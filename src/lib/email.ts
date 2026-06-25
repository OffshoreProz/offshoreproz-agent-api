/**
 * Transactional email via Resend REST API.
 *
 * No SDK — plain fetch(). From address: api@offshoreproz.com (Resend verified domain).
 * All functions are fire-and-forget safe: they never throw; failed sends return {ok:false}.
 * Requires: RESEND_API_KEY secret in wrangler.jsonc.
 */

const FROM = "OffshoreProz <api@offshoreproz.com>";
const RESEND_URL = "https://api.resend.com/emails";
const PORTAL_BASE = "https://docs.offshoreproz.com";

interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

async function send(
  apiKey: string,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<SendResult> {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `Resend ${res.status}: ${t.slice(0, 200)}` };
  }

  const json = (await res.json()) as { id?: string };
  const emailId = json.id;
  return emailId ? { ok: true, id: emailId } : { ok: true };
}

// ─── HTML helpers ────────────────────────────────────────────────────────────

function layout(body: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#1a1a1a;line-height:1.6">
    <div style="border-bottom:2px solid #0f172a;padding-bottom:16px;margin-bottom:24px">
      <strong style="font-size:18px">OffshoreProz</strong>
    </div>
    ${body}
    <div style="border-top:1px solid #e2e8f0;margin-top:32px;padding-top:16px;color:#64748b;font-size:12px">
      OffshoreProz · AI-native company formation · <a href="https://offshoreproz.com">offshoreproz.com</a>
    </div>
  </body></html>`;
}

function btn(label: string, url: string): string {
  return `<p><a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`;
}

// ─── OTP verification (B5 self-serve live key) ───────────────────────────────

export async function sendVerificationEmail(
  apiKey: string,
  to: string,
  otp: string,
): Promise<SendResult> {
  const text = [
    `Your verification code is: ${otp}`,
    "",
    "Enter this code at POST /v1/keys/verify to activate your live API key.",
    "The code expires in 30 minutes.",
    "",
    "If you did not request this, ignore this email.",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">Your API verification code</h2>
    <p>Enter the code below to activate your live API key.</p>
    <p style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0f172a;margin:24px 0">${otp}</p>
    <p style="color:#64748b;font-size:14px">Expires in 30 minutes · <code>POST /v1/keys/verify</code></p>
    <p style="color:#94a3b8;font-size:12px">If you did not request this, ignore this email.</p>
  `);

  return send(apiKey, to, "Your OffshoreProz API verification code", text, html);
}

// ─── Formation step notifications ─────────────────────────────────────────────

/** KYC passed → owner must complete payment. */
export async function sendPaymentReadyEmail(
  apiKey: string,
  to: string,
  companyName: string,
  actionUrl: string,
  expiresAt: string,
): Promise<SendResult> {
  const expiryDate = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  const text = [
    `Great news! Identity verification for "${companyName}" is complete.`,
    "",
    "Your next step is to authorize payment to continue the formation process.",
    "",
    `Complete payment: ${actionUrl}`,
    `Link expires: ${expiryDate}`,
    "",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">Identity verified — payment required</h2>
    <p>Great news! Identity verification for <strong>${companyName}</strong> is complete.</p>
    <p>Your next step is to authorize payment to continue the formation process.</p>
    ${btn("Complete Payment →", actionUrl)}
    <p style="color:#64748b;font-size:13px">Link expires ${expiryDate}.</p>
  `);

  return send(apiKey, to, `Action required: Authorize payment for ${companyName}`, text, html);
}

/** Payment authorized → owner must sign the operating agreement. */
export async function sendSignatureReadyEmail(
  apiKey: string,
  to: string,
  companyName: string,
  jurisdiction: string,
  actionUrl: string,
  expiresAt: string,
): Promise<SendResult> {
  const expiryDate = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
  const entityLabel = jurisdiction === "MI" ? "DAO LLC Operating Agreement" : "LLC Operating Agreement";

  const text = [
    `Payment received for "${companyName}".`,
    "",
    `Your next step is to sign your ${entityLabel}.`,
    "",
    `Sign now: ${actionUrl}`,
    `Link expires: ${expiryDate}`,
    "",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">Payment received — signature required</h2>
    <p>Payment for <strong>${companyName}</strong> has been received.</p>
    <p>Please sign your ${entityLabel} to complete the formation process.</p>
    ${btn("Sign Operating Agreement →", actionUrl)}
    <p style="color:#64748b;font-size:13px">Link expires ${expiryDate}. The document will also be emailed to you by DocuSeal.</p>
  `);

  return send(apiKey, to, `Action required: Sign your ${companyName} operating agreement`, text, html);
}

/** DocuSeal completed → formation is in queue for filing. */
export async function sendFilingQueueEmail(
  apiKey: string,
  to: string,
  companyName: string,
  jurisdiction: string,
): Promise<SendResult> {
  const etaText = jurisdiction === "MI"
    ? "7-30 business days (MIDAO)"
    : "1-2 business days";
  const statusUrl = `${PORTAL_BASE}/portal`;

  const text = [
    `Your ${companyName} formation is in the queue for filing.`,
    "",
    "All documents have been signed and submitted. Our team will file your company and notify you when registration is complete.",
    "",
    `Estimated timeline: ${etaText}`,
    "",
    `Track your formation: ${statusUrl}`,
    "",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">Documents submitted — formation in progress</h2>
    <p>All documents for <strong>${companyName}</strong> have been signed and submitted.</p>
    <p>Our team will file your company and notify you when registration is complete.</p>
    <p style="background:#f1f5f9;border-radius:6px;padding:12px 16px;font-size:14px">
      ⏱ Estimated timeline: <strong>${etaText}</strong>
    </p>
    ${btn("Track Your Formation →", statusUrl)}
  `);

  return send(apiKey, to, `${companyName} — filed and in progress`, text, html);
}

/** Ops completed filing → company is registered. */
export async function sendRegistrationCompleteEmail(
  apiKey: string,
  to: string,
  companyName: string,
  jurisdiction: string,
  filingReference?: string,
): Promise<SendResult> {
  const docsUrl = `${PORTAL_BASE}/portal`;
  const jurisdictionName = jurisdiction === "WY" ? "Wyoming LLC"
    : jurisdiction === "MI" ? "Marshall Islands DAO LLC"
    : jurisdiction;

  const text = [
    `Congratulations! ${companyName} is now officially registered.`,
    "",
    `Entity type: ${jurisdictionName}`,
    ...(filingReference ? [`Filing reference: ${filingReference}`] : []),
    "",
    "Your formation documents are available in your portal.",
    "",
    `Access documents: ${docsUrl}`,
    "",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">🎉 ${companyName} is registered!</h2>
    <p>Congratulations! Your <strong>${jurisdictionName}</strong> is now officially registered.</p>
    ${filingReference ? `<p style="color:#64748b;font-size:13px">Filing reference: <code>${filingReference}</code></p>` : ""}
    <p>Your formation documents (Articles of Organization, Operating Agreement) are available in your portal.</p>
    ${btn("Access Your Documents →", docsUrl)}
    <p style="color:#64748b;font-size:13px">If you need an EIN or have questions, reply to this email.</p>
  `);

  return send(apiKey, to, `🎉 ${companyName} is now registered!`, text, html);
}

/** Admin approved pilot — owner must proceed with KYC. */
export async function sendKycReadyEmail(
  apiKey: string,
  to: string,
  companyName: string,
  actionUrl: string,
  expiresAt: string,
): Promise<SendResult> {
  const expiryDate = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  const text = [
    `Good news! Your ${companyName} application has been reviewed and approved.`,
    "",
    "Your next step is to complete identity verification (KYC) to continue.",
    "",
    `Start identity verification: ${actionUrl}`,
    `Link expires: ${expiryDate}`,
    "",
    "This uses Stripe Identity — you'll need a government-issued ID and a selfie.",
    "",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">Application approved — verify your identity</h2>
    <p>Your <strong>${companyName}</strong> application has been reviewed and approved.</p>
    <p>Your next step is to complete identity verification (KYC) to continue.</p>
    ${btn("Start Identity Verification →", actionUrl)}
    <p style="color:#64748b;font-size:13px">Link expires ${expiryDate}. You'll need a government-issued ID and a selfie.</p>
  `);

  return send(apiKey, to, `Action required: Verify your identity for ${companyName}`, text, html);
}

/** KYC failed — owner needs to retry. */
export async function sendKycFailedEmail(
  apiKey: string,
  to: string,
  companyName: string,
  reason: string,
): Promise<SendResult> {
  const supportUrl = "mailto:support@offshoreproz.com";

  const text = [
    `Identity verification for "${companyName}" could not be completed.`,
    "",
    `Reason: ${reason}`,
    "",
    "You can retry by returning to your formation link. If you need help, contact support@offshoreproz.com.",
    "",
    "— OffshoreProz Team",
  ].join("\n");

  const html = layout(`
    <h2 style="margin:0 0 8px">Identity verification needs attention</h2>
    <p>Identity verification for <strong>${companyName}</strong> could not be completed.</p>
    <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;font-size:14px;color:#991b1b">
      ${reason}
    </p>
    <p>You can retry via your formation link. If you continue to have issues:</p>
    ${btn("Contact Support →", supportUrl)}
  `);

  return send(apiKey, to, `Identity verification issue — ${companyName}`, text, html);
}
