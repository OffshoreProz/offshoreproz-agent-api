/**
 * P0 money-safety / compliance guards (go-live gate).
 *
 * Covers the three production blockers fixed before live charges:
 *  - T1: Stripe Idempotency-Key on Checkout + Identity (no double charge)
 *  - T2: refund helper is idempotent and throws on error (no false "refunded"),
 *        and the state machine permits refund → cancelled from post-charge states
 *  - T3: OFAC screen reports `error` on failure so the live path fails CLOSED
 *
 * These mock global fetch — no network, no DB, no worker bindings needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  initiateCheckoutSession,
  initiateKycSession,
  refundPayment,
} from "../src/lib/providers.ts";
import { screenOfac } from "../src/lib/ofac.ts";
import { canTransition } from "../src/core/formation-state.ts";

afterEach(() => vi.unstubAllGlobals());

/** Capture the headers of the single fetch call and return a canned JSON body. */
function stubFetchCapturing(body: unknown, status = 200): { headers: () => Headers } {
  let captured: Headers | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      captured = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return { headers: () => captured ?? new Headers() };
}

// ─── T1: Stripe idempotency (no double charge) ───────────────────────────────

describe("T1 — Stripe Idempotency-Key", () => {
  it("Checkout sends a stable key keyed on the formation id", async () => {
    const cap = stubFetchCapturing({ id: "cs_1", url: "https://pay", payment_intent: "pi_1" });
    const r = await initiateCheckoutSession(
      { STRIPE_SECRET_KEY: "sk_test_x" },
      "frm_abc",
      49900,
      "WY",
      "Acme LLC",
      "a@b.com",
      "https://ok",
      "https://cancel",
    );
    expect(cap.headers().get("Idempotency-Key")).toBe("checkout_frm_abc");
    expect(r.url).toBe("https://pay");
  });

  it("Identity (KYC) sends a stable key keyed on the formation id", async () => {
    const cap = stubFetchCapturing({ id: "vs_1", url: "https://verify" });
    const r = await initiateKycSession(
      { KYC_PROVIDER_KEY: "sk_test_x" },
      "frm_abc",
      "https://return",
    );
    expect(cap.headers().get("Idempotency-Key")).toBe("kyc_frm_abc");
    expect(r.url).toBe("https://verify");
  });
});

// ─── T2: refund safety + state machine ───────────────────────────────────────

describe("T2 — refund", () => {
  it("sends an Idempotency-Key keyed on the payment_intent", async () => {
    const cap = stubFetchCapturing({ id: "re_1", amount: 49900, status: "succeeded" });
    const r = await refundPayment({ STRIPE_SECRET_KEY: "sk_test_x" }, "pi_123");
    expect(cap.headers().get("Idempotency-Key")).toBe("refund_pi_123");
    expect(r.status).toBe("succeeded");
    expect(r.refund_id).toBe("re_1");
  });

  it("throws on Stripe error so the caller never marks a formation refunded", async () => {
    stubFetchCapturing({ error: { message: "charge already refunded" } }, 400);
    await expect(
      refundPayment({ STRIPE_SECRET_KEY: "sk_test_x" }, "pi_123"),
    ).rejects.toThrow(/already refunded/);
  });

  it("throws when there is no payment_intent to refund", async () => {
    await expect(
      refundPayment({ STRIPE_SECRET_KEY: "sk_test_x" }, ""),
    ).rejects.toThrow(/nothing to refund/);
  });

  it("state machine allows refund → cancelled from every post-charge state", () => {
    for (const s of [
      "payment_authorized",
      "signature_pending",
      "filing_ready",
      "filing_in_progress",
    ] as const) {
      expect(canTransition(s, "cancelled")).toBe(true);
    }
  });

  it("state machine still forbids cancelling a completed formation", () => {
    expect(canTransition("complete", "cancelled")).toBe(false);
  });
});

// ─── T3: OFAC fails closed ───────────────────────────────────────────────────

describe("T3 — OFAC screen surfaces failure (live path fails closed)", () => {
  it("reports error when the OFAC API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const r = await screenOfac("John Doe");
    expect(r.hit).toBe(false);
    expect(r.error).toMatch(/ofac_fetch_failed/);
  });

  it("reports error on a non-200 OFAC response", async () => {
    stubFetchCapturing("upstream error", 503);
    const r = await screenOfac("John Doe");
    expect(r.hit).toBe(false);
    expect(r.error).toBe("ofac_api_503");
  });

  it("returns a clean miss (no error) when the API responds with no matches", async () => {
    stubFetchCapturing({ results: [] }, 200);
    const r = await screenOfac("John Doe");
    expect(r.hit).toBe(false);
    expect(r.error).toBeUndefined();
  });
});
