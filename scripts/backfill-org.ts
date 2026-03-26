/**
 * Backfill organization_id on existing domain rows.
 *
 * Usage:
 *   bun scripts/backfill-org.ts <organization_id>
 *
 * Run this AFTER signing up and creating your first organization.
 * Pass the organization ID (visible in the URL or database).
 */
import { Pool } from "pg";

const orgId = process.argv[2];

if (!orgId) {
  console.error("Usage: bun scripts/backfill-org.ts <organization_id>");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const tables = [
  "ad_account",
  "campaign",
  "ad_set",
  "ad",
  "ad_creative",
  "landing_page",
  "landing_page_version",
  "tag",
  "entity_tag",
  "performance_log",
  "ab_test",
  "ab_test_variant",
];

async function main() {
  for (const table of tables) {
    const result = await pool.query(
      `UPDATE "${table}" SET organization_id = $1 WHERE organization_id IS NULL`,
      [orgId],
    );
    console.log(`${table}: ${result.rowCount} rows updated`);
  }

  console.log("\nDone! All existing data is now scoped to organization:", orgId);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
