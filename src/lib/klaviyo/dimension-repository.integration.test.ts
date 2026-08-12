import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  KlaviyoCompoundPage,
  KlaviyoResource,
} from "@/lib/klaviyo/client";
import type {
  KlaviyoCredentialProvider,
  ResolvedKlaviyoCredential,
  RevivKlaviyoBinding,
} from "@/lib/klaviyo/credential-provider";
import type { NormalizedMarketingObject } from "@/lib/klaviyo/dimensions";
import type { KlaviyoDimensionCheckpoint } from "@/lib/klaviyo/types";

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

const FIXTURE_DDL = [
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
     shopify_order_id text NOT NULL, order_created_at timestamp NOT NULL,
     order_day date NOT NULL, net_sales numeric NOT NULL,
     bucket attribution_bucket, bucket_rule_version integer,
     meta_verified boolean DEFAULT false NOT NULL, meta_campaign_id text,
     verification_pending boolean DEFAULT false NOT NULL,
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
const TEST_DATABASE = "adsolute_klaviyo_dimension_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 8,
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const repository = await import("@/lib/klaviyo/dimension-repository");
const store = await import("@/lib/klaviyo/source-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = {
  organizationId: "org-a",
  storeId: "store-a",
  connectionId: "connection-a",
};

const BINDING: RevivKlaviyoBinding = {
  expectedAccountId: "account-a",
  shopDomain: "a.example.com",
  allowedUrlHosts: [],
};

const fakeCredentialProvider: KlaviyoCredentialProvider = {
  async getPilotBinding() {
    return BINDING;
  },
  async resolve(): Promise<ResolvedKlaviyoCredential> {
    return {
      privateApiKey: "pk_test",
      reference: "reviv_environment",
      expectedAccountId: "account-a",
      allowedUrlHosts: [],
    };
  },
};

function page(
  data: KlaviyoResource[],
  nextCursor: string | null = null,
): KlaviyoCompoundPage {
  return { data, included: [], nextCursor, apiRevision: "2026-07-15" };
}

function fakeDimensionClient() {
  return {
    listCampaigns: vi
      .fn<
        (input: {
          channel: "email" | "sms";
          cursor: string | null;
        }) => Promise<KlaviyoCompoundPage>
      >()
      .mockImplementation(async ({ channel }) =>
        channel === "email"
          ? page([
              {
                type: "campaign",
                id: "campaign-1",
                attributes: { name: "Summer Sale", status: "sent" },
              },
            ])
          : page([]),
      ),
    listCampaignMessages: vi
      .fn<(input: unknown) => Promise<KlaviyoCompoundPage>>()
      .mockResolvedValue(
        page([
          {
            type: "campaign-message",
            id: "message-1",
            attributes: { label: "Main", channel: "email" },
          },
        ]),
      ),
    listFlows: vi
      .fn<(input: unknown) => Promise<KlaviyoCompoundPage>>()
      .mockResolvedValue(
        page([{ type: "flow", id: "flow-1", attributes: { name: "Welcome" } }]),
      ),
    listFlowActions: vi
      .fn<(input: unknown) => Promise<KlaviyoCompoundPage>>()
      .mockResolvedValue(page([{ type: "flow-action", id: "action-1" }])),
    listFlowMessages: vi
      .fn<(input: unknown) => Promise<KlaviyoCompoundPage>>()
      .mockResolvedValue(
        page([
          {
            type: "flow-message",
            id: "flow-message-1",
            attributes: { name: "Welcome Email" },
          },
        ]),
      ),
    getTrackingSettings: vi
      .fn<(input: unknown) => Promise<KlaviyoCompoundPage>>()
      .mockResolvedValue(
        page([
          {
            type: "tracking-setting",
            id: "tracking-1",
            attributes: { utm_source: "klaviyo", auto_add_parameters: true },
          },
        ]),
      ),
  };
}

function marketingObject(
  overrides: Partial<NormalizedMarketingObject> = {},
): NormalizedMarketingObject {
  return {
    objectType: "campaign",
    externalId: "campaign-1",
    parentExternalId: null,
    parentObjectType: null,
    name: "Summer Sale",
    channel: "email",
    status: "sent",
    providerCreatedAt: new Date("2026-07-01T00:00:00Z"),
    providerUpdatedAt: null,
    trackingProjection: {},
    ...overrides,
  };
}

const checkpoint1: KlaviyoDimensionCheckpoint = {
  operation: "dimensions",
  stage: "campaigns_email",
  parentExternalId: null,
  cursor: "cursor-1",
  page: 1,
};

async function startRun(): Promise<string> {
  const { syncRunId } = await repository.startOrResumeDimensionSync({
    scope,
    triggerType: "manual",
    now: new Date(),
  });
  return syncRunId;
}

describeIfDb("Klaviyo dimension repository on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    // A DROP DATABASE ... WITH (FORCE) from a leftover or concurrent run kills
    // idle clients, which surfaces as a pool-level error; without a listener
    // that crashes the worker even when every assertion passed.
    adminPool.on("error", () => {});
    testPool?.on("error", () => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    for (const statement of FIXTURE_DDL) await testPool!.query(statement);
    for (const migration of [
      "0055_klaviyo_shopify_evidence.sql",
      "0056_klaviyo_source_core.sql",
      "0057_klaviyo_advisory_matching.sql",
      "0058_klaviyo_claims_reporting.sql",
    ]) {
      for (const statement of migrationStatements(migration)) {
        await testPool!.query(statement);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`,
      );
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE klaviyo_connection, shopify_store, organization
         RESTART IDENTITY CASCADE`,
    );
    await testPool!.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES
         ('org-a', 'Org A', 'org-a', now()), ('org-b', 'Org B', 'org-b', now())`,
    );
    await testPool!.query(
      `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone) VALUES
         ('store-a', 'org-a', 'a.example.com', 'America/New_York'),
         ('store-b', 'org-b', 'b.example.com', 'UTC')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_connection
         (id, organization_id, shopify_store_id, klaviyo_account_id, status) VALUES
         ('connection-a', 'org-a', 'store-a', 'account-a', 'ready'),
         ('connection-b', 'org-b', 'store-b', 'account-b', 'ready')`,
    );
  });

  it("replays page upserts by scoped external identity without duplicates", async () => {
    const syncRunId = await startRun();
    await repository.commitKlaviyoDimensionPage({
      scope,
      syncRunId,
      page: {
        objects: [marketingObject()],
        trackingSettings: [],
        warnings: [],
        apiRevision: "2026-07-15",
      },
      expectedCheckpoint: null,
      nextCheckpoint: checkpoint1,
      now: new Date(),
    });
    await repository.commitKlaviyoDimensionPage({
      scope,
      syncRunId,
      page: {
        objects: [marketingObject({ name: "Summer Sale Updated" })],
        trackingSettings: [],
        warnings: [],
        apiRevision: "2026-07-15",
      },
      expectedCheckpoint: checkpoint1,
      nextCheckpoint: { ...checkpoint1, cursor: null, page: 2 },
      now: new Date(),
    });
    const rows = await testPool!.query(
      `SELECT name FROM klaviyo_marketing_object
        WHERE connection_id = 'connection-a' AND object_type = 'campaign'
          AND external_id = 'campaign-1'`,
    );
    expect(rows.rows).toEqual([{ name: "Summer Sale Updated" }]);
  });

  it("advances checkpoint and heartbeat atomically and rejects stale replays", async () => {
    const syncRunId = await startRun();
    await repository.commitKlaviyoDimensionPage({
      scope,
      syncRunId,
      page: {
        objects: [marketingObject()],
        trackingSettings: [],
        warnings: ["campaign_name_unavailable"],
        apiRevision: "2026-07-15",
      },
      expectedCheckpoint: null,
      nextCheckpoint: checkpoint1,
      now: new Date(),
    });
    const run = await testPool!.query(
      `SELECT checkpoint, warning_count FROM klaviyo_sync_run WHERE id = $1`,
      [syncRunId],
    );
    expect(run.rows[0].checkpoint).toMatchObject({
      stage: "campaigns_email",
      cursor: "cursor-1",
      page: 1,
    });
    expect(run.rows[0].warning_count).toBe(1);
    await expect(
      repository.commitKlaviyoDimensionPage({
        scope,
        syncRunId,
        page: {
          objects: [marketingObject({ externalId: "campaign-9" })],
          trackingSettings: [],
          warnings: [],
          apiRevision: "2026-07-15",
        },
        expectedCheckpoint: null,
        nextCheckpoint: checkpoint1,
        now: new Date(),
      }),
    ).rejects.toThrow("checkpoint moved");
    const missing = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_marketing_object
        WHERE external_id = 'campaign-9'`,
    );
    expect(missing.rows[0].count).toBe(0);
  });

  it("rejects parents outside the connection and preserves prior data on failure", async () => {
    const syncRunId = await startRun();
    await testPool!.query(
      `INSERT INTO klaviyo_marketing_object
         (id, organization_id, shopify_store_id, connection_id, object_type,
          external_id, name, tracking_projection, source_checksum, api_revision)
       VALUES ('foreign-campaign', 'org-b', 'store-b', 'connection-b',
         'campaign', 'campaign-foreign', 'Foreign', '{}', 'checksum',
         '2026-07-15')`,
    );
    await repository.commitKlaviyoDimensionPage({
      scope,
      syncRunId,
      page: {
        objects: [marketingObject()],
        trackingSettings: [],
        warnings: [],
        apiRevision: "2026-07-15",
      },
      expectedCheckpoint: null,
      nextCheckpoint: checkpoint1,
      now: new Date(),
    });
    await expect(
      repository.commitKlaviyoDimensionPage({
        scope,
        syncRunId,
        page: {
          objects: [
            marketingObject({
              objectType: "campaign_message",
              externalId: "message-x",
              parentExternalId: "campaign-foreign",
              parentObjectType: "campaign",
            }),
          ],
          trackingSettings: [],
          warnings: [],
          apiRevision: "2026-07-15",
        },
        expectedCheckpoint: checkpoint1,
        nextCheckpoint: { ...checkpoint1, page: 2 },
        now: new Date(),
      }),
    ).rejects.toThrow("outside this connection");
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId,
      operation: "dimensions",
      status: "failed",
      error: new Error("traversal failed"),
    });
    const survivors = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_marketing_object
        WHERE connection_id = 'connection-a'`,
    );
    expect(survivors.rows[0].count).toBe(1);
  });

  it("reuses a live identical run and reaps an expired lease before replacement", async () => {
    const first = await repository.startOrResumeDimensionSync({
      scope,
      triggerType: "manual",
      now: new Date(),
    });
    const second = await repository.startOrResumeDimensionSync({
      scope,
      triggerType: "manual",
      now: new Date(),
    });
    expect(second).toEqual({ syncRunId: first.syncRunId, reused: true });
    await testPool!.query(
      `UPDATE klaviyo_sync_run
          SET heartbeat_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [first.syncRunId],
    );
    const third = await repository.startOrResumeDimensionSync({
      scope,
      triggerType: "manual",
      now: new Date(),
    });
    expect(third.reused).toBe(false);
    expect(third.syncRunId).not.toBe(first.syncRunId);
    const reaped = await testPool!.query(
      `SELECT status, error_code FROM klaviyo_sync_run WHERE id = $1`,
      [first.syncRunId],
    );
    expect(reaped.rows[0].status).toBe("failed");
    expect(reaped.rows[0].error_code).toBeTruthy();
  });

  it("finishes each widened operation exactly once through the scoped finalizer", async () => {
    const syncRunId = await startRun();
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId,
      operation: "dimensions",
      status: "success",
    });
    await expect(
      store.finishKlaviyoSyncRun({
        scope,
        syncRunId,
        operation: "dimensions",
        status: "success",
      }),
    ).rejects.toThrow("not active");
    await expect(
      store.finishKlaviyoSyncRun({
        scope,
        syncRunId: "missing-run",
        operation: "reports",
        status: "success",
      }),
    ).rejects.toThrow("not active");
  });

  it("runs a bounded full traversal to success with parents and tracking", async () => {
    const syncRunId = await startRun();
    const client = fakeDimensionClient();
    const result = await repository.processDimensionBatch(
      { scope, syncRunId },
      {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
      },
    );
    expect(result.done).toBe(true);
    const run = await testPool!.query(
      `SELECT status, checkpoint FROM klaviyo_sync_run WHERE id = $1`,
      [syncRunId],
    );
    expect(run.rows[0]).toMatchObject({ status: "success", checkpoint: null });
    const objects = await testPool!.query(
      `SELECT object_type, external_id, parent_id
         FROM klaviyo_marketing_object
        WHERE connection_id = 'connection-a'
        ORDER BY object_type, external_id`,
    );
    const types = objects.rows.map(
      (row: { object_type: string }) => row.object_type,
    );
    expect(types).toEqual(
      expect.arrayContaining(["campaign", "campaign_message", "flow", "flow_message"]),
    );
    const message = objects.rows.find(
      (row: { object_type: string }) => row.object_type === "campaign_message",
    );
    expect(message.parent_id).not.toBeNull();
    const tracking = await testPool!.query(
      `SELECT scope, parameter_name FROM klaviyo_tracking_setting
        WHERE connection_id = 'connection-a'`,
    );
    expect(tracking.rows).toEqual([
      { scope: "account", parameter_name: "utm_source" },
    ]);
  });

  it("stops at the request budget with a durable resumable checkpoint", async () => {
    const syncRunId = await startRun();
    const client = fakeDimensionClient();
    const first = await repository.processDimensionBatch(
      { scope, syncRunId, maxRequests: 2 },
      {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
      },
    );
    expect(first.done).toBe(false);
    if (first.done) throw new Error("unreachable");
    expect(first.checkpoint.operation).toBe("dimensions");
    const persisted = await testPool!.query(
      `SELECT checkpoint FROM klaviyo_sync_run WHERE id = $1`,
      [syncRunId],
    );
    expect(persisted.rows[0].checkpoint).toMatchObject({
      stage: first.checkpoint.stage,
    });
    const resumed = await repository.processDimensionBatch(
      { scope, syncRunId, maxRequests: 50 },
      {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
      },
    );
    expect(resumed.done).toBe(true);
    const campaigns = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_marketing_object
        WHERE connection_id = 'connection-a' AND object_type = 'campaign'`,
    );
    expect(campaigns.rows[0].count).toBe(1);
  });

  it("replays against an already-terminal run without touching data", async () => {
    const syncRunId = await startRun();
    await store.finishKlaviyoSyncRun({
      scope,
      syncRunId,
      operation: "dimensions",
      status: "success",
    });
    await expect(
      repository.processDimensionBatch(
        { scope, syncRunId },
        {
          createClient: () => fakeDimensionClient(),
          credentialProvider: fakeCredentialProvider,
        },
      ),
    ).rejects.toThrow("not active");
  });
});

describe("klaviyo-dimensions trigger source boundary", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "trigger/klaviyo-dimensions.ts"),
    "utf8",
  );

  it("exports the task with the dedicated single-concurrency queue", () => {
    expect(source).toContain("export const klaviyoDimensionsTask");
    expect(source).toContain('name: "klaviyo-dimensions"');
    expect(source).toContain("concurrencyLimit: 1");
    expect(source).toContain("maxDuration: 600");
  });

  it("schedules exactly one checkpoint-keyed global continuation", () => {
    expect(source).toContain(
      "`klaviyo:dimensions:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`",
    );
    expect(source).toContain('{ scope: "global" }');
    expect(source).toContain('idempotencyKeyTTL: "7d"');
    expect(source.match(/tasks\.trigger/g)).toHaveLength(1);
  });

  it("finalizes exhausted retries through the fixed-code dimension finalizer", () => {
    expect(source).toContain("failKlaviyoSyncRunAfterRetryExhaustion");
    expect(source).toContain('operation: "dimensions"');
    expect(source).not.toMatch(/console\.log/);
  });
});
