/**
 * Structured JSON logging for the Agent API.
 *
 * Rules:
 *  - ALL logs must be structured JSON (searchable in Cloudflare Logs dashboard)
 *  - NEVER log raw PII: no passport numbers, addresses, full names, emails,
 *    payment card numbers, KYC documents
 *  - Always include trace_id for request correlation
 *  - Use api_key_id, formation_id, portal_project_id as correlation keys
 *
 * Severity mapping:
 *  - info  → console.log  (informational, request lifecycle)
 *  - warn  → console.warn (unexpected but recoverable)
 *  - error → console.error (actionable: alerts fire on these)
 */

import type { LogEvent } from "../types.ts";

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/** Create a logger bound to a specific trace ID. */
export function createLogger(traceId: string): Logger {
  const base = { trace_id: traceId };

  function emit(
    level: LogEvent["level"],
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    // Sanitize extra to strip accidental PII fields
    const safeExtra = extra ? sanitize(extra) : {};
    const ev: LogEvent = {
      ...base,
      ts: new Date().toISOString(),
      level,
      message,
      ...safeExtra,
    };
    const line = JSON.stringify(ev);
    switch (level) {
      case "info":
        console.log(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }
  }

  return {
    info: (m, extra) => emit("info", m, extra),
    warn: (m, extra) => emit("warn", m, extra),
    error: (m, extra) => emit("error", m, extra),
  };
}

/** Fields that must never appear in logs. */
const PII_FIELDS = new Set([
  "password",
  "password_hash",
  "passport",
  "passport_number",
  "ssn",
  "itin",
  "dob",
  "date_of_birth",
  "address",
  "street",
  "zip",
  "phone",
  "full_name",
  "card_number",
  "cvv",
  "bank_account",
  "routing",
  "request_json_encrypted",
  "agent_context_json",
]);

function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = sanitize(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Format error safely for logging — never exposes stack traces to the API consumer. */
export function formatError(err: unknown): {
  error: string;
  error_type: string;
} {
  if (err instanceof Error) {
    return { error: err.message, error_type: err.constructor.name };
  }
  return { error: String(err), error_type: "UnknownError" };
}
