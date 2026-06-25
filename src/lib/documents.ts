/**
 * Document storage — Sprint 6 (R2 Documents + Portal Vault)
 *
 * Formation documents are stored in the SHARED R2 bucket
 * `offshoreproz-docs-storage` under a strictly namespaced prefix:
 *
 *   agent-api/formations/{formation_id}/{document_type}/{document_id}.{ext}
 *
 * ⚠️ SAFETY: This module ONLY ever touches keys under the `agent-api/` prefix.
 * It NEVER lists, reads, overwrites, or deletes anything outside that prefix,
 * so the portal's existing objects are untouchable from here.
 *
 * Download is never public. A short-TTL download token (stored in KV) gates
 * the streaming endpoint — the R2 object itself is never made public.
 */

const R2_PREFIX = "agent-api/formations";
const R2_BUCKET_NAME = "offshoreproz-docs-storage";

/** Hard guard: every key this module produces/accepts must be namespaced. */
export function assertNamespacedKey(key: string): void {
  if (!key.startsWith(`${R2_PREFIX}/`)) {
    throw new Error(
      `Refusing to touch R2 key outside agent-api namespace: ${key}`,
    );
  }
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/json": "json",
  "text/plain": "txt",
};

export function extForContentType(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
}

/** Build the canonical R2 key for a formation document. */
export function buildDocumentKey(
  formationId: string,
  documentType: string,
  documentId: string,
  contentType: string,
): string {
  const ext = extForContentType(contentType);
  return `${R2_PREFIX}/${formationId}/${documentType}/${documentId}.${ext}`;
}

/** Generate a document id: doc_<hex>. */
export function generateDocumentId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `doc_${hex}`;
}

/** SHA-256 hex of bytes — integrity check stored alongside metadata. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface PutDocumentResult {
  r2_key: string;
  r2_bucket: string;
  size_bytes: number;
  sha256: string;
}

/**
 * Store a document in R2 under the agent-api namespace.
 * Returns the key + integrity metadata. Never overwrites outside namespace.
 */
export async function putDocument(
  bucket: R2Bucket,
  key: string,
  data: ArrayBuffer,
  contentType: string,
  metadata: Record<string, string>,
): Promise<PutDocumentResult> {
  assertNamespacedKey(key);
  const sha = await sha256Hex(data);
  await bucket.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: { ...metadata, sha256: sha },
  });
  return {
    r2_key: key,
    r2_bucket: R2_BUCKET_NAME,
    size_bytes: data.byteLength,
    sha256: sha,
  };
}

/** Fetch a document object from R2 (namespace-guarded). */
export async function getDocument(
  bucket: R2Bucket,
  key: string,
): Promise<R2ObjectBody | null> {
  assertNamespacedKey(key);
  const obj = await bucket.get(key);
  return obj ?? null;
}

// ─── Short-TTL download tokens (KV-backed signed-URL equivalent) ───────────────

const DOWNLOAD_TOKEN_TTL_SECONDS = 300; // 5 minutes

/** Generate a download token: dl_<hex>. */
export function generateDownloadToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `dl_${hex}`;
}

export interface DownloadTokenPayload {
  document_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
}

/** Mint a short-TTL download token in KV, returns token + ttl. */
export async function mintDownloadToken(
  kv: KVNamespace,
  payload: DownloadTokenPayload,
  ttlSeconds: number = DOWNLOAD_TOKEN_TTL_SECONDS,
): Promise<{ token: string; ttl_seconds: number }> {
  const token = generateDownloadToken();
  await kv.put(`dl:${token}`, JSON.stringify(payload), {
    expirationTtl: ttlSeconds,
  });
  return { token, ttl_seconds: ttlSeconds };
}

/** Resolve a download token to its payload, or null if invalid/expired. */
export async function resolveDownloadToken(
  kv: KVNamespace,
  token: string,
): Promise<DownloadTokenPayload | null> {
  const raw = await kv.get(`dl:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DownloadTokenPayload;
  } catch {
    return null;
  }
}
