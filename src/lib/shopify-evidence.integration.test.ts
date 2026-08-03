import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import type { IdentityCryptoKeyChecks } from "@/lib/identity-hmac";

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
const TEST_DATABASE = "adsolute_shopify_evidence_persistence_test";
const ADVISORY_LOCK: [number, number] = [1_384_994_861, 1_816_654_771];

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

const {
  SHOPIFY_EVIDENCE_STALE_AFTER_MS,
  checkpointShopifyEvidenceRun,
  commitShopifyEvidenceOrder,
  countEvidenceOrders,
  ensureIdentityCryptoPolicy,
  failExpiredShopifyEvidenceRun,
  failShopifyEvidenceRunAfterRetryExhaustion,
  finishShopifyEvidenceRun,
  listEvidenceOrderBatch,
  loadEvidenceStore,
  persistShopifyIdentityEvidence,
  recordFirstBatchTriggerRunId,
  renewShopifyEvidenceRunHeartbeat,
  replaceCompleteShopifyLineSet,
  startShopifyEvidenceRun,
} = await import("@/lib/shopify-evidence-store");

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
  if (errors.length > 0) throw new AggregateError(errors, "Evidence DB cleanup failed");
}

const describeIfDb = baseConnectionString ? describe : describe.skip;
const scope = { organizationId: "org_a", storeId: "store_a" };
const otherScope = { organizationId: "org_b", storeId: "store_b" };
const KEY_CHECKS: IdentityCryptoKeyChecks = {
  matching: [{ keyVersion: "v1", keyCheck: "matching-check-a" }],
  suppression: { keyVersion: "e1", keyCheck: "suppression-check-a" },
};
const OTHER_KEY_CHECKS: IdentityCryptoKeyChecks = {
  matching: [{ keyVersion: "v1", keyCheck: "matching-check-b" }],
  suppression: { keyVersion: "e1", keyCheck: "suppression-check-b" },
};
const ZERO_COUNTS = {
  ordersRead: 0,
  ordersEnriched: 0,
  ordersPartial: 0,
  ordersUnavailable: 0,
  warnings: 0,
  failures: 0,
};
const FIRST_CURSOR = {
  orderCreatedAt: new Date("2026-07-30T01:00:00.000Z"),
  id: "order_a",
};
const SECOND_CURSOR = {
  orderCreatedAt: new Date("2026-07-30T02:00:00.000Z"),
  id: "order_a2",
};
const firstCompleteSet = {
  completeness: "complete" as const,
  shopifyOrderId: "gid://shopify/Order/1",
  orderUpdatedAt: new Date("2026-07-31T03:00:00.000Z"),
  lines: [
    {
      shopifyLineItemId: "gid://shopify/LineItem/1",
      shopifyProductId: "gid://shopify/Product/1",
      shopifyVariantId: "gid://shopify/ProductVariant/1",
      sku: "SKU-1",
      productTitle: "First",
      variantTitle: "Small",
      quantity: 1,
      sourcePosition: 0,
    },
    {
      shopifyLineItemId: "gid://shopify/LineItem/2",
      shopifyProductId: null,
      shopifyVariantId: null,
      sku: null,
      productTitle: "Second",
      variantTitle: null,
      quantity: 2,
      sourcePosition: 1,
    },
  ],
};

function availableIdentity(
  digest = "matching-digest-v1",
  suppressionCandidates: Array<{
    kind: "email" | "shopify_customer_id";
    keyVersion: string;
    digest: string;
  }> = [
    { kind: "email", keyVersion: "e1", digest: "suppression-email" },
    {
      kind: "shopify_customer_id",
      keyVersion: "e1",
      digest: "suppression-customer",
    },
  ],
) {
  return {
    status: "available" as const,
    shopifyCustomerId: "gid://shopify/Customer/1",
    digests: [{ keyVersion: "v1", digest, rotationState: "active" as const }],
    suppressionCandidates,
    keyChecks: KEY_CHECKS,
    evaluatedKeyVersions: ["v1"],
  };
}

async function startRun(
  startTriggerRunId = `trigger-${crypto.randomUUID()}`,
  now = new Date("2026-08-01T00:00:00.000Z"),
  runScope = scope,
) {
  return startShopifyEvidenceRun({
    startTriggerRunId,
    scope: runScope,
    mode: "incremental_7d",
    storeTimezone: "UTC",
    anchorStoreDay: "2026-07-31",
    window: {
      from: new Date("2026-07-25T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
    },
    disposition: { kind: "running", identityCapability: "unknown" },
    now,
  });
}

async function readLineIds(): Promise<string[]> {
  const result = await testPool!.query<{ shopify_line_item_id: string }>(
    `SELECT shopify_line_item_id FROM shopify_order_line
     WHERE organization_id = 'org_a' AND store_id = 'store_a'
       AND order_id = 'order_a'
     ORDER BY shopify_line_item_id`,
  );
  return result.rows.map((row) => row.shopify_line_item_id);
}

async function readPersistedOrderCursor(orderId: string) {
  const batch = await listEvidenceOrderBatch(
    scope,
    {
      from: new Date("2000-01-01T00:00:00.000Z"),
      to: new Date("2100-01-01T00:00:00.000Z"),
    },
    null,
    1_000,
  );
  const order = batch.orders.find((candidate) => candidate.id === orderId);
  if (!order) throw new Error("Expected persisted evidence order fixture");
  return { orderCreatedAt: order.orderCreatedAt, id: order.id };
}

async function readAtomicState(runId: string) {
  const [lines, hmacs, order, run, observations] = await Promise.all([
    testPool!.query(
      `SELECT id, shopify_line_item_id, shopify_product_id,
              shopify_variant_id, sku, product_title, variant_title,
              quantity, source_position, parent_order_updated_at::text,
              created_at::text, updated_at::text
       FROM shopify_order_line
       WHERE organization_id = 'org_a' AND store_id = 'store_a'
         AND order_id = 'order_a'
       ORDER BY shopify_line_item_id`,
    ),
    testPool!.query(
      `SELECT id, key_version, rotation_state, created_at::text
       FROM source_identity_hmac
       WHERE organization_id = 'org_a' AND store_id = 'store_a'
         AND shopify_order_id = 'order_a'
       ORDER BY key_version`,
    ),
    testPool!.query(
      `SELECT shopify_customer_id IS NULL AS customer_identity_absent,
              updated_at::text, net_sales, customer_journey, bucket,
              bucket_rule_version, meta_verified, cancelled_at,
              order_source_name
       FROM shopify_order WHERE id = 'order_a'`,
    ),
    testPool!.query(
      `SELECT cursor, status, identity_capability, line_completeness,
              orders_read, orders_enriched, orders_partial,
              orders_unavailable, warnings, failures, heartbeat_at::text
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [runId],
    ),
    testPool!.query(
      `SELECT
         (SELECT count(*) FROM shopify_evidence_run_observation
          WHERE evidence_run_id = $1) AS content,
         (SELECT count(*) FROM shopify_evidence_run_identity_observation
          WHERE evidence_run_id = $1) AS identity`,
      [runId],
    ),
  ]);
  return {
    lines: lines.rows,
    hmacs: hmacs.rows,
    order: order.rows,
    run: run.rows,
    observations: observations.rows,
  };
}

describeIfDb("Shopify evidence persistence", () => {
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
    } catch (setupError) {
      try {
        await cleanupFixture();
      } catch (cleanupError) {
        throw new AggregateError([setupError, cleanupError], "Evidence DB setup failed");
      }
      throw setupError;
    }
  }, 120_000);

  afterAll(cleanupFixture);

  beforeEach(async () => {
    await testPool!.query("TRUNCATE organization CASCADE");
    await testPool!.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES
       ('org_a', 'Org A', 'org-a', now()),
       ('org_b', 'Org B', 'org-b', now())`,
    );
    await testPool!.query(
      `INSERT INTO shopify_store (
         id, organization_id, shop_domain, iana_timezone, currency
       ) VALUES
       ('store_a', 'org_a', 'store-a.myshopify.com', 'UTC', 'USD'),
       ('store_a2', 'org_a', 'store-a2.myshopify.com', 'UTC', 'USD'),
       ('store_b', 'org_b', 'store-b.myshopify.com', 'UTC', 'USD')`,
    );
    await testPool!.query(
      `INSERT INTO shopify_order (
         id, organization_id, store_id, shopify_order_id, order_name,
         order_created_at, order_updated_at, order_day, net_sales,
         customer_journey, journey_ready, bucket, bucket_rule_version,
         meta_verified, verification_pending, order_source_name,
         updated_at
       ) VALUES
       ('order_a', 'org_a', 'store_a', 'gid://shopify/Order/1', '#1',
        '2026-07-30 01:00:00', '2026-07-30 02:00:00', '2026-07-30', 123.45,
        '{"utm":"kept"}', true, 'meta', 7, true, false, 'web',
        '2026-07-30 03:00:00'),
       ('order_a2', 'org_a', 'store_a', 'gid://shopify/Order/2', '#2',
        '2026-07-30 02:00:00', '2026-07-30 03:00:00', '2026-07-30', 45.67,
        null, false, null, null, false, false, 'web',
        '2026-07-30 04:00:00'),
       ('order_a3', 'org_a', 'store_a', 'gid://shopify/Order/4', '#4',
        '2026-07-30 03:00:00', '2026-07-30 04:00:00', '2026-07-30', 12.34,
        null, false, null, null, false, false, 'web',
        '2026-07-30 05:00:00'),
       ('order_b', 'org_b', 'store_b', 'gid://shopify/Order/3', '#3',
        '2026-07-30 01:30:00', '2026-07-30 02:30:00', '2026-07-30', 9.99,
        null, false, null, null, false, false, 'web',
        '2026-07-30 05:00:00')`,
    );
  });

  it("applies the checked-in 0053 migration to the disposable pre-0053 catalog", async () => {
    const result = await testPool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'shopify_order_line', 'source_identity_hmac',
           'identity_matching_key_binding', 'identity_crypto_policy',
           'identity_erasure_suppression', 'shopify_evidence_sync_run',
           'shopify_evidence_run_observation',
           'shopify_evidence_run_identity_observation'
         ) ORDER BY table_name`,
    );
    expect(result.rows).toHaveLength(8);
  });

  it("loads and batches only the full scoped half-open order window", async () => {
    await expect(loadEvidenceStore(scope)).resolves.toMatchObject({
      id: "store_a",
      organizationId: "org_a",
      shopDomain: "store-a.myshopify.com",
    });
    await expect(
      loadEvidenceStore({ organizationId: "org_b", storeId: "store_a" }),
    ).rejects.toThrow("binding was not found");
    const window = {
      from: new Date("2026-07-30T01:00:00.000Z"),
      to: new Date("2026-07-30T03:00:00.000Z"),
    };
    const first = await listEvidenceOrderBatch(scope, window, null, 1);
    expect(first.orders.map((order) => order.id)).toEqual(["order_a"]);
    expect(first.nextCursor).toEqual(FIRST_CURSOR);
    const second = await listEvidenceOrderBatch(scope, window, first.nextCursor, 1000);
    expect(second.orders.map((order) => order.id)).toEqual(["order_a2"]);
    expect(second.nextCursor).toBeNull();
    await expect(countEvidenceOrders(scope, window)).resolves.toBe(2);
    await expect(countEvidenceOrders(otherScope, window)).resolves.toBe(1);
  });

  it("replaces complete lines, clears with complete empty, and rolls back invalid insertion", async () => {
    await replaceCompleteShopifyLineSet(scope, firstCompleteSet);
    expect(await readLineIds()).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
    await expect(
      replaceCompleteShopifyLineSet(scope, {
        ...firstCompleteSet,
        lines: [{ ...firstCompleteSet.lines[0], quantity: 0 }],
      }),
    ).rejects.toThrow();
    expect(await readLineIds()).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
    await replaceCompleteShopifyLineSet(scope, { ...firstCompleteSet, lines: [] });
    expect(await readLineIds()).toEqual([]);
  });

  it("initializes one lifetime crypto binding safely under replay and races", async () => {
    await Promise.all([
      ensureIdentityCryptoPolicy({ scope, keyChecks: KEY_CHECKS }),
      ensureIdentityCryptoPolicy({ scope, keyChecks: KEY_CHECKS }),
    ]);
    const counts = await testPool!.query<{ bindings: string; policies: string }>(
      `SELECT
         (SELECT count(*) FROM identity_matching_key_binding
          WHERE organization_id = 'org_a' AND store_id = 'store_a') AS bindings,
         (SELECT count(*) FROM identity_crypto_policy
          WHERE organization_id = 'org_a' AND store_id = 'store_a') AS policies`,
    );
    expect(counts.rows[0]).toEqual({ bindings: "1", policies: "1" });
    await expect(
      ensureIdentityCryptoPolicy({
        scope,
        keyChecks: {
          ...KEY_CHECKS,
          matching: [{ keyVersion: "v1", keyCheck: "different" }],
        },
      }),
    ).rejects.toThrow("identity_crypto_policy_conflict");
    await expect(
      ensureIdentityCryptoPolicy({
        scope,
        keyChecks: {
          ...KEY_CHECKS,
          suppression: { keyVersion: "e1", keyCheck: "different" },
        },
      }),
    ).rejects.toThrow("identity_crypto_policy_conflict");
    await expect(
      ensureIdentityCryptoPolicy({
        scope,
        keyChecks: {
          ...KEY_CHECKS,
          matching: [
            ...KEY_CHECKS.matching,
            { keyVersion: "v0", keyCheck: "previous" },
          ],
        },
      }),
    ).rejects.toThrow("identity_crypto_policy_conflict");
    await expect(
      ensureIdentityCryptoPolicy({ scope: otherScope, keyChecks: OTHER_KEY_CHECKS }),
    ).resolves.toBeUndefined();
  });

  it("allows only one divergent crypto-policy initializer to bind a store", async () => {
    const divergent: IdentityCryptoKeyChecks = {
      matching: [{ keyVersion: "v1", keyCheck: "divergent-matching-check" }],
      suppression: { keyVersion: "e1", keyCheck: "divergent-suppression-check" },
    };
    const outcomes = await Promise.allSettled([
      ensureIdentityCryptoPolicy({ scope, keyChecks: KEY_CHECKS }),
      ensureIdentityCryptoPolicy({ scope, keyChecks: divergent }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: "identity_crypto_policy_conflict",
    });
    const counts = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM identity_matching_key_binding
          WHERE organization_id = 'org_a' AND store_id = 'store_a') AS bindings,
         (SELECT count(*) FROM identity_crypto_policy
          WHERE organization_id = 'org_a' AND store_id = 'store_a') AS policies`,
    );
    expect(counts.rows[0]).toEqual({ bindings: "1", policies: "1" });
  });

  it("preserves unavailable identity and changes only allowlisted identity fields", async () => {
    const before = await testPool!.query(
      `SELECT updated_at, net_sales, customer_journey, journey_ready, bucket,
              bucket_rule_version, meta_verified, verification_pending,
              cancelled_at, cancel_reason, order_source_name
       FROM shopify_order WHERE id = 'order_a'`,
    );
    const first = await persistShopifyIdentityEvidence(
      scope,
      "gid://shopify/Order/1",
      availableIdentity(),
    );
    await persistShopifyIdentityEvidence(scope, "gid://shopify/Order/1", {
      status: "unavailable",
      reason: "protected_identity_unavailable",
    });
    const second = await persistShopifyIdentityEvidence(
      scope,
      "gid://shopify/Order/1",
      availableIdentity(),
    );
    expect(second.identityHmacId).toBe(first.identityHmacId);
    const after = await testPool!.query(
      `SELECT updated_at, net_sales, customer_journey, journey_ready, bucket,
              bucket_rule_version, meta_verified, verification_pending,
              cancelled_at, cancel_reason, order_source_name,
              shopify_customer_id
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(after.rows[0]).toMatchObject({
      ...before.rows[0],
      shopify_customer_id: "gid://shopify/Customer/1",
    });
  });

  it("deletes only an explicitly evaluated identity version proven absent", async () => {
    await persistShopifyIdentityEvidence(
      scope,
      "gid://shopify/Order/1",
      availableIdentity(),
    );
    await persistShopifyIdentityEvidence(scope, "gid://shopify/Order/1", {
      status: "available",
      shopifyCustomerId: null,
      digests: [],
      suppressionCandidates: [],
      keyChecks: KEY_CHECKS,
      evaluatedKeyVersions: ["v1"],
    });
    const stored = await testPool!.query(
      `SELECT shopify_customer_id,
              (SELECT count(*) FROM source_identity_hmac
               WHERE shopify_order_id = 'order_a') AS digests
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(stored.rows[0]).toEqual({ shopify_customer_id: null, digests: "0" });
  });

  it("fails a same-label suppression mismatch before identity mutation", async () => {
    await ensureIdentityCryptoPolicy({ scope, keyChecks: KEY_CHECKS });
    const candidate = availableIdentity();
    candidate.keyChecks = {
      ...KEY_CHECKS,
      suppression: { keyVersion: "e1", keyCheck: "wrong-root" },
    };
    await expect(
      persistShopifyIdentityEvidence(scope, "gid://shopify/Order/1", candidate),
    ).rejects.toThrow("identity_crypto_policy_conflict");
    const stored = await testPool!.query(
      `SELECT shopify_customer_id,
              (SELECT count(*) FROM source_identity_hmac
               WHERE shopify_order_id = 'order_a') AS digests
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(stored.rows[0]).toEqual({ shopify_customer_id: null, digests: "0" });
  });

  it.each([
    {
      name: "an extra evaluated version",
      mutate: () => ({
        ...availableIdentity(),
        evaluatedKeyVersions: ["v1", "v0"],
      }),
    },
    {
      name: "a previous-rotation digest",
      mutate: () => ({
        ...availableIdentity(),
        digests: [
          {
            keyVersion: "v1",
            digest: "not-inspected",
            rotationState: "rotation_previous" as const,
          },
        ],
      }),
    },
    {
      name: "duplicate suppression candidates",
      mutate: () => {
        const identity = availableIdentity();
        return {
          ...identity,
          suppressionCandidates: [
            identity.suppressionCandidates[0],
            identity.suppressionCandidates[0],
          ],
        };
      },
    },
    {
      name: "different email suppression candidates",
      mutate: () => {
        const identity = availableIdentity();
        return {
          ...identity,
          suppressionCandidates: [
            ...identity.suppressionCandidates,
            { kind: "email" as const, keyVersion: "e1", digest: "other-email" },
          ],
        };
      },
    },
    {
      name: "a missing customer suppression candidate",
      mutate: () => ({
        ...availableIdentity(),
        suppressionCandidates: availableIdentity().suppressionCandidates.filter(
          (candidate) => candidate.kind !== "shopify_customer_id",
        ),
      }),
    },
    {
      name: "a customer suppression candidate without a customer alias",
      mutate: () => ({ ...availableIdentity(), shopifyCustomerId: null }),
    },
    {
      name: "a missing email suppression candidate",
      mutate: () => ({
        ...availableIdentity(),
        suppressionCandidates: availableIdentity().suppressionCandidates.filter(
          (candidate) => candidate.kind !== "email",
        ),
      }),
    },
    {
      name: "an email suppression candidate without an active email digest",
      mutate: () => ({ ...availableIdentity(), digests: [] }),
    },
    {
      name: "an empty customer alias",
      mutate: () => ({ ...availableIdentity(), shopifyCustomerId: "" }),
    },
  ])("rejects current-only identity evidence with $name before writes", async ({ mutate }) => {
    await expect(
      persistShopifyIdentityEvidence(scope, "gid://shopify/Order/1", mutate()),
    ).rejects.toThrow("shopify_identity_evidence_invalid");
    const stored = await testPool!.query(
      `SELECT shopify_customer_id,
              (SELECT count(*) FROM identity_matching_key_binding) AS bindings,
              (SELECT count(*) FROM identity_crypto_policy) AS policies,
              (SELECT count(*) FROM source_identity_hmac) AS hmacs
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(stored.rows[0]).toEqual({
      shopify_customer_id: null,
      bindings: "0",
      policies: "0",
      hmacs: "0",
    });
  });

  it("rejects incoherent identity evidence before resolving any database scope", async () => {
    const identity = availableIdentity();
    await expect(
      persistShopifyIdentityEvidence(
        { organizationId: "missing-org", storeId: "missing-store" },
        "gid://shopify/Order/missing",
        {
          ...identity,
          suppressionCandidates: identity.suppressionCandidates.filter(
            (candidate) => candidate.kind !== "email",
          ),
        },
      ),
    ).rejects.toThrow("shopify_identity_evidence_invalid");
  });

  it("rejects incoherent candidates before a tombstone can be bypassed or state resurrected", async () => {
    await testPool!.query(
      `INSERT INTO identity_erasure_suppression (
         id, organization_id, store_id, kind, key_version, digest
       ) VALUES (
         'coherence-tombstone', 'org_a', 'store_a',
         'email', 'e1', 'suppression-email'
       )`,
    );
    const run = await startRun("trigger-coherence-tombstone");
    const before = await readAtomicState(run.id);
    const identity = availableIdentity();
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: {
          ...identity,
          suppressionCandidates: identity.suppressionCandidates.filter(
            (candidate) => candidate.kind !== "email",
          ),
        },
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("shopify_identity_evidence_invalid");
    expect(await readAtomicState(run.id)).toEqual(before);
    const privacyRows = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM identity_erasure_suppression) AS tombstones,
         (SELECT count(*) FROM identity_matching_key_binding) AS bindings,
         (SELECT count(*) FROM identity_crypto_policy) AS policies,
         (SELECT count(*) FROM source_identity_hmac) AS hmacs`,
    );
    expect(privacyRows.rows[0]).toEqual({
      tombstones: "1",
      bindings: "0",
      policies: "0",
      hmacs: "0",
    });
  });

  it.each([
    {
      name: "customer-only",
      tombstoneKind: "shopify_customer_id" as const,
      tombstoneDigest: "suppression-customer-only",
      identity: {
        status: "available" as const,
        shopifyCustomerId: "gid://shopify/Customer/customer-only",
        digests: [],
        suppressionCandidates: [
          {
            kind: "shopify_customer_id" as const,
            keyVersion: "e1",
            digest: "suppression-customer-only",
          },
        ],
        keyChecks: KEY_CHECKS,
        evaluatedKeyVersions: ["v1"],
      },
    },
    {
      name: "email-only",
      tombstoneKind: "email" as const,
      tombstoneDigest: "suppression-email-only",
      identity: {
        status: "available" as const,
        shopifyCustomerId: null,
        digests: [
          {
            keyVersion: "v1",
            digest: "matching-email-only",
            rotationState: "active" as const,
          },
        ],
        suppressionCandidates: [
          {
            kind: "email" as const,
            keyVersion: "e1",
            digest: "suppression-email-only",
          },
        ],
        keyChecks: KEY_CHECKS,
        evaluatedKeyVersions: ["v1"],
      },
    },
  ])("accepts coherent $name evidence and honors its tombstone", async ({
    tombstoneKind,
    tombstoneDigest,
    identity,
  }) => {
    await testPool!.query(
      `INSERT INTO identity_erasure_suppression (
         id, organization_id, store_id, kind, key_version, digest
       ) VALUES ($1, 'org_a', 'store_a', $2, 'e1', $3)`,
      [`single-alias-${tombstoneKind}`, tombstoneKind, tombstoneDigest],
    );
    await expect(
      persistShopifyIdentityEvidence(
        scope,
        "gid://shopify/Order/1",
        identity,
      ),
    ).resolves.toEqual({ disposition: "suppressed", identityHmacId: null });
    const privateState = await testPool!.query(
      `SELECT shopify_customer_id,
              (SELECT count(*) FROM source_identity_hmac
               WHERE organization_id = 'org_a' AND store_id = 'store_a'
                 AND shopify_order_id = 'order_a') AS hmacs,
              (SELECT count(*) FROM identity_erasure_suppression
               WHERE organization_id = 'org_a' AND store_id = 'store_a') AS tombstones
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(privateState.rows[0]).toEqual({
      shopify_customer_id: null,
      hmacs: "0",
      tombstones: "1",
    });
  });

  it("suppresses identity without removing commerce and retains lifetime binding", async () => {
    await persistShopifyIdentityEvidence(
      scope,
      "gid://shopify/Order/1",
      availableIdentity(),
    );
    await testPool!.query(
      `INSERT INTO identity_erasure_suppression (
         id, organization_id, store_id, kind, key_version, digest
       ) VALUES ('suppression-1', 'org_a', 'store_a', 'email', 'e1', 'suppression-email')`,
    );
    const result = await persistShopifyIdentityEvidence(
      scope,
      "gid://shopify/Order/1",
      availableIdentity(),
    );
    expect(result).toEqual({ disposition: "suppressed", identityHmacId: null });
    const stored = await testPool!.query(
      `SELECT shopify_customer_id, net_sales,
              (SELECT count(*) FROM source_identity_hmac
               WHERE shopify_order_id = 'order_a') AS digests,
              (SELECT count(*) FROM identity_matching_key_binding
               WHERE organization_id = 'org_a' AND store_id = 'store_a') AS bindings
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(stored.rows[0]).toMatchObject({
      shopify_customer_id: null,
      net_sales: "123.45",
      digests: "0",
      bindings: "1",
    });
  });

  it("atomically commits complete evidence, safe observations, checkpoint, and exact replay", async () => {
    const monetaryBefore = await testPool!.query(
      `SELECT updated_at, net_sales, customer_journey, journey_ready, bucket,
              bucket_rule_version, meta_verified, verification_pending,
              cancelled_at, cancel_reason, order_source_name
       FROM shopify_order WHERE id = 'order_a'`,
    );
    const run = await startRun("trigger-atomic");
    const input = {
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete" as const,
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available" as const,
        lineCompleteness: "complete" as const,
      },
      now: new Date("2026-08-01T00:01:00.000Z"),
    };
    const first = await commitShopifyEvidenceOrder(input);
    const replay = await commitShopifyEvidenceOrder(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      committedCursor: FIRST_CURSOR,
      lineDisposition: "complete",
      identityDisposition: "available",
    });
    expect(first.identityHmacId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.observedContentChecksum).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM shopify_evidence_run_observation
          WHERE evidence_run_id = $1) AS content,
         (SELECT count(*) FROM shopify_evidence_run_identity_observation
          WHERE evidence_run_id = $1) AS identity,
         (SELECT cursor FROM shopify_evidence_sync_run WHERE id = $1) AS cursor,
         (SELECT orders_read FROM shopify_evidence_sync_run WHERE id = $1) AS orders_read,
         (SELECT heartbeat_at::text FROM shopify_evidence_sync_run WHERE id = $1) AS heartbeat`,
      [run.id],
    );
    expect(rows.rows[0]).toMatchObject({ content: "1", identity: "1", orders_read: 1 });
    expect(rows.rows[0].cursor).toBeTruthy();
    expect(rows.rows[0].heartbeat).toBe("2026-08-01 00:01:00");
    const monetaryAfter = await testPool!.query(
      `SELECT updated_at, net_sales, customer_journey, journey_ready, bucket,
              bucket_rule_version, meta_verified, verification_pending,
              cancelled_at, cancel_reason, order_source_name
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(monetaryAfter.rows).toEqual(monetaryBefore.rows);

    await expect(
      commitShopifyEvidenceOrder({
        ...input,
        identity: availableIdentity("different-replay-digest"),
      }),
    ).rejects.toThrow("identity observation replay conflicts");
    const unchanged = await testPool!.query<{ id: string }>(
      `SELECT id FROM source_identity_hmac
       WHERE organization_id = 'org_a' AND store_id = 'store_a'
         AND shopify_order_id = 'order_a'`,
    );
    expect(unchanged.rows).toEqual([{ id: first.identityHmacId }]);
  });

  it("keeps content checksums and observation rows independent from excluded private and monetary state", async () => {
    const oldIdentity = {
      ...availableIdentity("private-matching-value-old"),
      shopifyCustomerId: "gid://shopify/Customer/private-old",
      suppressionCandidates: [
        {
          kind: "email" as const,
          keyVersion: "e1",
          digest: "private-suppression-email-old",
        },
        {
          kind: "shopify_customer_id" as const,
          keyVersion: "e1",
          digest: "private-suppression-customer-old",
        },
      ],
    };
    const run1 = await startRun("trigger-privacy-independent-1");
    const first = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run1.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: oldIdentity,
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    const run1Observation = await testPool!.query(
      `SELECT to_jsonb(content_row) AS content,
              to_jsonb(identity_row) AS identity
       FROM shopify_evidence_run_observation AS content_row
       JOIN shopify_evidence_run_identity_observation AS identity_row
         ON identity_row.organization_id = content_row.organization_id
        AND identity_row.store_id = content_row.store_id
        AND identity_row.evidence_run_id = content_row.evidence_run_id
        AND identity_row.order_id = content_row.order_id
       WHERE content_row.evidence_run_id = $1
         AND content_row.order_id = 'order_a'`,
      [run1.id],
    );
    expect(run1Observation.rows).toHaveLength(1);
    await finishShopifyEvidenceRun({
      scope,
      runId: run1.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });

    await testPool!.query(
      `UPDATE shopify_order
       SET net_sales = 987.65,
           customer_journey = '{"marker":"private-journey-marker"}'::jsonb,
           bucket = 'google',
           bucket_rule_version = 999,
           meta_verified = false,
           meta_campaign_id = 'private-meta-marker',
           verification_pending = true,
           cancelled_at = '2026-07-30 09:00:00',
           cancel_reason = 'private-cancel-marker',
           order_source_name = 'private-source-marker'
       WHERE organization_id = 'org_a' AND store_id = 'store_a'
         AND id = 'order_a'`,
    );
    const newIdentity = {
      ...availableIdentity("private-matching-value-new"),
      shopifyCustomerId: "gid://shopify/Customer/private-new",
      suppressionCandidates: [
        {
          kind: "email" as const,
          keyVersion: "e1",
          digest: "private-suppression-email-new",
        },
        {
          kind: "shopify_customer_id" as const,
          keyVersion: "e1",
          digest: "private-suppression-customer-new",
        },
      ],
    };
    await persistShopifyIdentityEvidence(
      scope,
      "gid://shopify/Order/1",
      newIdentity,
    );

    const run2 = await startRun("trigger-privacy-independent-2");
    const second = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run2.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: newIdentity,
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    expect(second.observedContentChecksum).toBe(first.observedContentChecksum);

    const columnAllowlists = await Promise.all([
      testPool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'shopify_evidence_run_observation'
         ORDER BY ordinal_position`,
      ),
      testPool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'shopify_evidence_run_identity_observation'
         ORDER BY ordinal_position`,
      ),
    ]);
    expect(columnAllowlists[0].rows.map((row) => row.column_name)).toEqual([
      "id",
      "organization_id",
      "store_id",
      "evidence_run_id",
      "order_id",
      "line_disposition",
      "identity_disposition",
      "observed_content_checksum",
      "observed_at",
    ]);
    expect(columnAllowlists[1].rows.map((row) => row.column_name)).toEqual([
      "id",
      "organization_id",
      "store_id",
      "evidence_run_id",
      "order_id",
      "identity_hmac_id",
      "observed_at",
    ]);

    const allObservations = await testPool!.query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(content_row) ORDER BY evidence_run_id)
          FROM shopify_evidence_run_observation AS content_row) AS content,
         (SELECT jsonb_agg(to_jsonb(identity_row) ORDER BY evidence_run_id)
          FROM shopify_evidence_run_identity_observation AS identity_row) AS identity`,
    );
    const serialized = JSON.stringify([
      run1Observation.rows,
      allObservations.rows,
    ]);
    const containsExcludedValue = [
      "test-private-email-marker@example.com",
      "gid://shopify/Customer/private-old",
      "gid://shopify/Customer/private-new",
      "private-matching-value-old",
      "private-matching-value-new",
      "private-suppression-email-old",
      "private-suppression-customer-old",
      "private-suppression-email-new",
      "private-suppression-customer-new",
      KEY_CHECKS.matching[0].keyCheck,
      KEY_CHECKS.suppression.keyCheck,
      "123.45",
      "987.65",
      "private-previous-version-marker",
      "private-journey-marker",
      "private-meta-marker",
      "private-cancel-marker",
      "private-source-marker",
    ].some((excluded) => serialized.includes(excluded));
    expect(containsExcludedValue).toBe(false);
  });

  it("replays exactly without rewriting evidence and renews only the heartbeat", async () => {
    const run = await startRun("trigger-byte-replay");
    const input = {
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete" as const,
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available" as const,
        lineCompleteness: "complete" as const,
      },
      now: new Date("2026-08-01T00:01:00.000Z"),
    };
    const first = await commitShopifyEvidenceOrder(input);
    const before = await readAtomicState(run.id);
    const replay = await commitShopifyEvidenceOrder({
      ...input,
      lines: {
        ...firstCompleteSet,
        lines: [...firstCompleteSet.lines].reverse().map((line, index) => ({
          ...line,
          productTitle: `Presentation ${index}`,
          variantTitle: `Presentation variant ${index}`,
          sourcePosition: 100 + index,
        })),
      },
      now: new Date("2026-08-01T00:02:00.000Z"),
    });
    const after = await readAtomicState(run.id);
    expect(replay).toEqual({ ...first, identityHmacId: first.identityHmacId });
    expect(after.lines).toEqual(before.lines);
    expect(after.hmacs).toEqual(before.hmacs);
    expect(after.order).toEqual(before.order);
    expect(after.observations).toEqual(before.observations);
    expect(after.run[0]).toEqual({
      ...before.run[0],
      heartbeat_at: "2026-08-01 00:02:00",
    });
  });

  it("rejects a replay whose complete content checksum disagrees without mutation", async () => {
    const run = await startRun("trigger-content-replay-conflict");
    const input = {
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete" as const,
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available" as const,
        lineCompleteness: "complete" as const,
      },
    };
    await commitShopifyEvidenceOrder(input);
    const before = await readAtomicState(run.id);
    await expect(
      commitShopifyEvidenceOrder({
        ...input,
        lines: {
          ...firstCompleteSet,
          lines: [
            { ...firstCompleteSet.lines[0], productTitle: "Changed", quantity: 9 },
          ],
        },
      }),
    ).rejects.toThrow("observation replay conflicts");
    expect(await readAtomicState(run.id)).toEqual(before);
  });

  it("does not resurrect an identity link legitimately removed before replay", async () => {
    const run = await startRun("trigger-erased-replay");
    const input = {
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete" as const,
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available" as const,
        lineCompleteness: "complete" as const,
      },
    };
    const committed = await commitShopifyEvidenceOrder(input);
    await testPool!.query(
      `UPDATE shopify_order SET shopify_customer_id = null WHERE id = 'order_a'`,
    );
    await testPool!.query("DELETE FROM source_identity_hmac WHERE id = $1", [
      committed.identityHmacId,
    ]);
    const replay = await commitShopifyEvidenceOrder(input);
    expect(replay).toMatchObject({
      observedContentChecksum: committed.observedContentChecksum,
      identityDisposition: "available",
      identityHmacId: null,
    });
    const state = await readAtomicState(run.id);
    expect(state.hmacs).toEqual([]);
    expect(state.observations).toEqual([{ content: "1", identity: "0" }]);
    expect(state.order[0]).toMatchObject({ customer_identity_absent: true });
  });

  it("rolls back lines, identity, observation, and checkpoint together", async () => {
    await replaceCompleteShopifyLineSet(scope, firstCompleteSet);
    const run = await startRun("trigger-rollback");
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: {
          ...firstCompleteSet,
          lines: [{ ...firstCompleteSet.lines[0], quantity: 0 }],
        },
        lineDisposition: "complete",
        identity: availableIdentity(),
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow();
    expect(await readLineIds()).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
    const rows = await testPool!.query(
      `SELECT cursor, orders_read,
              (SELECT count(*) FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1) AS observations,
              (SELECT count(*) FROM source_identity_hmac
               WHERE shopify_order_id = 'order_a') AS digests
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(rows.rows[0]).toMatchObject({
      cursor: null,
      orders_read: 0,
      observations: "0",
      digests: "0",
    });
  });

  it.each([
    {
      name: "the wrong order ID",
      nextCursor: { ...FIRST_CURSOR, id: "order_a2" },
    },
    {
      name: "the wrong order timestamp",
      nextCursor: {
        ...FIRST_CURSOR,
        orderCreatedAt: new Date("2026-07-30T01:00:01.000Z"),
      },
    },
    {
      name: "a cursor belonging to a later order",
      nextCursor: SECOND_CURSOR,
    },
  ])("rejects an order commit checkpoint with $name", async ({ nextCursor }) => {
    const run = await startRun(`trigger-cursor-${nextCursor.id}-${nextCursor.orderCreatedAt.getTime()}`);
    const before = await readAtomicState(run.id);
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: availableIdentity(),
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("cursor does not identify its locked order");
    expect(await readAtomicState(run.id)).toEqual(before);
    const policy = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM identity_matching_key_binding) AS bindings,
         (SELECT count(*) FROM identity_crypto_policy) AS policies`,
    );
    expect(policy.rows[0]).toEqual({ bindings: "0", policies: "0" });
  });

  it("rejects malformed available identity before atomic line or policy writes", async () => {
    const run = await startRun("trigger-malformed-atomic");
    const before = await readAtomicState(run.id);
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: {
          ...availableIdentity(),
          evaluatedKeyVersions: ["v1", "v0"],
        },
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("shopify_identity_evidence_invalid");
    expect(await readAtomicState(run.id)).toEqual(before);
    const policy = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM identity_matching_key_binding) AS bindings,
         (SELECT count(*) FROM identity_crypto_policy) AS policies`,
    );
    expect(policy.rows[0]).toEqual({ bindings: "0", policies: "0" });
  });

  it("rejects cross-run and cross-order membership without advancing state", async () => {
    const run = await startRun("trigger-cross-membership");
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: "run-outside-scope",
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: { status: "not_refreshed" },
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1 },
          identityCapability: "unknown",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("not active in this scope");
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a2",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: { status: "not_refreshed" },
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1 },
          identityCapability: "unknown",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("order was not found");
    const stored = await testPool!.query(
      `SELECT cursor, orders_read,
              (SELECT count(*) FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1) AS observations
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(stored.rows[0]).toEqual({
      cursor: null,
      orders_read: 0,
      observations: "0",
    });
  });

  it("accepts an order exactly on the inclusive run lower bound", async () => {
    const run = await startRun("trigger-window-lower-inclusive");
    await testPool!.query(
      `UPDATE shopify_order
       SET order_created_at = (
         SELECT requested_from FROM shopify_evidence_sync_run WHERE id = $1
       )
       WHERE id = 'order_a'`,
      [run.id],
    );
    const lowerCursor = await readPersistedOrderCursor("order_a");
    const committed = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: lowerCursor,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    expect(committed.committedCursor).toEqual(lowerCursor);
  });

  it.each([
    {
      name: "below the inclusive lower bound",
      boundary: "below" as const,
    },
    {
      name: "on the exclusive upper bound",
      boundary: "upper" as const,
    },
  ])("rejects an order $name without mutating atomic state", async ({ boundary }) => {
    const run = await startRun(`trigger-window-outside-${boundary}`);
    await testPool!.query(
      `UPDATE shopify_order
       SET order_created_at = (
         SELECT CASE WHEN $2::text = 'below'
           THEN requested_from - interval '1 millisecond'
           ELSE requested_to
         END
         FROM shopify_evidence_sync_run WHERE id = $1
       )
       WHERE id = 'order_a'`,
      [run.id, boundary],
    );
    const outsideCursor = await readPersistedOrderCursor("order_a");
    const before = await readAtomicState(run.id);
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: outsideCursor,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: availableIdentity(),
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("outside the Shopify evidence run window");
    expect(await readAtomicState(run.id)).toEqual(before);
    const policies = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM identity_matching_key_binding) AS bindings,
         (SELECT count(*) FROM identity_crypto_policy) AS policies`,
    );
    expect(policies.rows[0]).toEqual({ bindings: "0", policies: "0" });
  });

  it("enforces the immutable run window before replay heartbeat mutation", async () => {
    const run = await startRun("trigger-window-replay");
    const input = {
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete" as const,
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available" as const,
        lineCompleteness: "complete" as const,
      },
    };
    await commitShopifyEvidenceOrder(input);
    await testPool!.query(
      `UPDATE shopify_evidence_sync_run
       SET requested_from = '2026-07-30 01:00:00.001'
       WHERE id = $1`,
      [run.id],
    );
    const before = await readAtomicState(run.id);
    await expect(
      commitShopifyEvidenceOrder({
        ...input,
        now: new Date("2026-08-01T00:05:00.000Z"),
      }),
    ).rejects.toThrow("outside the Shopify evidence run window");
    expect(await readAtomicState(run.id)).toEqual(before);
  });

  it("rejects a commit whose locked order belongs to another store", async () => {
    const storeA2Scope = { organizationId: "org_a", storeId: "store_a2" };
    const run = await startRun(
      "trigger-wrong-store-order",
      new Date("2026-08-01T00:00:00.000Z"),
      storeA2Scope,
    );
    const before = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    await expect(
      commitShopifyEvidenceOrder({
        scope: storeA2Scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: { status: "not_refreshed" },
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1 },
          identityCapability: "unknown",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("order was not found");
    const after = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await readLineIds()).toEqual([]);
  });

  it("rejects an identity observation linked to a digest from another store", async () => {
    const run = await startRun("trigger-cross-digest-link");
    await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: { status: "not_refreshed" },
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "unknown",
        lineCompleteness: "complete",
      },
    });
    await testPool!.query(
      `INSERT INTO source_identity_hmac (
         id, organization_id, store_id, source_kind, shopify_order_id,
         key_version, digest, rotation_state
       ) VALUES (
         'foreign-hmac', 'org_b', 'store_b', 'shopify_order', 'order_b',
         'v1', 'foreign-value-not-inspected', 'active'
       )`,
    );
    await expect(
      testPool!.query(
        `INSERT INTO shopify_evidence_run_identity_observation (
           id, organization_id, store_id, evidence_run_id, order_id,
           identity_hmac_id
         ) VALUES (
           'bad-cross-link', 'org_a', 'store_a', $1, 'order_a',
           'foreign-hmac'
         )`,
        [run.id],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "shopify_evidence_identity_observation_hmac_fk",
    });
    const links = await testPool!.query(
      `SELECT count(*) AS links
       FROM shopify_evidence_run_identity_observation
       WHERE evidence_run_id = $1`,
      [run.id],
    );
    expect(links.rows[0]).toEqual({ links: "0" });
  });

  it("preserves partial lines and unavailable identity while committing safe progress", async () => {
    await replaceCompleteShopifyLineSet(scope, firstCompleteSet);
    const run = await startRun("trigger-partial");
    const result = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: null,
      lineDisposition: "preserved_partial",
      identity: { status: "not_refreshed" },
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersPartial: 1, failures: 1 },
        identityCapability: "unknown",
        lineCompleteness: "partial",
      },
    });
    expect(result.identityDisposition).toBe("not_refreshed");
    expect(await readLineIds()).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
  });

  it("resumes the second order from the first committed cursor after rollback", async () => {
    const run = await startRun("trigger-later-order-retry");
    await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: { status: "not_refreshed" },
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "unknown",
        lineCompleteness: "complete",
      },
    });
    const secondSet = {
      ...firstCompleteSet,
      shopifyOrderId: "gid://shopify/Order/2",
      lines: [
        {
          ...firstCompleteSet.lines[0],
          shopifyLineItemId: "gid://shopify/LineItem/20",
          quantity: 0,
        },
      ],
    };
    const secondProgress = {
      counts: { ...ZERO_COUNTS, ordersRead: 2, ordersEnriched: 2 },
      identityCapability: "unknown" as const,
      lineCompleteness: "complete" as const,
    };
    await expect(
      commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a2",
        shopifyOrderId: "gid://shopify/Order/2",
        expectedCursor: FIRST_CURSOR,
        nextCursor: SECOND_CURSOR,
        lines: secondSet,
        lineDisposition: "complete",
        identity: { status: "not_refreshed" },
        progress: secondProgress,
      }),
    ).rejects.toThrow();
    let stored = await testPool!.query(
      `SELECT cursor, orders_read,
              (SELECT count(*) FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1) AS observations,
              (SELECT count(*) FROM shopify_order_line
               WHERE order_id = 'order_a2') AS second_lines
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(stored.rows[0]).toMatchObject({
      orders_read: 1,
      observations: "1",
      second_lines: "0",
    });
    const persistedFirstCursor = stored.rows[0].cursor;

    const committed = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run.id,
      orderId: "order_a2",
      shopifyOrderId: "gid://shopify/Order/2",
      expectedCursor: FIRST_CURSOR,
      nextCursor: SECOND_CURSOR,
      lines: {
        ...secondSet,
        lines: [{ ...secondSet.lines[0], quantity: 2 }],
      },
      lineDisposition: "complete",
      identity: { status: "not_refreshed" },
      progress: secondProgress,
    });
    expect(committed.committedCursor).toEqual(SECOND_CURSOR);
    stored = await testPool!.query(
      `SELECT cursor, orders_read,
              (SELECT count(*) FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1) AS observations,
              (SELECT count(*) FROM shopify_order_line
               WHERE order_id = 'order_a2') AS second_lines
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(stored.rows[0]).toMatchObject({
      orders_read: 2,
      observations: "2",
      second_lines: "1",
    });
    expect(stored.rows[0].cursor).not.toBe(persistedFirstCursor);
  });

  it("canonicalizes line ordering while distinguishing semantic content changes", async () => {
    const progress = {
      counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
      identityCapability: "unknown" as const,
      lineCompleteness: "complete" as const,
    };
    const run1 = await startRun("trigger-checksum-order-1");
    const first = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run1.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: { status: "not_refreshed" },
      progress,
    });
    await finishShopifyEvidenceRun({
      scope,
      runId: run1.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress,
    });

    const run2 = await startRun("trigger-checksum-order-2");
    const reordered = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run2.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: {
        ...firstCompleteSet,
        lines: [...firstCompleteSet.lines].reverse().map((line, index) => ({
          ...line,
          productTitle: `Rewritten title ${index}`,
          variantTitle: `Rewritten variant ${index}`,
          sourcePosition: 50 + index,
        })),
      },
      lineDisposition: "complete",
      identity: { status: "not_refreshed" },
      progress,
    });
    expect(reordered.observedContentChecksum).toBe(first.observedContentChecksum);
    await finishShopifyEvidenceRun({
      scope,
      runId: run2.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress,
    });

    const run3 = await startRun("trigger-checksum-order-3");
    const changed = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run3.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: {
        ...firstCompleteSet,
        lines: [{ ...firstCompleteSet.lines[0], quantity: 3 }],
      },
      lineDisposition: "complete",
      identity: { status: "not_refreshed" },
      progress,
    });
    expect(changed.observedContentChecksum).not.toBe(first.observedContentChecksum);
  });

  it("cascades changed or erased identity links but retains immutable content observations", async () => {
    const run1 = await startRun("trigger-history-1");
    const first = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run1.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: availableIdentity("digest-one"),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    const olderBefore = await testPool!.query(
      `SELECT observed_content_checksum, line_disposition, identity_disposition
       FROM shopify_evidence_run_observation
       WHERE evidence_run_id = $1 AND order_id = 'order_a'`,
      [run1.id],
    );
    await finishShopifyEvidenceRun({
      scope,
      runId: run1.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    const run2 = await startRun("trigger-history-2");
    const second = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run2.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: {
        ...firstCompleteSet,
        lines: [
          { ...firstCompleteSet.lines[0], productTitle: "Later failed content" },
        ],
      },
      lineDisposition: "complete",
      identity: availableIdentity("digest-two"),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    expect(second.identityHmacId).not.toBe(first.identityHmacId);
    expect(second.observedContentChecksum).not.toBe(first.observedContentChecksum);
    await finishShopifyEvidenceRun({
      scope,
      runId: run2.id,
      expectedCursor: FIRST_CURSOR,
      status: "failed",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
      error: "evidence_batch_failed",
    });
    const olderAfter = await testPool!.query(
      `SELECT observed_content_checksum, line_disposition, identity_disposition
       FROM shopify_evidence_run_observation
       WHERE evidence_run_id = $1 AND order_id = 'order_a'`,
      [run1.id],
    );
    expect(olderAfter.rows).toEqual(olderBefore.rows);
    const failedLater = await testPool!.query(
      `SELECT status, error FROM shopify_evidence_sync_run WHERE id = $1`,
      [run2.id],
    );
    expect(failedLater.rows[0]).toEqual({
      status: "failed",
      error: "evidence_batch_failed",
    });
    let counts = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM shopify_evidence_run_observation) AS content,
         (SELECT count(*) FROM shopify_evidence_run_identity_observation) AS identity`,
    );
    expect(counts.rows[0]).toEqual({ content: "2", identity: "1" });
    await testPool!.query("DELETE FROM source_identity_hmac WHERE id = $1", [
      second.identityHmacId,
    ]);
    counts = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM shopify_evidence_run_observation) AS content,
         (SELECT count(*) FROM shopify_evidence_run_identity_observation) AS identity`,
    );
    expect(counts.rows[0]).toEqual({ content: "2", identity: "0" });
  });

  it.each([
    { name: "subject erasure", deletion: "subject" as const, clearsCustomer: true },
    { name: "pilot uninstall", deletion: "uninstall" as const, clearsCustomer: true },
    { name: "rotation prune", deletion: "rotation" as const, clearsCustomer: false },
  ])("keeps content and lifetime binding after $name identity deletion", async ({
    deletion,
    clearsCustomer,
  }) => {
    const run = await startRun(`trigger-delete-${deletion}`);
    const committed = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    const before = await testPool!.query(
      `SELECT updated_at::text, net_sales, customer_journey, bucket,
              (SELECT observed_content_checksum
               FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1 AND order_id = 'order_a') AS checksum
       FROM shopify_order WHERE id = 'order_a'`,
      [run.id],
    );

    if (deletion === "subject") {
      await testPool!.query(
        `WITH cleared AS (
           UPDATE shopify_order SET shopify_customer_id = null
           WHERE organization_id = 'org_a' AND store_id = 'store_a'
             AND id = 'order_a'
           RETURNING id
         )
         DELETE FROM source_identity_hmac
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
           AND shopify_order_id IN (SELECT id FROM cleared)`,
      );
    } else if (deletion === "uninstall") {
      await testPool!.query(
        `WITH cleared AS (
           UPDATE shopify_order SET shopify_customer_id = null
           WHERE organization_id = 'org_a' AND store_id = 'store_a'
           RETURNING id
         )
         DELETE FROM source_identity_hmac
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
           AND shopify_order_id IN (SELECT id FROM cleared)`,
      );
    } else {
      await testPool!.query(
        `DELETE FROM source_identity_hmac
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
           AND key_version = 'v1'`,
      );
    }

    const after = await testPool!.query(
      `SELECT updated_at::text, net_sales, customer_journey, bucket,
              shopify_customer_id IS NULL AS customer_identity_absent,
              (SELECT count(*) FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1 AND order_id = 'order_a') AS content,
              (SELECT count(*) FROM shopify_evidence_run_identity_observation
               WHERE evidence_run_id = $1 AND order_id = 'order_a') AS identity,
              (SELECT count(*) FROM source_identity_hmac
               WHERE organization_id = 'org_a' AND store_id = 'store_a'
                 AND shopify_order_id = 'order_a') AS hmacs,
              (SELECT count(*) FROM identity_matching_key_binding
               WHERE organization_id = 'org_a' AND store_id = 'store_a') AS bindings,
              (SELECT observed_content_checksum
               FROM shopify_evidence_run_observation
               WHERE evidence_run_id = $1 AND order_id = 'order_a') AS checksum
       FROM shopify_order WHERE id = 'order_a'`,
      [run.id],
    );
    expect(after.rows[0]).toMatchObject({
      updated_at: before.rows[0].updated_at,
      net_sales: before.rows[0].net_sales,
      customer_journey: before.rows[0].customer_journey,
      bucket: before.rows[0].bucket,
      customer_identity_absent: clearsCustomer,
      content: "1",
      identity: "0",
      hmacs: "0",
      bindings: "1",
      checksum: committed.observedContentChecksum,
    });
  });

  it("shares the store-first lock with suppression so erasure-first cannot resurrect identity", async () => {
    const run = await startRun("trigger-suppression-race");
    const locker = await testPool!.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        `SELECT id FROM shopify_store
         WHERE organization_id = 'org_a' AND id = 'store_a' FOR UPDATE`,
      );
      const commitPromise = commitShopifyEvidenceOrder({
        scope,
        evidenceRunId: run.id,
        orderId: "order_a",
        shopifyOrderId: "gid://shopify/Order/1",
        expectedCursor: null,
        nextCursor: FIRST_CURSOR,
        lines: firstCompleteSet,
        lineDisposition: "complete",
        identity: availableIdentity(),
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      });
      await locker.query(
        `INSERT INTO identity_erasure_suppression (
           id, organization_id, store_id, kind, key_version, digest
         ) VALUES (
           'race-suppression', 'org_a', 'store_a', 'email', 'e1', 'suppression-email'
         )`,
      );
      await locker.query("COMMIT");
      const committed = await commitPromise;
      expect(committed.identityDisposition).toBe("suppressed");
      expect(committed.identityHmacId).toBeNull();
      const privateRows = await testPool!.query(
        `SELECT shopify_customer_id,
                (SELECT count(*) FROM source_identity_hmac
                 WHERE shopify_order_id = 'order_a') AS digests,
                (SELECT count(*) FROM shopify_evidence_run_identity_observation
                 WHERE evidence_run_id = $1) AS identity_links,
                (SELECT count(*) FROM shopify_order_line
                 WHERE order_id = 'order_a') AS lines
         FROM shopify_order WHERE id = 'order_a'`,
        [run.id],
      );
      expect(privateRows.rows[0]).toMatchObject({
        shopify_customer_id: null,
        digests: "0",
        identity_links: "0",
        lines: "2",
      });
      expect(privateRows.rows[0]).toHaveProperty("shopify_customer_id", null);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
  });

  it("keeps content history and prevents resurrection in the commit-first erasure schedule", async () => {
    const run1 = await startRun("trigger-commit-first-1");
    await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run1.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    await finishShopifyEvidenceRun({
      scope,
      runId: run1.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });

    const erasure = await testPool!.connect();
    try {
      await erasure.query("BEGIN");
      await erasure.query(
        `SELECT id FROM shopify_store
         WHERE organization_id = 'org_a' AND id = 'store_a' FOR UPDATE`,
      );
      await erasure.query(
        `INSERT INTO identity_erasure_suppression (
           id, organization_id, store_id, kind, key_version, digest
         ) VALUES (
           'commit-first-suppression', 'org_a', 'store_a',
           'email', 'e1', 'suppression-email'
         )`,
      );
      await erasure.query(
        `UPDATE shopify_order SET shopify_customer_id = null
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
           AND id = 'order_a'`,
      );
      await erasure.query(
        `DELETE FROM source_identity_hmac
         WHERE organization_id = 'org_a' AND store_id = 'store_a'
           AND shopify_order_id = 'order_a'`,
      );
      await erasure.query("COMMIT");
    } finally {
      await erasure.query("ROLLBACK").catch(() => undefined);
      erasure.release();
    }

    let history = await testPool!.query(
      `SELECT
         (SELECT count(*) FROM shopify_evidence_run_observation
          WHERE evidence_run_id = $1) AS content,
         (SELECT count(*) FROM shopify_evidence_run_identity_observation
          WHERE evidence_run_id = $1) AS identity`,
      [run1.id],
    );
    expect(history.rows[0]).toEqual({ content: "1", identity: "0" });

    const run2 = await startRun("trigger-commit-first-2");
    const next = await commitShopifyEvidenceOrder({
      scope,
      evidenceRunId: run2.id,
      orderId: "order_a",
      shopifyOrderId: "gid://shopify/Order/1",
      expectedCursor: null,
      nextCursor: FIRST_CURSOR,
      lines: firstCompleteSet,
      lineDisposition: "complete",
      identity: availableIdentity(),
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    expect(next.identityDisposition).toBe("suppressed");
    const final = await testPool!.query(
      `SELECT shopify_customer_id,
              (SELECT count(*) FROM source_identity_hmac
               WHERE shopify_order_id = 'order_a') AS digests,
              (SELECT count(*) FROM shopify_order_line
               WHERE order_id = 'order_a') AS lines,
              (SELECT cursor FROM shopify_evidence_sync_run WHERE id = $1) AS cursor
       FROM shopify_order WHERE id = 'order_a'`,
      [run2.id],
    );
    expect(final.rows[0]).toMatchObject({
      shopify_customer_id: null,
      digests: "0",
      lines: "2",
    });
    expect(final.rows[0].cursor).toBeTruthy();
    history = await testPool!.query(
      `SELECT count(*) AS content FROM shopify_evidence_run_observation
       WHERE evidence_run_id = $1`,
      [run1.id],
    );
    expect(history.rows[0]).toEqual({ content: "1" });
  });

  it("persists the exact approved start authority and initial liveness state", async () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const run = await startRun("trigger-start-authority", now);
    const stored = await testPool!.query(
      `SELECT id, start_trigger_run_id, first_batch_trigger_run_id,
              organization_id, store_id, mode, store_timezone,
              anchor_store_day, requested_from::text, requested_to::text,
              cursor, status, identity_capability, line_completeness,
              orders_read, orders_enriched, orders_partial,
              orders_unavailable, warnings, failures, error,
              heartbeat_at::text, started_at::text, finished_at
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(stored.rows[0]).toEqual({
      id: run.id,
      start_trigger_run_id: "trigger-start-authority",
      first_batch_trigger_run_id: null,
      organization_id: "org_a",
      store_id: "store_a",
      mode: "incremental_7d",
      store_timezone: "UTC",
      anchor_store_day: "2026-07-31",
      requested_from: "2026-07-25 00:00:00",
      requested_to: "2026-08-01 00:00:00",
      cursor: null,
      status: "running",
      identity_capability: "unknown",
      line_completeness: "unknown",
      orders_read: 0,
      orders_enriched: 0,
      orders_partial: 0,
      orders_unavailable: 0,
      warnings: 0,
      failures: 0,
      error: null,
      heartbeat_at: "2026-08-01 00:00:00",
      started_at: "2026-08-01 00:00:00",
      finished_at: null,
    });
  });

  it("renews exactly one scoped running heartbeat and no other run column", async () => {
    const run = await startRun(
      "trigger-direct-heartbeat",
      new Date("2000-01-01T00:00:00.000Z"),
    );
    const before = await testPool!.query(
      `SELECT to_jsonb(run_row) - 'heartbeat_at' AS stable,
              heartbeat_at::text AS heartbeat
       FROM shopify_evidence_sync_run AS run_row
       WHERE id = $1`,
      [run.id],
    );
    expect(before.rows).toHaveLength(1);
    const exactNow = new Date("2026-08-01T03:04:05.000Z");
    await renewShopifyEvidenceRunHeartbeat(scope, run.id, exactNow);
    const after = await testPool!.query(
      `SELECT to_jsonb(run_row) - 'heartbeat_at' AS stable,
              heartbeat_at::text AS heartbeat
       FROM shopify_evidence_sync_run AS run_row
       WHERE id = $1`,
      [run.id],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].stable).toEqual(before.rows[0].stable);
    expect(after.rows[0].heartbeat).toBe("2026-08-01 03:04:05");
  });

  it("get-or-creates one stable start trigger row without replay rewrites", async () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const first = await startRun("trigger-stable-start", now);
    const before = await testPool!.query(
      `SELECT to_jsonb(run_row) AS run
       FROM shopify_evidence_sync_run AS run_row
       WHERE id = $1`,
      [first.id],
    );
    const replay = await startRun("trigger-stable-start", now);
    const after = await testPool!.query(
      `SELECT to_jsonb(run_row) AS run
       FROM shopify_evidence_sync_run AS run_row
       WHERE id = $1`,
      [first.id],
    );
    expect(replay).toEqual({
      id: first.id,
      status: "running",
      firstBatchTriggerRunId: null,
      replayed: true,
    });
    expect(after.rows).toEqual(before.rows);
    const count = await testPool!.query(
      `SELECT count(*) AS runs FROM shopify_evidence_sync_run
       WHERE start_trigger_run_id = 'trigger-stable-start'`,
    );
    expect(count.rows[0]).toEqual({ runs: "1" });
  });

  it.each([
    {
      name: "mode and window",
      scope,
      mode: "initial_90d" as const,
      storeTimezone: "UTC",
      anchorStoreDay: "2026-07-31",
      window: {
        from: new Date("2026-05-03T00:00:00.000Z"),
        to: new Date("2026-08-01T00:00:00.000Z"),
      },
    },
    {
      name: "scope",
      scope: { organizationId: "org_a", storeId: "store_a2" },
      mode: "incremental_7d" as const,
      storeTimezone: "UTC",
      anchorStoreDay: "2026-07-31",
      window: {
        from: new Date("2026-07-25T00:00:00.000Z"),
        to: new Date("2026-08-01T00:00:00.000Z"),
      },
    },
    {
      name: "anchor and window",
      scope,
      mode: "incremental_7d" as const,
      storeTimezone: "UTC",
      anchorStoreDay: "2026-07-30",
      window: {
        from: new Date("2026-07-24T00:00:00.000Z"),
        to: new Date("2026-07-31T00:00:00.000Z"),
      },
    },
    {
      name: "timezone and window",
      scope,
      mode: "incremental_7d" as const,
      storeTimezone: "Asia/Manila",
      anchorStoreDay: "2026-07-31",
      window: {
        from: new Date("2026-07-24T16:00:00.000Z"),
        to: new Date("2026-07-31T16:00:00.000Z"),
      },
    },
  ])("rejects stable start trigger reuse with conflicting $name authority", async (conflict) => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const first = await startRun("trigger-stable-conflict", now);
    const before = await testPool!.query(
      `SELECT to_jsonb(run_row) AS run
       FROM shopify_evidence_sync_run AS run_row
       WHERE id = $1`,
      [first.id],
    );
    await expect(
      startShopifyEvidenceRun({
        startTriggerRunId: "trigger-stable-conflict",
        scope: conflict.scope,
        mode: conflict.mode,
        storeTimezone: conflict.storeTimezone,
        anchorStoreDay: conflict.anchorStoreDay,
        window: conflict.window,
        disposition: { kind: "running", identityCapability: "unknown" },
        now,
      }),
    ).rejects.toThrow("Shopify evidence start idempotency conflict");
    const after = await testPool!.query(
      `SELECT to_jsonb(run_row) AS run
       FROM shopify_evidence_sync_run AS run_row
       WHERE id = $1`,
      [first.id],
    );
    expect(after.rows).toEqual(before.rows);
    const count = await testPool!.query(
      `SELECT count(*) AS runs FROM shopify_evidence_sync_run`,
    );
    expect(count.rows[0]).toEqual({ runs: "1" });
  });

  it("lets the database partial unique index independently reject a second running row", async () => {
    await startRun("trigger-index-running");
    await expect(
      testPool!.query(
        `INSERT INTO shopify_evidence_sync_run (
           id, start_trigger_run_id, organization_id, store_id, mode,
           store_timezone, anchor_store_day, requested_from, requested_to,
           status, heartbeat_at, started_at
         ) VALUES (
           'manual-second-running', 'trigger-manual-second-running',
           'org_a', 'store_a', 'incremental_7d', 'UTC', '2026-07-31',
           '2026-07-25 00:00:00', '2026-08-01 00:00:00',
           'running', now(), now()
         )`,
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "shopify_evidence_sync_run_one_running_store_uidx",
    });
  });

  it("renews heartbeat for both first-batch handoff and checkpoint", async () => {
    const run = await startRun("trigger-heartbeat-contract");
    await testPool!.query(
      `UPDATE shopify_evidence_sync_run SET heartbeat_at = '2000-01-01'
       WHERE id = $1`,
      [run.id],
    );
    await recordFirstBatchTriggerRunId({
      scope,
      runId: run.id,
      triggerRunId: "batch-heartbeat",
    });
    let heartbeat = await testPool!.query(
      `SELECT heartbeat_at > '2000-01-01'::timestamp AS renewed,
              first_batch_trigger_run_id
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(heartbeat.rows[0]).toEqual({
      renewed: true,
      first_batch_trigger_run_id: "batch-heartbeat",
    });
    await recordFirstBatchTriggerRunId({
      scope,
      runId: run.id,
      triggerRunId: "batch-heartbeat",
    });
    await expect(
      recordFirstBatchTriggerRunId({
        scope,
        runId: run.id,
        triggerRunId: "batch-divergent",
      }),
    ).rejects.toThrow("handoff conflicts");

    await testPool!.query(
      `UPDATE shopify_evidence_sync_run SET heartbeat_at = '2001-01-01'
       WHERE id = $1`,
      [run.id],
    );
    await checkpointShopifyEvidenceRun(scope, run.id, null, FIRST_CURSOR, {
      counts: { ...ZERO_COUNTS, ordersRead: 1 },
      identityCapability: "unknown",
      lineCompleteness: "complete",
    });
    heartbeat = await testPool!.query(
      `SELECT heartbeat_at > '2001-01-01'::timestamp AS renewed,
              orders_read, line_completeness
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(heartbeat.rows[0]).toEqual({
      renewed: true,
      orders_read: 1,
      line_completeness: "complete",
    });
  });

  it("enforces scoped run lifecycle CAS, monotonic progress, and terminal idempotency", async () => {
    const run = await startRun("trigger-lifecycle");
    await expect(
      startRun("trigger-second-live"),
    ).rejects.toThrow("already owns this store");
    await recordFirstBatchTriggerRunId({
      scope,
      runId: run.id,
      triggerRunId: "batch-trigger-1",
    });
    await recordFirstBatchTriggerRunId({
      scope,
      runId: run.id,
      triggerRunId: "batch-trigger-1",
    });
    await expect(
      recordFirstBatchTriggerRunId({
        scope,
        runId: run.id,
        triggerRunId: "batch-trigger-2",
      }),
    ).rejects.toThrow("conflicts");
    await checkpointShopifyEvidenceRun(scope, run.id, null, FIRST_CURSOR, {
      counts: { ...ZERO_COUNTS, ordersRead: 1 },
      identityCapability: "available",
      lineCompleteness: "complete",
    });
    await expect(
      checkpointShopifyEvidenceRun(scope, run.id, null, SECOND_CURSOR, {
        counts: { ...ZERO_COUNTS, ordersRead: 2 },
        identityCapability: "available",
        lineCompleteness: "complete",
      }),
    ).rejects.toThrow("compare-and-set");
    await expect(
      checkpointShopifyEvidenceRun(scope, run.id, FIRST_CURSOR, SECOND_CURSOR, {
        counts: ZERO_COUNTS,
        identityCapability: "available",
        lineCompleteness: "complete",
      }),
    ).rejects.toThrow("cannot decrease");
    await expect(
      checkpointShopifyEvidenceRun(scope, run.id, FIRST_CURSOR, SECOND_CURSOR, {
        counts: { ...ZERO_COUNTS, ordersRead: 1 },
        identityCapability: "unknown",
        lineCompleteness: "unknown",
      }),
    ).rejects.toThrow("state transition is invalid");
    await expect(
      renewShopifyEvidenceRunHeartbeat(otherScope, run.id, new Date()),
    ).rejects.toThrow("not active in this scope");
    await expect(
      finishShopifyEvidenceRun({
        scope,
        runId: run.id,
        expectedCursor: FIRST_CURSOR,
        status: "failed",
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
        error: "provider said something private",
      }),
    ).rejects.toThrow("error code is invalid");
    await finishShopifyEvidenceRun({
      scope,
      runId: run.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1 },
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    const terminalBefore = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    await expect(
      finishShopifyEvidenceRun({
        scope,
        runId: run.id,
        expectedCursor: FIRST_CURSOR,
        status: "failed",
        progress: {
          counts: { ...ZERO_COUNTS, ordersRead: 1 },
          identityCapability: "available",
          lineCompleteness: "complete",
        },
      }),
    ).rejects.toThrow("not active in this scope");
    const terminalAfter = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(terminalAfter.rows).toEqual(terminalBefore.rows);
    await expect(
      failShopifyEvidenceRunAfterRetryExhaustion(scope, run.id, "batch"),
    ).resolves.toEqual({ changed: false });
  });

  it.each([
    {
      name: "identity available to unknown",
      currentIdentity: "available" as const,
      nextIdentity: "unknown" as const,
      currentLines: "unknown" as const,
      nextLines: "unknown" as const,
    },
    {
      name: "identity unavailable to unknown",
      currentIdentity: "unavailable" as const,
      nextIdentity: "unknown" as const,
      currentLines: "unknown" as const,
      nextLines: "unknown" as const,
    },
    {
      name: "identity unavailable to available",
      currentIdentity: "unavailable" as const,
      nextIdentity: "available" as const,
      currentLines: "unknown" as const,
      nextLines: "unknown" as const,
    },
    {
      name: "lines complete to unknown",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "complete" as const,
      nextLines: "unknown" as const,
    },
    {
      name: "lines complete to unavailable",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "complete" as const,
      nextLines: "unavailable" as const,
    },
    {
      name: "lines partial to unknown",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "partial" as const,
      nextLines: "unknown" as const,
    },
    {
      name: "lines partial to complete",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "partial" as const,
      nextLines: "complete" as const,
    },
    {
      name: "lines partial to unavailable",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "partial" as const,
      nextLines: "unavailable" as const,
    },
    {
      name: "lines unavailable to unknown",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "unavailable" as const,
      nextLines: "unknown" as const,
    },
    {
      name: "lines unavailable to complete",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "unavailable" as const,
      nextLines: "complete" as const,
    },
    {
      name: "lines unavailable to partial",
      currentIdentity: "unknown" as const,
      nextIdentity: "unknown" as const,
      currentLines: "unavailable" as const,
      nextLines: "partial" as const,
    },
  ])("rejects forbidden checkpoint transition: $name", async ({
    currentIdentity,
    nextIdentity,
    currentLines,
    nextLines,
  }) => {
    const run = await startRun(`trigger-transition-${crypto.randomUUID()}`);
    await checkpointShopifyEvidenceRun(scope, run.id, null, FIRST_CURSOR, {
      counts: { ...ZERO_COUNTS, ordersRead: 1 },
      identityCapability: currentIdentity,
      lineCompleteness: currentLines,
    });
    const before = await testPool!.query(
      `SELECT cursor, identity_capability, line_completeness,
              orders_read, heartbeat_at::text
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    await expect(
      checkpointShopifyEvidenceRun(scope, run.id, FIRST_CURSOR, SECOND_CURSOR, {
        counts: { ...ZERO_COUNTS, ordersRead: 1 },
        identityCapability: nextIdentity,
        lineCompleteness: nextLines,
      }),
    ).rejects.toThrow("state transition is invalid");
    const after = await testPool!.query(
      `SELECT cursor, identity_capability, line_completeness,
              orders_read, heartbeat_at::text
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it.each([
    { name: "a decreasing count", counts: { ...ZERO_COUNTS, ordersRead: 0 } },
    { name: "a negative count", counts: { ...ZERO_COUNTS, ordersRead: -1 } },
    { name: "a fractional count", counts: { ...ZERO_COUNTS, ordersRead: 1, warnings: 0.5 } },
    {
      name: "an unsafe count",
      counts: {
        ...ZERO_COUNTS,
        ordersRead: 1,
        warnings: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ])("rejects checkpoint progress with $name", async ({ counts }) => {
    const run = await startRun(`trigger-count-${crypto.randomUUID()}`);
    await checkpointShopifyEvidenceRun(scope, run.id, null, FIRST_CURSOR, {
      counts: { ...ZERO_COUNTS, ordersRead: 1 },
      identityCapability: "unknown",
      lineCompleteness: "unknown",
    });
    const before = await testPool!.query(
      `SELECT cursor, orders_read, warnings, heartbeat_at::text
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    await expect(
      checkpointShopifyEvidenceRun(scope, run.id, FIRST_CURSOR, SECOND_CURSOR, {
        counts,
        identityCapability: "unknown",
        lineCompleteness: "unknown",
      }),
    ).rejects.toThrow("counts cannot decrease");
    const after = await testPool!.query(
      `SELECT cursor, orders_read, warnings, heartbeat_at::text
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("rejects every wrong-scope lifecycle mutation without changing the run", async () => {
    const run = await startRun("trigger-wrong-scope-lifecycle");
    const before = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    await expect(
      checkpointShopifyEvidenceRun(otherScope, run.id, null, FIRST_CURSOR, {
        counts: { ...ZERO_COUNTS, ordersRead: 1 },
        identityCapability: "unknown",
        lineCompleteness: "complete",
      }),
    ).rejects.toThrow("not active in this scope");
    await expect(
      finishShopifyEvidenceRun({
        scope: otherScope,
        runId: run.id,
        expectedCursor: null,
        status: "failed",
        progress: {
          counts: ZERO_COUNTS,
          identityCapability: "unknown",
          lineCompleteness: "unknown",
        },
      }),
    ).rejects.toThrow("not active in this scope");
    await expect(
      failShopifyEvidenceRunAfterRetryExhaustion(otherScope, run.id, "batch"),
    ).rejects.toThrow("outside this scope");
    await expect(
      failExpiredShopifyEvidenceRun(
        otherScope,
        run.id,
        new Date("2026-08-01T01:00:00.000Z"),
      ),
    ).rejects.toThrow("outside this scope");
    const after = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it.each([
    {
      name: "fabricated increased counts",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 2 },
        identityCapability: "available" as const,
        lineCompleteness: "complete" as const,
      },
    },
    {
      name: "a fabricated capability change",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1 },
        identityCapability: "unavailable" as const,
        lineCompleteness: "complete" as const,
      },
    },
    {
      name: "a fabricated completeness change",
      progress: {
        counts: { ...ZERO_COUNTS, ordersRead: 1 },
        identityCapability: "available" as const,
        lineCompleteness: "partial" as const,
      },
    },
  ])("rejects finishing with $name", async ({ progress }) => {
    const run = await startRun(`trigger-finish-${progress.counts.ordersRead}-${progress.identityCapability}-${progress.lineCompleteness}`);
    await checkpointShopifyEvidenceRun(scope, run.id, null, FIRST_CURSOR, {
      counts: { ...ZERO_COUNTS, ordersRead: 1 },
      identityCapability: "available",
      lineCompleteness: "complete",
    });
    const before = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    await expect(
      finishShopifyEvidenceRun({
        scope,
        runId: run.id,
        expectedCursor: FIRST_CURSOR,
        status: "success",
        progress,
      }),
    ).rejects.toThrow("finish progress conflicts");
    const after = await testPool!.query(
      `SELECT * FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("reaps only expired runs once and permits a replacement", async () => {
    const initialNow = new Date("2026-08-01T00:00:00.000Z");
    const run = await startRun("trigger-stale", initialNow);
    const liveNow = new Date(
      initialNow.getTime() + SHOPIFY_EVIDENCE_STALE_AFTER_MS - 1,
    );
    await expect(
      failExpiredShopifyEvidenceRun(scope, run.id, liveNow),
    ).resolves.toEqual({ changed: false });
    const expiredNow = new Date(
      initialNow.getTime() + SHOPIFY_EVIDENCE_STALE_AFTER_MS,
    );
    await expect(startRun("trigger-replacement", expiredNow)).resolves.toMatchObject({
      status: "running",
      replayed: false,
    });
    await expect(
      failExpiredShopifyEvidenceRun(scope, run.id, expiredNow),
    ).resolves.toEqual({ changed: false });
    const stored = await testPool!.query(
      `SELECT status, failures, error FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(stored.rows[0]).toEqual({
      status: "failed",
      failures: 1,
      error: "lease_expired",
    });
  });

  it("retry exhaustion preserves committed progress and is scoped and idempotent", async () => {
    const run = await startRun("trigger-retry-finalizer");
    await checkpointShopifyEvidenceRun(scope, run.id, null, FIRST_CURSOR, {
      counts: {
        ...ZERO_COUNTS,
        ordersRead: 1,
        ordersEnriched: 1,
        warnings: 2,
      },
      identityCapability: "available",
      lineCompleteness: "complete",
    });
    await expect(
      failShopifyEvidenceRunAfterRetryExhaustion(otherScope, run.id, "batch"),
    ).rejects.toThrow("outside this scope");
    await expect(
      failShopifyEvidenceRunAfterRetryExhaustion(scope, run.id, "batch"),
    ).resolves.toEqual({ changed: true });
    await expect(
      failShopifyEvidenceRunAfterRetryExhaustion(scope, run.id, "batch"),
    ).resolves.toEqual({ changed: false });
    const stored = await testPool!.query(
      `SELECT cursor, status, orders_read, orders_enriched, warnings,
              failures, identity_capability, line_completeness, error
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "failed",
      orders_read: 1,
      orders_enriched: 1,
      warnings: 2,
      failures: 1,
      identity_capability: "available",
      line_completeness: "complete",
      error: "batch_retries_exhausted",
    });
    expect(stored.rows[0].cursor).toBeTruthy();
  });

  it("rejects invalid run authority before inserting anything", async () => {
    await expect(
      startShopifyEvidenceRun({
        startTriggerRunId: "trigger-invalid-zone",
        scope,
        mode: "incremental_7d",
        storeTimezone: "Not/A_Zone",
        anchorStoreDay: "2026-07-31",
        window: {
          from: new Date("2026-07-25T00:00:00.000Z"),
          to: new Date("2026-08-01T00:00:00.000Z"),
        },
        disposition: { kind: "running", identityCapability: "unknown" },
        now: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("timezone");
    await expect(
      startShopifyEvidenceRun({
        startTriggerRunId: "trigger-invalid-day",
        scope,
        mode: "incremental_7d",
        storeTimezone: "UTC",
        anchorStoreDay: "2026-02-30",
        window: {
          from: new Date("2026-07-25T00:00:00.000Z"),
          to: new Date("2026-08-01T00:00:00.000Z"),
        },
        disposition: { kind: "running", identityCapability: "unknown" },
        now: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("calendar day");
    await expect(
      startShopifyEvidenceRun({
        startTriggerRunId: "trigger-invalid-mode",
        scope,
        mode: "unsupported" as "incremental_7d",
        storeTimezone: "UTC",
        anchorStoreDay: "2026-07-31",
        window: {
          from: new Date("2026-07-25T00:00:00.000Z"),
          to: new Date("2026-08-01T00:00:00.000Z"),
        },
        disposition: { kind: "running", identityCapability: "unknown" },
        now: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Unsupported Shopify evidence mode");
    const stored = await testPool!.query(
      `SELECT count(*) AS runs FROM shopify_evidence_sync_run`,
    );
    expect(stored.rows[0]).toEqual({ runs: "0" });
  });

  it("inserts terminal-unavailable starts once with safe measurable counts", async () => {
    const result = await startShopifyEvidenceRun({
      startTriggerRunId: "trigger-unavailable",
      scope,
      mode: "initial_90d",
      storeTimezone: "UTC",
      anchorStoreDay: "2026-07-31",
      window: {
        from: new Date("2026-05-03T00:00:00.000Z"),
        to: new Date("2026-08-01T00:00:00.000Z"),
      },
      disposition: {
        kind: "terminal_unavailable",
        identityCapability: "unavailable",
        counts: { ...ZERO_COUNTS, ordersUnavailable: 2 },
        errorCode: "required_order_scope_unavailable",
      },
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(result.status).toBe("partial");
    const stored = await testPool!.query(
      `SELECT status, line_completeness, identity_capability,
              orders_unavailable, warnings, error, finished_at
       FROM shopify_evidence_sync_run WHERE id = $1`,
      [result.id],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "partial",
      line_completeness: "unavailable",
      identity_capability: "unavailable",
      orders_unavailable: 2,
      warnings: 1,
      error: "required_order_scope_unavailable",
    });
    expect(stored.rows[0].finished_at).toBeInstanceOf(Date);
  });
});
