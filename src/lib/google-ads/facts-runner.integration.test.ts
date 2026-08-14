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
  GoogleAdsCredentialProvider,
  GoogleAdsCredentialRequest,
  ResolvedGoogleAdsCredential,
} from "@/lib/google-ads/credential-provider";
import type { GoogleAdsClient, GoogleAdsSearchPage } from "@/lib/google-ads/client";
import type { ConnectionRecord } from "@/lib/google-ads/sync-store";

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
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_store_org_id_uniq UNIQUE (organization_id, id)
   )`,
];

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_google_ads_facts_runner_test";
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
  const result = await testPool!.query(
    `SELECT id, organization_id AS "organizationId", shopify_store_id AS "storeId",
            google_customer_id AS "googleCustomerId",
            descriptive_name AS "descriptiveName", currency_code AS "currencyCode",
            timezone, status, authentication_mode AS "authenticationMode",
            credential_reference AS "credentialReference",
            last_discovery_synced_at AS "lastDiscoverySyncedAt",
            last_facts_synced_at AS "lastFactsSyncedAt",
            backfill_completed_at AS "backfillCompletedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM google_ads_connection WHERE id = $1`,
    [id],
  );
  return result.rows[0] as ConnectionRecord;
}

async function reloadConnection(id: string): Promise<ConnectionRecord> {
  const result = await testPool!.query(
    `SELECT id, organization_id AS "organizationId", shopify_store_id AS "storeId",
            google_customer_id AS "googleCustomerId",
            descriptive_name AS "descriptiveName", currency_code AS "currencyCode",
            timezone, status, authentication_mode AS "authenticationMode",
            credential_reference AS "credentialReference",
            last_discovery_synced_at AS "lastDiscoverySyncedAt",
            last_facts_synced_at AS "lastFactsSyncedAt",
            backfill_completed_at AS "backfillCompletedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM google_ads_connection WHERE id = $1`,
    [id],
  );
  return result.rows[0] as ConnectionRecord;
}

describeIfDb("Google Ads facts runner on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    adminPool.on("error", () => {});
    testPool?.on("error", () => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    for (const statement of FIXTURE_DDL) await testPool!.query(statement);
    for (const migration of ["0060_serious_mimic.sql"]) {
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
      `TRUNCATE google_ads_campaign_fact, google_ads_sync_run, google_ads_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await testPool!.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES
         ('org-a', 'Org A', 'org-a', now())`,
    );
    await testPool!.query(
      `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone) VALUES
         ('store-a', 'org-a', '${SEEDED_SHOP_DOMAIN}', 'America/New_York')`,
    );
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
