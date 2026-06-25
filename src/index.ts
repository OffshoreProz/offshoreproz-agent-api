/**
 * OffshoreProz Agent API — Main Entry Point
 *
 * Worker: offshoreproz-agent-api
 * Domain: api.offshoreproz.com (production) | api-staging.offshoreproz.com (staging)
 * Account: OffshoreProz Account (see private wrangler.jsonc for the account ID)
 *
 * Sprint 1 — Worker Shell
 * Implemented endpoints:
 *   GET /health
 *   GET /openapi.json
 *   GET /v1/jurisdictions
 *   GET /v1/jurisdictions/:code
 *   GET /v1/jurisdictions/:code/requirements
 *   POST /v1/jurisdictions/:code/estimate
 *
 * Architecture:
 *   ┌────────────────────────────────────────────────────────┐
 *   │  Request                                               │
 *   │    │                                                   │
 *   │    ▼                                                   │
 *   │  [errorHandler]  — catch all unhandled exceptions      │
 *   │    │                                                   │
 *   │    ▼                                                   │
 *   │  [trace]         — assign trace_id, log entry/exit     │
 *   │    │                                                   │
 *   │    ▼                                                   │
 *   │  [cors]          — CORS headers + preflight            │
 *   │    │                                                   │
 *   │    ▼                                                   │
 *   │  Routes                                                │
 *   │    ├── /health         (public)                        │
 *   │    ├── /openapi.json   (public)                        │
 *   │    ├── /v1/jurisdictions (public)                      │
 *   │    └── 404 handler                                     │
 *   └────────────────────────────────────────────────────────┘
 *
 * @see the internal architecture docs (private)
 */

import { Hono } from "hono";
import type { AppType } from "./types.ts";
import { cors } from "./middleware/cors.ts";
import { errorHandler } from "./middleware/errors.ts";
import { trace } from "./middleware/trace.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerJurisdictionRoutes } from "./routes/jurisdictions.ts";
import { registerOpenApiRoutes } from "./routes/openapi.ts";
import { registerFormationRoutes } from "./routes/formations.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";
import { registerActionRoutes } from "./routes/actions.ts";
import { registerDocumentRoutes } from "./routes/documents.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerMcpRoutes } from "./routes/mcp.ts";
import { registerBetaRoutes } from "./routes/beta.ts";
import { registerKeyRoutes } from "./routes/keys.ts";
import { registerProviderWebhookRoutes } from "./routes/provider-webhooks.ts";
import { registerOAuthRoutes } from "./routes/oauth.ts";
import { errors } from "./lib/response.ts";

const app = new Hono<AppType>();

// ─── Middleware stack (order matters) ─────────────────────────────────────────
//
// 1. errorHandler — outermost catch, must be first
// 2. trace        — assign trace_id and log lifecycle
// 3. cors         — allow cross-origin requests + handle preflight

app.use("*", errorHandler);
app.use("*", trace);
app.use("*", cors);

// ─── Routes ───────────────────────────────────────────────────────────────────

registerOpenApiRoutes(app);
registerHealthRoutes(app);
registerJurisdictionRoutes(app);
registerFormationRoutes(app);
registerWebhookRoutes(app);
registerActionRoutes(app);
registerDocumentRoutes(app);
registerAdminRoutes(app);
registerMcpRoutes(app);
registerBetaRoutes(app);
registerKeyRoutes(app);
registerProviderWebhookRoutes(app);
registerOAuthRoutes(app);

// ─── 404 handler ──────────────────────────────────────────────────────────────

app.notFound((c) => {
  const traceId =
    (c.get("trace_id") as string | undefined) ?? crypto.randomUUID();
  return errors.notFound(traceId);
});

// ─── Export ───────────────────────────────────────────────────────────────────
//
// Cloudflare Workers expects a default export with a `fetch` handler.
// Hono's `fetch` satisfies this interface directly.

export default app;
