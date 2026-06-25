-- ─── Documents (Sprint 6 — R2 Documents + Portal Vault) ─────────────────────
-- Metadata for formation documents stored in R2. The bytes live in the shared
-- bucket offshoreproz-docs-storage under a namespaced prefix:
--   agent-api/formations/{formation_id}/{document_type}/{document_id}.{ext}
--
-- This table is the Agent API's source of truth for documents. On live, the
-- portal's incorporation_documents (PORTAL_DB) mirrors these via source_external_id.
--
-- Download is never public: a short-TTL download token (KV) gates streaming.

CREATE TABLE IF NOT EXISTS agent_documents (
  id             TEXT PRIMARY KEY,                         -- doc_<hex>
  formation_id   TEXT NOT NULL,
  document_type  TEXT NOT NULL                             -- canonical doc category
                   CHECK (document_type IN (
                     'articles_of_organization',
                     'operating_agreement',
                     'ein_confirmation',
                     'registered_agent_acceptance',
                     'certificate_of_formation',
                     'invoice',
                     'kyc_document',
                     'other'
                   )),
  filename       TEXT NOT NULL,                            -- display name
  r2_key         TEXT NOT NULL UNIQUE,                     -- object key in R2
  r2_bucket      TEXT NOT NULL DEFAULT 'offshoreproz-docs-storage',
  content_type   TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT,                                     -- integrity check
  source         TEXT NOT NULL DEFAULT 'agent_api'         -- who produced it
                   CHECK (source IN ('agent_api', 'filing_provider', 'admin', 'import')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT,                                     -- soft delete only (never hard-delete)
  FOREIGN KEY (formation_id) REFERENCES agent_formations(id)
);

CREATE INDEX IF NOT EXISTS idx_documents_formation
  ON agent_documents(formation_id);
CREATE INDEX IF NOT EXISTS idx_documents_type
  ON agent_documents(formation_id, document_type);
CREATE INDEX IF NOT EXISTS idx_documents_active
  ON agent_documents(formation_id, deleted_at);
