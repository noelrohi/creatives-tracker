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
const TEST_DATABASE = "adsolute_klaviyo_queries_test";
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

const service = await import("@/lib/klaviyo/match-service");
const queries = await import("@/lib/klaviyo/queries");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-30T00:00:00.000Z"),
};

describeIfDb("Klaviyo evidence queries on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
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
      `TRUNCATE identity_pilot_uninstall_receipt, klaviyo_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
    await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    // A second order arriving after publication: genuinely not evaluated.
    await testPool!.query(
      `INSERT INTO shopify_order
         (id, organization_id, store_id, shopify_order_id, order_created_at,
          order_day, net_sales)
       VALUES ('order-b', 'org-a', 'store-a', '9002',
         '2026-07-21T10:00:00Z', '2026-07-21', 10)`,
    );
  });

  it("counts coverage including explicit not_evaluated on both sides", async () => {
    const coverage = await queries.loadEvidenceCoverage({ scope, window });
    expect(coverage.orders).toEqual({ confirmed: 1, not_evaluated: 1 });
    expect(coverage.events).toEqual({ confirmed: 1 });
  });

  it("lists the order ledger with left-joined current results", async () => {
    const all = await queries.listEvidenceOrders({ scope, window });
    expect(all.items).toHaveLength(2);
    const byId = new Map(all.items.map((item) => [item.orderId, item]));
    expect(byId.get("order-a")).toMatchObject({
      orderStatus: "confirmed",
      productStatus: "unavailable",
    });
    expect(byId.get("order-b")).toMatchObject({
      orderStatus: "not_evaluated",
      matchRunId: null,
      boundaryWarning: false,
    });

    const notEvaluated = await queries.listEvidenceOrders({
      scope,
      window,
      orderStatus: "not_evaluated",
    });
    expect(notEvaluated.items.map((item) => item.orderId)).toEqual(["order-b"]);
    const confirmed = await queries.listEvidenceOrders({
      scope,
      window,
      orderStatus: "confirmed",
    });
    expect(confirmed.items.map((item) => item.orderId)).toEqual(["order-a"]);
  });

  it("explains an order with candidate edges and selection", async () => {
    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    expect(explanation).toMatchObject({
      orderStatus: "confirmed",
      matcherVersion: "klaviyo-v1",
    });
    expect(explanation!.candidates).toHaveLength(1);
    expect(explanation!.candidates[0]).toMatchObject({
      candidateClass: "deterministic",
      selected: true,
    });
    const missing = await queries.loadOrderExplanation({
      scope,
      orderId: "order-nope",
    });
    expect(missing).toBeNull();
    const notEvaluated = await queries.loadOrderExplanation({
      scope,
      orderId: "order-b",
    });
    expect(notEvaluated).toMatchObject({
      orderStatus: "not_evaluated",
      candidates: [],
    });
  });

  it("returns canonical products, diagnostic candidate rows, and NOT_FOUND", async () => {
    const canonical = await queries.loadOrderProducts({
      scope,
      orderId: "order-a",
    });
    expect(canonical).toMatchObject({
      kind: "canonical",
      productStatus: "unavailable",
    });

    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    const candidateId = explanation!.candidates[0].candidateId;
    const diagnostic = await queries.loadOrderProducts({
      scope,
      orderId: "order-a",
      candidateId,
    });
    expect(diagnostic.kind).toBe("diagnostic");
    expect(JSON.stringify(diagnostic)).not.toContain('"productStatus"');

    const wrongOrder = await queries.loadOrderProducts({
      scope,
      orderId: "order-b",
      candidateId,
    });
    expect(wrongOrder.kind).toBe("not_found");

    // Superseding the requested order's result makes its candidate
    // inaccessible even though the run row still exists.
    await testPool!.query(
      `UPDATE klaviyo_order_match_result
          SET superseded_at = now(), supersession_reason = 'entity_replaced'
        WHERE order_id = 'order-a'`,
    );
    const afterSupersede = await queries.loadOrderProducts({
      scope,
      orderId: "order-a",
      candidateId,
    });
    expect(afterSupersede.kind).toBe("not_found");
  });

  it("lists unmatched events symmetrically with the read-union filter", async () => {
    // Default ledger excludes the confirmed event.
    const defaultLedger = await queries.listUnmatchedEvents({ scope, window: {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
    } });
    expect(defaultLedger.items).toHaveLength(0);

    // Supersede the event result with an incident boundary: the event
    // becomes API-only not_evaluated with a boundary warning.
    await testPool!.query(
      `UPDATE klaviyo_event_match_result
          SET superseded_at = now(),
              supersession_reason = 'incident_edge_boundary',
              selected_candidate_id = NULL, selected_class = NULL
        WHERE event_id = 'event-a'`,
    );
    const afterBoundary = await queries.listUnmatchedEvents({
      scope,
      window,
      eventStatus: "not_evaluated",
    });
    expect(afterBoundary.items).toEqual([
      expect.objectContaining({
        eventId: "event-a",
        eventStatus: "not_evaluated",
        boundaryWarning: true,
      }),
    ]);
  });

  it("never mutates results and never leaks identity material", async () => {
    const before = await testPool!.query(
      `SELECT count(*)::int AS results FROM klaviyo_order_match_result`,
    );
    const ledger = await queries.listEvidenceOrders({ scope, window });
    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    const after = await testPool!.query(
      `SELECT count(*)::int AS results FROM klaviyo_order_match_result`,
    );
    expect(after.rows[0].results).toBe(before.rows[0].results);
    const serialized = JSON.stringify({ ledger, explanation });
    expect(serialized).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(serialized).not.toContain("digest");
  });
});
