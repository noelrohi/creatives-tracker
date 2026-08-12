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
    const { matchRunId } = await publishMatchWorld();
    const claimReplayId = await startGraph(matchRunId);
    const dependencies = {
      createClient: () => fakeClaimClient(),
      credentialProvider: fakeCredentialProvider,
      verifyWriterReadiness: gateOpen,
    };
    await repository.processClaimBatch({ scope, claimReplayId }, dependencies);
    // A second graph replays the same conversions: unchanged checksums are
    // skipped in phase missing, both bounded retry phases stay empty.
    const secondStart = await repository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId,
      now: new Date(),
    });
    expect(secondStart.kind).toBe("started");
    if (secondStart.kind !== "started") throw new Error("unreachable");
    const second = await repository.processClaimBatch(
      { scope, claimReplayId: secondStart.claimReplayId },
      dependencies,
    );
    expect(second).toMatchObject({ outcome: "done", processed: 0 });
    const claims = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_attribution_claim`,
    );
    expect(claims.rows[0].count).toBe(1);
    const order = await testPool!.query(
      `SELECT claim_count FROM klaviyo_order_match_result WHERE run_id = $1`,
      [matchRunId],
    );
    expect(order.rows[0].claim_count).toBe(1);
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
