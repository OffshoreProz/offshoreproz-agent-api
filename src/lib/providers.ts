/**
 * Provider integrations — real (live) and simulated (sandbox).
 *
 * Sandbox (op_test_): simulate* functions return realistic-looking refs immediately.
 * Live (op_live_):    Real async API calls. Returns a redirect_url; the formation
 *                     advances when the provider webhook fires
 *                     (POST /webhooks/stripe or /webhooks/docseal).
 *
 * Wiring — set via `wrangler secret put <NAME> --env <staging|production>`:
 *   KYC:       KYC_PROVIDER_KEY         ← env.local STRIPE_IDENTIFYING_KEY_AGENT_API
 *   Payment:   STRIPE_SECRET_KEY        ← env.local STRIPE_SECRET_KEY_LIVE
 *   Signature: SIGNING_PROVIDER_KEY     ← env.local DOCUSEAL_API_KEY
 *              DOCUSEAL_TEMPLATE_ID_WY  ← numeric ID of WY operating-agreement template
 *              DOCUSEAL_TEMPLATE_ID_MI  ← numeric ID of MI DAO LLC operating-agreement template
 *   Webhooks:  STRIPE_WEBHOOK_SECRET    ← env.local STRIPE_WEBHOOK_SECRET_AGENT_API
 *              DOCUSEAL_WEBHOOK_SECRET  ← set in DocuSeal dashboard
 *   Filing:    manual-assisted by OffshoreProz ops team (no provider)
 */

import type { Env } from "../types.ts";

// ─── API base URLs ─────────────────────────────────────────────────────────────

const STRIPE_API = "https://api.stripe.com/v1";
const DOCSEAL_API = "https://api.docuseal.com";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function randomRef(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

// ─── Existing return types (unchanged — used by sandbox + webhook advance) ────

export interface KycResult {
  provider: "stripe_identity";
  reference: string;
  status: "verified";
  simulated: boolean;
}

export interface PaymentResult {
  provider: "stripe";
  reference: string;
  amount_usd: number;
  status: "authorized";
  simulated: boolean;
}

export interface SignatureResult {
  provider: "docseal";
  reference: string;
  status: "completed";
  simulated: boolean;
}

export interface FilingResult {
  provider: "manual_assisted";
  reference: string;
  status: "filed";
  simulated: boolean;
}

// ─── Live provider initiation results ─────────────────────────────────────────

/** Returned when a real Stripe Identity VerificationSession is created. */
export interface KycSessionResult {
  provider: "stripe_identity";
  session_id: string;
  url: string;
}

/** Returned when a real Stripe Checkout Session is created for payment. */
export interface PaymentSessionResult {
  provider: "stripe";
  checkout_session_id: string;
  payment_intent_id: string | null;
  url: string;
}

/** Returned when a real DocuSeal submission is created for signing. */
export interface SignatureSessionResult {
  provider: "docseal";
  submission_id: string;
  signing_url: string;
}

// ─── Sandbox simulations (op_test_ mode only) ─────────────────────────────────

/** Simulate a Stripe Identity verification (sandbox = always verified instantly). */
export function simulateKyc(simulated: boolean): KycResult {
  return {
    provider: "stripe_identity",
    reference: randomRef("vs"),
    status: "verified",
    simulated,
  };
}

/** Simulate a Stripe payment authorization (sandbox = always authorized instantly). */
export function simulatePayment(amountUsd: number, simulated: boolean): PaymentResult {
  return {
    provider: "stripe",
    reference: randomRef("pi"),
    amount_usd: amountUsd,
    status: "authorized",
    simulated,
  };
}

/** Simulate a DocuSeal signature envelope (sandbox = always completed instantly). */
export function simulateSignature(simulated: boolean): SignatureResult {
  return {
    provider: "docseal",
    reference: randomRef("sub"),
    status: "completed",
    simulated,
  };
}

/** Filing is always manual-assisted — no real provider to call. */
export function simulateFiling(simulated: boolean): FilingResult {
  return {
    provider: "manual_assisted",
    reference: randomRef("file"),
    status: "filed",
    simulated,
  };
}

// ─── Live: Stripe Identity (KYC) ──────────────────────────────────────────────

/**
 * Create a Stripe Identity VerificationSession.
 *
 * The owner is redirected to `url` to complete ID verification via Stripe's
 * hosted flow. After completion, Stripe calls POST /webhooks/stripe with an
 * `identity.verification_session.verified` (or `requires_input`) event, which
 * advances the formation state.
 *
 * Throws on API error — caller must NOT consume the action token if this throws.
 */
export async function initiateKycSession(
  env: Pick<Env, "KYC_PROVIDER_KEY">,
  formationId: string,
  returnUrl: string,
): Promise<KycSessionResult> {
  if (!env.KYC_PROVIDER_KEY) {
    throw new Error("KYC_PROVIDER_KEY not configured — run: wrangler secret put KYC_PROVIDER_KEY");
  }

  const resp = await fetch(`${STRIPE_API}/identity/verification_sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.KYC_PROVIDER_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Idempotency: a double-click / retry for the same formation reuses the
      // same VerificationSession instead of creating a duplicate. Stripe keys
      // are scoped per-account, so the formation id is a stable, unique key.
      "Idempotency-Key": `kyc_${formationId}`,
    },
    body: new URLSearchParams({
      type: "document",
      "metadata[formation_id]": formationId,
      "return_url": returnUrl,
      "options[document][require_live_capture]": "true",
      "options[document][require_matching_selfie]": "true",
    }),
  });

  const data = await resp.json() as {
    id?: string;
    url?: string;
    error?: { message: string; type: string };
  };

  if (!resp.ok || !data.id || !data.url) {
    throw new Error(data.error?.message ?? `Stripe Identity error (HTTP ${resp.status})`);
  }

  return { provider: "stripe_identity", session_id: data.id, url: data.url };
}

// ─── Live: Stripe Checkout (Payment) ──────────────────────────────────────────

/**
 * Create a Stripe Checkout Session for payment.
 *
 * The owner is redirected to `url` to pay via Stripe's hosted checkout.
 * After payment, Stripe calls POST /webhooks/stripe with a
 * `checkout.session.completed` event, which advances the formation state.
 *
 * Throws on API error — caller must NOT consume the action token if this throws.
 */
export async function initiateCheckoutSession(
  env: Pick<Env, "STRIPE_SECRET_KEY">,
  formationId: string,
  amountCents: number,
  jurisdiction: string,
  companyName: string,
  ownerEmail: string | undefined,
  successUrl: string,
  cancelUrl: string,
): Promise<PaymentSessionResult> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY not configured — run: wrangler secret put STRIPE_SECRET_KEY");
  }

  const productName =
    `${jurisdiction === "WY" ? "Wyoming" : "Marshall Islands"} LLC Formation — ${companyName}`;

  const bodyParams: Record<string, string> = {
    mode: "payment",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": amountCents.toString(),
    "line_items[0][price_data][product_data][name]": productName,
    "line_items[0][price_data][product_data][description]":
      "Includes state filing fees, registered agent (1 year), and operating agreement",
    "line_items[0][quantity]": "1",
    "metadata[formation_id]": formationId,
    "payment_intent_data[metadata][formation_id]": formationId,
    "success_url": successUrl,
    "cancel_url": cancelUrl,
  };

  if (ownerEmail) bodyParams["customer_email"] = ownerEmail;

  const resp = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Idempotency: prevents a double-charge if the owner clicks "confirm"
      // twice (or the request is retried) before the action token is consumed.
      // Stripe returns the SAME Checkout session for a repeated key, so at most
      // one charge can ever exist per formation.
      "Idempotency-Key": `checkout_${formationId}`,
    },
    body: new URLSearchParams(bodyParams),
  });

  const data = await resp.json() as {
    id?: string;
    payment_intent?: string;
    url?: string;
    error?: { message: string };
  };

  if (!resp.ok || !data.id || !data.url) {
    throw new Error(data.error?.message ?? `Stripe Checkout error (HTTP ${resp.status})`);
  }

  return {
    provider: "stripe",
    checkout_session_id: data.id,
    payment_intent_id: data.payment_intent ?? null,
    url: data.url,
  };
}

// ─── Live: DocuSeal (Signature) ───────────────────────────────────────────────

/**
 * Create a DocuSeal submission for the operating agreement.
 *
 * The owner is directed to `signing_url` to e-sign. DocuSeal also sends the
 * signing link by email. After signing, DocuSeal calls POST /webhooks/docseal
 * with a `form.completed` event, which advances the formation state.
 *
 * Requires SIGNING_PROVIDER_KEY and DOCUSEAL_TEMPLATE_ID_WY/MI to be set.
 *
 * Throws on API error or missing template — caller must NOT consume the action
 * token if this throws.
 */
export async function createDocuSealSubmission(
  env: Pick<
    Env,
    "SIGNING_PROVIDER_KEY" | "DOCUSEAL_TEMPLATE_ID_WY" | "DOCUSEAL_TEMPLATE_ID_MI"
  >,
  formationId: string,
  jurisdiction: string,
  companyName: string,
  ownerEmail: string,
  ownerName: string,
): Promise<SignatureSessionResult> {
  if (!env.SIGNING_PROVIDER_KEY) {
    throw new Error(
      "SIGNING_PROVIDER_KEY not configured — run: wrangler secret put SIGNING_PROVIDER_KEY",
    );
  }

  const templateIdStr =
    jurisdiction === "WY" ? env.DOCUSEAL_TEMPLATE_ID_WY : env.DOCUSEAL_TEMPLATE_ID_MI;

  if (!templateIdStr) {
    throw new Error(
      `DOCUSEAL_TEMPLATE_ID_${jurisdiction} not configured — ` +
        `run: wrangler secret put DOCUSEAL_TEMPLATE_ID_${jurisdiction}`,
    );
  }

  const templateId = parseInt(templateIdStr, 10);
  if (Number.isNaN(templateId)) {
    throw new Error(`DOCUSEAL_TEMPLATE_ID_${jurisdiction} must be a numeric template ID`);
  }

  const resp = await fetch(`${DOCSEAL_API}/submissions`, {
    method: "POST",
    headers: {
      "X-Auth-Token": env.SIGNING_PROVIDER_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template_id: templateId,
      send_email: true,
      submitters: [
        {
          role: "Signer",
          email: ownerEmail,
          name: ownerName,
          metadata: { formation_id: formationId },
          values: {
            company_name: companyName,
            jurisdiction: jurisdiction === "WY" ? "Wyoming" : "Marshall Islands",
          },
        },
      ],
    }),
  });

  type DocuSealSubmitter = { id: number; slug: string; error?: string };

  const data = await resp.json() as DocuSealSubmitter[] | { error: string };

  if (!resp.ok || !Array.isArray(data)) {
    const errMsg = !Array.isArray(data) ? (data as { error: string }).error : undefined;
    throw new Error(errMsg ?? `DocuSeal error (HTTP ${resp.status})`);
  }

  const submitter = data[0] as DocuSealSubmitter | undefined;
  if (!submitter || submitter.error) {
    throw new Error(submitter?.error ?? "DocuSeal returned no submitter");
  }

  return {
    provider: "docseal",
    submission_id: String(submitter.id),
    signing_url: `https://docuseal.com/s/${submitter.slug}`,
  };
}

// ─── Live: Stripe Refund ──────────────────────────────────────────────────────

/** Returned when a real Stripe Refund is created. */
export interface RefundResult {
  provider: "stripe";
  refund_id: string;
  payment_intent_id: string;
  amount_cents: number | null;
  status: string; // "succeeded" | "pending" | "failed" | "canceled"
}

/**
 * Refund a charged formation via the Stripe Refunds API.
 *
 * Used by the admin refund endpoint when a formation is cancelled or its filing
 * fails after payment, so the customer's money is never stranded.
 *
 * Idempotency: keyed on the payment_intent so a retried refund never issues a
 * second refund for the same charge.
 *
 * Throws on API error — the caller must NOT advance formation state if this
 * throws (otherwise we'd mark a formation refunded without a refund).
 */
export async function refundPayment(
  env: Pick<Env, "STRIPE_SECRET_KEY">,
  paymentIntentId: string,
  reason: "requested_by_customer" | "duplicate" | "fraudulent" = "requested_by_customer",
): Promise<RefundResult> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY not configured — run: wrangler secret put STRIPE_SECRET_KEY");
  }
  if (!paymentIntentId) {
    throw new Error("No payment_intent_id on formation — nothing to refund");
  }

  const resp = await fetch(`${STRIPE_API}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // One refund per charge, even if ops clicks twice or the call is retried.
      "Idempotency-Key": `refund_${paymentIntentId}`,
    },
    body: new URLSearchParams({
      payment_intent: paymentIntentId,
      reason,
    }),
  });

  const data = await resp.json() as {
    id?: string;
    amount?: number;
    status?: string;
    error?: { message: string };
  };

  if (!resp.ok || !data.id) {
    throw new Error(data.error?.message ?? `Stripe Refund error (HTTP ${resp.status})`);
  }

  return {
    provider: "stripe",
    refund_id: data.id,
    payment_intent_id: paymentIntentId,
    amount_cents: data.amount ?? null,
    status: data.status ?? "unknown",
  };
}
