#!/usr/bin/env bash
# apply-0007-manual.sh — aplica a migration 0007 passo a passo via --command
# para contornar o fato de D1 não propagar PRAGMA entre statements de --file.
#
# Cada batch aqui é UMA chamada à API D1, então PRAGMA no mesmo batch é honrado.
#
# Usage (do diretório workers/agent-api):
#   ./scripts/apply-0007-manual.sh

set -euo pipefail
WRANGLER="npx wrangler@4.95.0"
DB="offshoreproz-agent-api"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Migration 0007 — Execução manual passo a passo"
echo "DB: $DB"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Passo 1: Criar a nova tabela ──────────────────────────────────────────────
echo "PASSO 1 — CREATE TABLE agent_formations_new..."
$WRANGLER d1 execute "$DB" --remote --command "
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
)
"
echo "  ✅ Tabela criada"

# ── Passo 2: Copiar dados ─────────────────────────────────────────────────────
echo "PASSO 2 — INSERT INTO agent_formations_new SELECT * FROM agent_formations..."
$WRANGLER d1 execute "$DB" --remote --command "
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
FROM agent_formations
"
echo "  ✅ Dados copiados"

# ── Passo 3: Verificar contagem antes de dropar ────────────────────────────────
echo "PASSO 3 — Verificando contagem (nova tabela deve bater com antiga)..."
$WRANGLER d1 execute "$DB" --remote --command "
SELECT
  (SELECT COUNT(*) FROM agent_formations) AS old_count,
  (SELECT COUNT(*) FROM agent_formations_new) AS new_count
"

# ── Passo 4: DROP + RENAME em um único --command (PRAGMA fica no mesmo batch) ─
echo "PASSO 4 — PRAGMA foreign_keys=OFF + DROP + RENAME (um único batch)..."
$WRANGLER d1 execute "$DB" --remote --command "PRAGMA foreign_keys = OFF; DROP TABLE agent_formations; ALTER TABLE agent_formations_new RENAME TO agent_formations; PRAGMA foreign_keys = ON"
echo "  ✅ Drop + rename concluído"

# ── Passo 5: Recriar índices ──────────────────────────────────────────────────
echo "PASSO 5 — Recriando 9 índices..."
$WRANGLER d1 execute "$DB" --remote --command "
CREATE INDEX IF NOT EXISTS idx_formations_api_key      ON agent_formations(api_key_id);
CREATE INDEX IF NOT EXISTS idx_formations_status       ON agent_formations(status);
CREATE INDEX IF NOT EXISTS idx_formations_mode         ON agent_formations(mode);
CREATE INDEX IF NOT EXISTS idx_formations_jurisdiction ON agent_formations(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_formations_portal_proj  ON agent_formations(portal_project_id);
CREATE INDEX IF NOT EXISTS idx_formations_created      ON agent_formations(created_at);
CREATE INDEX IF NOT EXISTS idx_formations_stripe       ON agent_formations(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_formations_portal_sync_status ON agent_formations(portal_sync_status);
CREATE INDEX IF NOT EXISTS idx_formations_portal_project ON agent_formations(portal_project_id) WHERE portal_project_id IS NOT NULL
"
echo "  ✅ Índices criados"

# ── Passo 6: Registrar 0007 em d1_migrations ──────────────────────────────────
echo "PASSO 6 — Registrando 0007 em d1_migrations..."
$WRANGLER d1 execute "$DB" --remote --command "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_add_kyc_approved_status.sql')"
echo "  ✅ Migration registrada"

# ── Verificação final ─────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "VERIFICAÇÃO FINAL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "→ CHECK constraint contém kyc_approved?"
$WRANGLER d1 execute "$DB" --remote \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_formations'" \
  | grep -o "kyc_approved" && echo "  ✅ kyc_approved presente no CHECK" || echo "  ❌ kyc_approved AUSENTE — verificar"

echo "→ Contagem de formations:"
$WRANGLER d1 execute "$DB" --remote --command "SELECT COUNT(*) AS total FROM agent_formations"

echo "→ d1_migrations:"
$WRANGLER d1 execute "$DB" --remote --command "SELECT id, name FROM d1_migrations ORDER BY id"

echo ""
echo "🏁 Migration 0007 concluída!"
