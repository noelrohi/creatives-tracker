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
  GoogleAdsCredentialProvider,
  GoogleAdsCredentialRequest,
  ResolvedGoogleAdsCredential,
} from "@/lib/google-ads/credential-provider";
import type { GoogleAdsClient, GoogleAdsSearchPage } from "@/lib/google-ads/client";
import type { ConnectionRecord } from "@/lib/google-ads/sync-store";
import {
  createTestDatabaseHandle,
  reloadGoogleAdsConnection,
  seedOrgAndStore,
  setupTestDatabase,
  teardownTestDatabase,
} from "@/lib/google-ads/test-support/pg-harness";

const TEST_DATABASE = "adsolute_google_ads_facts_runner_test";
const { baseConnectionString, testPool, testDb } =
  createTestDatabaseHandle(TEST_DATABASE);

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const store = await import("@/lib/google-ads/sync-store");
const { processGoogleAdsFactsBatch } = await import(
  "@/lib/google-ads/facts-runner"
);
const describeIfDb = baseConnectionString ? describe : describe.skip;

const SEEDED_SHOP_DOMAIN = "reviv-google-facts-runner-test.myshopify.com";
const SEEDED_CUSTOMER_ID = "1234567890";

const CREDENTIAL: ResolvedGoogleAdsCredential = {
  developerToken: "dev-token",
  oauthClientId: "client-id",
  oauthClientSecret: "client-secret",
  refreshToken: "refresh-token",
  customerId: SEEDED_CUSTOMER_ID,
  loginCustomerId: "0987654321",
  reference: "reviv_environment",
};

/** Records every resolve() request so tests can pin the persisted customer ID sent. */
function fakeProvider(
  calls: GoogleAdsCredentialRequest[],
): GoogleAdsCredentialProvider {
  return {
    getPilotBinding: async () => ({
      customerId: SEEDED_CUSTOMER_ID,
      loginCustomerId: CREDENTIAL.loginCustomerId,
      shopDomain: SEEDED_SHOP_DOMAIN,
    }),
    getPilotShopDomain: async () => SEEDED_SHOP_DOMAIN,
    resolve: async (request) => {
      calls.push(request);
      return CREDENTIAL;
    },
  };
}

/** Returns canned pages in order across however many search() calls a chunk makes. */
function queuedClientFactory(
  pages: GoogleAdsSearchPage[],
): (credential: ResolvedGoogleAdsCredential) => Pick<GoogleAdsClient, "search"> {
  let index = 0;
  return () => ({
    search: async () => {
      if (index >= pages.length) {
        throw new Error("queuedClientFactory ran out of canned pages");
      }
      const page = pages[index];
      index += 1;
      return page;
    },
  });
}

function factRow(overrides: {
  campaignId: string;
  factDate: string;
}): Record<string, unknown> {
  return {
    campaign: {
      id: overrides.campaignId,
      name: `Campaign ${overrides.campaignId}`,
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
    },
    segments: { date: overrides.factDate },
    metrics: {
      costMicros: "1000000",
      impressions: "100",
      clicks: "10",
      conversions: "1",
      conversionsValue: "50",
    },
  };
}

async function insertReadyConnection(
  organizationId: string,
  storeId: string,
): Promise<ConnectionRecord> {
  const id = crypto.randomUUID();
  await testPool!.query(
    `INSERT INTO google_ads_connection
       (id, organization_id, shopify_store_id, google_customer_id, descriptive_name,
        currency_code, timezone, status)
     VALUES ($1, $2, $3, $4, 'Reviv Ads', 'USD', 'America/New_York', 'ready')`,
    [id, organizationId, storeId, SEEDED_CUSTOMER_ID],
  );
  return reloadGoogleAdsConnection(testPool!, id) as Promise<ConnectionRecord>;
}

async function reloadConnection(id: string): Promise<ConnectionRecord> {
  return reloadGoogleAdsConnection(testPool!, id) as Promise<ConnectionRecord>;
}

describeIfDb("Google Ads facts runner on PostgreSQL", () => {
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

  it("processes a two-page chunk, persists rows with the connection currency, and pins the resolve request (a, d)", async () => {
    const connection = await insertReadyConnection("org-a", "store-a");
    const scope = store.connectionScope(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-05-01",
      windowToDay: "2026-05-20",
      apiVersion: "v21",
    });

    const calls: GoogleAdsCredentialRequest[] = [];
    const result = await processGoogleAdsFactsBatch({
      syncRunId: run.id,
      provider: fakeProvider(calls),
      clientFactory: queuedClientFactory([
        {
          results: [
            factRow({ campaignId: "1", factDate: "2026-05-01" }),
            factRow({ campaignId: "2", factDate: "2026-05-01" }),
          ],
          nextPageToken: "p2",
          apiVersion: "v21",
        },
        {
          results: [factRow({ campaignId: "3", factDate: "2026-05-02" })],
          nextPageToken: null,
          apiVersion: "v21",
        },
      ]),
    });

    // Window is 20 days, longer than the 14-day chunk cap, so this first
    // invocation must not finish the run.
    expect(result).toEqual({
      done: false,
      chunk: { fromDay: "2026-05-01", toDay: "2026-05-14", done: false },
      rowsRead: 3,
    });

    const { run: reloadedRun } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloadedRun.status).toBe("running");
    expect(reloadedRun.checkpointDay).toBe("2026-05-14");
    expect(reloadedRun.rowsRead).toBe(3);
    expect(reloadedRun.rowsUpserted).toBe(3);

    const facts = await testPool!.query(
      `SELECT campaign_id AS "campaignId", currency_code AS "currencyCode"
         FROM google_ads_campaign_fact WHERE connection_id = $1
        ORDER BY campaign_id`,
      [connection.id],
    );
    expect(facts.rows).toEqual([
      { campaignId: "1", currencyCode: "USD" },
      { campaignId: "2", currencyCode: "USD" },
      { campaignId: "3", currencyCode: "USD" },
    ]);

    // Pins fix 1: the fail-closed account binding must pass the
    // connection's persisted customer ID to resolve(), not null.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      credentialReference: "reviv_environment",
      persistedGoogleCustomerId: SEEDED_CUSTOMER_ID,
    });
  });

  it("resumes from the checkpoint on the second invocation and completes the run (b)", async () => {
    const connection = await insertReadyConnection("org-a", "store-a");
    const scope = store.connectionScope(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-05-01",
      windowToDay: "2026-05-20",
      apiVersion: "v21",
    });

    await processGoogleAdsFactsBatch({
      syncRunId: run.id,
      provider: fakeProvider([]),
      clientFactory: queuedClientFactory([
        { results: [], nextPageToken: null, apiVersion: "v21" },
      ]),
    });

    const second = await processGoogleAdsFactsBatch({
      syncRunId: run.id,
      provider: fakeProvider([]),
      clientFactory: queuedClientFactory([
        {
          results: [factRow({ campaignId: "9", factDate: "2026-05-15" })],
          nextPageToken: null,
          apiVersion: "v21",
        },
      ]),
    });

    expect(second).toEqual({
      done: true,
      chunk: { fromDay: "2026-05-15", toDay: "2026-05-20", done: true },
      rowsRead: 1,
    });

    const { run: reloadedRun } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloadedRun.status).toBe("completed");
    expect(reloadedRun.checkpointDay).toBe("2026-05-20");

    const reloadedConnection = await reloadConnection(connection.id);
    expect(reloadedConnection.lastFactsSyncedAt).not.toBeNull();
    expect(reloadedConnection.backfillCompletedAt).not.toBeNull();
  });

  it("re-entering a completed run is a no-op (c)", async () => {
    const connection = await insertReadyConnection("org-a", "store-a");
    const scope = store.connectionScope(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-05-01",
      windowToDay: "2026-05-01",
      apiVersion: "v21",
    });

    const first = await processGoogleAdsFactsBatch({
      syncRunId: run.id,
      provider: fakeProvider([]),
      clientFactory: queuedClientFactory([
        {
          results: [factRow({ campaignId: "5", factDate: "2026-05-01" })],
          nextPageToken: null,
          apiVersion: "v21",
        },
      ]),
    });
    expect(first.done).toBe(true);

    const countBefore = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_campaign_fact WHERE connection_id = $1`,
      [connection.id],
    );

    const second = await processGoogleAdsFactsBatch({
      syncRunId: run.id,
      provider: fakeProvider([]),
      clientFactory: queuedClientFactory([]),
    });
    expect(second).toEqual({ done: true, chunk: null, rowsRead: 0 });

    const countAfter = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_campaign_fact WHERE connection_id = $1`,
      [connection.id],
    );
    expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);
  });

  it("slices a single chunk of 4000 facts, which would exceed the bind-param ceiling unsliced (e)", async () => {
    const connection = await insertReadyConnection("org-a", "store-a");
    const scope = store.connectionScope(connection);
    // A single-day window keeps the whole chunk in one page while still
    // exercising the 500-row insert slicing inside commitCampaignFactsChunk.
    // 4000 rows x 17 params/row = 68,000 params, which wraps Postgres's
    // int16 bind-param count (65,535) if sent as one unsliced INSERT — so
    // this genuinely fails without the slicing fix, unlike a smaller count.
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-05-01",
      windowToDay: "2026-05-01",
      apiVersion: "v21",
    });

    const rows = Array.from({ length: 4000 }, (_, index) =>
      factRow({ campaignId: String(index + 1), factDate: "2026-05-01" }),
    );

    const result = await processGoogleAdsFactsBatch({
      syncRunId: run.id,
      provider: fakeProvider([]),
      clientFactory: queuedClientFactory([
        { results: rows, nextPageToken: null, apiVersion: "v21" },
      ]),
    });

    expect(result.done).toBe(true);
    expect(result.rowsRead).toBe(4000);

    const facts = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_campaign_fact WHERE connection_id = $1`,
      [connection.id],
    );
    expect(facts.rows[0].count).toBe(4000);

    const { run: reloadedRun } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloadedRun.rowsUpserted).toBe(4000);
    expect(reloadedRun.status).toBe("completed");
  });

  it("rejects a chunk that exceeds the page cap and leaves the run untouched", async () => {
    const connection = await insertReadyConnection("org-a", "store-a");
    const scope = store.connectionScope(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "facts",
      windowFromDay: "2026-05-01",
      windowToDay: "2026-05-14",
      apiVersion: "v21",
    });

    // 21 pages, each pointing to another page, so the do/while loop would
    // spin forever without the MAX_PAGES_PER_CHUNK guard.
    const pages: GoogleAdsSearchPage[] = Array.from({ length: 21 }, (_, index) => ({
      results: [factRow({ campaignId: String(index + 1), factDate: "2026-05-01" })],
      nextPageToken: `p${index + 2}`,
      apiVersion: "v21",
    }));

    await expect(
      processGoogleAdsFactsBatch({
        syncRunId: run.id,
        provider: fakeProvider([]),
        clientFactory: queuedClientFactory(pages),
      }),
    ).rejects.toThrow(/page cap/);

    const { run: reloadedRun } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloadedRun.status).toBe("running");
    expect(reloadedRun.checkpointDay).toBeNull();

    const facts = await testPool!.query(
      `SELECT count(*)::int AS count FROM google_ads_campaign_fact WHERE connection_id = $1`,
      [connection.id],
    );
    expect(facts.rows[0].count).toBe(0);
  });
});
