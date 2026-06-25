-- Migration 0008: AI owner type column
-- Adds owner_type to agent_formations for AI-agent-initiated formations.
-- beneficial_owner stays the human custodian (no change to OFAC/KYC routing).
-- owner_type is AGENT_DB-internal; legal docs name the human custodian only.

ALTER TABLE agent_formations
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'human'
    CHECK (owner_type IN ('human', 'ai_agent'));

CREATE INDEX IF NOT EXISTS idx_formations_owner_type
  ON agent_formations(owner_type);
