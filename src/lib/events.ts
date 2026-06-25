/**
 * Formation event helpers — Sprint 4
 *
 * Centralizes the event-logging pattern used across all formation routes.
 * The agent_formation_events table is append-only — never UPDATE or DELETE rows.
 *
 * Schema: agent_formation_events (migrations/agent-db/0001_initial_schema.sql)
 *
 * Usage:
 *   // Log a transition
 *   const eventId = await logFormationEvent(db, {
 *     formation_id, event_type: "status_change",
 *     from_status: "draft", to_status: "pending_owner_confirmation",
 *     actor_type: "api_key", actor_id: apiKeyId, trace_id,
 *   });
 *
 *   // Fetch history for GET /v1/formations/:id/events
 *   const events = await getFormationEvents(db, formationId);
 */

import { generateTraceId } from "./crypto.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Internal DB event types. Webhook delivery uses the public event surface
 * defined in webhooks.ts (e.g. "formation.created", "formation.status_changed").
 */
export type InternalEventType =
  | "status_change"
  | "payment"
  | "signed"
  | "filed"
  | "error"
  | "webhook_sent"
  | "portal_sync"
  | "retry"
  | "cancel"
  | "note";

/** Public webhook event types exposed to API consumers. */
export type PublicEventType =
  | "formation.created"
  | "formation.status_changed"
  | "formation.cancelled"
  | "formation.portal_synced"
  | "formation.portal_sync_failed"
  | "formation.payment_received"
  | "formation.signed"
  | "formation.filed"
  | "formation.complete"
  | "formation.error";

export type ActorType = "api_key" | "system" | "admin" | "owner" | "webhook";

export interface LogEventInput {
  formation_id: string;
  event_type: InternalEventType | string;
  from_status?: string | null;
  to_status?: string | null;
  actor_type?: ActorType;
  actor_id?: string | null;
  trace_id?: string | null;
  payload?: Record<string, unknown>;
}

export interface FormationEventRow {
  id: string;
  formation_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  actor_id: string | null;
  trace_id: string | null;
  payload_json: string;
  created_at: string;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Log a formation event. Safe to call fire-and-forget — catches all errors.
 * Returns the generated event ID (evt_...).
 */
export async function logFormationEvent(
  db: D1Database,
  input: LogEventInput,
): Promise<string> {
  const id = `evt_${generateTraceId().replace(/-/g, "").slice(0, 14)}`;
  const now = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO agent_formation_events
         (id, formation_id, event_type, from_status, to_status,
          actor_type, actor_id, trace_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.formation_id,
        input.event_type,
        input.from_status ?? null,
        input.to_status ?? null,
        input.actor_type ?? "system",
        input.actor_id ?? null,
        input.trace_id ?? null,
        input.payload ? JSON.stringify(input.payload) : "{}",
        now,
      )
      .run();
  } catch (err) {
    // Events must never block the critical path
    console.error("[events] log_failed", {
      formation_id: input.formation_id,
      event_type: input.event_type,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return id;
}

/**
 * Fetch all events for a formation in chronological order (ASC).
 * Used by GET /v1/formations/:id/events.
 */
export async function getFormationEvents(
  db: D1Database,
  formation_id: string,
  limit = 100,
): Promise<FormationEventRow[]> {
  const result = await db
    .prepare(
      `SELECT id, formation_id, event_type, from_status, to_status,
              actor_type, actor_id, trace_id, payload_json, created_at
       FROM agent_formation_events
       WHERE formation_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(formation_id, limit)
    .all<FormationEventRow>();

  return result.results ?? [];
}

/**
 * Map an internal event_type + status transition to a public webhook event type.
 * Returns null if the event should not be delivered as a webhook.
 */
export function toPublicEventType(
  event_type: string,
  to_status?: string | null,
): PublicEventType | null {
  if (event_type === "status_change") {
    if (!to_status) return "formation.status_changed";
    if (to_status === "cancelled") return "formation.cancelled";
    if (to_status === "portal_synced") return "formation.portal_synced";
    if (to_status === "complete") return "formation.complete";
    return "formation.status_changed";
  }
  if (event_type === "payment") return "formation.payment_received";
  if (event_type === "signed") return "formation.signed";
  if (event_type === "filed") return "formation.filed";
  if (event_type === "error") return "formation.error";
  if (event_type === "portal_sync") return "formation.portal_synced";
  return null;
}
