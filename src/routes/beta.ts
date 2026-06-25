/**
 * Beta waitlist — Sprint 8
 *
 *   POST /v1/beta/waitlist   (public) — request access to the op_live_ beta
 *   GET  /v1/beta/waitlist   (admin)  — list requests (ADMIN_API_TOKEN)
 *
 * Public endpoint is rate-limited only by Cloudflare; it stores one row per
 * email (idempotent on email via UNIQUE index).
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { AppType } from "../types.ts";
import { ok, created, errors } from "../lib/response.ts";
import { generateTraceId, timingSafeCompare } from "../lib/crypto.ts";

const waitlistSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(120).optional(),
  company: z.string().max(160).optional(),
  use_case: z.string().max(1000).optional(),
  platform: z.string().max(80).optional(),
});

function genId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `wl_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function registerBetaRoutes(app: Hono<AppType>): void {
  // ── POST /v1/beta/waitlist (public) ───────────────────────────────────────
  app.post("/v1/beta/waitlist", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const body = await c.req.json().catch(() => null);
    const parsed = waitlistSchema.safeParse(body);
    if (!parsed.success) {
      return errors.validation(
        traceId,
        parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      );
    }

    const { email, name, company, use_case, platform } = parsed.data;
    const id = genId();
    const now = new Date().toISOString();

    // Idempotent on email: ignore duplicates, still report success.
    await c.env.AGENT_DB.prepare(
      `INSERT INTO agent_beta_waitlist
       (id, email, name, company, use_case, platform, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(email) DO NOTHING`,
    )
      .bind(
        id,
        email.toLowerCase().trim(),
        name ?? null,
        company ?? null,
        use_case ?? null,
        platform ?? null,
        now,
      )
      .run();

    return created(
      {
        status: "pending",
        email: email.toLowerCase().trim(),
        message:
          "You're on the OffshoreProz Agent API beta waitlist. We'll email you when op_live_ access opens.",
      },
      traceId,
    );
  });

  // ── GET /v1/beta/waitlist (admin) ─────────────────────────────────────────
  app.get("/v1/beta/waitlist", async (c) => {
    const traceId = (c.get("trace_id") as string) ?? generateTraceId();
    const expected = c.env.ADMIN_API_TOKEN;
    const header = c.req.header("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (
      !expected ||
      !provided ||
      !(await timingSafeCompare(provided, expected))
    ) {
      return errors.unauthorized(traceId);
    }

    const result = await c.env.AGENT_DB.prepare(
      `SELECT id, email, name, company, use_case, platform, status, created_at
       FROM agent_beta_waitlist ORDER BY created_at DESC LIMIT 200`,
    ).all();

    return ok(
      {
        waitlist: result.results ?? [],
        count: result.results?.length ?? 0,
      },
      traceId,
    );
  });
}
