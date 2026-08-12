import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mockState = {
  executeRows: [] as Array<Record<string, unknown>[]>,
  executedSql: [] as unknown[],
};

const mockDb = {
  execute: vi.fn(async (query: unknown) => {
    mockState.executedSql.push(query);
    return { rows: mockState.executeRows.shift() ?? [], rowCount: 0 };
  }),
};

function compileSql(query: unknown): string {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));

const { planRetention } = await import("./plan");
const { retentionCutoffs } = await import("./shared");

const ORG = "org_plan_test";
const TODAY = "2026-08-12";

describe("planRetention", () => {
  beforeEach(() => {
    mockState.executeRows = [];
    mockState.executedSql = [];
    vi.clearAllMocks();
  });

  it("reports every category with the policy cutoffs", async () => {
    const plan = await planRetention({ organizationId: ORG, today: TODAY });

    expect(plan.cutoffs).toEqual(retentionCutoffs(TODAY));
    expect(plan.cutoffs).toEqual({
      base: "2026-02-13",
      breakdown: "2026-07-29",
      evidence: "2026-05-14",
    });
    expect(plan.categories.map((category) => category.key)).toEqual([
      "performance_breakdown",
      "performance_base",
      "klaviyo_event",
      "shopify_order_line",
      "source_identity_hmac",
      "shopify_evidence_run_identity_observation",
      "shopify_evidence_run_observation",
      "klaviyo_sync_run",
      "shopify_evidence_sync_run",
    ]);
  });

  it("totals candidate rows across categories", async () => {
    mockState.executeRows.push(
      [{ candidate_rows: 7, oldest_date: "2026-01-01", newest_date: "2026-07-28" }],
      [{ candidate_rows: 3, oldest_date: "2026-01-01", newest_date: "2026-02-12" }],
    );

    const plan = await planRetention({ organizationId: ORG, today: TODAY });

    expect(plan.categories[0]).toEqual({
      key: "performance_breakdown",
      table: "performance_log",
      candidateRows: 7,
      oldestDate: "2026-01-01",
      newestDate: "2026-07-28",
    });
    expect(plan.categories[1].candidateRows).toBe(3);
    expect(plan.totalCandidateRows).toBe(10);
  });

  it("scopes performance categories by grain and date_end", async () => {
    await planRetention({ organizationId: ORG, today: TODAY });

    const breakdown = compileSql(mockState.executedSql[0]).toLowerCase();
    const base = compileSql(mockState.executedSql[1]).toLowerCase();

    expect(breakdown).toContain("from performance_log pl");
    expect(breakdown).toContain("pl.organization_id = $1");
    expect(breakdown).toContain("not (coalesce(pl.country, '') = ''");
    expect(breakdown).toContain("pl.date_end < $2::date");
    expect(base).toContain("and coalesce(pl.country, '') = ''");
    expect(base).toContain("pl.date_end < $2::date");
  });

  it("guards sync-run categories with NOT EXISTS on surviving observations", async () => {
    await planRetention({ organizationId: ORG, today: TODAY });

    const klaviyoRun = compileSql(mockState.executedSql[7]).toLowerCase();
    const shopifyRun = compileSql(mockState.executedSql[8]).toLowerCase();

    expect(klaviyoRun).toContain("ksr.status in ('success', 'partial', 'failed')");
    expect(klaviyoRun).toContain("ksr.requested_to < $2::timestamp");
    expect(klaviyoRun).toContain("not exists");
    expect(klaviyoRun).toContain("from klaviyo_event_run_observation kero");
    expect(shopifyRun).toContain("sesr.status in ('success', 'partial', 'failed')");
    expect(shopifyRun).toContain("from shopify_evidence_run_observation sero");
  });

  it("never touches the excluded tables", async () => {
    await planRetention({ organizationId: ORG, today: TODAY });

    const allSql = mockState.executedSql
      .map((query) => compileSql(query).toLowerCase())
      .join("\n");

    for (const table of [
      "shopify_order ",
      "shopify_refund",
      "identity_matching_key_binding",
      "identity_erasure_suppression",
      "identity_crypto_policy",
      "identity_pilot_uninstall_receipt",
      "klaviyo_report_fact",
      "klaviyo_connection",
    ]) {
      expect(allSql).not.toContain(table);
    }
  });
});
