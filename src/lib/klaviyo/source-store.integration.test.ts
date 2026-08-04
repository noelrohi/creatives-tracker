import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { orderCoreSourceContract, type NormalizedKlaviyoEvent } from "@/lib/klaviyo/types";
import { klaviyoSyncRuns } from "@/schema/klaviyo";

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

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function migrationStatements(fileName: string): string[] {
  return readFileSync(path.resolve(process.cwd(), "drizzle", fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

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

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_source_test";
const testPool = baseConnectionString
  ? new Pool({ connectionString: withDatabase(baseConnectionString, TEST_DATABASE), max: 12 })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const store = await import("@/lib/klaviyo/source-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = {
  organizationId: "org-a",
  storeId: "store-a",
  connectionId: "connection-a",
};
const otherScope = {
  organizationId: "org-b",
  storeId: "store-b",
  connectionId: "connection-b",
};
const contract = orderCoreSourceContract();
const checkpoint0 = { ...contract, metricIndex: 0, cursor: null, page: 0 };

function eventFixture(
  overrides: Partial<NormalizedKlaviyoEvent> = {},
): NormalizedKlaviyoEvent {
  return {
    externalEventId: "event-external-a",
    eventUuid: "uuid-a",
    metricId: "metric-row-placed",
    metricKind: "placed_order",
    occurredAt: new Date("2026-07-20T10:00:00.000Z"),
    profileId: "profile-a",
    explicitOrderIdCandidate: "gid://shopify/Order/1001",
    providerUniqueIdCandidate: "provider-unique-a",
    providerValue: "42.00",
    providerCurrency: "USD",
    attributionRelationshipIds: ["campaign-a"],
    evidence: {
      values: { OrderId: "gid://shopify/Order/1001" },
      fingerprint: [{ key: "OrderId", keyKind: "approved", type: "string" }],
      warnings: [],
      truncated: false,
    },
    products: [
      {
        sourceOrdinal: 0,
        productId: "product-a",
        variantId: "variant-a",
        sku: "SKU-A",
        productName: "Product A",
        variantName: "Variant A",
        quantity: 1,
      },
    ],
    productEvidenceCompleteness: "complete",
    sourceChecksum: "checksum-a",
    apiRevision: "2026-07-15",
    ...overrides,
  };
}

function discoveryMetrics(overrides: {
  placedId?: string;
  productId?: string;
} = {}) {
  return [
    {
      externalMetricId: overrides.placedId ?? "metric-external-placed",
      name: "Placed Order",
      integrationName: "Shopify",
      integrationCategory: "ecommerce",
      canonicalKind: "placed_order" as const,
      ingestionEnabled: true,
      apiRevision: "2026-07-15",
    },
    {
      externalMetricId: overrides.productId ?? "metric-external-product",
      name: "Ordered Product",
      integrationName: "Shopify",
      integrationCategory: "ecommerce",
      canonicalKind: "ordered_product" as const,
      ingestionEnabled: true,
      apiRevision: "2026-07-15",
    },
  ];
}

async function seedBase(): Promise<void> {
  await testPool!.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES
       ('org-a', 'Org A', 'org-a', now()), ('org-b', 'Org B', 'org-b', now())`,
  );
  await testPool!.query(
    `INSERT INTO shopify_store
       (id, organization_id, shop_domain, iana_timezone, currency) VALUES
       ('store-a', 'org-a', 'a.example.com', 'America/New_York', 'USD'),
       ('store-b', 'org-b', 'b.example.com', 'UTC', 'USD')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_connection
       (id, organization_id, shopify_store_id, klaviyo_account_id) VALUES
       ('connection-a', 'org-a', 'store-a', 'account-a'),
       ('connection-b', 'org-b', 'store-b', 'account-b')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_metric
       (id, organization_id, shopify_store_id, connection_id,
        external_metric_id, name, canonical_kind, ingestion_enabled, api_revision) VALUES
       ('metric-row-placed', 'org-a', 'store-a', 'connection-a',
        'metric-external-placed', 'Placed Order', 'placed_order', 1, '2026-07-15'),
       ('metric-row-product', 'org-a', 'store-a', 'connection-a',
        'metric-external-product', 'Ordered Product', 'ordered_product', 1, '2026-07-15'),
       ('metric-row-other', 'org-b', 'store-b', 'connection-b',
        'metric-external-other', 'Placed Order', 'placed_order', 1, '2026-07-15'),
       ('metric-row-other-product', 'org-b', 'store-b', 'connection-b',
        'metric-external-other-product', 'Ordered Product', 'ordered_product', 1, '2026-07-15')`,
  );
}

async function seedRun(input: {
  id: string;
  targetScope?: typeof scope;
  operation?: string;
  status?: string;
  checkpoint?: unknown;
  requestParameters?: unknown;
  heartbeatAt?: Date;
  lastEventSyncedAt?: Date;
}): Promise<void> {
  const target = input.targetScope ?? scope;
  if (input.lastEventSyncedAt) {
    await testPool!.query(
      `UPDATE klaviyo_connection SET last_event_synced_at = $1 WHERE id = $2`,
      [input.lastEventSyncedAt, target.connectionId],
    );
  }
  await testPool!.query(
    `INSERT INTO klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status, checkpoint, request_parameters, heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9)`,
    [
      input.id,
      target.organizationId,
      target.storeId,
      target.connectionId,
      input.operation ?? "events",
      input.status ?? "running",
      input.checkpoint === undefined ? checkpoint0 : input.checkpoint,
      input.requestParameters === undefined ? contract : input.requestParameters,
      input.heartbeatAt ?? new Date(),
    ],
  );
}

async function setHeartbeatForTest(id: string, heartbeatAt: Date): Promise<void> {
  await testDb!
    .update(klaviyoSyncRuns)
    .set({ heartbeatAt })
    .where(eq(klaviyoSyncRuns.id, id));
}

async function expectNoPageMutation(runId: string): Promise<void> {
  for (const table of [
    "klaviyo_event",
    "klaviyo_event_product",
    "klaviyo_event_run_observation",
  ]) {
    const count = await testPool!.query(`SELECT count(*)::int AS count FROM ${table}`);
    expect(count.rows[0].count).toBe(0);
  }
  const run = await testPool!.query(
    `SELECT checkpoint, rows_read, rows_inserted, rows_updated
       FROM klaviyo_sync_run WHERE id = $1`,
    [runId],
  );
  expect(run.rows[0]).toEqual({
    checkpoint: checkpoint0,
    rows_read: 0,
    rows_inserted: 0,
    rows_updated: 0,
  });
}

async function seedProbeParents(targetScope = scope): Promise<void> {
  await seedRun({
    id: `probe-run-${targetScope.connectionId}`,
    targetScope,
    operation: "probe",
    checkpoint: null,
    requestParameters: { sampleSize: 20 },
  });
  await testPool!.query(
    `INSERT INTO klaviyo_probe_report
       (id, organization_id, shopify_store_id, connection_id, sync_run_id,
        sampled_from, sampled_to, sampled_shopify_orders, sampled_klaviyo_events,
        binding_overlap_count, key_type_shapes, identifier_coverage,
        collision_summary, unmatched_summary, unmatched_examples,
        product_coverage, attribution_coverage, redaction_verified, status, checksum)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now(),
       20, 20, 1, '[]', '{}', '{}', '{}', '[]', '{}', '{}', 1, 'pending', $6)`,
    [
      `probe-${targetScope.connectionId}`,
      targetScope.organizationId,
      targetScope.storeId,
      targetScope.connectionId,
      `probe-run-${targetScope.connectionId}`,
      `checksum-${targetScope.connectionId}`,
    ],
  );
}

describeIfDb("Klaviyo source store on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    for (const statement of PRE_0053_FIXTURE_DDL) await testPool!.query(statement);
    for (const migration of [
      "0053_klaviyo_shopify_evidence.sql",
      "0054_klaviyo_source_core.sql",
    ]) {
      for (const statement of migrationStatements(migration)) {
        await testPool!.query(statement);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE klaviyo_connection, shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedBase();
  });

  it("enforces connection scope, active-account uniqueness, and cascades source", async () => {
    await expect(
      testPool!.query(
        `INSERT INTO klaviyo_connection
           (id, organization_id, shopify_store_id, klaviyo_account_id)
         VALUES ('bad', 'org-b', 'store-a', 'account-bad')`,
      ),
    ).rejects.toThrow();
    await expect(
      testPool!.query(
        `UPDATE klaviyo_connection SET klaviyo_account_id = 'account-a'
          WHERE id = 'connection-b'`,
      ),
    ).rejects.toThrow();

    await seedRun({ id: "run-cascade" });
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-cascade",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture()],
      rowsRead: 1,
    });
    await testPool!.query(`DELETE FROM klaviyo_connection WHERE id = 'connection-a'`);
    for (const table of [
      "klaviyo_event",
      "klaviyo_event_product",
      "klaviyo_event_run_observation",
      "klaviyo_sync_run",
    ]) {
      const result = await testPool!.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE connection_id = 'connection-a'`,
      );
      expect(result.rows[0].count).toBe(0);
    }
  });

  it("rejects cross-connection report/rule parents and a second running event", async () => {
    await seedProbeParents(scope);
    await seedProbeParents(otherScope);
    await expect(
      testPool!.query(
        `INSERT INTO klaviyo_probe_report
           (id, organization_id, shopify_store_id, connection_id, sync_run_id,
            sampled_from, sampled_to, sampled_shopify_orders, sampled_klaviyo_events,
            binding_overlap_count, key_type_shapes, identifier_coverage,
            collision_summary, unmatched_summary, unmatched_examples,
            product_coverage, attribution_coverage, redaction_verified, status, checksum)
         VALUES ('probe-cross', 'org-a', 'store-a', 'connection-a',
          'probe-run-connection-b', now() - interval '1 day', now(), 20, 20,
          1, '[]', '{}', '{}', '{}', '[]', '{}', '{}', 1, 'pending', 'cross')`,
      ),
    ).rejects.toThrow();
    await expect(
      testPool!.query(
        `INSERT INTO klaviyo_join_rule
           (id, organization_id, shopify_store_id, connection_id, probe_report_id,
            event_kind, source_property, target_namespace, canonicalizer, state,
            observed_populated, observed_collisions)
         VALUES ('rule-cross', 'org-a', 'store-a', 'connection-a',
          'probe-connection-b', 'placed_order', 'OrderId', 'shopify_order_gid',
          'shopify_order_gid', 'candidate', 20, 0)`,
      ),
    ).rejects.toThrow();

    await seedRun({ id: "run-only" });
    await expect(seedRun({ id: "run-second" })).rejects.toThrow();
  });

  it("bootstraps only the configured organization store, idempotently and account-free", async () => {
    await testPool!.query(`DELETE FROM klaviyo_connection`);
    const calls: string[] = [];
    const dependencies = {
      database: testDb!,
      loadIdentityKeyring: () => {
        calls.push("hmac");
        return { current: { version: "v1", secret: new Uint8Array(32) } };
      },
      credentialProvider: {
        getPilotBinding: async () => {
          calls.push("private-key");
          return {
            expectedAccountId: "account-configured",
            shopDomain: "a.example.com",
            allowedUrlHosts: ["a.example.com"],
          };
        },
        resolve: vi.fn(),
      },
    };
    const first = await store.ensurePilotConnection("org-a", dependencies);
    const second = await store.ensurePilotConnection("org-a", dependencies);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      organizationId: "org-a",
      storeId: "store-a",
      klaviyoAccountId: null,
      status: "pending",
    });
    expect(dependencies.credentialProvider.resolve).not.toHaveBeenCalled();
    expect(calls).toEqual(["hmac", "private-key", "hmac", "private-key"]);
    await expect(store.ensurePilotConnection("org-b", dependencies)).rejects.toThrow(
      "not found in this organization",
    );
    expect(
      (await testPool!.query(`SELECT count(*)::int AS count FROM klaviyo_connection`))
        .rows[0].count,
    ).toBe(1);
  });

  it("fails HMAC/private-key validation before bootstrap writes", async () => {
    await testPool!.query(`DELETE FROM klaviyo_connection`);
    const database = { transaction: vi.fn() } as unknown as typeof testDb;
    await expect(
      store.ensurePilotConnection("org-a", {
        database: database!,
        loadIdentityKeyring: () => {
          throw new Error("missing hmac");
        },
        credentialProvider: {
          getPilotBinding: vi.fn(),
          resolve: vi.fn(),
        },
      }),
    ).rejects.toThrow("missing hmac");
    expect(database!.transaction).not.toHaveBeenCalled();

    await expect(
      store.ensurePilotConnection("org-a", {
        database: database!,
        loadIdentityKeyring: () => ({
          current: { version: "v1", secret: new Uint8Array(32) },
        }),
        credentialProvider: {
          getPilotBinding: async () => {
            throw new Error("missing private key");
          },
          resolve: vi.fn(),
        },
      }),
    ).rejects.toThrow("missing private key");
    expect(database!.transaction).not.toHaveBeenCalled();
  });

  it("loads internal/provider metric IDs and only approved aliases in canonical order", async () => {
    await seedProbeParents(scope);
    await testPool!.query(
      `INSERT INTO klaviyo_event_alias
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          probe_report_id, canonical_field, source_property, state, observed_populated)
       VALUES
         ('alias-approved-product', 'org-a', 'store-a', 'connection-a',
          'metric-row-product', 'probe-connection-a', 'productId', 'ProductID',
          'approved', 20),
         ('alias-approved-order', 'org-a', 'store-a', 'connection-a',
          'metric-row-placed', 'probe-connection-a', 'orderId', 'OrderId',
          'approved', 20),
         ('alias-candidate', 'org-a', 'store-a', 'connection-a',
          'metric-row-placed', 'probe-connection-a', 'sku', 'CandidateSKU',
          'candidate', 20)`,
    );
    const metrics = await store.loadEnabledOrderCoreMetrics(scope);
    expect(metrics.map((metric) => [
      metric.metricRowId,
      metric.externalMetricId,
      metric.metricKind,
    ])).toEqual([
      ["metric-row-placed", "metric-external-placed", "placed_order"],
      ["metric-row-product", "metric-external-product", "ordered_product"],
    ]);
    expect(metrics[0].approvedAliases.orderId).toBe("OrderId");
    expect(metrics[0].approvedAliases.sku).toBeNull();
    expect(metrics[1].approvedAliases.productId).toBe("ProductID");
  });

  it("preserves alias history while the approved-only index prevents overlap", async () => {
    await seedProbeParents(scope);
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status)
       VALUES ('probe-run-new', 'org-a', 'store-a', 'connection-a',
         'probe', 'manual', 'success')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_probe_report
         (id, organization_id, shopify_store_id, connection_id, sync_run_id,
          sampled_from, sampled_to, sampled_shopify_orders, sampled_klaviyo_events,
          binding_overlap_count, key_type_shapes, identifier_coverage,
          collision_summary, unmatched_summary, unmatched_examples,
          product_coverage, attribution_coverage, redaction_verified, status, checksum)
       VALUES ('probe-new', 'org-a', 'store-a', 'connection-a', 'probe-run-new',
         now() - interval '1 day', now(), 20, 20, 1, '[]', '{}', '{}', '{}',
         '[]', '{}', '{}', 1, 'pending', 'checksum-new')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_alias
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          probe_report_id, canonical_field, source_property, state, observed_populated)
       VALUES
         ('alias-old', 'org-a', 'store-a', 'connection-a', 'metric-row-placed',
          'probe-connection-a', 'orderId', 'OrderId', 'approved', 20),
         ('alias-new', 'org-a', 'store-a', 'connection-a', 'metric-row-placed',
          'probe-new', 'orderId', 'NewOrderId', 'candidate', 20)`,
    );
    await expect(
      testPool!.query(`UPDATE klaviyo_event_alias SET state = 'approved' WHERE id = 'alias-new'`),
    ).rejects.toThrow();
    await testPool!.query(`UPDATE klaviyo_event_alias SET state = 'disabled' WHERE id = 'alias-old'`);
    await testPool!.query(`UPDATE klaviyo_event_alias SET state = 'approved' WHERE id = 'alias-new'`);
    const history = await testPool!.query(
      `SELECT id, state FROM klaviyo_event_alias ORDER BY id`,
    );
    expect(history.rows).toEqual([
      { id: "alias-new", state: "approved" },
      { id: "alias-old", state: "disabled" },
    ]);
  });

  it("rejects a cross-connection alias metric/report tuple", async () => {
    await seedProbeParents(scope);
    await seedProbeParents(otherScope);
    await expect(
      testPool!.query(
        `INSERT INTO klaviyo_event_alias
           (id, organization_id, shopify_store_id, connection_id, metric_id,
            probe_report_id, canonical_field, source_property, state, observed_populated)
         VALUES ('alias-cross', 'org-a', 'store-a', 'connection-a',
          'metric-row-other', 'probe-connection-a', 'orderId', 'OrderId',
          'approved', 20)`,
      ),
    ).rejects.toThrow();
    await expect(
      testPool!.query(
        `INSERT INTO klaviyo_event_alias
           (id, organization_id, shopify_store_id, connection_id, metric_id,
            probe_report_id, canonical_field, source_property, state, observed_populated)
         VALUES ('alias-cross-report', 'org-a', 'store-a', 'connection-a',
          'metric-row-placed', 'probe-connection-b', 'orderId', 'OrderId',
          'approved', 20)`,
      ),
    ).rejects.toThrow();
  });

  it("commits a page atomically with exact-run observation and preserves complete children", async () => {
    await seedRun({ id: "run-event" });
    const next = { ...contract, metricIndex: 0, cursor: "opaque-next", page: 1 };
    await expect(
      store.commitKlaviyoEventPage({
        scope,
        syncRunId: "run-event",
        sourceContract: contract,
        expectedCheckpoint: checkpoint0,
        nextCheckpoint: next,
        events: [eventFixture()],
        rowsRead: 1,
      }),
    ).resolves.toEqual({ committed: true, inserted: 1, updated: 0 });

    const observation = await testPool!.query(
      `SELECT observed_source_checksum FROM klaviyo_event_run_observation
        WHERE sync_run_id = 'run-event'`,
    );
    expect(observation.rows).toEqual([{ observed_source_checksum: "checksum-a" }]);

    const replay = await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-event",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: next,
      events: [eventFixture()],
      rowsRead: 1,
    });
    expect(replay).toEqual({ committed: false, inserted: 0, updated: 0 });

    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-event",
      sourceContract: contract,
      expectedCheckpoint: next,
      nextCheckpoint: { ...next, cursor: null, page: 2 },
      events: [
        eventFixture({
          productEvidenceCompleteness: "incomplete",
          products: [],
          sourceChecksum: "checksum-a",
        }),
      ],
      rowsRead: 1,
    });
    const persisted = await testPool!.query(
      `SELECT e.product_evidence_completeness,
              (SELECT array_agg(p.product_id ORDER BY p.source_ordinal)
                 FROM klaviyo_event_product p WHERE p.event_id = e.id) AS product_ids
         FROM klaviyo_event e WHERE e.external_event_id = 'event-external-a'`,
    );
    expect(persisted.rows[0]).toEqual({
      product_evidence_completeness: "incomplete",
      product_ids: ["product-a"],
    });
  });

  it("initializes run heartbeat and renews it in the page checkpoint transaction", async () => {
    const started = await store.startKlaviyoSyncRun({
      scope,
      operation: "events",
      triggerType: "manual",
      checkpoint: checkpoint0,
      requestParameters: contract,
    });
    const initial = await testPool!.query(
      `SELECT heartbeat_at, started_at FROM klaviyo_sync_run WHERE id = $1`,
      [started.id],
    );
    expect(initial.rows[0].heartbeat_at).toBeInstanceOf(Date);
    expect(initial.rows[0].heartbeat_at.getTime()).toBe(
      initial.rows[0].started_at.getTime(),
    );

    const oldHeartbeat = new Date("2026-07-01T00:00:00.000Z");
    await setHeartbeatForTest(started.id, oldHeartbeat);
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: started.id,
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture()],
      rowsRead: 1,
    });
    const committed = await testPool!.query(
      `SELECT heartbeat_at, checkpoint, rows_read
         FROM klaviyo_sync_run WHERE id = $1`,
      [started.id],
    );
    expect(committed.rows[0].heartbeat_at.getTime()).toBeGreaterThan(
      oldHeartbeat.getTime(),
    );
    expect(committed.rows[0]).toMatchObject({ checkpoint: null, rows_read: 1 });

    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId: started.id,
      operation: "events",
      status: "success",
    });
    const futureRun = await store.startKlaviyoSyncRun({
      scope,
      operation: "events",
      triggerType: "manual",
      checkpoint: checkpoint0,
      requestParameters: contract,
    });
    const futureHeartbeat = new Date(Date.now() + 60 * 60 * 1000);
    await setHeartbeatForTest(futureRun.id, futureHeartbeat);
    const futureBeforeCommit = await testDb!
      .select({ heartbeatAt: klaviyoSyncRuns.heartbeatAt })
      .from(klaviyoSyncRuns)
      .where(eq(klaviyoSyncRuns.id, futureRun.id));
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: futureRun.id,
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture({ externalEventId: "event-future-heartbeat" })],
      rowsRead: 1,
    });
    const futureCommitted = await testDb!
      .select({ heartbeatAt: klaviyoSyncRuns.heartbeatAt })
      .from(klaviyoSyncRuns)
      .where(eq(klaviyoSyncRuns.id, futureRun.id));
    expect(futureCommitted[0].heartbeatAt.getTime()).toBe(
      futureBeforeCommit[0].heartbeatAt.getTime(),
    );
  });

  it("rolls back event, product, observation, counts and checkpoint together", async () => {
    await seedRun({ id: "run-rollback" });
    await expect(
      store.commitKlaviyoEventPage({
        scope,
        syncRunId: "run-rollback",
        sourceContract: contract,
        expectedCheckpoint: checkpoint0,
        nextCheckpoint: null,
        events: [eventFixture({ metricId: "missing-metric" })],
        rowsRead: 1,
      }),
    ).rejects.toThrow();
    for (const table of [
      "klaviyo_event",
      "klaviyo_event_product",
      "klaviyo_event_run_observation",
    ]) {
      const count = await testPool!.query(`SELECT count(*)::int AS count FROM ${table}`);
      expect(count.rows[0].count).toBe(0);
    }
    const run = await testPool!.query(
      `SELECT checkpoint, rows_read, rows_inserted, rows_updated
         FROM klaviyo_sync_run WHERE id = 'run-rollback'`,
    );
    expect(run.rows[0]).toEqual({
      checkpoint: checkpoint0,
      rows_read: 0,
      rows_inserted: 0,
      rows_updated: 0,
    });
  });

  it("rejects wrong operation and immutable contract changes before source mutation", async () => {
    await seedRun({ id: "run-probe-page", operation: "probe" });
    await expect(
      store.commitKlaviyoEventPage({
        scope,
        syncRunId: "run-probe-page",
        sourceContract: contract,
        expectedCheckpoint: checkpoint0,
        nextCheckpoint: null,
        events: [eventFixture()],
        rowsRead: 1,
      }),
    ).rejects.toThrow("event sync run");
    await expect(
      store.commitKlaviyoEventPage({
        scope,
        syncRunId: "run-probe-page",
        sourceContract: { ...contract, unsafe: true } as never,
        expectedCheckpoint: checkpoint0,
        nextCheckpoint: null,
        events: [eventFixture()],
        rowsRead: 1,
      }),
    ).rejects.toThrow("not immutable order core");
    expect(
      (await testPool!.query(`SELECT count(*)::int AS count FROM klaviyo_event`)).rows[0]
        .count,
    ).toBe(0);
  });

  it("rejects missing or changed persisted source contracts without changing checkpoint or source", async () => {
    for (const [id, requestParameters] of [
      ["run-missing-mode", { metricKinds: contract.metricKinds }],
      [
        "run-changed-kinds",
        { sourceMode: "order_core", metricKinds: ["placed_order", "clicked_email"] },
      ],
    ] as const) {
      await seedRun({ id, requestParameters });
      await expect(
        store.commitKlaviyoEventPage({
          scope,
          syncRunId: id,
          sourceContract: contract,
          expectedCheckpoint: checkpoint0,
          nextCheckpoint: null,
          events: [eventFixture({ externalEventId: `event-${id}` })],
          rowsRead: 1,
        }),
      ).rejects.toThrow("invalid source contract");
      const run = await testPool!.query(
        `SELECT checkpoint, rows_read FROM klaviyo_sync_run WHERE id = $1`,
        [id],
      );
      expect(run.rows[0]).toEqual({ checkpoint: checkpoint0, rows_read: 0 });
      await testPool!.query(`UPDATE klaviyo_sync_run SET status = 'failed' WHERE id = $1`, [id]);
    }
    expect(
      (await testPool!.query(`SELECT count(*)::int AS count FROM klaviyo_event`)).rows[0]
        .count,
    ).toBe(0);
  });

  it("rejects wrong-kind, wrong-row, disabled, and cross-scope event metrics atomically", async () => {
    const cases: Array<{
      id: string;
      event: NormalizedKlaviyoEvent;
      prepare?: () => Promise<void>;
      restore?: () => Promise<void>;
    }> = [
      {
        id: "wrong-kind",
        event: eventFixture({ metricKind: "ordered_product" }),
      },
      {
        id: "wrong-row",
        event: eventFixture({ metricId: "metric-row-product" }),
      },
      {
        id: "disabled-row",
        event: eventFixture(),
        prepare: async () => {
          await testPool!.query(
            `UPDATE klaviyo_metric SET ingestion_enabled = 0 WHERE id = 'metric-row-placed'`,
          );
        },
        restore: async () => {
          await testPool!.query(
            `UPDATE klaviyo_metric SET ingestion_enabled = 1 WHERE id = 'metric-row-placed'`,
          );
        },
      },
      {
        id: "cross-scope-row",
        event: eventFixture({ metricId: "metric-row-other" }),
      },
    ];

    for (const testCase of cases) {
      await testCase.prepare?.();
      const runId = `run-${testCase.id}`;
      await seedRun({ id: runId });
      await expect(
        store.commitKlaviyoEventPage({
          scope,
          syncRunId: runId,
          sourceContract: contract,
          expectedCheckpoint: checkpoint0,
          nextCheckpoint: null,
          events: [
            eventFixture({
              ...testCase.event,
              externalEventId: `event-${testCase.id}`,
            }),
          ],
          rowsRead: 1,
        }),
      ).rejects.toThrow(/metric/i);
      await expectNoPageMutation(runId);
      await testPool!.query(
        `UPDATE klaviyo_sync_run SET status = 'failed' WHERE id = $1`,
        [runId],
      );
      await testCase.restore?.();
    }
  });

  it("ignores hostile product scope and database-column overrides", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, attribution_relationship_ids,
          redacted_properties, key_type_fingerprint, warnings,
          product_evidence_completeness, source_checksum, api_revision)
       VALUES ('event-b', 'org-b', 'store-b', 'connection-b', 'metric-row-other',
        'event-external-b', now(), '[]', '{}', '[]', '[]', 'complete',
        'checksum-b', '2026-07-15')`,
    );
    await seedRun({ id: "run-hostile-product" });
    const hostileProduct = Object.assign(
      {
        sourceOrdinal: 0,
        productId: "product-safe",
        variantId: "variant-safe",
        sku: "SKU-SAFE",
        productName: "Safe product",
        variantName: "Safe variant",
        quantity: 1,
      },
      {
        id: "hostile-product-id",
        organizationId: "org-b",
        storeId: "store-b",
        connectionId: "connection-b",
        eventId: "event-b",
        createdAt: new Date("2000-01-01T00:00:00.000Z"),
      },
    );
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-hostile-product",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture({ products: [hostileProduct] })],
      rowsRead: 1,
    });
    const products = await testPool!.query(
      `SELECT p.id, p.organization_id, p.shopify_store_id, p.connection_id,
              p.event_id, p.product_id, p.created_at, e.external_event_id
         FROM klaviyo_event_product p JOIN klaviyo_event e ON e.id = p.event_id`,
    );
    expect(products.rows).toHaveLength(1);
    expect(products.rows[0]).toMatchObject({
      organization_id: "org-a",
      shopify_store_id: "store-a",
      connection_id: "connection-a",
      product_id: "product-safe",
      external_event_id: "event-external-a",
    });
    expect(products.rows[0].id).not.toBe("hostile-product-id");
    expect(products.rows[0].event_id).not.toBe("event-b");
    expect(products.rows[0].created_at.getUTCFullYear()).not.toBe(2000);
  });

  it("keeps exact-run observations immutable across later-run updates", async () => {
    await seedRun({ id: "run-old" });
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-old",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture()],
      rowsRead: 1,
    });
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId: "run-old",
      operation: "events",
      status: "success",
    });
    await seedRun({ id: "run-new" });
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-new",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture({ sourceChecksum: "checksum-new", providerValue: "50.00" })],
      rowsRead: 1,
    });
    const versions = await testPool!.query(
      `SELECT r.sync_run_id, r.observed_source_checksum, e.source_checksum
         FROM klaviyo_event_run_observation r
         JOIN klaviyo_event e ON e.id = r.event_id
        ORDER BY r.sync_run_id`,
    );
    expect(versions.rows).toEqual([
      {
        sync_run_id: "run-new",
        observed_source_checksum: "checksum-new",
        source_checksum: "checksum-new",
      },
      {
        sync_run_id: "run-old",
        observed_source_checksum: "checksum-a",
        source_checksum: "checksum-new",
      },
    ]);
  });

  it("rejects different-checksum replay in one run and rolls the attempted update back", async () => {
    await seedRun({ id: "run-replay" });
    const next = { ...contract, metricIndex: 0, cursor: "next", page: 1 };
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-replay",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: next,
      events: [eventFixture()],
      rowsRead: 1,
    });
    // Simulate a worker retry from the persisted page boundary without touching
    // the immutable observation membership.
    await testPool!.query(
      `UPDATE klaviyo_sync_run SET checkpoint = $1 WHERE id = 'run-replay'`,
      [checkpoint0],
    );
    await expect(
      store.commitKlaviyoEventPage({
        scope,
        syncRunId: "run-replay",
        sourceContract: contract,
        expectedCheckpoint: checkpoint0,
        nextCheckpoint: next,
        events: [eventFixture({ sourceChecksum: "checksum-tampered" })],
        rowsRead: 1,
      }),
    ).rejects.toThrow("observation changed");
    const result = await testPool!.query(
      `SELECT e.source_checksum, r.observed_source_checksum, s.rows_read, s.rows_inserted
         FROM klaviyo_event e
         JOIN klaviyo_event_run_observation r ON r.event_id = e.id
         JOIN klaviyo_sync_run s ON s.id = r.sync_run_id`,
    );
    expect(result.rows[0]).toEqual({
      source_checksum: "checksum-a",
      observed_source_checksum: "checksum-a",
      rows_read: 1,
      rows_inserted: 1,
    });
  });

  it("finishes exactly one scoped operation and publishes event freshness atomically", async () => {
    await seedRun({ id: "run-finish" });
    await expect(
      store.finishKlaviyoSyncRun({
        scope: otherScope,
        syncRunId: "run-finish",
        operation: "events",
        status: "success",
      }),
    ).rejects.toThrow();
    await expect(
      store.finishKlaviyoSyncRun({
        scope,
        syncRunId: "run-finish",
        operation: "probe",
        status: "success",
      }),
    ).rejects.toThrow();
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId: "run-finish",
      operation: "events",
      status: "success",
    });
    const committed = await testPool!.query(
      `SELECT r.status, r.finished_at, c.last_event_synced_at
         FROM klaviyo_sync_run r JOIN klaviyo_connection c ON c.id = r.connection_id
        WHERE r.id = 'run-finish'`,
    );
    expect(committed.rows[0].status).toBe("success");
    expect(committed.rows[0].finished_at.getTime()).toBe(
      committed.rows[0].last_event_synced_at.getTime(),
    );
    await expect(
      store.finishKlaviyoSyncRun({
        scope,
        syncRunId: "run-finish",
        operation: "events",
        status: "failed",
      }),
    ).rejects.toThrow("not active");
  });

  it("never advances freshness for partial/failed events or non-event runs", async () => {
    const freshness = new Date("2026-07-01T00:00:00.000Z");
    await seedRun({ id: "run-partial", lastEventSyncedAt: freshness });
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId: "run-partial",
      operation: "events",
      status: "partial",
    });
    await seedRun({ id: "run-failed" });
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId: "run-failed",
      operation: "events",
      status: "failed",
      error: new Error("provider-private-detail"),
    });
    await seedRun({
      id: "run-probe-finish",
      operation: "probe",
      checkpoint: null,
      requestParameters: { sampleSize: 20 },
    });
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId: "run-probe-finish",
      operation: "probe",
      status: "success",
    });
    const result = await testPool!.query(
      `SELECT last_event_synced_at FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    expect(result.rows[0].last_event_synced_at.getTime()).toBe(freshness.getTime());
    const failed = await testPool!.query(
      `SELECT error_code, error_message FROM klaviyo_sync_run WHERE id = 'run-failed'`,
    );
    expect(failed.rows[0]).toEqual({
      error_code: "KLAVIYO_SYNC_FAILED",
      error_message:
        "Klaviyo sync failed; inspect the provider status and configured scopes",
    });
  });

  it("finalizes retry exhaustion once while preserving committed state and freshness", async () => {
    const freshness = new Date("2026-07-01T00:00:00.000Z");
    await seedRun({ id: "run-exhausted", lastEventSyncedAt: freshness });
    await testPool!.query(
      `UPDATE klaviyo_sync_run SET rows_read = 5, rows_inserted = 2, rows_updated = 1
        WHERE id = 'run-exhausted'`,
    );
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-exhausted",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [eventFixture()],
      rowsRead: 1,
    });
    await expect(
      store.failKlaviyoSyncRunAfterRetryExhaustion({
        scope,
        syncRunId: "run-exhausted",
        operation: "events",
      }),
    ).resolves.toEqual({ changed: true });
    await expect(
      store.failKlaviyoSyncRunAfterRetryExhaustion({
        scope,
        syncRunId: "run-exhausted",
        operation: "events",
      }),
    ).resolves.toEqual({ changed: false });
    const row = await testPool!.query(
      `SELECT r.status, r.error_code, r.error_message, r.failure_count,
              r.rows_read, r.rows_inserted, r.rows_updated, r.checkpoint,
              c.last_event_synced_at
         FROM klaviyo_sync_run r JOIN klaviyo_connection c ON c.id = r.connection_id
        WHERE r.id = 'run-exhausted'`,
    );
    expect(row.rows[0]).toMatchObject({
      status: "failed",
      error_code: "KLAVIYO_RETRIES_EXHAUSTED",
      error_message: "Klaviyo task retries were exhausted",
      failure_count: 1,
      rows_read: 6,
      rows_inserted: 3,
      rows_updated: 1,
      checkpoint: null,
    });
    expect(row.rows[0].last_event_synced_at.getTime()).toBe(freshness.getTime());
    await expect(seedRun({ id: "run-replacement" })).resolves.toBeUndefined();
  });

  it("requires exact scope/operation for retry exhaustion and supports probe runs", async () => {
    await seedRun({
      id: "run-probe-exhausted",
      operation: "probe",
      checkpoint: null,
      requestParameters: { sampleSize: 20 },
    });
    await expect(
      store.failKlaviyoSyncRunAfterRetryExhaustion({
        scope: { ...scope, organizationId: "org-b" },
        syncRunId: "run-probe-exhausted",
        operation: "probe",
      }),
    ).rejects.toThrow("outside this scope");
    const untouched = await testPool!.query(
      `SELECT status, failure_count FROM klaviyo_sync_run
        WHERE id = 'run-probe-exhausted'`,
    );
    expect(untouched.rows[0]).toEqual({ status: "running", failure_count: 0 });
    await expect(
      store.failKlaviyoSyncRunAfterRetryExhaustion({
        scope,
        syncRunId: "run-probe-exhausted",
        operation: "events",
      }),
    ).rejects.toThrow("scoped operation");
    await expect(
      store.failKlaviyoSyncRunAfterRetryExhaustion({
        scope,
        syncRunId: "run-probe-exhausted",
        operation: "probe",
      }),
    ).resolves.toEqual({ changed: true });
  });

  it("does not rewrite success, partial, or failed runs on retry-hook replay", async () => {
    const terminalStates = ["success", "partial", "failed"] as const;
    for (const [index, status] of terminalStates.entries()) {
      const id = `terminal-${status}`;
      await seedRun({ id, status });
      const finishedAt = new Date(`2026-07-0${index + 1}T00:00:00.000Z`);
      await testPool!.query(
        `UPDATE klaviyo_sync_run
            SET error_code = $2, error_message = $3, failure_count = $4,
                finished_at = $5
          WHERE id = $1`,
        [id, `SAFE_${status}`, `safe ${status}`, index + 2, finishedAt],
      );
      const before = await testPool!.query(
        `SELECT status, error_code, error_message, failure_count, finished_at
           FROM klaviyo_sync_run WHERE id = $1`,
        [id],
      );
      await expect(
        store.failKlaviyoSyncRunAfterRetryExhaustion({
          scope,
          syncRunId: id,
          operation: "events",
        }),
      ).resolves.toEqual({ changed: false });
      const after = await testPool!.query(
        `SELECT status, error_code, error_message, failure_count, finished_at
           FROM klaviyo_sync_run WHERE id = $1`,
        [id],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    }
  });

  it("renews heartbeat and reaps only a lease at least twenty minutes old", async () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    await seedRun({
      id: "run-lease",
    });
    await setHeartbeatForTest(
      "run-lease",
      new Date(now.getTime() - store.KLAVIYO_RUN_STALE_AFTER_MS + 1),
    );
    await expect(
      store.failExpiredKlaviyoSyncRun({ scope, syncRunId: "run-lease", operation: "events", now }),
    ).resolves.toEqual({ changed: false });
    await setHeartbeatForTest(
      "run-lease",
      new Date(now.getTime() - store.KLAVIYO_RUN_STALE_AFTER_MS),
    );
    await expect(
      store.failExpiredKlaviyoSyncRun({ scope, syncRunId: "run-lease", operation: "events", now }),
    ).resolves.toEqual({ changed: true });
    await expect(
      store.failExpiredKlaviyoSyncRun({ scope, syncRunId: "run-lease", operation: "events", now }),
    ).resolves.toEqual({ changed: false });
    const row = await testPool!.query(
      `SELECT status, error_code, error_message, failure_count
         FROM klaviyo_sync_run WHERE id = 'run-lease'`,
    );
    expect(row.rows[0]).toEqual({
      status: "failed",
      error_code: "KLAVIYO_LEASE_EXPIRED",
      error_message: "Klaviyo task lease expired before completion",
      failure_count: 1,
    });
  });

  it("refuses to move a running heartbeat backwards", async () => {
    await seedRun({ id: "run-monotonic-heartbeat" });
    const baseline = new Date("2026-07-30T12:00:00.000Z");
    await setHeartbeatForTest("run-monotonic-heartbeat", baseline);
    const forward = new Date(baseline.getTime() + 60_000);
    await store.renewKlaviyoSyncRunHeartbeat({
      scope,
      syncRunId: "run-monotonic-heartbeat",
      operation: "events",
      now: forward,
    });
    await expect(
      store.renewKlaviyoSyncRunHeartbeat({
        scope,
        syncRunId: "run-monotonic-heartbeat",
        operation: "events",
        now: new Date(forward.getTime() - 1),
      }),
    ).rejects.toThrow(/backwards/i);
    const [run] = await testDb!
      .select({ heartbeatAt: klaviyoSyncRuns.heartbeatAt })
      .from(klaviyoSyncRuns)
      .where(eq(klaviyoSyncRuns.id, "run-monotonic-heartbeat"));
    expect(run.heartbeatAt.getTime()).toBe(forward.getTime());
  });

  it("reaps and replaces atomically under one connection lock", async () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    await seedRun({
      id: "run-stale",
    });
    await setHeartbeatForTest(
      "run-stale",
      new Date(now.getTime() - store.KLAVIYO_RUN_STALE_AFTER_MS),
    );
    await store.withKlaviyoConnectionLock(scope, async (tx) => {
      await store.failExpiredKlaviyoSyncRun(
        { scope, syncRunId: "run-stale", operation: "events", now },
        tx,
      );
      await tx.insert((await import("@/schema/klaviyo")).klaviyoSyncRuns).values({
        id: "run-reaped-replacement",
        organizationId: scope.organizationId,
        storeId: scope.storeId,
        connectionId: scope.connectionId,
        operation: "events",
        triggerType: "manual",
        requestParameters: contract,
        checkpoint: checkpoint0,
        status: "running",
      });
    });
    const rows = await testPool!.query(
      `SELECT id, status FROM klaviyo_sync_run ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: "run-reaped-replacement", status: "running" },
      { id: "run-stale", status: "failed" },
    ]);
  });

  it("commits scoped discovery and rejects account disagreement atomically", async () => {
    await seedRun({
      id: "run-discovery",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });
    await store.commitKlaviyoDiscovery({
      scope,
      syncRunId: "run-discovery",
      expectedAccountId: "account-a",
      account: {
        id: "account-a",
        name: "Reviv",
        timezone: "America/New_York",
        currency: "USD",
      },
      metrics: [
        {
          externalMetricId: "metric-external-placed",
          name: "Placed Order",
          integrationName: "Shopify",
          integrationCategory: "ecommerce",
          canonicalKind: "placed_order",
          ingestionEnabled: true,
          apiRevision: "2026-07-15",
        },
        {
          externalMetricId: "metric-external-product",
          name: "Ordered Product",
          integrationName: "Shopify",
          integrationCategory: "ecommerce",
          canonicalKind: "ordered_product",
          ingestionEnabled: true,
          apiRevision: "2026-07-15",
        },
      ],
    });
    const committed = await testPool!.query(
      `SELECT c.account_name, c.last_discovery_synced_at, r.status
         FROM klaviyo_connection c JOIN klaviyo_sync_run r ON r.connection_id = c.id
        WHERE r.id = 'run-discovery'`,
    );
    expect(committed.rows[0]).toMatchObject({ account_name: "Reviv", status: "success" });
    expect(committed.rows[0].last_discovery_synced_at).toBeInstanceOf(Date);

    await seedRun({
      id: "run-discovery-bad",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });
    await expect(
      store.commitKlaviyoDiscovery({
        scope,
        syncRunId: "run-discovery-bad",
        expectedAccountId: "account-a",
        account: { id: "account-other", name: null, timezone: null, currency: null },
        metrics: discoveryMetrics(),
      }),
    ).rejects.toThrow("does not match the Reviv binding");
    const failedAttempt = await testPool!.query(
      `SELECT status FROM klaviyo_sync_run WHERE id = 'run-discovery-bad'`,
    );
    expect(failedAttempt.rows[0].status).toBe("running");
  });

  it("invalidates approved parsing/matching and a running event when native bindings change", async () => {
    await seedProbeParents(scope);
    await testPool!.query(
      `UPDATE klaviyo_connection SET status = 'ready' WHERE id = 'connection-a'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_alias
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          probe_report_id, canonical_field, source_property, state, observed_populated)
       VALUES ('approved-before-rebind', 'org-a', 'store-a', 'connection-a',
        'metric-row-placed', 'probe-connection-a', 'orderId', 'OrderId',
        'approved', 20)`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_join_rule
         (id, organization_id, shopify_store_id, connection_id, probe_report_id,
          event_kind, source_property, target_namespace, canonicalizer, state,
          observed_populated, observed_collisions)
       VALUES ('rule-before-rebind', 'org-a', 'store-a', 'connection-a',
        'probe-connection-a', 'placed_order', 'OrderId', 'shopify_order_gid',
        'shopify_order_gid', 'approved', 20, 0)`,
    );
    await seedRun({ id: "event-before-rebind" });
    await seedRun({
      id: "discovery-rebind",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });

    await store.commitKlaviyoDiscovery({
      scope,
      syncRunId: "discovery-rebind",
      expectedAccountId: "account-a",
      account: {
        id: "account-a",
        name: "Reviv",
        timezone: "America/New_York",
        currency: "USD",
      },
      metrics: discoveryMetrics({
        placedId: "metric-external-placed-v2",
        productId: "metric-external-product-v2",
      }),
    });

    const connection = await testPool!.query(
      `SELECT status FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    expect(connection.rows[0].status).toBe("pending");
    const metrics = await testPool!.query(
      `SELECT external_metric_id, ingestion_enabled
         FROM klaviyo_metric WHERE connection_id = 'connection-a'
        ORDER BY external_metric_id`,
    );
    expect(metrics.rows).toEqual([
      { external_metric_id: "metric-external-placed", ingestion_enabled: 0 },
      { external_metric_id: "metric-external-placed-v2", ingestion_enabled: 1 },
      { external_metric_id: "metric-external-product", ingestion_enabled: 0 },
      { external_metric_id: "metric-external-product-v2", ingestion_enabled: 1 },
    ]);
    expect(
      (
        await testPool!.query(
          `SELECT state FROM klaviyo_event_alias WHERE id = 'approved-before-rebind'`,
        )
      ).rows[0].state,
    ).toBe("disabled");
    expect(
      (
        await testPool!.query(
          `SELECT state FROM klaviyo_join_rule WHERE id = 'rule-before-rebind'`,
        )
      ).rows[0].state,
    ).toBe("disabled");
    const runs = await testPool!.query(
      `SELECT id, status, error_code FROM klaviyo_sync_run
        WHERE id IN ('event-before-rebind', 'discovery-rebind') ORDER BY id`,
    );
    expect(runs.rows).toEqual([
      { id: "discovery-rebind", status: "success", error_code: null },
      {
        id: "event-before-rebind",
        status: "failed",
        error_code: "KLAVIYO_METRIC_BINDING_CHANGED",
      },
    ]);
  });

  it("ignores hostile discovery scope and database-column overrides", async () => {
    await seedRun({
      id: "discovery-hostile-scope",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });
    const [placed, product] = discoveryMetrics({
      placedId: "metric-external-other",
    });
    const hostilePlaced = Object.assign(
      { ...placed, name: "Scoped A replacement" },
      {
        id: "metric-row-other",
        organizationId: "org-b",
        storeId: "store-b",
        connectionId: "connection-b",
        discoveredAt: new Date("2000-01-01T00:00:00.000Z"),
        updatedAt: new Date("2000-01-01T00:00:00.000Z"),
      },
    );
    await store.commitKlaviyoDiscovery({
      scope,
      syncRunId: "discovery-hostile-scope",
      expectedAccountId: "account-a",
      account: { id: "account-a", name: null, timezone: null, currency: null },
      metrics: [hostilePlaced, product],
    });
    const otherMetric = await testPool!.query(
      `SELECT name, organization_id, shopify_store_id, connection_id
         FROM klaviyo_metric WHERE id = 'metric-row-other'`,
    );
    expect(otherMetric.rows[0]).toEqual({
      name: "Placed Order",
      organization_id: "org-b",
      shopify_store_id: "store-b",
      connection_id: "connection-b",
    });
    const scopedMetric = await testPool!.query(
      `SELECT id, organization_id, shopify_store_id, connection_id, discovered_at
         FROM klaviyo_metric
        WHERE connection_id = 'connection-a'
          AND external_metric_id = 'metric-external-other'`,
    );
    expect(scopedMetric.rows).toHaveLength(1);
    expect(scopedMetric.rows[0]).toMatchObject({
      organization_id: "org-a",
      shopify_store_id: "store-a",
      connection_id: "connection-a",
    });
    expect(scopedMetric.rows[0].id).not.toBe("metric-row-other");
    expect(scopedMetric.rows[0].discovered_at.getUTCFullYear()).not.toBe(2000);
  });

  it("rejects duplicate external IDs anywhere in a discovery payload", async () => {
    await seedRun({
      id: "discovery-duplicate-external",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });
    const metrics = discoveryMetrics();
    metrics.push({
      ...metrics[0],
      name: "Duplicate disabled copy",
      canonicalKind: null as never,
      ingestionEnabled: false,
    });
    await expect(
      store.commitKlaviyoDiscovery({
        scope,
        syncRunId: "discovery-duplicate-external",
        expectedAccountId: "account-a",
        account: { id: "account-a", name: null, timezone: null, currency: null },
        metrics,
      }),
    ).rejects.toThrow(/duplicate external metric/i);
    const run = await testPool!.query(
      `SELECT status FROM klaviyo_sync_run WHERE id = 'discovery-duplicate-external'`,
    );
    expect(run.rows[0].status).toBe("running");
    const enabled = await testPool!.query(
      `SELECT external_metric_id FROM klaviyo_metric
        WHERE connection_id = 'connection-a' AND ingestion_enabled = 1
        ORDER BY external_metric_id`,
    );
    expect(enabled.rows).toEqual([
      { external_metric_id: "metric-external-placed" },
      { external_metric_id: "metric-external-product" },
    ]);
  });

  it("preserves readiness, approved parsing, and a running event when bindings are unchanged", async () => {
    await seedProbeParents(scope);
    await testPool!.query(
      `UPDATE klaviyo_connection SET status = 'ready' WHERE id = 'connection-a'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_alias
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          probe_report_id, canonical_field, source_property, state, observed_populated)
       VALUES ('approved-unchanged', 'org-a', 'store-a', 'connection-a',
        'metric-row-placed', 'probe-connection-a', 'orderId', 'OrderId',
        'approved', 20)`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_join_rule
         (id, organization_id, shopify_store_id, connection_id, probe_report_id,
          event_kind, source_property, target_namespace, canonicalizer, state,
          observed_populated, observed_collisions)
       VALUES ('rule-unchanged', 'org-a', 'store-a', 'connection-a',
        'probe-connection-a', 'placed_order', 'OrderId', 'shopify_order_gid',
        'shopify_order_gid', 'approved', 20, 0)`,
    );
    await seedRun({ id: "event-unchanged" });
    await seedRun({
      id: "discovery-unchanged",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });

    await store.commitKlaviyoDiscovery({
      scope,
      syncRunId: "discovery-unchanged",
      expectedAccountId: "account-a",
      account: {
        id: "account-a",
        name: "Reviv",
        timezone: "America/New_York",
        currency: "USD",
      },
      metrics: discoveryMetrics(),
    });

    const state = await testPool!.query(
      `SELECT
         (SELECT status FROM klaviyo_connection WHERE id = 'connection-a') AS connection_status,
         (SELECT state FROM klaviyo_event_alias WHERE id = 'approved-unchanged') AS alias_state,
         (SELECT state FROM klaviyo_join_rule WHERE id = 'rule-unchanged') AS rule_state,
         (SELECT status FROM klaviyo_sync_run WHERE id = 'event-unchanged') AS event_status`,
    );
    expect(state.rows[0]).toEqual({
      connection_status: "ready",
      alias_state: "approved",
      rule_state: "approved",
      event_status: "running",
    });
    const enabled = await testPool!.query(
      `SELECT external_metric_id FROM klaviyo_metric
        WHERE connection_id = 'connection-a' AND ingestion_enabled = 1
        ORDER BY external_metric_id`,
    );
    expect(enabled.rows).toEqual([
      { external_metric_id: "metric-external-placed" },
      { external_metric_id: "metric-external-product" },
    ]);
  });

  it("disables an allowlisted metric omitted from the latest discovery", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_metric
         (id, organization_id, shopify_store_id, connection_id,
          external_metric_id, name, canonical_kind, ingestion_enabled, api_revision)
       VALUES ('metric-row-clicked', 'org-a', 'store-a', 'connection-a',
        'metric-external-clicked', 'Clicked Email', 'clicked_email', 1, '2026-07-15')`,
    );
    await seedRun({
      id: "discovery-omitted",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });

    await store.commitKlaviyoDiscovery({
      scope,
      syncRunId: "discovery-omitted",
      expectedAccountId: "account-a",
      account: { id: "account-a", name: null, timezone: null, currency: null },
      metrics: discoveryMetrics(),
    });

    const clicked = await testPool!.query(
      `SELECT ingestion_enabled FROM klaviyo_metric WHERE id = 'metric-row-clicked'`,
    );
    expect(clicked.rows[0].ingestion_enabled).toBe(0);
    const connection = await testPool!.query(
      `SELECT status FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    expect(connection.rows[0].status).toBe("pending");
  });

  it("reuses a live prepared run and refuses a different scoped request", async () => {
    const now = new Date();
    const first = await store.prepareKlaviyoOperationRun({
      scope,
      operation: "discovery",
      triggerType: "manual",
      requestParameters: {},
      now,
    });
    expect(first.reused).toBe(false);
    const second = await store.prepareKlaviyoOperationRun({
      scope,
      operation: "discovery",
      triggerType: "manual",
      requestParameters: {},
      now: new Date(now.getTime() + 1000),
    });
    expect(second).toEqual({ syncRunId: first.syncRunId, reused: true });

    await seedRun({
      id: "probe-live",
      operation: "probe",
      checkpoint: null,
      requestParameters: { sampleSize: 20 },
    });
    await expect(
      store.prepareKlaviyoOperationRun({
        scope,
        operation: "probe",
        triggerType: "manual",
        requestParameters: { sampleSize: 30 },
        now: new Date(),
      }),
    ).rejects.toThrow(/already running/i);
    const probeRuns = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_sync_run
        WHERE connection_id = 'connection-a' AND operation = 'probe'`,
    );
    expect(probeRuns.rows[0].count).toBe(1);
  });

  it("finalizes an expired prepared run with the fixed lease code before replacement", async () => {
    const now = new Date();
    await seedRun({
      id: "discovery-expired",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
      heartbeatAt: new Date(now.getTime() - 25 * 60 * 1000),
    });
    const replacement = await store.prepareKlaviyoOperationRun({
      scope,
      operation: "discovery",
      triggerType: "manual",
      requestParameters: {},
      now,
    });
    expect(replacement.reused).toBe(false);
    expect(replacement.syncRunId).not.toBe("discovery-expired");
    const reaped = await testPool!.query(
      `SELECT status, error_code, error_message FROM klaviyo_sync_run
        WHERE id = 'discovery-expired'`,
    );
    expect(reaped.rows[0]).toEqual({
      status: "failed",
      error_code: "KLAVIYO_LEASE_EXPIRED",
      error_message: "Klaviyo task lease expired before completion",
    });
  });

  it("keeps committed account and metric data across lease recovery", async () => {
    await seedRun({
      id: "discovery-committed",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
    });
    await store.commitKlaviyoDiscovery({
      scope,
      syncRunId: "discovery-committed",
      expectedAccountId: "account-a",
      account: {
        id: "account-a",
        name: "Reviv",
        timezone: "America/New_York",
        currency: "USD",
      },
      metrics: discoveryMetrics(),
    });

    const now = new Date();
    await seedRun({
      id: "discovery-crashed",
      operation: "discovery",
      checkpoint: null,
      requestParameters: {},
      heartbeatAt: new Date(now.getTime() - 25 * 60 * 1000),
    });
    await store.prepareKlaviyoOperationRun({
      scope,
      operation: "discovery",
      triggerType: "manual",
      requestParameters: {},
      now,
    });

    const preserved = await testPool!.query(
      `SELECT
         (SELECT account_name FROM klaviyo_connection WHERE id = 'connection-a') AS account_name,
         (SELECT count(*)::int FROM klaviyo_metric
           WHERE connection_id = 'connection-a' AND ingestion_enabled = 1) AS enabled_count`,
    );
    expect(preserved.rows[0]).toEqual({ account_name: "Reviv", enabled_count: 2 });
  });

  it("never returns opaque provider cursors, request JSON, or raw errors", async () => {
    const hostile = "user@example.com-secret-provider-cursor-key-fragment";
    await seedRun({ id: "run-hostile" });
    await testPool!.query(
      `UPDATE klaviyo_sync_run
          SET checkpoint = $1,
              request_parameters = $2,
              error_code = 'PROVIDER_RAW',
              error_message = $3
        WHERE id = 'run-hostile'`,
      [
        { ...checkpoint0, cursor: hostile, page: 4 },
        { ...contract, privateCursor: hostile },
        `GET https://a.klaviyo.com?email=${hostile}`,
      ],
    );
    await seedRun({
      id: "run-invalid-summary",
      status: "success",
      checkpoint: { ...checkpoint0, cursor: hostile, unsafeExtra: true },
    });
    await seedRun({
      id: "probe-invalid-summary",
      operation: "probe",
      status: "success",
      checkpoint: { page: 4, cursor: hostile },
      requestParameters: { sampleSize: 20 },
    });
    const result = await store.listKlaviyoSyncRuns({ scope, limit: 20, cursor: null });
    expect(
      result.items.find((item) => item.id === "run-hostile")?.checkpointSummary,
    ).toEqual({
      sourceMode: "order_core",
      metricIndex: 0,
      page: 4,
    });
    expect(
      result.items.find((item) => item.id === "run-invalid-summary")
        ?.checkpointSummary,
    ).toBeNull();
    expect(
      result.items.find((item) => item.id === "probe-invalid-summary")
        ?.checkpointSummary,
    ).toBeNull();
    expect(result.items.find((item) => item.id === "run-hostile")?.errorMessage).toBe(
      "Klaviyo sync failed; inspect the provider status and configured scopes",
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain("privateCursor");
    expect(serialized).not.toContain("a.klaviyo.com");
    expect(serialized).not.toContain("PROVIDER_RAW");
  });

  it("paginates sync runs stably without exposing checkpoint or request JSON", async () => {
    for (const [id, startedAt] of [
      ["page-run-1", "2026-07-01T00:00:00.000Z"],
      ["page-run-2", "2026-07-02T00:00:00.000Z"],
      ["page-run-3", "2026-07-03T00:00:00.000Z"],
    ] as const) {
      await seedRun({ id, status: "success" });
      await testPool!.query(
        `UPDATE klaviyo_sync_run SET started_at = $2 WHERE id = $1`,
        [id, startedAt],
      );
    }
    const first = await store.listKlaviyoSyncRuns({ scope, limit: 2, cursor: null });
    expect(first.items.map((item) => item.id)).toEqual(["page-run-3", "page-run-2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const repeat = await store.listKlaviyoSyncRuns({ scope, limit: 2, cursor: null });
    expect(repeat).toEqual(first);
    const second = await store.listKlaviyoSyncRuns({
      scope,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual(["page-run-1"]);
    expect(second.nextCursor).toBeNull();
    const serialized = JSON.stringify({ first, second });
    expect(serialized).not.toContain("requestParameters");
    expect(serialized).not.toContain('"checkpoint"');
    expect(serialized).not.toContain("cursor");
  });

  it("lists only scoped redacted probe and rule review fields", async () => {
    await seedProbeParents(scope);
    await seedProbeParents(otherScope);
    await testPool!.query(
      `INSERT INTO klaviyo_join_rule
         (id, organization_id, shopify_store_id, connection_id, probe_report_id,
          event_kind, source_property, target_namespace, canonicalizer, state,
          observed_populated, observed_collisions, review_note)
       VALUES
         ('review-rule-a', 'org-a', 'store-a', 'connection-a',
          'probe-connection-a', 'placed_order', 'OrderId', 'shopify_order_gid',
          'shopify_order_gid', 'candidate', 20, 0, 'safe note'),
         ('review-rule-b', 'org-b', 'store-b', 'connection-b',
          'probe-connection-b', 'placed_order', 'OrderId', 'shopify_order_gid',
          'shopify_order_gid', 'candidate', 20, 0, 'other note')`,
    );
    const review = await store.listKlaviyoProbeReview({ scope });
    expect(review.reports.map((report) => report.id)).toEqual([
      "probe-connection-a",
    ]);
    expect(review.reports[0].redactionVerified).toBe(true);
    expect(review.rules.map((rule) => rule.id)).toEqual(["review-rule-a"]);
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("probe-run-connection-a");
    expect(serialized).not.toContain("checksum-connection-a");
    expect(serialized).not.toContain('"connectionId"');
    expect(serialized).not.toContain('"organizationId"');
    expect(serialized).not.toContain('"storeId"');
  });

  it("returns safe pre-connection and discovered health without binding identifiers", async () => {
    const provider = {
      getPilotBinding: async () => ({
        expectedAccountId: "account-a",
        shopDomain: "a.example.com",
        allowedUrlHosts: ["a.example.com"],
      }),
      resolve: vi.fn(),
    };
    const discovered = await store.getKlaviyoHealthForOrganization(
      "org-a",
      new Date("2026-07-30T03:30:00.000Z"),
      provider,
    );
    expect(discovered.store?.todayInStoreTz).toBe("2026-07-29");
    expect(JSON.stringify(discovered)).not.toContain("account-a");
    expect(JSON.stringify(discovered)).not.toContain("connection-a");
    await testPool!.query(`DELETE FROM klaviyo_connection WHERE id = 'connection-a'`);
    const pending = await store.getKlaviyoHealthForOrganization("org-a", new Date(), provider);
    expect(pending).toMatchObject({ configured: true, connection: null });
    expect(pending.store?.id).toBe("store-a");
    await expect(
      store.getKlaviyoHealthForOrganization("org-a", new Date(), {
        getPilotBinding: async () => {
          throw new Error("missing private key");
        },
        resolve: vi.fn(),
      }),
    ).resolves.toEqual({ configured: false, store: null, connection: null });
  });

  it("serializes page mutation behind the shared publication connection lock", async () => {
    await seedRun({ id: "run-race" });
    const publisher: PoolClient = await testPool!.connect();
    try {
      await publisher.query("BEGIN");
      const blocker = await publisher.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      const blockerPid = blocker.rows[0].pid;
      await publisher.query(
        `SELECT id FROM klaviyo_connection
          WHERE organization_id = $1 AND shopify_store_id = $2 AND id = $3
          FOR UPDATE`,
        [scope.organizationId, scope.storeId, scope.connectionId],
      );
      // Plan 3 publication validates the current checksum while holding this lock.
      const validated = await publisher.query(
        `SELECT source_checksum FROM klaviyo_event WHERE connection_id = $1`,
        [scope.connectionId],
      );
      expect(validated.rowCount).toBe(0);

      let pageSettled = false;
      const pageCommit = store
        .commitKlaviyoEventPage({
          scope,
          syncRunId: "run-race",
          sourceContract: contract,
          expectedCheckpoint: checkpoint0,
          nextCheckpoint: null,
          events: [eventFixture()],
          rowsRead: 1,
        })
        .then((result) => {
          pageSettled = true;
          return result;
        });
      let waiterPid: number | null = null;
      for (let attempt = 0; attempt < 100 && waiterPid === null; attempt += 1) {
        const waiters = await testPool!.query<{ pid: number }>(
          `SELECT pid
             FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
            ORDER BY pid
            LIMIT 1`,
          [blockerPid],
        );
        waiterPid = waiters.rows[0]?.pid ?? null;
        if (waiterPid === null) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(waiterPid).not.toBeNull();
      expect(pageSettled).toBe(false);
      const beforePublication = await publisher.query(
        `SELECT count(*)::int AS count FROM klaviyo_event WHERE connection_id = $1`,
        [scope.connectionId],
      );
      expect(beforePublication.rows[0].count).toBe(0);
      await publisher.query("COMMIT");
      await expect(pageCommit).resolves.toMatchObject({ committed: true });
    } finally {
      try {
        await publisher.query("ROLLBACK");
      } finally {
        publisher.release();
      }
    }
  });
});
