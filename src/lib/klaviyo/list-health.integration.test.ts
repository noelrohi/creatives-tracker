import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCOPE,
  applyMatchFixture,
  resolveConnectionString,
  seedMatchWorld,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_list_health_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 6,
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const evidenceStore = await import("@/lib/shopify-evidence-store");
const { loadListHealth } = await import("@/lib/klaviyo/list-health");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
// seedMatchWorld's store runs in America/New_York (EDT, UTC-4 in August).
const timeZone = "America/New_York";
const window = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-15T00:00:00.000Z"),
};

const ZERO_TOTALS = {
  subscribed: 0,
  unsubscribed: 0,
  wonBack: 0,
  quickChurn: 0,
  net: 0,
};

/**
 * Consent metric rows, modeled on the harness's klaviyo_metric seed.
 * ingestion_enabled stays 0: consent kinds read from retained events; the
 * enabled-kind partial unique index only guards enabled rows anyway.
 */
async function seedConsentMetric(
  id: string,
  kind: string,
  name: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_metric
       (id, organization_id, shopify_store_id, connection_id,
        external_metric_id, name, canonical_kind, ingestion_enabled,
        api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $1 || '-ext', $3, $2, 0,
       '2026-07-15')`,
    [id, kind, name],
  );
}

async function seedConsentMetrics(): Promise<void> {
  await seedConsentMetric("metric-sub", "subscribed_to_list", "Subscribed to List");
  await seedConsentMetric(
    "metric-unsub",
    "unsubscribed_from_list",
    "Unsubscribed from List",
  );
}

/**
 * Consent event rows: the email-attribution seedEvent shape plus profile_id.
 * occurred_at is passed as ISO TEXT so Postgres stores the UTC wall time
 * regardless of the process timezone (the harness convention).
 */
async function seedConsentEvent(
  id: string,
  metricId: string,
  profileId: string,
  occurredAt: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, profile_id,
        explicit_order_id_candidate, attribution_relationship_ids,
        redacted_properties, key_type_fingerprint, warnings,
        product_evidence_completeness, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2,
       $1 || '-external', $4, $3, NULL, '[]', '{}', '[]', '[]',
       'unavailable', $1 || '-checksum', '2026-07-15')`,
    [id, metricId, profileId, occurredAt],
  );
}

describeIfDb("Klaviyo list health aggregates on PostgreSQL", () => {
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
    await applyMatchFixture(testPool!);
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
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
  });

  it("computes totals and flips end to end over seeded consent events", async () => {
    await seedConsentMetrics();
    // p-plain: one plain subscribe.
    await seedConsentEvent("ev-plain", "metric-sub", "p-plain", "2026-08-02T10:00:00Z");
    // p-wonback: unsubscribe then resubscribe, both in window -> wonBack.
    await seedConsentEvent("ev-wb-1", "metric-unsub", "p-wonback", "2026-08-03T10:00:00Z");
    await seedConsentEvent("ev-wb-2", "metric-sub", "p-wonback", "2026-08-05T10:00:00Z");
    // p-quick: subscribe, unsubscribe exactly 13d later -> quickChurn.
    await seedConsentEvent("ev-qc-1", "metric-sub", "p-quick", "2026-08-01T10:00:00Z");
    await seedConsentEvent("ev-qc-2", "metric-unsub", "p-quick", "2026-08-14T10:00:00Z");
    // p-slow: subscribe (before the window), unsubscribe 15d later -> NOT
    // quick churn; only the unsubscribe lands in the window.
    await seedConsentEvent("ev-sl-1", "metric-sub", "p-slow", "2026-07-25T10:00:00Z");
    await seedConsentEvent("ev-sl-2", "metric-unsub", "p-slow", "2026-08-09T10:00:00Z");
    // p-first: an unsubscribe as the profile's first-ever event -> no flip.
    await seedConsentEvent("ev-first", "metric-unsub", "p-first", "2026-08-06T10:00:00Z");

    const summary = await loadListHealth({ scope, window, timeZone });

    expect(summary.discovered).toBe(true);
    expect(summary.totals).toEqual({
      subscribed: 3,
      unsubscribed: 4,
      wonBack: 1,
      quickChurn: 1,
      net: -1,
    });
  });

  it("returns discovered: false with zero totals when no consent metrics exist", async () => {
    // seedMatchWorld's placed_order/ordered_product metrics are present but
    // no consent-kind metric row exists.
    const summary = await loadListHealth({ scope, window, timeZone });

    expect(summary).toEqual({
      discovered: false,
      totals: ZERO_TOTALS,
      daily: [],
    });
  });

  it("counts an event at exactly window.from and excludes one at window.to", async () => {
    await seedConsentMetrics();
    await seedConsentEvent("ev-edge-from", "metric-sub", "p-edge-from", "2026-08-01T00:00:00Z");
    await seedConsentEvent("ev-edge-to", "metric-sub", "p-edge-to", "2026-08-15T00:00:00Z");

    const summary = await loadListHealth({ scope, window, timeZone });

    expect(summary.totals).toEqual({
      subscribed: 1,
      unsubscribed: 0,
      wonBack: 0,
      quickChurn: 0,
      net: 1,
    });
    // 2026-08-01T00:00Z is 2026-07-31 20:00 in America/New_York (EDT).
    expect(summary.daily).toEqual([
      { day: "2026-07-31", subscribed: 1, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 1 },
    ]);
  });

  it("uses prior state from before the window for won-back", async () => {
    await seedConsentMetrics();
    // July unsubscribe (outside the August window) sets the prior state;
    // the in-window resubscribe flips to won-back.
    await seedConsentEvent("ev-prior", "metric-unsub", "p-prior", "2026-07-10T10:00:00Z");
    await seedConsentEvent("ev-resub", "metric-sub", "p-prior", "2026-08-05T10:00:00Z");

    const summary = await loadListHealth({ scope, window, timeZone });

    expect(summary.totals).toEqual({
      subscribed: 1,
      unsubscribed: 0,
      wonBack: 1,
      quickChurn: 0,
      net: 1,
    });
  });
});
