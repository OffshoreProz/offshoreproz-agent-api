/**
 * HTTP response helpers for the Agent API.
 *
 * All responses follow the standard envelope:
 *
 * Success:
 *   { "data": {...}, "request_id": "trace_id" }
 *
 * Error:
 *   { "error": "Human message", "code": "snake_case_code", "request_id": "..." }
 *   Optional: "docs": "https://docs.offshoreproz.com/api/errors/..."
 *
 * HTTP headers always include:
 *   Content-Type: application/json
 *   X-Request-Id: {trace_id}
 */

import type { ApiErrorResponse, ApiSuccessResponse } from "../types.ts";

const DOCS_BASE = "https://docs.offshoreproz.com/api/errors";

function headers(requestId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
    // Prevent downstream caching of API responses by default
    "Cache-Control": "no-store",
  };
}

// ─── Success responses ─────────────────────────────────────────────────────

export function ok<T>(data: T, requestId: string, status = 200): Response {
  const body: ApiSuccessResponse<T> = { data, request_id: requestId };
  return new Response(JSON.stringify(body), {
    status,
    headers: headers(requestId),
  });
}

export function created<T>(data: T, requestId: string): Response {
  return ok(data, requestId, 201);
}

export function accepted<T>(data: T, requestId: string): Response {
  return ok(data, requestId, 202);
}

// ─── Error responses ───────────────────────────────────────────────────────

function error(
  code: string,
  message: string,
  requestId: string,
  status: number,
  docsSlug?: string,
): Response {
  const body: ApiErrorResponse = {
    error: message,
    code,
    request_id: requestId,
    ...(docsSlug ? { docs: `${DOCS_BASE}/${docsSlug}` } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: headers(requestId),
  });
}

export const errors = {
  notFound: (requestId: string) =>
    error("not_found", "Resource not found", requestId, 404, "not-found"),

  methodNotAllowed: (requestId: string) =>
    error("method_not_allowed", "Method not allowed", requestId, 405),

  unauthorized: (requestId: string) =>
    error(
      "invalid_api_key",
      "Invalid or missing API key. Include your key as: Authorization: Bearer op_test_...",
      requestId,
      401,
      "invalid-api-key",
    ),

  forbidden: (requestId: string) =>
    error(
      "forbidden",
      "This operation is not permitted for your API key",
      requestId,
      403,
    ),

  conflict: (requestId: string, message: string) =>
    error(
      "idempotency_key_conflict",
      message,
      requestId,
      409,
      "idempotency-conflict",
    ),

  paymentRequired: (requestId: string) =>
    error(
      "payment_failed",
      "Payment method declined or authorization failed",
      requestId,
      402,
    ),

  unprocessable: (requestId: string, message: string, code = "unprocessable") =>
    error(code, message, requestId, 422, code),

  rateLimit: (requestId: string, retryAfter: number): Response => {
    const body: ApiErrorResponse = {
      error:
        "Rate limit exceeded. Slow down and retry after the specified interval.",
      code: "rate_limit_exceeded",
      request_id: requestId,
      docs: `${DOCS_BASE}/rate-limit`,
    };
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: {
        ...headers(requestId),
        "Retry-After": String(retryAfter),
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + retryAfter),
      },
    });
  },

  validation: (requestId: string, issues: unknown[]): Response => {
    const body: ApiErrorResponse & { issues: unknown[] } = {
      error: "Request validation failed. Check the issues array for details.",
      code: "validation_error",
      request_id: requestId,
      issues,
      docs: `${DOCS_BASE}/validation`,
    };
    return new Response(JSON.stringify(body), {
      status: 400,
      headers: headers(requestId),
    });
  },

  internal: (requestId: string): Response =>
    error(
      "internal_error",
      "An unexpected error occurred. It has been logged and our team will investigate.",
      requestId,
      500,
      "internal-error",
    ),

  serviceUnavailable: (requestId: string): Response =>
    error(
      "service_unavailable",
      "Service temporarily unavailable. Retry in a few minutes.",
      requestId,
      503,
    ),
};
