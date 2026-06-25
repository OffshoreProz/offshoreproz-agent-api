/**
 * Request tracing middleware.
 *
 * Assigns a unique trace_id to every request and stores it in Hono context.
 * All subsequent middleware and handlers read from c.get('trace_id').
 *
 * The trace_id is also returned in every response as X-Request-Id header,
 * enabling correlation between client logs and server logs.
 *
 * Logs request entry and exit with timing and status code.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { generateTraceId } from "../lib/crypto.ts";
import { createLogger } from "../lib/logger.ts";

export const trace: MiddlewareHandler = async (
  c: Context,
  next: Next,
): Promise<void> => {
  const traceId = generateTraceId();
  const start = Date.now();
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Store in context for all downstream middleware and handlers
  c.set("trace_id", traceId);

  const logger = createLogger(traceId);
  logger.info("Request received", { method, path });

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  // Set the trace header on every response
  c.res.headers.set("X-Request-Id", traceId);

  if (status >= 500) {
    logger.error("Request completed with server error", {
      method,
      path,
      status_code: status,
      duration_ms: duration,
    });
  } else if (status >= 400) {
    logger.warn("Request completed with client error", {
      method,
      path,
      status_code: status,
      duration_ms: duration,
    });
  } else {
    logger.info("Request completed", {
      method,
      path,
      status_code: status,
      duration_ms: duration,
    });
  }
};
