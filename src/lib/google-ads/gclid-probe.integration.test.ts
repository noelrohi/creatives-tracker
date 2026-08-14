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
import { addDays } from "@/lib/google-ads/facts";
import {
  createTestDatabaseHandle,
  FIXTURE_DDL,
  seedOrgAndStore,
  setupTestDatabase,
  teardownTestDatabase,
} from "@/lib/google-ads/test-support/pg-harness";

/**
 * Minimal hand-rolled shopify_order fixture (not generated from a
 * migration, same idiom as the organization/shopify_store tables in
 * FIXTURE_DDL) carrying only the columns gclid-probe.ts reads or which are
 * NOT NULL on the real table (net_sales, order_created_at, order_day,
 * shopify_order_id).
 */
const SHOPIFY_ORDER_DDL = `CREATE TABLE shopify_order (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     shopify_order_id text NOT NULL, order_created_at timestamp NOT NULL,
     order_day date NOT NULL, net_sales numeric NOT NULL,
     customer_journey jsonb, bucket text,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_order_store_order_uniq UNIQUE (store_id, shopify_order_id)
   )`;

const TEST_DATABASE = "adsolute_google_ads_gclid_probe_test";
const { baseConnectionString, testPool, testDb } =
  createTestDatabaseHandle(TEST_DATABASE);

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const probe = await import("@/lib/google-ads/gclid-probe");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const SEEDED_SHOP_DOMAIN = "reviv-google-gclid-probe-test.myshopify.com";
const FIXED_NOW = new Date("2026-08-14T12:00:00.000Z");
const TO_DAY = "2026-08-14";
const FROM_DAY = addDays(TO_DAY, -89);

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

function journey(landingPage: string): Record<string, unknown> {
  return { ready: true, lastVisit: { landingPage, referrerUrl: null } };
}

async function seedOrder(params: {
  id: string;
  shopifyOrderId: string;
  orderDay: string;
  bucket: string | null;
  customerJourney: Record<string, unknown> | null;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales, customer_journey, bucket)
     VALUES ($1, 'org-a', 'store-a', $2, $3::date, $3::date, 100, $4, $5)`,
    [
      params.id,
      params.shopifyOrderId,
      params.orderDay,
      params.customerJourney ? JSON.stringify(params.customerJourney) : null,
      params.bucket,
    ],
  );
}

async function seedFiveOrders(): Promise<void> {
  await seedOrder({
    id: "order-1",
    shopifyOrderId: "1001",
    orderDay: TO_DAY,
    bucket: "google",
    customerJourney: journey(
      "https://shop.example.com/?gclid=abc123&utm_source=google",
    ),
  });
  await seedOrder({
    id: "order-2",
    shopifyOrderId: "1002",
    orderDay: TO_DAY,
    bucket: "google",
    customerJourney: journey("https://shop.example.com/"),
  });
  await seedOrder({
    id: "order-3",
    shopifyOrderId: "1003",
    orderDay: TO_DAY,
    // "organic_direct" is the real attribution_bucket enum member (there is
    // no plain "organic" value) — assert a key that can actually occur.
    bucket: "organic_direct",
    customerJourney: journey("https://shop.example.com/?wbraid=w1&gbraid=g1"),
  });
  await seedOrder({
    id: "order-4",
    shopifyOrderId: "1004",
    orderDay: TO_DAY,
    bucket: null,
    customerJourney: null,
  });
  // Outside the 90-day window — must never be counted.
  await seedOrder({
    id: "order-5",
    shopifyOrderId: "1005",
    orderDay: addDays(FROM_DAY, -1),
    bucket: "google",
    customerJourney: journey("https://shop.example.com/?gclid=old999"),
  });
}

async function reloadProbeReport(id: string): Promise<Record<string, unknown>> {
  const result = await testPool!.query(
    `SELECT id, organization_id AS "organizationId", shopify_store_id AS "storeId",
            window_from_day::text AS "windowFromDay", window_to_day::text AS "windowToDay",
            status, orders_scanned AS "ordersScanned", summary, checksum,
            error_code AS "errorCode", error_message AS "errorMessage"
       FROM gclid_probe_report WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) throw new Error(`probe report ${id} not found`);
  return result.rows[0];
}

describeIfDb("gclid probe on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = await setupTestDatabase({
      baseConnectionString: baseConnectionString!,
      testPool: testPool!,
      database: TEST_DATABASE,
      ddlStatements: [...FIXTURE_DDL, SHOPIFY_ORDER_DDL],
    });
  }, 120_000);

  afterAll(async () => {
    await teardownTestDatabase({ adminPool, testPool, database: TEST_DATABASE });
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE gclid_probe_report, shopify_order, shopify_store, organization
         RESTART IDENTITY CASCADE`,
    );
    await seedOrgAndStore(testPool!, { shopDomain: SEEDED_SHOP_DOMAIN });
  });

  it("tallies the bucket matrix and publishes an immutable summary", async () => {
    await seedFiveOrders();

    const report = await probe.prepareGclidProbeRun(
      fakeProvider(SEEDED_SHOP_DOMAIN),
      FIXED_NOW,
    );
    const summary = await probe.runGclidProbe({ probeReportId: report.id });

    expect(summary.ordersScanned).toBe(4);
    expect(summary.ordersWithAnyClickId).toBe(2);
    expect(summary.byKind).toEqual({ gclid: 1, wbraid: 1, gbraid: 1 });
    expect(summary.byBucket).toEqual({
      google: { orders: 2, withClickId: 1 },
      organic_direct: { orders: 1, withClickId: 1 },
      pending: { orders: 1, withClickId: 0 },
    });
    expect(summary.journeyMissing).toBe(1);
    expect(summary.multiKindOrders).toBe(1);

    const gclidFingerprint = summary.paramKeyFingerprints.find(
      (entry) => entry.key === "gclid",
    );
    const utmSourceFingerprint = summary.paramKeyFingerprints.find(
      (entry) => entry.key === "utm_source",
    );
    expect(gclidFingerprint).toEqual({ key: "gclid", hashed: false, count: 1 });
    expect(utmSourceFingerprint).toEqual({
      key: "utm_source",
      hashed: false,
      count: 1,
    });

    const persisted = await reloadProbeReport(report.id);
    expect(persisted.status).toBe("completed");
    expect(persisted.ordersScanned).toBe(4);
    expect(persisted.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted.summary)).not.toContain("abc123");
  });

  it("marks a report failed with a sanitized reason", async () => {
    const report = await probe.prepareGclidProbeRun(
      fakeProvider(SEEDED_SHOP_DOMAIN),
      FIXED_NOW,
    );
    await probe.failGclidProbeReport({
      probeReportId: report.id,
      code: "internal_error",
      message: "gclid probe failed unexpectedly",
    });

    const persisted = await reloadProbeReport(report.id);
    expect(persisted.status).toBe("failed");
    expect(persisted.summary).toBeNull();
    expect(persisted.errorCode).toBe("internal_error");
  });

  it("refuses to run a non-running report", async () => {
    const report = await probe.prepareGclidProbeRun(
      fakeProvider(SEEDED_SHOP_DOMAIN),
      FIXED_NOW,
    );
    await probe.runGclidProbe({ probeReportId: report.id });

    await expect(
      probe.runGclidProbe({ probeReportId: report.id }),
    ).rejects.toThrow(/not running/);
  });

  it("prepare rejects when the domain has no store", async () => {
    await expect(
      probe.prepareGclidProbeRun(fakeProvider("unknown.myshopify.com"), FIXED_NOW),
    ).rejects.toThrow(/no Shopify store/);
  });

  it("hashes an unrecognized param key and never persists it literally", async () => {
    await seedOrder({
      id: "order-secret",
      shopifyOrderId: "2001",
      orderDay: TO_DAY,
      bucket: "google",
      customerJourney: journey(
        "https://shop.example.com/?secret_key=x&gclid=y",
      ),
    });

    const report = await probe.prepareGclidProbeRun(
      fakeProvider(SEEDED_SHOP_DOMAIN),
      FIXED_NOW,
    );
    const summary = await probe.runGclidProbe({ probeReportId: report.id });

    const hashedEntry = summary.paramKeyFingerprints.find((entry) => entry.hashed);
    expect(hashedEntry).toBeDefined();
    expect(hashedEntry!.key).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(hashedEntry!.count).toBe(1);

    const persisted = await reloadProbeReport(report.id);
    expect(JSON.stringify(persisted.summary)).not.toContain("secret_key");
  });

  it("failGclidProbeReport on an already-completed report is a no-op", async () => {
    const report = await probe.prepareGclidProbeRun(
      fakeProvider(SEEDED_SHOP_DOMAIN),
      FIXED_NOW,
    );
    await probe.runGclidProbe({ probeReportId: report.id });

    await probe.failGclidProbeReport({
      probeReportId: report.id,
      code: "internal_error",
      message: "should not apply",
    });

    const persisted = await reloadProbeReport(report.id);
    expect(persisted.status).toBe("completed");
    expect(persisted.errorCode).toBeNull();
  });
});
