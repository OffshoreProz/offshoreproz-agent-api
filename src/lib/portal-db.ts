/**
 * Portal DB Safety Layer
 *
 * ⚠️  PRODUCTION GUARD — READ THIS BEFORE USING PORTAL_DB ⚠️
 *
 * the portal database (PORTAL_DB) is the LIVE PRODUCTION database of the portal.
 * Real clients. Real invoices. Real shareholders. Real documents.
 *
 * RULES enforced by this module:
 *   1. STAGING WRITE BLOCK: PORTAL_SYNC_ENABLED=false → all writes dry-run
 *   2. ALLOWLIST-ONLY WRITES: only projects, incorporation_documents, invoices
 *   3. NO UPDATE/DELETE ON EXISTING ROWS
 *   4. NO DESTRUCTIVE PATTERNS
 *   5. ALWAYS USE THIS WRAPPER — never call c.env.PORTAL_DB directly in Sprint 3+ code
 */

import type { Context } from "hono";
import type { AppType } from "../types.ts";
import { createLogger } from "./logger.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortalProjectInsert {
  id: string;
  client_user_id: string;
  jurisdiction: string;
  company_names_json: string;
  agent_formation_id: string;
  agent_context_json: string | null;
  notes: string | null;
}

export interface PortalWriteResult {
  dry_run: boolean;
  preview?: Record<string, unknown>;
  inserted_id?: string;
  error?: string;
}

// ─── Jurisdiction code → portal string map ────────────────────────────────────

const JURISDICTION_MAP: Record<string, string> = {
  WY: "wyoming",
  MI: "marshall_islands",
  NV: "nevada",
  BVI: "bvi",
  PA: "panama",
  UAE: "uae",
};

export function toPortalJurisdiction(code: string): string {
  return JURISDICTION_MAP[code] ?? code.toLowerCase();
}

// ─── Allowlisted tables ───────────────────────────────────────────────────────

const AGENT_API_WRITE_TABLES = new Set([
  "projects",
  "incorporation_documents",
  "invoices",
]);

// ─── Main wrapper ─────────────────────────────────────────────────────────────

export function portalDb(c: Context<AppType>) {
  const env = c.env;
  const syncEnabled = env.PORTAL_SYNC_ENABLED === "true";
  const traceId =
    (c.get("trace_id") as string | undefined) ?? crypto.randomUUID();
  const logger = createLogger(traceId);

  if (!syncEnabled) {
    logger.info(
      "PortalDB: PORTAL_SYNC_ENABLED=false — all writes are dry-run",
      { environment: env.ENVIRONMENT },
    );
  }

  return {
    isLive: syncEnabled,

    async findUserByEmail(
      email: string,
    ): Promise<{ id: string; name: string } | null> {
      try {
        const row = await env.PORTAL_DB.prepare(
          `SELECT id, name FROM users WHERE email = ? AND is_active = 1 LIMIT 1`,
        )
          .bind(email.toLowerCase().trim())
          .first<{ id: string; name: string }>();
        return row ?? null;
      } catch {
        return null;
      }
    },

    async createProject(data: PortalProjectInsert): Promise<PortalWriteResult> {
      if (!syncEnabled) {
        return {
          dry_run: true,
          preview: {
            table: "projects",
            action: "INSERT OR IGNORE",
            data: {
              id: data.id,
              client_user_id: data.client_user_id,
              jurisdiction: data.jurisdiction,
              company_names: data.company_names_json,
              status: "documentation_pending",
              source_channel: "agent_api",
              agent_formation_id: data.agent_formation_id,
              notes: data.notes,
            },
          },
        };
      }

      assertAllowedTable("projects");

      try {
        const now = new Date().toISOString();

        const result = await env.PORTAL_DB.prepare(
          `INSERT OR IGNORE INTO projects
           (id, client_user_id, jurisdiction, company_names,
            status, notes, source_channel,
            agent_formation_id, agent_context_json,
            completeness_percentage, created_at, updated_at)
           VALUES (?, ?, ?, ?,
                   'documentation_pending', ?, 'agent_api',
                   ?, ?,
                   0, ?, ?)`,
        )
          .bind(
            data.id,
            data.client_user_id,
            data.jurisdiction,
            data.company_names_json,
            data.notes,
            data.agent_formation_id,
            data.agent_context_json,
            now,
            now,
          )
          .run();

        if (result.success) {
          logger.info("PortalDB: project created", {
            portal_project_id: data.id,
            agent_formation_id: data.agent_formation_id,
          });
          return { dry_run: false, inserted_id: data.id };
        }

        return {
          dry_run: false,
          error: "Insert returned success=false — possible conflict (already exists)",
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("PortalDB: createProject failed", {
          error: message,
          formation_id: data.agent_formation_id,
        });
        return { dry_run: false, error: message };
      }
    },

    async isMigration082Applied(): Promise<boolean> {
      try {
        const row = await env.PORTAL_DB.prepare(
          `SELECT 1 FROM pragma_table_info('projects') WHERE name = 'agent_formation_id' LIMIT 1`,
        ).first<{ 1: number }>();
        return !!row;
      } catch {
        return false;
      }
    },

    async findProjectByFormationId(
      formationId: string,
    ): Promise<{ id: string; status: string } | null> {
      try {
        const row = await env.PORTAL_DB.prepare(
          `SELECT id, status FROM projects
           WHERE agent_formation_id = ?
             AND source_channel = 'agent_api'
           LIMIT 1`,
        )
          .bind(formationId)
          .first<{ id: string; status: string }>();
        return row ?? null;
      } catch {
        return null;
      }
    },

    async healthCheck(): Promise<{
      reachable: boolean;
      migration_082_applied: boolean;
      portal_sync_enabled: boolean;
    }> {
      try {
        await env.PORTAL_DB.prepare("SELECT 1").first();
        const migration082 = await this.isMigration082Applied();
        return {
          reachable: true,
          migration_082_applied: migration082,
          portal_sync_enabled: syncEnabled,
        };
      } catch {
        return {
          reachable: false,
          migration_082_applied: false,
          portal_sync_enabled: syncEnabled,
        };
      }
    },
  };
}

function assertAllowedTable(table: string): void {
  if (!AGENT_API_WRITE_TABLES.has(table)) {
    throw new Error(
      `[PortalDB SAFETY] Attempted write to disallowed table: "${table}". ` +
        `Only these tables may be written by Agent API: ${[...AGENT_API_WRITE_TABLES].join(", ")}. ` +
        `This is a code bug — do NOT catch this error.`,
    );
  }
}
