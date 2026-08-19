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
  KlaviyoCompoundPage,
  KlaviyoSingleEventRequest,
  KlaviyoSingleEventResult,
} from "@/lib/klaviyo/client";
import type {
  KlaviyoCredentialProvider,
  ResolvedKlaviyoCredential,
} from "@/lib/klaviyo/credential-provider";
import type { ClaimReplayCheckpoint } from "@/lib/klaviyo/claims";
import {
  MATCH_SCOPE,
  applyMatchFixture,
  resolveConnectionString,
  seedMatchWorld,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_claim_test";
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

const repository = await import("@/lib/klaviyo/claim-repository");
const matchService = await import("@/lib/klaviyo/match-service");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;

const fakeCredentialProvider: KlaviyoCredentialProvider = {
  async getPilotBinding() {
    return {
      expectedAccountId: "account-a",
      shopDomain: "a.example.com",
      allowedUrlHosts: [],
    };
  },
  async resolve(): Promise<ResolvedKlaviyoCredential> {
    return {
      privateApiKey: "pk_test",
      reference: "reviv_environment",
      expectedAccountId: "account-a",
      allowedUrlHosts: [],
    };
  },
};

const gateOpen = async () => ({ ready: true });

function fakeClaimClient(
  overrides: {
    attributions?: KlaviyoCompoundPage["included"];
    referencedUrl?: string;
  } = {},
) {
  return {
    getEventById: vi
      .fn<
        (input: {
          externalEventId: string;
          request: KlaviyoSingleEventRequest;
        }) => Promise<KlaviyoSingleEventResult>
      >()
      .mockImplementation(async ({ externalEventId, request }) => {
        if (request.purpose === "attribution_claim") {
          const attributions = overrides.attributions ?? [
            {
              type: "attribution",
              id: "attribution-1",
              relationships: {
                campaign: { data: { type: "campaign", id: "campaign-ext-1" } },
                "attributed-event": {
                  data: { type: "event", id: "interaction-ext-1" },
                },
              },
            },
          ];
          return {
            purpose: "attribution_claim",
            event: { type: "event", id: externalEventId },
            attributionIds: attributions.map((resource) => resource.id),
            attributions,
          };
        }
        return {
          purpose: "referenced_interaction",
          event: {
            type: "event",
            id: externalEventId,
            attributes: {
              datetime: "2026-07-20T09:55:00Z",
              event_properties: {
                URL:
                  overrides.referencedUrl ??
                  "https://shop.example.com/products/x?utm_source=klaviyo",
              },
            },
          },
          metric: { type: "metric", id: "metric-ext-click" },
        };
      }),
  };
}

async function publishMatchWorld(): Promise<{ matchRunId: string }> {
  const result = await matchService.computeAndPublishMatches({
    scope,
    sourceRunId: "source-run-a",
    shopifyEvidenceRunId: "evidence-run-a",
  });
  return { matchRunId: result.runId };
}

async function startGraph(matchRunId: string): Promise<string> {
  const start = await repository.startOrResumeClaimReplay({
    scope,
    sourceRunId: "source-run-a",
    matchRunId,
    now: new Date(),
  });
  if (start.kind !== "started") {
    throw new Error(`expected started, got ${start.kind}`);
  }
  return start.claimReplayId;
}

async function graphRow(claimReplayId: string) {
  const result = await testPool!.query(
    `SELECT status, failure_code, checkpoint, superseded_skipped,
            conversions_complete, conversions_incomplete, conversions_failed
       FROM klaviyo_claim_replay_run WHERE id = $1`,
    [claimReplayId],
  );
  return result.rows[0];
}


const DAY_MS = 24 * 60 * 60 * 1000;

async function seedExtraConversionEvent(
  id: string,
  externalEventId: string,
  occurredAt: Date,
  explicitOrderIdCandidate: string | null = null,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, explicit_order_id_candidate,
        attribution_relationship_ids, redacted_properties,
        key_type_fingerprint, warnings, product_evidence_completeness,
        source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'metric-placed',
       $2, $3, $4, '["attribution-1"]', '{}', '[]', '[]', 'unavailable',
       $5, '2026-07-15')`,
    [id, externalEventId, occurredAt, explicitOrderIdCandidate, `${id}-checksum`],
  );
  await testPool!.query(
    `INSERT INTO klaviyo_event_run_observation
       (organization_id, shopify_store_id, connection_id, sync_run_id,
        event_id, observed_source_checksum)
     VALUES ('org-a', 'store-a', 'connection-a', 'source-run-a', $1, $2)`,
    [id, `${id}-checksum`],
  );
}

/**
 * Seed a second, old confirmed-matchable conversion (~60 days before now,
 * far outside the claim replay lookback): an order with a line + evidence
 * observation and a placed-order event resolving to it. Must run before
 * publishMatchWorld so the publication's projections include it.
 */
async function seedOldConversionWorld(): Promise<{ occurredAt: Date }> {
  const orderCreatedAt = new Date(Date.now() - 60 * DAY_MS);
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales)
     VALUES ('order-old', 'org-a', 'store-a', '9002', $1, $2, 19.5)`,
    [orderCreatedAt, orderCreatedAt.toISOString().slice(0, 10)],
  );
  await testPool!.query(
    `INSERT INTO shopify_order_line
       (id, organization_id, store_id, order_id, shopify_line_item_id,
        shopify_product_id, shopify_variant_id, sku, product_title, quantity,
        parent_order_updated_at)
     VALUES ('line-old', 'org-a', 'store-a', 'order-old', 'li-2', '77', '88',
       'SKU-1', 'Product', 1, now())`,
  );
  // Recompute with the Date exactly as drizzle will reparse it (naive
  // timestamps map back as UTC), mirroring seedMatchWorld.
  const [{ stored_text: storedText }] = (
    await testPool!.query(
      `SELECT order_created_at::text AS stored_text
         FROM shopify_order WHERE id = 'order-old'`,
    )
  ).rows as Array<{ stored_text: string }>;
  const storedCreatedAt = new Date(`${storedText.replace(" ", "T")}Z`);
  const checksum = evidenceStore.canonicalContentChecksum({
    order: {
      id: "order-old",
      shopifyOrderId: "9002",
      orderCreatedAt: storedCreatedAt,
    },
    lines: [
      {
        shopifyLineItemId: "li-2",
        shopifyProductId: "77",
        shopifyVariantId: "88",
        sku: "SKU-1",
        quantity: 1,
      },
    ],
    lineDisposition: "complete",
    identityDisposition: "unavailable",
  });
  await testPool!.query(
    `INSERT INTO shopify_evidence_run_observation
       (id, organization_id, store_id, evidence_run_id, order_id,
        line_disposition, identity_disposition, observed_content_checksum)
     VALUES ('obs-order-old', 'org-a', 'store-a', 'evidence-run-a',
       'order-old', 'complete', 'unavailable', $1)`,
    [checksum],
  );
  const occurredAt = new Date(orderCreatedAt.getTime() + 4 * 60 * 1000);
  await seedExtraConversionEvent(
    "event-old",
    "external-event-old",
    occurredAt,
    "9002",
  );
  return { occurredAt };
}

describeIfDb("Klaviyo claim repository on PostgreSQL", () => {
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
      `TRUNCATE identity_pilot_uninstall_receipt, klaviyo_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
    // event-a expects exactly one attribution relationship; the source
    // checksum is opaque so this does not invalidate the projections.
    await testPool!.query(
      `UPDATE klaviyo_event
          SET attribution_relationship_ids = '["attribution-1"]'
        WHERE id = 'event-a'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_metric
         (id, organization_id, shopify_store_id, connection_id,
          external_metric_id, name, canonical_kind, ingestion_enabled,
          api_revision)
       VALUES ('metric-click', 'org-a', 'store-a', 'connection-a',
         'metric-ext-click', 'Clicked Email', 'clicked_email', 0,
         '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_marketing_object
         (id, organization_id, shopify_store_id, connection_id, object_type,
          external_id, name, tracking_projection, source_checksum, api_revision)
       VALUES ('campaign-row-1', 'org-a', 'store-a', 'connection-a',
         'campaign', 'campaign-ext-1', 'Summer Sale', '{}', 'checksum',
         '2026-07-15')`,
    );
  });

  it("starts one graph, reuses it live, and conflicts on a different binding", async () => {
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const again = await repository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId,
      now: new Date(),
    });
    expect(again).toEqual({ kind: "pending", claimReplayId });
    const different = await repository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId: "match-run-other",
      now: new Date(),
    });
    expect(different).toEqual({ kind: "conflict" });
  });

  it("creates no graph for a missing or stale publication", async () => {
    const stale = await repository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId: "match-run-missing",
      now: new Date(),
    });
    expect(stale).toEqual({ kind: "stale", reason: "run_missing" });
    const graphs = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_claim_replay_run`,
    );
    expect(graphs.rows[0].count).toBe(0);
  });

  it("replays a complete conversion end to end and sets only claimCount", async () => {
    const { matchRunId } = await publishMatchWorld();
    const before = await testPool!.query(
      `SELECT id, status, selected_candidate_id, selected_class, method,
              confidence_summary, product_status, claim_count
         FROM klaviyo_order_match_result WHERE run_id = $1`,
      [matchRunId],
    ).catch(async () =>
      testPool!.query(
        `SELECT id, status, selected_candidate_id, selected_class,
                product_status, claim_count
           FROM klaviyo_order_match_result WHERE run_id = $1`,
        [matchRunId],
      ),
    );
    const claimReplayId = await startGraph(matchRunId);
    const client = fakeClaimClient();
    const result = await repository.processClaimBatch(
      { scope, claimReplayId },
      {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
        verifyWriterReadiness: gateOpen,
      },
    );
    expect(result.outcome).toBe("done");
    expect(result.processed).toBe(1);

    const graph = await graphRow(claimReplayId);
    expect(graph.status).toBe("success");
    expect(graph.conversions_complete).toBe(1);

    const claims = await testPool!.query(
      `SELECT klaviyo_attribution_id, campaign_object_id,
              attributed_interaction_external_event_id, interaction_type,
              interaction_host, interaction_path
         FROM klaviyo_attribution_claim
        WHERE conversion_event_id = 'event-a'`,
    );
    expect(claims.rows).toEqual([
      {
        klaviyo_attribution_id: "attribution-1",
        campaign_object_id: "campaign-row-1",
        attributed_interaction_external_event_id: "interaction-ext-1",
        interaction_type: "click",
        interaction_host: "shop.example.com",
        interaction_path: "/products/x",
      },
    ]);

    const state = await testPool!.query(
      `SELECT status, resolved_claim_count FROM klaviyo_claim_replay_state
        WHERE conversion_event_id = 'event-a'`,
    );
    expect(state.rows[0]).toEqual({ status: "complete", resolved_claim_count: 1 });

    const after = await testPool!.query(
      `SELECT id, status, selected_candidate_id, selected_class,
              product_status, claim_count
         FROM klaviyo_order_match_result WHERE run_id = $1`,
      [matchRunId],
    );
    expect(after.rows[0].claim_count).toBe(1);
    const beforeRow = before.rows[0] as Record<string, unknown>;
    expect(after.rows[0].status).toBe(beforeRow.status);
    expect(after.rows[0].selected_candidate_id).toBe(
      beforeRow.selected_candidate_id,
    );
    expect(after.rows[0].product_status).toBe(beforeRow.product_status);
  });

  it("preserves prior claims and writes incomplete on a truncated refresh", async () => {
    const { matchRunId } = await publishMatchWorld();
    await testPool!.query(
      `UPDATE klaviyo_event
          SET warnings = '["attribution_relationship_truncated"]'
        WHERE id = 'event-a'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, unknown_reason_codes,
          source_checksum, api_revision)
       VALUES ('claim-previous', 'org-a', 'store-a', 'connection-a',
         'event-a', 'attribution-old', '[]', 'checksum-old', '2026-07-15')`,
    );
    const claimReplayId = await startGraph(matchRunId);
    const result = await repository.processClaimBatch(
      { scope, claimReplayId },
      {
        createClient: () => fakeClaimClient(),
        credentialProvider: fakeCredentialProvider,
        verifyWriterReadiness: gateOpen,
      },
    );
    expect(result.outcome).toBe("done");
    const graph = await graphRow(claimReplayId);
    expect(graph.status).toBe("partial");
    expect(graph.conversions_incomplete).toBe(1);
    const claims = await testPool!.query(
      `SELECT klaviyo_attribution_id FROM klaviyo_attribution_claim
        WHERE conversion_event_id = 'event-a'`,
    );
    expect(claims.rows).toEqual([{ klaviyo_attribution_id: "attribution-old" }]);
    const state = await testPool!.query(
      `SELECT status, reason_codes FROM klaviyo_claim_replay_state
        WHERE conversion_event_id = 'event-a'`,
    );
    expect(state.rows[0].status).toBe("incomplete");
    expect(state.rows[0].reason_codes).toContain(
      "attribution_relationship_truncated",
    );
    const order = await testPool!.query(
      `SELECT claim_count FROM klaviyo_order_match_result WHERE run_id = $1`,
      [matchRunId],
    );
    expect(order.rows[0].claim_count).toBe(0);
  });

  it("blocks on a failed gate check with no claim, state, or count writes", async () => {
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const client = fakeClaimClient();
    const result = await repository.processClaimBatch(
      { scope, claimReplayId },
      {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
        verifyWriterReadiness: async () => ({ ready: false }),
      },
    );
    expect(result.outcome).toBe("gate_blocked");
    expect(client.getEventById).not.toHaveBeenCalled();
    const graph = await graphRow(claimReplayId);
    expect(graph.status).toBe("running");
    const writes = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM klaviyo_attribution_claim) AS claims,
         (SELECT count(*)::int FROM klaviyo_claim_replay_state) AS states`,
    );
    expect(writes.rows[0]).toEqual({ claims: 0, states: 0 });
  });

  it("recovers only the exact attempting conversion and finalizes failed", async () => {
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const checkpoint = (await graphRow(claimReplayId))
      .checkpoint as ClaimReplayCheckpoint;
    const fetching: ClaimReplayCheckpoint = {
      ...checkpoint,
      attemptingConversionEventId: "event-a",
      attemptingOccurredAt: "2026-07-20T10:04:00.000Z",
      stage: "fetching",
    };
    await testPool!.query(
      `UPDATE klaviyo_claim_replay_run SET checkpoint = $1 WHERE id = $2`,
      [JSON.stringify(fetching), claimReplayId],
    );
    const recovery = await repository.recoverExhaustedClaimBatch({
      scope,
      claimReplayId,
      now: new Date(),
    });
    expect(recovery.kind).toBe("recovered");
    const graph = await graphRow(claimReplayId);
    expect(graph.status).toBe("failed");
    expect(graph.failure_code).toBe("CLAIM_RETRIES_EXHAUSTED");
    const state = await testPool!.query(
      `SELECT status, reason_codes FROM klaviyo_claim_replay_state
        WHERE conversion_event_id = 'event-a'`,
    );
    expect(state.rows[0].status).toBe("failed");
    expect(state.rows[0].reason_codes).toEqual(["CLAIM_RETRIES_EXHAUSTED"]);
    const again = await repository.recoverExhaustedClaimBatch({
      scope,
      claimReplayId,
      now: new Date(),
    });
    expect(again.kind).toBe("no_attempt");
  });

  it("skips a superseded attempting anchor and goes stale with none left", async () => {
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const checkpoint = (await graphRow(claimReplayId))
      .checkpoint as ClaimReplayCheckpoint;
    await testPool!.query(
      `UPDATE klaviyo_claim_replay_run SET checkpoint = $1 WHERE id = $2`,
      [
        JSON.stringify({
          ...checkpoint,
          attemptingConversionEventId: "event-a",
          attemptingOccurredAt: "2026-07-20T10:04:00.000Z",
          stage: "fetching",
        }),
        claimReplayId,
      ],
    );
    await testPool!.query(
      `UPDATE klaviyo_event_match_result
          SET superseded_at = greatest(published_at, now()),
              supersession_reason = 'entity_replaced'
        WHERE run_id = $1 AND event_id = 'event-a'`,
      [matchRunId],
    );
    const recovery = await repository.recoverExhaustedClaimBatch({
      scope,
      claimReplayId,
      now: new Date(),
    });
    expect(recovery.kind).toBe("stale");
    const graph = await graphRow(claimReplayId);
    expect(graph.status).toBe("stale");
    expect(graph.superseded_skipped).toBe(1);
    const states = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_claim_replay_state`,
    );
    expect(states.rows[0].count).toBe(0);
  });

  it("reaps only an expired lease and preserves checkpoint and claims", async () => {
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const live = await repository.failExpiredClaimReplayRun({
      scope,
      claimReplayId,
      now: new Date(),
    });
    expect(live).toEqual({ changed: false });
    await testPool!.query(
      `UPDATE klaviyo_claim_replay_run
          SET heartbeat_at = now() - interval '30 minutes' WHERE id = $1`,
      [claimReplayId],
    );
    const reaped = await repository.failExpiredClaimReplayRun({
      scope,
      claimReplayId,
      now: new Date(),
    });
    expect(reaped).toEqual({ changed: true });
    const graph = await graphRow(claimReplayId);
    expect(graph.status).toBe("failed");
    expect(graph.failure_code).toBe("CLAIM_LEASE_EXPIRED");
    expect(graph.checkpoint).not.toBeNull();
    const replay = await repository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId,
      now: new Date(),
    });
    expect(replay.kind).toBe("started");
  });

  it("is idempotent across a full replay of an already-complete graph", async () => {
    // A conversion inside the lookback window: its second-graph skip must
    // travel the checksum-equality path, not the age bound.
    await seedExtraConversionEvent(
      "event-recent",
      "external-event-recent",
      new Date(Date.now() - 2 * DAY_MS),
    );
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const dependenciesFor = (client: ReturnType<typeof fakeClaimClient>) => ({
      createClient: () => client,
      credentialProvider: fakeCredentialProvider,
      verifyWriterReadiness: gateOpen,
    });
    const firstClient = fakeClaimClient();
    const first = await repository.processClaimBatch(
      { scope, claimReplayId },
      dependenciesFor(firstClient),
    );
    expect(first).toMatchObject({ outcome: "done", processed: 2 });
    // A second graph replays the same conversions: the old conversion is
    // skipped by the age bound, the recent one by its unchanged checksum in
    // phase missing, and both bounded retry phases stay empty.
    const secondStart = await repository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId,
      now: new Date(),
    });
    expect(secondStart.kind).toBe("started");
    if (secondStart.kind !== "started") throw new Error("unreachable");
    const secondClient = fakeClaimClient();
    const second = await repository.processClaimBatch(
      { scope, claimReplayId: secondStart.claimReplayId },
      dependenciesFor(secondClient),
    );
    expect(second).toMatchObject({ outcome: "done", processed: 0 });
    expect(secondClient.getEventById).not.toHaveBeenCalled();
    const claims = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_attribution_claim`,
    );
    expect(claims.rows[0].count).toBe(2);
    const order = await testPool!.query(
      `SELECT claim_count FROM klaviyo_order_match_result WHERE run_id = $1`,
      [matchRunId],
    );
    expect(order.rows[0].claim_count).toBe(1);
  });

  describe("age-bounded replay scope", () => {
    // A prior replay's state under an earlier run scope: visible to the
    // connection-wide coverage check, invisible to the current-run join.
    async function insertCoverageState(input: {
      conversionEventId: string;
      status: "complete" | "incomplete";
      matchRunId: string;
    }): Promise<void> {
      await testPool!.query(
        `INSERT INTO klaviyo_claim_replay_state
           (id, organization_id, shopify_store_id, connection_id,
            source_run_id, match_run_id, conversion_event_id, source_checksum,
            status, reason_codes, attempt_count, attempted_at, completed_at)
         VALUES ($1, 'org-a', 'store-a', 'connection-a', 'probe-run-a', $2,
           $3, $4, $5, '[]', 1, now(), $6)`,
        [
          `state-${input.conversionEventId}`,
          input.matchRunId,
          input.conversionEventId,
          `${input.conversionEventId}-checksum`,
          input.status,
          input.status === "complete" ? new Date() : null,
        ],
      );
    }

    function dependenciesFor(client: ReturnType<typeof fakeClaimClient>) {
      return {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
        verifyWriterReadiness: gateOpen,
      };
    }

    function fetchedExternalIds(client: ReturnType<typeof fakeClaimClient>) {
      return client.getEventById.mock.calls.map(
        ([{ externalEventId }]) => externalEventId,
      );
    }

    it("skips an old conversion already covered by a complete state", async () => {
      await seedOldConversionWorld();
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-old",
        status: "complete",
        matchRunId,
      });
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result.outcome).toBe("done");
      expect(result.processed).toBe(1);
      expect(fetchedExternalIds(client)).not.toContain("external-event-old");
      const graph = await graphRow(claimReplayId);
      expect(graph.status).toBe("success");
      expect(graph.conversions_complete).toBe(1);
      const oldWrites = await testPool!.query(
        `SELECT
           (SELECT count(*)::int FROM klaviyo_attribution_claim
             WHERE conversion_event_id = 'event-old') AS claims,
           (SELECT count(*)::int FROM klaviyo_claim_replay_state
             WHERE conversion_event_id = 'event-old'
               AND source_run_id = 'source-run-a') AS states`,
      );
      expect(oldWrites.rows[0]).toEqual({ claims: 0, states: 0 });
    });

    it("replays an old conversion that was never covered", async () => {
      await seedOldConversionWorld();
      const { matchRunId } = await publishMatchWorld();
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result.outcome).toBe("done");
      expect(result.processed).toBe(2);
      expect(fetchedExternalIds(client)).toContain("external-event-old");
      const graph = await graphRow(claimReplayId);
      expect(graph.status).toBe("success");
      expect(graph.conversions_complete).toBe(2);
      const oldClaims = await testPool!.query(
        `SELECT count(*)::int AS count FROM klaviyo_attribution_claim
          WHERE conversion_event_id = 'event-old'`,
      );
      expect(oldClaims.rows[0].count).toBe(1);
    });

    it("replays an old conversion whose only prior state is incomplete", async () => {
      await seedOldConversionWorld();
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-old",
        status: "incomplete",
        matchRunId,
      });
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result.outcome).toBe("done");
      expect(result.processed).toBe(2);
      expect(fetchedExternalIds(client)).toContain("external-event-old");
      const state = await testPool!.query(
        `SELECT status FROM klaviyo_claim_replay_state
          WHERE conversion_event_id = 'event-old'
            AND source_run_id = 'source-run-a'`,
      );
      expect(state.rows[0].status).toBe("complete");
    });

    it("re-replays a recent conversion that already has a complete state", async () => {
      await seedExtraConversionEvent(
        "event-recent",
        "external-event-recent",
        new Date(Date.now() - 2 * DAY_MS),
      );
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-recent",
        status: "complete",
        matchRunId,
      });
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result.outcome).toBe("done");
      expect(result.processed).toBe(2);
      expect(fetchedExternalIds(client)).toContain("external-event-recent");
      const recentClaims = await testPool!.query(
        `SELECT count(*)::int AS count FROM klaviyo_attribution_claim
          WHERE conversion_event_id = 'event-recent'`,
      );
      expect(recentClaims.rows[0].count).toBe(1);
    });

    it("completes success with zero conversions when every anchor is old and covered", async () => {
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-a",
        status: "complete",
        matchRunId,
      });
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result).toMatchObject({ outcome: "done", processed: 0 });
      expect(client.getEventById).not.toHaveBeenCalled();
      const graph = await graphRow(claimReplayId);
      expect(graph.status).toBe("success");
      expect(graph.conversions_complete).toBe(0);
      expect(graph.conversions_incomplete).toBe(0);
    });

    it("persists the lookback cutoff in the checkpoint across batch resume", async () => {
      for (let index = 1; index <= 5; index += 1) {
        await seedExtraConversionEvent(
          `event-x${index}`,
          `external-event-x${index}`,
          new Date(Date.now() - (10 + index) * 60 * 60 * 1000),
        );
      }
      const { matchRunId } = await publishMatchWorld();
      const startedAt = Date.now();
      const claimReplayId = await startGraph(matchRunId);
      const initial = (await graphRow(claimReplayId))
        .checkpoint as ClaimReplayCheckpoint;
      expect(typeof initial.lookbackCutoff).toBe("string");
      expect(
        Math.abs(
          Date.parse(initial.lookbackCutoff) - (startedAt - 14 * DAY_MS),
        ),
      ).toBeLessThan(60_000);

      const client = fakeClaimClient();
      const first = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(first.outcome).toBe("continue");
      expect(first.processed).toBe(5);
      const between = (await graphRow(claimReplayId))
        .checkpoint as ClaimReplayCheckpoint;
      expect(between.lookbackCutoff).toBe(initial.lookbackCutoff);

      const second = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(second.outcome).toBe("done");
      expect(second.processed).toBe(1);
      const graph = await graphRow(claimReplayId);
      expect(graph.status).toBe("success");
      expect(graph.conversions_complete).toBe(6);
      const claims = await testPool!.query(
        `SELECT count(*)::int AS count FROM klaviyo_attribution_claim`,
      );
      expect(claims.rows[0].count).toBe(6);
    });
  });
});

describe("klaviyo-claims trigger source boundary", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "trigger/klaviyo-claims.ts"),
    "utf8",
  );

  it("exports the claim task on the dedicated single-concurrency queue", () => {
    expect(source).toContain("export const klaviyoClaimsTask");
    expect(source).toContain('name: "klaviyo-claims"');
    expect(source).toContain("concurrencyLimit: 1");
    expect(source).toContain("maxDuration: 600");
  });

  it("uses only internal-tuple global keys with a seven-day TTL", () => {
    expect(source).toContain("`klaviyo-claims:first:${claimReplayId}`");
    expect(source).toContain(
      "`klaviyo-claims:${payload.claimReplayId}:${sourceRunId}:${matchRunId}:${result.checkpoint.phase}:${tupleHash(result.checkpoint)}`",
    );
    expect(source.match(/\{ scope: "global" \}/g)?.length).toBe(2);
    expect(source.match(/idempotencyKeyTTL: "7d"/g)?.length).toBe(2);
    expect(source).not.toContain("externalEventId");
  });

  it("recovers exhausted retries through the exact-attempt helper without raw errors", () => {
    expect(source).toContain("recoverExhaustedClaimBatch");
    expect(source).toContain("onFailure: async ({ payload })");
    expect(source).not.toMatch(/console\.log/);
  });
});
