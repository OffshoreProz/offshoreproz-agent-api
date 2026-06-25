/**
 * Tests for GET /health and GET /openapi.json
 *
 * These run inside the actual Workers runtime via @cloudflare/vitest-pool-workers.
 * That catches edge-only issues that Node.js-based tests miss.
 *
 * Sprint 1 coverage:
 *  - GET /health → 200, correct fields
 *  - GET /openapi.json → 200, valid JSON with correct schema
 *  - GET /unknown → 404 with standard error envelope
 *  - OPTIONS preflight → 204 with CORS headers
 *  - CORS headers present on all responses
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index.ts";

// Minimal Env for test environment
const testEnv: typeof env = {
  ...env,
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  API_BASE_URL: "http://localhost:8787",
  PORTAL_URL: "https://docs.offshoreproz.com",
  PORTAL_DOCS_DB_ACCOUNT_ID: "test-account-id-0000000000000000",
  API_KEY_ENCRYPTION_SECRET: "a".repeat(64),
};

function request(
  path: string,
  method = "GET",
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:8787${path}`, {
    method,
    headers: { Origin: "https://example.com", ...headers },
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with correct structure", async () => {
    const res = await app.fetch(request("/health"), testEnv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        status: string;
        env: string;
        version: string;
        service: string;
        timestamp: string;
      };
      request_id: string;
    };
    expect(body.data.status).toBe("ok");
    expect(body.data.service).toBe("offshoreproz-agent-api");
    expect(body.data.env).toBe("development");
    expect(body.data.version).toBe("v1");
    expect(typeof body.data.timestamp).toBe("string");
    expect(typeof body.request_id).toBe("string");
  });

  it("includes X-Request-Id header", async () => {
    const res = await app.fetch(request("/health"), testEnv);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("includes Content-Type: application/json", async () => {
    const res = await app.fetch(request("/health"), testEnv);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe("CORS", () => {
  it("handles OPTIONS preflight with 204", async () => {
    const res = await app.fetch(request("/health", "OPTIONS"), testEnv);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("adds CORS headers to regular requests", async () => {
    const res = await app.fetch(request("/health"), testEnv);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

describe("404 handler", () => {
  it("returns 404 with standard error envelope for unknown routes", async () => {
    const res = await app.fetch(request("/v1/this-does-not-exist"), testEnv);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { code: string; request_id: string };
    expect(body.code).toBe("not_found");
    expect(typeof body.request_id).toBe("string");
  });
});

// ─── OpenAPI ──────────────────────────────────────────────────────────────────

describe("GET /openapi.json", () => {
  it("returns 200 with valid JSON", async () => {
    const res = await app.fetch(request("/openapi.json"), testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const spec = (await res.json()) as {
      openapi: string;
      info: { title: string };
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe("OffshoreProz Agent API");
  });
});

// ─── Jurisdictions (static data) ─────────────────────────────────────────────

describe("GET /v1/jurisdictions", () => {
  it("returns list with at least WY and MI", async () => {
    const res = await app.fetch(request("/v1/jurisdictions"), testEnv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { jurisdictions: Array<{ code: string }> };
    };
    const codes = body.data.jurisdictions.map((j) => j.code);
    expect(codes).toContain("WY");
    expect(codes).toContain("MI");
  });

  it("each jurisdiction has required fields", async () => {
    const res = await app.fetch(request("/v1/jurisdictions"), testEnv);
    const body = (await res.json()) as {
      data: {
        jurisdictions: Array<{
          code: string;
          status: string;
          eta_days: { min: number; max: number };
          pricing_summary: { total_estimated_usd: number };
        }>;
      };
    };

    for (const j of body.data.jurisdictions) {
      expect(typeof j.code).toBe("string");
      expect(typeof j.status).toBe("string");
      expect(typeof j.eta_days.min).toBe("number");
      expect(typeof j.eta_days.max).toBe("number");
      expect(typeof j.pricing_summary.total_estimated_usd).toBe("number");
    }
  });
});

describe("GET /v1/jurisdictions/:code", () => {
  it("returns WY details", async () => {
    const res = await app.fetch(request("/v1/jurisdictions/WY"), testEnv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { jurisdiction: { code: string } };
    };
    expect(body.data.jurisdiction.code).toBe("WY");
  });

  it("returns 404 for unknown code", async () => {
    const res = await app.fetch(request("/v1/jurisdictions/XX"), testEnv);
    expect(res.status).toBe(404);
  });

  it("is case-insensitive (wy → WY)", async () => {
    const res = await app.fetch(request("/v1/jurisdictions/wy"), testEnv);
    expect(res.status).toBe(200);
  });
});
