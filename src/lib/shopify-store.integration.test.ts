import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";

function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_shopify_store_test";
const ADVISORY_LOCK: [number, number] = [1_384_994_861, 1_816_654_769];

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const testPool = baseConnectionString
  ? new Pool({ connectionString: withDatabase(baseConnectionString, TEST_DATABASE) })
  : null;
const testDb = testPool ? drizzle(testPool) : null;
let adminPool: Pool | null = null;
let adminClient: PoolClient | null = null;
let testPoolClosed = false;
let advisoryLockHeld = false;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { ShopifyStoreOwnershipConflictError, upsertShopifyStore } = await import(
  "./shopify-ingest"
);

const FIXTURE_DDL = [
  `CREATE TABLE organization (
     id text PRIMARY KEY,
     name text NOT NULL,
     slug text NOT NULL UNIQUE,
     logo text,
     created_at timestamp NOT NULL,
     metadata text
   )`,
  `CREATE TABLE shopify_store (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     shop_domain text NOT NULL UNIQUE,
     access_token text,
     iana_timezone text NOT NULL,
     currency text,
     last_synced_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL
   )`,
];

async function createFixtureSchema() {
  for (const statement of FIXTURE_DDL) {
    await testDb!.execute(sql.raw(statement));
  }
}

async function cleanupFixture() {
  const cleanupErrors: unknown[] = [];

  if (!testPoolClosed) {
    try {
      await testPool?.end();
      testPoolClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (adminClient && advisoryLockHeld) {
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await adminClient.query("SELECT pg_advisory_unlock($1, $2)", ADVISORY_LOCK);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      advisoryLockHeld = false;
    }
  }

  if (adminClient) {
    try {
      adminClient.release();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      adminClient = null;
    }
  }

  if (adminPool) {
    try {
      await adminPool.end();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      adminPool = null;
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to clean up Shopify store test database");
  }
}

const describeIfDb = baseConnectionString ? describe : describe.skip;

describeIfDb("upsertShopifyStore ownership", () => {
  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: withDatabase(baseConnectionString!, "postgres"),
    });
    try {
      adminClient = await adminPool.connect();
      await adminClient.query("SET statement_timeout = '30s'");
      await adminClient.query("SELECT pg_advisory_lock($1, $2)", ADVISORY_LOCK);
      advisoryLockHeld = true;
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
      await adminClient.query(`CREATE DATABASE ${TEST_DATABASE}`);
      await createFixtureSchema();
    } catch (setupError) {
      try {
        await cleanupFixture();
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          "Failed to set up and clean up Shopify store test database",
        );
      }
      throw setupError;
    }
  }, 120_000);

  afterAll(async () => {
    await cleanupFixture();
  });

  beforeEach(async () => {
    await testDb!.execute(sql.raw("TRUNCATE shopify_store, organization CASCADE"));
    await testDb!.execute(sql`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES
        ('org_a', 'Org A', 'org-a', now()),
        ('org_b', 'Org B', 'org-b', now())
    `);
  });

  it("updates mutable metadata without changing the owner", async () => {
    await upsertShopifyStore({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "UTC",
      currency: "USD",
    });

    const updated = await upsertShopifyStore({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "Asia/Manila",
      currency: "PHP",
    });

    expect(updated).toMatchObject({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "Asia/Manila",
      currency: "PHP",
    });
  });

  it("rejects a domain already owned by another organization", async () => {
    await upsertShopifyStore({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "UTC",
      currency: "USD",
    });

    await expect(
      upsertShopifyStore({
        organizationId: "org_b",
        shopDomain: "reviv.myshopify.com",
        ianaTimezone: "Asia/Manila",
        currency: "PHP",
      }),
    ).rejects.toBeInstanceOf(ShopifyStoreOwnershipConflictError);

    const { rows: [stored] } = await testDb!.execute(sql`
      SELECT organization_id, iana_timezone, currency
      FROM shopify_store
      WHERE shop_domain = 'reviv.myshopify.com'
    `);
    expect(stored).toMatchObject({
      organization_id: "org_a",
      iana_timezone: "UTC",
      currency: "USD",
    });
  });

  it("allows exactly one owner under a concurrent first claim", async () => {
    const claims = await Promise.allSettled([
      upsertShopifyStore({
        organizationId: "org_a",
        shopDomain: "reviv.myshopify.com",
        ianaTimezone: "UTC",
        currency: "USD",
      }),
      upsertShopifyStore({
        organizationId: "org_b",
        shopDomain: "reviv.myshopify.com",
        ianaTimezone: "Asia/Manila",
        currency: "PHP",
      }),
    ]);

    const fulfilled = claims.filter((claim) => claim.status === "fulfilled");
    const rejected = claims.filter((claim) => claim.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [fulfilledClaim] = fulfilled;
    const [rejectedClaim] = rejected;
    if (
      !fulfilledClaim ||
      !rejectedClaim ||
      fulfilledClaim.status !== "fulfilled" ||
      rejectedClaim.status !== "rejected"
    ) {
      throw new Error("Expected one fulfilled and one rejected store claim");
    }

    expect(rejectedClaim.reason).toBeInstanceOf(ShopifyStoreOwnershipConflictError);

    const { rows: [stored] } = await testDb!.execute(sql`
      SELECT organization_id, iana_timezone, currency
      FROM shopify_store
      WHERE shop_domain = 'reviv.myshopify.com'
    `);
    expect(stored).toMatchObject({
      organization_id: fulfilledClaim.value.organizationId,
      iana_timezone: fulfilledClaim.value.ianaTimezone,
      currency: fulfilledClaim.value.currency,
    });
  });
});
