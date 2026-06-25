/**
 * OAuth 2.1 authorization server for the MCP remote connector.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  — resource metadata (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server      — AS metadata (RFC 8414)
 *   POST /oauth/register                              — dynamic client reg (RFC 7591)
 *   GET  /oauth/authorize                             — PKCE consent screen
 *   POST /oauth/authorize                             — validate op_ key → auth code
 *   POST /oauth/token                                 — code / refresh → tokens
 *
 * Flow (PKCE, public client):
 *   client → register → authorize(GET consent) → user pastes op_ key →
 *   authorize(POST) issues single-use code → token(POST) verifies PKCE →
 *   access_token (opz_at_) + refresh_token. The access token is presented to
 *   /mcp and resolves to the op_ key's api_key_id (see middleware/auth.ts).
 *
 * Security: PKCE S256 required; redirect_uri validated against the registered
 * set (no open redirect); auth codes single-use 60s; tokens stored hashed.
 */

import type { Hono } from "hono";
import type { AppType } from "../types.ts";
import { validateApiKey } from "../lib/api-key.ts";
import { isLiveModeEnabled } from "../config/live-mode.ts";
import { createLogger } from "../lib/logger.ts";
import { generateTraceId } from "../lib/crypto.ts";
import {
  registerClient,
  getClient,
  issueAuthCode,
  consumeAuthCode,
  issueTokens,
  consumeRefreshToken,
  verifyPkceS256,
} from "../lib/oauth.ts";

/** Escape a value for safe interpolation into an HTML attribute. */
function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function consentPage(params: {
  clientName: string;
  fields: Record<string, string>;
  error?: string;
}): string {
  const hidden = Object.entries(params.fields)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeAttr(k)}" value="${escapeAttr(v)}" />`,
    )
    .join("\n      ");
  const errBlock = params.error
    ? `<p class="err">${escapeAttr(params.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${escapeAttr(params.clientName)} — OffshoreProz</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0a0a0a; color:#e5e5e5; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { width:100%; max-width:420px; padding:32px; background:#141414; border:1px solid #262626; border-radius:14px; margin:16px; }
  .brand { display:flex; align-items:center; gap:8px; justify-content:center; font-weight:600; margin-bottom:20px; }
  .brand svg { color:#10b981; }
  h1 { font-size:18px; text-align:center; margin:0 0 6px; }
  p.sub { text-align:center; color:#a3a3a3; margin:0 0 20px; font-size:13px; }
  label { display:block; font-size:13px; color:#a3a3a3; margin:0 0 6px; }
  input[type=password],input[type=text] { width:100%; box-sizing:border-box; padding:11px 12px; background:#0a0a0a;
         border:1px solid #333; border-radius:9px; color:#e5e5e5; font-size:14px; font-family:ui-monospace,monospace; }
  button { width:100%; margin-top:16px; padding:12px; background:#10b981; color:#04110b; border:0; border-radius:9px;
           font-size:15px; font-weight:600; cursor:pointer; }
  button.secondary { background:transparent; color:#a3a3a3; border:1px solid #333; margin-top:8px; }
  .err { background:#2a1414; border:1px solid #5a2020; color:#fca5a5; padding:10px 12px; border-radius:9px; font-size:13px; margin:0 0 16px; }
  .foot { text-align:center; color:#666; font-size:12px; margin-top:20px; }
</style></head>
<body>
  <form class="card" method="post" action="/oauth/authorize">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>
      OffshoreProz
    </div>
    <h1>Authorize ${escapeAttr(params.clientName)}</h1>
    <p class="sub">${escapeAttr(params.clientName)} wants to act on your OffshoreProz account via the Agent API. Paste your API key to allow it.</p>
    ${errBlock}
    <label for="op_key">API key (op_test_… or op_live_…)</label>
    <input id="op_key" name="op_key" type="password" autocomplete="off" spellcheck="false" placeholder="op_test_…" required />
    ${hidden}
    <button type="submit">Authorize</button>
    <button type="submit" class="secondary" name="deny" value="1">Deny</button>
    <p class="foot">Your key is used only to mint a revocable access token. Secured by OffshoreProz · Agent API</p>
  </form>
</body></html>`;
}

export function registerOAuthRoutes(app: Hono<AppType>): void {
  const meta = (c: { env: AppType["Bindings"] }) => {
    const base = c.env.API_BASE_URL.replace(/\/$/, "");
    return { base };
  };

  // ── Protected-resource metadata (RFC 9728) ────────────────────────────────
  // Served at both the bare and /mcp-suffixed paths (clients try either).
  const resourceMetadata = (c: { env: AppType["Bindings"] }) => {
    const { base } = meta(c);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
    };
  };
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(resourceMetadata(c)),
  );
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(resourceMetadata(c)),
  );

  // ── Authorization-server metadata (RFC 8414) ──────────────────────────────
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const { base } = meta(c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  // ── Dynamic client registration (RFC 7591) ────────────────────────────────
  app.post("/oauth/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      redirect_uris?: unknown;
      client_name?: unknown;
    } | null;
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? (body.redirect_uris.filter((u) => typeof u === "string") as string[])
      : [];
    if (redirectUris.length === 0) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: "redirect_uris is required" },
        400,
      );
    }
    // All redirect URIs must be https (or localhost for native dev loopback).
    const bad = redirectUris.find(
      (u) => !/^https:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(u),
    );
    if (bad) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: `redirect_uri must be https: ${bad}` },
        400,
      );
    }
    const clientName =
      typeof body?.client_name === "string" ? body.client_name : undefined;
    const client = await registerClient(c.env.KV, redirectUris, clientName);
    return c.json(
      {
        client_id: client.client_id,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(clientName ? { client_name: clientName } : {}),
      },
      201,
    );
  });

  // ── Authorization endpoint — consent screen ───────────────────────────────
  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const clientId = q.client_id ?? "";
    const redirectUri = q.redirect_uri ?? "";

    const client = clientId ? await getClient(c.env.KV, clientId) : null;
    // Validate client + redirect_uri BEFORE trusting the redirect target.
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      return c.html(
        `<!doctype html><meta charset=utf-8><body style="background:#0a0a0a;color:#e5e5e5;font-family:sans-serif;text-align:center;padding:60px">
         <h2>Invalid authorization request</h2><p>Unknown client or unregistered redirect URI.</p></body>`,
        400,
      );
    }
    // From here, errors can safely redirect back to the (validated) redirect_uri.
    const redirectErr = (error: string, desc: string): Response => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", desc);
      if (q.state) u.searchParams.set("state", q.state);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code") {
      return redirectErr("unsupported_response_type", "only response_type=code is supported");
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return redirectErr("invalid_request", "PKCE S256 code_challenge is required");
    }

    return c.html(
      consentPage({
        clientName: client.client_name ?? "An application",
        fields: {
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: q.code_challenge,
          code_challenge_method: "S256",
          state: q.state ?? "",
          scope: q.scope ?? "mcp",
        },
      }),
    );
  });

  // ── Authorization endpoint — submit (validate op_ key → code) ──────────────
  app.post("/oauth/authorize", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const logger = createLogger(traceId);
    const form = await c.req.parseBody();
    const clientId = String(form.client_id ?? "");
    const redirectUri = String(form.redirect_uri ?? "");
    const codeChallenge = String(form.code_challenge ?? "");
    const state = String(form.state ?? "");

    const client = clientId ? await getClient(c.env.KV, clientId) : null;
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      return c.html(
        `<!doctype html><meta charset=utf-8><body style="background:#0a0a0a;color:#e5e5e5;font-family:sans-serif;text-align:center;padding:60px"><h2>Invalid request</h2></body>`,
        400,
      );
    }
    const redirectBack = (qs: Record<string, string>): Response => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
      if (state) u.searchParams.set("state", state);
      return c.redirect(u.toString(), 302);
    };

    if (form.deny) return redirectBack({ error: "access_denied" });
    if (!codeChallenge) return redirectBack({ error: "invalid_request" });

    const opKey = String(form.op_key ?? "").trim();
    const auth = await validateApiKey(c.env.AGENT_DB, opKey, isLiveModeEnabled(c.env));
    if (!auth.ok) {
      logger.warn("oauth: consent key rejected", { reason: auth.reason });
      // Re-render consent with an error (do NOT leak which part failed).
      return c.html(
        consentPage({
          clientName: client.client_name ?? "An application",
          error: "That API key was not accepted. Check it and try again.",
          fields: {
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state,
            scope: String(form.scope ?? "mcp"),
          },
        }),
        401,
      );
    }

    const code = await issueAuthCode(c.env.KV, {
      api_key_id: auth.id,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
    });
    logger.info("oauth: code issued", { api_key_id: auth.id, client_id: clientId });
    return redirectBack({ code });
  });

  // ── Token endpoint ────────────────────────────────────────────────────────
  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const grantType = String(form.grant_type ?? "");

    const tokenResponse = (apiKeyId: string) =>
      issueTokens(c.env.KV, apiKeyId).then((t) =>
        c.json(
          {
            access_token: t.access_token,
            token_type: "Bearer",
            expires_in: t.expires_in,
            refresh_token: t.refresh_token,
            scope: "mcp",
          },
          200,
          { "Cache-Control": "no-store" },
        ),
      );

    if (grantType === "authorization_code") {
      const code = String(form.code ?? "");
      const verifier = String(form.code_verifier ?? "");
      const redirectUri = String(form.redirect_uri ?? "");
      const clientId = String(form.client_id ?? "");
      const data = code ? await consumeAuthCode(c.env.KV, code) : null;
      if (!data) {
        return c.json({ error: "invalid_grant", error_description: "code invalid or expired" }, 400);
      }
      if (data.client_id !== clientId || data.redirect_uri !== redirectUri) {
        return c.json({ error: "invalid_grant", error_description: "client_id / redirect_uri mismatch" }, 400);
      }
      if (!verifier || !(await verifyPkceS256(verifier, data.code_challenge))) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }
      return tokenResponse(data.api_key_id);
    }

    if (grantType === "refresh_token") {
      const refresh = String(form.refresh_token ?? "");
      const apiKeyId = refresh ? await consumeRefreshToken(c.env.KV, refresh) : null;
      if (!apiKeyId) {
        return c.json({ error: "invalid_grant", error_description: "refresh_token invalid or expired" }, 400);
      }
      return tokenResponse(apiKeyId);
    }

    return c.json(
      { error: "unsupported_grant_type", error_description: `grant_type "${grantType}" not supported` },
      400,
    );
  });
}
