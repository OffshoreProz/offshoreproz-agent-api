/**
 * Document routes — Sprint 6 (R2 Documents + Portal Vault)
 *
 *   POST /v1/formations/:id/documents     (API key) → upload a document to R2
 *   GET  /v1/formations/:id/documents     (API key) → list documents
 *   GET  /v1/documents/:id                (API key) → metadata + short-TTL download URL
 *   GET  /v1/documents/:id/download?token (token)   → stream bytes from R2
 *
 * Storage: shared bucket offshoreproz-docs-storage, prefix agent-api/formations/.
 * Download is gated by a 5-minute KV token — the R2 object is never public.
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { AppType } from "../types.ts";
import { ok, created, errors } from "../lib/response.ts";
import { requireApiKey } from "../middleware/auth.ts";
import { rateLimiter } from "../middleware/rate-limit.ts";
import { createLogger } from "../lib/logger.ts";
import { generateTraceId } from "../lib/crypto.ts";
import { logFormationEvent } from "../lib/events.ts";
import {
  buildDocumentKey,
  generateDocumentId,
  putDocument,
  getDocument,
  mintDownloadToken,
  resolveDownloadToken,
} from "../lib/documents.ts";

const DOCUMENT_TYPES = [
  "articles_of_organization",
  "operating_agreement",
  "ein_confirmation",
  "registered_agent_acceptance",
  "certificate_of_formation",
  "invoice",
  "kyc_document",
  "other",
] as const;

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

const uploadSchema = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
  filename: z.string().min(1).max(200),
  content_type: z
    .enum([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/json",
      "text/plain",
    ])
    .default("application/pdf"),
  /** base64-encoded file content */
  content_base64: z.string().min(1),
});

interface DocRow {
  id: string;
  formation_id: string;
  document_type: string;
  filename: string;
  r2_key: string;
  r2_bucket: string;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  source: string;
  created_at: string;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function registerDocumentRoutes(app: Hono<AppType>): void {
  // ── POST /v1/formations/:id/documents ─────────────────────────────────────
  app.post(
    "/v1/formations/:id/documents",
    requireApiKey,
    rateLimiter,
    async (c) => {
      const traceId = (c.get("trace_id") as string) ?? generateTraceId();
      const apiKeyId = c.get("api_key_id") as string;
      const formationId = c.req.param("id");
      const log = createLogger(traceId);

      // Ownership: the formation must belong to this API key.
      const formation = await c.env.AGENT_DB.prepare(
        `SELECT id FROM agent_formations WHERE id = ? AND api_key_id = ? LIMIT 1`,
      )
        .bind(formationId, apiKeyId)
        .first<{ id: string }>();
      if (!formation) return errors.notFound(traceId);

      const body = await c.req.json().catch(() => null);
      const parsed = uploadSchema.safeParse(body);
      if (!parsed.success) {
        return errors.validation(
          traceId,
          parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        );
      }

      const { document_type, filename, content_type, content_base64 } =
        parsed.data;

      let data: ArrayBuffer;
      try {
        data = base64ToArrayBuffer(content_base64);
      } catch {
        return errors.unprocessable(
          traceId,
          "content_base64 is not valid base64.",
          "invalid_base64",
        );
      }

      if (data.byteLength === 0) {
        return errors.unprocessable(
          traceId,
          "Document is empty.",
          "empty_document",
        );
      }
      if (data.byteLength > MAX_DOCUMENT_BYTES) {
        return errors.unprocessable(
          traceId,
          `Document exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit.`,
          "document_too_large",
        );
      }

      const documentId = generateDocumentId();
      const key = buildDocumentKey(
        formationId,
        document_type,
        documentId,
        content_type,
      );

      const stored = await putDocument(c.env.R2, key, data, content_type, {
        formation_id: formationId,
        document_id: documentId,
        document_type,
      });

      const now = new Date().toISOString();
      await c.env.AGENT_DB.prepare(
        `INSERT INTO agent_documents
         (id, formation_id, document_type, filename, r2_key, r2_bucket,
          content_type, size_bytes, sha256, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent_api', ?)`,
      )
        .bind(
          documentId,
          formationId,
          document_type,
          filename,
          stored.r2_key,
          stored.r2_bucket,
          content_type,
          stored.size_bytes,
          stored.sha256,
          now,
        )
        .run();

      c.executionCtx.waitUntil(
        logFormationEvent(c.env.AGENT_DB, {
          formation_id: formationId,
          event_type: "note",
          actor_type: "api_key",
          actor_id: apiKeyId,
          trace_id: traceId,
          payload: {
            action: "document_uploaded",
            document_id: documentId,
            document_type,
            size_bytes: stored.size_bytes,
          },
        }),
      );

      log.info("document_uploaded", {
        formation_id: formationId,
        document_id: documentId,
        document_type,
        size_bytes: stored.size_bytes,
      });

      return created(
        {
          id: documentId,
          formation_id: formationId,
          document_type,
          filename,
          content_type,
          size_bytes: stored.size_bytes,
          sha256: stored.sha256,
          created_at: now,
        },
        traceId,
      );
    },
  );

  // ── GET /v1/formations/:id/documents ──────────────────────────────────────
  app.get(
    "/v1/formations/:id/documents",
    requireApiKey,
    rateLimiter,
    async (c) => {
      const traceId = (c.get("trace_id") as string) ?? generateTraceId();
      const apiKeyId = c.get("api_key_id") as string;
      const formationId = c.req.param("id");

      const formation = await c.env.AGENT_DB.prepare(
        `SELECT id FROM agent_formations WHERE id = ? AND api_key_id = ? LIMIT 1`,
      )
        .bind(formationId, apiKeyId)
        .first<{ id: string }>();
      if (!formation) return errors.notFound(traceId);

      const result = await c.env.AGENT_DB.prepare(
        `SELECT id, formation_id, document_type, filename, r2_key, r2_bucket,
                content_type, size_bytes, sha256, source, created_at
         FROM agent_documents
         WHERE formation_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`,
      )
        .bind(formationId)
        .all<DocRow>();

      return ok(
        {
          formation_id: formationId,
          documents: (result.results ?? []).map((d) => ({
            id: d.id,
            document_type: d.document_type,
            filename: d.filename,
            content_type: d.content_type,
            size_bytes: d.size_bytes,
            sha256: d.sha256,
            source: d.source,
            created_at: d.created_at,
          })),
          count: result.results?.length ?? 0,
        },
        traceId,
      );
    },
  );

  // ── GET /v1/documents/:id (metadata + short-TTL download URL) ─────────────
  app.get("/v1/documents/:id", requireApiKey, rateLimiter, async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const apiKeyId = c.get("api_key_id") as string;
    const documentId = c.req.param("id");

    // Join to formation to enforce ownership by API key.
    const row = await c.env.AGENT_DB.prepare(
      `SELECT d.id, d.formation_id, d.document_type, d.filename, d.r2_key,
              d.r2_bucket, d.content_type, d.size_bytes, d.sha256, d.source, d.created_at
       FROM agent_documents d
       JOIN agent_formations f ON f.id = d.formation_id
       WHERE d.id = ? AND f.api_key_id = ? AND d.deleted_at IS NULL
       LIMIT 1`,
    )
      .bind(documentId, apiKeyId)
      .first<DocRow>();

    if (!row) return errors.notFound(traceId);

    const { token, ttl_seconds } = await mintDownloadToken(c.env.KV, {
      document_id: row.id,
      r2_key: row.r2_key,
      filename: row.filename,
      content_type: row.content_type,
    });

    const downloadUrl = `${c.env.API_BASE_URL}/v1/documents/${row.id}/download?token=${token}`;

    return ok(
      {
        id: row.id,
        formation_id: row.formation_id,
        document_type: row.document_type,
        filename: row.filename,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        source: row.source,
        created_at: row.created_at,
        download_url: downloadUrl,
        download_expires_in_seconds: ttl_seconds,
      },
      traceId,
    );
  });

  // ── GET /v1/documents/:id/download?token= (token-gated stream) ────────────
  // No API key — the short-TTL token is the credential. The R2 object stays
  // private; we stream it through the worker.
  app.get("/v1/documents/:id/download", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const documentId = c.req.param("id");
    const token = c.req.query("token");

    if (!token) {
      return errors.unprocessable(
        traceId,
        "Missing download token. Request a fresh URL from GET /v1/documents/:id.",
        "missing_download_token",
      );
    }

    const payload = await resolveDownloadToken(c.env.KV, token);
    if (!payload || payload.document_id !== documentId) {
      return errors.unprocessable(
        traceId,
        "Download link is invalid or has expired. Request a fresh one.",
        "download_token_invalid",
      );
    }

    const obj = await getDocument(c.env.R2, payload.r2_key);
    if (!obj) return errors.notFound(traceId);

    const headers = new Headers();
    headers.set("Content-Type", payload.content_type);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${payload.filename.replace(/"/g, "")}"`,
    );
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Request-Id", traceId);
    return new Response(obj.body, { status: 200, headers });
  });
}
