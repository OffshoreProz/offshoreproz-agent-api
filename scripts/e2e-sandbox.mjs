#!/usr/bin/env node
/**
 * E2E sandbox lifecycle test for the Agent API.
 *
 * Runs against staging (or a custom BASE_URL) using only test-mode API keys.
 * No real charges, no real filings. Validates the full formation flow:
 *
 *   1. Create test key  (POST /v1/keys)
 *   2. List jurisdictions
 *   3. Get WY requirements
 *   4. Estimate cost → get estimate_token
 *   5. Create WY LLC formation
 *   6. Idempotency replay (same Idempotency-Key)
 *   7. List formations → find the new one
 *   8. Get formation status → verify next_action
 *   9. Get action token info (GET /v1/actions/:token)
 *  10. Confirm action (POST /v1/actions/:token/confirm) → sandbox advances state
 *  11. Get formation status after confirm → verify advanced
 *  12. List events → verify audit trail
 *  13. List documents (should be empty at this stage)
 *  14. Cancel a second formation (tests cancel path)
 *  15. TOS gate: user_confirmed_cost_and_process=false → 400
 *  16. MCP: tools/list, estimate, list_formations, get_formation_status
 *  17. Revoke test key via a spare key
 *
 * Exit code: 0 = all passed, 1 = failures found.
 *
 * Usage:
 *   node scripts/e2e-sandbox.mjs
 *   BASE_URL=https://api-staging.offshoreproz.com node scripts/e2e-sandbox.mjs
 */

const BASE_URL = process.env.BASE_URL ?? "https://api-staging.offshoreproz.com";

// ─── Tiny test harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function req(method, path, { body, key, idempotencyKey } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

function randomName() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `E2E Test LLC ${suffix}`;
}

async function getEstimate() {
  const r = await req("POST", "/v1/jurisdictions/WY/estimate", { body: { obtain_ein: false } });
  return r.body?.data?.estimate_token ?? null;
}

// ─── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n🧪 Agent API E2E Sandbox — ${BASE_URL}\n`);

  // ── STEP 1: Health ──────────────────────────────────────────────────────────
  console.log("STEP 1 — Health check");
  {
    const r = await req("GET", "/health");
    assert("HTTP 200", r.status === 200, `got ${r.status}`);
    assert("status: ok", r.body?.data?.status === "ok");
    assert("env present", !!r.body?.data?.env);
  }

  // ── STEP 2: Create test API key ─────────────────────────────────────────────
  console.log("\nSTEP 2 — Create test key");
  let testKey;
  let testKeyId;
  {
    const r = await req("POST", "/v1/keys", {
      body: { mode: "test", name: "E2E Test Key", email: "e2e-test@offshoreproz.com" },
    });
    assert("HTTP 201", r.status === 201, `got ${r.status}`);
    assert("key starts with op_test_", r.body?.data?.key?.startsWith("op_test_"));
    testKey = r.body?.data?.key;
    testKeyId = r.body?.data?.id;
    assert("key id present", !!testKeyId);
  }

  if (!testKey) {
    console.error("\n💥 Cannot continue without a test key\n");
    process.exit(1);
  }

  // ── STEP 3: List jurisdictions ──────────────────────────────────────────────
  console.log("\nSTEP 3 — List jurisdictions");
  {
    const r = await req("GET", "/v1/jurisdictions");
    assert("HTTP 200", r.status === 200, `got ${r.status}`);
    const juris = r.body?.data?.jurisdictions ?? [];
    assert("jurisdictions array", Array.isArray(juris));
    const wy = juris.find((j) => j.code === "WY");
    assert("WY present and available", wy?.status === "available");
  }

  // ── STEP 4: Get WY requirements ────────────────────────────────────────────
  console.log("\nSTEP 4 — WY requirements");
  {
    const r = await req("GET", "/v1/jurisdictions/WY/requirements");
    assert("HTTP 200", r.status === 200, `got ${r.status}`);
    const fields = r.body?.data?.required_fields ?? r.body?.required_fields;
    assert("required_fields present", Array.isArray(fields));
  }

  // ── STEP 5: Estimate cost ───────────────────────────────────────────────────
  console.log("\nSTEP 5 — Estimate cost");
  let estimateToken;
  {
    const r = await req("POST", "/v1/jurisdictions/WY/estimate", {
      body: { obtain_ein: true },
    });
    assert("HTTP 200", r.status === 200, `got ${r.status}`);
    assert("estimate_token present", !!r.body?.data?.estimate_token);
    assert("total_usd present", typeof r.body?.data?.total_usd === "number");
    estimateToken = r.body?.data?.estimate_token;
  }

  if (!estimateToken) {
    console.error("\n💥 Cannot continue without estimate_token\n");
    process.exit(1);
  }

  // ── STEP 6: Create formation ────────────────────────────────────────────────
  console.log("\nSTEP 6 — Create formation");
  let formationId;
  let idempotencyKey;
  let actionTokenFromCreate;
  const companyName = randomName();
  {
    idempotencyKey = `e2e-test-${Date.now()}`;
    const r = await req("POST", "/v1/formations", {
      key: testKey,
      idempotencyKey,
      body: {
        jurisdiction: "WY",
        company_name: companyName,
        estimate_token: estimateToken,
        user_confirmed_cost_and_process: true,
        beneficial_owner: {
          full_name: "Alice Testowner",
          email: "alice@example.com",
          address: { street: "123 Test St", city: "Cheyenne", country: "US" },
        },
      },
    });
    assert("HTTP 201", r.status === 201, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    // Response uses formation_id (not id) in POST response
    formationId = r.body?.data?.formation_id;
    assert("formation_id present", !!formationId, `data keys: ${Object.keys(r.body?.data ?? {}).join(", ")}`);
    assert("status pending_owner_confirmation", r.body?.data?.status === "pending_owner_confirmation");
    const nextActions = r.body?.data?.next_actions ?? [];
    assert("next_actions present", Array.isArray(nextActions) && nextActions.length > 0);
    // Extract action token from POST response (most reliable — token is freshly minted)
    const firstUrl = nextActions[0]?.url ?? "";
    const mCreate = firstUrl.match(/\/(act_[a-f0-9]+)/);
    actionTokenFromCreate = mCreate?.[1] ?? null;
  }

  // ── STEP 7: Idempotency replay ──────────────────────────────────────────────
  console.log("\nSTEP 7 — Idempotency replay");
  {
    const r = await req("POST", "/v1/formations", {
      key: testKey,
      idempotencyKey,
      body: {
        jurisdiction: "WY",
        company_name: companyName,
        estimate_token: estimateToken,
        user_confirmed_cost_and_process: true,
        beneficial_owner: {
          full_name: "Alice Testowner",
          email: "alice@example.com",
          address: { street: "123 Test St", city: "Cheyenne", country: "US" },
        },
      },
    });
    assert("idempotency replay 201", r.status === 201, `got ${r.status}`);
    assert("same formation_id", r.body?.data?.formation_id === formationId,
      `got ${r.body?.data?.formation_id} vs ${formationId}`);
  }

  if (!formationId) {
    console.error("\n💥 Cannot continue without formation id\n");
  } else {

    // ── STEP 8: List formations ───────────────────────────────────────────────
    console.log("\nSTEP 8 — List formations");
    {
      const r = await req("GET", "/v1/formations", { key: testKey });
      assert("HTTP 200", r.status === 200, `got ${r.status}`);
      const list = r.body?.data?.formations ?? [];
      assert("formations array", Array.isArray(list));
      assert("new formation in list", list.some((f) => f.id === formationId || f.formation_id === formationId));
    }

    // ── STEP 9: Get formation status ──────────────────────────────────────────
    console.log("\nSTEP 9 — Get formation status");
    let actionToken;
    {
      const r = await req("GET", `/v1/formations/${formationId}`, { key: testKey });
      assert("HTTP 200", r.status === 200, `got ${r.status}`);
      const d = r.body?.data ?? {};
      assert("correct formation id", d.id === formationId || d.formation_id === formationId);
      assert("status pending_owner_confirmation", d.status === "pending_owner_confirmation");
      const nextAction = (d.next_actions ?? [])[0];
      assert("next_action present", !!nextAction);
      // Try to extract act_ token from GET response URL first
      if (nextAction?.url) {
        const m = nextAction.url.match(/\/(act_[a-f0-9]+)/);
        actionToken = m?.[1] ?? null;
      }
      // Fall back to token extracted during creation (POST response is authoritative)
      if (!actionToken && actionTokenFromCreate) {
        actionToken = actionTokenFromCreate;
        console.log(`    → Using action token from creation response`);
      }
      assert("action token available", !!actionToken, `next_action url: ${nextAction?.url ?? "none"}`);
    }

    // ── STEP 10: Inspect action token ─────────────────────────────────────────
    if (actionToken) {
      console.log("\nSTEP 10 — Inspect action token");
      {
        const r = await req("GET", `/v1/actions/${actionToken}`);
        assert("HTTP 200", r.status === 200, `got ${r.status}`);
        assert("purpose owner_confirmation", r.body?.data?.purpose === "owner_confirmation");
        const fId = r.body?.data?.formation?.id ?? r.body?.data?.formation?.formation_id;
        assert("formation id matches", fId === formationId);
      }

      // ── STEP 11: Confirm action (sandbox) ──────────────────────────────────
      console.log("\nSTEP 11 — Confirm action (sandbox advances state)");
      {
        const r = await req("POST", `/v1/actions/${actionToken}/confirm`, {
          body: { email: "alice@example.com" },
        });
        assert("HTTP 200 or 202", [200, 202].includes(r.status), `got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
        const fId = r.body?.data?.formation_id ?? r.body?.data?.id;
        assert("formation id in response", !!fId);
      }

      // ── STEP 12: Status after confirm ─────────────────────────────────────
      console.log("\nSTEP 12 — Status after confirm (sandbox should advance)");
      {
        const r = await req("GET", `/v1/formations/${formationId}`, { key: testKey });
        assert("HTTP 200", r.status === 200, `got ${r.status}`);
        const status = r.body?.data?.status;
        assert("status advanced from pending_owner_confirmation",
          status !== "pending_owner_confirmation",
          `still at ${status}`
        );
        console.log(`    → New status: ${status}`);
      }
    } else {
      console.log("\nSTEP 10–12 — SKIPPED (action token not extractable)");
      failed += 3;
      failures.push("action token not extractable from next_actions URL");
    }

    // ── STEP 13: Formation events ──────────────────────────────────────────────
    console.log("\nSTEP 13 — Formation audit trail");
    {
      const r = await req("GET", `/v1/formations/${formationId}/events`, { key: testKey });
      assert("HTTP 200", r.status === 200, `got ${r.status}`);
      const events = r.body?.data?.events ?? [];
      assert("events array", Array.isArray(events));
      assert("at least one event", events.length > 0, `got ${events.length}`);
    }

    // ── STEP 14: List documents (empty) ───────────────────────────────────────
    console.log("\nSTEP 14 — List documents");
    {
      const r = await req("GET", `/v1/formations/${formationId}/documents`, { key: testKey });
      assert("HTTP 200", r.status === 200, `got ${r.status}`);
    }

    // ── STEP 15: Cancel a second formation ───────────────────────────────────
    console.log("\nSTEP 15 — Create + cancel formation");
    {
      const tok2 = await getEstimate();
      if (tok2) {
        const cr = await req("POST", "/v1/formations", {
          key: testKey,
          body: {
            jurisdiction: "WY",
            company_name: randomName(),
            estimate_token: tok2,
            user_confirmed_cost_and_process: true,
            beneficial_owner: {
              full_name: "Bob Cancel",
              email: "bob@example.com",
              address: { street: "1 Cancel St", city: "Cheyenne", country: "US" },
            },
          },
        });
        const f2id = cr.body?.data?.formation_id;
        if (f2id) {
          const delR = await req("DELETE", `/v1/formations/${f2id}`, { key: testKey });
          assert("cancel HTTP 200", delR.status === 200, `got ${delR.status}`);
          assert("status cancelled", delR.body?.data?.status === "cancelled");
        } else {
          assert("second formation created", false, `${JSON.stringify(cr.body).slice(0, 150)}`);
        }
      } else {
        assert("second estimate token", false, "no token");
      }
    }
  }

  // ── STEP 16: TOS gate ──────────────────────────────────────────────────────
  console.log("\nSTEP 16 — TOS gate (user_confirmed_cost_and_process)");
  {
    const tok = await getEstimate();
    if (tok) {
      const r = await req("POST", "/v1/formations", {
        key: testKey,
        body: {
          jurisdiction: "WY",
          company_name: "TOS Gate Test LLC",
          estimate_token: tok,
          user_confirmed_cost_and_process: false, // ← must be rejected
          beneficial_owner: {
            full_name: "Gate Test",
            email: "gate@example.com",
            address: { street: "1 Gate St", city: "Cheyenne", country: "US" },
          },
        },
      });
      // Zod validation returns 400; literal(true) failure is a validation error
      assert("TOS gate rejects false (400)", r.status === 400, `got ${r.status}`);
    }
    const tok2 = await getEstimate();
    if (tok2) {
      const r2 = await req("POST", "/v1/formations", {
        key: testKey,
        body: {
          jurisdiction: "WY",
          company_name: "TOS Gate Test LLC",
          estimate_token: tok2,
          // user_confirmed_cost_and_process omitted → also 400
          beneficial_owner: {
            full_name: "Gate Test",
            email: "gate@example.com",
            address: { street: "1 Gate St", city: "Cheyenne", country: "US" },
          },
        },
      });
      assert("TOS gate rejects missing field (400)", r2.status === 400, `got ${r2.status}`);
    }
  }

  // ── STEP 17: MCP tools ────────────────────────────────────────────────────
  console.log("\nSTEP 17 — MCP server");
  {
    // Discovery
    const disco = await req("GET", "/mcp");
    assert("GET /mcp 200", disco.status === 200, `got ${disco.status}`);
    assert("MCP tools list present", Array.isArray(disco.body?.tools));

    // tools/list
    const listR = await req("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    assert("tools/list 200", listR.status === 200, `got ${listR.status}`);
    const tools = listR.body?.result?.tools ?? [];
    assert("9 tools registered", tools.length === 9, `got ${tools.length}: ${tools.map(t=>t.name).join(", ")}`);

    // Public estimate call (no key needed)
    const estR = await req("POST", "/mcp", {
      body: {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "offshoreproz_estimate_cost", arguments: { jurisdiction: "WY" } },
      },
    });
    assert("MCP estimate_cost works", estR.status === 200 && !estR.body?.result?.isError);

    // list_formations (requires key)
    const listFR = await req("POST", "/mcp", {
      key: testKey,
      body: {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "offshoreproz_list_formations", arguments: { limit: 5 } },
      },
    });
    assert("MCP list_formations works", listFR.status === 200 && !listFR.body?.result?.isError,
      JSON.stringify(listFR.body?.result).slice(0, 100));

    // get_formation_status (requires key + formationId)
    if (formationId) {
      const getR = await req("POST", "/mcp", {
        key: testKey,
        body: {
          jsonrpc: "2.0", id: 4, method: "tools/call",
          params: { name: "offshoreproz_get_formation_status", arguments: { formation_id: formationId } },
        },
      });
      assert("MCP get_formation_status works", getR.status === 200 && !getR.body?.result?.isError);
    }
  }

  // ── STEP 18: Revoke test key using a same-email spare key ─────────────────
  // Keys can only be revoked by keys belonging to the same owner email.
  console.log("\nSTEP 18 — Revoke test key (via same-email spare key)");
  {
    // Create a spare key with the SAME email — only keys from the same owner can revoke
    const spareR = await req("POST", "/v1/keys", {
      body: { mode: "test", name: "Spare Key for Revoke", email: "e2e-test@offshoreproz.com" },
    });
    const spareKey = spareR.body?.data?.key;
    if (spareKey && testKeyId) {
      const revokeR = await req("DELETE", `/v1/keys/${testKeyId}`, { key: spareKey });
      assert("revoke via same-owner spare key 200", revokeR.status === 200, `got ${revokeR.status}: ${JSON.stringify(revokeR.body).slice(0,100)}`);
      // Verify the revoked key is now rejected
      const checkR = await req("GET", "/v1/formations", { key: testKey });
      assert("revoked key rejected (401)", checkR.status === 401, `got ${checkR.status}`);
    } else {
      assert("spare key created", !!spareKey, `spare key: ${JSON.stringify(spareR.body).slice(0, 100)}`);
      assert("testKeyId known", !!testKeyId);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    failures.forEach((f) => console.error(`  • ${f}`));
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
