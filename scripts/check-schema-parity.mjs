#!/usr/bin/env node
/**
 * G4 — Schema parity check
 *
 * Verifies that TypeScript union types in src/types.ts match the CHECK
 * constraints in the most recent AGENT_DB migration.
 *
 * WHY: The B1 bug (kyc_approved missing from CHECK) was silently breaking
 * the KYC-approve path in production. This script makes that class of drift
 * fail loudly during CI before it ever reaches the DB.
 *
 * Usage:
 *   node scripts/check-schema-parity.mjs
 *   npm run test:parity
 *
 * Exit 0 = all good. Exit 1 = drift detected (add values to migration OR types.ts).
 */

import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

// ── Parsers ────────────────────────────────────────────────────────────────────

function extractUnionType(src, typeName) {
  const re = new RegExp(`export type ${typeName}\\s*=([^;]+);`, "s");
  const m = src.match(re);
  if (!m) throw new Error(`Type '${typeName}' not found in types.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

function extractCheckInValues(sql, columnName) {
  // Matches: CHECK (column_name IN ('a', 'b', ...)) — handles multiline
  const re = new RegExp(
    `CHECK\\s*\\(\\s*${columnName}\\s+IN\\s*\\(([^)]+)\\)`,
    "si",
  );
  const m = sql.match(re);
  if (!m)
    throw new Error(
      `CHECK (${columnName} IN (...)) not found in migration source`,
    );
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

// ── Load sources ───────────────────────────────────────────────────────────────

const typesSrc = readFileSync(resolve(root, "src/types.ts"), "utf8");

// Use the most recent migration file as the schema source of truth.
// Migrations are numbered 0001, 0002, … so the last one alphabetically is latest.
const migrationsDir = resolve(root, "migrations/agent-db");
const latestMigration = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .at(-1);

if (!latestMigration)
  throw new Error(`No .sql files found in ${migrationsDir}`);

const migrationSrc = readFileSync(
  resolve(migrationsDir, latestMigration),
  "utf8",
);

// ── Parity checks ──────────────────────────────────────────────────────────────
//
// Each entry maps a TypeScript union type to a D1 CHECK column.
// Both directions are checked: ts → db AND db → ts.

const CHECKS = [
  {
    label: "FormationStatus ↔ agent_formations.status",
    tsType: "FormationStatus",
    dbColumn: "status",
  },
  {
    label: "JurisdictionCode ↔ agent_formations.jurisdiction",
    tsType: "JurisdictionCode",
    dbColumn: "jurisdiction",
  },
  {
    label: "FormationMode ↔ agent_formations.mode",
    tsType: "FormationMode",
    dbColumn: "mode",
  },
];

// ── Run ────────────────────────────────────────────────────────────────────────

console.log(`\nSchema parity check — migration: ${latestMigration}\n`);

let failed = false;

for (const { label, tsType, dbColumn } of CHECKS) {
  let tsValues, dbValues;
  try {
    tsValues = extractUnionType(typesSrc, tsType);
    dbValues = extractCheckInValues(migrationSrc, dbColumn);
  } catch (err) {
    console.error(`❌  ${label}\n    Parse error: ${err.message}`);
    failed = true;
    continue;
  }

  const missingInDb = tsValues.filter((v) => !dbValues.includes(v));
  const missingInTs = dbValues.filter((v) => !tsValues.includes(v));

  if (missingInDb.length || missingInTs.length) {
    console.error(`❌  ${label}`);
    if (missingInDb.length)
      console.error(
        `    In types.ts but NOT in CHECK: ${missingInDb.map((v) => `'${v}'`).join(", ")}`,
      );
    if (missingInTs.length)
      console.error(
        `    In CHECK but NOT in types.ts: ${missingInTs.map((v) => `'${v}'`).join(", ")}`,
      );
    failed = true;
  } else {
    console.log(`✅  ${label} (${tsValues.length} values)`);
  }
}

if (failed) {
  console.error(
    "\nParity check FAILED. Update the migration CHECK or types.ts to fix drift.\n",
  );
  process.exit(1);
}

console.log("\nAll parity checks passed.\n");
