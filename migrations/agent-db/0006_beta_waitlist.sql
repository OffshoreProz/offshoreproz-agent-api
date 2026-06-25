-- ─── Beta Waitlist (Sprint 8 — MCP Sandbox + Beta) ──────────────────────────
-- Developers requesting access to the Agent API beta (op_live_ keys).
-- Public POST /v1/beta/waitlist writes here; the team reviews and approves.

CREATE TABLE IF NOT EXISTS agent_beta_waitlist (
  id           TEXT PRIMARY KEY,                          -- wl_<hex>
  email        TEXT NOT NULL,
  name         TEXT,
  company      TEXT,
  use_case     TEXT,                                      -- what they want to build
  platform     TEXT,                                      -- claude_mcp, cursor, n8n, custom...
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email
  ON agent_beta_waitlist(email);
CREATE INDEX IF NOT EXISTS idx_waitlist_status
  ON agent_beta_waitlist(status);
