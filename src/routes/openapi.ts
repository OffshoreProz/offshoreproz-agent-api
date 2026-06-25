/**
 * GET /openapi.json — OpenAPI 3.1 specification for the Agent API.
 *
 * Covers all live endpoints as of 2026-06-18:
 *   Jurisdictions, Formations, Actions, Documents, Webhooks (outbound + inbound),
 *   Keys (self-serve), Admin, MCP, Beta, Health.
 *
 * Used for: SDK generation, Postman/Bruno collections, developer docs, MCP discovery.
 */

import type { Hono } from "hono";
import type { AppType } from "../types.ts";

// ─── Reusable schema fragments ─────────────────────────────────────────────────

const ApiError = {
  type: "object",
  required: ["error", "code", "request_id"],
  properties: {
    error: { type: "string", description: "Human-readable error message" },
    code: { type: "string", description: "Machine-readable error code" },
    request_id: { type: "string", format: "uuid" },
    docs: { type: "string", format: "uri", description: "Link to error documentation" },
  },
};

const FormationStatus = {
  type: "string",
  enum: [
    "draft", "pending_owner_confirmation", "portal_synced",
    "kyc_pending", "kyc_review", "kyc_approved", "kyc_failed",
    "payment_pending", "payment_authorized",
    "signature_pending", "filing_ready", "filing_in_progress",
    "registration_complete", "ein_pending", "documents_ready",
    "complete", "action_required", "failed", "cancelled",
  ],
};

const JurisdictionCode = { type: "string", enum: ["WY", "MI", "NV", "BVI", "PA", "UAE"] };

const Formation = {
  type: "object",
  properties: {
    id: { type: "string" },
    mode: { type: "string", enum: ["test", "live"] },
    status: FormationStatus,
    jurisdiction: JurisdictionCode,
    company_name: { type: "string" },
    amount_total_usd: { type: "integer", description: "Amount in USD cents" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time", nullable: true },
    completed_at: { type: "string", format: "date-time", nullable: true },
    next_actions: {
      type: "array",
      items: { type: "object", properties: { type: { type: "string" }, url: { type: "string" } } },
    },
  },
};

const ApiKey = {
  type: "object",
  properties: {
    id: { type: "string" },
    mode: { type: "string", enum: ["test", "live"] },
    name: { type: "string" },
    key: { type: "string", description: "Raw key — shown ONCE at creation only" },
    tier: { type: "string", enum: ["standard", "premium"] },
    created_at: { type: "string", format: "date-time" },
    last_used_at: { type: "string", format: "date-time", nullable: true },
    revoked_at: { type: "string", format: "date-time", nullable: true },
  },
};

function resp(description: string, schema?: Record<string, unknown>) {
  if (!schema) return { description };
  return { description, content: { "application/json": { schema } } };
}

function dataResp(description: string, dataSchema: Record<string, unknown>) {
  return resp(description, {
    type: "object",
    properties: {
      data: dataSchema,
      request_id: { type: "string" },
    },
  });
}

const err401 = resp("Unauthorized — invalid or missing API key", ApiError);
const err403 = resp("Forbidden — operation not permitted for this key", ApiError);
const err404 = resp("Not found", ApiError);
const err422 = resp("Unprocessable — validation or state machine error", ApiError);
const err429 = resp("Rate limit exceeded", ApiError);

// ─── Path parameter shared ────────────────────────────────────────────────────

function pathParam(name: string, schema: Record<string, unknown> = { type: "string" }, description?: string) {
  return { name, in: "path", required: true, schema, ...(description ? { description } : {}) };
}

// ─── Route builder ─────────────────────────────────────────────────────────────

export function registerOpenApiRoutes(app: Hono<AppType>): void {
  app.get("/openapi.json", (c) => {
    const baseUrl = c.env.API_BASE_URL;
    const env = c.env.ENVIRONMENT;

    const spec = {
      openapi: "3.1.0",
      info: {
        title: "OffshoreProz Agent API",
        version: "1.0.0",
        description: [
          "REST + MCP API for agent-native company formation.",
          "",
          "**Authentication:** Include your API key as `Authorization: Bearer op_test_...` (sandbox) or `Authorization: Bearer op_live_...` (live).",
          "",
          "**Sandbox vs Live:** Sandbox keys (`op_test_`) simulate all providers — no charges, no real filings. Live keys (`op_live_`) trigger real Stripe / DocuSeal calls.",
          "",
          "**Consent gate:** Before creating a formation, call `POST /v1/jurisdictions/{code}/estimate` to get an `estimate_token`. Pass it with `user_confirmed_cost_and_process: true` in the create request.",
          "",
          "**MCP:** Claude and other LLMs can use this API via `POST /mcp` (JSON-RPC 2.0). See the MCP section for tool definitions.",
          "",
          "⚠️ This API automates operational processes. It does not provide legal, tax, or financial advice.",
        ].join("\n"),
        contact: { name: "OffshoreProz", url: "https://docs.offshoreproz.com/api", email: "api@offshoreproz.com" },
        license: { name: "Proprietary" },
      },
      servers: [
        { url: baseUrl, description: env === "production" ? "Production" : env === "staging" ? "Staging" : "Development" },
        { url: "https://api.offshoreproz.com", description: "Production" },
        { url: "https://api-staging.offshoreproz.com", description: "Staging" },
      ],
      security: [{ BearerAuth: [] }],
      tags: [
        { name: "System", description: "Health check and API metadata" },
        { name: "Keys", description: "Self-serve API key management" },
        { name: "Jurisdictions", description: "Available jurisdictions and pricing" },
        { name: "Formations", description: "Company formation lifecycle" },
        { name: "Actions", description: "Owner-facing action token confirmation (portal)" },
        { name: "Documents", description: "Formation document upload and download" },
        { name: "Webhooks", description: "Outbound webhook endpoint management" },
        { name: "Admin", description: "Ops/admin endpoints (ADMIN_API_TOKEN required)" },
        { name: "MCP", description: "Model Context Protocol server for AI agents" },
        { name: "Beta", description: "Beta waitlist" },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "op_test_<64hex> | op_live_<64hex>",
            description: "API key. Use `op_test_` for sandbox, `op_live_` for live. Obtain via POST /v1/keys.",
          },
          AdminToken: {
            type: "http",
            scheme: "bearer",
            description: "Admin API token (ADMIN_API_TOKEN env var). Not a customer API key.",
          },
        },
        schemas: {
          ApiError,
          FormationStatus,
          JurisdictionCode,
          Formation,
          ApiKey,
        },
      },
      paths: {

        // ── System ─────────────────────────────────────────────────────────

        "/health": {
          get: {
            operationId: "getHealth",
            summary: "Health check",
            tags: ["System"],
            security: [],
            responses: {
              "200": dataResp("Worker is healthy", {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["ok"] },
                  env: { type: "string" },
                  version: { type: "string" },
                  portal_db: {
                    type: "object",
                    properties: {
                      reachable: { type: "boolean" },
                      migration_082_applied: { type: "boolean" },
                      portal_sync_enabled: { type: "boolean" },
                    },
                  },
                },
              }),
            },
          },
        },

        // ── API Keys (B5) ──────────────────────────────────────────────────

        "/v1/keys": {
          post: {
            operationId: "createApiKey",
            summary: "Create API key",
            description: "**Test keys** are issued immediately. **Live keys** require email OTP verification (POST /v1/keys/verify) and a Stripe payment method on file. Rate-limited: 5 per hour per email, 10 per hour per IP.",
            tags: ["Keys"],
            security: [],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["mode", "name", "email"],
                    properties: {
                      mode: { type: "string", enum: ["test", "live"] },
                      name: { type: "string", description: "Human label for the key, e.g. 'My Agent'" },
                      email: { type: "string", format: "email", description: "Owner email. Used for OTP (live) and key lookup." },
                    },
                  },
                },
              },
            },
            responses: {
              "201": dataResp("Test key created immediately", {
                type: "object",
                properties: {
                  key: { type: "string", description: "Raw key — copy now, never shown again" },
                  id: { type: "string" },
                  mode: { type: "string", enum: ["test"] },
                  name: { type: "string" },
                },
              }),
              "202": dataResp("Live key: OTP sent — call POST /v1/keys/verify", {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["verification_required"] },
                  message: { type: "string" },
                  expires_in_seconds: { type: "integer" },
                },
              }),
              "400": resp("Validation error", ApiError),
              "429": err429,
            },
          },
          get: {
            operationId: "listApiKeys",
            summary: "List my API keys",
            description: "Lists all active (non-revoked) keys for the authenticated email.",
            tags: ["Keys"],
            responses: {
              "200": dataResp("Key list", {
                type: "object",
                properties: {
                  keys: { type: "array", items: ApiKey },
                },
              }),
              "401": err401,
            },
          },
        },

        "/v1/keys/verify": {
          post: {
            operationId: "verifyApiKey",
            summary: "Verify OTP and activate live key",
            description: "Complete live key creation. OTP is emailed at POST /v1/keys. Also checks that a Stripe payment method is on file (402 if not).",
            tags: ["Keys"],
            security: [],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["email", "otp"],
                    properties: {
                      email: { type: "string", format: "email" },
                      otp: { type: "string", description: "6-digit code from email" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": dataResp("Live key activated", {
                type: "object",
                properties: {
                  key: { type: "string", description: "Raw live key — copy now, never shown again" },
                  id: { type: "string" },
                  mode: { type: "string", enum: ["live"] },
                },
              }),
              "402": resp("Payment method required — add a card at https://docs.offshoreproz.com/billing", ApiError),
              "422": resp("Invalid OTP, expired, or too many attempts", ApiError),
              "429": err429,
            },
          },
        },

        "/v1/keys/{id}": {
          delete: {
            operationId: "revokeApiKey",
            summary: "Revoke API key",
            description: "Permanently revoke a key. Can only revoke keys belonging to the authenticated email.",
            tags: ["Keys"],
            parameters: [pathParam("id", { type: "string" }, "Key ID")],
            responses: {
              "200": dataResp("Key revoked", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
              "401": err401,
              "403": err403,
              "404": err404,
            },
          },
        },

        // ── Jurisdictions ──────────────────────────────────────────────────

        "/v1/jurisdictions": {
          get: {
            operationId: "listJurisdictions",
            summary: "List available jurisdictions",
            description: "Returns all jurisdictions with pricing, timelines, and requirements. Available: WY (available), MI (pilot). No authentication required.",
            tags: ["Jurisdictions"],
            security: [],
            parameters: [
              { name: "include_coming_soon", in: "query", schema: { type: "boolean", default: false } },
            ],
            responses: {
              "200": dataResp("Jurisdiction list", { type: "object", properties: { jurisdictions: { type: "array" } } }),
            },
          },
        },

        "/v1/jurisdictions/{code}": {
          get: {
            operationId: "getJurisdiction",
            summary: "Get jurisdiction details",
            tags: ["Jurisdictions"],
            security: [],
            parameters: [pathParam("code", JurisdictionCode)],
            responses: { "200": resp("Jurisdiction detail"), "404": err404 },
          },
        },

        "/v1/jurisdictions/{code}/requirements": {
          get: {
            operationId: "getJurisdictionRequirements",
            summary: "Required fields for a jurisdiction",
            tags: ["Jurisdictions"],
            security: [],
            parameters: [pathParam("code", JurisdictionCode)],
            responses: { "200": resp("Required fields list"), "404": err404 },
          },
        },

        "/v1/jurisdictions/{code}/estimate": {
          post: {
            operationId: "estimateCost",
            summary: "Estimate formation cost",
            description: "Returns all-in cost breakdown and an `estimate_token` (30-minute TTL). **Required** before calling POST /v1/formations.",
            tags: ["Jurisdictions"],
            security: [],
            parameters: [pathParam("code", JurisdictionCode)],
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { obtain_ein: { type: "boolean" } } },
                },
              },
            },
            responses: {
              "200": dataResp("Cost estimate + token", {
                type: "object",
                properties: {
                  estimate_token: { type: "string", description: "Pass to POST /v1/formations; expires in 30 min" },
                  total_usd: { type: "number" },
                  breakdown: { type: "object" },
                  valid_for_seconds: { type: "integer", default: 1800 },
                },
              }),
              "404": err404,
              "422": err422,
            },
          },
        },

        // ── Formations ─────────────────────────────────────────────────────

        "/v1/formations": {
          post: {
            operationId: "createFormation",
            summary: "Create formation",
            description: "Start a company formation. Requires `estimate_token` from POST /v1/jurisdictions/{code}/estimate and explicit cost confirmation. Sandbox: simulates all providers. Live: triggers real Stripe/DocuSeal flows.",
            tags: ["Formations"],
            parameters: [
              { name: "Idempotency-Key", in: "header", schema: { type: "string" }, description: "Idempotency key — safe to retry" },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jurisdiction", "company_name", "estimate_token", "user_confirmed_cost_and_process", "beneficial_owner"],
                    properties: {
                      jurisdiction: JurisdictionCode,
                      company_name: { type: "string" },
                      company_purpose: { type: "string" },
                      estimate_token: { type: "string", description: "Token from POST /estimate (30min TTL)" },
                      user_confirmed_cost_and_process: { type: "boolean", enum: [true], description: "Must be true — consent gate" },
                      obtain_ein: { type: "boolean", description: "WY only" },
                      governance_model: { type: "string", enum: ["on_chain", "hybrid", "traditional"], description: "MI only" },
                      smart_contract_address: { type: "string", description: "MI only (optional)" },
                      blockchain_network: { type: "string", description: "MI only (optional)" },
                      beneficial_owner: {
                        type: "object",
                        required: ["full_name", "email", "address"],
                        properties: {
                          full_name: { type: "string" },
                          email: { type: "string", format: "email" },
                          phone: { type: "string" },
                          address: { type: "string" },
                          id_document_type: { type: "string", enum: ["passport", "drivers_license", "national_id"] },
                          ownership_percentage: { type: "number", description: "MI only — percentage of governance (25%+ triggers KYC)" },
                        },
                      },
                    },
                  },
                },
              },
            },
            responses: {
              "201": dataResp("Formation created", Formation),
              "400": resp("Validation error", ApiError),
              "401": err401,
              "403": resp("Live mode not enabled or key mode mismatch", ApiError),
              "409": resp("Idempotency key conflict", ApiError),
              "422": err422,
            },
          },
          get: {
            operationId: "listFormations",
            summary: "List formations",
            description: "Lists formations associated with the authenticated API key.",
            tags: ["Formations"],
            parameters: [
              { name: "status", in: "query", schema: FormationStatus },
              { name: "jurisdiction", in: "query", schema: JurisdictionCode },
              { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
              { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            ],
            responses: {
              "200": dataResp("Formation list", {
                type: "object",
                properties: { formations: { type: "array", items: Formation }, total: { type: "integer" } },
              }),
              "401": err401,
            },
          },
        },

        "/v1/formations/{id}": {
          get: {
            operationId: "getFormation",
            summary: "Get formation status",
            description: "Returns current status, next required actions, and provider details.",
            tags: ["Formations"],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Formation detail", Formation),
              "401": err401,
              "404": err404,
            },
          },
        },

        "/v1/formations/{id}/retry": {
          post: {
            operationId: "retryFormation",
            summary: "Retry failed formation",
            description: "Resets a failed or action_required formation back to pending_owner_confirmation.",
            tags: ["Formations"],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Retry initiated", Formation),
              "401": err401,
              "404": err404,
              "422": err422,
            },
          },
        },

        "/v1/formations/{id}/events": {
          get: {
            operationId: "listFormationEvents",
            summary: "Formation audit trail",
            description: "Full audit trail — status changes, provider events, token actions, webhook deliveries.",
            tags: ["Formations"],
            parameters: [
              pathParam("id"),
              { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
            ],
            responses: {
              "200": dataResp("Event list", {
                type: "object",
                properties: {
                  formation_id: { type: "string" },
                  events: { type: "array", items: { type: "object" } },
                  count: { type: "integer" },
                },
              }),
              "401": err401,
              "404": err404,
            },
          },
        },

        "/v1/formations/{id}/actions/reissue": {
          post: {
            operationId: "reissueActionLink",
            summary: "Reissue action link",
            description: "Reissue a fresh link for the current step (e.g. expired or lost). Invalidates the outstanding link for that step.",
            tags: ["Formations"],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("New action link", {
                type: "object",
                properties: {
                  formation_id: { type: "string" },
                  action_url: { type: "string", format: "uri" },
                  expires_at: { type: "string", format: "date-time" },
                  purpose: { type: "string" },
                },
              }),
              "401": err401,
              "404": err404,
              "422": err422,
            },
          },
        },

        "/v1/formations/{id}/cancel": {
          delete: {
            operationId: "cancelFormation",
            summary: "Cancel formation",
            description: "Cancel a formation. Only possible from draft or pending_owner_confirmation.",
            tags: ["Formations"],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Formation cancelled", Formation),
              "401": err401,
              "404": err404,
              "422": err422,
            },
          },
        },

        // ── Actions (owner token flow) ─────────────────────────────────────

        "/v1/actions/{token}": {
          get: {
            operationId: "getAction",
            summary: "Inspect action token",
            description: "Returns the purpose, label, expiry, and formation summary for an action token. Used by the portal page to render the owner confirmation UI.",
            tags: ["Actions"],
            security: [],
            parameters: [pathParam("token", { type: "string" }, "act_... token from action email")],
            responses: {
              "200": dataResp("Action token info", {
                type: "object",
                properties: {
                  purpose: { type: "string", enum: ["owner_confirmation", "kyc", "payment", "signature"] },
                  label: { type: "string" },
                  expires_at: { type: "string", format: "date-time" },
                  formation: Formation,
                },
              }),
              "422": resp("Token not found, expired, or already used", ApiError),
            },
          },
        },

        "/v1/actions/{token}/confirm": {
          post: {
            operationId: "confirmAction",
            summary: "Confirm action / advance formation",
            description: "Owner confirms the action. **Sandbox:** simulates provider immediately, returns next action. **Live:** initiates real provider (Stripe Identity/Checkout/DocuSeal) and returns redirect URL. Owner completes at the provider, then webhook advances the status automatically.",
            tags: ["Actions"],
            security: [],
            parameters: [pathParam("token", { type: "string" })],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      email: { type: "string", format: "email", description: "Required for payment (Stripe pre-fill) and signature (DocuSeal)" },
                      name: { type: "string", description: "Required for signature step (DocuSeal)" },
                    },
                  },
                },
              },
            },
            responses: {
              "200": dataResp("Step completed (sandbox) or already completed", {
                type: "object",
                properties: {
                  formation_id: { type: "string" },
                  status: FormationStatus,
                  next_action: {
                    type: "object",
                    nullable: true,
                    properties: { type: { type: "string" }, url: { type: "string", format: "uri" }, expires_at: { type: "string" } },
                  },
                },
              }),
              "202": dataResp("Live provider initiated — redirect owner to redirect_url", {
                type: "object",
                properties: {
                  formation_id: { type: "string" },
                  status: FormationStatus,
                  redirect_url: { type: "string", format: "uri" },
                  redirect_note: { type: "string" },
                  pilot_review: { type: "boolean", description: "true for MI — formation parked for ops review" },
                },
              }),
              "422": resp("Token invalid/expired/consumed, or formation not in expected status", ApiError),
            },
          },
        },

        // ── Documents ──────────────────────────────────────────────────────

        "/v1/formations/{id}/documents": {
          post: {
            operationId: "uploadDocument",
            summary: "Upload document",
            description: "Upload a document for a formation. Stored in R2 under `agent-api/formations/{id}/`.",
            tags: ["Documents"],
            parameters: [pathParam("id")],
            requestBody: {
              required: true,
              content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" }, type: { type: "string" } } } } },
            },
            responses: {
              "201": dataResp("Document uploaded", { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, size: { type: "integer" } } }),
              "401": err401,
              "404": err404,
            },
          },
          get: {
            operationId: "listDocuments",
            summary: "List formation documents",
            tags: ["Documents"],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Document list", { type: "object", properties: { documents: { type: "array" } } }),
              "401": err401,
              "404": err404,
            },
          },
        },

        "/v1/documents/{id}": {
          get: {
            operationId: "getDocument",
            summary: "Get document metadata + download URL",
            description: "Returns document metadata and a short-lived (5 min) signed download URL.",
            tags: ["Documents"],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Document info + download_url", { type: "object", properties: { id: { type: "string" }, download_url: { type: "string", format: "uri" }, expires_at: { type: "string" } } }),
              "401": err401,
              "404": err404,
            },
          },
        },

        "/v1/documents/{id}/download": {
          get: {
            operationId: "downloadDocument",
            summary: "Stream document bytes",
            description: "Streams the document from R2. Authenticated via short-lived `?token=` query param from GET /v1/documents/{id}.",
            tags: ["Documents"],
            security: [],
            parameters: [
              pathParam("id"),
              { name: "token", in: "query", required: true, schema: { type: "string" }, description: "Short-lived KV token from GET /v1/documents/{id}" },
            ],
            responses: {
              "200": { description: "Document bytes", content: { "application/octet-stream": {} } },
              "401": err401,
              "404": err404,
            },
          },
        },

        // ── Webhooks (outbound, customer-managed) ──────────────────────────

        "/v1/webhooks": {
          post: {
            operationId: "createWebhook",
            summary: "Register webhook endpoint",
            description: "Register a URL to receive formation events. Returns a `webhook_secret` (whsec_...) for signature verification. Events: formation.created, formation.status_changed, formation.complete, formation.pilot_review_pending.",
            tags: ["Webhooks"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["url"],
                    properties: {
                      url: { type: "string", format: "uri" },
                      description: { type: "string" },
                      events: { type: "array", items: { type: "string" }, description: "Omit for all events" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": dataResp("Webhook created", {
                type: "object",
                properties: {
                  id: { type: "string" },
                  url: { type: "string" },
                  webhook_secret: { type: "string", description: "whsec_... — used to verify signatures. Shown ONCE." },
                },
              }),
              "401": err401,
            },
          },
          get: {
            operationId: "listWebhooks",
            summary: "List webhook endpoints",
            tags: ["Webhooks"],
            responses: {
              "200": dataResp("Webhook list", { type: "object", properties: { webhooks: { type: "array" } } }),
              "401": err401,
            },
          },
        },

        "/v1/webhooks/{id}": {
          get: {
            operationId: "getWebhook",
            summary: "Get webhook endpoint",
            tags: ["Webhooks"],
            parameters: [pathParam("id")],
            responses: { "200": resp("Webhook detail"), "401": err401, "404": err404 },
          },
          delete: {
            operationId: "deleteWebhook",
            summary: "Deactivate webhook endpoint",
            tags: ["Webhooks"],
            parameters: [pathParam("id")],
            responses: { "200": resp("Webhook deactivated"), "401": err401, "404": err404 },
          },
        },

        "/v1/webhooks/{id}/deliveries": {
          get: {
            operationId: "listWebhookDeliveries",
            summary: "Recent delivery attempts",
            description: "Returns last 50 delivery attempts for a webhook endpoint, including status codes and error messages.",
            tags: ["Webhooks"],
            parameters: [pathParam("id")],
            responses: { "200": resp("Delivery log"), "401": err401, "404": err404 },
          },
        },

        // ── Inbound provider webhooks ─────────────────────────────────────

        "/webhooks/stripe": {
          post: {
            operationId: "stripeWebhook",
            summary: "Stripe inbound webhook",
            description: "Receives Stripe events (`identity.verification_session.verified`, `identity.verification_session.requires_input`, `checkout.session.completed`). Signature-verified via `Stripe-Signature` header. Always returns 200 — processing is async.",
            tags: ["Webhooks"],
            security: [],
            responses: { "200": resp("Acknowledged") },
          },
        },

        "/webhooks/docseal": {
          post: {
            operationId: "docsealWebhook",
            summary: "DocuSeal inbound webhook",
            description: "Receives DocuSeal `form.completed` events. Signature-verified via `X-Docuseal-Signature` header. Always returns 200 — processing is async.",
            tags: ["Webhooks"],
            security: [],
            responses: { "200": resp("Acknowledged") },
          },
        },

        // ── Admin ──────────────────────────────────────────────────────────

        "/v1/admin/formations": {
          get: {
            operationId: "adminListFormations",
            summary: "List formations (admin)",
            description: "List all formations with optional filters. Requires ADMIN_API_TOKEN.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [
              { name: "jurisdiction", in: "query", schema: JurisdictionCode },
              { name: "status", in: "query", schema: FormationStatus },
              { name: "mode", in: "query", schema: { type: "string", enum: ["test", "live"] } },
              { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
              { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            ],
            responses: { "200": resp("Formation list"), "401": err401 },
          },
        },

        "/v1/admin/formations/{id}": {
          get: {
            operationId: "adminGetFormation",
            summary: "Get formation detail (admin)",
            description: "Full formation detail including event history. Requires ADMIN_API_TOKEN.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [pathParam("id")],
            responses: { "200": resp("Formation + event history"), "401": err401, "404": err404 },
          },
        },

        "/v1/admin/formations/{id}/pilot/approve": {
          post: {
            operationId: "adminPilotApprove",
            summary: "Approve MI pilot review",
            description: "Advance a formation from `action_required` (pilot review gate) to `kyc_pending`. Mints a KYC action token and emails the link to the owner.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Formation advanced to kyc_pending", {
                type: "object",
                properties: {
                  formation_id: { type: "string" },
                  status: { type: "string", enum: ["kyc_pending"] },
                  kyc_action_url: { type: "string", format: "uri" },
                  kyc_token_expires_at: { type: "string", format: "date-time" },
                },
              }),
              "401": err401,
              "404": err404,
              "422": err422,
            },
          },
        },

        "/v1/admin/formations/{id}/pilot/reject": {
          post: {
            operationId: "adminPilotReject",
            summary: "Reject MI pilot review",
            description: "Set a formation from `action_required` to `failed` with a reason.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [pathParam("id")],
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { reason: { type: "string", default: "rejected_by_ops" } } },
                },
              },
            },
            responses: {
              "200": dataResp("Formation failed", { type: "object", properties: { formation_id: { type: "string" }, status: { type: "string" }, reason: { type: "string" } } }),
              "401": err401,
              "404": err404,
              "422": err422,
            },
          },
        },

        "/v1/admin/formations/{id}/filing/start": {
          post: {
            operationId: "adminFilingStart",
            summary: "Start filing (ops hand-off)",
            description: "Advance formation from `filing_ready` to `filing_in_progress`. Called by ops when they begin the state filing.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [pathParam("id")],
            responses: { "200": resp("Filing started"), "401": err401, "404": err404, "422": err422 },
          },
        },

        "/v1/admin/formations/{id}/filing/complete": {
          post: {
            operationId: "adminFilingComplete",
            summary: "Complete filing",
            description: "Walk the formation from `filing_in_progress` through `registration_complete → ein_pending → documents_ready → complete`. Emails the owner a registration completion notice.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [pathParam("id")],
            responses: {
              "200": dataResp("Filing complete", {
                type: "object",
                properties: { formation_id: { type: "string" }, status: { type: "string", enum: ["complete"] }, filing_reference: { type: "string" } },
              }),
              "401": err401,
              "404": err404,
              "422": err422,
            },
          },
        },

        "/v1/admin/keys": {
          get: {
            operationId: "adminListKeys",
            summary: "List all API keys (admin)",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [
              { name: "email", in: "query", schema: { type: "string" } },
              { name: "mode", in: "query", schema: { type: "string", enum: ["test", "live"] } },
              { name: "include_revoked", in: "query", schema: { type: "boolean", default: false } },
              { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
              { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            ],
            responses: { "200": dataResp("Key list", { type: "object", properties: { keys: { type: "array" }, total: { type: "integer" } } }), "401": err401 },
          },
        },

        "/v1/admin/keys/{id}/revoke": {
          post: {
            operationId: "adminRevokeKey",
            summary: "Force-revoke API key (admin)",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            parameters: [pathParam("id")],
            responses: { "200": resp("Key revoked"), "401": err401, "404": err404 },
          },
        },

        "/v1/admin/stats": {
          get: {
            operationId: "adminStats",
            summary: "Aggregate stats (admin)",
            description: "Formation counts by status and jurisdiction, key stats, and pilot review queue depth.",
            tags: ["Admin"],
            security: [{ AdminToken: [] }],
            responses: {
              "200": dataResp("Stats", {
                type: "object",
                properties: {
                  formations: { type: "object", properties: { by_status: { type: "array" }, by_jurisdiction: { type: "array" } } },
                  api_keys: { type: "object", properties: { total: { type: "integer" }, live: { type: "integer" }, test: { type: "integer" }, revoked: { type: "integer" } } },
                  pilot_review_queue: { type: "integer", description: "Live formations waiting for ops review (action_required)" },
                },
              }),
              "401": err401,
            },
          },
        },

        // ── MCP ────────────────────────────────────────────────────────────

        "/mcp": {
          get: {
            operationId: "mcpDiscovery",
            summary: "MCP discovery hint",
            description: "Human-readable page describing the MCP server. For programmatic access, use POST /mcp.",
            tags: ["MCP"],
            security: [],
            responses: { "200": { description: "HTML page" } },
          },
          post: {
            operationId: "mcpRpc",
            summary: "MCP JSON-RPC 2.0 server",
            description: [
              "Model Context Protocol server for AI agents (Claude, GPT-4, etc.).",
              "",
              "**Available tools:**",
              "- `offshoreproz_list_jurisdictions` — list available jurisdictions",
              "- `offshoreproz_get_jurisdiction_requirements` — required fields for a jurisdiction",
              "- `offshoreproz_estimate_cost` — estimate all-in cost + issue estimate_token",
              "- `offshoreproz_create_formation` — create company (requires estimate_token + API key)",
              "- `offshoreproz_get_formation_status` — get current status (requires API key)",
              "- `offshoreproz_list_documents` — list formation documents (requires API key)",
            ].join("\n"),
            tags: ["MCP"],
            security: [],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jsonrpc", "method", "id"],
                    properties: {
                      jsonrpc: { type: "string", enum: ["2.0"] },
                      method: { type: "string", enum: ["tools/list", "tools/call"] },
                      id: { type: ["string", "integer", "null"] },
                      params: {
                        type: "object",
                        properties: {
                          name: { type: "string", description: "Tool name (for tools/call)" },
                          arguments: { type: "object", description: "Tool input arguments" },
                        },
                      },
                    },
                  },
                },
              },
            },
            responses: {
              "200": { description: "JSON-RPC 2.0 response (result or error)" },
            },
          },
        },

        // ── Beta ───────────────────────────────────────────────────────────

        "/v1/beta/waitlist": {
          post: {
            operationId: "joinWaitlist",
            summary: "Join beta waitlist",
            description: "Request API access. Idempotent on email — safe to re-submit.",
            tags: ["Beta"],
            security: [],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["email", "name", "use_case"],
                    properties: {
                      email: { type: "string", format: "email" },
                      name: { type: "string" },
                      use_case: { type: "string", description: "What you'll build with the API" },
                      company: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": resp("Added to waitlist"),
              "200": resp("Already on waitlist"),
              "429": err429,
            },
          },
        },
      },
    };

    return new Response(JSON.stringify(spec, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "X-Request-Id": (c.get("trace_id") as string | undefined) ?? crypto.randomUUID(),
      },
    });
  });

  // Filtered spec for GPT Actions — excludes /admin/* paths and AdminToken security scheme.
  app.get("/openapi-gpt-actions.json", (c) => {
    const baseUrl = c.env.API_BASE_URL;
    const env = c.env.ENVIRONMENT;

    const spec = {
      openapi: "3.1.0",
      info: {
        title: "OffshoreProz Agent API",
        version: "1.0.0",
        description: [
          "REST + MCP API for agent-native company formation.",
          "",
          "**Authentication:** `Authorization: Bearer op_test_...` (sandbox) or `Authorization: Bearer op_live_...` (live).",
          "",
          "**Consent gate:** Call `POST /v1/jurisdictions/{code}/estimate` first to get an `estimate_token`. Pass it with `user_confirmed_cost_and_process: true` in the create request.",
          "",
          "⚠️ This API automates operational processes. It does not provide legal, tax, or financial advice.",
        ].join("\n"),
        contact: { name: "OffshoreProz", url: "https://docs.offshoreproz.com/api", email: "api@offshoreproz.com" },
        license: { name: "Proprietary" },
      },
      servers: [
        { url: "https://api.offshoreproz.com", description: "Production" },
        { url: baseUrl, description: env === "staging" ? "Staging" : "Development" },
      ],
      security: [{ BearerAuth: [] }],
      tags: [
        { name: "Jurisdictions", description: "Available jurisdictions and pricing" },
        { name: "Formations", description: "Company formation lifecycle" },
        { name: "Documents", description: "Formation document management" },
        { name: "Keys", description: "Self-serve API key management" },
        { name: "Webhooks", description: "Outbound webhook management" },
        { name: "MCP", description: "Model Context Protocol server for AI agents" },
        { name: "Beta", description: "Beta waitlist" },
        { name: "System", description: "Health check" },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "op_test_<64hex> | op_live_<64hex>",
            description: "API key. Use op_test_ for sandbox, op_live_ for live. Obtain via POST /v1/keys.",
          },
        },
        schemas: { ApiError, FormationStatus, JurisdictionCode, Formation, ApiKey },
      },
      paths: Object.fromEntries(
        Object.entries(((): Record<string, unknown> => {
          // Build the full paths object then filter admin routes.
          // This references the same spec object built in /openapi.json above.
          // We rebuild inline to avoid a shared-mutable reference.
          const fullSpec = JSON.parse(
            JSON.stringify({
              "/v1/jurisdictions": { get: { operationId: "listJurisdictions", summary: "List jurisdictions", tags: ["Jurisdictions"], security: [], parameters: [{ name: "include_coming_soon", in: "query", schema: { type: "boolean" } }], responses: { "200": dataResp("Jurisdiction list", { type: "object" }) } } },
              "/v1/jurisdictions/{code}": { get: { operationId: "getJurisdiction", summary: "Get jurisdiction", tags: ["Jurisdictions"], security: [], parameters: [pathParam("code", JurisdictionCode)], responses: { "200": resp("Detail"), "404": err404 } } },
              "/v1/jurisdictions/{code}/requirements": { get: { operationId: "getJurisdictionRequirements", summary: "Required fields", tags: ["Jurisdictions"], security: [], parameters: [pathParam("code", JurisdictionCode)], responses: { "200": resp("Fields") } } },
              "/v1/jurisdictions/{code}/estimate": { post: { operationId: "estimateCost", summary: "Estimate cost", description: "Returns all-in cost and an estimate_token (30-min TTL) required for POST /v1/formations.", tags: ["Jurisdictions"], security: [], parameters: [pathParam("code", JurisdictionCode)], requestBody: { content: { "application/json": { schema: { type: "object", properties: { obtain_ein: { type: "boolean" } } } } } }, responses: { "200": dataResp("Estimate + token", { type: "object", properties: { estimate_token: { type: "string" }, total_usd: { type: "number" }, valid_for_seconds: { type: "integer" } } }) } } },
              "/v1/formations": {
                post: { operationId: "createFormation", summary: "Create formation", tags: ["Formations"], parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["jurisdiction", "company_name", "estimate_token", "user_confirmed_cost_and_process", "beneficial_owner"], properties: { jurisdiction: JurisdictionCode, company_name: { type: "string" }, estimate_token: { type: "string" }, user_confirmed_cost_and_process: { type: "boolean", enum: [true] }, obtain_ein: { type: "boolean" }, owner_type: { type: "string", enum: ["human", "ai_agent"], description: "ai_agent for AI-initiated formations; beneficial_owner is always the human custodian" }, beneficial_owner: { type: "object", required: ["full_name", "email", "address"], properties: { full_name: { type: "string" }, email: { type: "string", format: "email" }, phone: { type: "string" }, address: { type: "object" } } }, agent_context: { type: "object", description: "AI entity metadata", properties: { agent_id: { type: "string" }, agent_name: { type: "string" }, agent_purpose: { type: "string" }, platform: { type: "string" } } } } } } } }, responses: { "201": dataResp("Formation created", Formation), "401": err401, "422": err422 } },
                get: { operationId: "listFormations", summary: "List formations", tags: ["Formations"], parameters: [{ name: "status", in: "query", schema: FormationStatus }, { name: "jurisdiction", in: "query", schema: JurisdictionCode }, { name: "limit", in: "query", schema: { type: "integer", default: 20 } }], responses: { "200": dataResp("Formation list", { type: "object" }), "401": err401 } },
              },
              "/v1/formations/{id}": { get: { operationId: "getFormation", summary: "Get formation", tags: ["Formations"], parameters: [pathParam("id")], responses: { "200": dataResp("Formation", Formation), "401": err401, "404": err404 } } },
              "/v1/formations/{id}/actions/reissue": { post: { operationId: "reissueActionLink", summary: "Reissue action link", tags: ["Formations"], parameters: [pathParam("id")], responses: { "200": dataResp("New link", { type: "object" }), "401": err401, "404": err404 } } },
              "/v1/formations/{id}/cancel": { delete: { operationId: "cancelFormation", summary: "Cancel formation", tags: ["Formations"], parameters: [pathParam("id")], responses: { "200": dataResp("Cancelled", Formation), "401": err401, "404": err404 } } },
              "/v1/formations/{id}/documents": { get: { operationId: "listDocuments", summary: "List documents", tags: ["Documents"], parameters: [pathParam("id")], responses: { "200": dataResp("Documents", { type: "object" }), "401": err401 } }, post: { operationId: "uploadDocument", summary: "Upload document", tags: ["Documents"], parameters: [pathParam("id")], requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } } }, responses: { "201": dataResp("Uploaded", { type: "object" }), "401": err401 } } },
              "/v1/keys": { post: { operationId: "createApiKey", summary: "Create API key", tags: ["Keys"], security: [], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["mode", "name", "email"], properties: { mode: { type: "string", enum: ["test", "live"] }, name: { type: "string" }, email: { type: "string", format: "email" } } } } } }, responses: { "201": dataResp("Test key created", { type: "object" }), "202": dataResp("Live key: OTP sent", { type: "object" }) } } },
              "/v1/webhooks": { post: { operationId: "createWebhook", summary: "Register webhook", tags: ["Webhooks"], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string" } } } } } } }, responses: { "201": dataResp("Webhook created", { type: "object" }), "401": err401 } } },
              "/mcp": { post: { operationId: "mcpRpc", summary: "MCP JSON-RPC 2.0", description: "Model Context Protocol endpoint. Tools: list_jurisdictions, estimate_cost, create_formation, get_formation_status, list_formations, list_documents, cancel_formation, reissue_action_link.", tags: ["MCP"], security: [], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["jsonrpc", "method", "id"], properties: { jsonrpc: { type: "string", enum: ["2.0"] }, method: { type: "string" }, id: { type: ["string", "integer"] }, params: { type: "object" } } } } } }, responses: { "200": { description: "JSON-RPC 2.0 response" } } } },
              "/v1/beta/waitlist": { post: { operationId: "joinWaitlist", summary: "Join beta waitlist", tags: ["Beta"], security: [], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "name", "use_case"], properties: { email: { type: "string", format: "email" }, name: { type: "string" }, use_case: { type: "string" } } } } } }, responses: { "201": resp("Added to waitlist") } } },
              "/health": { get: { operationId: "getHealth", summary: "Health check", tags: ["System"], security: [], responses: { "200": resp("ok") } } },
            })
          ) as Record<string, unknown>;
          return fullSpec;
        })()).filter(([path]) => !path.startsWith("/v1/admin"))
      ),
    };

    return new Response(JSON.stringify(spec, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "X-Request-Id": (c.get("trace_id") as string | undefined) ?? crypto.randomUUID(),
      },
    });
  });
}
