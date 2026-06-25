/**
 * Action routes — Sprint 5 (Owner Actions)
 *
 * PUBLIC, token-authenticated endpoints. No API key required — the high-entropy
 * action token (act_...) IS the bearer credential. These power the owner-facing
 * portal page at docs.offshoreproz.com/portal/actions/{token}.
 *
 *   GET  /v1/actions/:token          → inspect token + formation summary
 *   POST /v1/actions/:token/confirm  → owner confirms; advances the formation
 *
 * Security:
 *  - Tokens are single-use (consumed atomically) and time-boxed.
 *  - Only non-sensitive formation summary is returned (no PII payloads).
 *  - Every confirmation is audited in agent_formation_events (actor_type=owner).
 */

import type { Hono } from "hono";
import type { AppType, FormationStatus } from "../types.ts";
import { ok, accepted, errors } from "../lib/response.ts";
import { getJurisdiction } from "../config/jurisdictions.ts";
import { createLogger } from "../lib/logger.ts";
import { generateTraceId } from "../lib/crypto.ts";
import {
  validateActionToken,
  consumeActionToken,
  createActionToken,
  type ActionPurpose,
} from "../lib/actions.ts";
import { logFormationEvent } from "../lib/events.ts";
import {
  deliverEventToEndpoints,
  type WebhookEventPayload,
} from "../lib/webhooks.ts";
import { canTransition } from "../core/formation-state.ts";
import {
  simulateKyc,
  simulatePayment,
  simulateSignature,
  initiateKycSession,
  initiateCheckoutSession,
  createDocuSealSubmission,
} from "../lib/providers.ts";

interface FormationLite {
  id: string;
  api_key_id: string;
  mode: string;
  status: FormationStatus;
  jurisdiction: string;
  company_name: string;
  amount_total_usd: number | null;
  created_at: string;
}

/**
 * The owner journey, step by step. Each purpose, when its token is consumed,
 * walks the formation through `path` (each hop validated by the state machine)
 * and then issues a token for `nextPurpose` (null = handed to ops/filing).
 *
 * Sandbox simulates the provider for that step; live wiring is Sprint 7 go-live.
 */
const STEP_FLOW: Record<
  ActionPurpose,
  {
    fromStatus: FormationStatus;
    path: FormationStatus[];
    nextPurpose: ActionPurpose | null;
    provider: "none" | "stripe_identity" | "stripe" | "docseal";
  }
> = {
  owner_confirmation: {
    fromStatus: "pending_owner_confirmation",
    path: ["kyc_pending"],
    nextPurpose: "kyc",
    provider: "none",
  },
  kyc: {
    fromStatus: "kyc_pending",
    path: ["kyc_approved", "payment_pending"],
    nextPurpose: "payment",
    provider: "stripe_identity",
  },
  payment: {
    fromStatus: "payment_pending",
    path: ["payment_authorized", "signature_pending"],
    nextPurpose: "signature",
    provider: "stripe",
  },
  signature: {
    fromStatus: "signature_pending",
    path: ["filing_ready"],
    nextPurpose: null,
    provider: "docseal",
  },
};

/** Human-readable label per purpose. */
const PURPOSE_LABEL: Record<ActionPurpose, string> = {
  owner_confirmation: "Confirm cost and process",
  kyc: "Complete identity verification (KYC)",
  payment: "Authorize payment",
  signature: "Sign the operating agreement",
};

/** Label for the NEXT action the owner sees. */
const NEXT_LABEL: Record<ActionPurpose, string> = {
  owner_confirmation: "Confirm cost and process",
  kyc: "Beneficial owner must complete identity verification (KYC)",
  payment: "Payment authorization required",
  signature: "Beneficial owner must sign the operating agreement",
};

function loadFormation(
  db: D1Database,
  formationId: string,
): Promise<FormationLite | null> {
  return db
    .prepare(
      `SELECT id, api_key_id, mode, status, jurisdiction, company_name,
              amount_total_usd, created_at
       FROM agent_formations WHERE id = ? LIMIT 1`,
    )
    .bind(formationId)
    .first<FormationLite>();
}

export function registerActionRoutes(app: Hono<AppType>): void {
  // ── GET /v1/actions/:token — inspect (used by portal page) ────────────────
  app.get("/v1/actions/:token", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const rawToken = c.req.param("token");

    const v = await validateActionToken(c.env.AGENT_DB, rawToken);
    if (!v.ok) {
      return errors.unprocessable(
        traceId,
        v.reason === "expired"
          ? "This action link has expired. Request a new one."
          : v.reason === "consumed"
            ? "This action link was already used."
            : "Action link not found.",
        `action_token_${v.reason}`,
      );
    }

    const formation = await loadFormation(c.env.AGENT_DB, v.token.formation_id);
    if (!formation) return errors.notFound(traceId);

    return ok(
      {
        purpose: v.token.purpose,
        label: PURPOSE_LABEL[v.token.purpose],
        expires_at: v.token.expires_at,
        formation: {
          id: formation.id,
          status: formation.status,
          jurisdiction: formation.jurisdiction,
          company_name: formation.company_name,
          estimated_total_usd: formation.amount_total_usd
            ? formation.amount_total_usd / 100
            : null,
          sandbox: formation.mode === "test",
        },
      },
      traceId,
    );
  });

  // ── POST /v1/actions/:token/confirm — owner advances the formation ────────
  app.post("/v1/actions/:token/confirm", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    const rawToken = c.req.param("token");

    const v = await validateActionToken(c.env.AGENT_DB, rawToken);
    if (!v.ok) {
      return errors.unprocessable(
        traceId,
        v.reason === "expired"
          ? "This action link has expired. Request a new one."
          : v.reason === "consumed"
            ? "This action link was already used."
            : "Action link not found.",
        `action_token_${v.reason}`,
      );
    }

    const token = v.token;
    const formation = await loadFormation(c.env.AGENT_DB, token.formation_id);
    if (!formation) return errors.notFound(traceId);

    const flow = STEP_FLOW[token.purpose];
    const sandbox = formation.mode === "test";

    // The formation must be in the status this step expects.
    if (formation.status !== flow.fromStatus) {
      const finalStatus = flow.path[flow.path.length - 1];
      if (formation.status === finalStatus) {
        return ok(
          { formation_id: formation.id, status: formation.status, already_completed: true },
          traceId,
        );
      }
      return errors.unprocessable(
        traceId,
        `Formation is in status "${formation.status}", not ready for the "${token.purpose}" step.`,
        "step_out_of_order",
      );
    }

    // Validate the full path against the state machine before any mutation.
    let cursor = formation.status;
    for (const next of flow.path) {
      if (!canTransition(cursor, next)) {
        return errors.unprocessable(
          traceId,
          `Illegal transition ${cursor} → ${next}.`,
          "illegal_transition",
        );
      }
      cursor = next;
    }

    // ── PILOT REVIEW GATE ─────────────────────────────────────────────────
    // Intercepts owner_confirmation in live mode for pilot jurisdictions (e.g. MI).
    // Consumes the token, parks the formation at action_required, and notifies ops.
    // Admin resumes via POST /v1/admin/formations/:id/pilot/approve.
    // Sandbox bypasses this gate entirely (always auto-simulates).
    if (!sandbox && token.purpose === "owner_confirmation") {
      const jurConfig = getJurisdiction(formation.jurisdiction);
      if (jurConfig?.requires_pilot_review) {
        const consumed = await consumeActionToken(c.env.AGENT_DB, token.id);
        if (!consumed) {
          return errors.unprocessable(traceId, "This action link was already used.", "action_token_consumed");
        }

        const now = new Date().toISOString();
        const eventId = await logFormationEvent(c.env.AGENT_DB, {
          formation_id: formation.id,
          event_type: "status_change",
          from_status: formation.status,
          to_status: "action_required",
          actor_type: "system",
          trace_id: traceId,
          payload: {
            action: "pilot_review_requested",
            jurisdiction: formation.jurisdiction,
            reason: "pilot_review_pending",
          },
        });

        await c.env.AGENT_DB.prepare(
          `UPDATE agent_formations SET status = ?, updated_at = ? WHERE id = ?`,
        ).bind("action_required", now, formation.id).run();

        c.executionCtx.waitUntil(
          (() => {
            const payload: WebhookEventPayload = {
              id: eventId,
              type: "formation.pilot_review_pending",
              created: now,
              livemode: true,
              data: {
                formation_id: formation.id,
                status: "action_required",
                jurisdiction: formation.jurisdiction,
                company_name: formation.company_name,
                sandbox: false,
              },
            };
            return deliverEventToEndpoints(
              c.env.AGENT_DB,
              c.env,
              formation.api_key_id,
              eventId,
              "formation.pilot_review_pending",
              formation.id,
              payload,
            ).catch(() => {});
          })(),
        );

        logger.info("live: pilot review gate — formation parked", {
          formation_id: formation.id,
          jurisdiction: formation.jurisdiction,
        });

        return accepted(
          {
            formation_id: formation.id,
            status: "action_required",
            pilot_review: true,
            message:
              "Your Marshall Islands DAO LLC application has been submitted. The OffshoreProz team will contact you within 24-48 hours to proceed with identity verification.",
          },
          traceId,
        );
      }
    }

    // ── LIVE MODE: initiate real provider BEFORE consuming the token ──────
    // If the provider call fails, the token is NOT consumed so the owner can retry.
    if (!sandbox && flow.provider !== "none") {
      // Optional body params (email/name for DocuSeal, email for Stripe Checkout)
      const body = await c.req.json().catch(() => ({})) as {
        email?: string;
        name?: string;
      };

      const returnUrl = `${c.env.PORTAL_URL}/portal/formations/${formation.id}`;

      try {
        if (flow.provider === "stripe_identity") {
          const session = await initiateKycSession(
            c.env,
            formation.id,
            returnUrl,
          );

          // Consume token now (provider call succeeded)
          const consumed = await consumeActionToken(c.env.AGENT_DB, token.id);
          if (!consumed) {
            return errors.unprocessable(traceId, "This action link was already used.", "action_token_consumed");
          }

          await logFormationEvent(c.env.AGENT_DB, {
            formation_id: formation.id,
            event_type: "note",
            actor_type: "owner",
            actor_id: token.id,
            trace_id: traceId,
            payload: {
              action: "kyc_session_initiated",
              kyc_session_id: session.session_id,
              provider: "stripe_identity",
            },
          });

          logger.info("live: KYC session initiated", {
            formation_id: formation.id,
            session_id: session.session_id,
          });

          return ok(
            {
              formation_id: formation.id,
              status: formation.status, // unchanged — webhook advances it
              step_initiated: token.purpose,
              provider: "stripe_identity",
              redirect_url: session.url,
              redirect_note:
                "Complete your identity verification at the URL above. Your formation status will update automatically after verification.",
              sandbox: false,
            },
            traceId,
          );
        }

        if (flow.provider === "stripe") {
          const amountCents = formation.amount_total_usd ?? 49900;
          const session = await initiateCheckoutSession(
            c.env,
            formation.id,
            amountCents,
            formation.jurisdiction,
            formation.company_name,
            body.email,
            `${returnUrl}?payment=success`,
            `${returnUrl}?payment=cancelled`,
          );

          const consumed = await consumeActionToken(c.env.AGENT_DB, token.id);
          if (!consumed) {
            return errors.unprocessable(traceId, "This action link was already used.", "action_token_consumed");
          }

          await logFormationEvent(c.env.AGENT_DB, {
            formation_id: formation.id,
            event_type: "note",
            actor_type: "owner",
            actor_id: token.id,
            trace_id: traceId,
            payload: {
              action: "checkout_session_initiated",
              checkout_session_id: session.checkout_session_id,
              provider: "stripe",
            },
          });

          logger.info("live: Checkout session initiated", {
            formation_id: formation.id,
            checkout_session_id: session.checkout_session_id,
          });

          return ok(
            {
              formation_id: formation.id,
              status: formation.status,
              step_initiated: token.purpose,
              provider: "stripe",
              redirect_url: session.url,
              redirect_note:
                "Complete payment at the URL above. Your formation status will update automatically after payment.",
              sandbox: false,
            },
            traceId,
          );
        }

        if (flow.provider === "docseal") {
          if (!body.email || !body.name) {
            return errors.validation(traceId, [
              {
                field: "email",
                message: "email and name are required in the request body for the signature step",
              },
            ]);
          }

          const submission = await createDocuSealSubmission(
            c.env,
            formation.id,
            formation.jurisdiction,
            formation.company_name,
            body.email,
            body.name,
          );

          const consumed = await consumeActionToken(c.env.AGENT_DB, token.id);
          if (!consumed) {
            return errors.unprocessable(traceId, "This action link was already used.", "action_token_consumed");
          }

          // Store submission ID so the webhook can look up the formation
          await c.env.AGENT_DB.prepare(
            `UPDATE agent_formations
             SET signing_envelope_id = ?, signing_provider = 'docseal', updated_at = ?
             WHERE id = ?`,
          )
            .bind(submission.submission_id, new Date().toISOString(), formation.id)
            .run()
            .catch(() => {});

          await logFormationEvent(c.env.AGENT_DB, {
            formation_id: formation.id,
            event_type: "note",
            actor_type: "owner",
            actor_id: token.id,
            trace_id: traceId,
            payload: {
              action: "docseal_submission_created",
              submission_id: submission.submission_id,
              provider: "docseal",
              signer_email: body.email,
            },
          });

          logger.info("live: DocuSeal submission created", {
            formation_id: formation.id,
            submission_id: submission.submission_id,
          });

          return ok(
            {
              formation_id: formation.id,
              status: formation.status,
              step_initiated: token.purpose,
              provider: "docseal",
              redirect_url: submission.signing_url,
              redirect_note:
                "Sign the operating agreement at the URL above (also sent by email). Your formation status will update automatically after signing.",
              sandbox: false,
            },
            traceId,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Provider error";
        logger.error("live: provider initiation failed", {
          formation_id: formation.id,
          provider: flow.provider,
          error: message,
        });
        return errors.unprocessable(
          traceId,
          `Could not initiate ${flow.provider} step: ${message}`,
          "provider_error",
        );
      }
    }

    // ── SANDBOX: consume token then simulate provider instantly ────────────
    const consumed = await consumeActionToken(c.env.AGENT_DB, token.id);
    if (!consumed) {
      return errors.unprocessable(traceId, "This action link was already used.", "action_token_consumed");
    }

    // Simulate the provider for this step (sandbox = always success).
    let providerResult: Record<string, unknown> | null = null;
    if (flow.provider === "stripe_identity") {
      providerResult = { kyc: simulateKyc(true) };
    } else if (flow.provider === "stripe") {
      providerResult = {
        payment: simulatePayment(
          formation.amount_total_usd ? formation.amount_total_usd / 100 : 0,
          true,
        ),
      };
    } else if (flow.provider === "docseal") {
      providerResult = { signature: simulateSignature(true) };
    }

    // Walk the path, logging each transition; the LAST event drives the webhook.
    const finalStatus = flow.path[flow.path.length - 1];
    let prev = formation.status;
    let lastEventId = "";
    const now = new Date().toISOString();
    for (const next of flow.path) {
      lastEventId = await logFormationEvent(c.env.AGENT_DB, {
        formation_id: formation.id,
        event_type: "status_change",
        from_status: prev,
        to_status: next,
        actor_type: "owner",
        actor_id: token.id,
        trace_id: traceId,
        payload: {
          action: token.purpose,
          token_id: token.id,
          provider: flow.provider,
          ...(providerResult ?? {}),
        },
      });
      prev = next;
    }

    await c.env.AGENT_DB.prepare(
      `UPDATE agent_formations SET status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(finalStatus, now, formation.id)
      .run();

    // Mint the next-step token if the journey continues.
    let nextAction: {
      type: string;
      label: string;
      url: string;
      expires_at: string;
      sandbox_note?: string | undefined;
    } | null = null;
    if (flow.nextPurpose) {
      const nextToken = await createActionToken(c.env.AGENT_DB, formation.id, flow.nextPurpose);
      nextAction = {
        type: flow.nextPurpose,
        label: NEXT_LABEL[flow.nextPurpose],
        url: `${c.env.PORTAL_URL}/portal/actions/${nextToken.raw_token}`,
        expires_at: nextToken.expires_at,
        sandbox_note: `Sandbox: ${flow.nextPurpose} is simulated — no real ${flow.nextPurpose === "payment" ? "charge" : "document"}.`,
      };
    }

    logger.info("sandbox: owner step completed", {
      formation_id: formation.id,
      purpose: token.purpose,
      from_status: formation.status,
      to_status: finalStatus,
      provider: flow.provider,
    });

    // Fire formation.status_changed webhook (non-blocking).
    c.executionCtx.waitUntil(
      (() => {
        const payload: WebhookEventPayload = {
          id: lastEventId,
          type: "formation.status_changed",
          created: now,
          livemode: false, // sandbox is never livemode
          data: {
            formation_id: formation.id,
            status: finalStatus,
            previous_status: formation.status,
            step_completed: token.purpose,
            jurisdiction: formation.jurisdiction,
            company_name: formation.company_name,
            sandbox: true,
          },
        };
        return deliverEventToEndpoints(
          c.env.AGENT_DB,
          c.env,
          formation.api_key_id,
          lastEventId,
          "formation.status_changed",
          formation.id,
          payload,
        ).catch(() => {});
      })(),
    );

    return ok(
      {
        formation_id: formation.id,
        status: finalStatus,
        step_completed: token.purpose,
        confirmed: true,
        provider_result: providerResult,
        next_action: nextAction,
        filing_note:
          flow.nextPurpose === null
            ? "All owner steps complete. The OffshoreProz team will file the formation (manual-assisted) and publish documents."
            : undefined,
      },
      traceId,
    );
  });
}
