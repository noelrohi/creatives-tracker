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
const TEST_DATABASE = "adsolute_klaviyo_match_fresh_test";
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
const freshness = await import("@/lib/klaviyo/match-freshness");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;

describeIfDb("Klaviyo match freshness on PostgreSQL", () => {
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
  });

  async function publish(): Promise<string> {
    const result = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    return result.runId;
  }

  it("verifies a fresh publication and its claim anchor", async () => {
    const runId = await publish();
    const publication = await freshness.verifyPublishedMatchFreshness({
      scope,
      matchRunId: runId,
    });
    expect(publication.fresh).toBe(true);
    const anchor = await freshness.verifyCurrentClaimAnchor({
      scope,
      matchRunId: runId,
      conversionEventRowId: "event-a",
    });
    expect(anchor).toMatchObject({
      fresh: true,
      eventStatus: "confirmed",
    });
    expect(
      anchor.fresh && anchor.canonicalOrderResultId,
    ).toBeTruthy();
  });

  it("goes stale when the source projection mutates", async () => {
    const runId = await publish();
    await testPool!.query(
      `UPDATE klaviyo_event SET source_checksum = 'mutated' WHERE id = 'event-a'`,
    );
    const result = await freshness.verifyPublishedMatchFreshness({
      scope,
      matchRunId: runId,
    });
    expect(result).toEqual({ fresh: false, reason: "source_projection_stale" });
    const anchor = await freshness.verifyCurrentClaimAnchor({
      scope,
      matchRunId: runId,
      conversionEventRowId: "event-a",
    });
    expect(anchor).toEqual({ fresh: false, reason: "publication_stale" });
  });

  it("goes stale when approved rules change", async () => {
    const runId = await publish();
    await testPool!.query(
      `UPDATE klaviyo_join_rule SET state = 'disabled' WHERE id = 'rule-a'`,
    );
    const result = await freshness.verifyPublishedMatchFreshness({
      scope,
      matchRunId: runId,
    });
    expect(result).toEqual({ fresh: false, reason: "rule_or_config_changed" });
  });

  it("distinguishes an entity-only supersession from full staleness", async () => {
    const runId = await publish();
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, attribution_relationship_ids,
          redacted_properties, key_type_fingerprint, warnings,
          product_evidence_completeness, source_checksum, api_revision)
       VALUES ('event-b', 'org-a', 'store-a', 'connection-a', 'metric-placed',
         'external-event-b', now(), '[]', '{}', '[]', '[]', 'unavailable',
         'event-checksum-b', '2026-07-15')`,
    );
    // Supersede only the published event result (entity replacement) while
    // another current result keeps the run current.
    await testPool!.query(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, reason_codes, published_at)
       VALUES ('extra-current', 'org-a', 'store-a', 'connection-a', $1,
         'event-b', 'unmatched', '[]', now())`,
      [runId],
    );
    await testPool!.query(
      `UPDATE klaviyo_event_match_result
          SET superseded_at = greatest(published_at, now()), supersession_reason = 'entity_replaced'
        WHERE run_id = $1 AND event_id = 'event-a'`,
      [runId],
    );
    const anchor = await freshness.verifyCurrentClaimAnchor({
      scope,
      matchRunId: runId,
      conversionEventRowId: "event-a",
    });
    expect(anchor).toEqual({ fresh: false, reason: "event_result_superseded" });
  });

  it("rejects a zero-claiming row whose expected projection is nonempty", async () => {
    const runId = await publish();
    // Corrupt the run to claim zero membership while projections are nonempty.
    await testPool!.query(
      `UPDATE klaviyo_match_run
          SET expected_order_count = 0, expected_event_count = 0,
              result_order_count = 0, result_event_count = 0,
              candidate_count = 0
        WHERE id = $1`,
      [runId],
    );
    const result = await freshness.verifyPublishedMatchFreshness({
      scope,
      matchRunId: runId,
    });
    expect(result).toEqual({
      fresh: false,
      reason: "zero_claim_with_nonempty_projection",
    });
  });
});
