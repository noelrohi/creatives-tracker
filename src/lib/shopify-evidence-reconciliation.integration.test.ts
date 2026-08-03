import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  computeErasureSuppressionDigests,
  computeIdentityCryptoKeyChecks,
  computeIdentityDigests,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";

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
const TEST_DATABASE = "adsolute_shopify_evidence_reconciliation_test";
const ADVISORY_LOCK: [number, number] = [1_384_994_861, 1_816_654_783];

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
let advisoryLockHeld = false;
let testPoolClosed = false;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { getBucketTotals, getMetaVerified } = await import(
  "@/lib/attribution-queries"
);
const {
  persistShopifyIdentityEvidence,
  replaceCompleteShopifyLineSet,
} = await import("@/lib/shopify-evidence-store");
const {
  clearPilotShopifyIdentityForStore,
  eraseShopifySubjectByEmail,
} = await import("@/lib/shopify-privacy");

const PRE_0053_FIXTURE_DDL = [
  `CREATE TABLE organization (
     id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
     logo text, created_at timestamp NOT NULL, metadata text
   )`,
  `CREATE TABLE shopify_store (
     id text PRIMARY KEY, organization_id text NOT NULL,
     shop_domain text NOT NULL UNIQUE, access_token text,
     iana_timezone text NOT NULL, currency text, last_synced_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL
   )`,
  `CREATE TYPE attribution_bucket AS ENUM (
     'meta', 'google', 'klaviyo', 'tiktok', 'ai',
     'organic_direct', 'unattributed', 'untracked'
   )`,
  `CREATE TABLE shopify_order (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     shopify_order_id text NOT NULL, order_name text,
     order_created_at timestamp NOT NULL, order_updated_at timestamp,
     order_day date NOT NULL, net_sales numeric NOT NULL,
     taxes_included boolean, customer_journey jsonb,
     journey_ready boolean DEFAULT false NOT NULL, pending_since timestamp,
     last_click_utm_source text, last_click_utm_medium text,
     last_click_utm_campaign text, bucket attribution_bucket,
     bucket_rule_version integer, meta_verified boolean DEFAULT false NOT NULL,
     meta_campaign_id text, verification_pending boolean DEFAULT false NOT NULL,
     cancelled_at timestamp, cancel_reason text, order_source_name text,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_order_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_order_store_order_uniq UNIQUE (store_id, shopify_order_id)
   )`,
  `CREATE TABLE shopify_refund (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     order_id text NOT NULL, shopify_refund_id text NOT NULL,
     refund_day date NOT NULL, amount numeric NOT NULL,
     kind text DEFAULT 'refund' NOT NULL, refund_created_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_refund_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_order_id_shopify_order_id_fk
       FOREIGN KEY (order_id) REFERENCES shopify_order(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_store_refund_uniq UNIQUE (store_id, shopify_refund_id)
   )`,
  `CREATE TABLE shopify_sync_run (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     trigger_type text NOT NULL, phase text NOT NULL, date_from date, date_to date,
     result text, orders_synced integer, error text,
     requested_at timestamp DEFAULT now() NOT NULL, finished_at timestamp, meta jsonb,
     CONSTRAINT shopify_sync_run_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
  `CREATE TYPE finding_type AS ENUM (
     'meta_overclaim', 'unattributed_spike', 'broken_utm_template',
     'sync_failure', 'roas_below_target'
   )`,
  `CREATE TABLE finding (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text,
     type finding_type NOT NULL, fired_at timestamp DEFAULT now() NOT NULL,
     payload jsonb NOT NULL, created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT finding_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
];

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "drizzle/0053_klaviyo_shopify_evidence.sql",
);

async function createFixtureSchema(pool: Pool): Promise<void> {
  for (const statement of PRE_0053_FIXTURE_DDL) await pool.query(statement);
  const migration = readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of migration) await pool.query(statement);
}

async function cleanupFixture(): Promise<void> {
  const errors: unknown[] = [];
  if (!testPoolClosed) {
    try {
      await testPool?.end();
      testPoolClosed = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (adminClient && advisoryLockHeld) {
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    } catch (error) {
      errors.push(error);
    }
    try {
      await adminClient.query("SELECT pg_advisory_unlock($1, $2)", ADVISORY_LOCK);
    } catch (error) {
      errors.push(error);
    } finally {
      advisoryLockHeld = false;
    }
  }
  adminClient?.release();
  adminClient = null;
  if (adminPool) await adminPool.end();
  adminPool = null;
  if (errors.length > 0) {
    throw new AggregateError(errors, "Reconciliation DB cleanup failed");
  }
}

const SCOPE = {
  organizationId: "org_reconciliation",
  storeId: "store_reconciliation",
  dateFrom: "2026-07-29",
  dateTo: "2026-07-31",
};
const EMAIL = "person@example.com";
const SHOPIFY_CUSTOMER_ID = "gid://shopify/Customer/1";
const KEYRING: IdentityHmacKeyring = {
  current: { version: "v1", secret: new Uint8Array(32).fill(0x41) },
};
const SUPPRESSION_KEY: ErasureSuppressionKey = {
  version: "e1",
  secret: new Uint8Array(32).fill(0x52),
};
const IDENTITY_SCOPE = {
  organizationId: SCOPE.organizationId,
  storeId: SCOPE.storeId,
};
const COMPLETE_LINES = {
  completeness: "complete" as const,
  shopifyOrderId: "gid://shopify/Order/1",
  orderUpdatedAt: new Date("2026-07-29T02:00:00.000Z"),
  lines: [
    {
      shopifyLineItemId: "gid://shopify/LineItem/1",
      shopifyProductId: "gid://shopify/Product/1",
      shopifyVariantId: "gid://shopify/ProductVariant/1",
      sku: "SKU-1",
      productTitle: "Product one",
      variantTitle: "Default",
      quantity: 1,
      sourcePosition: 0,
    },
  ],
};
const AVAILABLE_IDENTITY = {
  status: "available" as const,
  shopifyCustomerId: SHOPIFY_CUSTOMER_ID,
  digests: computeIdentityDigests({
    scope: IDENTITY_SCOPE,
    email: EMAIL,
    keyring: KEYRING,
  }),
  suppressionCandidates: computeErasureSuppressionDigests({
    scope: IDENTITY_SCOPE,
    key: SUPPRESSION_KEY,
    email: EMAIL,
    shopifyCustomerId: SHOPIFY_CUSTOMER_ID,
  }),
  keyChecks: computeIdentityCryptoKeyChecks({
    scope: IDENTITY_SCOPE,
    keyring: KEYRING,
    suppressionKey: SUPPRESSION_KEY,
  }),
  evaluatedKeyVersions: [KEYRING.current.version],
};

type ReconciliationBaseRow = {
  order_count: number;
  gross: string;
  refunded: string;
  rule_versions: Array<number | null>;
  production_row_timestamps: string[];
  meta_verified_count: number;
  verification_pending_count: number;
};

async function readReconciliationSnapshot(scope: {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const [bucketTotals, metaVerified, baseResult] = await Promise.all([
    getBucketTotals(scope),
    getMetaVerified(scope),
    testDb!.execute<ReconciliationBaseRow>(sql`
      SELECT
        count(DISTINCT o.id)::int AS order_count,
        coalesce(sum(o.net_sales), 0)::text AS gross,
        coalesce((
          SELECT sum(r.amount)
          FROM shopify_refund AS r
          WHERE r.organization_id = ${scope.organizationId}
            AND r.store_id = ${scope.storeId}
        ), 0)::text AS refunded,
        array_agg(DISTINCT o.bucket_rule_version ORDER BY o.bucket_rule_version) AS rule_versions,
        array_agg(
          o.id || ':' || o.updated_at::text
          ORDER BY o.id
        ) AS production_row_timestamps,
        count(*) FILTER (WHERE o.meta_verified)::int AS meta_verified_count,
        count(*) FILTER (WHERE o.verification_pending)::int AS verification_pending_count
      FROM shopify_order AS o
      WHERE o.organization_id = ${scope.organizationId}
        AND o.store_id = ${scope.storeId}
    `),
  ]);
  const [base] = baseResult.rows;
  return { bucketTotals, metaVerified, base };
}

const describeIfDb = baseConnectionString ? describe : describe.skip;

describeIfDb("Shopify evidence reconciliation", () => {
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

      await testPool!.query(
        `INSERT INTO organization (id, name, slug, created_at)
         VALUES ('org_reconciliation', 'Reconciliation Org', 'reconciliation-org',
           '2026-07-01 00:00:00')`,
      );
      await testPool!.query(
        `INSERT INTO shopify_store (
           id, organization_id, shop_domain, iana_timezone, currency,
           created_at, updated_at
         ) VALUES (
           'store_reconciliation', 'org_reconciliation',
           'reconciliation.myshopify.com', 'UTC', 'USD',
           '2026-07-01 00:00:00', '2026-07-01 00:00:00'
         )`,
      );
      await testPool!.query(
        `INSERT INTO shopify_order (
           id, organization_id, store_id, shopify_order_id, order_name,
           order_created_at, order_updated_at, order_day, net_sales,
           journey_ready, bucket, bucket_rule_version, meta_verified,
           meta_campaign_id, verification_pending, order_source_name,
           created_at, updated_at
         ) VALUES
         ('order_meta', 'org_reconciliation', 'store_reconciliation',
          'gid://shopify/Order/1', '#1', '2026-07-29 01:00:00',
          '2026-07-29 02:00:00', '2026-07-29', 100.00, true, 'meta', 41,
          true, 'meta-campaign-1', false, 'web',
          '2026-07-29 03:00:00', '2026-07-29 04:00:00'),
         ('order_google', 'org_reconciliation', 'store_reconciliation',
          'gid://shopify/Order/2', '#2', '2026-07-30 01:00:00',
          '2026-07-30 02:00:00', '2026-07-30', 50.00, true, 'google', 42,
          false, null, false, 'web',
          '2026-07-30 03:00:00', '2026-07-30 04:00:00'),
         ('order_organic', 'org_reconciliation', 'store_reconciliation',
          'gid://shopify/Order/3', '#3', '2026-07-31 01:00:00',
          '2026-07-31 02:00:00', '2026-07-31', 25.00, true,
          'organic_direct', 41, false, null, false, 'web',
          '2026-07-31 03:00:00', '2026-07-31 04:00:00'),
         ('order_pending', 'org_reconciliation', 'store_reconciliation',
          'gid://shopify/Order/4', '#4', '2026-07-31 05:00:00',
          '2026-07-31 06:00:00', '2026-07-31', 12.00, false, null, null,
          false, null, true, 'web',
          '2026-07-31 07:00:00', '2026-07-31 08:00:00')`,
      );
      await testPool!.query(
        `INSERT INTO shopify_refund (
           id, organization_id, store_id, order_id, shopify_refund_id,
           refund_day, amount, refund_created_at, created_at
         ) VALUES
         ('refund_meta', 'org_reconciliation', 'store_reconciliation',
          'order_meta', 'gid://shopify/Refund/1', '2026-07-30', 10.00,
          '2026-07-30 12:00:00', '2026-07-30 12:01:00'),
         ('refund_organic', 'org_reconciliation', 'store_reconciliation',
          'order_organic', 'gid://shopify/Refund/2', '2026-07-31', 5.00,
          '2026-07-31 12:00:00', '2026-07-31 12:01:00')`,
      );
    } catch (setupError) {
      try {
        await cleanupFixture();
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          "Reconciliation DB setup failed",
        );
      }
      throw setupError;
    }
  }, 120_000);

  afterAll(cleanupFixture);

  it("keeps Shopify money and attribution byte-for-byte unchanged", async () => {
    const before = await readReconciliationSnapshot(SCOPE);

    expect(before.bucketTotals).toEqual({
      buckets: [
        { bucket: "meta", revenueCents: 9_000, orderCount: 1 },
        { bucket: "google", revenueCents: 5_000, orderCount: 1 },
        { bucket: "klaviyo", revenueCents: 0, orderCount: 0 },
        { bucket: "tiktok", revenueCents: 0, orderCount: 0 },
        { bucket: "ai", revenueCents: 0, orderCount: 0 },
        { bucket: "organic_direct", revenueCents: 2_000, orderCount: 1 },
        { bucket: "unattributed", revenueCents: 0, orderCount: 0 },
        { bucket: "untracked", revenueCents: 0, orderCount: 0 },
      ],
      pending: { count: 1, revenueCents: 1_200 },
      totalCents: 17_200,
      identity: {
        sumOfBucketsCents: 16_000,
        actualCents: 17_200,
        differenceCents: 0,
        matches: true,
      },
    });
    expect(before.metaVerified).toEqual({
      verifiedRevenueCents: 9_000,
      verifiedOrderCount: 1,
      verificationPendingCount: 1,
    });
    expect(before.base).toEqual(
      expect.objectContaining({
        order_count: 4,
        gross: "187.00",
        refunded: "15.00",
        rule_versions: [41, 42, null],
        meta_verified_count: 1,
        verification_pending_count: 1,
      }),
    );

    await replaceCompleteShopifyLineSet(IDENTITY_SCOPE, COMPLETE_LINES);
    await persistShopifyIdentityEvidence(
      IDENTITY_SCOPE,
      "gid://shopify/Order/1",
      AVAILABLE_IDENTITY,
    );
    await replaceCompleteShopifyLineSet(IDENTITY_SCOPE, COMPLETE_LINES);

    const afterReplay = await readReconciliationSnapshot(SCOPE);
    expect(afterReplay).toEqual(before);

    await eraseShopifySubjectByEmail({
      scope: IDENTITY_SCOPE,
      email: EMAIL,
      keyring: KEYRING,
      suppressionKey: SUPPRESSION_KEY,
    });
    const afterErasure = await readReconciliationSnapshot(SCOPE);
    expect(afterErasure).toEqual(before);

    await clearPilotShopifyIdentityForStore(IDENTITY_SCOPE);
    const afterUninstallCleanup = await readReconciliationSnapshot(SCOPE);
    expect(afterUninstallCleanup).toEqual(before);
  });
});
