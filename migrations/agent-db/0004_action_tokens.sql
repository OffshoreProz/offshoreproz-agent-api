-- ─── Action Tokens (Sprint 5 — Owner Actions) ───────────────────────────────
-- Secure, single-use, expiring tokens that let a beneficial owner (a human)
-- confirm/advance a formation WITHOUT an API key. The raw token is the bearer
-- credential — only its SHA-256 hash is stored here (never the raw value).
--
-- The owner receives a URL: docs.offshoreproz.com/portal/actions/{raw_token}
-- Replaces the previous insecure pattern of putting formation_id directly in
-- the action URL.
--
-- Lifecycle:
--   created → (owner opens link) → validated → consumed (single use)
--   expired tokens can be reissued (reissued_from links the audit chain)

CREATE TABLE IF NOT EXISTS agent_action_tokens (
  id            TEXT PRIMARY KEY,                          -- act_<hex>
  formation_id  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,                      -- SHA-256 of raw token
  purpose       TEXT NOT NULL                              -- which step this token unlocks
                  CHECK (purpose IN (
                    'owner_confirmation',
                    'kyc',
                    'payment',
                    'signature'
                  )),
  expires_at    TEXT NOT NULL,                             -- ISO 8601
  consumed_at   TEXT,                                      -- NULL = unused (single-use)
  reissued_from TEXT,                                      -- previous token id (audit chain)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (formation_id) REFERENCES agent_formations(id)
);

CREATE INDEX IF NOT EXISTS idx_action_tokens_hash
  ON agent_action_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_action_tokens_formation
  ON agent_action_tokens(formation_id);
CREATE INDEX IF NOT EXISTS idx_action_tokens_active
  ON agent_action_tokens(formation_id, purpose, consumed_at);
