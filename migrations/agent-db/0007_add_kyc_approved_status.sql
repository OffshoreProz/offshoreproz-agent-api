-- AGENT_DB migration: add 'kyc_approved' to the agent_formations status CHECK
-- Migration: 0007_add_kyc_approved_status
-- DB: offshoreproz-agent-api (AGENT_DB) — id <AGENT_DB_ID>
-- Created: 2026-06-18
--
-- WHY (verified bug, 2026-06-18):
--   src/types.ts and src/core/formation-state.ts use the status 'kyc_approved'
--   for the KYC-success → payment transition, but the production CHECK constraint
--   on agent_formations.status allows only: kyc_pending, kyc_review, kyc_failed
--   (NOT kyc_approved). Verified against prod:
--     SELECT sql FROM sqlite_master WHERE name='agent_formations'  → no 'kyc_approved'
--   Result: any UPDATE ... SET status='kyc_approved' is REJECTED by D1, breaking
--   the entire KYC-approve path. This migration widens the CHECK to include it.
--
-- SQLite/D1 cannot ALTER an existing CHECK constraint, so this is a table-rebuild
-- (create new → copy → drop → rename → recreate indexes). The new table is the
-- EXACT current production schema (28 columns, incl. the 0003 portal_sync_*
-- columns) with 'kyc_approved' added to the status CHECK — nothing else changes.
--
-- ⚠️ PREREQUISITES (do NOT apply blind):
--   1. The d1_migrations tracking table on prod only records 0001 + 0002, even
--      though 0003-0006 ARE applied. Running `wrangler d1 migrations apply` will
--      try to re-apply 0003-0006 and FAIL. You MUST reconcile tracking first.
--      See: RECONCILE-AND-APPLY-0007.md (same folder) for the exact steps.
--   2. Take a fresh AGENT_DB backup before applying.
--   3. D1 runs with foreign-key enforcement OFF by default, so dropping
--      agent_formations (referenced by agent_formation_events.formation_id) is
--      safe; row ids are preserved by the copy below.
--
-- Verify after apply:
--   SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_formations';
--   -- the status CHECK list must now contain 'kyc_approved'

-- 1) New table — identical to current prod schema + 'kyc_approved' in status CHECK.
CREATE TABLE agent_formations_new (
  id                        TEXT PRIMARY KEY,
  mode                      TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  api_key_id                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                'draft', 'pending_owner_confirmation', 'portal_synced',
                                'kyc_pending', 'kyc_review', 'kyc_approved', 'kyc_failed',
                                'payment_pending', 'payment_authorized',
                                'signature_pending', 'filing_ready', 'filing_in_progress',
                                'registration_complete', 'documents_ready', 'ein_pending',
                                'complete', 'action_required', 'failed', 'cancelled'
                              )),
  jurisdiction              TEXT NOT NULL
                              CHECK (jurisdiction IN ('WY', 'MI', 'NV', 'BVI', 'PA', 'UAE')),
  company_name              TEXT NOT NULL,
  portal_project_id         TEXT,
  portal_client_id          TEXT,
  estimate_id               TEXT,
  estimate_token            TEXT,
  amount_total_usd          INTEGER,
  payment_provider          TEXT CHECK (payment_provider IN ('stripe', 'crypto', NULL)),
  stripe_payment_intent_id  TEXT,
  stripe_payment_status     TEXT CHECK (stripe_payment_status IN ('pending', 'captured', 'refunded', NULL)),
  signing_provider          TEXT,
  signing_envelope_id       TEXT,
  sign_url                  TEXT,
  sign_expires_at           TEXT,
  request_json_encrypted    TEXT,
  agent_context_json        TEXT,
  error_code                TEXT,
  error_message             TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at              TEXT,
  portal_sync_status        TEXT DEFAULT 'not_attempted'
                              CHECK (portal_sync_status IN (
                                'not_attempted', 'dry_run', 'synced',
                                'no_portal_user', 'failed', 'skipped_sandbox'
                              )),
  portal_sync_attempted_at  TEXT,
  portal_sync_error         TEXT,
  FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id)
);

-- 2) Copy every row (all 28 columns, explicit order — existing statuses are a
--    subset of the widened CHECK, so no row can violate it).
INSERT INTO agent_formations_new (
  id, mode, api_key_id, status, jurisdiction, company_name,
  portal_project_id, portal_client_id, estimate_id, estimate_token, amount_total_usd,
  payment_provider, stripe_payment_intent_id, stripe_payment_status,
  signing_provider, signing_envelope_id, sign_url, sign_expires_at,
  request_json_encrypted, agent_context_json, error_code, error_message,
  created_at, updated_at, completed_at,
  portal_sync_status, portal_sync_attempted_at, portal_sync_error
)
SELECT
  id, mode, api_key_id, status, jurisdiction, company_name,
  portal_project_id, portal_client_id, estimate_id, estimate_token, amount_total_usd,
  payment_provider, stripe_payment_intent_id, stripe_payment_status,
  signing_provider, signing_envelope_id, sign_url, sign_expires_at,
  request_json_encrypted, agent_context_json, error_code, error_message,
  created_at, updated_at, completed_at,
  portal_sync_status, portal_sync_attempted_at, portal_sync_error
FROM agent_formations;

-- 3) Replace old with new.
-- PRAGMA foreign_keys = OFF is required because agent_formation_events has a
-- FK referencing agent_formations(id). D1 enforces FK constraints by default.
-- Disabling here is safe: all rows in agent_formation_events still have valid
-- formation_id values (the new table preserves all IDs). Re-enabled after rename.
PRAGMA foreign_keys = OFF;
DROP TABLE agent_formations;
ALTER TABLE agent_formations_new RENAME TO agent_formations;
PRAGMA foreign_keys = ON;

-- 4) Recreate all 9 indexes (exact match to prod).
CREATE INDEX IF NOT EXISTS idx_formations_api_key       ON agent_formations(api_key_id);
CREATE INDEX IF NOT EXISTS idx_formations_status        ON agent_formations(status);
CREATE INDEX IF NOT EXISTS idx_formations_mode          ON agent_formations(mode);
CREATE INDEX IF NOT EXISTS idx_formations_jurisdiction  ON agent_formations(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_formations_portal_proj   ON agent_formations(portal_project_id);
CREATE INDEX IF NOT EXISTS idx_formations_created       ON agent_formations(created_at);
CREATE INDEX IF NOT EXISTS idx_formations_stripe        ON agent_formations(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_formations_portal_sync_status
  ON agent_formations(portal_sync_status);
CREATE INDEX IF NOT EXISTS idx_formations_portal_project
  ON agent_formations(portal_project_id)
  WHERE portal_project_id IS NOT NULL;
