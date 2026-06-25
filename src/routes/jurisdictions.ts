/**
 * Jurisdiction routes — Sprint 1 (static data, no DB)
 *
 * GET /v1/jurisdictions
 *   List all jurisdictions with pricing and requirements.
 *   Query params:
 *     ?include_coming_soon=true  — include jurisdictions with status=coming_soon
 *
 * GET /v1/jurisdictions/:code
 *   Full detail for a single jurisdiction including required fields.
 *
 * GET /v1/jurisdictions/:code/requirements
 *   Only the required fields for a jurisdiction (used by MCP tools to build intake form).
 *
 * POST /v1/jurisdictions/:code/estimate
 *   Return cost estimate for a formation in this jurisdiction.
 *   Does NOT create any DB record (pure calculation).
 *   Returns an estimate_token valid for 30 minutes — required to create a formation.
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { AppType } from "../types.ts";
import { ok } from "../lib/response.ts";
import { errors } from "../lib/response.ts";
import {
  getJurisdiction,
  listJurisdictions,
  isValidCode,
} from "../config/jurisdictions.ts";

// ─── Estimate token cache (KV, 30 min TTL) ───────────────────────────────────

const ESTIMATE_TTL_SECONDS = 30 * 60; // 30 minutes

interface EstimateTokenPayload {
  jurisdiction: string;
  obtain_ein: boolean;
  total_usd: number; // USD cents
  breakdown: Array<{ item: string; amount_usd: number }>;
  expires_at: string;
  issued_at: string;
}

export function registerJurisdictionRoutes(app: Hono<AppType>): void {
  // GET /v1/jurisdictions
  app.get("/v1/jurisdictions", (c) => {
    const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
    const includeComingSoon = c.req.query("include_coming_soon") === "true";
    const jurisdictions = listJurisdictions(includeComingSoon);

    return ok(
      {
        jurisdictions: jurisdictions.map((j) => ({
          code: j.code,
          name: j.name,
          entity_type: j.entity_type,
          status: j.status,
          phase: j.phase,
          eta_days: j.eta_days,
          pricing_summary: {
            total_estimated_usd: j.pricing.total_estimated_usd / 100,
            annual_maintenance_usd: j.pricing.annual_maintenance_usd / 100,
            currency: "USD",
            note: j.pricing.note,
          },
          tax_treatment: j.tax_treatment,
          privacy_level: j.privacy_level,
          requires_physical_presence: j.requires_physical_presence,
          key_features: j.key_features,
          ideal_for: j.ideal_for,
        })),
        total: jurisdictions.length,
      },
      traceId,
    );
  });

  // GET /v1/jurisdictions/:code
  app.get("/v1/jurisdictions/:code", (c) => {
    const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
    const code = c.req.param("code").toUpperCase();
    const jurisdiction = getJurisdiction(code);

    if (!jurisdiction) {
      return errors.notFound(traceId);
    }

    return ok({ jurisdiction }, traceId);
  });

  // GET /v1/jurisdictions/:code/requirements
  app.get("/v1/jurisdictions/:code/requirements", (c) => {
    const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
    const code = c.req.param("code").toUpperCase();
    const jurisdiction = getJurisdiction(code);

    if (!jurisdiction) {
      return errors.notFound(traceId);
    }

    if (
      jurisdiction.status === "coming_soon" &&
      jurisdiction.phase === "future"
    ) {
      return errors.unprocessable(
        traceId,
        `${jurisdiction.name} is not yet available via API. Contact OffshoreProz for manual formation.`,
        "jurisdiction_not_available",
      );
    }

    return ok(
      {
        jurisdiction_code: jurisdiction.code,
        jurisdiction_name: jurisdiction.name,
        required_fields: jurisdiction.required_fields,
        legal_note: jurisdiction.legal_note,
      },
      traceId,
    );
  });

  // POST /v1/jurisdictions/:code/estimate
  const estimateSchema = z.object({
    obtain_ein: z.boolean().optional().default(true),
    members_count: z.number().int().min(1).max(50).optional().default(1),
    governance_model: z.enum(["on_chain", "hybrid", "traditional"]).optional(),
  });

  app.post("/v1/jurisdictions/:code/estimate", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? crypto.randomUUID();
    const code = c.req.param("code").toUpperCase();

    if (!isValidCode(code)) {
      return errors.notFound(traceId);
    }

    const jurisdiction = getJurisdiction(code)!;

    if (jurisdiction.status === "coming_soon") {
      return errors.unprocessable(
        traceId,
        `${jurisdiction.name} is not yet available for API formation. Use contact form for manual setup.`,
        "jurisdiction_not_available",
      );
    }

    let body: z.infer<typeof estimateSchema>;
    try {
      const raw = await c.req.json();
      body = estimateSchema.parse(raw);
    } catch {
      body = estimateSchema.parse({});
    }

    const p = jurisdiction.pricing;
    const breakdown: Array<{ item: string; amount_usd: number }> = [
      { item: "Government filing fee", amount_usd: p.government_fee_usd / 100 },
      {
        item: "Registered Agent (1 year)",
        amount_usd: p.registered_agent_fee_usd / 100,
      },
    ];

    let total = p.government_fee_usd + p.registered_agent_fee_usd;

    if (body.obtain_ein && p.ein_fee_usd !== null) {
      breakdown.push({
        item: "EIN (Federal Tax ID) service",
        amount_usd: p.ein_fee_usd / 100,
      });
      total += p.ein_fee_usd;
    }

    // OffshoreProz service fee — only set on jurisdictions with all-in pricing
    // (e.g. Wyoming $499 provisional). Undefined elsewhere, so skipped.
    if (p.service_fee_usd) {
      breakdown.push({
        item: "OffshoreProz service fee",
        amount_usd: p.service_fee_usd / 100,
      });
      total += p.service_fee_usd;
    }

    const expiresAt = new Date(
      Date.now() + ESTIMATE_TTL_SECONDS * 1000,
    ).toISOString();
    const issuedAt = new Date().toISOString();

    // Store token in KV for validation when create_formation is called
    const estimateToken = crypto.randomUUID();
    const payload: EstimateTokenPayload = {
      jurisdiction: code,
      obtain_ein: body.obtain_ein,
      total_usd: total,
      breakdown,
      expires_at: expiresAt,
      issued_at: issuedAt,
    };

    await c.env.KV.put(`estimate:${estimateToken}`, JSON.stringify(payload), {
      expirationTtl: ESTIMATE_TTL_SECONDS,
    });

    return ok(
      {
        estimate_token: estimateToken,
        jurisdiction_code: code,
        jurisdiction_name: jurisdiction.name,
        total_usd: total / 100,
        currency: "USD",
        breakdown,
        annual_maintenance_usd: p.annual_maintenance_usd / 100,
        eta_days: jurisdiction.eta_days,
        expires_at: expiresAt,
        issued_at: issuedAt,
        /**
         * IMPORTANT: Pass estimate_token when calling POST /v1/formations.
         * Estimate tokens are required to prevent accidental or unconfirmed formations.
         * Tokens expire in 30 minutes.
         */
        usage_note:
          "Include estimate_token in your POST /v1/formations request. Tokens expire in 30 minutes. Call this endpoint again to get a fresh token.",
        legal_note: jurisdiction.legal_note,
      },
      traceId,
    );
  });
}
