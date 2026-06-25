/**
 * Self-serve API Key Management — B5
 *
 * Endpoints:
 *   POST   /v1/keys           — create key (test: immediate; live: starts OTP flow)
 *   POST   /v1/keys/verify    — complete live key creation (OTP + payment check)
 *   GET    /v1/keys           — list my keys  (auth: Bearer op_* key)
 *   DELETE /v1/keys/:id       — revoke a key  (auth: Bearer op_* key, same email)
 *
 * Gates:
 *   Test keys  — always available, no auth required, rate-limited
 *   Live keys  — LIVE_MODE_ENABLED=true + email OTP + Stripe payment method on file
 *
 * Rate limits (KV-backed):
 *   key_create:{email} — 5 creates per hour per email
 *   key_create_ip:{ip} — 10 creates per hour per IP
 *   otp_attempts:{email} — 5 wrong attempts before OTP expires
 *
 * OTP storage:
 *   KV key:  otp:key:{email}
 *   Value:   {name, otp, attempts, expires_at}
 *   TTL:     1800s (30 minutes)
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { AppType } from "../types.ts";
import {
  ok,
  created,
  accepted,
  errors,
} from "../lib/response.ts";
import {
  generateApiKey,
  hashApiKey,
  generateTraceId,
} from "../lib/crypto.ts";
import { isLiveModeEnabled } from "../config/live-mode.ts";
import { requireApiKey } from "../middleware/auth.ts";
import { sendVerificationEmail } from "../lib/email.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const OTP_TTL_SECONDS = 1800; // 30 minutes
const RATE_HOUR = 3600;
const RATE_MAX_PER_EMAIL = 5;
const RATE_MAX_PER_IP = 10;
const OTP_MAX_ATTEMPTS = 5;

// ── ID generators ──────────────────────────────────────────────────────────────

function generateKeyId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `key_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] ?? 0) % 1_000_000).padStart(6, "0");
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const createKeySchema = z.object({
  mode: z.enum(["test", "live"]),
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
});

const verifyOtpSchema = z.object({
  email: z.string().email().max(254),
  otp: z.string().length(6),
});

// ── KV helpers ─────────────────────────────────────────────────────────────────

interface PendingKeyEntry {
  name: string;
  otp: string;
  attempts: number;
  expires_at: number; // Unix epoch ms
}

async function getKvRate(kv: KVNamespace, key: string): Promise<number> {
  return ((await kv.get(key, "json")) as number | null) ?? 0;
}

async function incrementKvRate(
  kv: KVNamespace,
  key: string,
  max: number,
  ttl: number,
): Promise<boolean> {
  const count = await getKvRate(kv, key);
  if (count >= max) return false;
  await kv.put(key, JSON.stringify(count + 1), { expirationTtl: ttl });
  return true;
}

// ── Stripe payment method check ────────────────────────────────────────────────
// Verifies that the email has a Stripe Customer with a payment method on file.
// Returns true if approved. Returns false + reason string if not.
//
// TODO (billing setup): if no customer exists, generate a Stripe Checkout
// Session in "setup" mode and return its URL so the developer can add a card
// before retrying. For now we return a 402 with instructions.

async function hasStripePaymentMethod(
  stripeKey: string,
  email: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // 1. Find customer by email
  const url = `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1&expand[]=data.invoice_settings.default_payment_method`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });

  if (!res.ok) {
    return { ok: false, reason: "stripe_api_error" };
  }

  const body = (await res.json()) as {
    data: Array<{
      id: string;
      default_source: string | null;
      invoice_settings: { default_payment_method: string | null };
    }>;
  };

  if (!body.data?.length) {
    return { ok: false, reason: "no_stripe_customer" };
  }

  const customer = body.data[0];
  if (!customer) return { ok: false, reason: "no_stripe_customer" };

  const hasPM =
    customer.invoice_settings?.default_payment_method ||
    customer.default_source;

  if (!hasPM) {
    return { ok: false, reason: "no_payment_method" };
  }

  return { ok: true };
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerKeyRoutes(app: Hono<AppType>): void {
  // ── POST /v1/keys — create key (public) ─────────────────────────────────────
  app.post("/v1/keys", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();

    const body = await c.req.json().catch(() => null);
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      return errors.validation(
        traceId,
        parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      );
    }

    const { mode, name, email } = parsed.data;
    const normalEmail = email.toLowerCase().trim();
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For") ??
      "unknown";

    // Rate limit by email
    const emailRateKey = `rate:key_create:email:${normalEmail}`;
    const emailOk = await incrementKvRate(
      c.env.KV,
      emailRateKey,
      RATE_MAX_PER_EMAIL,
      RATE_HOUR,
    );
    if (!emailOk) return errors.rateLimit(traceId, RATE_HOUR);

    // Rate limit by IP
    const ipRateKey = `rate:key_create:ip:${ip}`;
    const ipOk = await incrementKvRate(
      c.env.KV,
      ipRateKey,
      RATE_MAX_PER_IP,
      RATE_HOUR,
    );
    if (!ipOk) return errors.rateLimit(traceId, RATE_HOUR);

    // ── Test key — immediate creation ─────────────────────────────────────────
    if (mode === "test") {
      const rawKey = generateApiKey("test");
      const keyHash = await hashApiKey(rawKey);
      const keyId = generateKeyId();
      const now = new Date().toISOString();

      await c.env.AGENT_DB.prepare(
        `INSERT INTO agent_api_keys
         (id, key_hash, mode, name, owner_email, tier, created_at)
         VALUES (?, ?, 'test', ?, ?, 'free', ?)`,
      )
        .bind(keyId, keyHash, name, normalEmail, now)
        .run();

      return created(
        {
          id: keyId,
          key: rawKey,
          mode: "test" as const,
          name,
          owner_email: normalEmail,
          tier: "free",
          created_at: now,
          warning:
            "Store this key securely — it cannot be retrieved again. Use it as: Authorization: Bearer op_test_...",
        },
        traceId,
      );
    }

    // ── Live key — start OTP verification flow ────────────────────────────────
    if (!isLiveModeEnabled(c.env)) {
      return c.json(
        {
          error:
            "Live API keys are not yet available. Join the beta waitlist at POST /v1/beta/waitlist or use a test key (op_test_) for sandbox testing.",
          code: "live_mode_not_available",
          request_id: traceId,
          docs: "https://docs.offshoreproz.com/api/beta",
        },
        403,
      );
    }

    if (!c.env.RESEND_API_KEY) {
      return errors.internal(traceId);
    }

    const otp = generateOtp();
    const expiresAt = Date.now() + OTP_TTL_SECONDS * 1000;

    const entry: PendingKeyEntry = {
      name,
      otp,
      attempts: 0,
      expires_at: expiresAt,
    };

    await c.env.KV.put(
      `otp:key:${normalEmail}`,
      JSON.stringify(entry),
      { expirationTtl: OTP_TTL_SECONDS },
    );

    const emailResult = await sendVerificationEmail(
      c.env.RESEND_API_KEY,
      normalEmail,
      otp,
    );

    if (!emailResult.ok) {
      // Clean up KV if email failed — don't leave orphaned OTP
      c.executionCtx.waitUntil(
        c.env.KV.delete(`otp:key:${normalEmail}`).catch(() => {}),
      );
      return errors.internal(traceId);
    }

    return accepted(
      {
        status: "verification_required",
        message:
          "Check your email for a 6-digit verification code. Submit it to POST /v1/keys/verify within 30 minutes.",
        email: normalEmail,
        expires_in_minutes: 30,
      },
      traceId,
    );
  });

  // ── POST /v1/keys/verify — complete live key creation ───────────────────────
  app.post("/v1/keys/verify", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();

    if (!isLiveModeEnabled(c.env)) {
      return c.json(
        {
          error:
            "Live mode is not yet available.",
          code: "live_mode_not_available",
          request_id: traceId,
        },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = verifyOtpSchema.safeParse(body);
    if (!parsed.success) {
      return errors.validation(
        traceId,
        parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      );
    }

    const { email, otp } = parsed.data;
    const normalEmail = email.toLowerCase().trim();
    const otpKey = `otp:key:${normalEmail}`;

    // Load pending entry
    const raw = await c.env.KV.get(otpKey, "json") as PendingKeyEntry | null;
    if (!raw) {
      return errors.unprocessable(
        traceId,
        "No pending verification found for this email. Start by calling POST /v1/keys with mode=live.",
        "otp_not_found",
      );
    }

    if (Date.now() > raw.expires_at) {
      c.executionCtx.waitUntil(c.env.KV.delete(otpKey).catch(() => {}));
      return errors.unprocessable(
        traceId,
        "Verification code expired. Start over with POST /v1/keys.",
        "otp_expired",
      );
    }

    // Increment attempt counter before checking — prevents timing oracle
    raw.attempts += 1;
    if (raw.attempts > OTP_MAX_ATTEMPTS) {
      c.executionCtx.waitUntil(c.env.KV.delete(otpKey).catch(() => {}));
      return errors.unprocessable(
        traceId,
        "Too many incorrect attempts. Start over with POST /v1/keys.",
        "otp_attempts_exceeded",
      );
    }

    if (otp !== raw.otp) {
      // Save incremented attempt count back to KV
      await c.env.KV.put(otpKey, JSON.stringify(raw), {
        expirationTtl: Math.floor((raw.expires_at - Date.now()) / 1000),
      });
      return errors.unprocessable(
        traceId,
        `Incorrect code. ${OTP_MAX_ATTEMPTS - raw.attempts} ${raw.attempts === OTP_MAX_ATTEMPTS - 1 ? "attempt" : "attempts"} remaining.`,
        "otp_invalid",
      );
    }

    // OTP correct — check Stripe payment method
    const stripeKey = c.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const stripeCheck = await hasStripePaymentMethod(stripeKey, normalEmail);
      if (!stripeCheck.ok) {
        const reason = stripeCheck.reason;
        const isNoCustomer =
          reason === "no_stripe_customer" || reason === "no_payment_method";

        return c.json(
          {
            error: isNoCustomer
              ? "No payment method on file. Add a payment method at https://docs.offshoreproz.com/billing before creating a live key."
              : "Could not verify payment method. Retry in a moment.",
            code: isNoCustomer
              ? "payment_method_required"
              : "payment_check_failed",
            request_id: traceId,
            docs: "https://docs.offshoreproz.com/billing",
          },
          isNoCustomer ? 402 : 503,
        );
      }
    }

    // All gates passed — create the live key
    const rawKey = generateApiKey("live");
    const keyHash = await hashApiKey(rawKey);
    const keyId = generateKeyId();
    const now = new Date().toISOString();

    await c.env.AGENT_DB.prepare(
      `INSERT INTO agent_api_keys
       (id, key_hash, mode, name, owner_email, tier, created_at)
       VALUES (?, ?, 'live', ?, ?, 'free', ?)`,
    )
      .bind(keyId, keyHash, raw.name, normalEmail, now)
      .run();

    // Delete OTP entry — consumed
    c.executionCtx.waitUntil(c.env.KV.delete(otpKey).catch(() => {}));

    return created(
      {
        id: keyId,
        key: rawKey,
        mode: "live" as const,
        name: raw.name,
        owner_email: normalEmail,
        tier: "free",
        created_at: now,
        warning:
          "Store this key securely — it cannot be retrieved again. Use it as: Authorization: Bearer op_live_...",
      },
      traceId,
    );
  });

  // ── GET /v1/keys — list my keys (authenticated) ─────────────────────────────
  app.get("/v1/keys", requireApiKey, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;

    // Get owner_email from the authenticated key
    const authKey = await c.env.AGENT_DB.prepare(
      `SELECT owner_email FROM agent_api_keys WHERE id = ? LIMIT 1`,
    )
      .bind(apiKeyId)
      .first<{ owner_email: string }>();

    if (!authKey) return errors.unauthorized(traceId);

    const result = await c.env.AGENT_DB.prepare(
      `SELECT id, mode, name, tier, created_at, last_used_at,
              CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END AS is_active
       FROM agent_api_keys
       WHERE owner_email = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
      .bind(authKey.owner_email)
      .all<{
        id: string;
        mode: string;
        name: string;
        tier: string;
        created_at: string;
        last_used_at: string | null;
        is_active: number;
      }>();

    return ok(
      {
        keys: (result.results ?? []).map((k) => ({
          id: k.id,
          mode: k.mode,
          name: k.name,
          tier: k.tier,
          created_at: k.created_at,
          last_used_at: k.last_used_at,
          is_active: k.is_active === 1,
        })),
        count: result.results?.length ?? 0,
      },
      traceId,
    );
  });

  // ── DELETE /v1/keys/:id — revoke key (authenticated, same owner) ─────────────
  app.delete("/v1/keys/:id", requireApiKey, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const targetId = c.req.param("id");

    // Prevent revoking your own current key (would break auth for further calls)
    if (targetId === apiKeyId) {
      return errors.unprocessable(
        traceId,
        "Cannot revoke the key used for this request. Use a different key to revoke this one, or contact support.",
        "cannot_revoke_current_key",
      );
    }

    // Get owner_email from the authenticated key
    const authKey = await c.env.AGENT_DB.prepare(
      `SELECT owner_email FROM agent_api_keys WHERE id = ? LIMIT 1`,
    )
      .bind(apiKeyId)
      .first<{ owner_email: string }>();

    if (!authKey) return errors.unauthorized(traceId);

    // Load target key and verify same owner
    const targetKey = await c.env.AGENT_DB.prepare(
      `SELECT id, owner_email, revoked_at FROM agent_api_keys WHERE id = ? LIMIT 1`,
    )
      .bind(targetId)
      .first<{ id: string; owner_email: string; revoked_at: string | null }>();

    if (!targetKey) return errors.notFound(traceId);

    if (targetKey.owner_email !== authKey.owner_email) {
      return errors.forbidden(traceId);
    }

    if (targetKey.revoked_at) {
      return errors.unprocessable(
        traceId,
        "This key is already revoked.",
        "already_revoked",
      );
    }

    const now = new Date().toISOString();
    await c.env.AGENT_DB.prepare(
      `UPDATE agent_api_keys SET revoked_at = ? WHERE id = ?`,
    )
      .bind(now, targetId)
      .run();

    return ok({ revoked: true, id: targetId, revoked_at: now }, traceId);
  });
}
