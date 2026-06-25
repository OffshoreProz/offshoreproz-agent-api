/**
 * Action Tokens — Sprint 5 (Owner Actions)
 *
 * Secure, single-use, expiring bearer tokens that let a beneficial owner (human)
 * confirm or advance a formation WITHOUT an API key. The raw token is delivered
 * to the owner inside a portal URL:
 *
 *   https://docs.offshoreproz.com/portal/actions/{raw_token}
 *
 * Security rules:
 *  - Only the SHA-256 hash is stored (never the raw token).
 *  - Single-use: consumed_at is set the moment it advances a formation.
 *  - Time-boxed: expires_at enforced on every validation.
 *  - Reissue: an expired/lost token can be reissued; the chain is audited.
 *
 * Table: agent_action_tokens (migrations/agent-db/0004_action_tokens.sql)
 */

export type ActionPurpose =
  | "owner_confirmation"
  | "kyc"
  | "payment"
  | "signature";

export interface ActionTokenRow {
  id: string;
  formation_id: string;
  token_hash: string;
  purpose: ActionPurpose;
  expires_at: string;
  consumed_at: string | null;
  reissued_from: string | null;
  created_at: string;
}

/** Default time-to-live for an owner action link. */
export const ACTION_TOKEN_TTL_HOURS = 14 * 24; // 14 days

/** Generate a raw action token: act_<64 hex chars>. Show to owner ONCE. */
export function generateActionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `act_${hex}`;
}

/** SHA-256 hex of the raw token — what we store and look up by. */
export async function hashActionToken(rawToken: string): Promise<string> {
  const data = new TextEncoder().encode(rawToken);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function genId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `act_${hex}`;
}

export interface CreatedActionToken {
  id: string;
  raw_token: string;
  expires_at: string;
}

/**
 * Create a fresh action token for a formation + purpose.
 * Returns the raw token (only chance to read it) and metadata.
 */
export async function createActionToken(
  db: D1Database,
  formationId: string,
  purpose: ActionPurpose,
  ttlHours: number = ACTION_TOKEN_TTL_HOURS,
  reissuedFrom: string | null = null,
): Promise<CreatedActionToken> {
  const id = genId();
  const rawToken = generateActionToken();
  const tokenHash = await hashActionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + ttlHours * 60 * 60 * 1000,
  ).toISOString();

  await db
    .prepare(
      `INSERT INTO agent_action_tokens
       (id, formation_id, token_hash, purpose, expires_at, consumed_at, reissued_from, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      formationId,
      tokenHash,
      purpose,
      expiresAt,
      reissuedFrom,
      now.toISOString(),
    )
    .run();

  return { id, raw_token: rawToken, expires_at: expiresAt };
}

/**
 * Validate a raw action token. Returns the row only if it exists, is not
 * consumed, and has not expired. Returns a typed reason otherwise.
 */
export async function validateActionToken(
  db: D1Database,
  rawToken: string,
): Promise<
  | { ok: true; token: ActionTokenRow }
  | { ok: false; reason: "not_found" | "consumed" | "expired" }
> {
  const tokenHash = await hashActionToken(rawToken);
  const row = await db
    .prepare(
      `SELECT id, formation_id, token_hash, purpose, expires_at, consumed_at, reissued_from, created_at
       FROM agent_action_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<ActionTokenRow>();

  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, token: row };
}

/**
 * Mark a token consumed (single-use). Uses a conditional UPDATE so two
 * concurrent confirmations cannot both succeed.
 * Returns true if THIS call consumed it, false if it was already consumed.
 */
export async function consumeActionToken(
  db: D1Database,
  tokenId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE agent_action_tokens
       SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL`,
    )
    .bind(now, tokenId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Reissue a token for a formation + purpose. Invalidates any outstanding
 * unconsumed tokens for the same purpose (marks them consumed) so only the
 * newest link works, then creates a fresh one linked via reissued_from.
 */
export async function reissueActionToken(
  db: D1Database,
  formationId: string,
  purpose: ActionPurpose,
  ttlHours: number = ACTION_TOKEN_TTL_HOURS,
): Promise<CreatedActionToken> {
  // Find the most recent token (for the audit chain) and invalidate outstanding ones.
  const prior = await db
    .prepare(
      `SELECT id FROM agent_action_tokens
       WHERE formation_id = ? AND purpose = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(formationId, purpose)
    .first<{ id: string }>();

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE agent_action_tokens
       SET consumed_at = ?
       WHERE formation_id = ? AND purpose = ? AND consumed_at IS NULL`,
    )
    .bind(now, formationId, purpose)
    .run();

  return createActionToken(
    db,
    formationId,
    purpose,
    ttlHours,
    prior?.id ?? null,
  );
}

/**
 * Get the most recent unconsumed, unexpired token for a formation + purpose,
 * if any. Used to rebuild a live action URL on GET without minting a new token.
 */
export async function getActiveActionToken(
  db: D1Database,
  formationId: string,
  purpose: ActionPurpose,
): Promise<ActionTokenRow | null> {
  const row = await db
    .prepare(
      `SELECT id, formation_id, token_hash, purpose, expires_at, consumed_at, reissued_from, created_at
       FROM agent_action_tokens
       WHERE formation_id = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(formationId, purpose)
    .first<ActionTokenRow>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Map a formation status to the action purpose the owner must complete. */
export function purposeForStatus(status: string): ActionPurpose | null {
  switch (status) {
    case "pending_owner_confirmation":
    case "draft":
      return "owner_confirmation";
    case "kyc_pending":
      return "kyc";
    case "payment_pending":
      return "payment";
    case "signature_pending":
      return "signature";
    default:
      return null;
  }
}
