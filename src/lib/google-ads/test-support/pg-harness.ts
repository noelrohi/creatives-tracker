/**
 * Shared PostgreSQL scaffolding for the Google Ads integration suites
 * (sync-store, discovery, facts-runner, gclid-probe). Each suite still owns
 * its own ephemeral database name, `vi.mock("@/db", ...)` wiring (hoisting
 * requires that block to live in the test file itself), and seeding
 * specifics — this module only centralizes the parts that were byte-for-byte
 * identical across all of them.
 *
 * NOTE: this file intentionally does not end in `.test.ts` so vitest's
 * `src/**\/*.test.ts` include glob (see vitest.config.ts) never picks it up
 * as a test file on its own.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export function migrationStatements(fileName: string): string[] {
  return readFileSync(path.resolve(process.cwd(), "drizzle", fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Hand-rolled fixture tables for the auth/shopify tables the Google Ads
 * migrations foreign-key against. These are NOT generated from a migration
 * — only the minimal columns the suites touch are declared.
 */
export const FIXTURE_DDL = [
  `CREATE TABLE organization (
     id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
     logo text, created_at timestamp NOT NULL, metadata text
   )`,
  `CREATE TABLE shopify_store (
     id text PRIMARY KEY, organization_id text NOT NULL,
     shop_domain text NOT NULL UNIQUE, access_token text,
     iana_timezone text NOT NULL, currency text, last_synced_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_store_org_id_uniq UNIQUE (organization_id, id)
   )`,
];

/**
 * Ordered migration files layered on top of FIXTURE_DDL when provisioning a
 * fresh ephemeral test database. A single shared list so a future migration
 * (e.g. 0061) only needs to be added once for every suite that uses this
 * harness.
 */
export const MIGRATION_FILES = ["0060_serious_mimic.sql"];

/** Creates the (possibly null, when no DATABASE_URL is configured) test pool/db pair for one suite's ephemeral database. */
export function createTestDatabaseHandle(database: string): {
  baseConnectionString: string | null;
  testPool: Pool | null;
  testDb: NodePgDatabase | null;
} {
  const baseConnectionString = resolveConnectionString();
  const testPool = baseConnectionString
    ? new Pool({
        connectionString: withDatabase(baseConnectionString, database),
        max: 8,
      })
    : null;
  const testDb = testPool ? drizzle(testPool) : null;
  return { baseConnectionString, testPool, testDb };
}

/**
 * Drops and recreates `database`, then applies `ddlStatements` (defaults to
 * FIXTURE_DDL) followed by `migrationFiles` (defaults to MIGRATION_FILES).
 * Returns the admin pool so the caller's `afterAll` can drop the database
 * and close it via {@link teardownTestDatabase}.
 *
 * A DROP DATABASE ... WITH (FORCE) from a leftover or concurrent run kills
 * idle clients, which surfaces as a pool-level error; without an error
 * listener on both pools that crashes the worker even when every assertion
 * passed.
 */
export async function setupTestDatabase(params: {
  baseConnectionString: string;
  testPool: Pool;
  database: string;
  ddlStatements?: string[];
  migrationFiles?: string[];
}): Promise<Pool> {
  const adminPool = new Pool({ connectionString: params.baseConnectionString });
  adminPool.on("error", () => {});
  params.testPool.on("error", () => {});
  await adminPool.query(`DROP DATABASE IF EXISTS ${params.database} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${params.database}`);
  for (const statement of params.ddlStatements ?? FIXTURE_DDL) {
    await params.testPool.query(statement);
  }
  for (const migration of params.migrationFiles ?? MIGRATION_FILES) {
    for (const statement of migrationStatements(migration)) {
      await params.testPool.query(statement);
    }
  }
  return adminPool;
}

export async function teardownTestDatabase(params: {
  adminPool: Pool | null;
  testPool: Pool | null;
  database: string;
}): Promise<void> {
  await params.testPool?.end();
  if (params.adminPool) {
    await params.adminPool.query(`DROP DATABASE IF EXISTS ${params.database} WITH (FORCE)`);
    await params.adminPool.end();
  }
}

/** Seeds the single org + store pair the pilot binding resolves against. */
export async function seedOrgAndStore(
  testPool: Pool,
  params: {
    orgId?: string;
    storeId?: string;
    shopDomain: string;
    timezone?: string;
  },
): Promise<void> {
  const orgId = params.orgId ?? "org-a";
  const storeId = params.storeId ?? "store-a";
  const timezone = params.timezone ?? "America/New_York";
  await testPool.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $1, now())`,
    [orgId, `Org ${orgId}`],
  );
  await testPool.query(
    `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
     VALUES ($1, $2, $3, $4)`,
    [storeId, orgId, params.shopDomain, timezone],
  );
}

const CONNECTION_SELECT_COLUMNS = `id, organization_id AS "organizationId", shopify_store_id AS "storeId",
       google_customer_id AS "googleCustomerId",
       descriptive_name AS "descriptiveName", currency_code AS "currencyCode",
       timezone, status, authentication_mode AS "authenticationMode",
       credential_reference AS "credentialReference",
       last_discovery_synced_at AS "lastDiscoverySyncedAt",
       last_facts_synced_at AS "lastFactsSyncedAt",
       backfill_completed_at AS "backfillCompletedAt",
       created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Re-reads a google_ads_connection row shaped like `ConnectionRecord`. */
export async function reloadGoogleAdsConnection(
  testPool: Pool,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await testPool.query(
    `SELECT ${CONNECTION_SELECT_COLUMNS} FROM google_ads_connection WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) {
    throw new Error(`connection ${id} not found`);
  }
  return result.rows[0];
}
