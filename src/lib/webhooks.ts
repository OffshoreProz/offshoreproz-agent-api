/**
 * Webhook delivery — Sprint 4
 *
 * Architecture:
 *   1. Client registers a URL → POST /v1/webhooks
 *      Returns signing secret ONCE as "whsec_<hex>".
 *      Secret is derived deterministically: HMAC-SHA256(API_KEY_ENCRYPTION_SECRET, endpointId)
 *      → never stored raw; can be recomputed at delivery time.
 *
 *   2. On formation events, call deliverEventToEndpoints() via ctx.waitUntil().
 *      Fan-out: one delivery attempt per active subscribed endpoint.
 *
 *   3. Signature header: X-OffshoreProz-Signature: t=<unix_ts>,v1=<hmac_hex>
 *      Payload signed: "<unix_ts>.<raw_json>"
 *      This matches Stripe's webhook signing scheme for compatibility.
 *
 * Retry schedule (per endpoint):
 *   Attempt 1: immediate
 *   Attempt 2: 30 seconds after failure
 *   Attempt 3: 5 minutes after failure
 *   Dead-lettered after 3 failures
 *
 * Tables: agent_webhook_endpoints, agent_webhook_deliveries
 * (defined in migrations/agent-db/0001_initial_schema.sql)
 */

import { generateTraceId } from "./crypto.ts";
import type { Env } from "../types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Delivery retry delays in ms: attempt 1 (immediate), attempt 2, attempt 3 */
const RETRY_DELAYS_MS: readonly number[] = [0, 30_000, 300_000];
const MAX_ATTEMPTS = 3;
const DELIVERY_TIMEOUT_MS = 8_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebhookEndpointRow {
  id: string;
  api_key_id: string;
  url: string;
  events_json: string; // JSON array of event patterns, e.g. ["*"] or ["formation.*"]
  secret_hash: string; // SHA-256 of the derived secret (for verification logs only)
  active: number; // 1 = active, 0 = deactivated
  created_at: string;
  updated_at: string | null;
}

export interface WebhookEventPayload {
  /** Globally unique event ID: evt_... */
  id: string;
  /** Public event type: "formation.created", "formation.status_changed", etc. */
  type: string;
  /** ISO 8601 creation timestamp */
  created: string;
  /** true for production keys, false for test keys */
  livemode: boolean;
  /** Event-specific data */
  data: Record<string, unknown>;
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Deterministically derive a webhook signing secret from:
 *   endpointId + API_KEY_ENCRYPTION_SECRET (env var)
 *
 * Returns "whsec_<64-char hex>". Same input always produces same output.
 * The client receives this once at registration and stores it on their side.
 */
export async function deriveWebhookSecret(
  endpointId: string,
  encryptionSecret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(encryptionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`whsec:${endpointId}`),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `whsec_${hex}`;
}

/**
 * Build the X-OffshoreProz-Signature header value.
 *
 * Format: t=<unix_timestamp_seconds>,v1=<hmac_hex>
 *
 * The HMAC input is: "<timestamp>.<raw_json_payload>"
 *
 * To verify on the client side:
 *   const secret = Buffer.from(whsec.replace('whsec_', ''), 'hex')
 *   const expected = createHmac('sha256', secret)
 *     .update(`${t}.${rawBody}`).digest('hex')
 *   assert(expected === v1)
 */
export async function buildWebhookSignature(
  whsec: string, // "whsec_<64-char hex>"
  unixTimestamp: number,
  rawPayload: string,
): Promise<string> {
  const secretHex = whsec.replace(/^whsec_/, "");
  const secretBytes = new Uint8Array(
    (secretHex.match(/../g) ?? []).map((h) => parseInt(h, 16)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${unixTimestamp}.${rawPayload}`),
  );
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${unixTimestamp},v1=${hexSig}`;
}

// ─── Fan-out delivery ─────────────────────────────────────────────────────────

/**
 * Deliver a formation event to all active webhook endpoints registered for an API key.
 *
 * Call this via ctx.waitUntil() — never awaited in the response path.
 * Safe: all errors are caught internally. A delivery failure never affects the API response.
 *
 * @param db          AGENT_DB binding
 * @param env         Worker env (needs API_KEY_ENCRYPTION_SECRET)
 * @param apiKeyId    The API key that owns the formation
 * @param eventId     The evt_... ID logged in agent_formation_events
 * @param eventType   Public event type string ("formation.created", etc.)
 * @param formationId Formation ID for the delivery record
 * @param payload     Full webhook payload to deliver
 */
export async function deliverEventToEndpoints(
  db: D1Database,
  env: Env,
  apiKeyId: string,
  eventId: string,
  eventType: string,
  formationId: string | null,
  payload: WebhookEventPayload,
): Promise<void> {
  const endpoints = await db
    .prepare(
      `SELECT id, url, events_json FROM agent_webhook_endpoints
       WHERE api_key_id = ? AND active = 1`,
    )
    .bind(apiKeyId)
    .all<Pick<WebhookEndpointRow, "id" | "url" | "events_json">>();

  if (!endpoints.results?.length) return;

  const payloadStr = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);

  for (const endpoint of endpoints.results) {
    // Check if endpoint is subscribed to this event type
    const subscribed: string[] = JSON.parse(endpoint.events_json ?? '["*"]');
    const matches =
      subscribed.includes("*") ||
      subscribed.includes(eventType) ||
      subscribed.some(
        (pattern) =>
          pattern.endsWith(".*") &&
          eventType.startsWith(pattern.replace(/\.\*$/, ".")),
      );

    if (!matches) continue;

    // Derive the endpoint's signing secret deterministically
    const secret = await deriveWebhookSecret(
      endpoint.id,
      env.API_KEY_ENCRYPTION_SECRET,
    );
    const signature = await buildWebhookSignature(secret, ts, payloadStr);

    // Create queued delivery record
    const deliveryId = `del_${generateTraceId().replace(/-/g, "").slice(0, 14)}`;
    await db
      .prepare(
        `INSERT INTO agent_webhook_deliveries
         (id, endpoint_id, formation_id, event_type, event_id,
          attempt_number, status, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 'sending', ?, ?)`,
      )
      .bind(
        deliveryId,
        endpoint.id,
        formationId,
        eventType,
        eventId,
        payload.id,
        new Date().toISOString(),
      )
      .run()
      .catch((err: unknown) =>
        console.error("[webhooks] delivery_insert_failed", { err }),
      );

    // Attempt delivery (fire-and-forget per endpoint)
    await attemptDelivery(
      db,
      deliveryId,
      endpoint.url,
      payloadStr,
      signature,
      1,
    ).catch((err: unknown) =>
      console.error("[webhooks] delivery_attempt_failed", {
        delivery_id: deliveryId,
        err,
      }),
    );
  }
}

// ─── Delivery attempt ─────────────────────────────────────────────────────────

async function attemptDelivery(
  db: D1Database,
  deliveryId: string,
  url: string,
  payload: string,
  signature: string,
  attempt: number,
): Promise<void> {
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let succeeded = false;

  try {
    const res = await Promise.race<Response>([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OffshoreProz-Signature": signature,
          "X-OffshoreProz-Delivery": deliveryId,
          "User-Agent": "OffshoreProz-Webhooks/1.0",
        },
        body: payload,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error("delivery_timeout")),
          DELIVERY_TIMEOUT_MS,
        ),
      ),
    ]);

    responseStatus = res.status;
    responseBody = (await res.text().catch(() => "")).slice(0, 500);
    succeeded = responseStatus >= 200 && responseStatus < 300;
  } catch (err) {
    responseBody = (err instanceof Error ? err.message : String(err)).slice(
      0,
      500,
    );
  }

  const now = new Date().toISOString();
  const nextAttempt = attempt + 1;
  const canRetry = !succeeded && nextAttempt <= MAX_ATTEMPTS;
  const nextRetryAt = canRetry
    ? new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]!).toISOString()
    : null;
  const finalStatus = succeeded
    ? "succeeded"
    : canRetry
      ? "queued"
      : "dead_lettered";

  await db
    .prepare(
      `UPDATE agent_webhook_deliveries
       SET status = ?, response_status = ?, response_body_truncated = ?,
           delivered_at = ?, next_retry_at = ?, attempt_number = ?
       WHERE id = ?`,
    )
    .bind(
      finalStatus,
      responseStatus,
      responseBody,
      succeeded ? now : null,
      nextRetryAt,
      attempt,
      deliveryId,
    )
    .run()
    .catch((err: unknown) =>
      console.error("[webhooks] delivery_update_failed", { err }),
    );
}
