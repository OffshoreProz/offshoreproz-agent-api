/**
 * API key validation helper — shared between auth middleware and MCP server.
 *
 * The auth middleware (src/middleware/auth.ts) gates REST routes via Hono
 * context. The MCP server (src/routes/mcp.ts) authenticates inside tools/call,
 * so it needs the same validation as a plain function.
 */

import { hashApiKey } from "./crypto.ts";

export interface ValidApiKey {
  ok: true;
  id: string;
  mode: "test" | "live";
  tier: "free" | "pro" | "enterprise";
  name: string;
}

export interface InvalidApiKey {
  ok: false;
  reason:
    | "missing"
    | "bad_prefix"
    | "live_not_available"
    | "not_found"
    | "revoked"
    | "mode_mismatch";
}

/**
 * Validate a raw API key string against AGENT_DB.
 * `liveEnabled` mirrors the LIVE_MODE_ENABLED gate in the auth middleware.
 */
export async function validateApiKey(
  db: D1Database,
  rawKey: string | undefined,
  liveEnabled: boolean,
): Promise<ValidApiKey | InvalidApiKey> {
  if (!rawKey) return { ok: false, reason: "missing" };

  const mode = rawKey.startsWith("op_test_")
    ? "test"
    : rawKey.startsWith("op_live_")
      ? "live"
      : null;
  if (!mode) return { ok: false, reason: "bad_prefix" };

  if (mode === "live" && !liveEnabled) {
    return { ok: false, reason: "live_not_available" };
  }

  const keyHash = await hashApiKey(rawKey);
  const row = await db
    .prepare(
      `SELECT id, mode, tier, revoked_at, name
       FROM agent_api_keys WHERE key_hash = ? LIMIT 1`,
    )
    .bind(keyHash)
    .first<{
      id: string;
      mode: string;
      tier: string;
      revoked_at: string | null;
      name: string;
    }>();

  if (!row) return { ok: false, reason: "not_found" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.mode !== mode) return { ok: false, reason: "mode_mismatch" };

  return {
    ok: true,
    id: row.id,
    mode: row.mode as "test" | "live",
    tier: row.tier as "free" | "pro" | "enterprise",
    name: row.name,
  };
}
