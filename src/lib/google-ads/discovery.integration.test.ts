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
const TEST_DATABASE = "adsolute_google_ads_discovery_test";
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
  if (result.rows.length === 0) {
    throw new Error(`connection ${id} not found`);
  }
  return result.rows[0] as ConnectionRecord;
}

describeIfDb("Google Ads discovery on PostgreSQL", () => {
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
});
