#!/usr/bin/env bash
# set-secrets.sh — lê .env.local da raiz do repo e seta secrets no Worker via wrangler.
#
# Usage (do diretório workers/agent-api):
#   ./scripts/set-secrets.sh              # produção
#   ./scripts/set-secrets.sh --staging    # staging
#   ./scripts/set-secrets.sh --both       # produção + staging

set -eo pipefail   # sem -u para tolerar vars ausentes no .env.local

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
WRANGLER="npx wrangler@4.95.0"
WORKER_PROD="offshoreproz-agent-api"
WORKER_STAGING="offshoreproz-agent-api-staging"

# Args
TARGETS=("prod")
for arg in "$@"; do
  case "$arg" in
    --staging) TARGETS=("staging") ;;
    --both)    TARGETS=("prod" "staging") ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Não encontrei $ENV_FILE" >&2; exit 1
fi

# Carrega variáveis do .env.local (sem executar código arbitrário)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Função que seta um secret: worker_name secret_name valor
set_secret() {
  local worker="$1"
  local secret_name="$2"
  local value="$3"

  if [[ -z "$value" ]]; then
    echo "  ⚠️  $secret_name — variável não encontrada no .env.local, pulando"
    return
  fi

  printf '%s' "$value" | $WRANGLER secret put "$secret_name" --name "$worker" 2>&1 \
    | grep -v "^$" | sed 's/^/  /'
  echo "  ✅ $secret_name setado"
}

for target in "${TARGETS[@]}"; do
  if [[ "$target" == "prod" ]]; then
    WORKER="$WORKER_PROD"; LABEL="PRODUÇÃO"
  else
    WORKER="$WORKER_STAGING"; LABEL="STAGING"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $WORKER ($LABEL)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Mapeamento explícito: NOME_NO_WORKER ← NOME_NO_ENV_LOCAL
  # (tipos.ts:61-68 documenta este mapeamento)
  set_secret "$WORKER" "STRIPE_SECRET_KEY"      "${STRIPE_SECRET_KEY_LIVE:-}"
  set_secret "$WORKER" "STRIPE_WEBHOOK_SECRET"  "${STRIPE_WEBHOOK_SECRET_AGENT_API:-}"
  set_secret "$WORKER" "KYC_PROVIDER_KEY"       "${STRIPE_IDENTIFYING_KEY_AGENT_API:-}"
  set_secret "$WORKER" "SIGNING_PROVIDER_KEY"   "${DOCUSEAL_API_KEY:-}"
  set_secret "$WORKER" "API_KEY_ENCRYPTION_SECRET" "${API_KEY_ENCRYPTION_SECRET:-}"
  set_secret "$WORKER" "RESEND_API_KEY"           "${RESEND_API_KEY:-}"
  set_secret "$WORKER" "ADMIN_API_TOKEN"          "${ADMIN_API_TOKEN:-}"
  set_secret "$WORKER" "DOCUSEAL_TEMPLATE_ID_WY" "${DOCUSEAL_TEMPLATE_ID_WY:-}"
  set_secret "$WORKER" "DOCUSEAL_TEMPLATE_ID_MI" "${DOCUSEAL_TEMPLATE_ID_MI:-}"
  set_secret "$WORKER" "DOCUSEAL_WEBHOOK_SECRET"  "${DOCUSEAL_WEBHOOK_SECRET:-}"
done

echo ""
echo "🏁 Concluído. Verificar:"
echo "   $WRANGLER secret list --name $WORKER_PROD"
