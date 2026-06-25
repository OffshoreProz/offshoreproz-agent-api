/**
 * OAuth 2.1 helpers — storage + PKCE for the MCP remote connector.
 *
 * Covers the security-load-bearing pieces:
 *  - PKCE S256 verification (RFC 7636 Appendix B test vector)
 *  - auth codes are single-use
 *  - access tokens resolve to the bound api_key_id (and only with the right prefix)
 *  - refresh tokens rotate (single-use)
 *  - dynamic client registration round-trips
 *
 * Uses an in-memory KV mock — no worker bindings needed.
 */

import { describe, it, expect } from "vitest";
import {
  registerClient,
  getClient,
  issueAuthCode,
  consumeAuthCode,
  issueTokens,
  resolveAccessToken,
  consumeRefreshToken,
  verifyPkceS256,
} from "../src/lib/oauth.ts";

function mockKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v);
    },
    delete: async (k: string) => {
      m.delete(k);
    },
  } as unknown as KVNamespace;
}

// RFC 7636 Appendix B test vector.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE S256", () => {
  it("accepts the RFC 7636 verifier/challenge pair", async () => {
    expect(await verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });
  it("rejects a wrong verifier", async () => {
    expect(await verifyPkceS256("not-the-verifier", RFC_CHALLENGE)).toBe(false);
  });
});

describe("authorization codes", () => {
  it("are single-use", async () => {
    const kv = mockKV();
    const code = await issueAuthCode(kv, {
      api_key_id: "key_1",
      client_id: "opzc_x",
      redirect_uri: "https://app/cb",
      code_challenge: RFC_CHALLENGE,
    });
    const first = await consumeAuthCode(kv, code);
    expect(first?.api_key_id).toBe("key_1");
    const second = await consumeAuthCode(kv, code);
    expect(second).toBeNull();
  });

  it("returns null for an unknown code", async () => {
    expect(await consumeAuthCode(mockKV(), "opzac_nope")).toBeNull();
  });
});

describe("access tokens", () => {
  it("resolve to the bound api_key_id", async () => {
    const kv = mockKV();
    const { access_token } = await issueTokens(kv, "key_42");
    expect(access_token.startsWith("opz_at_")).toBe(true);
    expect(await resolveAccessToken(kv, access_token)).toBe("key_42");
  });
  it("reject a token without the opz_at_ prefix", async () => {
    expect(await resolveAccessToken(mockKV(), "op_test_abc")).toBeNull();
  });
});

describe("refresh tokens", () => {
  it("rotate (single-use)", async () => {
    const kv = mockKV();
    const { refresh_token } = await issueTokens(kv, "key_7");
    expect(await consumeRefreshToken(kv, refresh_token)).toBe("key_7");
    expect(await consumeRefreshToken(kv, refresh_token)).toBeNull();
  });
});

describe("dynamic client registration", () => {
  it("round-trips client_id + redirect_uris", async () => {
    const kv = mockKV();
    const client = await registerClient(kv, ["https://claude.ai/cb"], "Claude");
    expect(client.client_id.startsWith("opzc_")).toBe(true);
    const fetched = await getClient(kv, client.client_id);
    expect(fetched?.redirect_uris).toEqual(["https://claude.ai/cb"]);
    expect(fetched?.client_name).toBe("Claude");
  });
});
