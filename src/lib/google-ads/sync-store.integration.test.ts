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
import type { GoogleAdsCredentialProvider } from "@/lib/google-ads/credential-provider";
import type { NormalizedCampaignFact } from "@/lib/google-ads/facts";
import type { ConnectionRecord } from "@/lib/google-ads/sync-store";
import {
  createTestDatabaseHandle,
  reloadGoogleAdsConnection,
  seedOrgAndStore,
  setupTestDatabase,
  teardownTestDatabase,
} from "@/lib/google-ads/test-support/pg-harness";

const TEST_DATABASE = "adsolute_google_ads_sync_store_test";
const { baseConnectionString, testPool, testDb } =
  createTestDatabaseHandle(TEST_DATABASE);

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const store = await import("@/lib/google-ads/sync-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const SEEDED_SHOP_DOMAIN = "reviv-google-test.myshopify.com";
const SEEDED_SHOP_DOMAIN_B = "reviv-google-test-b.myshopify.com";

function fakeProvider(shopDomain: string): GoogleAdsCredentialProvider {
  return {
    getPilotBinding: async () => ({
      customerId: "1234567890",
      loginCustomerId: "0987654321",
      shopDomain,
    }),
    getPilotShopDomain: async () => shopDomain,
    resolve: async () => {
      throw new Error("not needed");
    },
  };
}

function connectionScopeOf(connection: ConnectionRecord) {
  return store.connectionScope(connection);
}

async function reloadConnection(id: string): Promise<ConnectionRecord> {
  return reloadGoogleAdsConnection(testPool!, id) as Promise<ConnectionRecord>;
}

function fact(
  overrides: Partial<NormalizedCampaignFact> = {},
): NormalizedCampaignFact {
  return {
    campaignId: "222",
    campaignName: "Brand Search",
    campaignStatus: "ENABLED",
    channelType: "SEARCH",
    factDate: "2026-08-01",
    costMicros: 1_000_000,
    impressions: 100,
    clicks: 10,
    conversions: "1",
    conversionsValue: "100",
    ...overrides,
  };
}

describeIfDb("Google Ads sync store on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = await setupTestDatabase({
      baseConnectionString: baseConnectionString!,
      testPool: testPool!,
      database: TEST_DATABASE,
    });
  }, 120_000);

  afterAll(async () => {
    await teardownTestDatabase({ adminPool, testPool, database: TEST_DATABASE });
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE google_ads_campaign_fact, google_ads_sync_run, google_ads_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedOrgAndStore(testPool!, { shopDomain: SEEDED_SHOP_DOMAIN });
  });

  it("bootstraps one pending connection idempotently", async () => {
    const first = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const second = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    expect(second.id).toBe(first.id);
    expect(first.status).toBe("pending");
    const rows = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_connection`,
    );
    expect(rows.rows[0].count).toBe(1);
  });

  it("throws when the shop domain has no store", async () => {
    await expect(
      store.ensurePilotGoogleAdsConnection(
        fakeProvider("unknown.myshopify.com"),
      ),
    ).rejects.toThrow(/no Shopify store/);
  });

  it("commits a facts chunk atomically and restates on re-upsert", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const scope = connectionScopeOf(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    await store.commitCampaignFactsChunk({
      scope,
      syncRunId: run.id,
      facts: [fact({ conversionsValue: "100" })],
      checkpointDay: "2026-08-01",
      rowsRead: 1,
      failureCount: 0,
      apiVersion: "v21",
      currencyCode: "USD",
    });
    await store.commitCampaignFactsChunk({
      scope,
      syncRunId: run.id,
      facts: [fact({ conversionsValue: "150" })],
      checkpointDay: "2026-08-01",
      rowsRead: 1,
      failureCount: 1,
      apiVersion: "v21",
      currencyCode: "USD",
    });
    const facts = await testPool!.query(
      `SELECT conversions_value AS "conversionsValue" FROM google_ads_campaign_fact
        WHERE connection_id = $1`,
      [connection.id],
    );
    expect(facts.rows).toEqual([{ conversionsValue: "150" }]);
    const runRow = await testPool!.query(
      `SELECT checkpoint_day::text AS "checkpointDay", rows_read AS "rowsRead",
              rows_upserted AS "rowsUpserted", failure_count AS "failureCount"
         FROM google_ads_sync_run WHERE id = $1`,
      [run.id],
    );
    expect(runRow.rows[0].checkpointDay).toBe("2026-08-01");
    expect(runRow.rows[0].rowsRead).toBe(2);
    expect(runRow.rows[0].rowsUpserted).toBe(2);
    expect(runRow.rows[0].failureCount).toBe(1);
  });

  it("rejects a chunk commit against a non-running run and writes no fact rows", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const scope = connectionScopeOf(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    await store.failGoogleAdsSyncRun({
      scope,
      syncRunId: run.id,
      operation: "facts",
      error: { code: "TIMEOUT", message: "request timed out" },
    });
    await expect(
      store.commitCampaignFactsChunk({
        scope,
        syncRunId: run.id,
        facts: [fact()],
        checkpointDay: "2026-08-01",
        rowsRead: 1,
        failureCount: 0,
        apiVersion: "v21",
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/checkpoint raced/);
    const facts = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_campaign_fact WHERE connection_id = $1`,
      [connection.id],
    );
    expect(facts.rows[0].count).toBe(0);
  });

  it("stamps backfillCompletedAt only on the first completed facts run", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const scope = connectionScopeOf(connection);
    const firstRun = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    await store.completeGoogleAdsSyncRun({
      scope,
      syncRunId: firstRun.id,
      operation: "facts",
    });
    const afterFirst = await reloadConnection(connection.id);
    expect(afterFirst.backfillCompletedAt).not.toBeNull();
    const stampAfterFirst = afterFirst.backfillCompletedAt;

    const secondRun = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-15",
      windowToDay: "2026-08-21",
      apiVersion: "v21",
    });
    await store.completeGoogleAdsSyncRun({
      scope,
      syncRunId: secondRun.id,
      operation: "facts",
    });
    const afterSecond = await reloadConnection(connection.id);
    expect(afterSecond.backfillCompletedAt?.getTime()).toBe(
      stampAfterFirst?.getTime(),
    );
  });

  it("marks a run failed with the sanitized error only", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const scope = connectionScopeOf(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    await store.failGoogleAdsSyncRun({
      scope,
      syncRunId: run.id,
      operation: "facts",
      error: { code: "TIMEOUT", message: "request timed out" },
    });
    const { run: reloaded } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.errorCode).toBe("TIMEOUT");
    expect(reloaded.errorMessage).toBe("request timed out");
  });

  it("rejects completing an already-failed run and does not stamp backfillCompletedAt", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const scope = connectionScopeOf(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    await store.failGoogleAdsSyncRun({
      scope,
      syncRunId: run.id,
      operation: "facts",
      error: { code: "TIMEOUT", message: "request timed out" },
    });
    await expect(
      store.completeGoogleAdsSyncRun({
        scope,
        syncRunId: run.id,
        operation: "facts",
      }),
    ).rejects.toThrow(/completion raced/);
    const reloaded = await reloadConnection(connection.id);
    expect(reloaded.backfillCompletedAt).toBeNull();
  });

  it("rejects resolving an unknown sync run", async () => {
    await expect(
      store.resolveGoogleAdsSyncRun("missing-run-id"),
    ).rejects.toThrow(/does not exist/);
  });

  it("scopes bootstrap to the resolved store, not just the organization", async () => {
    await testPool!.query(
      `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone) VALUES
         ('store-b', 'org-a', '${SEEDED_SHOP_DOMAIN_B}', 'America/New_York')`,
    );
    const connectionA = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const connectionB = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN_B),
    );
    expect(connectionB.id).not.toBe(connectionA.id);
    expect(connectionA.storeId).toBe("store-a");
    expect(connectionB.storeId).toBe("store-b");
    const rows = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_connection WHERE organization_id = 'org-a'`,
    );
    expect(rows.rows[0].count).toBe(2);
  });

  it("one running facts run per connection", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(
      fakeProvider(SEEDED_SHOP_DOMAIN),
    );
    const scope = connectionScopeOf(connection);
    const first = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    await expect(
      store.createGoogleAdsSyncRun({
        scope,
        operation: "facts",
        windowFromDay: "2026-08-15",
        windowToDay: "2026-08-21",
        apiVersion: "v21",
      }),
    ).rejects.toThrow();
    await store.completeGoogleAdsSyncRun({
      scope,
      syncRunId: first.id,
      operation: "facts",
    });
    const second = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-08-15",
      windowToDay: "2026-08-21",
      apiVersion: "v21",
    });
    expect(second.id).not.toBe(first.id);
  });
});
