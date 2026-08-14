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

const TEST_DATABASE = "adsolute_google_ads_discovery_test";
const { baseConnectionString, testPool, testDb } =
  createTestDatabaseHandle(TEST_DATABASE);

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const store = await import("@/lib/google-ads/sync-store");
const { runGoogleAdsDiscovery } = await import("@/lib/google-ads/discovery");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const SEEDED_SHOP_DOMAIN = "reviv-google-discovery-test.myshopify.com";

const CREDENTIAL: ResolvedGoogleAdsCredential = {
  developerToken: "dev-token",
  oauthClientId: "client-id",
  oauthClientSecret: "client-secret",
  refreshToken: "refresh-token",
  customerId: "1234567890",
  loginCustomerId: "0987654321",
  reference: "reviv_environment",
};

function fakeProvider(): GoogleAdsCredentialProvider {
  return {
    getPilotBinding: async () => ({
      customerId: CREDENTIAL.customerId,
      loginCustomerId: CREDENTIAL.loginCustomerId,
      shopDomain: SEEDED_SHOP_DOMAIN,
    }),
    resolve: async () => CREDENTIAL,
  };
}

function fakeClientFactory(
  page: GoogleAdsSearchPage,
): (credential: ResolvedGoogleAdsCredential) => Pick<GoogleAdsClient, "search"> {
  return () => ({
    search: async () => page,
  });
}

async function reloadConnection(id: string): Promise<ConnectionRecord> {
  return reloadGoogleAdsConnection(testPool!, id) as Promise<ConnectionRecord>;
}

describeIfDb("Google Ads discovery on PostgreSQL", () => {
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

  it("marks the connection ready on a matching non-manager customer", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(fakeProvider());
    const scope = store.connectionScope(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "discovery",
      apiVersion: "v21",
    });

    const result = await runGoogleAdsDiscovery({
      syncRunId: run.id,
      provider: fakeProvider(),
      clientFactory: fakeClientFactory({
        results: [
          {
            customer: {
              id: CREDENTIAL.customerId,
              descriptiveName: "Reviv Ads",
              currencyCode: "USD",
              timeZone: "America/New_York",
              manager: false,
            },
          },
        ],
        nextPageToken: null,
        apiVersion: "v21",
      }),
    });

    expect(result).toEqual({ status: "ready" });

    const { run: reloadedRun } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloadedRun.status).toBe("completed");

    const reloadedConnection = await reloadConnection(connection.id);
    expect(reloadedConnection.status).toBe("ready");
    expect(reloadedConnection.googleCustomerId).toBe(CREDENTIAL.customerId);
    expect(reloadedConnection.currencyCode).toBe("USD");
    expect(reloadedConnection.timezone).toBe("America/New_York");
    expect(reloadedConnection.lastDiscoverySyncedAt).not.toBeNull();
  });

  it("degrades the connection on a manager account and leaves identity fields null", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(fakeProvider());
    const scope = store.connectionScope(connection);
    const run = await store.createGoogleAdsSyncRun({
      scope,
      operation: "discovery",
      apiVersion: "v21",
    });

    const result = await runGoogleAdsDiscovery({
      syncRunId: run.id,
      provider: fakeProvider(),
      clientFactory: fakeClientFactory({
        results: [
          {
            customer: {
              id: CREDENTIAL.customerId,
              descriptiveName: "Reviv Ads",
              currencyCode: "USD",
              timeZone: "America/New_York",
              manager: true,
            },
          },
        ],
        nextPageToken: null,
        apiVersion: "v21",
      }),
    });

    expect(result).toEqual({ status: "degraded", code: "manager_account" });

    const { run: reloadedRun } = await store.resolveGoogleAdsSyncRun(run.id);
    expect(reloadedRun.status).toBe("failed");
    expect(reloadedRun.errorCode).toBe("manager_account");

    const reloadedConnection = await reloadConnection(connection.id);
    expect(reloadedConnection.status).toBe("degraded");
    expect(reloadedConnection.googleCustomerId).toBeNull();
    expect(reloadedConnection.currencyCode).toBeNull();
    expect(reloadedConnection.timezone).toBeNull();
  });

  it("degrades on a currency change and preserves the previously recorded currency", async () => {
    const connection = await store.ensurePilotGoogleAdsConnection(fakeProvider());
    const scope = store.connectionScope(connection);
    const firstRun = await store.createGoogleAdsSyncRun({
      scope,
      operation: "discovery",
      apiVersion: "v21",
    });
    const firstResult = await runGoogleAdsDiscovery({
      syncRunId: firstRun.id,
      provider: fakeProvider(),
      clientFactory: fakeClientFactory({
        results: [
          {
            customer: {
              id: CREDENTIAL.customerId,
              descriptiveName: "Reviv Ads",
              currencyCode: "USD",
              timeZone: "America/New_York",
              manager: false,
            },
          },
        ],
        nextPageToken: null,
        apiVersion: "v21",
      }),
    });
    expect(firstResult).toEqual({ status: "ready" });

    const secondRun = await store.createGoogleAdsSyncRun({
      scope,
      operation: "discovery",
      apiVersion: "v21",
    });
    const secondResult = await runGoogleAdsDiscovery({
      syncRunId: secondRun.id,
      provider: fakeProvider(),
      clientFactory: fakeClientFactory({
        results: [
          {
            customer: {
              id: CREDENTIAL.customerId,
              descriptiveName: "Reviv Ads",
              currencyCode: "EUR",
              timeZone: "America/New_York",
              manager: false,
            },
          },
        ],
        nextPageToken: null,
        apiVersion: "v21",
      }),
    });

    expect(secondResult).toEqual({ status: "degraded", code: "currency_changed" });

    const { run: reloadedSecondRun } = await store.resolveGoogleAdsSyncRun(
      secondRun.id,
    );
    expect(reloadedSecondRun.status).toBe("failed");
    expect(reloadedSecondRun.errorCode).toBe("currency_changed");

    const reloadedConnection = await reloadConnection(connection.id);
    expect(reloadedConnection.status).toBe("degraded");
    expect(reloadedConnection.currencyCode).toBe("USD");
  });
});
