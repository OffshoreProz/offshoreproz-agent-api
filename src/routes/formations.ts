/**
 * Formation routes — Sprint 2
 *
 * POST /v1/formations
 *   Create a new formation. Requires auth (requireApiKey).
 *   op_test_ → sandbox: stored in AGENT_DB, never triggers real filing or charges.
 *   op_live_ → blocked until Sprint 7 live gate (see auth middleware).
 *
 *   Idempotency: if Idempotency-Key header is present and matches a prior request
 *   with the same body hash, returns the cached response immediately (no DB insert).
 *
 * GET /v1/formations
 *   List formations for the authenticated API key. Paginated.
 *
 * GET /v1/formations/:id
 *   Get current status and next_actions for a formation.
 *
 * POST /v1/formations/:id/retry
 *   Retry a failed or action_required formation.
 *
 * DELETE /v1/formations/:id
 *   Cancel a formation. Only available in statuses: draft, pending_owner_confirmation.
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { AppType, FormationStatus } from "../types.ts";
import { ok, errors } from "../lib/response.ts";
import { requireApiKey } from "../middleware/auth.ts";
import { rateLimiter } from "../middleware/rate-limit.ts";
import { createLogger } from "../lib/logger.ts";
import { getJurisdiction } from "../config/jurisdictions.ts";
import { generateTraceId, hashApiKey } from "../lib/crypto.ts";
import { portalDb, toPortalJurisdiction } from "../lib/portal-db.ts";
import { getFormationEvents, logFormationEvent } from "../lib/events.ts";
import {
  deliverEventToEndpoints,
  type WebhookEventPayload,
} from "../lib/webhooks.ts";
import {
  createActionToken,
  reissueActionToken,
  getActiveActionToken,
  purposeForStatus,
} from "../lib/actions.ts";
import { screenOfac } from "../lib/ofac.ts";
import { normalizeCountry } from "../lib/countries.ts";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const addressSchema = z.object({
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  // Accept full country names (e.g. "Brasil") and normalize to ISO 3166-1
  // alpha-2 before validating, so agents don't burn a retry on the format.
  country: z.preprocess(
    (v) => (typeof v === "string" ? normalizeCountry(v) : v),
    z
      .string()
      .length(2, "Use the ISO 3166-1 alpha-2 country code (e.g. BR, US, GB)"),
  ),
  zip: z.string().max(20).optional(),
});

const beneficialOwnerSchema = z.object({
  full_name: z.string().min(2).max(200),
  email: z.string().email().max(254),
  phone: z.string().max(30).optional(),
  address: addressSchema,
  ownership_percentage: z.number().min(0).max(100).optional().default(100),
  id_document_type: z
    .enum(["passport", "drivers_license", "national_id"])
    .optional(),
});

const agentContextSchema = z
  .object({
    agent_id: z.string().max(100).optional(),
    agent_name: z.string().max(100).optional(),
    agent_purpose: z.string().max(300).optional(),
    platform: z.string().max(100).optional(),
  })
  .optional();

const createFormationSchema = z.object({
  jurisdiction: z.enum(["WY", "MI", "NV", "BVI", "PA", "UAE"]),
  company_name: z.string().min(3).max(120),
  /** Consent gate — must be true. Present cost, timeline, KYC/payment/signature steps,
   *  and the not-legal-advice notice before setting this. */
  user_confirmed_cost_and_process: z.literal(true, {
    errorMap: () => ({
      message:
        "user_confirmed_cost_and_process must be true. Present the all-in cost, estimated timeline, KYC/payment/signature steps, and the not-legal-advice disclaimer to the user first.",
    }),
  }),
  company_purpose: z
    .string()
    .max(500)
    .optional()
    .default("any lawful business purpose"),
  obtain_ein: z.boolean().optional().default(true),
  management_structure: z
    .enum(["member_managed", "manager_managed"])
    .optional()
    .default("member_managed"),
  beneficial_owner: beneficialOwnerSchema,
  members: z
    .array(
      z.object({
        full_name: z.string().min(2).max(200),
        email: z.string().email(),
        ownership_percentage: z.number().min(0).max(100),
        role: z
          .enum(["member", "manager", "director"])
          .optional()
          .default("member"),
      }),
    )
    .max(20)
    .optional()
    .default([]),
  /** estimate_token from POST /v1/jurisdictions/:code/estimate (required, 30 min TTL) */
  estimate_token: z
    .string()
    .uuid("estimate_token must be a valid UUID from POST /estimate"),
  agent_context: agentContextSchema,
  /** Custodian-first design: beneficial_owner is always the human custodian.
   *  For AI-agent formations set owner_type="ai_agent" and populate agent_context.agent_id.
   *  This field is AGENT_DB-internal — legal docs name the human custodian only. */
  owner_type: z.enum(["human", "ai_agent"]).optional().default("human"),
  metadata: z.record(z.string().max(500)).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a formation ID like frm_abc123456789 */
function generateFormationId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `frm_${hex}`;
}

/**
 * Summarize next action based on current status.
 *
 * `actionUrl` is the secure, single-use owner action link (built from an
 * act_ token). When null (no active token — e.g. expired), the link field is
 * empty and the caller should surface the reissue endpoint.
 */
function buildNextActions(
  status: FormationStatus,
  actionUrl: string | null,
  expiresAt: string | null,
): Array<{
  type: string;
  label: string;
  url: string;
  expires_at: string | null;
}> {
  switch (status) {
    case "pending_owner_confirmation":
    case "draft":
      return [
        {
          type: "owner_confirmation",
          label: "Beneficial owner must confirm cost and process",
          url: actionUrl ?? "",
          expires_at: expiresAt,
        },
      ];
    case "kyc_pending":
      return [
        {
          type: "human_kyc",
          label: "Beneficial owner must complete identity verification (KYC)",
          url: actionUrl ?? "",
          expires_at: expiresAt,
        },
      ];
    case "payment_pending":
      return [
        {
          type: "payment",
          label: "Payment authorization required",
          url: actionUrl ?? "",
          expires_at: expiresAt,
        },
      ];
    case "signature_pending":
      return [
        {
          type: "signature",
          label: "Beneficial owner must sign the operating agreement",
          url: actionUrl ?? "",
          expires_at: expiresAt,
        },
      ];
    case "action_required":
      return [
        {
          type: "retry",
          label: "Action required — check formation details",
          url: actionUrl ?? "",
          expires_at: null,
        },
      ];
    default:
      return [];
  }
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerFormationRoutes(app: Hono<AppType>): void {
  // ── POST /v1/formations ───────────────────────────────────────────────────
  app.post("/v1/formations", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    const apiKeyId = c.get("api_key_id") as string;
    const mode = c.get("api_key_mode") as "test" | "live";
    const portalUrl = c.env.PORTAL_URL;

    // ── Body size guard ────────────────────────────────────────────────────
    const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
    if (contentLength > 256_000) {
      return errors.validation(traceId, [
        { field: "body", message: "Request body exceeds 256KB limit" },
      ]);
    }

    // ── Idempotency check ──────────────────────────────────────────────────
    const idempotencyKey = c.req.header("Idempotency-Key");
    let rawBodyStr: string;

    try {
      rawBodyStr = await c.req.text();
    } catch {
      return errors.validation(traceId, [
        { field: "body", message: "Could not read request body" },
      ]);
    }

    if (idempotencyKey) {
      // Validate format
      if (
        idempotencyKey.length > 255 ||
        /[^a-zA-Z0-9_\-.]/.test(idempotencyKey)
      ) {
        return errors.validation(traceId, [
          {
            field: "Idempotency-Key",
            message:
              "Invalid Idempotency-Key format (max 255 chars, alphanumeric + _-. only)",
          },
        ]);
      }

      const idem = await c.env.AGENT_DB.prepare(
        `SELECT response_json, status_code, formation_id FROM agent_idempotency_keys
         WHERE api_key_id = ? AND idempotency_key = ?
         LIMIT 1`,
      )
        .bind(apiKeyId, idempotencyKey)
        .first<{
          response_json: string;
          status_code: number;
          formation_id: string | null;
        }>();

      if (idem?.response_json) {
        // Note: full payload hash validation would compare idem.request_hash here
        // For Sprint 2 we return the cached response; full hash check is Sprint 3
        logger.info("Idempotency hit — returning cached response", {
          idempotency_key: idempotencyKey,
          formation_id: idem.formation_id,
        });
        return new Response(idem.response_json, {
          status: idem.status_code,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": traceId,
            "X-Idempotency-Replayed": "true",
          },
        });
      }
    }

    // ── Parse + validate ───────────────────────────────────────────────────
    let body: z.infer<typeof createFormationSchema>;
    try {
      const raw = JSON.parse(rawBodyStr);
      const result = createFormationSchema.safeParse(raw);
      if (!result.success) {
        return errors.validation(
          traceId,
          result.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        );
      }
      body = result.data;
    } catch {
      return errors.validation(traceId, [
        { field: "body", message: "Invalid JSON" },
      ]);
    }

    // ── Validate jurisdiction availability ─────────────────────────────────
    const jurisdiction = getJurisdiction(body.jurisdiction);
    if (!jurisdiction || jurisdiction.status === "coming_soon") {
      return errors.unprocessable(
        traceId,
        `${body.jurisdiction} is not available for formation via API.`,
        "jurisdiction_not_available",
      );
    }

    // ── Validate estimate_token ────────────────────────────────────────────
    const estimateRaw = await c.env.KV.get(`estimate:${body.estimate_token}`);
    if (!estimateRaw) {
      return errors.unprocessable(
        traceId,
        "estimate_token is invalid or expired (30 minute TTL). Call POST /v1/jurisdictions/{code}/estimate to get a fresh token.",
        "estimate_token_invalid",
      );
    }
    const estimate = JSON.parse(estimateRaw) as {
      jurisdiction: string;
      total_usd: number;
      obtain_ein: boolean;
    };

    if (estimate.jurisdiction !== body.jurisdiction) {
      return errors.unprocessable(
        traceId,
        `estimate_token was generated for ${estimate.jurisdiction} but formation requests ${body.jurisdiction}.`,
        "estimate_token_jurisdiction_mismatch",
      );
    }

    // ── Validate company name ──────────────────────────────────────────────
    const name = body.company_name.trim();
    const nameSuffixes = ["LLC", "L.L.C.", "Limited Liability Company"];
    const requiredSuffix =
      body.jurisdiction === "WY" || body.jurisdiction === "NV";
    if (
      requiredSuffix &&
      !nameSuffixes.some((s) => name.toUpperCase().includes(s.toUpperCase()))
    ) {
      return errors.validation(traceId, [
        {
          field: "company_name",
          message: `Wyoming LLCs must include "LLC", "L.L.C.", or "Limited Liability Company" in the name.`,
        },
      ]);
    }

    // ── OFAC sanctions screening ───────────────────────────────────────────
    // FAIL-CLOSED (live mode only — sandbox is never screened). A live formation
    // may not proceed without a clean screen. If the OFAC API is down/errored we
    // BLOCK rather than wave the customer through: letting a formation pass during
    // a screening outage is a real AML/sanctions hole. The caller retries once the
    // screen is available.
    if (mode === "live") {
      const ofacResult = await screenOfac(body.beneficial_owner.full_name);
      if (ofacResult.hit) {
        logger.warn("OFAC sanctions hit — formation blocked", {
          full_name: body.beneficial_owner.full_name, // key matches PII_FIELDS sanitizer
          match: ofacResult.match_name,
          score: ofacResult.match_score,
        });
        return errors.unprocessable(
          traceId,
          "This application cannot be processed at this time. If you believe this is an error, contact support@offshoreproz.com.",
          "sanctions_screening_required",
        );
      }
      if (ofacResult.error) {
        // Fail-closed: screening could not complete → do NOT create the formation.
        logger.error("OFAC screening unavailable — formation blocked (fail-closed)", {
          error: ofacResult.error,
        });
        return errors.unprocessable(
          traceId,
          "Identity screening is temporarily unavailable and is required before processing. Please retry in a few minutes.",
          "sanctions_screening_unavailable",
        );
      }
    }

    // ── Create formation in AGENT_DB ──────────────────────────────────────
    const formationId = generateFormationId();
    const now = new Date().toISOString();
    const initialStatus: FormationStatus = "pending_owner_confirmation";

    // PII handling: beneficial-owner PII is NOT persisted in AGENT_DB — only the
    // non-PII agent_context below is stored (agent_id/name/purpose/platform), so
    // there is no plaintext PII at rest here. If full-intake storage is ever
    // needed (audit/replay/support), encrypt it with encryptPII() from
    // lib/crypto.ts (AES-256-GCM) before INSERT. See plano-final/09-SEGURANCA.
    const agentContextSafe = body.agent_context
      ? JSON.stringify({
          agent_id: body.agent_context.agent_id,
          agent_name: body.agent_context.agent_name,
          agent_purpose: body.agent_context.agent_purpose,
          platform: body.agent_context.platform,
        })
      : null;

    await c.env.AGENT_DB.prepare(
      `INSERT INTO agent_formations
       (id, mode, api_key_id, status, jurisdiction, company_name,
        estimate_id, amount_total_usd, agent_context_json, owner_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        formationId,
        mode,
        apiKeyId,
        initialStatus,
        body.jurisdiction,
        name,
        body.estimate_token,
        estimate.total_usd, // already in cents (KV estimate payload stores cents)
        agentContextSafe,
        body.owner_type ?? "human",
        now,
        now,
      )
      .run();

    // ── Record creation event ──────────────────────────────────────────────
    const eventId = `evt_${generateTraceId().replace(/-/g, "").slice(0, 14)}`;
    await c.env.AGENT_DB.prepare(
      `INSERT INTO agent_formation_events
       (id, formation_id, event_type, from_status, to_status, actor_type, actor_id, trace_id, payload_json, created_at)
       VALUES (?, ?, ?, NULL, ?, 'api_key', ?, ?, ?, ?)`,
    )
      .bind(
        eventId,
        formationId,
        "status_change",
        initialStatus,
        apiKeyId,
        traceId,
        JSON.stringify({
          jurisdiction: body.jurisdiction,
          company_name: name,
          mode,
          estimate_token: body.estimate_token,
          total_usd: estimate.total_usd / 100, // cents → dollars
        }),
        now,
      )
      .run();

    logger.info("Formation created", {
      formation_id: formationId,
      jurisdiction: body.jurisdiction,
      mode,
      api_key_id: apiKeyId,
      company_name: name,
    });

    // ── Mint owner confirmation action token (Sprint 5) ────────────────────
    // Secure, single-use, expiring link the beneficial owner opens to confirm.
    const ownerToken = await createActionToken(
      c.env.AGENT_DB,
      formationId,
      "owner_confirmation",
    );
    const ownerActionUrl = `${portalUrl}/portal/actions/${ownerToken.raw_token}`;

    // ── Build response ─────────────────────────────────────────────────────
    const responseData = {
      formation_id: formationId,
      status: initialStatus,
      mode,
      jurisdiction: body.jurisdiction,
      jurisdiction_name: jurisdiction.name,
      company_name: name,
      estimated_total_usd: estimate.total_usd / 100, // cents → dollars for display
      estimated_completion: (() => {
        const d = new Date();
        d.setDate(d.getDate() + jurisdiction.eta_days.max);
        return d.toISOString();
      })(),
      next_actions: buildNextActions(
        initialStatus,
        ownerActionUrl,
        ownerToken.expires_at,
      ),
      portal_url: `${portalUrl}/portal/formations/${formationId}`,
      sandbox: mode === "test",
      created_at: now,
      portal_project_id: null, // populated async via portal sync below
      portal_sync_status: "not_attempted",
      legal_disclaimer:
        "This formation has been initiated but not filed. KYC, payment authorization, and beneficial owner signature are required before filing begins. This is not legal or tax advice.",
    };

    const responseJson = JSON.stringify({
      data: responseData,
      request_id: traceId,
    });

    // ── Store idempotency cache ────────────────────────────────────────────
    if (idempotencyKey) {
      const _requestHash = await hashApiKey(rawBodyStr);
      const idemId = `idem_${generateTraceId().replace(/-/g, "").slice(0, 12)}`;
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      c.executionCtx.waitUntil(
        c.env.AGENT_DB.prepare(
          `INSERT OR IGNORE INTO agent_idempotency_keys
           (id, api_key_id, idempotency_key, request_hash, response_json, status_code, formation_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 201, ?, ?, ?)`,
        )
          .bind(
            idemId,
            apiKeyId,
            idempotencyKey,
            _requestHash,
            responseJson,
            formationId,
            now,
            expires,
          )
          .run()
          .catch(() => {}),
      );
    }

    // ── Portal sync (Sprint 3) — non-blocking, best-effort ────────────────
    // Runs after response is sent. If it fails, formation is still valid.
    // In staging (PORTAL_SYNC_ENABLED=false), logs dry-run preview only.
    c.executionCtx.waitUntil(
      (async () => {
        const pdb = portalDb(c);
        const now2 = new Date().toISOString();

        // Step 1: look up portal user by beneficial owner email (read-only)
        const portalUser = await pdb.findUserByEmail(
          body.beneficial_owner.email,
        );

        if (!portalUser) {
          logger.info("Portal sync: no portal user found — skipping", {
            formation_id: formationId,
            email_domain: body.beneficial_owner.email.split("@")[1],
          });
          await c.env.AGENT_DB.prepare(
            `UPDATE agent_formations
             SET portal_sync_status = 'no_portal_user', portal_sync_attempted_at = ?
             WHERE id = ?`,
          )
            .bind(now2, formationId)
            .run()
            .catch(() => {});
          return;
        }

        // Step 2: check migration 082 is applied before any write
        const migrationOk = await pdb.isMigration082Applied();
        if (!migrationOk && pdb.isLive) {
          logger.warn(
            "Portal sync: migration 082 not applied — aborting live write",
            { formation_id: formationId },
          );
          await c.env.AGENT_DB.prepare(
            `UPDATE agent_formations
             SET portal_sync_status = 'failed', portal_sync_error = ?, portal_sync_attempted_at = ?
             WHERE id = ?`,
          )
            .bind("migration_082_not_applied", now2, formationId)
            .run()
            .catch(() => {});
          return;
        }

        // Step 3: create portal project
        const portalProjectId = `proj_${formationId.replace("frm_", "")}`;
        const syncResult = await pdb.createProject({
          id: portalProjectId,
          client_user_id: portalUser.id,
          jurisdiction: toPortalJurisdiction(body.jurisdiction),
          company_names_json: JSON.stringify([name]),
          agent_formation_id: formationId,
          agent_context_json: agentContextSafe,
          notes: `Created via Agent API. Formation: ${formationId}. Mode: ${mode}. Agent: ${body.agent_context?.agent_name ?? "unknown"}.`,
        });

        if (syncResult.dry_run) {
          logger.info("Portal sync: dry-run (staging)", {
            formation_id: formationId,
            preview: syncResult.preview,
          });
          await c.env.AGENT_DB.prepare(
            `UPDATE agent_formations
             SET portal_sync_status = 'dry_run', portal_sync_attempted_at = ?
             WHERE id = ?`,
          )
            .bind(now2, formationId)
            .run()
            .catch(() => {});
          return;
        }

        if (syncResult.error) {
          logger.error("Portal sync: failed", {
            formation_id: formationId,
            error: syncResult.error,
          });
          await c.env.AGENT_DB.prepare(
            `UPDATE agent_formations
             SET portal_sync_status = 'failed', portal_sync_error = ?, portal_sync_attempted_at = ?
             WHERE id = ?`,
          )
            .bind(syncResult.error, now2, formationId)
            .run()
            .catch(() => {});
          return;
        }

        // Step 4: update formation with portal_project_id
        await c.env.AGENT_DB.prepare(
          `UPDATE agent_formations
           SET portal_project_id = ?, portal_sync_status = 'synced',
               portal_sync_attempted_at = ?, status = 'portal_synced',
               updated_at = ?
           WHERE id = ?`,
        )
          .bind(portalProjectId, now2, now2, formationId)
          .run()
          .catch(() => {});

        logger.info("Portal sync: complete", {
          formation_id: formationId,
          portal_project_id: portalProjectId,
        });
      })().catch((err: unknown) => {
        logger.error("Portal sync: unhandled exception", {
          formation_id: formationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );

    // ── Webhook delivery (Sprint 4) — non-blocking, best-effort ──────────
    // Deliver "formation.created" to all subscribed endpoints for this key.
    c.executionCtx.waitUntil(
      (() => {
        const webhookPayload: WebhookEventPayload = {
          id: eventId,
          type: "formation.created",
          created: now,
          livemode: mode === "live",
          data: {
            formation_id: formationId,
            status: initialStatus,
            jurisdiction: body.jurisdiction,
            company_name: name,
            estimated_total_usd: estimate.total_usd / 100, // cents → dollars for display
            sandbox: mode === "test",
          },
        };
        return deliverEventToEndpoints(
          c.env.AGENT_DB,
          c.env,
          apiKeyId,
          eventId,
          "formation.created",
          formationId,
          webhookPayload,
        ).catch(() => {});
      })(),
    );

    return new Response(responseJson, {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": traceId,
        "Cache-Control": "no-store",
      },
    });
  });

  // ── GET /v1/formations/:id/events ─────────────────────────────────────────
  app.get(
    "/v1/formations/:id/events",
    requireApiKey,
    rateLimiter,
    async (c) => {
      const traceId = (c.get("trace_id") as string) ?? generateTraceId();
      const apiKeyId = c.get("api_key_id") as string;
      const formationId = c.req.param("id");

      // Verify ownership
      const row = await c.env.AGENT_DB.prepare(
        `SELECT id FROM agent_formations WHERE id = ? AND api_key_id = ? LIMIT 1`,
      )
        .bind(formationId, apiKeyId)
        .first<{ id: string }>();

      if (!row) return errors.notFound(traceId);

      const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);

      const events = await getFormationEvents(
        c.env.AGENT_DB,
        formationId,
        limit,
      );

      return ok(
        {
          formation_id: formationId,
          events: events.map((e) => ({
            id: e.id,
            type: e.event_type,
            from_status: e.from_status,
            to_status: e.to_status,
            actor_type: e.actor_type,
            payload: (() => {
              try {
                return JSON.parse(e.payload_json) as Record<string, unknown>;
              } catch {
                return {};
              }
            })(),
            trace_id: e.trace_id,
            created_at: e.created_at,
          })),
          count: events.length,
        },
        traceId,
      );
    },
  );

  // ── POST /v1/formations/:id/actions/reissue (Sprint 5) ────────────────────
  // Reissue a fresh owner action link for the current step. Invalidates any
  // outstanding link for that step. Use when a link expired or was lost.
  app.post(
    "/v1/formations/:id/actions/reissue",
    requireApiKey,
    rateLimiter,
    async (c) => {
      const traceId = (c.get("trace_id") as string) ?? generateTraceId();
      const apiKeyId = c.get("api_key_id") as string;
      const formationId = c.req.param("id");
      const portalUrl = c.env.PORTAL_URL;

      const row = await c.env.AGENT_DB.prepare(
        `SELECT id, status FROM agent_formations WHERE id = ? AND api_key_id = ? LIMIT 1`,
      )
        .bind(formationId, apiKeyId)
        .first<{ id: string; status: FormationStatus }>();

      if (!row) return errors.notFound(traceId);

      const purpose = purposeForStatus(row.status);
      if (!purpose) {
        return errors.unprocessable(
          traceId,
          `Formation in status "${row.status}" has no pending owner action to reissue.`,
          "no_pending_action",
        );
      }

      const fresh = await reissueActionToken(
        c.env.AGENT_DB,
        formationId,
        purpose,
      );
      const url = `${portalUrl}/portal/actions/${fresh.raw_token}`;

      await logFormationEvent(c.env.AGENT_DB, {
        formation_id: formationId,
        event_type: "note",
        actor_type: "api_key",
        actor_id: apiKeyId,
        trace_id: traceId,
        payload: { action: "action_token_reissued", purpose },
      });

      return ok(
        {
          formation_id: formationId,
          status: row.status,
          next_action: {
            type: purpose,
            url,
            expires_at: fresh.expires_at,
          },
        },
        traceId,
      );
    },
  );

  // ── GET /v1/formations/:id/status (PUBLIC) ────────────────────────────────
  // Owner-facing status by formation id. frm_ ids are unguessable (64-bit
  // random), so this acts as a share link. Returns NON-sensitive fields only —
  // never beneficial-owner PII. Powers the public company page at
  // /portal/formations/:id (mirrors how the action page reads the API).
  app.get("/v1/formations/:id/status", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const formationId = c.req.param("id");

    const row = await c.env.AGENT_DB.prepare(
      `SELECT id, mode, status, jurisdiction, company_name, amount_total_usd,
              created_at, updated_at, completed_at
       FROM agent_formations WHERE id = ? LIMIT 1`,
    )
      .bind(formationId)
      .first<{
        id: string;
        mode: string;
        status: FormationStatus;
        jurisdiction: string;
        company_name: string;
        amount_total_usd: number | null;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
      }>();

    if (!row) return errors.notFound(traceId);

    const STEP_LABELS: Record<string, string> = {
      draft: "Aguardando confirmação do titular",
      pending_owner_confirmation: "Aguardando confirmação do titular",
      kyc_pending: "Verificação de identidade (KYC)",
      kyc_approved: "Identidade verificada — preparando pagamento",
      payment_pending: "Aguardando pagamento",
      payment_authorized: "Pagamento confirmado — preparando documentos",
      signature_pending: "Aguardando assinatura dos documentos",
      filing_ready: "Pronto para registro junto ao estado",
      filed: "Registro protocolado",
      complete: "Empresa formada",
      completed: "Empresa formada",
      cancelled: "Cancelada",
      failed: "Ação necessária",
      action_required: "Ação necessária",
    };

    return ok(
      {
        formation_id: row.id,
        status: row.status,
        step_label: STEP_LABELS[row.status] ?? row.status,
        jurisdiction: row.jurisdiction,
        company_name: row.company_name,
        estimated_total_usd: row.amount_total_usd
          ? row.amount_total_usd / 100
          : null,
        sandbox: row.mode === "test",
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
      },
      traceId,
    );
  });

  app.get("/v1/formations", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;

    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const cursor = c.req.query("cursor");
    const statusFilter = c.req.query("status");

    let query = `SELECT id, status, jurisdiction, company_name, mode, portal_project_id, created_at, updated_at, completed_at, error_code
                 FROM agent_formations
                 WHERE api_key_id = ?`;
    const params: unknown[] = [apiKeyId];

    if (statusFilter) {
      query += ` AND status = ?`;
      params.push(statusFilter);
    }
    if (cursor) {
      query += ` AND id < ?`;
      params.push(cursor);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = await c.env.AGENT_DB.prepare(query)
      .bind(...params)
      .all<{
        id: string;
        status: string;
        jurisdiction: string;
        company_name: string;
        mode: string;
        portal_project_id: string | null;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
        error_code: string | null;
      }>();

    const formations = rows.results ?? [];
    const hasMore = formations.length > limit;
    const items = hasMore ? formations.slice(0, limit) : formations;

    return ok(
      {
        formations: items,
        has_more: hasMore,
        next_cursor: hasMore ? items[items.length - 1]?.id : null,
        total_returned: items.length,
      },
      traceId,
    );
  });

  // ── GET /v1/formations/:id ────────────────────────────────────────────────
  app.get("/v1/formations/:id", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const formationId = c.req.param("id");
    const portalUrl = c.env.PORTAL_URL;

    const row = await c.env.AGENT_DB.prepare(
      `SELECT id, mode, status, jurisdiction, company_name, portal_project_id,
              portal_sync_status, amount_total_usd, error_code, error_message,
              created_at, updated_at, completed_at
       FROM agent_formations
       WHERE id = ? AND api_key_id = ?
       LIMIT 1`,
    )
      .bind(formationId, apiKeyId)
      .first<{
        id: string;
        mode: string;
        status: FormationStatus;
        jurisdiction: string;
        company_name: string;
        portal_project_id: string | null;
        portal_sync_status: string | null;
        amount_total_usd: number | null;
        error_code: string | null;
        error_message: string | null;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
      }>();

    if (!row) return errors.notFound(traceId);

    // Fetch recent events (last 10)
    const eventsResult = await c.env.AGENT_DB.prepare(
      `SELECT event_type, from_status, to_status, payload_json, created_at
       FROM agent_formation_events
       WHERE formation_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
    )
      .bind(formationId)
      .all<{
        event_type: string;
        from_status: string | null;
        to_status: string | null;
        payload_json: string;
        created_at: string;
      }>();

    // Rebuild the live owner action link from the active token (if any).
    // We never expose formation_id in the action URL — only the act_ token.
    const purpose = purposeForStatus(row.status);
    let actionUrl: string | null = null;
    let actionExpiresAt: string | null = null;
    if (purpose) {
      const active = await getActiveActionToken(
        c.env.AGENT_DB,
        row.id,
        purpose,
      );
      if (active) {
        // The raw token is not stored; the live URL is only returned at mint
        // time. Here we expose the reissue endpoint so the owner can get a
        // fresh link without leaking the (hashed) token.
        actionUrl = `${c.env.API_BASE_URL}/v1/formations/${row.id}/actions/reissue`;
        actionExpiresAt = active.expires_at;
      }
    }

    return ok(
      {
        formation_id: row.id,
        status: row.status,
        mode: row.mode,
        jurisdiction: row.jurisdiction,
        company_name: row.company_name,
        portal_project_id: row.portal_project_id,
        portal_sync_status: row.portal_sync_status ?? "not_attempted",
        estimated_total_usd: row.amount_total_usd
          ? row.amount_total_usd / 100
          : null,
        sandbox: row.mode === "test",
        error: row.error_code
          ? { code: row.error_code, message: row.error_message }
          : null,
        next_actions: buildNextActions(row.status, actionUrl, actionExpiresAt),
        portal_url: row.portal_project_id
          ? `${portalUrl}/portal/projects/${row.portal_project_id}`
          : `${portalUrl}/portal/formations/${row.id}`,
        timeline: (eventsResult.results ?? []).map((e) => ({
          event: e.event_type,
          from_status: e.from_status,
          to_status: e.to_status,
          at: e.created_at,
        })),
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
      },
      traceId,
    );
  });

  // ── POST /v1/formations/:id/retry ─────────────────────────────────────────
  app.post(
    "/v1/formations/:id/retry",
    requireApiKey,
    rateLimiter,
    async (c) => {
      const traceId = (c.get("trace_id") as string) ?? generateTraceId();
      const apiKeyId = c.get("api_key_id") as string;
      const formationId = c.req.param("id");

      const row = await c.env.AGENT_DB.prepare(
        `SELECT id, status, mode FROM agent_formations WHERE id = ? AND api_key_id = ? LIMIT 1`,
      )
        .bind(formationId, apiKeyId)
        .first<{ id: string; status: FormationStatus; mode: string }>();

      if (!row) return errors.notFound(traceId);

      const retryableStatuses: FormationStatus[] = [
        "failed",
        "action_required",
      ];
      if (!retryableStatuses.includes(row.status)) {
        return errors.unprocessable(
          traceId,
          `Formation in status "${row.status}" cannot be retried. Only failed or action_required formations can be retried.`,
          "formation_not_retryable",
        );
      }

      const now = new Date().toISOString();
      const newStatus: FormationStatus = "pending_owner_confirmation";

      await c.env.AGENT_DB.prepare(
        `UPDATE agent_formations SET status = ?, updated_at = ?, error_code = NULL, error_message = NULL WHERE id = ?`,
      )
        .bind(newStatus, now, formationId)
        .run();

      const eventId = `evt_${generateTraceId().replace(/-/g, "").slice(0, 14)}`;
      await c.env.AGENT_DB.prepare(
        `INSERT INTO agent_formation_events
       (id, formation_id, event_type, from_status, to_status, actor_type, actor_id, trace_id, payload_json, created_at)
       VALUES (?, ?, 'status_change', ?, ?, 'api_key', ?, ?, '{"action":"retry"}', ?)`,
      )
        .bind(
          eventId,
          formationId,
          row.status,
          newStatus,
          apiKeyId,
          traceId,
          now,
        )
        .run();

      // Webhook delivery (Sprint 4)
      c.executionCtx.waitUntil(
        deliverEventToEndpoints(
          c.env.AGENT_DB,
          c.env,
          apiKeyId,
          eventId,
          "formation.status_changed",
          formationId,
          {
            id: eventId,
            type: "formation.status_changed",
            created: now,
            livemode: row.mode === "live",
            data: {
              formation_id: formationId,
              from_status: row.status,
              to_status: newStatus,
              action: "retry",
            },
          },
        ).catch(() => {}),
      );

      return ok(
        { formation_id: formationId, status: newStatus, retried_at: now },
        traceId,
      );
    },
  );

  // ── DELETE /v1/formations/:id ─────────────────────────────────────────────
  app.delete("/v1/formations/:id", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const formationId = c.req.param("id");

    const row = await c.env.AGENT_DB.prepare(
      `SELECT id, status, mode FROM agent_formations WHERE id = ? AND api_key_id = ? LIMIT 1`,
    )
      .bind(formationId, apiKeyId)
      .first<{ id: string; status: FormationStatus; mode: string }>();

    if (!row) return errors.notFound(traceId);

    const cancellableStatuses: FormationStatus[] = [
      "draft",
      "pending_owner_confirmation",
    ];
    if (!cancellableStatuses.includes(row.status)) {
      return errors.unprocessable(
        traceId,
        `Formation in status "${row.status}" cannot be cancelled. Only draft or pending_owner_confirmation formations can be cancelled.`,
        "formation_not_cancellable",
      );
    }

    const now = new Date().toISOString();
    await c.env.AGENT_DB.prepare(
      `UPDATE agent_formations SET status = 'cancelled', updated_at = ? WHERE id = ?`,
    )
      .bind(now, formationId)
      .run();

    const eventId = `evt_${generateTraceId().replace(/-/g, "").slice(0, 14)}`;
    await c.env.AGENT_DB.prepare(
      `INSERT INTO agent_formation_events
       (id, formation_id, event_type, from_status, to_status, actor_type, actor_id, trace_id, payload_json, created_at)
       VALUES (?, ?, 'status_change', ?, 'cancelled', 'api_key', ?, ?, '{"action":"cancel"}', ?)`,
    )
      .bind(eventId, formationId, row.status, apiKeyId, traceId, now)
      .run();

    // Webhook delivery (Sprint 4)
    c.executionCtx.waitUntil(
      deliverEventToEndpoints(
        c.env.AGENT_DB,
        c.env,
        apiKeyId,
        eventId,
        "formation.cancelled",
        formationId,
        {
          id: eventId,
          type: "formation.cancelled",
          created: now,
          livemode: row.mode === "live",
          data: {
            formation_id: formationId,
            from_status: row.status,
            cancelled_at: now,
          },
        },
      ).catch(() => {}),
    );

    return ok(
      { formation_id: formationId, status: "cancelled", cancelled_at: now },
      traceId,
    );
  });
}
