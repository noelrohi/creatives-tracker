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
import {
  MATCH_SCOPE,
  applyMatchFixture,
  resolveConnectionString,
  seedMatchWorld,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_p4_isolation_test";
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

const matchService = await import("@/lib/klaviyo/match-service");
const claimRepository = await import("@/lib/klaviyo/claim-repository");
const reportRepository = await import("@/lib/klaviyo/report-repository");
const queries = await import("@/lib/klaviyo/queries");
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

function claimClient() {
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
          return {
            purpose: "attribution_claim",
            event: { type: "event", id: externalEventId },
            attributionIds: ["attribution-1"],
            attributions: [
              // Campaign/flow/message relationships deliberately absent —
              // unknown stays unknown, never inferred from names/reports.
              { type: "attribution", id: "attribution-1" },
            ],
          };
        }
        return {
          purpose: "referenced_interaction",
          event: { type: "event", id: externalEventId },
          metric: null,
        };
      }),
  };
}

function reportClient() {
  return {
    queryValuesReport: vi
      .fn<(input: unknown) => Promise<KlaviyoCompoundPage>>()
      .mockResolvedValue({
        data: [
          {
            type: "campaign-values-report",
            id: "report-1",
            attributes: {
              results: [
                {
                  groupings: { campaign_id: "campaign-ext-1" },
                  statistics: { conversions: 9, conversion_value: "500.00" },
                },
              ],
            },
          },
        ],
        included: [],
        nextCursor: null,
        apiRevision: "2026-07-15",
      }),
  };
}

async function snapshotTables(tables: string[], where = ""): Promise<string> {
  const chunks: string[] = [];
  for (const table of tables) {
    const rows = await testPool!.query(
      `SELECT to_jsonb(t) AS row FROM ${table} t ${where} ORDER BY to_jsonb(t)::text`,
    );
    chunks.push(JSON.stringify({ table, rows: rows.rows }));
  }
  return chunks.join("\n");
}

const TENANT_B_TABLES = [
  "shopify_order",
  "shopify_refund",
  "klaviyo_event",
  "klaviyo_match_run",
  "klaviyo_match_candidate",
  "klaviyo_event_match_result",
  "klaviyo_order_match_result",
  "klaviyo_attribution_claim",
  "klaviyo_report_generation",
  "klaviyo_report_fact",
];

async function seedTenantB(): Promise<void> {
  await testPool!.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-b', 'Org B', 'org-b', now())`,
  );
  await testPool!.query(
    `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
     VALUES ('store-b', 'org-b', 'b.example.com', 'UTC')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_connection
       (id, organization_id, shopify_store_id, klaviyo_account_id, status)
     VALUES ('connection-b', 'org-b', 'store-b', 'account-b', 'ready')`,
  );
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales, bucket, bucket_rule_version, meta_verified)
     VALUES ('order-b1', 'org-b', 'store-b', 'b-9001', '2026-07-20T10:00:00Z',
       '2026-07-20', 55, 'meta', 3, true)`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_metric
       (id, organization_id, shopify_store_id, connection_id,
        external_metric_id, name, canonical_kind, ingestion_enabled, api_revision)
     VALUES ('metric-b', 'org-b', 'store-b', 'connection-b', 'ext-placed-b',
       'Placed Order', 'placed_order', 1, '2026-07-15')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, attribution_relationship_ids,
        redacted_properties, key_type_fingerprint, warnings,
        product_evidence_completeness, source_checksum, api_revision)
     VALUES ('event-b1', 'org-b', 'store-b', 'connection-b', 'metric-b',
       'external-b1', '2026-07-20T10:05:00Z', '[]', '{}', '[]', '[]',
       'unavailable', 'checksum-b', '2026-07-15')`,
  );
}

describeIfDb("Plan 4 claims/reporting end-to-end isolation", () => {
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
    await seedTenantB();
    await testPool!.query(
      `UPDATE klaviyo_event
          SET attribution_relationship_ids = '["attribution-1"]'
        WHERE id = 'event-a'`,
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

  it("claims, reports, and a failed refresh change nothing they must not", async () => {
    const tenantBBefore = await snapshotTables(
      TENANT_B_TABLES,
      `WHERE t.organization_id = 'org-b'`,
    );
    const shopifyBefore = await snapshotTables(
      ["shopify_order", "shopify_refund"],
      `WHERE t.organization_id = 'org-a'`,
    );

    const published = await matchService.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    const matchStateBefore = await snapshotTables([
      "klaviyo_match_candidate",
    ]);
    const resultShapeBefore = await testPool!.query(
      `SELECT id, status, selected_candidate_id, selected_class,
              selected_event_id, product_status, matcher_version
         FROM klaviyo_order_match_result ORDER BY id`,
    );

    // Claims refresh.
    const claimStart = await claimRepository.startOrResumeClaimReplay({
      scope,
      sourceRunId: "source-run-a",
      matchRunId: published.runId,
      now: new Date(),
    });
    if (claimStart.kind !== "started") throw new Error("claim start failed");
    await claimRepository.processClaimBatch(
      { scope, claimReplayId: claimStart.claimReplayId },
      {
        createClient: () => claimClient(),
        credentialProvider: fakeCredentialProvider,
        verifyWriterReadiness: async () => ({ ready: true }),
      },
    );

    // Report refresh, then a second refresh failed mid-staging.
    const reportStart = await reportRepository.startOrResumeReportSync({
      scope,
      window: {
        from: new Date("2026-07-01T00:00:00Z"),
        to: new Date("2026-08-01T00:00:00Z"),
      },
      kinds: ["campaign"],
      reason: "manual",
      now: new Date(),
    });
    if (reportStart.kind !== "started") throw new Error("report start failed");
    await reportRepository.processReportBatch(
      { scope, syncRunId: reportStart.syncRunId },
      {
        createClient: () => reportClient(),
        credentialProvider: fakeCredentialProvider,
        spacer: async () => {},
      },
    );
    const failedRefresh = await reportRepository.startOrResumeReportSync({
      scope,
      window: {
        from: new Date("2026-07-01T00:00:00Z"),
        to: new Date("2026-08-01T00:00:00Z"),
      },
      kinds: ["campaign"],
      reason: "manual",
      now: new Date(),
    });
    if (failedRefresh.kind !== "started") throw new Error("second start failed");
    await reportRepository.failReportSync({
      scope,
      syncRunId: failedRefresh.syncRunId,
      now: new Date(),
    });

    // 1. The other tenant is byte-for-byte unchanged.
    const tenantBAfter = await snapshotTables(
      TENANT_B_TABLES,
      `WHERE t.organization_id = 'org-b'`,
    );
    expect(tenantBAfter).toBe(tenantBBefore);

    // 2. Shopify order/refund/money/bucket/Meta fields unchanged.
    const shopifyAfter = await snapshotTables(
      ["shopify_order", "shopify_refund"],
      `WHERE t.organization_id = 'org-a'`,
    );
    expect(shopifyAfter).toBe(shopifyBefore);

    // 3. Candidates and result selection/status/confidence untouched by
    // claims or reports; only claim_count on the canonical result moved.
    const matchStateAfter = await snapshotTables(["klaviyo_match_candidate"]);
    expect(matchStateAfter).toBe(matchStateBefore);
    const resultShapeAfter = await testPool!.query(
      `SELECT id, status, selected_candidate_id, selected_class,
              selected_event_id, product_status, matcher_version
         FROM klaviyo_order_match_result ORDER BY id`,
    );
    expect(resultShapeAfter.rows).toEqual(resultShapeBefore.rows);
    const claimCount = await testPool!.query(
      `SELECT claim_count FROM klaviyo_order_match_result
        WHERE order_id = 'order-a' AND superseded_at IS NULL`,
    );
    expect(claimCount.rows[0].claim_count).toBe(1);

    // 4. Missing relationships stayed null/unknown.
    const claim = await testPool!.query(
      `SELECT campaign_object_id, flow_object_id, message_object_id,
              variation_object_id, unknown_reason_codes
         FROM klaviyo_attribution_claim WHERE conversion_event_id = 'event-a'`,
    );
    expect(claim.rows[0]).toMatchObject({
      campaign_object_id: null,
      flow_object_id: null,
      message_object_id: null,
      variation_object_id: null,
    });

    // 5. Report facts cannot appear in an order claim or explanation.
    const chain = await queries.loadOrderClaims({ scope, orderId: "order-a" });
    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    const projections = JSON.stringify({ chain, explanation });
    expect(projections).not.toContain("500.00");
    expect(projections).not.toContain("recipients");
    expect(projections).not.toContain("conversionValue");

    // 6. Previous current report facts survive the failed refresh.
    const facts = await reportRepository.listCurrentReportFacts({
      scope,
      kind: "campaign",
    });
    expect(facts.facts).toHaveLength(1);

    // 7. No raw identity, URL query, or property data in stored rows or
    // safe projections.
    const stored = await snapshotTables([
      "klaviyo_attribution_claim",
      "klaviyo_claim_replay_state",
      "klaviyo_claim_replay_run",
      "klaviyo_report_generation",
      "klaviyo_report_fact",
    ]);
    expect(stored).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(stored).not.toContain("?utm_");
    expect(stored).not.toContain("privateApiKey");
    expect(projections).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("keeps journey membership on the exact profile only", async () => {
    await matchService.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    await testPool!.query(
      `UPDATE klaviyo_event SET profile_id = 'profile-a' WHERE id = 'event-a'`,
    );
    // A same-window event for another profile, canonically ingested.
    await testPool!.query(
      `INSERT INTO klaviyo_metric
         (id, organization_id, shopify_store_id, connection_id,
          external_metric_id, name, canonical_kind, ingestion_enabled, api_revision)
       VALUES ('metric-click', 'org-a', 'store-a', 'connection-a',
         'metric-ext-click', 'Clicked Email', 'clicked_email', 0, '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, profile_id,
          attribution_relationship_ids, redacted_properties,
          key_type_fingerprint, warnings, product_evidence_completeness,
          source_checksum, api_revision)
       VALUES ('event-other-profile', 'org-a', 'store-a', 'connection-a',
         'metric-click', 'external-other', '2026-07-20T09:00:00Z',
         'profile-other', '[]', '{}', '[]', '[]', 'unavailable',
         'other-checksum', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters, finished_at)
       VALUES ('journey-run-a', 'org-a', 'store-a', 'connection-a', 'events',
         'manual', 'success', NULL,
         '{"sourceMode":"journey","metricKinds":["clicked_email","clicked_sms","active_on_site","viewed_product","added_to_cart","checkout_started"]}',
         now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_run_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, observed_source_checksum)
       VALUES ('org-a', 'store-a', 'connection-a', 'journey-run-a',
         'event-other-profile', 'other-checksum')`,
    );
    const journey = await queries.loadOrderJourney({
      scope,
      orderId: "order-a",
      lookbackDays: 7,
    });
    if (journey.kind !== "journey") throw new Error("expected journey");
    expect(journey.events).toEqual([]);
    expect(JSON.stringify(journey)).not.toContain("profile-other");
  });
});
