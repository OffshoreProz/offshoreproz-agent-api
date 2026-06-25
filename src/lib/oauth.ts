/**
 * OAuth 2.1 storage + helpers for the MCP remote connector.
 *
 * The Agent API acts as BOTH the OAuth authorization server and the protected
 * resource (the /mcp endpoint). A native MCP client (Claude Desktop, claude.ai)
 * discovers the auth server via /.well-known metadata, registers dynamically,
 * runs the PKCE authorization-code flow, and presents the resulting bearer
 * access token to /mcp — no local mcp-remote bridge needed.
 *
 * Identity model: the user authorizes by entering their existing op_ API key on
 * the consent screen. The issued OAuth token is therefore bound to that key's
 * api_key_id — OAuth is a thin, revocable wrapper over the credential we already
 * have. We never store raw tokens: every code/token is looked up by SHA-256 hash
 * (same discipline as api_key_hash).
 *
 * Storage (KV, all keys prefixed `oauth:`):
 *   oauth:client:<client_id>   → OAuthClient JSON           (TTL 90d)
 *   oauth:code:<sha(code)>     → AuthCodeData JSON          (TTL 60s, single-use)
 *   oauth:at:<sha(token)>      → api_key_id                 (TTL 1h)
 *   oauth:rt:<sha(token)>      → api_key_id                 (TTL 30d, rotated)
 */

import { hashApiKey } from "./crypto.ts";

export const ACCESS_TOKEN_PREFIX = "opz_at_";
export const REFRESH_TOKEN_PREFIX = "opz_rt_";

export const AUTH_CODE_TTL = 60; // seconds — short, single-use
export const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
export const CLIENT_TTL = 60 * 60 * 24 * 90; // 90 days

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex}`;
}

/** base64url of raw bytes (no padding) — for PKCE S256 comparison. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Verify a PKCE code_verifier against a stored S256 code_challenge. */
export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest)) === challenge;
}

// ─── Dynamic client registration ──────────────────────────────────────────────

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: string;
}

export async function registerClient(
  kv: KVNamespace,
  redirectUris: string[],
  clientName: string | undefined,
): Promise<OAuthClient> {
  const client: OAuthClient = {
    client_id: randomToken("opzc_"),
    redirect_uris: redirectUris,
    created_at: new Date().toISOString(),
    ...(clientName ? { client_name: clientName } : {}),
  };
  await kv.put(`oauth:client:${client.client_id}`, JSON.stringify(client), {
    expirationTtl: CLIENT_TTL,
  });
  return client;
}

export async function getClient(
  kv: KVNamespace,
  clientId: string,
): Promise<OAuthClient | null> {
  const raw = await kv.get(`oauth:client:${clientId}`);
  return raw ? (JSON.parse(raw) as OAuthClient) : null;
}

// ─── Authorization codes (single-use, PKCE-bound) ─────────────────────────────

export interface AuthCodeData {
  api_key_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

export async function issueAuthCode(
  kv: KVNamespace,
  data: AuthCodeData,
): Promise<string> {
  const code = randomToken("opzac_");
  await kv.put(`oauth:code:${await hashApiKey(code)}`, JSON.stringify(data), {
    expirationTtl: AUTH_CODE_TTL,
  });
  return code;
}

/** Consume (delete) an auth code — single-use. Returns null if absent/expired. */
export async function consumeAuthCode(
  kv: KVNamespace,
  code: string,
): Promise<AuthCodeData | null> {
  const key = `oauth:code:${await hashApiKey(code)}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  return JSON.parse(raw) as AuthCodeData;
}

// ─── Access + refresh tokens ──────────────────────────────────────────────────

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function issueTokens(
  kv: KVNamespace,
  apiKeyId: string,
): Promise<IssuedTokens> {
  const access_token = randomToken(ACCESS_TOKEN_PREFIX);
  const refresh_token = randomToken(REFRESH_TOKEN_PREFIX);
  await kv.put(`oauth:at:${await hashApiKey(access_token)}`, apiKeyId, {
    expirationTtl: ACCESS_TOKEN_TTL,
  });
  await kv.put(`oauth:rt:${await hashApiKey(refresh_token)}`, apiKeyId, {
    expirationTtl: REFRESH_TOKEN_TTL,
  });
  return { access_token, refresh_token, expires_in: ACCESS_TOKEN_TTL };
}

/** Resolve a presented access token to its api_key_id (or null). */
export async function resolveAccessToken(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  return kv.get(`oauth:at:${await hashApiKey(token)}`);
}

/** Consume (rotate) a refresh token — single-use. Returns api_key_id or null. */
export async function consumeRefreshToken(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  if (!token.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  const key = `oauth:rt:${await hashApiKey(token)}`;
  const apiKeyId = await kv.get(key);
  if (!apiKeyId) return null;
  await kv.delete(key);
  return apiKeyId;
}
