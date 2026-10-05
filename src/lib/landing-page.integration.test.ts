import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConnectionString, withDatabase } from "./klaviyo/match-test-harness";

const connection = resolveConnectionString();
const database = "adsolute_landing_page_harvest_test";
const pool = connection ? new Pool({ connectionString: withDatabase(connection, database) }) : null;
const testDb = pool ? drizzle(pool) : null;
vi.mock("@/db", () => ({ get db() { return testDb; } }));
const { harvestLandingPages, harvestLandingPagesFromOrders } = await import("./landing-page");

// The columns the harvest reads and writes, plus every column Drizzle names
// in its statements (it lists all of landing_page's columns on insert and
// sets updated_at on every update).
const DDL = [
  `CREATE TABLE shopify_store (id text PRIMARY KEY, organization_id text NOT NULL, shop_domain text NOT NULL)`,
  `CREATE TABLE shopify_order (id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     journey_ready boolean NOT NULL DEFAULT false, landing_page_id text, customer_journey jsonb,
     updated_at timestamp NOT NULL DEFAULT now())`,
  `CREATE TABLE ad (id text PRIMARY KEY, organization_id text NOT NULL, destination_url text, landing_page_id text,
     updated_at timestamp NOT NULL DEFAULT now())`,
  `CREATE TABLE landing_page (id text PRIMARY KEY, organization_id text NOT NULL, normalized_url text NOT NULL,
     family text, first_seen_in_ads_at timestamp, first_seen_in_journeys_at timestamp,
     page_type text, funnel_stage text, awareness_fit text, classification_status text,
     classification_source text, classification_confidence numeric, content_hash text,
     classified_at timestamp, confirmed_at timestamp,
     created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
     CONSTRAINT landing_page_org_normalized_url_uniq UNIQUE (organization_id, normalized_url))`,
];

function journey(landingPage: string | null) {
  return JSON.stringify({ lastVisit: landingPage === null ? {} : { landingPage } });
}

async function seedOrder(id: string, landingPage: string | null) {
  await pool!.query(
    `INSERT INTO shopify_order (id, organization_id, store_id, journey_ready, customer_journey)
     VALUES ($1, 'org-a', 'store-a', true, $2)`,
    [id, journey(landingPage)],
  );
}

async function seedAd(id: string, destinationUrl: string) {
  await pool!.query(
    `INSERT INTO ad (id, organization_id, destination_url) VALUES ($1, 'org-a', $2)`,
    [id, destinationUrl],
  );
}

async function landingPageIdOf(table: "shopify_order" | "ad", id: string) {
  const result = await pool!.query(`SELECT landing_page_id FROM ${table} WHERE id = $1`, [id]);
  return result.rows[0].landing_page_id as string | null;
}

(connection ? describe : describe.skip)("landing page harvest on PostgreSQL", () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: withDatabase(connection!, "postgres") });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${database}`);
    } finally { await admin.end(); }
    for (const statement of DDL) await pool!.query(statement);
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool!.query("TRUNCATE shopify_store, shopify_order, ad, landing_page");
    await pool!.query(
      `INSERT INTO shopify_store (id, organization_id, shop_domain) VALUES ('store-a', 'org-a', 'shop.example.com')`,
    );
  });

  it("links journey orders without reading or linking ads", async () => {
    await seedOrder("order-linkable", "https://shop.example.com/products/x?utm_source=meta");
    await seedAd("ad-1", "https://shop.example.com/products/y");

    const result = await harvestLandingPagesFromOrders({ organizationId: "org-a", storeId: "store-a" });

    expect(result).toEqual({ ordersScanned: 1, ordersLinked: 1, pages: 1 });
    expect(await landingPageIdOf("shopify_order", "order-linkable")).not.toBeNull();
    expect(await landingPageIdOf("ad", "ad-1")).toBeNull();
    const pages = await pool!.query(
      `SELECT normalized_url, first_seen_in_ads_at, first_seen_in_journeys_at FROM landing_page`,
    );
    expect(pages.rows).toHaveLength(1);
    expect(pages.rows[0].normalized_url).toBe("shop.example.com/products/x");
    expect(pages.rows[0].first_seen_in_ads_at).toBeNull();
    expect(pages.rows[0].first_seen_in_journeys_at).not.toBeNull();
  });

  it("does not scan journey-ready orders whose journey has no landing page", async () => {
    await seedOrder("order-linkable", "https://shop.example.com/products/x");
    await seedOrder("order-no-landing-1", null);
    await seedOrder("order-no-landing-2", null);

    const orderOnly = await harvestLandingPagesFromOrders({ organizationId: "org-a", storeId: "store-a" });
    expect(orderOnly.ordersScanned).toBe(1);

    const full = await harvestLandingPages({ organizationId: "org-a", storeId: "store-a" });
    expect(full.ordersScanned).toBe(0);
    expect(await landingPageIdOf("shopify_order", "order-no-landing-1")).toBeNull();
  });

  it("keeps the full harvest linking both ads and orders", async () => {
    await seedOrder("order-linkable", "https://shop.example.com/products/x");
    await seedAd("ad-1", "https://shop.example.com/products/x?utm_campaign=1");

    const result = await harvestLandingPages({ organizationId: "org-a", storeId: "store-a" });

    expect(result).toMatchObject({ adsScanned: 1, adsLinked: 1, ordersScanned: 1, ordersLinked: 1, pages: 1 });
    expect(await landingPageIdOf("ad", "ad-1")).toBe(await landingPageIdOf("shopify_order", "order-linkable"));
  });
});
