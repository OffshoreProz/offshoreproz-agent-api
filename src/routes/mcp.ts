/**
 * MCP Server — Sprint 8 (Model Context Protocol)
 *
 * Exposes the Agent API as MCP tools so LLMs (Claude, Cursor, VS Code Copilot)
 * can discover and call company-formation capabilities natively.
 *
 *   POST /mcp        JSON-RPC 2.0 over HTTP
 *   GET  /mcp        Discovery hint (human-readable)
 *
 * Methods: initialize · tools/list · tools/call
 *
 * Auth: Authorization: Bearer op_test_... (or X-API-Key). Read-only tools
 * (list/estimate) also work for discovery; create/status/documents require a
 * valid key. Consent gate: create_formation requires user_confirmed_cost_and_process
 * plus a recent estimate_token (mirrors REST safety).
 */

import type { Hono, Context } from "hono";
import type { AppType } from "../types.ts";
import { generateTraceId } from "../lib/crypto.ts";
import { validateApiKey } from "../lib/api-key.ts";
import { listJurisdictions, getJurisdiction } from "../config/jurisdictions.ts";
import { isLiveModeEnabled } from "../config/live-mode.ts";
import { resolveAccessToken, ACCESS_TOKEN_PREFIX } from "../lib/oauth.ts";

const PROTOCOL_VERSION = "2024-11-05";

// ─── Tool catalog ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "offshoreproz_list_jurisdictions",
    description:
      "List all available company-formation jurisdictions with pricing and timelines. No sensitive data. Call this first.",
    annotations: {
      title: "List Jurisdictions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        include_coming_soon: {
          type: "boolean",
          description: "When true, also returns jurisdictions that are not yet accepting formations (status: coming_soon). Defaults to false.",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        jurisdictions: {
          type: "array",
          description: "Array of available jurisdictions",
          items: {
            type: "object",
            properties: {
              code: { type: "string", description: "Short jurisdiction code (e.g. WY, MI)" },
              name: { type: "string", description: "Full jurisdiction name (e.g. Wyoming LLC)" },
              status: { type: "string", description: "live | coming_soon" },
              total_estimated_usd: { type: "number", description: "All-in estimated cost in USD" },
              eta_days: { type: "integer", description: "Estimated formation time in business days" },
            },
          },
        },
        count: { type: "integer", description: "Total number of jurisdictions returned" },
      },
      required: ["jurisdictions", "count"],
    },
  },
  {
    name: "offshoreproz_get_jurisdiction_requirements",
    description:
      "Return the required fields to form a company in a given jurisdiction.",
    annotations: {
      title: "Get Jurisdiction Requirements",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        jurisdiction_code: {
          type: "string",
          description: "Short jurisdiction code to look up (e.g. WY for Wyoming, MI for Marshall Islands). Use offshoreproz_list_jurisdictions to discover available codes.",
        },
      },
      required: ["jurisdiction_code"],
    },
    outputSchema: {
      type: "object",
      properties: {
        jurisdiction_code: { type: "string", description: "The jurisdiction code" },
        name: { type: "string", description: "Full jurisdiction name" },
        required_fields: {
          type: "array",
          items: { type: "string" },
          description: "List of field names required to create a formation in this jurisdiction",
        },
      },
      required: ["jurisdiction_code", "name", "required_fields"],
    },
  },
  {
    name: "offshoreproz_estimate_cost",
    description:
      "Estimate the all-in cost for a jurisdiction. MUST be called before create_formation; returns an estimate_token required to create.",
    annotations: {
      title: "Estimate Formation Cost",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        jurisdiction: {
          type: "string",
          description: "Jurisdiction code to estimate for (e.g. WY, MI). Case-insensitive.",
        },
        obtain_ein: {
          type: "boolean",
          description: "Whether to include EIN (Employer Identification Number) obtainment in the estimate. Adds ~$99 USD and 2-4 extra business days. Defaults to true.",
        },
      },
      required: ["jurisdiction"],
    },
    outputSchema: {
      type: "object",
      properties: {
        jurisdiction: { type: "string", description: "Jurisdiction code" },
        company_name: { type: "string" },
        items: {
          type: "array",
          description: "Itemized cost breakdown",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              amount_usd: { type: "number" },
            },
          },
        },
        total_usd: { type: "number", description: "Total all-in cost in USD" },
        estimate_token: { type: "string", description: "Short-lived token (est_*) required by offshoreproz_create_formation" },
        expires_at: { type: "string", description: "ISO 8601 expiry timestamp for the estimate_token (typically 15 minutes)" },
      },
      required: ["jurisdiction", "total_usd", "estimate_token", "expires_at"],
    },
  },
  {
    name: "offshoreproz_create_formation",
    description:
      "Start forming a company. beneficial_owner = human custodian (authorized representative). For AI-agent formations, also pass owner_type='ai_agent' and agent_context.agent_id. Requires estimate_token from offshoreproz_estimate_cost AND user_confirmed_cost_and_process=true (user must have seen cost, timeline, KYC, payment, signature steps, and the not-legal-advice notice).",
    annotations: {
      title: "Create Formation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        jurisdiction: {
          type: "string",
          description: "Jurisdiction code where the company will be formed (e.g. WY, MI). Case-insensitive.",
        },
        company_name: {
          type: "string",
          description: "Desired company name including entity suffix (e.g. 'Acme Trading LLC'). Availability is checked during formation.",
        },
        obtain_ein: {
          type: "boolean",
          description: "Whether to obtain an EIN (Employer Identification Number) from the IRS. Recommended for US banking. Adds ~$99 and 2-4 extra days.",
        },
        estimate_token: {
          type: "string",
          description: "Short-lived cost-estimate token (est_*) returned by offshoreproz_estimate_cost. Required to confirm the user has seen the pricing.",
        },
        user_confirmed_cost_and_process: {
          type: "boolean",
          description: "Must be true. Set this only after the user has explicitly acknowledged cost, timeline, KYC requirements, payment, DocuSeal signature, and the not-legal-advice notice.",
        },
        owner_type: {
          type: "string",
          enum: ["human", "ai_agent"],
          description: "human (default) or ai_agent. For AI-initiated formations, set ai_agent and populate agent_context.",
        },
        beneficial_owner: {
          type: "object",
          description: "Human custodian / authorized representative. Always a real person — subject to KYC and DocuSeal signing.",
          properties: {
            full_name: {
              type: "string",
              description: "Full legal name of the beneficial owner as it appears on government ID.",
            },
            email: {
              type: "string",
              description: "Email address for KYC verification link, DocuSeal signing invitation, and formation notifications.",
            },
            address: {
              type: "object",
              description: "Residential or business address of the beneficial owner.",
              properties: {
                street: { type: "string", description: "Street address including number and street name." },
                city: { type: "string", description: "City or municipality." },
                country: {
                  type: "string",
                  description: "ISO 3166-1 alpha-2 country code (e.g. BR, US, GB). Full names like 'Brasil' are also accepted and normalized.",
                },
              },
              required: ["street", "city", "country"],
            },
          },
          required: ["full_name", "email", "address"],
        },
        agent_context: {
          type: "object",
          description: "AI entity metadata. Required when owner_type='ai_agent'. agent_id uniquely identifies the AI agent initiating or owning this formation.",
          properties: {
            agent_id: { type: "string", description: "Unique identifier of the AI agent (e.g. claude-3-opus, gpt-4o, my-custom-agent-v1)" },
            agent_name: { type: "string", description: "Human-readable name of the AI agent." },
            agent_purpose: { type: "string", description: "Brief description of why this agent is forming the company." },
            platform: { type: "string", description: "Platform or orchestration system the agent runs on (e.g. Claude, OpenAI Assistants, LangChain)." },
          },
        },
      },
      required: [
        "jurisdiction",
        "company_name",
        "estimate_token",
        "user_confirmed_cost_and_process",
        "beneficial_owner",
      ],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Formation ID (op_fm_*)" },
        status: { type: "string", description: "Initial status — typically pending_owner_confirmation" },
        jurisdiction: { type: "string" },
        company_name: { type: "string" },
        action_url: { type: "string", description: "URL the beneficial owner must visit to complete KYC and sign documents" },
        action_expires_at: { type: "string", description: "ISO 8601 expiry for the action_url" },
        created_at: { type: "string" },
      },
      required: ["id", "status", "jurisdiction", "company_name"],
    },
  },
  {
    name: "offshoreproz_get_formation_status",
    description: "Get the current status and next action of a formation.",
    annotations: {
      title: "Get Formation Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        formation_id: {
          type: "string",
          description: "Formation ID to query (op_fm_* format). Returned by offshoreproz_create_formation or offshoreproz_list_formations.",
        },
      },
      required: ["formation_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Formation ID" },
        status: { type: "string", description: "Current status (e.g. pending_owner_confirmation, kyc_pending, filed, complete, failed)" },
        jurisdiction: { type: "string" },
        company_name: { type: "string" },
        obtain_ein: { type: "boolean" },
        next_action: { type: "string", description: "Human-readable description of the next required action, if any" },
        action_url: { type: "string", description: "URL for the next action step, if applicable" },
        created_at: { type: "string" },
        updated_at: { type: "string" },
      },
      required: ["id", "status", "jurisdiction", "company_name"],
    },
  },
  {
    name: "offshoreproz_list_documents",
    description: "List documents available for a formation.",
    annotations: {
      title: "List Formation Documents",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        formation_id: {
          type: "string",
          description: "Formation ID whose documents to list (op_fm_* format).",
        },
      },
      required: ["formation_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        documents: {
          type: "array",
          description: "List of documents associated with the formation",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string", description: "Document type (e.g. articles_of_incorporation, operating_agreement, ein_letter)" },
              name: { type: "string" },
              status: { type: "string", description: "Document status (e.g. pending, ready, signed)" },
              download_url: { type: "string", description: "Temporary signed URL to download the document" },
              created_at: { type: "string" },
            },
          },
        },
        count: { type: "integer" },
      },
      required: ["documents", "count"],
    },
  },
  {
    name: "offshoreproz_list_formations",
    description:
      "List all formations for the authenticated API key. Returns current status, jurisdiction, and next required actions.",
    annotations: {
      title: "List Formations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status (e.g. pending_owner_confirmation, kyc_pending, filed, complete, failed, cancelled)",
        },
        jurisdiction: {
          type: "string",
          description: "Filter by jurisdiction code (WY, MI, etc.)",
        },
        limit: {
          type: "integer",
          description: "Max results to return (default 20, max 100)",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        formations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              jurisdiction: { type: "string" },
              company_name: { type: "string" },
              next_action: { type: "string" },
              created_at: { type: "string" },
              updated_at: { type: "string" },
            },
          },
        },
        count: { type: "integer" },
        total: { type: "integer", description: "Total number of formations matching the filter (before limit)" },
      },
      required: ["formations", "count"],
    },
  },
  {
    name: "offshoreproz_cancel_formation",
    description:
      "Cancel a formation. Only possible from draft or pending_owner_confirmation status. Irreversible.",
    annotations: {
      title: "Cancel Formation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        formation_id: {
          type: "string",
          description: "Formation ID to cancel (op_fm_* format). The formation must be in draft or pending_owner_confirmation status.",
        },
      },
      required: ["formation_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", description: "Updated status — will be 'cancelled'" },
        cancelled_at: { type: "string" },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "offshoreproz_reissue_action_link",
    description:
      "Reissue an expired or lost action link for the current formation step. The old link is invalidated.",
    annotations: {
      title: "Reissue Action Link",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        formation_id: {
          type: "string",
          description: "Formation ID for which to reissue the action link (op_fm_* format). The previous link is immediately invalidated.",
        },
      },
      required: ["formation_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        formation_id: { type: "string" },
        action_url: { type: "string", description: "New action URL replacing the expired one. Send this to the beneficial owner." },
        action_expires_at: { type: "string", description: "ISO 8601 expiry for the new action_url" },
      },
      required: ["formation_id", "action_url", "action_expires_at"],
    },
  },
  {
    name: "offshoreproz_register",
    description:
      "Create a free test API key instantly — no portal login required. Returns op_test_* key you can use immediately in this session. For production (op_live_*), complete email OTP verification via the portal. Call this first if you have no API key yet.",
    annotations: {
      title: "Register (Get API Key)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label for this key (e.g. 'my-agent-v1'). Helps identify it in the portal." },
        email: { type: "string", description: "Email address — used for formation notifications and live key OTP verification." },
      },
      required: ["name", "email"],
    },
    outputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Test API key in op_test_* format. Use as Bearer token in Authorization header." },
        key_id: { type: "string" },
        mode: { type: "string", description: "Always 'test' for keys created here" },
        name: { type: "string" },
        created_at: { type: "string" },
        note: { type: "string", description: "Reminder that this is a sandbox key and formations are never filed" },
      },
      required: ["key", "mode", "name"],
    },
  },
  {
    name: "offshoreproz_get_formation_events",
    description:
      "Return the full audit trail / event log for a formation. Shows every status change, portal sync, webhooks, and notes. Useful for debugging or understanding where a formation is in the pipeline.",
    annotations: {
      title: "Get Formation Events",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        formation_id: {
          type: "string",
          description: "Formation ID whose audit trail to retrieve (op_fm_* format).",
        },
        limit: {
          type: "integer",
          description: "Max events to return (default 50, max 500). Events are ordered newest-first.",
        },
      },
      required: ["formation_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          description: "Audit trail events, newest first",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string", description: "Event type (e.g. formation.created, status.changed, webhook.delivered)" },
              note: { type: "string", description: "Human-readable description of what happened" },
              old_status: { type: "string" },
              new_status: { type: "string" },
              created_at: { type: "string" },
            },
          },
        },
        count: { type: "integer" },
        formation_id: { type: "string" },
      },
      required: ["events", "count", "formation_id"],
    },
  },
  {
    name: "offshoreproz_retry_formation",
    description:
      "Retry a formation that is in 'failed' or 'action_required' status. Resets it to pending_owner_confirmation so the owner can restart the confirmation flow.",
    annotations: {
      title: "Retry Formation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        formation_id: {
          type: "string",
          description: "Formation ID to retry (op_fm_* format). Must be in 'failed' or 'action_required' status.",
        },
      },
      required: ["formation_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", description: "New status after retry — typically pending_owner_confirmation" },
        action_url: { type: "string", description: "Fresh action URL for the beneficial owner to restart the flow" },
        action_expires_at: { type: "string" },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "offshoreproz_register_webhook",
    description:
      "Register a webhook URL to receive real-time formation events (formation.created, formation.status_changed, formation.complete, etc.). Returns a signing secret (whsec_*) — store it to verify incoming payloads. Use '*' to receive all events.",
    annotations: {
      title: "Register Webhook",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL that will receive POST requests for subscribed events." },
        events: {
          type: "array",
          items: { type: "string" },
          description: "Event patterns to subscribe to. Use '*' for all events, 'formation.*' for all formation events, or specific types like 'formation.complete' or 'formation.status_changed'.",
        },
        description: { type: "string", description: "Optional human-readable label for this webhook endpoint (e.g. 'Production webhook')." },
      },
      required: ["url", "events"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Webhook endpoint ID (whep_*)" },
        url: { type: "string" },
        events: { type: "array", items: { type: "string" } },
        signing_secret: { type: "string", description: "HMAC signing secret (whsec_*). Store securely — shown only once. Use to verify X-OffshoreProz-Signature header." },
        created_at: { type: "string" },
        note: { type: "string" },
      },
      required: ["id", "url", "events", "signing_secret"],
    },
  },
  {
    name: "offshoreproz_list_webhooks",
    description:
      "List all registered webhook endpoints for the authenticated API key, including their event subscriptions and recent delivery stats.",
    annotations: {
      title: "List Webhooks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: {
      type: "object",
      properties: {
        webhooks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              url: { type: "string" },
              events: { type: "array", items: { type: "string" } },
              description: { type: "string" },
              created_at: { type: "string" },
            },
          },
        },
        count: { type: "integer" },
      },
      required: ["webhooks", "count"],
    },
  },
] as const;

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────────

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function toolText(obj: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    isError,
  };
}

// ─── Tool execution ────────────────────────────────────────────────────────────

async function callTool(
  c: Context<AppType>,
  app: Hono<AppType>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const auth = c.req.header("Authorization") ?? "";
  // Internal in-process dispatch — avoids a network hop to our own hostname
  // (a Worker fetching its own custom domain triggers Cloudflare 522).
  const internal = (path: string, init: RequestInit) =>
    app.request(path, init, c.env, c.executionCtx);
  // Public tools (no key required).
  if (name === "offshoreproz_list_jurisdictions") {
    const list = listJurisdictions(Boolean(args.include_coming_soon)).map(
      (j) => ({
        code: j.code,
        name: j.name,
        status: j.status,
        total_estimated_usd: j.pricing.total_estimated_usd / 100,
        eta_days: j.eta_days,
      }),
    );
    return toolText({ jurisdictions: list, count: list.length });
  }

  if (name === "offshoreproz_get_jurisdiction_requirements") {
    const j = getJurisdiction(String(args.jurisdiction_code));
    if (!j) return toolText({ error: "jurisdiction_not_found" }, true);
    return toolText({
      jurisdiction_code: j.code,
      name: j.name,
      required_fields: j.required_fields,
    });
  }

  if (name === "offshoreproz_estimate_cost") {
    const res = await internal(
      `/v1/jurisdictions/${String(args.jurisdiction).toLowerCase()}/estimate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          company_name: "Estimate Only LLC",
          obtain_ein: args.obtain_ein !== false,
        }),
      },
    );
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_create_formation") {
    if (args.user_confirmed_cost_and_process !== true) {
      return toolText(
        {
          error: "consent_required",
          message:
            "Set user_confirmed_cost_and_process=true only after the user has seen cost, timeline, KYC, payment, signature, and the not-legal-advice notice.",
        },
        true,
      );
    }
    const owner = (args.beneficial_owner ?? {}) as Record<string, unknown>;
    const res = await internal(`/v1/formations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
        "Idempotency-Key": `mcp_${generateTraceId()}`,
      },
      body: JSON.stringify({
        jurisdiction: String(args.jurisdiction).toUpperCase(),
        company_name: args.company_name,
        obtain_ein: args.obtain_ein !== false,
        estimate_token: args.estimate_token,
        user_confirmed_cost_and_process: true, // consent already verified above
        beneficial_owner: owner,
        owner_type: args.owner_type ?? "human",
        agent_context: args.agent_context,
      }),
    });
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_get_formation_status") {
    const res = await internal(`/v1/formations/${String(args.formation_id)}`, {
      method: "GET",
      headers: { Authorization: auth },
    });
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_list_documents") {
    const res = await internal(
      `/v1/formations/${String(args.formation_id)}/documents`,
      { method: "GET", headers: { Authorization: auth } },
    );
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_list_formations") {
    const qs = new URLSearchParams();
    if (args.status) qs.set("status", String(args.status));
    if (args.jurisdiction) qs.set("jurisdiction", String(args.jurisdiction));
    if (args.limit) qs.set("limit", String(args.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    const res = await internal(`/v1/formations${query}`, {
      method: "GET",
      headers: { Authorization: auth },
    });
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_cancel_formation") {
    const res = await internal(
      `/v1/formations/${String(args.formation_id)}`,
      { method: "DELETE", headers: { Authorization: auth } },
    );
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_reissue_action_link") {
    const res = await internal(
      `/v1/formations/${String(args.formation_id)}/actions/reissue`,
      { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: "{}" },
    );
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_register") {
    const res = await internal("/v1/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "test",
        name: args.name,
        email: args.email,
      }),
    });
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText({
      ...(json.data as Record<string, unknown>),
      note: "This is a test key (op_test_*). Formations created with it are sandboxed and never filed. To get a live key, complete OTP verification via the portal.",
    });
  }

  if (name === "offshoreproz_get_formation_events") {
    const limit = args.limit ? `?limit=${String(args.limit)}` : "";
    const res = await internal(
      `/v1/formations/${String(args.formation_id)}/events${limit}`,
      { method: "GET", headers: { Authorization: auth } },
    );
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_retry_formation") {
    const res = await internal(
      `/v1/formations/${String(args.formation_id)}/retry`,
      {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  if (name === "offshoreproz_register_webhook") {
    const res = await internal("/v1/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        url: args.url,
        events: args.events,
        description: args.description,
      }),
    });
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText({
      ...(json.data as Record<string, unknown>),
      note: "Store the signing_secret (whsec_*) — it will not be shown again. Use it to verify the X-OffshoreProz-Signature header on incoming events.",
    });
  }

  if (name === "offshoreproz_list_webhooks") {
    const res = await internal("/v1/webhooks", {
      method: "GET",
      headers: { Authorization: auth },
    });
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (!res.ok) return toolText(json, true);
    return toolText(json.data);
  }

  return toolText({ error: "unknown_tool", tool: name }, true);
}

// ─── Route ─────────────────────────────────────────────────────────────────────

export function registerMcpRoutes(app: Hono<AppType>): void {
  // Discovery hint for humans hitting /mcp in a browser.
  app.get("/mcp", (c) =>
    c.json({
      name: "offshoreproz",
      description: "OffshoreProz Agent API — MCP server for company formation. 14 tools covering self-registration, jurisdictions, formations, documents, webhooks, and audit logs.",
      protocol: "Model Context Protocol (JSON-RPC 2.0)",
      transport: "POST /mcp",
      methods: ["initialize", "tools/list", "tools/call"],
      tools: TOOLS.map((t) => t.name),
      docs: "https://docs.offshoreproz.com/api/mcp",
    }),
  );

  app.post("/mcp", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    } | null;

    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return c.json(rpcError(body?.id ?? null, -32600, "Invalid Request"));
    }

    const { id, method, params } = body;

    if (method === "initialize") {
      return c.json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "offshoreproz-agent-api", version: "1.0.0" },
        }),
      );
    }

    if (method === "notifications/initialized") {
      // Notification — no response body expected.
      return c.body(null, 204);
    }

    if (method === "tools/list") {
      return c.json(rpcResult(id, { tools: TOOLS }));
    }

    if (method === "tools/call") {
      const toolName = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      // Tools that touch customer data require a valid API key.
      // Public tools: jurisdiction info + estimate (read-only, no PII).
      const needsAuth = ![
        "offshoreproz_list_jurisdictions",
        "offshoreproz_get_jurisdiction_requirements",
        "offshoreproz_estimate_cost",
        "offshoreproz_register",
      ].includes(toolName);

      // KV rate limit on unauthenticated public tool calls: 10 req/min per IP.
      if (!needsAuth) {
        const xfwd = c.req.header("X-Forwarded-For");
        const ip: string =
          c.req.header("CF-Connecting-IP") ??
          (xfwd?.split(",")[0]?.trim()) ??
          "unknown";
        const rlKey = `mcp:rl:${ip}`;
        const raw = await c.env.KV.get(rlKey);
        const count = raw ? parseInt(raw, 10) : 0;
        if (count >= 10) {
          return c.json(
            rpcResult(id, toolText({
              error: "rate_limit_exceeded",
              message: "Too many requests. Limit: 10/min per IP for unauthenticated calls. Add an Authorization: Bearer op_test_... header to remove this limit.",
            }, true)),
          );
        }
        await c.env.KV.put(rlKey, String(count + 1), { expirationTtl: 60 });
      }

      if (needsAuth) {
        const header = c.req.header("Authorization") ?? "";
        const rawKey = header.startsWith("Bearer ")
          ? header.slice(7).trim()
          : (c.req.header("X-API-Key") ?? undefined);

        // Accept either an OAuth access token (remote connector) or a raw op_ key.
        let authed = false;
        if (rawKey?.startsWith(ACCESS_TOKEN_PREFIX)) {
          authed = (await resolveAccessToken(c.env.KV, rawKey)) !== null;
        } else {
          const auth = await validateApiKey(
            c.env.AGENT_DB,
            rawKey,
            isLiveModeEnabled(c.env),
          );
          authed = auth.ok;
        }

        if (!authed) {
          // 401 + WWW-Authenticate lets a native MCP client discover the OAuth
          // server and run the connect flow (no local mcp-remote bridge needed).
          const base = c.env.API_BASE_URL.replace(/\/$/, "");
          return c.json(
            rpcError(id, -32001, "authentication_required: connect via OAuth or send Authorization: Bearer op_test_..."),
            401,
            {
              "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            },
          );
        }
      }

      try {
        const result = await callTool(c, app, toolName, args);
        return c.json(rpcResult(id, result));
      } catch (err) {
        return c.json(
          rpcResult(
            id,
            toolText(
              {
                error: "tool_execution_failed",
                message: err instanceof Error ? err.message : String(err),
              },
              true,
            ),
          ),
        );
      }
    }

    return c.json(rpcError(id, -32601, `Method not found: ${method}`));
  });
}
