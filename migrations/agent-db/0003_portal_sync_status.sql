-- AGENT_DB Migration: Portal sync tracking fields
-- Migration: 0003_portal_sync_status
-- Date: 2026-06-08
--
-- Purpose: Track the portal sync lifecycle for each formation.
--   - portal_sync_status tells the API consumer whether their formation
--     has been linked to a portal project (or why it hasn't been yet).
--   - portal_sync_attempted_at records the last sync attempt timestamp.
--   - portal_sync_error stores the last failure reason for debugging.
--
-- All new columns use safe defaults — existing rows get 'not_attempted'.
--
-- Apply:
--   staging:    npm run migrate:staging
--   production: npm run migrate:production   (requires approval)

ALTER TABLE agent_formations
  ADD COLUMN portal_sync_status TEXT DEFAULT 'not_attempted'
    CHECK (portal_sync_status IN (
      'not_attempted',   -- formation created, no sync tried yet
      'dry_run',         -- sync ran in staging (PORTAL_SYNC_ENABLED=false)
      'synced',          -- project created in PORTAL_DB, portal_project_id set
      'no_portal_user',  -- beneficial owner email not found in portal — sync skipped
      'failed',          -- sync attempted but failed (DB error, etc.)
      'skipped_sandbox'  -- test mode formation — no portal sync attempted
    ));

ALTER TABLE agent_formations
  ADD COLUMN portal_sync_attempted_at TEXT;

ALTER TABLE agent_formations
  ADD COLUMN portal_sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_formations_portal_sync_status
  ON agent_formations(portal_sync_status);

CREATE INDEX IF NOT EXISTS idx_formations_portal_project
  ON agent_formations(portal_project_id)
  WHERE portal_project_id IS NOT NULL;
