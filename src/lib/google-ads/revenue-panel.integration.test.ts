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
import {
  createTestDatabaseHandle,
  FIXTURE_DDL,
  seedOrgAndStore,
  setupTestDatabase,
  teardownTestDatabase,
} from "@/lib/google-ads/test-support/pg-harness";

/**
 * Minimal hand-rolled shopify_order/shopify_refund fixtures (not generated
 * from a migration, same idiom as gclid-probe.integration.test.ts), carrying
 * only the columns `getBucketTotals` and this module's split queries read,
 * or which are NOT NULL on the real tables.
 */
const SHOPIFY_ORDER_DDL = `CREATE TABLE shopify_order (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     shopify_order_id text NOT NULL, order_created_at timestamp NOT NULL,
     order_day date NOT NULL, net_sales numeric NOT NULL,
     last_click_utm_source text, last_click_utm_medium text,
     last_click_utm_campaign text, bucket text,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_order_store_order_uniq UNIQUE (store_id, shopify_order_id)
   )`;

const SHOPIFY_REFUND_DDL = `CREATE TABLE shopify_refund (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     order_id text NOT NULL, shopify_refund_id text NOT NULL,
     refund_day date NOT NULL, amount numeric NOT NULL,
     kind text DEFAULT 'refund' NOT NULL, refund_created_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_refund_store_refund_uniq UNIQUE (store_id, shopify_refund_id)
   )`;

const TEST_DATABASE = "adsolute_google_ads_revenue_panel_test";
const { baseConnectionString, testPool, testDb } =
  createTestDatabaseHandle(TEST_DATABASE);

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { loadGoogleAdsRevenuePanel } = await import(
  "@/lib/google-ads/revenue-panel"
);
const { getBucketTotals } = await import("@/lib/attribution-queries");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const SEEDED_SHOP_DOMAIN = "reviv-google-ads-revenue-panel-test.myshopify.com";
const ORG_ID = "org-a";
const STORE_ID = "store-a";
const RANGE_FROM = "2026-08-01";
const RANGE_TO = "2026-08-07";
const IN_RANGE_DAY = "2026-08-03";
const OUT_OF_RANGE_DAY = "2026-08-15";

async function seedOrder(params: {
  id: string;
  netSales: string;
  bucket: string;
  lastClickUtmMedium: string | null;
  lastClickUtmCampaign: string | null;
  orderDay?: string;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales, last_click_utm_medium, last_click_utm_campaign, bucket)
     VALUES ($1, $2, $3, $1, $4::date, $4::date, $5, $6, $7, $8)`,
    [
      params.id,
      ORG_ID,
      STORE_ID,
      params.orderDay ?? IN_RANGE_DAY,
      params.netSales,
      params.lastClickUtmMedium,
      params.lastClickUtmCampaign,
      params.bucket,
    ],
  );
}

async function seedRefund(params: {
  id: string;
  orderId: string;
  amount: string;
  refundDay?: string;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO shopify_refund
       (id, organization_id, store_id, order_id, shopify_refund_id, refund_day, amount)
     VALUES ($1, $2, $3, $4, $1, $5::date, $6)`,
    [
      params.id,
      ORG_ID,
      STORE_ID,
      params.orderId,
      params.refundDay ?? IN_RANGE_DAY,
      params.amount,
    ],
  );
}

async function seedConnection(params: {
  id: string;
  status?: string;
  currencyCode?: string | null;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO google_ads_connection
       (id, organization_id, shopify_store_id, currency_code, status,
        last_facts_synced_at, backfill_completed_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [
      params.id,
      ORG_ID,
      STORE_ID,
      params.currencyCode ?? "USD",
      params.status ?? "ready",
    ],
  );
}

async function seedCampaignFact(params: {
  id: string;
  connectionId: string;
  campaignId: string;
  campaignName: string;
  factDate: string;
  costMicros: number;
  conversions: string;
  conversionsValue: string;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO google_ads_campaign_fact
       (id, organization_id, shopify_store_id, connection_id, campaign_id,
        campaign_name, fact_date, cost_micros, impressions, clicks,
        conversions, conversions_value, api_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, 0, 0, $9, $10, 'v18')`,
    [
      params.id,
      ORG_ID,
      STORE_ID,
      params.connectionId,
      params.campaignId,
      params.campaignName,
      params.factDate,
      params.costMicros,
      params.conversions,
      params.conversionsValue,
    ],
  );
}

describeIfDb("google ads revenue panel on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = await setupTestDatabase({
      baseConnectionString: baseConnectionString!,
      testPool: testPool!,
      database: TEST_DATABASE,
      ddlStatements: [...FIXTURE_DDL, SHOPIFY_ORDER_DDL, SHOPIFY_REFUND_DDL],
    });
  }, 120_000);

  afterAll(async () => {
    await teardownTestDatabase({ adminPool, testPool, database: TEST_DATABASE });
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE google_ads_campaign_fact, google_ads_sync_run, google_ads_connection,
                shopify_refund, shopify_order, shopify_store, organization
         RESTART IDENTITY CASCADE`,
    );
    await seedOrgAndStore(testPool!, { shopDomain: SEEDED_SHOP_DOMAIN });
  });

  async function seedGoogleBucketOrders(): Promise<void> {
    // Feed: free listings feed traffic.
    await seedOrder({
      id: "order-feed-1",
      netSales: "100.00",
      bucket: "google",
      lastClickUtmMedium: "product_sync",
      lastClickUtmCampaign: "sag_organic",
    });
    await seedOrder({
      id: "order-feed-2",
      netSales: "50.00",
      bucket: "google",
      lastClickUtmMedium: "product_sync",
      lastClickUtmCampaign: null,
    });
    // Paid: everything else in the google bucket.
    await seedOrder({
      id: "order-paid-1",
      netSales: "80.00",
      bucket: "google",
      lastClickUtmMedium: "cpc",
      lastClickUtmCampaign: "brand_search",
    });
    await seedOrder({
      id: "order-paid-2",
      netSales: "20.00",
      bucket: "google",
      lastClickUtmMedium: "cpc",
      lastClickUtmCampaign: null,
    });
    // Meta-bucket order — must be excluded entirely.
    await seedOrder({
      id: "order-meta-1",
      netSales: "999.00",
      bucket: "meta",
      lastClickUtmMedium: "cpc",
      lastClickUtmCampaign: "meta_test",
    });
    // Refund against a feed order, inside the range.
    await seedRefund({
      id: "refund-1",
      orderId: "order-feed-1",
      amount: "25.00",
    });
  }

  it("splits feed/paid summing exactly to the bucket totals", async () => {
    await seedGoogleBucketOrders();

    const result = await loadGoogleAdsRevenuePanel({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
    });

    // Feed: 100.00 + 50.00 - 25.00 refund = 125.00.
    expect(result.ourSide.feedRevenueCents).toBe(12500);
    expect(result.ourSide.feedOrders).toBe(2);
    // Paid: 80.00 + 20.00, no refunds = 100.00.
    expect(result.ourSide.paidRevenueCents).toBe(10000);
    expect(result.ourSide.paidOrders).toBe(2);

    expect(
      result.ourSide.feedRevenueCents + result.ourSide.paidRevenueCents,
    ).toBe(result.ourSide.bucketRevenueCents);
    expect(result.ourSide.feedOrders + result.ourSide.paidOrders).toBe(
      result.ourSide.bucketOrders,
    );

    // Ledger-agreement invariant: matches getBucketTotals' own "google" row.
    const directTotals = await getBucketTotals({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
    });
    const directGoogle = directTotals.buckets.find(
      (bucket) => bucket.bucket === "google",
    );
    expect(result.ourSide.bucketRevenueCents).toBe(directGoogle?.revenueCents);
    expect(result.ourSide.bucketOrders).toBe(directGoogle?.orderCount);
    // Sanity: 250.00 gross - 25.00 refund = 225.00.
    expect(result.ourSide.bucketRevenueCents).toBe(22500);
    expect(result.ourSide.bucketOrders).toBe(4);

    const brandSearch = result.ourSide.paidByCampaign.find(
      (slice) => slice.utmCampaign === "brand_search",
    );
    expect(brandSearch).toEqual({
      utmCampaign: "brand_search",
      revenueCents: 8000,
      orders: 1,
    });
    const noCampaign = result.ourSide.paidByCampaign.find(
      (slice) => slice.utmCampaign === null,
    );
    expect(noCampaign).toEqual({
      utmCampaign: null,
      revenueCents: 2000,
      orders: 1,
    });
  });

  it("slices google facts to the range and matches campaign names", async () => {
    await seedGoogleBucketOrders();
    await seedConnection({ id: "conn-1", currencyCode: "USD" });
    // Brand_Search: in-range 512.00 spend, out-of-range 999.00 spend.
    await seedCampaignFact({
      id: "fact-brand-in",
      connectionId: "conn-1",
      campaignId: "camp-brand",
      campaignName: "Brand_Search",
      factDate: IN_RANGE_DAY,
      costMicros: 5_120_000,
      conversions: "3.5",
      conversionsValue: "650.00",
    });
    await seedCampaignFact({
      id: "fact-brand-out",
      connectionId: "conn-1",
      campaignId: "camp-brand",
      campaignName: "Brand_Search",
      factDate: OUT_OF_RANGE_DAY,
      costMicros: 9_990_000,
      conversions: "9.9",
      conversionsValue: "1234.00",
    });
    // PMax: in-range 234.00 spend, out-of-range 445.00 spend.
    await seedCampaignFact({
      id: "fact-pmax-in",
      connectionId: "conn-1",
      campaignId: "camp-pmax",
      campaignName: "PMax",
      factDate: IN_RANGE_DAY,
      costMicros: 2_340_000,
      conversions: "1.2",
      conversionsValue: "210.00",
    });
    await seedCampaignFact({
      id: "fact-pmax-out",
      connectionId: "conn-1",
      campaignId: "camp-pmax",
      campaignName: "PMax",
      factDate: OUT_OF_RANGE_DAY,
      costMicros: 4_450_000,
      conversions: "4.4",
      conversionsValue: "555.00",
    });

    const result = await loadGoogleAdsRevenuePanel({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
    });

    expect(result.googleSays).not.toBeNull();
    const brand = result.googleSays!.byCampaign.find(
      (row) => row.campaignName === "Brand_Search",
    );
    const pmax = result.googleSays!.byCampaign.find(
      (row) => row.campaignName === "PMax",
    );
    expect(brand).toBeDefined();
    expect(pmax).toBeDefined();

    // Only the in-range fact day counts — the out-of-range day is excluded.
    expect(brand!.spendCents).toBe(512);
    expect(brand!.conversions).toBeCloseTo(3.5);
    expect(brand!.conversionsValueCents).toBe(65000);
    expect(brand!.matchedUtmCampaign).toBe("brand_search");

    expect(pmax!.spendCents).toBe(234);
    expect(pmax!.conversions).toBeCloseTo(1.2);
    expect(pmax!.conversionsValueCents).toBe(21000);
    expect(pmax!.matchedUtmCampaign).toBeNull();

    expect(result.googleSays!.spendCents).toBe(512 + 234);
    expect(result.googleSays!.conversionsValueCents).toBe(65000 + 21000);
    expect(result.googleSays!.conversions).toBeCloseTo(3.5 + 1.2);

    expect(result.connection).toEqual({
      status: "ready",
      lastFactsSyncedAt: expect.any(Date),
      backfillCompletedAt: expect.any(Date),
    });
    expect(result.googleCurrencyCode).toBe("USD");
  });

  it("returns googleSays null without a connection and ourSide still populated", async () => {
    await seedGoogleBucketOrders();
    // No google_ads_connection row seeded for this org/store.

    const result = await loadGoogleAdsRevenuePanel({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
    });

    expect(result.connection).toBeNull();
    expect(result.googleCurrencyCode).toBeNull();
    expect(result.googleSays).toBeNull();

    expect(result.ourSide.bucketRevenueCents).toBe(22500);
    expect(result.ourSide.bucketOrders).toBe(4);
    expect(result.ourSide.feedRevenueCents).toBe(12500);
    expect(result.ourSide.paidRevenueCents).toBe(10000);
  });

  it("accounts a refund against an out-of-range paid order as its own campaign slice", async () => {
    await seedGoogleBucketOrders();
    // Parent order's own day is outside the range — getBucketTotals still
    // nets its refund (refund windowed by refund_day, independent of the
    // order's day) against the "google" bucket, so the split must too.
    await seedOrder({
      id: "order-ghost-1",
      netSales: "60.00",
      bucket: "google",
      lastClickUtmMedium: "cpc",
      lastClickUtmCampaign: "ghost_only",
      orderDay: OUT_OF_RANGE_DAY,
    });
    await seedRefund({
      id: "refund-ghost-1",
      orderId: "order-ghost-1",
      amount: "15.00",
    });

    const result = await loadGoogleAdsRevenuePanel({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
    });

    // Feed slice untouched by the ghost order/refund.
    expect(result.ourSide.feedRevenueCents).toBe(12500);
    // Paid gross 100.00 (unchanged — the ghost order's own day is
    // out-of-range) minus the ghost refund 15.00 = 85.00.
    expect(result.ourSide.paidRevenueCents).toBe(8500);

    expect(
      result.ourSide.feedRevenueCents + result.ourSide.paidRevenueCents,
    ).toBe(result.ourSide.bucketRevenueCents);
    expect(result.ourSide.feedOrders + result.ourSide.paidOrders).toBe(
      result.ourSide.bucketOrders,
    );

    const sliceSum = result.ourSide.paidByCampaign.reduce(
      (total, slice) => total + slice.revenueCents,
      0,
    );
    expect(sliceSum).toBe(result.ourSide.paidRevenueCents);

    const ghostSlice = result.ourSide.paidByCampaign.find(
      (slice) => slice.utmCampaign === "ghost_only",
    );
    expect(ghostSlice).toEqual({
      utmCampaign: "ghost_only",
      revenueCents: -1500,
      orders: 0,
    });

    // Deterministic order: revenueCents descending, nulls last.
    expect(result.ourSide.paidByCampaign).toEqual([
      { utmCampaign: "brand_search", revenueCents: 8000, orders: 1 },
      { utmCampaign: null, revenueCents: 2000, orders: 1 },
      { utmCampaign: "ghost_only", revenueCents: -1500, orders: 0 },
    ]);
  });

  it("classifies feed/paid by trimmed, case-insensitive medium, treating a null medium as paid", async () => {
    await seedOrder({
      id: "order-padded-feed",
      netSales: "40.00",
      bucket: "google",
      lastClickUtmMedium: " PRODUCT_SYNC ",
      lastClickUtmCampaign: null,
    });
    await seedOrder({
      id: "order-null-medium",
      netSales: "10.00",
      bucket: "google",
      lastClickUtmMedium: null,
      lastClickUtmCampaign: null,
    });

    const result = await loadGoogleAdsRevenuePanel({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      dateFrom: RANGE_FROM,
      dateTo: RANGE_TO,
    });

    expect(result.ourSide.feedRevenueCents).toBe(4000);
    expect(result.ourSide.feedOrders).toBe(1);
    expect(result.ourSide.paidRevenueCents).toBe(1000);
    expect(result.ourSide.paidOrders).toBe(1);
  });
});
