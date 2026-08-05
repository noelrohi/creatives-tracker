import { readFileSync } from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
const disposableDatabases = new Set<string>();

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

const PRE_0053_FIXTURE_DDL = [
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
  `CREATE TABLE shopify_order (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     shopify_order_id text NOT NULL,
     order_created_at timestamp NOT NULL,
     order_day date NOT NULL,
     net_sales numeric NOT NULL,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_order_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_order_store_order_uniq
       UNIQUE (store_id, shopify_order_id)
   )`,
  `CREATE TABLE shopify_refund (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     order_id text NOT NULL,
     shopify_refund_id text NOT NULL,
     refund_day date NOT NULL,
     amount numeric NOT NULL,
     kind text DEFAULT 'refund' NOT NULL,
     refund_created_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_refund_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_order_id_shopify_order_id_fk
       FOREIGN KEY (order_id) REFERENCES shopify_order(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_store_refund_uniq
       UNIQUE (store_id, shopify_refund_id)
   )`,
  `CREATE TABLE shopify_sync_run (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     trigger_type text NOT NULL,
     phase text NOT NULL,
     requested_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_sync_run_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
  `CREATE TYPE finding_type AS ENUM (
     'meta_overclaim',
     'unattributed_spike',
     'broken_utm_template',
     'sync_failure',
     'roas_below_target'
   )`,
  `CREATE TABLE finding (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text,
     type finding_type NOT NULL,
     fired_at timestamp DEFAULT now() NOT NULL,
     payload jsonb NOT NULL,
     created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT finding_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
];

const NEW_EVIDENCE_ENUMS = [
  "identity_erasure_suppression_kind",
  "identity_hmac_rotation_state",
  "shopify_evidence_capability",
  "shopify_evidence_completeness",
  "shopify_evidence_run_status",
  "source_identity_kind",
] as const;

const NEW_EVIDENCE_TABLES = [
  "identity_crypto_policy",
  "identity_erasure_suppression",
  "identity_matching_key_binding",
  "shopify_evidence_run_identity_observation",
  "shopify_evidence_run_observation",
  "shopify_evidence_sync_run",
  "shopify_order_line",
  "source_identity_hmac",
] as const;

const NEW_PARENT_AND_SCOPED_CONSTRAINTS = [
  "finding_org_store_fk",
  "shopify_order_org_store_fk",
  "shopify_order_org_store_id_uniq",
  "shopify_refund_org_store_order_fk",
  "shopify_store_org_id_uniq",
  "shopify_store_organization_id_organization_id_fk",
  "shopify_sync_run_org_store_fk",
] as const;

const LEGACY_FOREIGN_KEYS = [
  {
    name: "finding_store_id_shopify_store_id_fk",
    table_name: "finding",
    type: "f",
  },
  {
    name: "shopify_order_store_id_shopify_store_id_fk",
    table_name: "shopify_order",
    type: "f",
  },
  {
    name: "shopify_refund_order_id_shopify_order_id_fk",
    table_name: "shopify_refund",
    type: "f",
  },
  {
    name: "shopify_refund_store_id_shopify_store_id_fk",
    table_name: "shopify_refund",
    type: "f",
  },
  {
    name: "shopify_sync_run_store_id_shopify_store_id_fk",
    table_name: "shopify_sync_run",
    type: "f",
  },
] as const;

const MIGRATION_PATHS = [
  "drizzle/0053_klaviyo_shopify_evidence.sql",
  "drizzle/0054_klaviyo_source_core.sql",
  "drizzle/0055_klaviyo_advisory_matching.sql",
].map((file) => path.resolve(process.cwd(), file));

function readMigrationStatements(): string[] {
  return MIGRATION_PATHS.flatMap((migrationPath) =>
    readFileSync(migrationPath, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean),
  );
}

async function expectConstraintViolation(
  statement: string,
  expectedCode: "23503" | "23505" | "23514",
  expectedConstraint?: string,
) {
  const expectedError: { code: string; constraint?: string } = {
    code: expectedCode,
  };
  if (expectedConstraint) expectedError.constraint = expectedConstraint;
  await expect(testPool!.query(statement)).rejects.toMatchObject(expectedError);
}

async function createFixtureSchema(pool: Pool) {
  for (const statement of PRE_0053_FIXTURE_DDL) {
    await pool.query(statement);
  }
}

async function applyEvidenceMigration(pool: Pool) {
  for (const statement of readMigrationStatements()) {
    await pool.query(statement);
  }
}

async function seedPreMigrationScope(pool: Pool) {
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES
       ('org_a', 'Org A', 'org-a', now()),
       ('org_b', 'Org B', 'org-b', now())`,
  );
  await pool.query(
    `INSERT INTO shopify_store (
       id, organization_id, shop_domain, iana_timezone
     ) VALUES
       ('store_a', 'org_a', 'store-a.myshopify.com', 'UTC'),
       ('store_b', 'org_b', 'store-b.myshopify.com', 'UTC')`,
  );
}

async function readRelevantMigrationCatalog(pool: Pool) {
  const [{ rows: enumRows }, { rows: tableRows }, { rows: customerColumns }] =
    await Promise.all([
      pool.query<{ name: string }>(
        `SELECT t.typname AS name
         FROM pg_type AS t
         JOIN pg_namespace AS n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public'
           AND t.typname = ANY($1::text[])
         ORDER BY t.typname`,
        [[...NEW_EVIDENCE_ENUMS]],
      ),
      pool.query<{ name: string }>(
        `SELECT c.relname AS name
         FROM pg_class AS c
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [[...NEW_EVIDENCE_TABLES]],
      ),
      pool.query<{ column_name: string; table_name: string }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'shopify_order'
           AND column_name = 'shopify_customer_id'
         ORDER BY table_name, column_name`,
      ),
    ]);

  const readConstraints = (names: readonly string[]) =>
    pool.query<{ name: string; table_name: string; type: string }>(
      `SELECT con.conname AS name, cls.relname AS table_name, con.contype AS type
       FROM pg_constraint AS con
       JOIN pg_class AS cls ON cls.oid = con.conrelid
       JOIN pg_namespace AS n ON n.oid = cls.relnamespace
       WHERE n.nspname = 'public'
         AND con.conname = ANY($1::text[])
       ORDER BY con.conname`,
      [[...names]],
    );
  const [{ rows: newConstraints }, { rows: legacyForeignKeys }] =
    await Promise.all([
      readConstraints(NEW_PARENT_AND_SCOPED_CONSTRAINTS),
      readConstraints(LEGACY_FOREIGN_KEYS.map(({ name }) => name)),
    ]);

  return {
    newEnums: enumRows.map(({ name }) => name),
    newEvidenceTables: tableRows.map(({ name }) => name),
    customerColumns,
    newParentAndScopedConstraints: newConstraints,
    legacyForeignKeys,
  };
}

async function verifyMigrationPreflight({
  databaseSuffix,
  expectedMessage,
  seedMismatch,
}: {
  databaseSuffix: string;
  expectedMessage: string;
  seedMismatch: (pool: Pool) => Promise<void>;
}) {
  const database = `adsolute_shopify_evidence_preflight_${databaseSuffix}`;
  if (!/^[a-z0-9_]+$/.test(database)) {
    throw new Error("Unsafe preflight database name");
  }

  disposableDatabases.add(database);
  await adminClient!.query(`DROP DATABASE IF EXISTS ${database}`);
  await adminClient!.query(`CREATE DATABASE ${database}`);
  const pool = new Pool({
    connectionString: withDatabase(baseConnectionString!, database),
  });

  try {
    await createFixtureSchema(pool);
    await seedMismatch(pool);
    const catalogBeforeMigration = await readRelevantMigrationCatalog(pool);

    expect(catalogBeforeMigration).toEqual({
      newEnums: [],
      newEvidenceTables: [],
      customerColumns: [],
      newParentAndScopedConstraints: [],
      legacyForeignKeys: LEGACY_FOREIGN_KEYS,
    });

    let migrationError: unknown;
    try {
      await applyEvidenceMigration(pool);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({ code: "P0001" });
    expect(String(migrationError)).toContain(expectedMessage);

    const catalogAfterFailure = await readRelevantMigrationCatalog(pool);
    expect(catalogAfterFailure).toEqual(catalogBeforeMigration);
  } finally {
    await pool.end();
    await adminClient!.query(`DROP DATABASE IF EXISTS ${database}`);
    disposableDatabases.delete(database);
  }
}

async function insertEvidenceGraph() {
  await testPool!.query(
    `INSERT INTO shopify_evidence_sync_run (
       id, start_trigger_run_id, organization_id, store_id, mode,
       store_timezone, anchor_store_day, requested_from, requested_to
     ) VALUES (
       'run_a', 'trigger-run-a', 'org_a', 'store_a', 'incremental_7d',
       'UTC', '2026-08-03', now() - interval '1 day', now()
     )`,
  );
  await testPool!.query(
    `INSERT INTO shopify_order_line (
       id, organization_id, store_id, order_id, shopify_line_item_id,
       product_title, quantity, parent_order_updated_at
     ) VALUES (
       'line_a', 'org_a', 'store_a', 'order_a', 'external-line-a',
       'Product', 1, now()
     )`,
  );
  await testPool!.query(
    `INSERT INTO source_identity_hmac (
       id, organization_id, store_id, source_kind, shopify_order_id,
       key_version, digest, rotation_state
     ) VALUES (
       'hmac_a', 'org_a', 'store_a', 'shopify_order', 'order_a',
       'v1', 'digest-a', 'active'
     )`,
  );
  await testPool!.query(
    `INSERT INTO shopify_evidence_run_observation (
       id, organization_id, store_id, evidence_run_id, order_id,
       line_disposition, identity_disposition, observed_content_checksum
     ) VALUES (
       'observation_a', 'org_a', 'store_a', 'run_a', 'order_a',
       'complete', 'available', 'checksum-a'
     )`,
  );
  await testPool!.query(
    `INSERT INTO shopify_evidence_run_identity_observation (
       id, organization_id, store_id, evidence_run_id, order_id,
       identity_hmac_id
     ) VALUES (
       'identity_observation_a', 'org_a', 'store_a', 'run_a', 'order_a',
       'hmac_a'
     )`,
  );
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
    for (const database of disposableDatabases) {
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS ${database}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    disposableDatabases.clear();

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
      await createFixtureSchema(testPool!);
      await applyEvidenceMigration(testPool!);
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
    await testDb!.execute(sql`
      INSERT INTO shopify_store (
        id,
        organization_id,
        shop_domain,
        iana_timezone
      )
      VALUES
        ('store_a', 'org_a', 'store-a.myshopify.com', 'UTC'),
        ('store_b', 'org_b', 'store-b.myshopify.com', 'UTC')
    `);
    await testDb!.execute(sql`
      INSERT INTO shopify_order (
        id,
        organization_id,
        store_id,
        shopify_order_id,
        order_created_at,
        order_day,
        net_sales
      )
      VALUES
        ('order_a', 'org_a', 'store_a', 'shopify-order-a', now(), current_date, 10),
        ('order_b', 'org_b', 'store_b', 'shopify-order-b', now(), current_date, 20)
    `);
  });

  describe("migration mismatch preflights", () => {
    it("rejects an orphaned Shopify store before any 0053 mutation", async () => {
      await verifyMigrationPreflight({
        databaseSuffix: "store",
        expectedMessage: "shopify_store organization scope preflight failed",
        seedMismatch: async (pool) => {
          await pool.query(
            `INSERT INTO organization (id, name, slug, created_at)
             VALUES ('org_a', 'Org A', 'org-a', now())`,
          );
          await pool.query(
            `INSERT INTO shopify_store (
               id, organization_id, shop_domain, iana_timezone
             ) VALUES (
               'store_orphan', 'org_missing', 'orphan.myshopify.com', 'UTC'
             )`,
          );
        },
      });
    });

    it("rejects an order outside its store organization before mutation", async () => {
      await verifyMigrationPreflight({
        databaseSuffix: "order",
        expectedMessage: "shopify_order store scope preflight failed",
        seedMismatch: async (pool) => {
          await seedPreMigrationScope(pool);
          await pool.query(
            `INSERT INTO shopify_order (
               id, organization_id, store_id, shopify_order_id,
               order_created_at, order_day, net_sales
             ) VALUES (
               'order_bad', 'org_b', 'store_a', 'shopify-order-bad',
               now(), current_date, 10
             )`,
          );
        },
      });
    });

    it("rejects a refund outside its exact order scope before mutation", async () => {
      await verifyMigrationPreflight({
        databaseSuffix: "refund",
        expectedMessage: "shopify_refund order scope preflight failed",
        seedMismatch: async (pool) => {
          await seedPreMigrationScope(pool);
          await pool.query(
            `INSERT INTO shopify_order (
               id, organization_id, store_id, shopify_order_id,
               order_created_at, order_day, net_sales
             ) VALUES (
               'order_a', 'org_a', 'store_a', 'shopify-order-a',
               now(), current_date, 10
             )`,
          );
          await pool.query(
            `INSERT INTO shopify_refund (
               id, organization_id, store_id, order_id, shopify_refund_id,
               refund_day, amount
             ) VALUES (
               'refund_bad', 'org_b', 'store_a', 'order_a',
               'shopify-refund-bad', current_date, 1
             )`,
          );
        },
      });
    });

    it("rejects a sync run outside its store organization before mutation", async () => {
      await verifyMigrationPreflight({
        databaseSuffix: "sync_run",
        expectedMessage: "shopify_sync_run store scope preflight failed",
        seedMismatch: async (pool) => {
          await seedPreMigrationScope(pool);
          await pool.query(
            `INSERT INTO shopify_sync_run (
               id, organization_id, store_id, trigger_type, phase
             ) VALUES ('sync_bad', 'org_b', 'store_a', 'manual', 'backfill')`,
          );
        },
      });
    });

    it("rejects a finding outside its store organization before mutation", async () => {
      await verifyMigrationPreflight({
        databaseSuffix: "finding",
        expectedMessage: "finding store scope preflight failed",
        seedMismatch: async (pool) => {
          await seedPreMigrationScope(pool);
          await pool.query(
            `INSERT INTO finding (
               id, organization_id, store_id, type, payload
             ) VALUES (
               'finding_bad', 'org_b', 'store_a', 'sync_failure', '{}'::jsonb
             )`,
          );
        },
      });
    });
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

  describe("scoped Shopify parent constraints", () => {
    it("installs only the named scoped foreign keys", async () => {
      const { rows } = await testPool!.query<{
        conname: string;
        definition: string;
      }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conname IN (
           'shopify_order_org_store_fk',
           'shopify_refund_org_store_order_fk',
           'shopify_sync_run_org_store_fk',
           'finding_org_store_fk',
           'shopify_order_store_id_shopify_store_id_fk',
           'shopify_refund_store_id_shopify_store_id_fk',
           'shopify_refund_order_id_shopify_order_id_fk',
           'shopify_sync_run_store_id_shopify_store_id_fk',
           'finding_store_id_shopify_store_id_fk'
         )
         ORDER BY conname`,
      );

      expect(rows).toEqual([
        {
          conname: "finding_org_store_fk",
          definition:
            "FOREIGN KEY (organization_id, store_id) REFERENCES shopify_store(organization_id, id) ON DELETE CASCADE",
        },
        {
          conname: "shopify_order_org_store_fk",
          definition:
            "FOREIGN KEY (organization_id, store_id) REFERENCES shopify_store(organization_id, id) ON DELETE CASCADE",
        },
        {
          conname: "shopify_refund_org_store_order_fk",
          definition:
            "FOREIGN KEY (organization_id, store_id, order_id) REFERENCES shopify_order(organization_id, store_id, id) ON DELETE CASCADE",
        },
        {
          conname: "shopify_sync_run_org_store_fk",
          definition:
            "FOREIGN KEY (organization_id, store_id) REFERENCES shopify_store(organization_id, id) ON DELETE CASCADE",
        },
      ]);
    });

    it("accepts matching order, refund, sync-run, and finding scopes", async () => {
      await testPool!.query(
        `INSERT INTO shopify_order (
           id, organization_id, store_id, shopify_order_id,
           order_created_at, order_day, net_sales
         ) VALUES (
           'order_matching', 'org_a', 'store_a', 'shopify-order-matching',
           now(), current_date, 30
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_refund (
           id, organization_id, store_id, order_id, shopify_refund_id,
           refund_day, amount
         ) VALUES (
           'refund_matching', 'org_a', 'store_a', 'order_matching',
           'shopify-refund-matching', current_date, 3
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_sync_run (
           id, organization_id, store_id, trigger_type, phase
         ) VALUES ('sync_matching', 'org_a', 'store_a', 'manual', 'backfill')`,
      );
      await testPool!.query(
        `INSERT INTO finding (
           id, organization_id, store_id, type, payload
         ) VALUES (
           'finding_matching', 'org_a', 'store_a', 'sync_failure', '{}'::jsonb
         )`,
      );

      const { rows: [counts] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM shopify_order WHERE id = 'order_matching') AS orders,
           (SELECT count(*)::int FROM shopify_refund WHERE id = 'refund_matching') AS refunds,
           (SELECT count(*)::int FROM shopify_sync_run WHERE id = 'sync_matching') AS sync_runs,
           (SELECT count(*)::int FROM finding WHERE id = 'finding_matching') AS findings`,
      );
      expect(counts).toEqual({ orders: 1, refunds: 1, sync_runs: 1, findings: 1 });
    });

    it("rejects an order outside its store organization", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_order (
           id, organization_id, store_id, shopify_order_id,
           order_created_at, order_day, net_sales
         ) VALUES (
           'order_bad_scope', 'org_b', 'store_a', 'shopify-order-bad-scope',
           now(), current_date, 10
         )`,
        "23503",
      );
    });

    it("rejects a refund outside its exact organization/store/order scope", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_refund (
           id, organization_id, store_id, order_id, shopify_refund_id,
           refund_day, amount
         ) VALUES (
           'refund_bad_scope', 'org_b', 'store_a', 'order_a',
           'shopify-refund-bad-scope', current_date, 1
         )`,
        "23503",
      );
    });

    it("rejects a monetary sync run outside its store organization", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_sync_run (
           id, organization_id, store_id, trigger_type, phase
         ) VALUES ('sync_bad_scope', 'org_b', 'store_a', 'manual', 'backfill')`,
        "23503",
      );
    });

    it("rejects a finding outside its store organization", async () => {
      await expectConstraintViolation(
        `INSERT INTO finding (
           id, organization_id, store_id, type, payload
         ) VALUES (
           'finding_bad_scope', 'org_b', 'store_a', 'sync_failure', '{}'::jsonb
         )`,
        "23503",
      );
    });

    it("allows an organization-scoped finding without a store", async () => {
      await testPool!.query(
        `INSERT INTO finding (
           id, organization_id, store_id, type, payload
         ) VALUES (
           'finding_without_store', 'org_a', NULL, 'sync_failure', '{}'::jsonb
         )`,
      );

      const { rows: [finding] } = await testPool!.query(
        `SELECT organization_id, store_id
         FROM finding
         WHERE id = 'finding_without_store'`,
      );
      expect(finding).toEqual({ organization_id: "org_a", store_id: null });
    });
  });

  describe("Shopify evidence cascades and run constraints", () => {
    it("cascades direct store deletion while preserving its organization and organization-only findings", async () => {
      await testPool!.query(
        `INSERT INTO shopify_store (
           id, organization_id, shop_domain, iana_timezone
         ) VALUES (
           'store_a_control', 'org_a', 'store-a-control.myshopify.com', 'UTC'
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_order (
           id, organization_id, store_id, shopify_order_id,
           order_created_at, order_day, net_sales
         ) VALUES (
           'order_a_control', 'org_a', 'store_a_control',
           'shopify-order-a-control', now(), current_date, 30
         )`,
      );
      await insertEvidenceGraph();
      await testPool!.query(
        `INSERT INTO shopify_refund (
           id, organization_id, store_id, order_id, shopify_refund_id,
           refund_day, amount
         ) VALUES (
           'refund_a', 'org_a', 'store_a', 'order_a', 'shopify-refund-a',
           current_date, 1
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_sync_run (
           id, organization_id, store_id, trigger_type, phase
         ) VALUES ('sync_a', 'org_a', 'store_a', 'manual', 'backfill')`,
      );
      await testPool!.query(
        `INSERT INTO finding (id, organization_id, store_id, type, payload)
         VALUES
           ('finding_a', 'org_a', 'store_a', 'sync_failure', '{}'::jsonb),
           ('finding_org_a', 'org_a', NULL, 'sync_failure', '{}'::jsonb)`,
      );
      await testPool!.query(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES
           ('org_a', 'store_a', 'v2', 'target-current-check'),
           ('org_a', 'store_a', 'v1', 'target-previous-check'),
           ('org_a', 'store_a_control', 'v2', 'control-current-check'),
           ('org_a', 'store_a_control', 'v1', 'control-previous-check')`,
      );
      await testPool!.query(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, matching_previous_version,
           matching_previous_key_check, suppression_version,
           suppression_key_check
         ) VALUES
           (
             'policy_target', 'org_a', 'store_a', 'v2',
             'target-current-check', 'v1', 'target-previous-check',
             'e1', 'target-suppression-check'
           ),
           (
             'policy_control', 'org_a', 'store_a_control', 'v2',
             'control-current-check', 'v1', 'control-previous-check',
             'e1', 'control-suppression-check'
           )`,
      );
      await testPool!.query(
        `INSERT INTO identity_erasure_suppression (
           id, organization_id, store_id, kind, key_version, digest
         ) VALUES
           ('suppression_target', 'org_a', 'store_a', 'email', 'e1', 'target-digest'),
           ('suppression_control', 'org_a', 'store_a_control', 'email', 'e1', 'control-digest')`,
      );

      const { rows: [authorityBeforeDeletion] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE store_id = 'store_a') AS target_bindings,
           (SELECT count(*)::int FROM identity_crypto_policy WHERE store_id = 'store_a') AS target_policies,
           (SELECT count(*)::int FROM identity_erasure_suppression WHERE store_id = 'store_a') AS target_suppressions,
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE store_id = 'store_a_control') AS control_bindings,
           (SELECT count(*)::int FROM identity_crypto_policy WHERE store_id = 'store_a_control') AS control_policies,
           (SELECT count(*)::int FROM identity_erasure_suppression WHERE store_id = 'store_a_control') AS control_suppressions`,
      );
      expect(authorityBeforeDeletion).toEqual({
        target_bindings: 2,
        target_policies: 1,
        target_suppressions: 1,
        control_bindings: 2,
        control_policies: 1,
        control_suppressions: 1,
      });

      await testPool!.query("DELETE FROM shopify_store WHERE id = 'store_a'");

      const { rows: [counts] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM organization WHERE id = 'org_a') AS organizations,
           (SELECT count(*)::int FROM shopify_store WHERE id = 'store_a') AS target_stores,
           (SELECT count(*)::int FROM shopify_store WHERE id = 'store_a_control') AS control_stores,
           (SELECT count(*)::int FROM shopify_order WHERE id = 'order_a') AS target_orders,
           (SELECT count(*)::int FROM shopify_order WHERE id = 'order_a_control') AS control_orders,
           (SELECT count(*)::int FROM shopify_refund WHERE id = 'refund_a') AS refunds,
           (SELECT count(*)::int FROM shopify_sync_run WHERE id = 'sync_a') AS sync_runs,
           (SELECT count(*)::int FROM finding WHERE id = 'finding_a') AS store_findings,
           (SELECT count(*)::int FROM finding WHERE id = 'finding_org_a') AS organization_findings,
           (SELECT count(*)::int FROM shopify_order_line WHERE id = 'line_a') AS lines,
           (SELECT count(*)::int FROM source_identity_hmac WHERE id = 'hmac_a') AS hmacs,
           (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE id = 'run_a') AS evidence_runs,
           (SELECT count(*)::int FROM shopify_evidence_run_observation WHERE id = 'observation_a') AS observations,
           (SELECT count(*)::int FROM shopify_evidence_run_identity_observation WHERE id = 'identity_observation_a') AS identities,
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE store_id = 'store_a') AS target_bindings,
           (SELECT count(*)::int FROM identity_crypto_policy WHERE store_id = 'store_a') AS target_policies,
           (SELECT count(*)::int FROM identity_erasure_suppression WHERE store_id = 'store_a') AS target_suppressions,
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE store_id = 'store_a_control') AS control_bindings,
           (SELECT count(*)::int FROM identity_crypto_policy WHERE store_id = 'store_a_control') AS control_policies,
           (SELECT count(*)::int FROM identity_erasure_suppression WHERE store_id = 'store_a_control') AS control_suppressions`,
      );
      expect(counts).toEqual({
        organizations: 1,
        target_stores: 0,
        control_stores: 1,
        target_orders: 0,
        control_orders: 1,
        refunds: 0,
        sync_runs: 0,
        store_findings: 0,
        organization_findings: 1,
        lines: 0,
        hmacs: 0,
        evidence_runs: 0,
        observations: 0,
        identities: 0,
        target_bindings: 0,
        target_policies: 0,
        target_suppressions: 0,
        control_bindings: 2,
        control_policies: 1,
        control_suppressions: 1,
      });
    });

    it("cascades organization deletion through store, order, and evidence children", async () => {
      await insertEvidenceGraph();
      await testPool!.query(
        `INSERT INTO shopify_refund (
           id, organization_id, store_id, order_id, shopify_refund_id,
           refund_day, amount
         ) VALUES (
           'refund_a', 'org_a', 'store_a', 'order_a', 'shopify-refund-a',
           current_date, 1
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_sync_run (
           id, organization_id, store_id, trigger_type, phase
         ) VALUES ('sync_a', 'org_a', 'store_a', 'manual', 'backfill')`,
      );
      await testPool!.query(
        `INSERT INTO finding (id, organization_id, store_id, type, payload)
         VALUES ('finding_a', 'org_a', 'store_a', 'sync_failure', '{}'::jsonb)`,
      );

      await testPool!.query("DELETE FROM organization WHERE id = 'org_a'");

      const { rows: [counts] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM shopify_store WHERE organization_id = 'org_a') AS stores,
           (SELECT count(*)::int FROM shopify_order WHERE organization_id = 'org_a') AS orders,
           (SELECT count(*)::int FROM shopify_refund WHERE organization_id = 'org_a') AS refunds,
           (SELECT count(*)::int FROM shopify_sync_run WHERE organization_id = 'org_a') AS sync_runs,
           (SELECT count(*)::int FROM finding WHERE organization_id = 'org_a') AS findings,
           (SELECT count(*)::int FROM shopify_order_line WHERE organization_id = 'org_a') AS lines,
           (SELECT count(*)::int FROM source_identity_hmac WHERE organization_id = 'org_a') AS hmacs,
           (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE organization_id = 'org_a') AS evidence_runs,
           (SELECT count(*)::int FROM shopify_evidence_run_observation WHERE organization_id = 'org_a') AS observations,
           (SELECT count(*)::int FROM shopify_evidence_run_identity_observation WHERE organization_id = 'org_a') AS identities`,
      );
      expect(counts).toEqual({
        stores: 0,
        orders: 0,
        refunds: 0,
        sync_runs: 0,
        findings: 0,
        lines: 0,
        hmacs: 0,
        evidence_runs: 0,
        observations: 0,
        identities: 0,
      });
    });

    it("cascades order deletion through line, HMAC, content, and identity observations", async () => {
      await insertEvidenceGraph();

      await testPool!.query("DELETE FROM shopify_order WHERE id = 'order_a'");

      const { rows: [counts] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM shopify_order_line WHERE order_id = 'order_a') AS lines,
           (SELECT count(*)::int FROM source_identity_hmac WHERE shopify_order_id = 'order_a') AS hmacs,
           (SELECT count(*)::int FROM shopify_evidence_run_observation WHERE order_id = 'order_a') AS observations,
           (SELECT count(*)::int FROM shopify_evidence_run_identity_observation WHERE order_id = 'order_a') AS identities,
           (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE id = 'run_a') AS runs`,
      );
      expect(counts).toEqual({
        lines: 0,
        hmacs: 0,
        observations: 0,
        identities: 0,
        runs: 1,
      });
    });

    it("cascades evidence-run deletion through content and identity observations", async () => {
      await insertEvidenceGraph();

      await testPool!.query("DELETE FROM shopify_evidence_sync_run WHERE id = 'run_a'");

      const { rows: [counts] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM shopify_evidence_run_observation WHERE evidence_run_id = 'run_a') AS observations,
           (SELECT count(*)::int FROM shopify_evidence_run_identity_observation WHERE evidence_run_id = 'run_a') AS identities,
           (SELECT count(*)::int FROM source_identity_hmac WHERE id = 'hmac_a') AS hmacs`,
      );
      expect(counts).toEqual({ observations: 0, identities: 0, hmacs: 1 });
    });

    it("cascades direct source-HMAC deletion only to its identity observation", async () => {
      await insertEvidenceGraph();

      const readGraphState = async () => {
        const { rows: [state] } = await testPool!.query(
          `SELECT
             (SELECT count(*)::int FROM shopify_order WHERE id = 'order_a') AS orders,
             (SELECT count(*)::int FROM shopify_order_line WHERE id = 'line_a') AS lines,
             (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE id = 'run_a') AS runs,
             (SELECT count(*)::int FROM shopify_evidence_run_observation WHERE id = 'observation_a') AS observations,
             (SELECT count(*)::int FROM source_identity_hmac WHERE id = 'hmac_a') AS hmacs,
             (SELECT count(*)::int FROM shopify_evidence_run_identity_observation WHERE id = 'identity_observation_a') AS identities`,
        );
        return state;
      };

      expect(await readGraphState()).toEqual({
        orders: 1,
        lines: 1,
        runs: 1,
        observations: 1,
        hmacs: 1,
        identities: 1,
      });

      const { rows: deletedHmacs } = await testPool!.query(
        `DELETE FROM source_identity_hmac
         WHERE id = 'hmac_a'
         RETURNING id`,
      );
      expect(deletedHmacs).toEqual([{ id: "hmac_a" }]);
      expect(await readGraphState()).toEqual({
        orders: 1,
        lines: 1,
        runs: 1,
        observations: 1,
        hmacs: 0,
        identities: 0,
      });
    });

    it("rejects invalid evidence windows and modes", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_bad_window', 'trigger-bad-window', 'org_a', 'store_a',
           'incremental_7d', 'UTC', '2026-08-03', now(), now()
         )`,
        "23514",
      );
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_bad_mode', 'trigger-bad-mode', 'org_a', 'store_a',
           'full_history', 'UTC', '2026-08-03', now() - interval '1 day', now()
         )`,
        "23514",
      );
    });

    it("enforces unique start Trigger run IDs", async () => {
      await testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to,
           status
         ) VALUES (
           'run_terminal_a', 'trigger-duplicate', 'org_a', 'store_a',
           'incremental_7d', 'UTC', '2026-08-03',
           now() - interval '1 day', now(), 'success'
         )`,
      );
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to,
           status
         ) VALUES (
           'run_terminal_b', 'trigger-duplicate', 'org_a', 'store_a',
           'incremental_7d', 'UTC', '2026-08-03',
           now() - interval '1 day', now(), 'failed'
         )`,
        "23505",
      );
    });

    it("allows terminal runs to coexist but only one running run per store", async () => {
      await testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to,
           status
         ) VALUES
           (
             'run_success', 'trigger-success', 'org_a', 'store_a',
             'incremental_7d', 'UTC', '2026-08-03',
             now() - interval '1 day', now(), 'success'
           ),
           (
             'run_failed', 'trigger-failed', 'org_a', 'store_a',
             'incremental_7d', 'UTC', '2026-08-03',
             now() - interval '1 day', now(), 'failed'
           ),
           (
             'run_running', 'trigger-running', 'org_a', 'store_a',
             'incremental_7d', 'UTC', '2026-08-03',
             now() - interval '1 day', now(), 'running'
           )`,
      );
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_running_duplicate', 'trigger-running-duplicate',
           'org_a', 'store_a', 'incremental_7d', 'UTC', '2026-08-03',
           now() - interval '1 day', now()
         )`,
        "23505",
      );
    });

    it("rejects invalid line and identity dispositions", async () => {
      await testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_a', 'trigger-run-a', 'org_a', 'store_a', 'incremental_7d',
           'UTC', '2026-08-03', now() - interval '1 day', now()
         )`,
      );
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_bad_line', 'org_a', 'store_a', 'run_a', 'order_a',
           'missing', 'available', 'checksum-a'
         )`,
        "23514",
      );
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_bad_identity', 'org_a', 'store_a', 'run_a', 'order_a',
           'complete', 'unknown', 'checksum-b'
         )`,
        "23514",
      );
    });

    it("enforces one identity observation per store/run/order", async () => {
      await insertEvidenceGraph();
      await testPool!.query(
        `INSERT INTO source_identity_hmac (
           id, organization_id, store_id, source_kind, shopify_order_id,
           key_version, digest, rotation_state
         ) VALUES (
           'hmac_a_v2', 'org_a', 'store_a', 'shopify_order', 'order_a',
           'v2', 'digest-a-v2', 'active'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_identity_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           identity_hmac_id
         ) VALUES (
           'identity_observation_duplicate', 'org_a', 'store_a', 'run_a',
           'order_a', 'hmac_a_v2'
         )`,
        "23505",
      );
    });
  });

  describe("Shopify evidence constraints", () => {
    it("rejects an order line outside its exact organization/store/order scope", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_order_line (
           id, organization_id, store_id, order_id, shopify_line_item_id,
           product_title, quantity, parent_order_updated_at
         ) VALUES (
           'line_bad_scope', 'org_a', 'store_a', 'order_b', 'external-line-1',
           'Product', 1, now()
         )`,
        "23503",
      );
    });

    it("rejects a duplicate Shopify line item within one store", async () => {
      await testPool!.query(
        `INSERT INTO shopify_order_line (
           id, organization_id, store_id, order_id, shopify_line_item_id,
           product_title, quantity, parent_order_updated_at
         ) VALUES (
           'line_a', 'org_a', 'store_a', 'order_a', 'external-line-1',
           'Product', 1, now()
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_order_line (
           id, organization_id, store_id, order_id, shopify_line_item_id,
           product_title, quantity, parent_order_updated_at
         ) VALUES (
           'line_duplicate', 'org_a', 'store_a', 'order_a', 'external-line-1',
           'Product', 2, now()
         )`,
        "23505",
      );
    });

    it("rejects an order line with quantity zero", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_order_line (
           id, organization_id, store_id, order_id, shopify_line_item_id,
           product_title, quantity, parent_order_updated_at
         ) VALUES (
           'line_zero', 'org_a', 'store_a', 'order_a', 'external-line-zero',
           'Product', 0, now()
         )`,
        "23514",
      );
    });

    it("rejects a source HMAC outside its exact organization/store/order scope", async () => {
      await expectConstraintViolation(
        `INSERT INTO source_identity_hmac (
           id, organization_id, store_id, source_kind, shopify_order_id,
           key_version, digest, rotation_state
         ) VALUES (
           'hmac_bad_order_scope', 'org_a', 'store_a', 'shopify_order',
           'order_b', 'v1', 'digest-bad-scope', 'active'
         )`,
        "23503",
        "source_identity_hmac_shopify_order_fk",
      );

      const { rows: [state] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM source_identity_hmac WHERE id = 'hmac_bad_order_scope') AS rejected_hmacs,
           (SELECT count(*)::int FROM shopify_order WHERE id IN ('order_a', 'order_b')) AS parent_orders`,
      );
      expect(state).toEqual({ rejected_hmacs: 0, parent_orders: 2 });
    });

    it("rejects a duplicate source identity version for one Shopify order", async () => {
      await testPool!.query(
        `INSERT INTO source_identity_hmac (
           id, organization_id, store_id, source_kind, shopify_order_id,
           key_version, digest, rotation_state
         ) VALUES (
           'hmac_a', 'org_a', 'store_a', 'shopify_order', 'order_a',
           'v1', 'digest-a', 'active'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO source_identity_hmac (
           id, organization_id, store_id, source_kind, shopify_order_id,
           key_version, digest, rotation_state
         ) VALUES (
           'hmac_duplicate', 'org_a', 'store_a', 'shopify_order', 'order_a',
           'v1', 'digest-b', 'rotation_previous'
         )`,
        "23505",
      );
    });

    it("rejects an evidence run outside its exact organization/store scope", async () => {
      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_bad_store_scope', 'trigger-bad-store-scope', 'org_a', 'store_b',
           'incremental_7d', 'UTC', current_date,
           now() - interval '1 day', now()
         )`,
        "23503",
        "shopify_evidence_sync_run_org_store_fk",
      );

      const { rows: [state] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE id = 'run_bad_store_scope') AS rejected_runs,
           (SELECT count(*)::int FROM shopify_store WHERE id = 'store_b' AND organization_id = 'org_b') AS parent_stores`,
      );
      expect(state).toEqual({ rejected_runs: 0, parent_stores: 1 });
    });

    it("rejects content observations outside their exact run and order scopes", async () => {
      await testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES
           (
             'run_a', 'trigger-run-a', 'org_a', 'store_a', 'initial_90d',
             'UTC', '2026-08-03', now() - interval '1 day', now()
           ),
           (
             'run_b', 'trigger-run-b', 'org_b', 'store_b', 'initial_90d',
             'UTC', '2026-08-03', now() - interval '1 day', now()
           )`,
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_bad_run_scope', 'org_a', 'store_a', 'run_b', 'order_a',
           'complete', 'available', 'run-scope-checksum'
         )`,
        "23503",
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_bad_order_scope', 'org_a', 'store_a', 'run_a', 'order_b',
           'complete', 'available', 'order-scope-checksum'
         )`,
        "23503",
      );
    });

    it("rejects duplicate order membership in one evidence run", async () => {
      await testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_a', 'trigger-run-a', 'org_a', 'store_a', 'incremental_7d',
           'UTC', current_date, now() - interval '1 day', now()
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_a', 'org_a', 'store_a', 'run_a', 'order_a',
           'complete', 'available', 'checksum-a'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_duplicate', 'org_a', 'store_a', 'run_a', 'order_a',
           'preserved_partial', 'not_refreshed', 'checksum-b'
         )`,
        "23505",
      );
    });

    it("rejects identity observations outside their exact content and HMAC scopes", async () => {
      await testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to
         ) VALUES (
           'run_a', 'trigger-run-a', 'org_a', 'store_a', 'incremental_7d',
           'UTC', current_date, now() - interval '1 day', now()
         )`,
      );
      await testPool!.query(
        `INSERT INTO source_identity_hmac (
           id, organization_id, store_id, source_kind, shopify_order_id,
           key_version, digest, rotation_state
         ) VALUES (
           'hmac_a', 'org_a', 'store_a', 'shopify_order', 'order_a',
           'v1', 'digest-a', 'active'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_identity_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           identity_hmac_id
         ) VALUES (
           'identity_observation_without_content', 'org_a', 'store_a', 'run_a',
           'order_a', 'hmac_a'
         )`,
        "23503",
      );

      await testPool!.query(
        `INSERT INTO shopify_evidence_run_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           line_disposition, identity_disposition, observed_content_checksum
         ) VALUES (
           'observation_a', 'org_a', 'store_a', 'run_a', 'order_a',
           'complete', 'available', 'checksum-a'
         )`,
      );
      await testPool!.query(
        `INSERT INTO source_identity_hmac (
           id, organization_id, store_id, source_kind, shopify_order_id,
           key_version, digest, rotation_state
         ) VALUES (
           'hmac_b', 'org_b', 'store_b', 'shopify_order', 'order_b',
           'v1', 'digest-b', 'active'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO shopify_evidence_run_identity_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           identity_hmac_id
         ) VALUES (
           'identity_observation_bad_hmac_scope', 'org_a', 'store_a', 'run_a',
           'order_a', 'hmac_b'
         )`,
        "23503",
      );
    });

    it("rejects a suppression outside its exact organization/store scope", async () => {
      await expectConstraintViolation(
        `INSERT INTO identity_erasure_suppression (
           id, organization_id, store_id, kind, key_version, digest
         ) VALUES (
           'suppression_bad_scope', 'org_a', 'store_b', 'email', 'e1', 'digest-a'
         )`,
        "23503",
      );
    });

    it("deduplicates one suppression digest within its scoped identity", async () => {
      await testPool!.query(
        `INSERT INTO identity_erasure_suppression (
           id, organization_id, store_id, kind, key_version, digest
         ) VALUES (
           'suppression_a', 'org_a', 'store_a', 'email', 'e1', 'digest-a'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO identity_erasure_suppression (
           id, organization_id, store_id, kind, key_version, digest
         ) VALUES (
           'suppression_duplicate', 'org_a', 'store_a', 'email', 'e1', 'digest-a'
         )`,
        "23505",
      );
    });

    it("rejects a matching-key binding outside its exact organization/store scope", async () => {
      await expectConstraintViolation(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES ('org_a', 'store_b', 'v1', 'bad-scope-check')`,
        "23503",
        "identity_matching_key_binding_org_store_fk",
      );

      const { rows: [state] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE key_check = 'bad-scope-check') AS rejected_bindings,
           (SELECT count(*)::int FROM shopify_store WHERE id = 'store_b' AND organization_id = 'org_b') AS parent_stores`,
      );
      expect(state).toEqual({ rejected_bindings: 0, parent_stores: 1 });
    });

    it("binds one matching key label to one key check for a store", async () => {
      await testPool!.query(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES ('org_a', 'store_a', 'v1', 'check-a')`,
      );

      await expectConstraintViolation(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES ('org_a', 'store_a', 'v1', 'check-b')`,
        "23505",
      );
    });

    it("rejects a crypto policy outside its exact organization/store scope", async () => {
      await testPool!.query(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES ('org_a', 'store_a', 'v1', 'registered-check')`,
      );

      // The mismatched policy tuple also cannot resolve its binding tuple. The
      // migration installs the store-scope FK first, and PostgreSQL reports its
      // exact catalog name here; the registered binding remains a control row.
      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, suppression_version, suppression_key_check
         ) VALUES (
           'policy_bad_store_scope', 'org_a', 'store_b', 'v1',
           'registered-check', 'e1', 'suppression-check'
         )`,
        "23503",
        "identity_crypto_policy_org_store_fk",
      );

      const { rows: [state] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM identity_crypto_policy WHERE id = 'policy_bad_store_scope') AS rejected_policies,
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE organization_id = 'org_a' AND store_id = 'store_a' AND key_version = 'v1') AS control_bindings`,
      );
      expect(state).toEqual({ rejected_policies: 0, control_bindings: 1 });
    });

    it("rejects a crypto policy pair absent from the matching-key registry", async () => {
      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, suppression_version, suppression_key_check
         ) VALUES (
           'policy_unregistered', 'org_a', 'store_a', 'v1', 'check-a',
           'e1', 'erasure-check-a'
         )`,
        "23503",
      );
    });

    it("rejects an absent previous binding independently of the valid current binding", async () => {
      await testPool!.query(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES ('org_a', 'store_a', 'v2', 'current-check')`,
      );

      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, matching_previous_version,
           matching_previous_key_check, suppression_version,
           suppression_key_check
         ) VALUES (
           'policy_missing_previous', 'org_a', 'store_a', 'v2',
           'current-check', 'v1', 'missing-previous-check',
           'e1', 'suppression-check'
         )`,
        "23503",
        "identity_crypto_policy_previous_binding_fk",
      );

      const { rows: [state] } = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM identity_crypto_policy WHERE id = 'policy_missing_previous') AS rejected_policies,
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE organization_id = 'org_a' AND store_id = 'store_a' AND key_version = 'v2' AND key_check = 'current-check') AS current_bindings,
           (SELECT count(*)::int FROM identity_matching_key_binding WHERE key_check = 'missing-previous-check') AS previous_bindings`,
      );
      expect(state).toEqual({
        rejected_policies: 0,
        current_bindings: 1,
        previous_bindings: 0,
      });
    });

    it("rejects deletion of a matching-key binding referenced by an active policy", async () => {
      await testPool!.query(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES ('org_a', 'store_a', 'v2', 'active-current-check')`,
      );
      await testPool!.query(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, suppression_version, suppression_key_check
         ) VALUES (
           'policy_active', 'org_a', 'store_a', 'v2', 'active-current-check',
           'e1', 'suppression-check'
         )`,
      );

      const { rows: beforeDeletion } = await testPool!.query(
        `SELECT 'binding' AS kind, key_version AS value
         FROM identity_matching_key_binding
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
         UNION ALL
         SELECT 'policy' AS kind, matching_current_version AS value
         FROM identity_crypto_policy
         WHERE id = 'policy_active'
         ORDER BY kind`,
      );
      expect(beforeDeletion).toEqual([
        { kind: "binding", value: "v2" },
        { kind: "policy", value: "v2" },
      ]);

      await expectConstraintViolation(
        `DELETE FROM identity_matching_key_binding
         WHERE organization_id = 'org_a'
           AND store_id = 'store_a'
           AND key_version = 'v2'`,
        "23503",
        "identity_crypto_policy_current_binding_fk",
      );

      const { rows: afterDeletion } = await testPool!.query(
        `SELECT 'binding' AS kind, key_version AS value
         FROM identity_matching_key_binding
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
         UNION ALL
         SELECT 'policy' AS kind, matching_current_version AS value
         FROM identity_crypto_policy
         WHERE id = 'policy_active'
         ORDER BY kind`,
      );
      expect(afterDeletion).toEqual(beforeDeletion);
    });

    it("enforces one valid current/previous crypto policy per store", async () => {
      await testPool!.query(
        `INSERT INTO identity_matching_key_binding (
           organization_id, store_id, key_version, key_check
         ) VALUES
           ('org_a', 'store_a', 'v2', 'check-v2'),
           ('org_a', 'store_a', 'v1', 'check-v1'),
           ('org_a', 'store_a', 'e1', 'check-e1')`,
      );
      await testPool!.query(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, matching_previous_version,
           matching_previous_key_check, suppression_version,
           suppression_key_check
         ) VALUES (
           'policy_a', 'org_a', 'store_a', 'v2', 'check-v2', 'v1', 'check-v1',
           'e1', 'check-e1'
         )`,
      );

      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, suppression_version, suppression_key_check
         ) VALUES (
           'policy_duplicate', 'org_a', 'store_a', 'v2', 'check-v2',
           'e1', 'check-e1'
         )`,
        "23505",
      );

      await testPool!.query("DELETE FROM identity_crypto_policy");

      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, matching_previous_version,
           suppression_version, suppression_key_check
         ) VALUES (
           'policy_partial_previous', 'org_a', 'store_a', 'v2', 'check-v2',
           'v1', 'e1', 'check-e1'
         )`,
        "23514",
      );

      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, matching_previous_key_check,
           suppression_version, suppression_key_check
         ) VALUES (
           'policy_previous_check_only', 'org_a', 'store_a', 'v2', 'check-v2',
           'check-v1', 'e1', 'check-e1'
         )`,
        "23514",
      );

      await expectConstraintViolation(
        `INSERT INTO identity_crypto_policy (
           id, organization_id, store_id, matching_current_version,
           matching_current_key_check, matching_previous_version,
           matching_previous_key_check, suppression_version,
           suppression_key_check
         ) VALUES (
           'policy_same_previous', 'org_a', 'store_a', 'v2', 'check-v2',
           'v2', 'check-v2', 'e1', 'check-e1'
         )`,
        "23514",
      );
    });
  });
});
