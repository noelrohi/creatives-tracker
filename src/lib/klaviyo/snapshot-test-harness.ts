/** Test-only harness. Requires an explicit local disposable DATABASE_URL and
 * SNAPSHOT_TEST_DATABASE=1; never reads .env or connects to a remote host.
 * Each caller gets its own database with the existing Klaviyo fixture and
 * relevant real migrations, then the generated snapshot migration unchanged.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { MATCH_FIXTURE_MIGRATIONS, applyMatchFixture, migrationStatements } from "./match-test-harness";
import { readFileSync } from "node:fs";
import { computeIdentityCryptoKeyChecks, type IdentityScope } from "@/lib/identity-hmac";

export const SNAPSHOT_TEST_NOW = new Date("2026-09-07T12:00:00Z");
export const SNAPSHOT_TEST_SCOPE = { organizationId: "snapshot-org", storeId: "snapshot-store", connectionId: "snapshot-connection" };
export const SNAPSHOT_TEST_KEYS = {
  keyring: { current: { version: "test-matching-v1", secret: Buffer.alloc(32, 17) } },
  suppressionKey: { version: "test-erasure-v1", secret: Buffer.alloc(32, 29) },
};

export async function createSnapshotTestDatabase() {
  if (process.env.SNAPSHOT_TEST_DATABASE !== "1" || !process.env.DATABASE_URL) {
    throw new Error("Snapshot DB tests require explicit disposable DATABASE_URL and SNAPSHOT_TEST_DATABASE=1");
  }
  const url = new URL(process.env.DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.startsWith("/snapshot_")) {
    throw new Error("Snapshot DB tests require a local snapshot_* disposable database");
  }
  const admin = new Pool({ connectionString: url.toString(), max: 2 });
  const databaseName = `snapshot_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString(), max: 8 });
    const db = drizzle(pool);
    await applyMatchFixture(pool);
    // Real OpenAPI integration tests authenticate through the app-owned API
    // key table. Reuse its generated DDL and user FK prerequisite unchanged.
    const userTable = migrationStatements("0010_add_auth_and_org_scoping.sql")
      .find(statement => statement.includes('CREATE TABLE IF NOT EXISTS "user"'));
    if (!userTable) throw new Error("Generated user prerequisite is missing");
    await pool.query(userTable);
    for (const statement of migrationStatements("0012_youthful_roulette.sql")) await pool.query(statement);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
    // 0000→0011 cannot replay from zero (pre-existing duplicate ad_account).
    // Use the repository's prerequisite fixture, not weakened snapshot DDL.
    // Skip whatever applyMatchFixture already applied (it reaches past 0073
    // now), otherwise a migration replays twice and fails on ADD COLUMN.
    const alreadyApplied = new Set<string>(MATCH_FIXTURE_MIGRATIONS.map(file => file.replace(/\.sql$/, "")));
    const migrations = ["0064_grey_tempest", "0066_shiny_stepford_cuckoos", "0070_majestic_peter_parker", "0071_exotic_epoch",
      ...journal.entries.filter(entry => entry.idx >= 73 && !alreadyApplied.has(entry.tag)).map(entry => entry.tag)];
    for (const migration of migrations) {
      for (const statement of migrationStatements(`${migration}.sql`)) await pool.query(statement);
    }
    return {
      pool, db, databaseName,
      async reset() { await pool!.query("TRUNCATE organization, shopify_store CASCADE"); },
      async close() {
        await pool!.end();
        await admin.query(`DROP DATABASE "${databaseName}"`);
        await admin.end();
      },
    };
  } catch (error) {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    throw error;
  }
}

export async function seedSnapshotTestConnection(pool: Pool, scope = SNAPSHOT_TEST_SCOPE, timezone = "America/New_York") {
  const checks = computeIdentityCryptoKeyChecks({ scope: scope as IdentityScope, ...SNAPSHOT_TEST_KEYS });
  await pool.query("INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now()) ON CONFLICT DO NOTHING", [scope.organizationId]);
  await pool.query("INSERT INTO shopify_store (id,organization_id,shop_domain,iana_timezone) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [scope.storeId, scope.organizationId, `${scope.storeId}.example.test`, timezone]);
  await pool.query("INSERT INTO identity_matching_key_binding (organization_id,store_id,key_version,key_check) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [scope.organizationId, scope.storeId, checks.matching[0].keyVersion, checks.matching[0].keyCheck]);
  await pool.query("INSERT INTO identity_crypto_policy (id,organization_id,store_id,matching_current_version,matching_current_key_check,suppression_version,suppression_key_check) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [randomUUID(), scope.organizationId, scope.storeId, checks.matching[0].keyVersion, checks.matching[0].keyCheck, checks.suppression.keyVersion, checks.suppression.keyCheck]);
  await pool.query("INSERT INTO klaviyo_connection (id,organization_id,shopify_store_id,klaviyo_account_id,status,timezone,identity_current_key_version,identity_current_key_check) VALUES ($1,$2,$3,$4,'ready',$5,$6,$7)", [scope.connectionId, scope.organizationId, scope.storeId, `${scope.connectionId}-account`, timezone, checks.matching[0].keyVersion, checks.matching[0].keyCheck]);
}
