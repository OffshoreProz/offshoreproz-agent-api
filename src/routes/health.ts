/**
 * GET /health
 *
 * Public endpoint — no authentication required.
 * Returns current operational status of the Worker.
 *
 * Used by:
 *  - Cloudflare health checks
 *  - Uptime monitoring
 *  - CI/CD smoke tests post-deploy
 *  - Developer verification that the Worker is reachable
 *
 * Response is intentionally minimal — does not expose internal state.
 */

import type { Hono } from "hono";
import type { AppType } from "../types.ts";
import { ok } from "../lib/response.ts";
import { portalDb } from "../lib/portal-db.ts";

interface HealthResponse {
  status: "ok";
  env: string;
  version: string;
  service: string;
  timestamp: string;
  portal_db: {
    reachable: boolean;
    migration_082_applied: boolean;
    portal_sync_enabled: boolean;
  };
}

export function registerHealthRoutes(app: Hono<AppType>): void {
  app.get("/health", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
    const pdbHealth = await portalDb(c).healthCheck();
    const data: HealthResponse = {
      status: "ok",
      env: c.env.ENVIRONMENT,
      version: c.env.API_VERSION,
      service: "offshoreproz-agent-api",
      timestamp: new Date().toISOString(),
      portal_db: pdbHealth,
    };
    return ok(data, traceId);
  });
}
