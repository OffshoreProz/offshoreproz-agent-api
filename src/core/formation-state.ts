/**
 * Formation state machine — valid transitions.
 *
 * This module defines allowed status transitions and guards.
 * Any code that mutates formation status must go through this module to
 * prevent illegal state changes (e.g., complete → pending_owner_confirmation).
 *
 * Usage:
 *   import { canTransition, FORMATION_STATUS_TRANSITIONS } from '../core/formation-state.ts';
 *   if (!canTransition(currentStatus, nextStatus)) throw new Error(...);
 */

import type { FormationStatus } from "../types.ts";

/**
 * Allowed transitions from each status.
 * A status not in this map has NO valid transitions (terminal state).
 *
 * State diagram:
 *
 *   draft ──────────────────────────────────────────────────────────────────────────► cancelled
 *     │
 *     ▼
 *   pending_owner_confirmation ────────────────────────────────────────────────────► cancelled
 *     │
 *     ├──► action_required ◄──── (from any non-terminal) ──────────────────────────► cancelled
 *     │         │
 *     │         └──► pending_owner_confirmation (retry)
 *     │
 *     ▼
 *   portal_synced (Sprint 3)
 *     │
 *     ▼
 *   kyc_pending
 *     │
 *     ├──► kyc_review
 *     │       │
 *     │       └──► kyc_failed ──► action_required
 *     │
 *     └──► kyc_approved
 *               │
 *               ▼
 *           payment_pending ──► payment_authorized
 *                                       │
 *                                       ▼
 *                               signature_pending ──► filing_ready
 *                                                          │
 *                                                          ▼
 *                                                   filing_in_progress
 *                                                          │
 *                                                          ▼
 *                                                   registration_complete
 *                                                          │
 *                                                          ├──► ein_pending (WY only)
 *                                                          │         │
 *                                                          │         ▼
 *                                                          │     documents_ready
 *                                                          │         │
 *                                                          └─────────┴──► complete
 *
 *   Any state ──► failed (system error, non-recoverable)
 *   Post-charge (payment_authorized..filing_in_progress) ──► cancelled (admin refund)
 */
export const FORMATION_STATUS_TRANSITIONS: Partial<
  Record<FormationStatus, FormationStatus[]>
> = {
  draft: ["pending_owner_confirmation", "cancelled", "failed"],
  pending_owner_confirmation: [
    "portal_synced",
    "kyc_pending",
    "action_required",
    "cancelled",
    "failed",
  ],
  portal_synced: ["kyc_pending", "action_required", "failed"],
  kyc_pending: [
    "kyc_review",
    "kyc_approved",
    "kyc_failed",
    "action_required",
    "failed",
  ],
  kyc_review: ["kyc_approved", "kyc_failed", "action_required", "failed"],
  kyc_failed: ["action_required", "cancelled", "failed"],
  kyc_approved: ["payment_pending", "action_required", "failed"],
  payment_pending: ["payment_authorized", "action_required", "failed"],
  // Post-charge states allow → cancelled (admin refund path only). A refunded
  // formation is cancelled, with the Stripe refund issued before the transition.
  payment_authorized: ["signature_pending", "action_required", "cancelled", "failed"],
  signature_pending: ["filing_ready", "action_required", "cancelled", "failed"],
  filing_ready: ["filing_in_progress", "cancelled", "failed"],
  filing_in_progress: ["registration_complete", "action_required", "cancelled", "failed"],
  registration_complete: [
    "ein_pending",
    "documents_ready",
    "complete",
    "failed",
  ],
  ein_pending: ["documents_ready", "action_required", "failed"],
  documents_ready: ["complete", "failed"],
  action_required: ["pending_owner_confirmation", "cancelled", "failed"],
  // Terminal states: complete, cancelled, failed — no transitions out
};

/**
 * Check if a status transition is valid.
 * Returns true if from → to is in the allowed map.
 */
export function canTransition(
  from: FormationStatus,
  to: FormationStatus,
): boolean {
  const allowed = FORMATION_STATUS_TRANSITIONS[from];
  if (!allowed) return false; // terminal state
  return allowed.includes(to);
}

/**
 * Get valid next statuses from the given status.
 * Returns empty array for terminal states.
 */
export function getValidTransitions(from: FormationStatus): FormationStatus[] {
  return FORMATION_STATUS_TRANSITIONS[from] ?? [];
}

/**
 * Terminal statuses — no further transitions allowed.
 */
export const TERMINAL_STATUSES: FormationStatus[] = [
  "complete",
  "cancelled",
  "failed",
];

export function isTerminal(status: FormationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
