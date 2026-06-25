# OffshoreProz Agent API

Agent-native company formation over **MCP** and **REST**, running on Cloudflare Workers.

Form a real legal entity (e.g. a Wyoming LLC or a Marshall Islands DAO LLC)
programmatically — designed for AI agents that need to spin up companies as part
of a workflow. Public tools (list jurisdictions, estimate cost, register) require
no authentication; formation and management tools require an API key.

- **Production:** `https://api.offshoreproz.com`
- **MCP endpoint:** `https://api.offshoreproz.com/mcp`
- **Docs:** `https://docs.offshoreproz.com`

---

## MCP server

The Agent API is also an MCP server with 14 tools covering the full formation
lifecycle: self-registration, jurisdiction discovery, cost estimation, formation
creation, status tracking, document access, webhooks, audit logs, and recovery
flows. It supports OAuth 2.1 as a native remote connector (Claude Desktop /
claude.ai), so no local `mcp-remote` bridge is needed.

See [smithery.yaml](smithery.yaml) for the tool catalog and
[docs/DEMO.md](docs/DEMO.md) for a runnable sandbox walkthrough.

---

## Authentication

| Key prefix  | Mode    | Effect                                   |
| ----------- | ------- | ---------------------------------------- |
| `op_test_*` | Sandbox | No charges, no real filings              |
| `op_live_*` | Live    | Real payment + state filing              |

Get a free test key instantly via the `offshoreproz_register` MCP tool — no
portal login required.

---

## Local development

```bash
npm install

# Generate Cloudflare types from your wrangler config
npx wrangler types

# Copy and fill local secrets
cp .dev.vars.example .dev.vars   # set API_KEY_ENCRYPTION_SECRET (do NOT commit)

# Apply migrations to the local DB, then run the Worker
npm run migrate:local
npm run dev
```

Copy [`wrangler.example.jsonc`](wrangler.example.jsonc) to `wrangler.jsonc` and
fill in your own Cloudflare account ID and resource bindings. Production secrets
are never committed — set them with `wrangler secret put`.

---

## Tests

```bash
npm run test           # run once
npm run test:watch     # watch mode
npm run test:coverage  # with coverage
```

---

## Project layout

```
src/
├── index.ts            ← entry point (Hono app)
├── config/             ← static jurisdiction data
├── routes/             ← REST + MCP + OAuth + webhooks
├── middleware/         ← auth, CORS, errors, tracing
└── lib/                ← crypto, OFAC, providers, countries, logging
migrations/             ← D1 schema
tests/
```

---

## License

See [LICENSE](LICENSE).
