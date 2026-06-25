#!/usr/bin/env bash
#
# Wire Stripe TEST keys into the staging worker for the realistic test-mode demo.
#
# Safety: this script REFUSES any sk_live_ / rk_live_ key, so it is impossible to
# accidentally point the staging demo at live Stripe (which would charge real cards).
#
# Run from workers/agent-api:  bash scripts/setup-staging-testmode.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

ENV=staging

refuse_live() {
  case "$1" in
    sk_live_*|rk_live_*)
      echo "❌ That is a LIVE key. This demo must use TEST keys only. Aborting." >&2
      exit 1 ;;
    sk_test_*|rk_test_*) return 0 ;;
    *)
      echo "❌ Unexpected key prefix (expected sk_test_ / rk_test_). Aborting." >&2
      exit 1 ;;
  esac
}

put() { printf "%s" "$2" | npx wrangler secret put "$1" --env "$ENV"; }

echo "── Stripe TEST secret key (sk_test_...) ──"
echo "   Stripe dashboard → toggle 'Test mode' ON → Developers → API keys → Secret key"
read -rsp "Paste sk_test_ secret key: " STRIPE_TEST; echo
refuse_live "$STRIPE_TEST"

put STRIPE_SECRET_KEY "$STRIPE_TEST"   # Stripe Checkout (payment)
put KYC_PROVIDER_KEY  "$STRIPE_TEST"   # Stripe Identity (KYC) — same test secret works

echo
echo "── Stripe TEST webhook signing secret (whsec_...) ──"
echo "   Create endpoint: https://api-staging.offshoreproz.com/webhooks/stripe"
echo "   Events: identity.verification_session.verified,"
echo "           identity.verification_session.requires_input,"
echo "           checkout.session.completed"
read -rsp "Paste whsec_ signing secret: " WHSEC; echo
case "$WHSEC" in whsec_*) ;; *) echo "❌ Expected whsec_ prefix. Aborting." >&2; exit 1;; esac
put STRIPE_WEBHOOK_SECRET "$WHSEC"

echo
echo "✅ Stripe test secrets set on $ENV. DocuSeal is already configured."
echo "   Next: tell the assistant to flip LIVE_MODE_ENABLED=true (staging) and deploy."
