import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
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
const TEST_DATABASE = "adsolute_shopify_privacy_test";
const ADVISORY_LOCK: [number, number] = [1_384_994_861, 1_816_654_779];

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
  clearPilotShopifyIdentityForStore,
  eraseShopifySubjectByEmail,
} = await import("@/lib/shopify-privacy");
const { commitShopifyEvidenceOrder, startShopifyEvidenceRun } = await import(
  "@/lib/shopify-evidence-store"
);

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
  if (errors.length > 0) throw new AggregateError(errors, "Privacy DB cleanup failed");
}

const describeIfDb = baseConnectionString ? describe : describe.skip;
const scope = { organizationId: "org_a", storeId: "store_a" };
const otherStoreScope = { organizationId: "org_a", storeId: "store_b" };
const otherOrgScope = { organizationId: "org_b", storeId: "store_c" };
const email = "person@example.com";
const customerId = "gid://shopify/Customer/1";
const keyring: IdentityHmacKeyring = {
  current: { version: "v2", secret: new Uint8Array(32).fill(0x22) },
  previous: { version: "v1", secret: new Uint8Array(32).fill(0x11) },
};
const currentOnlyKeyring: IdentityHmacKeyring = { current: keyring.current };
const suppressionKey: ErasureSuppressionKey = {
  version: "e1",
  secret: new Uint8Array(32).fill(0x33),
};

async function seedCryptoPolicy(
  targetScope: typeof scope,
  targetKeyring: IdentityHmacKeyring = keyring,
  targetSuppressionKey: ErasureSuppressionKey = suppressionKey,
): Promise<void> {
  const checks = computeIdentityCryptoKeyChecks({
    scope: targetScope,
    keyring: targetKeyring,
    suppressionKey: targetSuppressionKey,
  });
  for (const matching of checks.matching) {
    await testPool!.query(
      `INSERT INTO identity_matching_key_binding
         (organization_id, store_id, key_version, key_check)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [targetScope.organizationId, targetScope.storeId, matching.keyVersion, matching.keyCheck],
    );
  }
  await testPool!.query(
    `INSERT INTO identity_crypto_policy (
       id, organization_id, store_id,
       matching_current_version, matching_current_key_check,
       matching_previous_version, matching_previous_key_check,
       suppression_version, suppression_key_check
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      `policy_${targetScope.storeId}`,
      targetScope.organizationId,
      targetScope.storeId,
      checks.matching[0].keyVersion,
      checks.matching[0].keyCheck,
      checks.matching[1]?.keyVersion ?? null,
      checks.matching[1]?.keyCheck ?? null,
      checks.suppression.keyVersion,
      checks.suppression.keyCheck,
    ],
  );
}

async function seedOrderIdentity(params: {
  targetScope: typeof scope;
  orderId: string;
  subjectEmail?: string;
  subjectCustomerId?: string;
  targetKeyring?: IdentityHmacKeyring;
}): Promise<void> {
  const targetKeyring = params.targetKeyring ?? keyring;
  await testPool!.query(
    `UPDATE shopify_order SET shopify_customer_id = $1 WHERE id = $2`,
    [params.subjectCustomerId ?? customerId, params.orderId],
  );
  const digests = computeIdentityDigests({
    scope: params.targetScope,
    email: params.subjectEmail ?? email,
    keyring: targetKeyring,
  });
  for (const digest of digests) {
    await testPool!.query(
      `INSERT INTO source_identity_hmac (
         id, organization_id, store_id, source_kind, shopify_order_id,
         key_version, digest, rotation_state
       ) VALUES ($1, $2, $3, 'shopify_order', $4, $5, $6, $7)`,
      [
        `hmac_${params.orderId}_${digest.keyVersion}`,
        params.targetScope.organizationId,
        params.targetScope.storeId,
        params.orderId,
        digest.keyVersion,
        digest.digest,
        digest.rotationState,
      ],
    );
  }
}

async function resetScopeToCurrentOnly(): Promise<void> {
  await testPool!.query(
    `DELETE FROM source_identity_hmac
     WHERE organization_id = 'org_a' AND store_id = 'store_a'`,
  );
  await testPool!.query(
    `DELETE FROM identity_crypto_policy
     WHERE organization_id = 'org_a' AND store_id = 'store_a'`,
  );
  await seedCryptoPolicy(scope, currentOnlyKeyring);
  await seedOrderIdentity({
    targetScope: scope,
    orderId: "order_a",
    targetKeyring: currentOnlyKeyring,
  });
}

async function readOrderIdentitySnapshot(orderId: string) {
  const result = await testPool!.query(
    `SELECT o.shopify_customer_id, o.updated_at::text,
            h.id, h.key_version, h.digest, h.rotation_state
     FROM shopify_order o
     LEFT JOIN source_identity_hmac h ON h.shopify_order_id = o.id
     WHERE o.id = $1 ORDER BY h.key_version`,
    [orderId],
  );
  return result.rows;
}

async function readCommerceSnapshot(storeId: string) {
  const result = await testPool!.query(
    `SELECT
       (SELECT count(*)::int FROM shopify_order WHERE store_id = $1) AS order_count,
       (SELECT coalesce(sum(net_sales), 0)::text FROM shopify_order WHERE store_id = $1) AS net_sales,
       (SELECT count(*)::int FROM shopify_refund WHERE store_id = $1) AS refund_count,
       (SELECT coalesce(sum(amount), 0)::text FROM shopify_refund WHERE store_id = $1) AS refund_amount,
       (SELECT count(*)::int FROM shopify_order_line WHERE store_id = $1) AS line_count,
       (SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'bucket', bucket, 'bucketRuleVersion', bucket_rule_version,
          'metaVerified', meta_verified, 'metaCampaignId', meta_campaign_id,
          'verificationPending', verification_pending, 'updatedAt', updated_at::text
        ) ORDER BY id) FROM shopify_order WHERE store_id = $1) AS order_state`,
    [storeId],
  );
  return result.rows[0];
}

async function readPrivateState(orderId = "order_a") {
  const result = await testPool!.query(
    `SELECT
       (SELECT shopify_customer_id FROM shopify_order WHERE id = $1) AS customer_id,
       (SELECT count(*)::int FROM source_identity_hmac WHERE shopify_order_id = $1) AS digest_count,
       (SELECT count(*)::int FROM shopify_order_line WHERE order_id = $1) AS line_count,
       (SELECT count(*)::int FROM shopify_evidence_run_identity_observation
         WHERE order_id = $1) AS identity_observation_count`,
    [orderId],
  );
  return result.rows[0];
}

async function readSuppressionCount(storeId = "store_a"): Promise<number> {
  const result = await testPool!.query<{ value: number }>(
    `SELECT count(*)::int AS value FROM identity_erasure_suppression WHERE store_id = $1`,
    [storeId],
  );
  return result.rows[0]?.value ?? 0;
}

async function readSuppressionKinds(storeId = "store_a"): Promise<string[]> {
  const result = await testPool!.query<{ kind: string }>(
    `SELECT kind FROM identity_erasure_suppression
     WHERE store_id = $1 ORDER BY kind`,
    [storeId],
  );
  return result.rows.map((row) => row.kind);
}

async function readRetainedPrivacyControlSnapshot(storeId = "store_a") {
  const result = await testPool!.query(
    `SELECT
       (SELECT count(*)::int FROM identity_erasure_suppression
         WHERE store_id = $1) AS suppressions,
       (SELECT count(*)::int FROM identity_matching_key_binding
         WHERE store_id = $1) AS matching_bindings,
       (SELECT count(*)::int FROM identity_crypto_policy
         WHERE store_id = $1) AS crypto_policies`,
    [storeId],
  );
  return result.rows[0];
}

async function startCommitRun(): Promise<string> {
  const started = await startShopifyEvidenceRun({
    startTriggerRunId: `privacy-${crypto.randomUUID()}`,
    scope,
    mode: "initial_90d",
    storeTimezone: "UTC",
    anchorStoreDay: "2026-07-31",
    window: {
      from: new Date("2026-05-03T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
    },
    disposition: { kind: "running", identityCapability: "unknown" },
    now: new Date("2026-08-01T00:00:00.000Z"),
  });
  return started.id;
}

function availableEvidence() {
  return {
    status: "available" as const,
    shopifyCustomerId: customerId,
    digests: computeIdentityDigests({ scope, email, keyring: currentOnlyKeyring }),
    suppressionCandidates: computeErasureSuppressionDigests({
      scope,
      key: suppressionKey,
      email,
      shopifyCustomerId: customerId,
    }),
    keyChecks: computeIdentityCryptoKeyChecks({
      scope,
      keyring: currentOnlyKeyring,
      suppressionKey,
    }),
    evaluatedKeyVersions: [currentOnlyKeyring.current.version],
  };
}

async function commitHistoricalOrder(runId: string) {
  return commitShopifyEvidenceOrder({
    scope,
    evidenceRunId: runId,
    orderId: "order_a",
    shopifyOrderId: "gid://shopify/Order/1",
    expectedCursor: null,
    nextCursor: {
      orderCreatedAt: new Date("2026-07-30T01:00:00.000Z"),
      id: "order_a",
    },
    lines: {
      completeness: "complete",
      shopifyOrderId: "gid://shopify/Order/1",
      orderUpdatedAt: new Date("2026-07-30T02:00:00.000Z"),
      lines: [
        {
          shopifyLineItemId: "gid://shopify/LineItem/1",
          shopifyProductId: "gid://shopify/Product/1",
          shopifyVariantId: "gid://shopify/ProductVariant/1",
          sku: "SKU-1",
          productTitle: "Product",
          variantTitle: "Default",
          quantity: 1,
          sourcePosition: 0,
        },
      ],
    },
    lineDisposition: "complete",
    identity: availableEvidence(),
    progress: {
      counts: {
        ordersRead: 1,
        ordersEnriched: 1,
        ordersPartial: 0,
        ordersUnavailable: 0,
        warnings: 0,
        failures: 0,
      },
      identityCapability: "available",
      lineCompleteness: "complete",
    },
    now: new Date("2026-08-01T00:01:00.000Z"),
  });
}

async function waitForStoreLockWaiters(
  excludedPid: number,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await testPool!.query<{ value: number }>(
      `SELECT count(*)::int AS value
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> $1
         AND wait_event_type = 'Lock'
         AND query ILIKE '%shopify_store%'`,
      [excludedPid],
    );
    if ((result.rows[0]?.value ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the scoped Shopify store lock");
}

async function runBehindStoreLockInOrder<T, U>(
  first: () => Promise<T>,
  second: () => Promise<U>,
): Promise<[T, U]> {
  const gate = await testPool!.connect();
  let firstPromise: Promise<T> | undefined;
  let secondPromise: Promise<U> | undefined;
  try {
    await gate.query("BEGIN");
    const backend = await gate.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const gatePid = backend.rows[0]?.pid;
    if (gatePid === undefined) throw new Error("Expected privacy lock gate PID");
    await gate.query(
      `SELECT id FROM shopify_store
       WHERE organization_id = 'org_a' AND id = 'store_a'
       FOR UPDATE`,
    );
    firstPromise = first();
    await waitForStoreLockWaiters(gatePid, 1);
    secondPromise = second();
    await waitForStoreLockWaiters(gatePid, 2);
    await gate.query("COMMIT");
    return await Promise.all([firstPromise, secondPromise]);
  } catch (error) {
    await gate.query("ROLLBACK").catch(() => undefined);
    await Promise.allSettled(
      [firstPromise, secondPromise].filter(
        (promise): promise is Promise<T> | Promise<U> => promise !== undefined,
      ),
    );
    throw error;
  } finally {
    gate.release();
  }
}

describeIfDb("Shopify pilot privacy", () => {
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
        throw new AggregateError([setupError, cleanupError], "Privacy DB setup failed");
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
       ('store_b', 'org_a', 'store-b.myshopify.com', 'UTC', 'USD'),
       ('store_c', 'org_b', 'store-c.myshopify.com', 'UTC', 'USD')`,
    );
    await testPool!.query(
      `INSERT INTO shopify_order (
         id, organization_id, store_id, shopify_order_id, order_name,
         order_created_at, order_updated_at, order_day, net_sales,
         customer_journey, journey_ready, last_click_utm_source,
         last_click_utm_medium, last_click_utm_campaign, bucket,
         bucket_rule_version, meta_verified, meta_campaign_id,
         verification_pending, order_source_name, updated_at
       ) VALUES
       ('order_a', 'org_a', 'store_a', 'gid://shopify/Order/1', '#1',
        '2026-07-30 01:00:00', '2026-07-30 02:00:00', '2026-07-30', 123.45,
        '{"utm":"kept"}', true, 'facebook', 'paid', 'campaign', 'meta',
        7, true, '123', false, 'web', '2026-07-30 03:00:00'),
       ('order_control', 'org_a', 'store_a', 'gid://shopify/Order/9', '#9',
        '2026-07-30 05:00:00', '2026-07-30 06:00:00', '2026-07-30', 10.00,
        null, false, null, null, null, 'organic_direct',
        7, false, null, false, 'web', '2026-07-30 07:00:00'),
       ('order_b', 'org_a', 'store_b', 'gid://shopify/Order/2', '#2',
        '2026-07-30 01:00:00', '2026-07-30 02:00:00', '2026-07-30', 50.00,
        null, false, null, null, null, null,
        null, false, null, false, 'web', '2026-07-30 03:00:00'),
       ('order_c', 'org_b', 'store_c', 'gid://shopify/Order/3', '#3',
        '2026-07-30 01:00:00', '2026-07-30 02:00:00', '2026-07-30', 75.00,
        null, false, null, null, null, null,
        null, false, null, false, 'web', '2026-07-30 03:00:00')`,
    );
    await testPool!.query(
      `INSERT INTO shopify_refund (
         id, organization_id, store_id, order_id, shopify_refund_id,
         refund_day, amount, refund_created_at
       ) VALUES
       ('refund_a', 'org_a', 'store_a', 'order_a', 'gid://shopify/Refund/1',
        '2026-07-31', 12.34, '2026-07-31 01:00:00')`,
    );
    await testPool!.query(
      `INSERT INTO shopify_order_line (
         id, organization_id, store_id, order_id, shopify_line_item_id,
         shopify_product_id, shopify_variant_id, sku, product_title,
         variant_title, quantity, source_position, parent_order_updated_at
       ) VALUES
       ('line_a', 'org_a', 'store_a', 'order_a', 'gid://shopify/LineItem/1',
        'gid://shopify/Product/1', 'gid://shopify/ProductVariant/1', 'SKU-1',
        'Product', 'Default', 1, 0, '2026-07-30 02:00:00')`,
    );
    await seedCryptoPolicy(scope);
    await seedCryptoPolicy(otherStoreScope);
    await seedCryptoPolicy(otherOrgScope);
    await seedOrderIdentity({ targetScope: scope, orderId: "order_a" });
    await seedOrderIdentity({
      targetScope: scope,
      orderId: "order_control",
      subjectEmail: "control@example.com",
      subjectCustomerId: "gid://shopify/Customer/9",
    });
    await seedOrderIdentity({ targetScope: otherStoreScope, orderId: "order_b" });
    await seedOrderIdentity({ targetScope: otherOrgScope, orderId: "order_c" });
  });

  it("erases every configured version for one subject and one store", async () => {
    const beforeCommerce = await readCommerceSnapshot("store_a");
    const result = await eraseShopifySubjectByEmail({
      scope,
      email,
      keyring,
      suppressionKey,
    });

    expect(result).toEqual({
      ordersCleared: 1,
      digestsDeleted: 2,
      suppressionsUpserted: 2,
    });
    expect(await readOrderIdentitySnapshot("order_a")).toEqual([
      expect.objectContaining({ shopify_customer_id: null, id: null }),
    ]);
    expect(await readCommerceSnapshot("store_a")).toEqual(beforeCommerce);
    expect(await readOrderIdentitySnapshot("order_control")).toHaveLength(2);

    await expect(
      eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey }),
    ).resolves.toEqual({
      ordersCleared: 0,
      digestsDeleted: 0,
      suppressionsUpserted: 0,
    });
    expect(await readSuppressionKinds()).toEqual([
      "email",
      "shopify_customer_id",
    ]);
  });

  it("does not erase the same email in another store or organization", async () => {
    await eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey });

    expect(await readOrderIdentitySnapshot("order_b")).toHaveLength(2);
    expect(await readOrderIdentitySnapshot("order_c")).toHaveLength(2);
    expect(await readSuppressionCount("store_b")).toBe(0);
    expect(await readSuppressionCount("store_c")).toBe(0);
  });

  it("rejects a mismatched organization/store scope without writes", async () => {
    const before = await readOrderIdentitySnapshot("order_a");
    await expect(
      eraseShopifySubjectByEmail({
        scope: { organizationId: "org_b", storeId: "store_a" },
        email,
        keyring,
        suppressionKey,
      }),
    ).rejects.toThrow("Shopify privacy store is outside this scope");
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
    expect(await readSuppressionCount()).toBe(0);
  });

  it("fails without writes when a stored key version has no configured secret", async () => {
    await testPool!.query(
      `INSERT INTO source_identity_hmac (
         id, organization_id, store_id, source_kind, shopify_order_id,
         key_version, digest, rotation_state
       ) VALUES ('hmac_retired', 'org_a', 'store_a', 'shopify_order',
         'order_a', 'v0', 'retired-secret-digest', 'rotation_previous')`,
    );
    const before = await readOrderIdentitySnapshot("order_a");

    await expect(
      eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey }),
    ).rejects.toThrow("Identity HMAC secret is unavailable for stored key version v0");
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
    expect(await readSuppressionCount()).toBe(0);
  });

  it("inserts an email tombstone even when no current order matches and replays idempotently", async () => {
    const first = await eraseShopifySubjectByEmail({
      scope,
      email: "future@example.com",
      keyring,
      suppressionKey,
    });
    const replay = await eraseShopifySubjectByEmail({
      scope,
      email: "future@example.com",
      keyring,
      suppressionKey,
    });

    expect(first).toEqual({ ordersCleared: 0, digestsDeleted: 0, suppressionsUpserted: 1 });
    expect(replay).toEqual({ ordersCleared: 0, digestsDeleted: 0, suppressionsUpserted: 0 });
    expect(await readSuppressionCount()).toBe(1);
  });

  it("rejects a missing policy or stable suppression-key drift before lookup or writes", async () => {
    const before = await readOrderIdentitySnapshot("order_a");
    const wrongSuppressionKey = {
      version: suppressionKey.version,
      secret: new Uint8Array(32).fill(0x44),
    };

    await expect(
      eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey: wrongSuppressionKey }),
    ).rejects.toThrow("identity_crypto_policy_conflict");
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
    expect(await readSuppressionCount()).toBe(0);

    await expect(
      eraseShopifySubjectByEmail({
        scope,
        email,
        keyring,
        suppressionKey: undefined as unknown as ErasureSuppressionKey,
      }),
    ).rejects.toThrow();
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
    expect(await readSuppressionCount()).toBe(0);

    await testPool!.query(
      `DELETE FROM identity_crypto_policy WHERE organization_id = 'org_a' AND store_id = 'store_a'`,
    );
    await expect(
      eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey }),
    ).rejects.toThrow("identity_crypto_policy_conflict");
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
    expect(await readSuppressionCount()).toBe(0);
  });

  it.each(["current", "previous"] as const)(
    "rejects suppression-root reuse against the %s matcher with zero writes",
    async (which) => {
      const reusedSuppressionKey = {
        version: suppressionKey.version,
        secret: Uint8Array.from(keyring[which]!.secret),
      };
      const before = await readOrderIdentitySnapshot("order_a");

      await expect(
        eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey: reusedSuppressionKey }),
      ).rejects.toThrow("Identity HMAC root key material must be independent");
      expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
      expect(await readSuppressionCount()).toBe(0);
    },
  );

  it.each([
    {
      name: "current matching secret",
      expected: "Invalid identity HMAC key",
      malformedKeyring: {
        current: {
          version: keyring.current.version,
          secret: "x".repeat(32) as unknown as Uint8Array,
        },
        previous: keyring.previous,
      } as IdentityHmacKeyring,
      malformedSuppressionKey: suppressionKey,
    },
    {
      name: "previous matching secret",
      expected: "Invalid identity HMAC key",
      malformedKeyring: {
        current: keyring.current,
        previous: {
          version: keyring.previous!.version,
          secret: "y".repeat(32) as unknown as Uint8Array,
        },
      } as IdentityHmacKeyring,
      malformedSuppressionKey: suppressionKey,
    },
    {
      name: "suppression secret",
      expected: "Invalid erasure suppression HMAC key",
      malformedKeyring: keyring,
      malformedSuppressionKey: {
        version: suppressionKey.version,
        secret: "z".repeat(32) as unknown as Uint8Array,
      } as ErasureSuppressionKey,
    },
  ])(
    "rejects a wrong-type $name before trying the missing database scope",
    async ({ expected, malformedKeyring, malformedSuppressionKey }) => {
      const before = await readOrderIdentitySnapshot("order_a");
      await expect(
        eraseShopifySubjectByEmail({
          scope: { organizationId: "missing_org", storeId: "missing_store" },
          email,
          keyring: malformedKeyring,
          suppressionKey: malformedSuppressionKey,
        }),
      ).rejects.toThrow(expected);
      expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
      expect(await readSuppressionCount()).toBe(0);
    },
  );

  it("redacts derived HMACs and query details from unexpected erasure database failures", async () => {
    const identityDigests = computeIdentityDigests({ scope, email, keyring });
    const suppressionDigests = computeErasureSuppressionDigests({
      scope,
      key: suppressionKey,
      email,
      shopifyCustomerId: customerId,
    });
    const before = await readOrderIdentitySnapshot("order_a");
    await testPool!.query(
      `CREATE FUNCTION fail_shopify_privacy_suppression_insert()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'forced raw digest failure: %', NEW.digest;
       END;
       $$ LANGUAGE plpgsql`,
    );
    await testPool!.query(
      `CREATE TRIGGER fail_shopify_privacy_suppression_insert
       BEFORE INSERT ON identity_erasure_suppression
       FOR EACH ROW EXECUTE FUNCTION fail_shopify_privacy_suppression_insert()`,
    );

    let thrown: unknown;
    try {
      await eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey });
    } catch (error) {
      thrown = error;
    } finally {
      await testPool!.query(
        "DROP TRIGGER fail_shopify_privacy_suppression_insert ON identity_erasure_suppression",
      );
      await testPool!.query(
        "DROP FUNCTION fail_shopify_privacy_suppression_insert()",
      );
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe("shopify_subject_erasure_failed");
    for (const forbidden of [
      email,
      customerId,
      ...identityDigests.map((digest) => digest.digest),
      ...suppressionDigests.map((digest) => digest.digest),
      "identity_erasure_suppression",
      "insert into",
      "forced raw digest failure",
    ]) {
      expect(message).not.toContain(forbidden);
    }
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
    expect(await readSuppressionCount()).toBe(0);
  });

  it("snapshots mutable scope, key versions, and secret bytes before awaiting the store lock", async () => {
    const mutableScope = { ...scope };
    const mutableKeyring: IdentityHmacKeyring = {
      current: {
        version: keyring.current.version,
        secret: Uint8Array.from(keyring.current.secret),
      },
      previous: {
        version: keyring.previous!.version,
        secret: Uint8Array.from(keyring.previous!.secret),
      },
    };
    const mutableSuppressionKey: ErasureSuppressionKey = {
      version: suppressionKey.version,
      secret: Uint8Array.from(suppressionKey.secret),
    };

    const erasure = eraseShopifySubjectByEmail({
      scope: mutableScope,
      email,
      keyring: mutableKeyring,
      suppressionKey: mutableSuppressionKey,
    });
    mutableScope.organizationId = "org_b";
    mutableScope.storeId = "store_c";
    mutableKeyring.current.version = "changed-current";
    mutableKeyring.current.secret.fill(0x66);
    mutableKeyring.previous!.version = "changed-previous";
    mutableKeyring.previous!.secret.fill(0x77);
    mutableSuppressionKey.version = "changed-suppression";
    mutableSuppressionKey.secret.fill(0x88);

    await expect(erasure).resolves.toEqual({
      ordersCleared: 1,
      digestsDeleted: 2,
      suppressionsUpserted: 2,
    });
    expect(await readPrivateState()).toMatchObject({
      customer_id: null,
      digest_count: 0,
    });
    expect(await readOrderIdentitySnapshot("order_c")).toHaveLength(2);
  });

  it("clears only pilot identity for uninstall and retains commerce, timestamps, and tombstones", async () => {
    await eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey });
    const before = await readCommerceSnapshot("store_a");
    const controlsBefore = await readRetainedPrivacyControlSnapshot();

    await expect(clearPilotShopifyIdentityForStore(scope)).resolves.toEqual({
      ordersCleared: 1,
      digestsDeleted: 2,
    });

    expect(await readCommerceSnapshot("store_a")).toEqual(before);
    expect(await readPrivateState("order_control")).toMatchObject({
      customer_id: null,
      digest_count: 0,
      line_count: 0,
    });
    expect(await readRetainedPrivacyControlSnapshot()).toEqual(controlsBefore);
    expect(await readOrderIdentitySnapshot("order_b")).toHaveLength(2);
  });

  it("supports cleanup with a caller-owned transaction and lock", async () => {
    await eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey });
    const controlsBefore = await readRetainedPrivacyControlSnapshot();
    const cleanupWithLock = () =>
      testDb!.transaction(async (tx) => {
        await tx.execute(
          // The executor overload requires this exact lock to be held by its caller.
          // Values are fixture constants, never subject or secret material.
          (await import("drizzle-orm")).sql`
            select id from shopify_store
            where organization_id = 'org_a' and id = 'store_a'
            for update
          `,
        );
        return clearPilotShopifyIdentityForStore(scope, tx);
      });

    await expect(cleanupWithLock()).resolves.toEqual({
      ordersCleared: 1,
      digestsDeleted: 2,
    });
    await expect(cleanupWithLock()).resolves.toEqual({
      ordersCleared: 0,
      digestsDeleted: 0,
    });
    expect(await readRetainedPrivacyControlSnapshot()).toEqual(controlsBefore);
  });

  it("snapshots mutable uninstall scope before awaiting cleanup", async () => {
    const mutableScope = { ...scope };
    const cleanup = clearPilotShopifyIdentityForStore(mutableScope);
    mutableScope.organizationId = otherStoreScope.organizationId;
    mutableScope.storeId = otherStoreScope.storeId;

    await expect(cleanup).resolves.toEqual({
      ordersCleared: 2,
      digestsDeleted: 4,
    });
    expect(await readPrivateState("order_control")).toMatchObject({
      customer_id: null,
      digest_count: 0,
    });
    expect(await readOrderIdentitySnapshot("order_b")).toHaveLength(2);
  });

  it("keeps a historical replay suppressed by either email or customer alias", async () => {
    await resetScopeToCurrentOnly();
    await eraseShopifySubjectByEmail({
      scope,
      email,
      keyring: currentOnlyKeyring,
      suppressionKey,
    });
    const runId = await startCommitRun();

    const committed = await commitHistoricalOrder(runId);

    expect(committed).toMatchObject({ identityDisposition: "suppressed", identityHmacId: null });
    expect(await readPrivateState()).toEqual({
      customer_id: null,
      digest_count: 0,
      line_count: 1,
      identity_observation_count: 0,
    });
    const observation = await testPool!.query<{ identity_disposition: string }>(
      `SELECT identity_disposition FROM shopify_evidence_run_observation
       WHERE evidence_run_id = $1 AND order_id = 'order_a'`,
      [runId],
    );
    expect(observation.rows[0]?.identity_disposition).toBe("suppressed");
  });

  it.each(["erasure-first", "commit-first"] as const)(
    "converges to the same private state for the %s lock schedule",
    async (schedule) => {
      await resetScopeToCurrentOnly();
      const runId = await startCommitRun();
      const erase = () =>
        eraseShopifySubjectByEmail({
          scope,
          email,
          keyring: currentOnlyKeyring,
          suppressionKey,
        });
      const commit = () => commitHistoricalOrder(runId);
      if (schedule === "erasure-first") {
        await runBehindStoreLockInOrder(erase, commit);
      } else {
        await runBehindStoreLockInOrder(commit, erase);
      }

      expect(await readPrivateState()).toEqual({
        customer_id: null,
        digest_count: 0,
        line_count: 1,
        identity_observation_count: 0,
      });
      expect(await readSuppressionCount()).toBe(2);
      const runState = await testPool!.query<{
        identity_disposition: string;
        orders_read: number;
        orders_enriched: number;
        cursor_advanced: boolean;
      }>(
        `SELECT o.identity_disposition, r.orders_read, r.orders_enriched,
                r.cursor IS NOT NULL AS cursor_advanced
         FROM shopify_evidence_run_observation o
         JOIN shopify_evidence_sync_run r
           ON r.organization_id = o.organization_id
          AND r.store_id = o.store_id
          AND r.id = o.evidence_run_id
         WHERE o.evidence_run_id = $1 AND o.order_id = 'order_a'`,
        [runId],
      );
      expect(runState.rows[0]).toEqual({
        identity_disposition:
          schedule === "erasure-first" ? "suppressed" : "available",
        orders_read: 1,
        orders_enriched: 1,
        cursor_advanced: true,
      });
    },
  );

  it("cascades Shopify truth, evidence, and tombstones with organization deletion", async () => {
    await eraseShopifySubjectByEmail({
      scope,
      email: "future@example.com",
      keyring,
      suppressionKey,
    });
    await resetScopeToCurrentOnly();
    const runId = await startCommitRun();
    await commitHistoricalOrder(runId);

    const before = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM shopify_store WHERE organization_id = 'org_a') AS stores,
         (SELECT count(*)::int FROM shopify_order WHERE organization_id = 'org_a') AS orders,
         (SELECT count(*)::int FROM shopify_refund WHERE organization_id = 'org_a') AS refunds,
         (SELECT count(*)::int FROM shopify_order_line WHERE organization_id = 'org_a') AS lines,
         (SELECT count(*)::int FROM source_identity_hmac WHERE organization_id = 'org_a') AS hmacs,
         (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE organization_id = 'org_a') AS runs,
         (SELECT count(*)::int FROM shopify_evidence_run_identity_observation
           WHERE organization_id = 'org_a') AS identity_observations,
         (SELECT count(*)::int FROM identity_erasure_suppression
           WHERE organization_id = 'org_a') AS suppressions`,
    );
    expect(before.rows[0]).toMatchObject({
      stores: 2,
      orders: 3,
      refunds: 1,
      lines: 1,
      hmacs: 3,
      runs: 1,
      identity_observations: 1,
      suppressions: 1,
    });

    await testPool!.query(`DELETE FROM organization WHERE id = 'org_a'`);

    const result = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM shopify_store WHERE organization_id = 'org_a') AS stores,
         (SELECT count(*)::int FROM shopify_order WHERE organization_id = 'org_a') AS orders,
         (SELECT count(*)::int FROM shopify_refund WHERE organization_id = 'org_a') AS refunds,
         (SELECT count(*)::int FROM shopify_order_line WHERE organization_id = 'org_a') AS lines,
         (SELECT count(*)::int FROM source_identity_hmac WHERE organization_id = 'org_a') AS hmacs,
         (SELECT count(*)::int FROM shopify_evidence_sync_run WHERE organization_id = 'org_a') AS runs,
         (SELECT count(*)::int FROM shopify_evidence_run_identity_observation
           WHERE organization_id = 'org_a') AS identity_observations,
         (SELECT count(*)::int FROM identity_erasure_suppression WHERE organization_id = 'org_a') AS suppressions,
         (SELECT count(*)::int FROM shopify_store WHERE organization_id = 'org_b') AS other_stores`,
    );
    expect(result.rows[0]).toEqual({
      stores: 0,
      orders: 0,
      refunds: 0,
      lines: 0,
      hmacs: 0,
      runs: 0,
      identity_observations: 0,
      suppressions: 0,
      other_stores: 1,
    });
  });
});
