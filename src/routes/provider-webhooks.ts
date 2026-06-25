/**
 * Inbound webhook handlers from third-party providers.
 *
 * ⚠️  THESE ARE INBOUND ROUTES (provider → us). They are distinct from the
 *     OUTBOUND webhook system at /v1/webhooks (API-key-holder subscriptions).
 *     Do NOT mix these namespaces.
 *
 *   POST /webhooks/stripe   — Stripe events (Identity + Checkout)
 *   POST /webhooks/docseal  — DocuSeal form-completion events
 *
 * Authentication: signature-based (no Bearer API key required).
 * Both routes return HTTP 200 immediately for any request so the provider
 * does not retry on transient processing errors. Processing happens inside
 * executionCtx.waitUntil().
 *
 * Events handled:
 *   Stripe:   identity.verification_session.verified
 *             identity.verification_session.requires_input
 *             checkout.session.completed
 *   DocuSeal: form.completed
 */

import type { Hono } from "hono";
import type { AppType, FormationStatus } from "../types.ts";
import { createLogger } from "../lib/logger.ts";
import { generateTraceId, timingSafeCompare } from "../lib/crypto.ts";
import { logFormationEvent } from "../lib/events.ts";
import { deliverEventToEndpoints } from "../lib/webhooks.ts";
import { canTransition } from "../core/formation-state.ts";
import { createActionToken } from "../lib/actions.ts";
import {
  sendPaymentReadyEmail,
  sendSignatureReadyEmail,
  sendFilingQueueEmail,
  sendKycFailedEmail,
} from "../lib/email.ts";

// ─── Stripe signature verification ────────────────────────────────────────────

async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const parts = sigHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;

  const ts = parseInt(tPart.slice(2), 10);
  if (Number.isNaN(ts)) return false;

  // Reject events older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const toSign = `${ts}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(toSign));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeCompare(hex, v1Part.slice(3));
}

// ─── DocuSeal signature verification ──────────────────────────────────────────

async function verifyDocuSealSignature(
  payload: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeCompare(b64, sigHeader);
}

// ─── Formation state advance helper ───────────────────────────────────────────

interface FormationRow {
  id: string;
  api_key_id: string;
  mode: string;
  status: FormationStatus;
  jurisdiction: string;
  company_name: string;
  amount_total_usd: number | null;
}

async function loadFormationById(db: D1Database, id: string): Promise<FormationRow | null> {
  return db
    .prepare(
      `SELECT id, api_key_id, mode, status, jurisdiction, company_name, amount_total_usd
       FROM agent_formations WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<FormationRow>();
}

/**
 * Walk the formation through `path` (each hop validated by the state machine),
 * log events, update DB, mint a next-step action token if `nextPurpose` is set,
 * and fire the outbound webhook.
 *
 * This is a fire-and-forget helper — all errors are caught and logged.
 */
async function advanceFormation(
  db: D1Database,
  env: AppType["Bindings"],
  formation: FormationRow,
  path: FormationStatus[],
  traceId: string,
  eventPayload: Record<string, unknown>,
  nextPurpose?: "payment" | "signature" | null,
): Promise<void> {
  const logger = createLogger(traceId);

  // Validate each hop against the state machine before any mutation
  let cursor = formation.status;
  for (const next of path) {
    if (!canTransition(cursor, next)) {
      logger.warn(`provider_webhook: illegal transition ${cursor} → ${next}`, {
        formation_id: formation.id,
      });
      return;
    }
    cursor = next;
  }

  const finalStatus = path[path.length - 1];
  if (!finalStatus) return;

  const now = new Date().toISOString();
  let prev = formation.status;
  let lastEventId = "";

  for (const next of path) {
    lastEventId = await logFormationEvent(db, {
      formation_id: formation.id,
      event_type: "status_change",
      from_status: prev,
      to_status: next,
      actor_type: "webhook",
      trace_id: traceId,
      payload: eventPayload,
    });
    prev = next;
  }

  await db
    .prepare(`UPDATE agent_formations SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(finalStatus, now, formation.id)
    .run();

  logger.info("provider_webhook: formation advanced", {
    formation_id: formation.id,
    from: formation.status,
    to: finalStatus,
    event_id: lastEventId,
  });

  // Mint next action token and include in outbound webhook payload
  let nextActionUrl: string | null = null;
  let nextTokenExpiresAt: string | null = null;
  if (nextPurpose) {
    try {
      const token = await createActionToken(db, formation.id, nextPurpose);
      nextActionUrl = `${env.PORTAL_URL}/portal/actions/${token.raw_token}`;
      nextTokenExpiresAt = token.expires_at;
    } catch {
      logger.warn("provider_webhook: failed to mint next action token", {
        formation_id: formation.id,
        next_purpose: nextPurpose,
      });
    }
  }

  // Fire outbound webhook (best-effort)
  await deliverEventToEndpoints(
    db,
    env,
    formation.api_key_id,
    lastEventId,
    "formation.status_changed",
    formation.id,
    {
      id: lastEventId,
      type: "formation.status_changed",
      created: now,
      livemode: formation.mode === "live",
      data: {
        formation_id: formation.id,
        status: finalStatus,
        previous_status: formation.status,
        jurisdiction: formation.jurisdiction,
        company_name: formation.company_name,
        sandbox: formation.mode === "test",
        ...(nextActionUrl ? { next_action_url: nextActionUrl } : {}),
      },
    },
  ).catch(() => {});

  // Send step notification email to owner (live mode only; skip sandbox)
  if (formation.mode !== "test" && env.RESEND_API_KEY) {
    const keyRow = await db
      .prepare(`SELECT owner_email FROM agent_api_keys WHERE id = ? LIMIT 1`)
      .bind(formation.api_key_id)
      .first<{ owner_email: string }>();
    const ownerEmail = keyRow?.owner_email;

    if (ownerEmail) {
      if (nextPurpose === "payment" && nextActionUrl && nextTokenExpiresAt) {
        await sendPaymentReadyEmail(
          env.RESEND_API_KEY,
          ownerEmail,
          formation.company_name,
          nextActionUrl,
          nextTokenExpiresAt,
        ).catch(() => {});
      } else if (nextPurpose === "signature" && nextActionUrl && nextTokenExpiresAt) {
        await sendSignatureReadyEmail(
          env.RESEND_API_KEY,
          ownerEmail,
          formation.company_name,
          formation.jurisdiction,
          nextActionUrl,
          nextTokenExpiresAt,
        ).catch(() => {});
      } else if (nextPurpose === null && finalStatus === "filing_ready") {
        await sendFilingQueueEmail(
          env.RESEND_API_KEY,
          ownerEmail,
          formation.company_name,
          formation.jurisdiction,
        ).catch(() => {});
      }
    }
  }
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerProviderWebhookRoutes(app: Hono<AppType>): void {
  // ── POST /webhooks/stripe ─────────────────────────────────────────────────
  // Handles: identity.verification_session.*, checkout.session.completed
  app.post("/webhooks/stripe", async (c) => {
    const traceId = generateTraceId();
    const logger = createLogger(traceId);

    // Always ack immediately so Stripe doesn't retry on processing errors
    const rawBody = await c.req.text();

    c.executionCtx.waitUntil(
      (async () => {
        try {
          // Verify signature if secret is configured
          const sigHeader = c.req.header("stripe-signature") ?? "";
          if (c.env.STRIPE_WEBHOOK_SECRET) {
            const valid = await verifyStripeSignature(rawBody, sigHeader, c.env.STRIPE_WEBHOOK_SECRET);
            if (!valid) {
              logger.warn("stripe_webhook: invalid signature — ignoring", { trace_id: traceId });
              return;
            }
          } else {
            logger.warn("stripe_webhook: STRIPE_WEBHOOK_SECRET not set — rejecting request");
            return; // fail closed: never process unsigned webhooks
          }

          const event = JSON.parse(rawBody) as {
            id: string;
            type: string;
            data: { object: Record<string, unknown> };
          };

          logger.info("stripe_webhook: received", {
            event_id: event.id,
            event_type: event.type,
          });

          const obj = event.data.object;

          if (event.type === "identity.verification_session.verified") {
            // KYC passed
            const formationId = (obj.metadata as Record<string, string> | undefined)?.formation_id;
            if (!formationId) {
              logger.warn("stripe_webhook: no formation_id in identity session metadata");
              return;
            }

            const formation = await loadFormationById(c.env.AGENT_DB, formationId);
            if (!formation) {
              logger.warn("stripe_webhook: formation not found", { formation_id: formationId });
              return;
            }

            if (formation.status !== "kyc_pending") {
              logger.info("stripe_webhook: formation not in kyc_pending, skipping", {
                formation_id: formationId,
                current_status: formation.status,
              });
              return;
            }

            await advanceFormation(
              c.env.AGENT_DB,
              c.env,
              formation,
              ["kyc_approved", "payment_pending"],
              traceId,
              {
                event: event.type,
                stripe_event_id: event.id,
                kyc_session_id: String(obj.id ?? ""),
              },
              "payment",
            );
          } else if (event.type === "identity.verification_session.requires_input") {
            // KYC needs more info or failed
            const formationId = (obj.metadata as Record<string, string> | undefined)?.formation_id;
            if (!formationId) return;

            const formation = await loadFormationById(c.env.AGENT_DB, formationId);
            if (!formation || formation.status !== "kyc_pending") return;

            const now = new Date().toISOString();
            const lastReason = (obj.last_error as { code?: string } | null)?.code ?? "requires_input";

            await logFormationEvent(c.env.AGENT_DB, {
              formation_id: formationId,
              event_type: "status_change",
              from_status: "kyc_pending",
              to_status: "kyc_failed",
              actor_type: "webhook",
              trace_id: traceId,
              payload: { event: event.type, stripe_event_id: event.id, reason: lastReason },
            });

            await c.env.AGENT_DB.prepare(
              `UPDATE agent_formations
               SET status = 'kyc_failed', error_code = ?, error_message = ?, updated_at = ?
               WHERE id = ?`,
            )
              .bind(
                "kyc_requires_input",
                `Identity verification requires additional input: ${lastReason}`,
                now,
                formationId,
              )
              .run();

            logger.info("stripe_webhook: KYC requires input → kyc_failed", {
              formation_id: formationId,
              reason: lastReason,
            });

            // Notify owner (live mode only)
            if (formation.mode !== "test" && c.env.RESEND_API_KEY) {
              const keyRow = await c.env.AGENT_DB
                .prepare(`SELECT owner_email FROM agent_api_keys WHERE id = ? LIMIT 1`)
                .bind(formation.api_key_id)
                .first<{ owner_email: string }>();
              if (keyRow?.owner_email) {
                await sendKycFailedEmail(
                  c.env.RESEND_API_KEY,
                  keyRow.owner_email,
                  formation.company_name,
                  `Identity verification requires additional information: ${lastReason}`,
                ).catch(() => {});
              }
            }
          } else if (event.type === "checkout.session.completed") {
            // Payment succeeded
            const formationId = (obj.metadata as Record<string, string> | undefined)?.formation_id;
            const paymentIntentId = obj.payment_intent as string | undefined;

            if (!formationId) {
              logger.warn("stripe_webhook: no formation_id in checkout session metadata");
              return;
            }

            const formation = await loadFormationById(c.env.AGENT_DB, formationId);
            if (!formation) {
              logger.warn("stripe_webhook: formation not found", { formation_id: formationId });
              return;
            }

            if (formation.status !== "payment_pending") {
              logger.info("stripe_webhook: formation not in payment_pending, skipping", {
                formation_id: formationId,
                current_status: formation.status,
              });
              return;
            }

            // Store payment intent ID
            if (paymentIntentId) {
              await c.env.AGENT_DB.prepare(
                `UPDATE agent_formations SET stripe_payment_intent_id = ? WHERE id = ?`,
              )
                .bind(paymentIntentId, formationId)
                .run()
                .catch(() => {});
            }

            await advanceFormation(
              c.env.AGENT_DB,
              c.env,
              formation,
              ["payment_authorized", "signature_pending"],
              traceId,
              {
                event: event.type,
                stripe_event_id: event.id,
                checkout_session_id: String(obj.id ?? ""),
                payment_intent_id: paymentIntentId ?? null,
              },
              "signature",
            );
          } else {
            // Unhandled Stripe event — ack and ignore
            logger.info("stripe_webhook: unhandled event type", { event_type: event.type });
          }
        } catch (err) {
          logger.error("stripe_webhook: processing error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );

    return new Response("ok", { status: 200 });
  });

  // ── POST /webhooks/docseal ────────────────────────────────────────────────
  // Handles: form.completed
  app.post("/webhooks/docseal", async (c) => {
    const traceId = generateTraceId();
    const logger = createLogger(traceId);

    const rawBody = await c.req.text();

    c.executionCtx.waitUntil(
      (async () => {
        try {
          // Verify signature if secret is configured
          const sigHeader = c.req.header("x-docuseal-signature") ?? "";
          if (c.env.DOCUSEAL_WEBHOOK_SECRET) {
            if (!sigHeader) {
              logger.warn("docseal_webhook: missing X-Docuseal-Signature header");
              return;
            }
            const valid = await verifyDocuSealSignature(
              rawBody,
              sigHeader,
              c.env.DOCUSEAL_WEBHOOK_SECRET,
            );
            if (!valid) {
              logger.warn("docseal_webhook: invalid signature — ignoring");
              return;
            }
          } else {
            logger.warn("docseal_webhook: DOCUSEAL_WEBHOOK_SECRET not set — rejecting request");
            return; // fail closed: never process unsigned webhooks
          }

          const event = JSON.parse(rawBody) as {
            event_type: string;
            data: {
              submission?: {
                id: number;
                submitters?: Array<{
                  id: number;
                  metadata?: Record<string, string>;
                  email?: string;
                }>;
              };
            };
          };

          logger.info("docseal_webhook: received", { event_type: event.event_type });

          if (event.event_type !== "form.completed") {
            logger.info("docseal_webhook: unhandled event type", {
              event_type: event.event_type,
            });
            return;
          }

          const submission = event.data.submission;
          if (!submission) {
            logger.warn("docseal_webhook: no submission in event");
            return;
          }

          // Look up formation_id from submitter metadata
          const submitter = submission.submitters?.[0];
          let formationId = submitter?.metadata?.formation_id;

          // Fallback: look up by signing_envelope_id (submission ID stored at initiation)
          if (!formationId) {
            const row = await c.env.AGENT_DB.prepare(
              `SELECT id FROM agent_formations
               WHERE signing_envelope_id = ? AND signing_provider = 'docseal' LIMIT 1`,
            )
              .bind(String(submission.id))
              .first<{ id: string }>();
            formationId = row?.id;
          }

          if (!formationId) {
            logger.warn("docseal_webhook: cannot resolve formation_id", {
              submission_id: submission.id,
            });
            return;
          }

          const formation = await loadFormationById(c.env.AGENT_DB, formationId);
          if (!formation) {
            logger.warn("docseal_webhook: formation not found", { formation_id: formationId });
            return;
          }

          if (formation.status !== "signature_pending") {
            logger.info("docseal_webhook: formation not in signature_pending, skipping", {
              formation_id: formationId,
              current_status: formation.status,
            });
            return;
          }

          // Advance signature_pending → filing_ready (no next token — ops takes over)
          await advanceFormation(
            c.env.AGENT_DB,
            c.env,
            formation,
            ["filing_ready"],
            traceId,
            {
              event: event.event_type,
              submission_id: submission.id,
              signed_by: submitter?.email ?? "unknown",
            },
            null, // no next action token — filing is manual-assisted
          );

          logger.info("docseal_webhook: formation advanced to filing_ready", {
            formation_id: formationId,
          });
        } catch (err) {
          logger.error("docseal_webhook: processing error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );

    return new Response("ok", { status: 200 });
  });
}
