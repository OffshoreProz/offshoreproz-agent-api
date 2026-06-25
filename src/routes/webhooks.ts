/**
 * Webhook routes — Sprint 4
 *
 * POST   /v1/webhooks                        Register a webhook endpoint
 * GET    /v1/webhooks                        List all webhooks for the API key
 * GET    /v1/webhooks/:id                    Get a single webhook
 * DELETE /v1/webhooks/:id                    Deactivate a webhook
 * GET    /v1/webhooks/:id/deliveries         Recent delivery attempts (last 50)
 *
 * Authentication: Bearer op_test_... or op_live_... (requireApiKey middleware)
 *
 * Signing secrets:
 *   Returned ONCE at registration as "whsec_<hex>".
 *   Derived deterministically from endpointId + API_KEY_ENCRYPTION_SECRET.
 *   Never stored raw — recomputed at delivery time.
 *
 *   Clients should store their secret and use it to verify incoming events:
 *     X-OffshoreProz-Signature: t=<ts>,v1=<hmac_hex>
 *     Signed payload: "<ts>.<raw_body>"
 *
 * Event subscription patterns:
 *   "*"                     — all events
 *   "formation.*"           — all formation events
 *   "formation.created"     — specific event type
 *   ["formation.created", "formation.complete"]  — multiple
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { AppType } from "../types.ts";
import { ok, created, errors } from "../lib/response.ts";
import { requireApiKey } from "../middleware/auth.ts";
import { rateLimiter } from "../middleware/rate-limit.ts";
import { createLogger } from "../lib/logger.ts";
import { generateTraceId } from "../lib/crypto.ts";
import {
  deriveWebhookSecret,
  type WebhookEndpointRow,
} from "../lib/webhooks.ts";

// ─── Valid event patterns ─────────────────────────────────────────────────────

const VALID_EVENT_PATTERNS = [
  "*",
  "formation.*",
  "formation.created",
  "formation.status_changed",
  "formation.cancelled",
  "formation.portal_synced",
  "formation.portal_sync_failed",
  "formation.payment_received",
  "formation.signed",
  "formation.filed",
  "formation.complete",
  "formation.error",
] as const;

type EventPattern = (typeof VALID_EVENT_PATTERNS)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createWebhookSchema = z.object({
  url: z
    .string()
    .url("Must be a valid HTTPS URL")
    .max(500)
    .refine(
      (u) => u.startsWith("https://"),
      "Webhook URL must use HTTPS for security",
    ),
  events: z
    .array(
      z.enum(
        VALID_EVENT_PATTERNS as unknown as [EventPattern, ...EventPattern[]],
      ),
    )
    .min(1)
    .max(20)
    .default(["*"] as EventPattern[]),
  description: z.string().max(200).optional(),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerWebhookRoutes(app: Hono<AppType>): void {
  // ── POST /v1/webhooks ─────────────────────────────────────────────────────
  app.post("/v1/webhooks", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const log = createLogger(traceId);

    const body = await c.req.json().catch(() => null);
    const parsed = createWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return errors.validation(
        traceId,
        parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      );
    }

    const { url, events, description } = parsed.data;

    // Enforce a max of 10 active webhooks per API key
    const countResult = await c.env.AGENT_DB.prepare(
      `SELECT COUNT(*) as n FROM agent_webhook_endpoints
       WHERE api_key_id = ? AND active = 1`,
    )
      .bind(apiKeyId)
      .first<{ n: number }>();

    if ((countResult?.n ?? 0) >= 10) {
      return errors.unprocessable(
        traceId,
        "Maximum of 10 active webhooks per API key. Delete an existing webhook before adding a new one.",
        "webhook_limit_reached",
      );
    }

    const id = `wh_${generateTraceId().replace(/-/g, "").slice(0, 18)}`;
    const now = new Date().toISOString();

    // Derive signing secret (deterministic from id + env)
    const signingSecret = await deriveWebhookSecret(
      id,
      c.env.API_KEY_ENCRYPTION_SECRET,
    );

    // Store secret_hash = SHA-256(signingSecret) for observability only
    const secretBytes = new TextEncoder().encode(signingSecret);
    const hashBuf = await crypto.subtle.digest("SHA-256", secretBytes);
    const secretHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await c.env.AGENT_DB.prepare(
      `INSERT INTO agent_webhook_endpoints
       (id, api_key_id, url, events_json, secret_hash, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, apiKeyId, url, JSON.stringify(events), secretHash, now, now)
      .run();

    log.info("webhook_registered", {
      webhook_id: id,
      url,
      events,
    });

    return created(
      {
        id,
        url,
        events,
        description: description ?? null,
        active: true,
        created_at: now,
        // ⚠️ Secret returned ONCE — store it securely, it cannot be retrieved again.
        // Use it to verify the X-OffshoreProz-Signature header on incoming events.
        signing_secret: signingSecret,
        _note:
          "Store signing_secret securely — it will not be shown again. See docs for verification guide.",
      },
      traceId,
    );
  });

  // ── GET /v1/webhooks ──────────────────────────────────────────────────────
  app.get("/v1/webhooks", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;

    const result = await c.env.AGENT_DB.prepare(
      `SELECT id, api_key_id, url, events_json, active, created_at, updated_at
       FROM agent_webhook_endpoints
       WHERE api_key_id = ?
       ORDER BY created_at DESC`,
    )
      .bind(apiKeyId)
      .all<Omit<WebhookEndpointRow, "secret_hash">>();

    const webhooks = (result.results ?? []).map((w) => ({
      id: w.id,
      url: w.url,
      events: JSON.parse(w.events_json ?? '["*"]') as string[],
      active: w.active === 1,
      created_at: w.created_at,
      updated_at: w.updated_at,
    }));

    return ok({ webhooks, count: webhooks.length }, traceId);
  });

  // ── GET /v1/webhooks/:id ──────────────────────────────────────────────────
  app.get("/v1/webhooks/:id", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const webhookId = c.req.param("id");

    const hook = await c.env.AGENT_DB.prepare(
      `SELECT id, url, events_json, active, created_at, updated_at
       FROM agent_webhook_endpoints
       WHERE id = ? AND api_key_id = ?
       LIMIT 1`,
    )
      .bind(webhookId, apiKeyId)
      .first<Omit<WebhookEndpointRow, "secret_hash" | "api_key_id">>();

    if (!hook) return errors.notFound(traceId);

    return ok(
      {
        id: hook.id,
        url: hook.url,
        events: JSON.parse(hook.events_json ?? '["*"]') as string[],
        active: hook.active === 1,
        created_at: hook.created_at,
        updated_at: hook.updated_at,
        _note:
          "Signing secret is not retrievable after creation. Register a new webhook to rotate secrets.",
      },
      traceId,
    );
  });

  // ── DELETE /v1/webhooks/:id ───────────────────────────────────────────────
  app.delete("/v1/webhooks/:id", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const webhookId = c.req.param("id");

    const hook = await c.env.AGENT_DB.prepare(
      `SELECT id FROM agent_webhook_endpoints
       WHERE id = ? AND api_key_id = ? LIMIT 1`,
    )
      .bind(webhookId, apiKeyId)
      .first<{ id: string }>();

    if (!hook) return errors.notFound(traceId);

    const now = new Date().toISOString();
    await c.env.AGENT_DB.prepare(
      `UPDATE agent_webhook_endpoints
       SET active = 0, updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, webhookId)
      .run();

    return ok({ id: webhookId, deleted: true, deleted_at: now }, traceId);
  });

  // ── GET /v1/webhooks/:id/deliveries ───────────────────────────────────────
  app.get(
    "/v1/webhooks/:id/deliveries",
    requireApiKey,
    rateLimiter,
    async (c) => {
      const traceId = (c.get("trace_id") as string) ?? generateTraceId();
      const apiKeyId = c.get("api_key_id") as string;
      const webhookId = c.req.param("id");

      // Verify ownership
      const hook = await c.env.AGENT_DB.prepare(
        `SELECT id FROM agent_webhook_endpoints
         WHERE id = ? AND api_key_id = ? LIMIT 1`,
      )
        .bind(webhookId, apiKeyId)
        .first<{ id: string }>();

      if (!hook) return errors.notFound(traceId);

      const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 100);

      const result = await c.env.AGENT_DB.prepare(
        `SELECT id, endpoint_id, formation_id, event_type, event_id,
                attempt_number, status, response_status,
                response_body_truncated, next_retry_at,
                last_error_code, delivered_at, created_at
         FROM agent_webhook_deliveries
         WHERE endpoint_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
        .bind(webhookId, limit)
        .all<{
          id: string;
          endpoint_id: string;
          formation_id: string | null;
          event_type: string;
          event_id: string;
          attempt_number: number;
          status: string;
          response_status: number | null;
          response_body_truncated: string | null;
          next_retry_at: string | null;
          last_error_code: string | null;
          delivered_at: string | null;
          created_at: string;
        }>();

      return ok(
        {
          deliveries: result.results ?? [],
          count: result.results?.length ?? 0,
          webhook_id: webhookId,
        },
        traceId,
      );
    },
  );
}
