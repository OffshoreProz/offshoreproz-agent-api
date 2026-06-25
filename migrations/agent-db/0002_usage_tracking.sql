-- AGENT_DB: Usage and daily stats tracking
-- Migration: 0002_usage_tracking
-- Created: 2026-06-07
--
-- Tracks API usage per key per day for rate limits, billing, and analytics.
-- This table is updated by background cron, not on every request.

-- ─── Daily Usage ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_usage_daily (
  id                  TEXT PRIMARY KEY,
  api_key_id          TEXT NOT NULL,
  date                TEXT NOT NULL,                       -- YYYY-MM-DD
  total_requests      INTEGER NOT NULL DEFAULT 0,
  formations_test     INTEGER NOT NULL DEFAULT 0,
  formations_live     INTEGER NOT NULL DEFAULT 0,
  formations_complete INTEGER NOT NULL DEFAULT 0,
  formations_failed   INTEGER NOT NULL DEFAULT 0,
  webhook_deliveries  INTEGER NOT NULL DEFAULT 0,
  portal_syncs        INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(api_key_id, date),
  FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_key  ON agent_usage_daily(api_key_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON agent_usage_daily(date);

-- ─── Admin Audit Log ──────────────────────────────────────────────────────────
-- Manual actions by OffshoreProz ops team (key revocation, formation override, etc.)
CREATE TABLE IF NOT EXISTS agent_admin_actions (
  id            TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,                             -- user.id from PORTAL_DB
  action        TEXT NOT NULL,                             -- revoke_key | override_status | retry_formation | add_document
  target_type   TEXT NOT NULL,                             -- api_key | formation | webhook_endpoint
  target_id     TEXT NOT NULL,
  reason        TEXT,
  previous_state_json TEXT,                                -- snapshot before change
  trace_id      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_type      ON agent_admin_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_user      ON agent_admin_actions(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created   ON agent_admin_actions(created_at);
