#!/usr/bin/env bash
# restore-with-0007.sh — Recria AGENT_DB do backup com kyc_approved no CHECK.
#
# Estratégia: dropar todas as tabelas em ordem filho→pai (sem PRAGMA),
# depois importar o backup modificado que tem kyc_approved no CHECK.
#
# Usage (do diretório workers/agent-api):
#   ./scripts/restore-with-0007.sh

set -euo pipefail
WRANGLER="npx wrangler@4.95.0"
DB="offshoreproz-agent-api"
BACKUP="backups/agent-db_20260618_152208.sql"
MODIFIED="backups/agent-db_modified_0007.sql"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Restore AGENT_DB com migration 0007"
echo "DB: $DB"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Modificar o backup: adicionar kyc_approved ao CHECK ───────────────────────
echo ""
echo "PASSO 0 — Gerando backup modificado com kyc_approved..."
cp "$BACKUP" "$MODIFIED"

# Substituir: 'kyc_review', 'kyc_failed'  →  'kyc_review', 'kyc_approved', 'kyc_failed'
# (aplica só em agent_formations, a única tabela com esse CHECK)
sed -i '' "s/'kyc_review', 'kyc_failed'/'kyc_review', 'kyc_approved', 'kyc_failed'/g" "$MODIFIED"

# Verificar que a substituição foi feita
if grep -q "kyc_approved" "$MODIFIED"; then
  echo "  ✅ kyc_approved presente no backup modificado"
else
  echo "  ❌ Substituição falhou — abortar"
  exit 1
fi

# Verificar contagem atual antes de dropar
echo ""
echo "PASSO 1 — Verificando contagem atual..."
$WRANGLER d1 execute "$DB" --remote --command "
SELECT 'formations' AS tbl, COUNT(*) AS n FROM agent_formations
UNION ALL SELECT 'events', COUNT(*) FROM agent_formation_events
UNION ALL SELECT 'action_tokens', COUNT(*) FROM agent_action_tokens
UNION ALL SELECT 'api_keys', COUNT(*) FROM agent_api_keys
"

# ── Dropar tudo em ordem filho→pai ───────────────────────────────────────────
echo ""
echo "PASSO 2 — Dropando tabelas em ordem filho→pai..."

# Nível 1: folhas que referenciam agent_formations
echo "  Dropando filhos de agent_formations..."
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_formation_events" && echo "    ✅ agent_formation_events"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_action_tokens"    && echo "    ✅ agent_action_tokens"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_documents"        && echo "    ✅ agent_documents"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_formations_new"   && echo "    ✅ agent_formations_new (temp)"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_formations"       && echo "    ✅ agent_formations"

# Nível 2: filhos de agent_api_keys
echo "  Dropando filhos de agent_api_keys..."
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_webhook_deliveries"  && echo "    ✅ agent_webhook_deliveries"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_webhook_endpoints"   && echo "    ✅ agent_webhook_endpoints"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_idempotency_keys"    && echo "    ✅ agent_idempotency_keys"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_usage_daily"         && echo "    ✅ agent_usage_daily"

# Nível 3: pai
echo "  Dropando tabelas raiz..."
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_api_keys"       && echo "    ✅ agent_api_keys"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_admin_actions"  && echo "    ✅ agent_admin_actions"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS agent_beta_waitlist"  && echo "    ✅ agent_beta_waitlist"
$WRANGLER d1 execute "$DB" --remote --command "DROP TABLE IF EXISTS d1_migrations"        && echo "    ✅ d1_migrations"

# Confirmar DB está vazio (só _cf_KV e sqlite_sequence esperados)
echo ""
echo "  Tabelas restantes após DROP:"
$WRANGLER d1 execute "$DB" --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# ── Importar o backup modificado ──────────────────────────────────────────────
echo ""
echo "PASSO 3 — Importando backup com kyc_approved..."
$WRANGLER d1 execute "$DB" --remote --file "$MODIFIED"
echo "  ✅ Backup importado"

# ── Reconciliar d1_migrations (0003-0007 ausentes do backup original) ─────────
echo ""
echo "PASSO 4 — Reconciliando d1_migrations (0003-0007)..."
$WRANGLER d1 execute "$DB" --remote --command "
INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0003_portal_sync_status.sql'),
  ('0004_action_tokens.sql'),
  ('0005_documents.sql'),
  ('0006_beta_waitlist.sql'),
  ('0007_add_kyc_approved_status.sql');
"
echo "  ✅ d1_migrations reconciliado"

# ── Recriar os índices da 0007 (backup tem os índices da 0001-0006 apenas) ────
echo ""
echo "PASSO 5 — Recriando índices completos da 0007..."
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

# ── Verificação final ──────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "VERIFICAÇÃO FINAL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "→ CHECK contém kyc_approved?"
$WRANGLER d1 execute "$DB" --remote \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_formations'" \
  | grep -o "kyc_approved" && echo "  ✅ kyc_approved no CHECK" || echo "  ❌ AUSENTE"

echo "→ Contagens:"
$WRANGLER d1 execute "$DB" --remote --command "
SELECT 'formations' AS tbl, COUNT(*) AS n FROM agent_formations
UNION ALL SELECT 'events', COUNT(*) FROM agent_formation_events
UNION ALL SELECT 'action_tokens', COUNT(*) FROM agent_action_tokens
UNION ALL SELECT 'api_keys', COUNT(*) FROM agent_api_keys
"

echo "→ d1_migrations:"
$WRANGLER d1 execute "$DB" --remote \
  --command "SELECT id, name FROM d1_migrations ORDER BY id"

echo ""
echo "🏁 Migration 0007 concluída via restore!"
echo ""
echo "Próximo passo: remover o endpoint temporário e deployar"
