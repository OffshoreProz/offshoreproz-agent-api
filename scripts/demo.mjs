#!/usr/bin/env node
/**
 * Client-demo rehearsal — Agent API sandbox lifecycle, pretty output.
 *
 * Runs the exact flow a client sees, end to end, in SANDBOX (op_test):
 *   register → list jurisdictions → estimate → create → print live act_ link →
 *   walk the confirmation lifecycle (KYC → payment → signature → filing) → done.
 *
 * No real charges, no real filings. Use this to rehearse before a live demo and
 * to grab a real, clickable confirmation link to open in the browser.
 *
 * Usage:
 *   node scripts/demo.mjs                  # Wyoming LLC, full lifecycle (consumes the link)
 *   JURISDICTION=MI node scripts/demo.mjs  # Marshall Islands DAO LLC
 *   STOP_AT_LINK=1 node scripts/demo.mjs   # create + print a FRESH clickable link, don't confirm
 *   OPZ_KEY=op_test_... node scripts/demo.mjs   # use a fixed key, skip register (avoids rate limit)
 *   BASE_URL=https://api-staging.offshoreproz.com node scripts/demo.mjs
 *
 * For a LIVE demo, run with STOP_AT_LINK=1 to get an unconsumed link to click on
 * screen. Run without it to rehearse the entire flow end to end.
 */

const BASE_URL = process.env.BASE_URL ?? "https://api.offshoreproz.com";
const JURISDICTION = (process.env.JURISDICTION ?? "WY").toUpperCase();
const STOP_AT_LINK = process.env.STOP_AT_LINK === "1";
// Pre-provisioned key. Set this to skip offshoreproz_register (which is rate
// limited: 5/h per email, 10/h per IP). Mirrors the Claude Desktop demo config,
// where the key is passed via the mcp-remote Authorization header.
const OPZ_KEY = process.env.OPZ_KEY ?? "";

const NAMES = {
  WY: "Demo Startup AI LLC",
  MI: "Autonomous Agent DAO LLC",
};

async function call(name, args, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const outer = await res.json();
  const text = outer?.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function rest(method, path, { key, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

const line = () => console.log("─".repeat(60));
const tokenFromUrl = (url) => (url ?? "").match(/\/(act_[a-f0-9]+)/)?.[1] ?? null;

async function run() {
  const company = NAMES[JURISDICTION] ?? `Demo ${JURISDICTION} LLC`;
  console.log(`\n╔${"═".repeat(58)}╗`);
  console.log(`║  DEMO REHEARSAL — IA abrindo uma empresa (${JURISDICTION})`.padEnd(59) + "║");
  console.log(`╚${"═".repeat(58)}╝\n`);
  console.log(`API: ${BASE_URL}\n`);

  // 1 — get a key (use pre-provisioned, or register)
  console.log("① Chave de acesso");
  line();
  let key;
  if (OPZ_KEY) {
    key = OPZ_KEY;
    console.log(`   usando chave pré-provisionada: ${key.slice(0, 24)}…  (sem register)\n`);
  } else {
    const reg = await call("offshoreproz_register", { name: "demo-agent", email: "demo@offshoreproz.com" });
    if (!reg.key) {
      console.error(`   ⚠️  register falhou: ${reg.error ?? JSON.stringify(reg)}`);
      console.error(`   Dica: rode com uma chave fixa para evitar rate limit:`);
      console.error(`   OPZ_KEY=op_test_... node scripts/demo.mjs\n`);
      process.exit(1);
    }
    key = reg.key;
    console.log(`   chave: ${key.slice(0, 24)}…  (modo: ${reg.mode})\n`);
  }

  // 2 — jurisdictions
  console.log("② Jurisdições disponíveis");
  line();
  const jur = await call("offshoreproz_list_jurisdictions", { include_coming_soon: false });
  for (const j of jur.jurisdictions) {
    console.log(`   ${j.name.padEnd(28)} $${String(j.total_estimated_usd).padEnd(6)} ${j.eta_days.min}-${j.eta_days.max} dias [${j.status}]`);
  }
  console.log();

  // 3 — estimate
  console.log(`③ Orçamento — ${JURISDICTION}`);
  line();
  const est = await call("offshoreproz_estimate_cost", { jurisdiction: JURISDICTION, obtain_ein: JURISDICTION === "WY" }, key);
  for (const b of est.breakdown ?? []) console.log(`   ${b.item.padEnd(34)} $${b.amount_usd}`);
  console.log(`   ${"TOTAL".padEnd(34)} $${est.total_usd}\n`);

  // 4 — create
  console.log("④ Criando a empresa");
  line();
  const owner = {
    full_name: "Victor Tavares",
    email: "demo@offshoreproz.com",
    address: { street: "Rua Exemplo 100", city: "Sao Paulo", country: "BR" },
  };
  if (JURISDICTION === "MI") owner.ownership_percentage = 100;
  const create = await call("offshoreproz_create_formation", {
    jurisdiction: JURISDICTION,
    company_name: company,
    obtain_ein: JURISDICTION === "WY",
    estimate_token: est.estimate_token,
    user_confirmed_cost_and_process: true,
    owner_type: "ai_agent",
    beneficial_owner: owner,
    agent_context: { agent_id: "demo-agent", agent_name: "Demo Agent", agent_purpose: "Client demo", platform: "Rehearsal" },
  }, key);
  const fid = create.formation_id;
  let actToken = tokenFromUrl(create.next_actions?.[0]?.url);
  console.log(`   empresa:  ${create.company_name}`);
  console.log(`   id:       ${fid}`);
  console.log(`   status:   ${create.status}\n`);

  console.log("   🔗 LINK DE CONFIRMAÇÃO (abra no navegador para a demo):");
  console.log(`   ${create.next_actions?.[0]?.url}\n`);
  console.log(`   📁 Portal: ${create.portal_url}\n`);

  if (STOP_AT_LINK) {
    console.log("   ⏸  STOP_AT_LINK=1 — link fresco, NÃO confirmado. Abra-o no navegador para a demo ao vivo.\n");
    return;
  }

  // 5 — walk the confirmation lifecycle (sandbox simulates each step)
  console.log("⑤ Confirmando — sandbox simula KYC → pagamento → assinatura → filing");
  line();
  const TERMINAL = new Set(["filing_ready", "filed", "complete", "completed", "cancelled"]);
  let steps = 0;
  while (actToken && steps < 12) {
    steps++;
    const confirm = await rest("POST", `/v1/actions/${actToken}/confirm`, { body: { email: owner.email } });
    if (![200, 202].includes(confirm.status)) {
      console.log(`   confirm parou (HTTP ${confirm.status})`);
      break;
    }
    const status = await rest("GET", `/v1/formations/${fid}`, { key });
    const st = status.body?.data?.status;
    console.log(`   passo ${steps}: → ${st}`);
    if (TERMINAL.has(st)) break;
    // find next action token (sandbox returns one in confirm response or status)
    const nextUrl = confirm.body?.data?.next_action?.url ?? status.body?.data?.next_actions?.[0]?.url;
    const next = tokenFromUrl(nextUrl);
    if (!next || next === actToken) break;
    actToken = next;
  }
  console.log();

  // 6 — final state + audit
  const finalStatus = await rest("GET", `/v1/formations/${fid}`, { key });
  const events = await call("offshoreproz_get_formation_events", { formation_id: fid }, key);
  console.log("⑥ Estado final");
  line();
  console.log(`   status final: ${finalStatus.body?.data?.status}`);
  console.log(`   eventos registrados: ${events.events?.length ?? 0}`);
  console.log(`\n   (formação de teste — nada cobrado, nada registrado de verdade)\n`);
  console.log("✅ Rehearsal completo.\n");
}

run().catch((e) => { console.error("Falha:", e); process.exit(1); });
