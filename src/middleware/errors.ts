/**
 * Global error handler middleware for the Agent API.
 *
 * Catches all unhandled exceptions and returns a structured 500 response.
 * Logs the error with trace ID and path — never exposes stack traces to callers.
 *
 * Must be registered FIRST in the Hono app so it wraps all other middleware.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { errors } from "../lib/response.ts";
import { createLogger, formatError } from "../lib/logger.ts";

export const errorHandler: MiddlewareHandler = async (
  c: Context,
  next: Next,
): Promise<Response | void> => {
  // trace_id is injected by the trace middleware before this runs
  const traceId =
    (c.get("trace_id") as string | undefined) ?? crypto.randomUUID();
  const logger = createLogger(traceId);
  const path = new URL(c.req.url).pathname;

  try {
    await next();
    return;
  } catch (err) {
    const { error, error_type } = formatError(err);
    logger.error("Unhandled exception", {
      error,
      error_type,
      method: c.req.method,
      path,
    });
    return errors.internal(traceId);
  }
};
