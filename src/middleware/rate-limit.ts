/**
 * Rate Limiting Middleware — Sprint 2
 *
 * Sliding window rate limiter using Cloudflare KV.
 *
 * Limits per tier per minute:
 *   free:       50 req/min
 *   pro:      1000 req/min
 *   enterprise: no limit (but still tracked)
 *   sandbox:   200 req/min (test keys, any tier)
 *
 * KV key format: `rl:{api_key_id}:{window_start_minute}`
 * TTL: 120s (2x the window to handle clock drift)
 *
 * Must run AFTER requireApiKey (needs api_key_id and api_key_mode in context).
 *
 * Retry-After header is returned in 429 responses.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { errors } from "../lib/response.ts";
import { createLogger } from "../lib/logger.ts";

const LIMITS: Record<string, number> = {
  // test mode (sandbox) — always 200/min regardless of tier
  test_free: 200,
  test_pro: 200,
  test_enterprise: 200,
  // live mode — per tier
  live_free: 50,
  live_pro: 1000,
  live_enterprise: 999999,
};

const WINDOW_MS = 60_000; // 1 minute sliding window
const KV_TTL = 120; // seconds

export const rateLimiter: MiddlewareHandler = async (
  c: Context,
  next: Next,
): Promise<void> => {
  const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
  const logger = createLogger(traceId);

  const keyId = c.get("api_key_id") as string | undefined;
  const mode = c.get("api_key_mode") as string | undefined;
  const tier = c.get("api_key_tier") as string | undefined;

  // No auth context → rate limiting skipped (unauthenticated endpoint)
  if (!keyId || !mode || !tier) {
    await next();
    return;
  }

  const limitKey = `${mode}_${tier}`;
  const limit = LIMITS[limitKey] ?? 50;

  const windowStart = Math.floor(Date.now() / WINDOW_MS);
  const kvKey = `rl:${keyId}:${windowStart}`;

  // Get current count from KV
  const currentStr = await c.env.KV.get(kvKey);
  const current = currentStr ? parseInt(currentStr, 10) : 0;

  if (current >= limit) {
    const retryAfter = Math.ceil(
      (windowStart * WINDOW_MS + WINDOW_MS - Date.now()) / 1000,
    );
    logger.warn("Rate limit exceeded", {
      api_key_id: keyId,
      mode,
      tier,
      current,
      limit,
    });
    // Must return, not call next — cast workaround for Hono's void return type
    const res = errors.rateLimit(traceId, retryAfter);
    c.res = res;
    return;
  }

  // Increment counter async — non-blocking to avoid latency on every request
  c.executionCtx.waitUntil(
    c.env.KV.put(kvKey, String(current + 1), { expirationTtl: KV_TTL }).catch(
      () => {},
    ),
  );

  // Set rate limit headers on the response
  // We do this after next() so the actual response headers can be mutated
  await next();

  c.res.headers.set("X-RateLimit-Limit", String(limit));
  c.res.headers.set(
    "X-RateLimit-Remaining",
    String(Math.max(0, limit - current - 1)),
  );
  c.res.headers.set(
    "X-RateLimit-Reset",
    String(Math.floor((windowStart * WINDOW_MS + WINDOW_MS) / 1000)),
  );
};
