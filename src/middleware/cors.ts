/**
 * CORS middleware for the Agent API.
 *
 * The Agent API is a public API — any origin may call it.
 * Sensitive operations are protected by API key auth, not by CORS.
 *
 * Preflight (OPTIONS) requests are handled and must return quickly.
 */

import type { Context, MiddlewareHandler, Next } from "hono";

const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOWED_HEADERS =
  "Authorization, Content-Type, Idempotency-Key, X-OffshoreProz-Agent-Id, X-OffshoreProz-Request-Source";
const EXPOSE_HEADERS =
  "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After";
const MAX_AGE = "86400"; // 24h — cache preflight responses

export const cors: MiddlewareHandler = async (
  c: Context,
  next: Next,
): Promise<Response | void> => {
  // Handle CORS preflight immediately — do not continue to next handler
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(c.req.header("Origin")),
    });
  }

  await next();

  // Attach CORS headers to all responses
  const origin = c.req.header("Origin");
  if (origin) {
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      c.res.headers.set(key, value);
    }
  }
};

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Expose-Headers": EXPOSE_HEADERS,
    "Access-Control-Max-Age": MAX_AGE,
    // Do not send credentials (cookies) across origins for this API
    "Access-Control-Allow-Credentials": "false",
    Vary: "Origin",
  };
}
