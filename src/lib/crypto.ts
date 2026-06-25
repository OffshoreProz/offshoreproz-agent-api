/**
 * Cryptographic utilities for the Agent API.
 *
 * Uses the Web Crypto API — natively available in the Workers runtime.
 * Never use Math.random() for security-sensitive values.
 *
 * Rules:
 *  - Token/ID generation → crypto.randomUUID() or getRandomValues()
 *  - Secret comparison → timingSafeCompare() (prevents timing attacks)
 *  - API key storage → hashApiKey() (SHA-256, never store raw)
 *  - Webhook signatures → signWebhookPayload() (HMAC-SHA256)
 */

/** Generate a cryptographically secure trace ID for request correlation. */
export function generateTraceId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a new raw API key.
 * Format: op_{mode}_{64 random hex chars}
 *
 * Only show to user ONCE. Store only the hash.
 */
export function generateApiKey(mode: "test" | "live"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `op_${mode}_${hex}`;
}

/**
 * Hash an API key for storage using SHA-256.
 * Returns a 64-char hex string.
 *
 * Usage: store hash, compare with timingSafeCompare().
 */
export async function hashApiKey(rawKey: string): Promise<string> {
  const data = new TextEncoder().encode(rawKey);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Timing-safe comparison of two string values.
 * Hashes both to SHA-256 first to prevent length information leakage.
 *
 * Use for: API key verification, webhook secret comparison.
 */
export async function timingSafeCompare(
  a: string,
  b: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

/**
 * Sign a webhook payload using HMAC-SHA256.
 * Returns: `t={timestamp},v1={signature_hex}`
 *
 * Receiver must verify timestamp is within ±5 minutes to prevent replays.
 */
export async function signWebhookPayload(
  secret: string,
  payload: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const timestamp = Date.now();
  const toSign = `${timestamp}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(toSign));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

/**
 * Verify a webhook signature received from an inbound provider (Stripe, signing provider).
 * Returns true if the signature is valid and timestamp is within tolerance.
 *
 * @param secret  - Webhook secret
 * @param rawBody - Raw request body bytes (not parsed JSON)
 * @param sigHeader - Value of X-Signature or equivalent header
 * @param toleranceMs - Max age in ms (default: 5 minutes)
 */
export async function verifyInboundWebhook(
  secret: string,
  rawBody: string,
  sigHeader: string,
  toleranceMs = 5 * 60 * 1000,
): Promise<boolean> {
  const parts = sigHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;

  const timestamp = parseInt(tPart.slice(2), 10);
  if (Number.isNaN(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp) > toleranceMs) return false;

  const expectedSig = await signWebhookPayload(
    secret,
    `${timestamp}.${rawBody}`,
  );
  const expectedV1 = expectedSig.split(",v1=")[1] ?? "";
  return timingSafeCompare(v1Part.slice(3), expectedV1);
}

/** Generate a short idempotency nonce for KV storage (24 chars). */
export function generateNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── PII encryption (AES-256-GCM) ─────────────────────────────────────────────
// For encrypting sensitive intake (beneficial-owner PII / full request_json) at
// rest in AGENT_DB, keyed off API_KEY_ENCRYPTION_SECRET. NOTE: as of this writing
// the formation flow does NOT persist beneficial-owner PII (only non-PII
// agent_context is stored), so there is no plaintext PII at rest. These helpers
// exist so that IF intake storage is later required (audit/replay/support), it is
// encrypted from day one. See plano-final/09-SEGURANCA-COMPLIANCE-LEGAL.md.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Derive a 256-bit AES-GCM key from the encryption secret (SHA-256 of the secret). */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 * Returns `v1:{base64(iv)}:{base64(ciphertext+tag)}` — versioned for forward compat.
 * A fresh 12-byte IV is generated per call.
 */
export async function encryptPII(
  plaintext: string,
  secret: string,
): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1:${bytesToB64(iv)}:${bytesToB64(new Uint8Array(ct))}`;
}

/**
 * Decrypt a value produced by encryptPII().
 * Backward-compatible: a value not in the `v1:iv:ct` format (e.g. legacy plaintext)
 * is returned unchanged, so this is safe to call on mixed old/new data.
 */
export async function decryptPII(
  value: string,
  secret: string,
): Promise<string> {
  if (!value.startsWith("v1:")) return value; // legacy plaintext — pass through
  const parts = value.split(":");
  const ivB64 = parts[1];
  const ctB64 = parts[2];
  if (parts.length !== 3 || !ivB64 || !ctB64) return value;
  const key = await deriveAesKey(secret);
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
