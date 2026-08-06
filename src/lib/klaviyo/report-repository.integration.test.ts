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
import type { KlaviyoCompoundPage } from "@/lib/klaviyo/client";
import type {
  KlaviyoCredentialProvider,
  ResolvedKlaviyoCredential,
} from "@/lib/klaviyo/credential-provider";
import {
  MATCH_FIXTURE_DDL,
  migrationStatements,
  resolveConnectionString,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_report_test";
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

const repository = await import("@/lib/klaviyo/report-repository");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = {
  organizationId: "org-a",
  storeId: "store-a",
  connectionId: "connection-a",
};

const WINDOW = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
};

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

function reportPage(
  rows: Array<Record<string, unknown>>,
  pageCursor: string | null = null,
): KlaviyoCompoundPage {
  return {
    data: [
      {
        type: "campaign-values-report",
        id: "report-1",
        attributes: {
          results: rows,
          ...(pageCursor !== null ? { page_cursor: pageCursor } : {}),
        },
      },
    ],
    included: [],
    nextCursor: null,
    apiRevision: "2026-07-15",
  };
}

function fakeReportClient(spacerLog: number[] = []) {
  void spacerLog;
  return {
    queryValuesReport: vi
      .fn<
        (input: {
          request: { kind: string };
          pageCursor: string | null;
        }) => Promise<KlaviyoCompoundPage>
      >()
      .mockImplementation(async ({ request }) =>
        request.kind === "campaign"
          ? reportPage([
              {
                groupings: { campaign_id: "campaign-ext-1", send_date: "2026-07-15" },
                statistics: { conversions: 3, conversion_value: "99.50" },
              },
            ])
          : reportPage([
              {
                groupings: { flow_id: "flow-ext-1", send_date: "2026-07-16" },
                statistics: { conversions: 2 },
              },
            ]),
      ),
  };
}

async function startRun(
  kinds: Array<"campaign" | "flow">,
  reason: "manual" | "scheduled" = "manual",
  now = new Date(),
) {
  return repository.startOrResumeReportSync({
    scope,
    window: WINDOW,
    kinds,
    reason,
    now,
  });
}

describeIfDb("Klaviyo report repository on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    for (const statement of MATCH_FIXTURE_DDL) await testPool!.query(statement);
    for (const migration of [
      "0053_klaviyo_shopify_evidence.sql",
      "0054_klaviyo_source_core.sql",
      "0055_klaviyo_advisory_matching.sql",
      "0056_klaviyo_claims_reporting.sql",
    ]) {
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
      `TRUNCATE klaviyo_connection, shopify_store, organization
         RESTART IDENTITY CASCADE`,
    );
    await testPool!.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-a', 'Org A', 'org-a', now())`,
    );
    await testPool!.query(
      `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
       VALUES ('store-a', 'org-a', 'a.example.com', 'America/New_York')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_connection
         (id, organization_id, shopify_store_id, klaviyo_account_id, timezone, status)
       VALUES ('connection-a', 'org-a', 'store-a', 'account-a',
         'America/New_York', 'ready')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_metric
         (id, organization_id, shopify_store_id, connection_id,
          external_metric_id, name, canonical_kind, ingestion_enabled, api_revision)
       VALUES ('metric-placed', 'org-a', 'store-a', 'connection-a',
         'metric-ext-placed', 'Placed Order', 'placed_order', 1, '2026-07-15')`,
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

  it("stages one generation per kind, reuses a compatible live run with its asOf", async () => {
    const first = await startRun(["campaign", "flow"]);
    expect(first.kind).toBe("started");
    if (first.kind === "fresh") throw new Error("unreachable");
    expect(first.stagedKinds).toEqual(["campaign", "flow"]);
    const again = await startRun(["campaign", "flow"]);
    expect(again).toMatchObject({
      kind: "pending",
      syncRunId: first.syncRunId,
      asOf: first.asOf,
    });
    await expect(startRun(["campaign"])).rejects.toThrow(
      "different Klaviyo report run",
    );
    const generations = await testPool!.query(
      `SELECT kind, status FROM klaviyo_report_generation
        WHERE sync_run_id = $1 ORDER BY kind`,
      [first.syncRunId],
    );
    expect(generations.rows).toEqual([
      { kind: "campaign", status: "staging" },
      { kind: "flow", status: "staging" },
    ]);
  });

  it("processes, spaces low-quota calls, and swaps generations atomically", async () => {
    const start = await startRun(["campaign", "flow"]);
    if (start.kind !== "started") throw new Error("expected started");
    const spacerWaits: number[] = [];
    const client = fakeReportClient();
    const result = await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
        spacer: async (milliseconds) => {
          spacerWaits.push(milliseconds);
        },
      },
    );
    expect(result.done).toBe(true);
    expect(client.queryValuesReport).toHaveBeenCalledTimes(2);
    expect(spacerWaits).toEqual([1100]);

    const run = await testPool!.query(
      `SELECT status FROM klaviyo_sync_run WHERE id = $1`,
      [start.syncRunId],
    );
    expect(run.rows[0].status).toBe("success");
    const generations = await testPool!.query(
      `SELECT kind, status, fact_count FROM klaviyo_report_generation
        WHERE sync_run_id = $1 ORDER BY kind`,
      [start.syncRunId],
    );
    expect(generations.rows).toEqual([
      { kind: "campaign", status: "current", fact_count: 1 },
      { kind: "flow", status: "current", fact_count: 1 },
    ]);
    const facts = await testPool!.query(
      `SELECT report_kind, campaign_object_id, conversions, conversion_value
         FROM klaviyo_report_fact ORDER BY report_kind`,
    );
    expect(facts.rows[0]).toMatchObject({
      report_kind: "campaign",
      campaign_object_id: "campaign-row-1",
      conversions: "3",
      conversion_value: "99.50",
    });
    const connection = await testPool!.query(
      `SELECT last_report_synced_at FROM klaviyo_connection
        WHERE id = 'connection-a'`,
    );
    expect(connection.rows[0].last_report_synced_at).not.toBeNull();
  });

  it("keeps freshness server-side: scheduled skips fresh kinds, manual forces", async () => {
    const start = await startRun(["campaign"]);
    if (start.kind !== "started") throw new Error("expected started");
    await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      {
        createClient: () => fakeReportClient(),
        credentialProvider: fakeCredentialProvider,
        spacer: async () => {},
      },
    );
    const scheduled = await startRun(["campaign"], "scheduled");
    expect(scheduled).toEqual({ kind: "fresh" });
    const mixed = await startRun(["campaign", "flow"], "scheduled");
    expect(mixed.kind).toBe("started");
    if (mixed.kind === "fresh") throw new Error("unreachable");
    expect(mixed.stagedKinds).toEqual(["flow"]);
    await repository.processReportBatch(
      { scope, syncRunId: mixed.syncRunId },
      {
        createClient: () => fakeReportClient(),
        credentialProvider: fakeCredentialProvider,
        spacer: async () => {},
      },
    );
    const manual = await startRun(["campaign"], "manual");
    expect(manual.kind).toBe("started");
  });

  it("replaces only the refreshed slot and supersedes the prior current", async () => {
    const combined = await startRun(["campaign", "flow"]);
    if (combined.kind !== "started") throw new Error("expected started");
    const dependencies = {
      createClient: () => fakeReportClient(),
      credentialProvider: fakeCredentialProvider,
      spacer: async () => {},
    };
    await repository.processReportBatch(
      { scope, syncRunId: combined.syncRunId },
      dependencies,
    );
    const campaignOnly = await startRun(["campaign"], "manual");
    if (campaignOnly.kind !== "started") throw new Error("expected started");
    await repository.processReportBatch(
      { scope, syncRunId: campaignOnly.syncRunId },
      dependencies,
    );
    const slots = await testPool!.query(
      `SELECT kind, status, count(*)::int AS count
         FROM klaviyo_report_generation
        GROUP BY kind, status ORDER BY kind, status`,
    );
    expect(slots.rows).toEqual([
      { kind: "campaign", status: "current", count: 1 },
      { kind: "campaign", status: "superseded", count: 1 },
      { kind: "flow", status: "current", count: 1 },
    ]);
    const currentCampaign = await testPool!.query(
      `SELECT sync_run_id FROM klaviyo_report_generation
        WHERE kind = 'campaign' AND status = 'current'`,
    );
    expect(currentCampaign.rows[0].sync_run_id).toBe(campaignOnly.syncRunId);
  });

  it("fails staging generations atomically and preserves previous current facts", async () => {
    const first = await startRun(["campaign"]);
    if (first.kind !== "started") throw new Error("expected started");
    const dependencies = {
      createClient: () => fakeReportClient(),
      credentialProvider: fakeCredentialProvider,
      spacer: async () => {},
    };
    await repository.processReportBatch(
      { scope, syncRunId: first.syncRunId },
      dependencies,
    );
    const second = await startRun(["campaign"], "manual");
    if (second.kind !== "started") throw new Error("expected started");
    const failed = await repository.failReportSync({
      scope,
      syncRunId: second.syncRunId,
      now: new Date(),
    });
    expect(failed).toEqual({ changed: true });
    const replay = await repository.failReportSync({
      scope,
      syncRunId: second.syncRunId,
      now: new Date(),
    });
    expect(replay).toEqual({ changed: false });
    const generations = await testPool!.query(
      `SELECT status, count(*)::int AS count FROM klaviyo_report_generation
        WHERE kind = 'campaign' GROUP BY status ORDER BY status`,
    );
    expect(generations.rows).toEqual([
      { status: "current", count: 1 },
      { status: "failed", count: 1 },
    ]);
    const current = await repository.listCurrentReportFacts({
      scope,
      kind: "campaign",
    });
    expect(current.facts).toHaveLength(1);
    const run = await testPool!.query(
      `SELECT status, error_code FROM klaviyo_sync_run WHERE id = $1`,
      [second.syncRunId],
    );
    expect(run.rows[0]).toEqual({
      status: "failed",
      error_code: "KLAVIYO_REPORT_FAILED",
    });
  });

  it("reads only the single current generation per slot", async () => {
    const start = await startRun(["campaign"]);
    if (start.kind !== "started") throw new Error("expected started");
    // Staging facts are invisible before publication.
    const before = await repository.listCurrentReportFacts({
      scope,
      kind: "campaign",
    });
    expect(before.facts).toEqual([]);
    await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      {
        createClient: () => fakeReportClient(),
        credentialProvider: fakeCredentialProvider,
        spacer: async () => {},
      },
    );
    const after = await repository.listCurrentReportFacts({
      scope,
      kind: "campaign",
    });
    expect(after.facts).toHaveLength(1);
    expect(after.facts[0].conversions).toBe("3");
  });

  it("reaps an expired report lease before staging a replacement", async () => {
    const first = await startRun(["campaign"]);
    if (first.kind !== "started") throw new Error("expected started");
    await testPool!.query(
      `UPDATE klaviyo_sync_run
          SET heartbeat_at = now() - interval '30 minutes' WHERE id = $1`,
      [first.syncRunId],
    );
    const replacement = await startRun(["campaign"]);
    expect(replacement.kind).toBe("started");
    if (replacement.kind === "fresh") throw new Error("unreachable");
    expect(replacement.syncRunId).not.toBe(first.syncRunId);
    const reaped = await testPool!.query(
      `SELECT status FROM klaviyo_sync_run WHERE id = $1`,
      [first.syncRunId],
    );
    expect(reaped.rows[0].status).toBe("failed");
    const staleGenerations = await testPool!.query(
      `SELECT status FROM klaviyo_report_generation WHERE sync_run_id = $1`,
      [first.syncRunId],
    );
    expect(staleGenerations.rows).toEqual([{ status: "failed" }]);
  });
});

describe("klaviyo-reports trigger source boundary", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "trigger/klaviyo-reports.ts"),
    "utf8",
  );

  it("uses the dedicated low-quota queue with single concurrency", () => {
    expect(source).toContain("export const klaviyoReportsTask");
    expect(source).toContain('name: "klaviyo-reports-low-quota"');
    expect(source).toContain("concurrencyLimit: 1");
    expect(source).toContain("maxDuration: 600");
  });

  it("schedules checkpoint-keyed global continuations and first handoff", () => {
    expect(source).toContain(
      "`klaviyo:reports:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`",
    );
    expect(source).toContain("`klaviyo:reports:first:${syncRunId}`");
    expect(source.match(/\{ scope: "global" \}/g)?.length).toBe(2);
    expect(source.match(/idempotencyKeyTTL: "7d"/g)?.length).toBe(2);
  });

  it("routes every failure through the report-specific wrapper", () => {
    expect(source).toContain("failReportSync");
    expect(source).not.toContain("failKlaviyoSyncRunAfterRetryExhaustion");
  });
});
