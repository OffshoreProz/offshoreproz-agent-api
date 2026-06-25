-- AGENT_DB: Initial Schema for offshoreproz-agent-api
-- Migration: 0001_initial_schema
-- Created: 2026-06-07
-- Worker: offshoreproz-agent-api
-- DB ID: <AGENT_DB_ID>
--
-- Run locally:  npm run migrate:local
-- Run staging:  npm run migrate:staging
-- NEVER run production without approval: see 10-PLANO-DE-INICIO-ENG.md
--
-- ⚠️  IMPORTANT: This DB is ONLY for Agent API tracking state.
--               Operational entities (projects, clients, documents) live in the portal database (PORTAL_DB).
--               Never write portal objects to this DB and vice-versa.

-- ─── API Keys ─────────────────────────────────────────────────────────────────
-- Stores hashed API keys only. Raw key is shown once at creation and never stored.
CREATE TABLE IF NOT EXISTS agent_api_keys (
  id            TEXT PRIMARY KEY,                          -- key_abc123 (nanoid)
  key_hash      TEXT NOT NULL UNIQUE,                      -- SHA-256 of raw key
  mode          TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  name          TEXT NOT NULL,                             -- human label, e.g. "My Agent App"
  owner_email   TEXT NOT NULL,                             -- email for billing/notifications
  tier          TEXT NOT NULL DEFAULT 'free'
                  CHECK (tier IN ('free', 'pro', 'enterprise')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT,
  revoked_at    TEXT                                        -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash     ON agent_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_mode     ON agent_api_keys(mode);
CREATE INDEX IF NOT EXISTS idx_api_keys_email    ON agent_api_keys(owner_email);

-- ─── Formations ───────────────────────────────────────────────────────────────
-- One row per formation attempt.
-- portal_project_id is the FK into the portal database (PORTAL_DB).projects.id
-- For test formations, portal_project_id may be null (sandbox only).
CREATE TABLE IF NOT EXISTS agent_formations (
  id                        TEXT PRIMARY KEY,              -- frm_abc123 (nanoid)
  mode                      TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  api_key_id                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'draft'  -- see FormationStatus in types.ts
                              CHECK (status IN (
                                'draft', 'pending_owner_confirmation', 'portal_synced',
                                'kyc_pending', 'kyc_review', 'kyc_failed',
                                'payment_pending', 'payment_authorized',
                                'signature_pending', 'filing_ready', 'filing_in_progress',
                                'registration_complete', 'documents_ready', 'ein_pending',
                                'complete', 'action_required', 'failed', 'cancelled'
                              )),
  jurisdiction              TEXT NOT NULL
                              CHECK (jurisdiction IN ('WY', 'MI', 'NV', 'BVI', 'PA', 'UAE')),
  company_name              TEXT NOT NULL,
  -- Portal linkage (the portal database (PORTAL_DB))
  portal_project_id         TEXT,                          -- projects.id in PORTAL_DB
  portal_client_id          TEXT,                          -- clients.id in PORTAL_DB
  -- Estimate reference
  estimate_id               TEXT,                          -- KV key of cost estimate
  estimate_token            TEXT,                          -- token passed in create_formation
  amount_total_usd          INTEGER,                       -- cents, e.g. 49900 = $499.00
  -- Payment
  payment_provider          TEXT CHECK (payment_provider IN ('stripe', 'crypto', NULL)),
  stripe_payment_intent_id  TEXT,
  stripe_payment_status     TEXT CHECK (stripe_payment_status IN ('pending', 'captured', 'refunded', NULL)),
  -- Signing
  signing_provider          TEXT,                          -- dropbox_sign | docusign | internal
  signing_envelope_id       TEXT,
  sign_url                  TEXT,                          -- URL for owner to sign
  sign_expires_at           TEXT,
  -- Encrypted storage for PII (AES-256, key = API_KEY_ENCRYPTION_SECRET)
  request_json_encrypted    TEXT,                          -- encrypted JSON of full intake
  agent_context_json        TEXT,                          -- agent_id, agent_name, platform
  -- Error state
  error_code                TEXT,
  error_message             TEXT,
  -- Timestamps
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at              TEXT,
  FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_formations_api_key       ON agent_formations(api_key_id);
CREATE INDEX IF NOT EXISTS idx_formations_status        ON agent_formations(status);
CREATE INDEX IF NOT EXISTS idx_formations_mode          ON agent_formations(mode);
CREATE INDEX IF NOT EXISTS idx_formations_jurisdiction  ON agent_formations(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_formations_portal_proj   ON agent_formations(portal_project_id);
CREATE INDEX IF NOT EXISTS idx_formations_created       ON agent_formations(created_at);
CREATE INDEX IF NOT EXISTS idx_formations_stripe        ON agent_formations(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- ─── Formation Events (immutable audit trail) ─────────────────────────────────
-- Every status transition and significant action is recorded here.
-- This table is append-only — never UPDATE or DELETE rows.
CREATE TABLE IF NOT EXISTS agent_formation_events (
  id            TEXT PRIMARY KEY,                          -- evt_abc123 (nanoid)
  formation_id  TEXT NOT NULL,
  event_type    TEXT NOT NULL,                             -- status_change | payment | signed | filed | error | webhook_sent | portal_sync
  from_status   TEXT,
  to_status     TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'system'
                  CHECK (actor_type IN ('api_key', 'system', 'admin', 'owner', 'webhook')),
  actor_id      TEXT,                                      -- key ID, user ID, or hashed email
  trace_id      TEXT,                                      -- X-Request-Id correlation
  payload_json  TEXT NOT NULL DEFAULT '{}',               -- structured event data (no PII)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (formation_id) REFERENCES agent_formations(id)
);

CREATE INDEX IF NOT EXISTS idx_events_formation  ON agent_formation_events(formation_id);
CREATE INDEX IF NOT EXISTS idx_events_type       ON agent_formation_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created    ON agent_formation_events(created_at);

-- ─── Idempotency Keys ─────────────────────────────────────────────────────────
-- Prevent duplicate formations from retried requests.
-- Keyed by (api_key_id, idempotency_key) — must be unique per key.
CREATE TABLE IF NOT EXISTS agent_idempotency_keys (
  id                TEXT PRIMARY KEY,
  api_key_id        TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,                         -- from Idempotency-Key header
  request_hash      TEXT NOT NULL,                         -- SHA-256 of serialized request body
  response_json     TEXT,                                  -- cached response (for replay)
  status_code       INTEGER,
  formation_id      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL,                         -- typically created_at + 24h
  UNIQUE(api_key_id, idempotency_key),
  FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_key    ON agent_idempotency_keys(api_key_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON agent_idempotency_keys(expires_at);

-- ─── Webhook Endpoints (registered by API clients) ───────────────────────────
CREATE TABLE IF NOT EXISTS agent_webhook_endpoints (
  id          TEXT PRIMARY KEY,                            -- wh_abc123
  api_key_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["formation.*"]',     -- JSON array of event patterns
  secret_hash TEXT NOT NULL,                               -- SHA-256 of HMAC secret (never store raw)
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_webhooks_api_key ON agent_webhook_endpoints(api_key_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active  ON agent_webhook_endpoints(active);

-- ─── Webhook Deliveries (outgoing) ───────────────────────────────────────────
-- Tracks every delivery attempt for client webhooks.
-- Used for: observability, retry logic, dead-letter detection.
CREATE TABLE IF NOT EXISTS agent_webhook_deliveries (
  id                      TEXT PRIMARY KEY,               -- del_abc123
  endpoint_id             TEXT NOT NULL,
  formation_id            TEXT,
  event_type              TEXT NOT NULL,
  event_id                TEXT NOT NULL,                  -- globally unique event ID
  attempt_number          INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'sending', 'succeeded', 'failed', 'dead_lettered')),
  response_status         INTEGER,
  response_body_truncated TEXT,                           -- first 500 chars of response
  next_retry_at           TEXT,
  last_error_code         TEXT,
  trace_id                TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at            TEXT,
  FOREIGN KEY (endpoint_id) REFERENCES agent_webhook_endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_endpoint    ON agent_webhook_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status      ON agent_webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_retry       ON agent_webhook_deliveries(next_retry_at)
  WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_event_id    ON agent_webhook_deliveries(event_id);
