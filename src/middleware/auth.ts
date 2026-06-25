/**
 * API Key Authentication Middleware — Sprint 2
 *
 * Validates API keys from Authorization header: `Bearer op_test_...` or `Bearer op_live_...`
 *
 * Rules:
 *  - Prefix `op_test_` → sandbox mode. Formations never trigger real filing or charges.
 *  - Prefix `op_live_`  → live mode. BLOCKED until the live gate checklist is complete.
 *  - Key hash is looked up in AGENT_DB.agent_api_keys — raw key never stored.
 *  - Revoked keys (revoked_at != NULL) return 401 with code `api_key_revoked`.
 *  - Missing/malformed header returns 401 with code `invalid_api_key`.
 *  - Updates `last_used_at` async via ctx.waitUntil (non-blocking).
 *
 * Rate limiting is handled by the separate rateLimiter middleware.
 *
 * Usage in routes:
 *   import { requireApiKey } from '../middleware/auth.ts';
 *   app.post('/v1/formations', requireApiKey, handler);
 *
 * After auth, handlers can read:
 *   c.get('api_key_id')   → string
 *   c.get('api_key_mode') → 'test' | 'live'
 *   c.get('api_key_tier') → 'free' | 'pro' | 'enterprise'
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { errors } from "../lib/response.ts";
import { hashApiKey } from "../lib/crypto.ts";
import { createLogger } from "../lib/logger.ts";
import { isLiveModeEnabled } from "../config/live-mode.ts";
import { resolveAccessToken, ACCESS_TOKEN_PREFIX } from "../lib/oauth.ts";

interface ApiKeyRow {
  id: string;
  mode: string;
  tier: string;
  revoked_at: string | null;
  name: string;
}

/** Apply a resolved key row to the request context (shared by both auth paths). */
function applyKeyContext(c: Context, row: ApiKeyRow): void {
  c.set("api_key_id", row.id);
  c.set("api_key_mode", row.mode as "test" | "live");
  c.set("api_key_tier", row.tier as "free" | "pro" | "enterprise");
  c.executionCtx.waitUntil(
    c.env.AGENT_DB.prepare(
      `UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), row.id)
      .run()
      .catch(() => {}),
  );
}

export const requireApiKey: MiddlewareHandler = async (
  c: Context,
  next: Next,
): Promise<Response | void> => {
  const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
  const logger = createLogger(traceId);

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    logger.warn("Auth: missing or malformed Authorization header");
    return errors.unauthorized(traceId);
  }

  const rawKey = authHeader.slice(7).trim();

  // ── OAuth access token (MCP remote connector) ───────────────────────────────
  // Resolves to the api_key_id the user bound at consent. Same downstream
  // context as a raw op_ key, so every REST route + MCP-proxied call works.
  if (rawKey.startsWith(ACCESS_TOKEN_PREFIX)) {
    const apiKeyId = await resolveAccessToken(c.env.KV, rawKey);
    if (!apiKeyId) {
      logger.warn("Auth: OAuth access token invalid or expired");
      return errors.unauthorized(traceId);
    }
    const row = await (c.env.AGENT_DB.prepare(
      `SELECT id, mode, tier, revoked_at, name
       FROM agent_api_keys WHERE id = ? LIMIT 1`,
    )
      .bind(apiKeyId)
      .first() as Promise<ApiKeyRow | null>);
    if (!row) {
      logger.warn("Auth: OAuth token maps to missing key", { api_key_id: apiKeyId });
      return errors.unauthorized(traceId);
    }
    if (row.revoked_at) {
      return c.json(
        {
          error: "The underlying API key has been revoked.",
          code: "api_key_revoked",
          request_id: traceId,
        },
        401,
      );
    }
    if (row.mode === "live" && !isLiveModeEnabled(c.env)) {
      return c.json(
        {
          error: "Live mode is not yet available.",
          code: "live_mode_not_available",
          request_id: traceId,
        },
        403,
      );
    }
    applyKeyContext(c, row);
    await next();
    return;
  }

  // Validate prefix format
  const mode = rawKey.startsWith("op_test_")
    ? "test"
    : rawKey.startsWith("op_live_")
      ? "live"
      : null;

  if (!mode) {
    logger.warn("Auth: invalid key prefix (expected op_test_ or op_live_)");
    return errors.unauthorized(traceId);
  }

  // Live mode gated by the per-environment LIVE_MODE_ENABLED var (shared gate).
  if (mode === "live" && !isLiveModeEnabled(c.env)) {
    return c.json(
      {
        error:
          "Live mode is not yet available. Use op_test_ keys for sandbox testing. Production launch coming soon.",
        code: "live_mode_not_available",
        request_id: traceId,
        docs: "https://docs.offshoreproz.com/api/beta",
      },
      403,
    );
  }

  // Hash the raw key for lookup
  const keyHash = await hashApiKey(rawKey);

  // Look up in AGENT_DB
  const row = await (c.env.AGENT_DB.prepare(
    `SELECT id, mode, tier, revoked_at, name
     FROM agent_api_keys
     WHERE key_hash = ?
     LIMIT 1`,
  )
    .bind(keyHash)
    .first() as Promise<ApiKeyRow | null>);
  if (!row) {
    logger.warn("Auth: key hash not found");
    return errors.unauthorized(traceId);
  }

  if (row.revoked_at) {
    logger.warn("Auth: key revoked", { api_key_id: row.id });
    return c.json(
      {
        error:
          "This API key has been revoked. Generate a new key from your developer console.",
        code: "api_key_revoked",
        request_id: traceId,
      },
      401,
    );
  }

  // Verify mode matches the key's stored mode
  if (row.mode !== mode) {
    logger.warn("Auth: key mode mismatch", {
      api_key_id: row.id,
      claimed: mode,
      stored: row.mode,
    });
    return errors.unauthorized(traceId);
  }

  // Store in context for downstream handlers (+ async last_used_at bump).
  applyKeyContext(c, row);

  await next();
};
