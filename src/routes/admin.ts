/**
 * Admin / Ops routes
 *
 * Filing hand-off:
 *   POST /v1/admin/formations/:id/filing/start
 *   POST /v1/admin/formations/:id/filing/complete
 *
 * Pilot (MI) review:
 *   GET  /v1/admin/formations                           — list with filters
 *   GET  /v1/admin/formations/:id                      — detail
 *   POST /v1/admin/formations/:id/pilot/approve        — action_required → kyc_pending
 *   POST /v1/admin/formations/:id/pilot/reject         — action_required → failed
 *   POST /v1/admin/formations/:id/refund               — refund charge → cancelled
 *
 * Key management:
 *   GET  /v1/admin/keys                                — list all keys
 *   POST /v1/admin/keys/:id/revoke                     — force revoke
 *
 * Stats:
 *   GET  /v1/admin/stats                               — aggregate counts
 *
 * Auth: Authorization: Bearer {ADMIN_API_TOKEN}. NOT a customer API key.
 * If ADMIN_API_TOKEN is unset, all endpoints return 401.
 */

import type { Hono, Context } from "hono";
import type { AppType, FormationStatus } from "../types.ts";
import { ok, errors } from "../lib/response.ts";
import { createLogger } from "../lib/logger.ts";
import { generateTraceId, timingSafeCompare } from "../lib/crypto.ts";
import { logFormationEvent } from "../lib/events.ts";
import { canTransition } from "../core/formation-state.ts";
import {
  deliverEventToEndpoints,
  type WebhookEventPayload,
} from "../lib/webhooks.ts";
import { simulateFiling, refundPayment, type RefundResult } from "../lib/providers.ts";
import { createActionToken } from "../lib/actions.ts";
import {
  sendKycReadyEmail,
  sendRegistrationCompleteEmail,
} from "../lib/email.ts";

interface FormationAdminRow {
  id: string;
  api_key_id: string;
  mode: string;
  status: FormationStatus;
  jurisdiction: string;
  company_name: string;
}

async function requireAdmin(c: Context<AppType>): Promise<boolean> {
  const expected = c.env.ADMIN_API_TOKEN;
  if (!expected) return false; // endpoints disabled when no token configured
  const header = c.req.header("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided) return false;
  return timingSafeCompare(provided, expected);
}

async function loadFormation(
  db: D1Database,
  id: string,
): Promise<FormationAdminRow | null> {
  return db
    .prepare(
      `SELECT id, api_key_id, mode, status, jurisdiction, company_name
       FROM agent_formations WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<FormationAdminRow>();
}

async function applyTransition(
  db: D1Database,
  formation: FormationAdminRow,
  to: FormationStatus,
  traceId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const now = new Date().toISOString();
  const eventId = await logFormationEvent(db, {
    formation_id: formation.id,
    event_type: "status_change",
    from_status: formation.status,
    to_status: to,
    actor_type: "admin",
    trace_id: traceId,
    payload,
  });
  await db
    .prepare(
      `UPDATE agent_formations SET status = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(to, now, formation.id)
    .run();
  return eventId;
}

function fireWebhook(
  c: Context<AppType>,
  formation: FormationAdminRow,
  eventId: string,
  newStatus: FormationStatus,
  publicType:
    | "formation.filed"
    | "formation.complete"
    | "formation.status_changed",
): void {
  c.executionCtx.waitUntil(
    (() => {
      const payload: WebhookEventPayload = {
        id: eventId,
        type: publicType,
        created: new Date().toISOString(),
        livemode: formation.mode === "live",
        data: {
          formation_id: formation.id,
          status: newStatus,
          jurisdiction: formation.jurisdiction,
          company_name: formation.company_name,
          sandbox: formation.mode === "test",
        },
      };
      return deliverEventToEndpoints(
        c.env.AGENT_DB,
        c.env,
        formation.api_key_id,
        eventId,
        publicType,
        formation.id,
        payload,
      ).catch(() => {});
    })(),
  );
}

export function registerAdminRoutes(app: Hono<AppType>): void {
  // ── POST /v1/admin/formations/:id/filing/start ────────────────────────────
  app.post("/v1/admin/formations/:id/filing/start", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const formation = await loadFormation(c.env.AGENT_DB, c.req.param("id"));
    if (!formation) return errors.notFound(traceId);

    if (!canTransition(formation.status, "filing_in_progress")) {
      return errors.unprocessable(
        traceId,
        `Formation in status "${formation.status}" cannot start filing. Expected "filing_ready".`,
        "filing_not_ready",
      );
    }

    const eventId = await applyTransition(
      c.env.AGENT_DB,
      formation,
      "filing_in_progress",
      traceId,
      { action: "filing_started", actor: "ops" },
    );
    fireWebhook(
      c,
      formation,
      eventId,
      "filing_in_progress",
      "formation.status_changed",
    );

    return ok(
      { formation_id: formation.id, status: "filing_in_progress" },
      traceId,
    );
  });

  // ── POST /v1/admin/formations/:id/filing/complete ─────────────────────────
  // Walks filing_in_progress → registration_complete → ein_pending →
  // documents_ready → complete (Wyoming with EIN). Simulated filing reference.
  app.post("/v1/admin/formations/:id/filing/complete", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    let formation = await loadFormation(c.env.AGENT_DB, c.req.param("id"));
    if (!formation) return errors.notFound(traceId);

    if (formation.status !== "filing_in_progress") {
      return errors.unprocessable(
        traceId,
        `Formation in status "${formation.status}" cannot complete filing. Expected "filing_in_progress".`,
        "filing_not_in_progress",
      );
    }

    const filing = simulateFiling(formation.mode === "test");
    const path: FormationStatus[] = [
      "registration_complete",
      "ein_pending",
      "documents_ready",
      "complete",
    ];

    // Validate the whole path first.
    let cursor: FormationStatus = formation.status;
    for (const next of path) {
      if (!canTransition(cursor, next)) {
        return errors.unprocessable(
          traceId,
          `Illegal transition ${cursor} → ${next}.`,
          "illegal_transition",
        );
      }
      cursor = next;
    }

    let lastEventId = "";
    for (const next of path) {
      lastEventId = await applyTransition(
        c.env.AGENT_DB,
        formation,
        next,
        traceId,
        {
          action: "filing_progress",
          actor: "ops",
          filing,
        },
      );
      formation = { ...formation, status: next };
    }

    const completedAt = new Date().toISOString();
    await c.env.AGENT_DB.prepare(
      `UPDATE agent_formations SET completed_at = ? WHERE id = ?`,
    )
      .bind(completedAt, formation.id)
      .run();

    fireWebhook(c, formation, lastEventId, "complete", "formation.complete");

    // Email registration complete to owner (live mode, best-effort)
    if (formation.mode === "live" && c.env.RESEND_API_KEY) {
      const keyRow = await c.env.AGENT_DB
        .prepare(`SELECT owner_email FROM agent_api_keys WHERE id = ? LIMIT 1`)
        .bind(formation.api_key_id)
        .first<{ owner_email: string }>();
      if (keyRow?.owner_email) {
        await sendRegistrationCompleteEmail(
          c.env.RESEND_API_KEY,
          keyRow.owner_email,
          formation.company_name,
          formation.jurisdiction,
          filing.reference,
        ).catch(() => {});
      }
    }

    logger.info("Filing completed", {
      formation_id: formation.id,
      filing_reference: filing.reference,
    });

    return ok(
      {
        formation_id: formation.id,
        status: "complete",
        filing_reference: filing.reference,
        filing_provider: filing.provider,
        completed_at: completedAt,
      },
      traceId,
    );
  });

  // ── POST /v1/admin/formations/:id/refund ──────────────────────────────────
  // Money-safety: refund a charged formation and cancel it. Use when a filing
  // fails after payment, or a paid formation must be cancelled, so the
  // customer's funds are never stranded. Valid only for post-charge states
  // (payment_authorized..filing_in_progress). The Stripe refund is issued
  // BEFORE the state transition, so a formation is never marked cancelled
  // without the money actually being returned.
  //
  // Body (optional): { "reason": "requested_by_customer" | "duplicate" | "fraudulent" }
  app.post("/v1/admin/formations/:id/refund", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const formation = await loadFormation(c.env.AGENT_DB, c.req.param("id"));
    if (!formation) return errors.notFound(traceId);

    if (!canTransition(formation.status, "cancelled")) {
      return errors.unprocessable(
        traceId,
        `Formation in status "${formation.status}" cannot be refunded/cancelled.`,
        "formation_not_refundable",
      );
    }

    let refund: RefundResult | null = null;
    if (formation.mode === "live") {
      const payRow = await c.env.AGENT_DB
        .prepare(`SELECT stripe_payment_intent_id FROM agent_formations WHERE id = ? LIMIT 1`)
        .bind(formation.id)
        .first<{ stripe_payment_intent_id: string | null }>();
      const paymentIntentId = payRow?.stripe_payment_intent_id;
      if (!paymentIntentId) {
        return errors.unprocessable(
          traceId,
          "No Stripe payment_intent on this formation — nothing to refund.",
          "no_payment_to_refund",
        );
      }
      const body = (await c.req.json().catch(() => ({}))) as {
        reason?: "requested_by_customer" | "duplicate" | "fraudulent";
      };
      try {
        refund = await refundPayment(c.env, paymentIntentId, body.reason ?? "requested_by_customer");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Refund error";
        logger.error("admin refund failed — state NOT advanced", {
          formation_id: formation.id,
          error: message,
        });
        return errors.unprocessable(traceId, `Refund failed: ${message}`, "refund_failed");
      }
    }

    // Only advance to cancelled AFTER the refund succeeded (or sandbox no-op).
    const eventId = await applyTransition(c.env.AGENT_DB, formation, "cancelled", traceId, {
      action: "refunded_and_cancelled",
      actor: "ops",
      refund: refund ?? { simulated: formation.mode === "test" },
    });
    fireWebhook(c, formation, eventId, "cancelled", "formation.status_changed");

    logger.info("formation refunded + cancelled", {
      formation_id: formation.id,
      refund_id: refund?.refund_id ?? "(sandbox)",
    });

    return ok({ formation_id: formation.id, status: "cancelled", refund }, traceId);
  });

  // ── GET /v1/admin/formations ───────────────────────────────────────────────
  app.get("/v1/admin/formations", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const q = c.req.query();
    const jurisdiction = q.jurisdiction ?? null;
    const status = q.status ?? null;
    const mode = q.mode ?? null;
    const limit = Math.min(Number(q.limit ?? "50"), 200);
    const offset = Number(q.offset ?? "0");

    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (jurisdiction) { conditions.push("jurisdiction = ?"); binds.push(jurisdiction); }
    if (status)       { conditions.push("status = ?");       binds.push(status); }
    if (mode)         { conditions.push("mode = ?");          binds.push(mode); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    binds.push(limit, offset);

    const rows = await c.env.AGENT_DB.prepare(
      `SELECT id, mode, status, jurisdiction, company_name, created_at, updated_at, completed_at
       FROM agent_formations ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds).all<{
      id: string; mode: string; status: string; jurisdiction: string;
      company_name: string; created_at: string; updated_at: string | null;
      completed_at: string | null;
    }>();

    return ok({ formations: rows.results, total: rows.results.length, limit, offset }, traceId);
  });

  // ── GET /v1/admin/formations/:id ──────────────────────────────────────────
  app.get("/v1/admin/formations/:id", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const formation = await c.env.AGENT_DB.prepare(
      `SELECT f.id, f.api_key_id, f.mode, f.status, f.jurisdiction, f.company_name,
              f.amount_total_usd, f.portal_project_id, f.stripe_payment_intent_id,
              f.signing_envelope_id, f.error_code, f.created_at, f.updated_at, f.completed_at,
              k.owner_email, k.tier
       FROM agent_formations f
       LEFT JOIN agent_api_keys k ON k.id = f.api_key_id
       WHERE f.id = ? LIMIT 1`,
    ).bind(c.req.param("id")).first<Record<string, unknown>>();

    if (!formation) return errors.notFound(traceId);

    const events = await c.env.AGENT_DB.prepare(
      `SELECT id, event_type, from_status, to_status, actor_type, created_at
       FROM agent_formation_events WHERE formation_id = ?
       ORDER BY created_at ASC LIMIT 100`,
    ).bind(c.req.param("id")).all<Record<string, unknown>>();

    return ok({ formation, events: events.results }, traceId);
  });

  // ── POST /v1/admin/formations/:id/pilot/approve ───────────────────────────
  // Resumes a pilot formation: action_required → kyc_pending + mint KYC token.
  app.post("/v1/admin/formations/:id/pilot/approve", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const formation = await loadFormation(c.env.AGENT_DB, c.req.param("id"));
    if (!formation) return errors.notFound(traceId);

    if (formation.status !== "action_required") {
      return errors.unprocessable(
        traceId,
        `Formation is in status "${formation.status}", not "action_required". Only formations pending pilot review can be approved.`,
        "pilot_approve_invalid_status",
      );
    }

    if (!canTransition("action_required", "pending_owner_confirmation")) {
      return errors.unprocessable(traceId, "Illegal transition.", "illegal_transition");
    }

    const now = new Date().toISOString();
    // Transition: action_required → pending_owner_confirmation → kyc_pending
    const eventId1 = await logFormationEvent(c.env.AGENT_DB, {
      formation_id: formation.id,
      event_type: "status_change",
      from_status: "action_required",
      to_status: "pending_owner_confirmation",
      actor_type: "admin",
      trace_id: traceId,
      payload: { action: "pilot_approved", actor: "ops" },
    });
    await c.env.AGENT_DB.prepare(
      `UPDATE agent_formations SET status = ?, updated_at = ? WHERE id = ?`,
    ).bind("pending_owner_confirmation", now, formation.id).run();

    // Mint the KYC action token so ops can forward the link to the client
    const kycToken = await createActionToken(c.env.AGENT_DB, formation.id, "kyc");

    // Walk to kyc_pending
    const eventId2 = await logFormationEvent(c.env.AGENT_DB, {
      formation_id: formation.id,
      event_type: "status_change",
      from_status: "pending_owner_confirmation",
      to_status: "kyc_pending",
      actor_type: "admin",
      trace_id: traceId,
      payload: { action: "pilot_approved_advance_kyc", actor: "ops", kyc_token_id: kycToken.id },
    });
    await c.env.AGENT_DB.prepare(
      `UPDATE agent_formations SET status = ?, updated_at = ? WHERE id = ?`,
    ).bind("kyc_pending", now, formation.id).run();

    fireWebhook(c, { ...formation, status: "kyc_pending" }, eventId2, "kyc_pending", "formation.status_changed");

    logger.info("Pilot review approved — formation advanced to kyc_pending", {
      formation_id: formation.id,
      kyc_token_id: kycToken.id,
    });

    const actionUrl = `${c.env.PORTAL_URL}/portal/actions/${kycToken.raw_token}`;

    // Email the KYC link to the owner (live mode, best-effort)
    if (formation.mode === "live" && c.env.RESEND_API_KEY) {
      const keyRow = await c.env.AGENT_DB
        .prepare(`SELECT owner_email FROM agent_api_keys WHERE id = ? LIMIT 1`)
        .bind(formation.api_key_id)
        .first<{ owner_email: string }>();
      if (keyRow?.owner_email) {
        await sendKycReadyEmail(
          c.env.RESEND_API_KEY,
          keyRow.owner_email,
          formation.company_name,
          actionUrl,
          kycToken.expires_at,
        ).catch(() => {});
      }
    }

    return ok(
      {
        formation_id: formation.id,
        status: "kyc_pending",
        kyc_action_url: actionUrl,
        kyc_token_expires_at: kycToken.expires_at,
        note: "The kyc_action_url has been emailed to the owner (if live mode). Forward it manually if needed.",
        event_ids: [eventId1, eventId2],
      },
      traceId,
    );
  });

  // ── POST /v1/admin/formations/:id/pilot/reject ────────────────────────────
  app.post("/v1/admin/formations/:id/pilot/reject", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    const reason = body.reason ?? "rejected_by_ops";

    const formation = await loadFormation(c.env.AGENT_DB, c.req.param("id"));
    if (!formation) return errors.notFound(traceId);

    if (formation.status !== "action_required") {
      return errors.unprocessable(
        traceId,
        `Formation is in status "${formation.status}", not "action_required".`,
        "pilot_reject_invalid_status",
      );
    }

    const now = new Date().toISOString();
    const eventId = await logFormationEvent(c.env.AGENT_DB, {
      formation_id: formation.id,
      event_type: "status_change",
      from_status: "action_required",
      to_status: "failed",
      actor_type: "admin",
      trace_id: traceId,
      payload: { action: "pilot_rejected", actor: "ops", reason },
    });

    await c.env.AGENT_DB.prepare(
      `UPDATE agent_formations SET status = ?, error_code = ?, updated_at = ? WHERE id = ?`,
    ).bind("failed", reason, now, formation.id).run();

    fireWebhook(c, { ...formation, status: "failed" }, eventId, "failed", "formation.status_changed");

    logger.info("Pilot review rejected", { formation_id: formation.id, reason });

    return ok({ formation_id: formation.id, status: "failed", reason }, traceId);
  });

  // ── GET /v1/admin/keys ────────────────────────────────────────────────────
  app.get("/v1/admin/keys", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const q = c.req.query();
    const email = q.email ?? null;
    const mode = q.mode ?? null;
    const includeRevoked = q.include_revoked === "true";
    const limit = Math.min(Number(q.limit ?? "50"), 200);
    const offset = Number(q.offset ?? "0");

    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (email) { conditions.push("owner_email = ?"); binds.push(email); }
    if (mode)  { conditions.push("mode = ?");        binds.push(mode); }
    if (!includeRevoked) { conditions.push("revoked_at IS NULL"); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    binds.push(limit, offset);

    const rows = await c.env.AGENT_DB.prepare(
      `SELECT id, mode, name, owner_email, tier, created_at, last_used_at, revoked_at
       FROM agent_api_keys ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds).all<Record<string, unknown>>();

    return ok({ keys: rows.results, total: rows.results.length, limit, offset }, traceId);
  });

  // ── POST /v1/admin/keys/:id/revoke ────────────────────────────────────────
  app.post("/v1/admin/keys/:id/revoke", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const now = new Date().toISOString();
    const res = await c.env.AGENT_DB.prepare(
      `UPDATE agent_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).bind(now, c.req.param("id")).run();

    if ((res.meta?.changes ?? 0) === 0) {
      const existing = await c.env.AGENT_DB.prepare(
        `SELECT id FROM agent_api_keys WHERE id = ? LIMIT 1`,
      ).bind(c.req.param("id")).first<{ id: string }>();
      if (!existing) return errors.notFound(traceId);
      return ok({ id: c.req.param("id"), status: "already_revoked" }, traceId);
    }

    return ok({ id: c.req.param("id"), status: "revoked", revoked_at: now }, traceId);
  });

  // ── GET /v1/admin/stats ───────────────────────────────────────────────────
  app.get("/v1/admin/stats", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    if (!(await requireAdmin(c))) return errors.unauthorized(traceId);

    const [formationsByStatus, formationsByJurisdiction, keyStats, pilotQueue] = await Promise.all([
      c.env.AGENT_DB.prepare(
        `SELECT status, COUNT(*) as count FROM agent_formations GROUP BY status ORDER BY count DESC`,
      ).all<{ status: string; count: number }>(),

      c.env.AGENT_DB.prepare(
        `SELECT jurisdiction, mode, COUNT(*) as count
         FROM agent_formations GROUP BY jurisdiction, mode ORDER BY jurisdiction, mode`,
      ).all<{ jurisdiction: string; mode: string; count: number }>(),

      c.env.AGENT_DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN mode = 'live' THEN 1 ELSE 0 END) as live,
           SUM(CASE WHEN mode = 'test' THEN 1 ELSE 0 END) as test,
           SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) as revoked
         FROM agent_api_keys`,
      ).first<{ total: number; live: number; test: number; revoked: number }>(),

      c.env.AGENT_DB.prepare(
        `SELECT COUNT(*) as count FROM agent_formations
         WHERE status = 'action_required' AND mode = 'live'`,
      ).first<{ count: number }>(),
    ]);

    return ok(
      {
        formations: {
          by_status: formationsByStatus.results,
          by_jurisdiction: formationsByJurisdiction.results,
        },
        api_keys: keyStats,
        pilot_review_queue: pilotQueue?.count ?? 0,
      },
      traceId,
    );
  });
}
