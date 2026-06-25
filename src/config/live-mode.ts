/**
 * Live-mode gate — single source of truth.
 *
 * `op_live_` keys (real charges + real filing) are honored ONLY when live mode
 * is explicitly enabled for this environment, via the per-environment Cloudflare
 * var `LIVE_MODE_ENABLED` ("true" | "false") declared in wrangler.jsonc.
 *
 * Fail-safe by design: ANY value other than the exact string "true" keeps live
 * mode DISABLED (closed gate), so a missing or mistyped var never opens it.
 *
 * Read by BOTH the REST auth middleware (middleware/auth.ts) and the MCP route
 * (routes/mcp.ts) so the gate can never be half-open (REST live but MCP blocked,
 * or vice-versa). Flipping `LIVE_MODE_ENABLED` to "true" in the production env is
 * the FINAL step of the live gate (see plano-final/14-LIVE-GATE-CHECKLIST.md) —
 * no redeploy of code required, just a var change.
 */
export interface LiveModeEnv {
  LIVE_MODE_ENABLED?: string;
}

/** True only when this environment has explicitly opted into live mode. */
export function isLiveModeEnabled(env: LiveModeEnv): boolean {
  return env.LIVE_MODE_ENABLED === "true";
}
