import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

// Retention is aggregate SQL, batched deletes and an upsert — only a real
// Postgres proves the counts — so this runs the fixture schema into a
// throwaway database. The configured DATABASE_URL database is never written
// to; only its host credentials are reused.
function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_retention_lib_test";

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const testPool = baseConnectionString
  ? new Pool({ connectionString: withDatabase(baseConnectionString, TEST_DATABASE) })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("server-only", () => ({}));

const { planRetention } = await import("./plan");
const { executeRetention } = await import("./execute");
const { rollupMonthlySummaries } = await import("./rollup");
const { retentionCutoffs } = await import("./shared");

const ORG = "org_retention_test";
const OTHER_ORG = "org_other";
const TODAY = "2026-08-12";
const CUTOFFS = retentionCutoffs(TODAY);

function shiftYmd(ymd: string, days: number) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The committed migration chain is not replayable from an empty database, so
// the fixture transcribes only the columns retention reads and writes.
// Evidence tables carry no foreign keys here — cascades are exercised by
// Postgres in production; what is under test is the predicate and the order.
const FIXTURE_DDL = [
  `CREATE TABLE performance_log (
     id text PRIMARY KEY,
     ad_id text NOT NULL,
     spend numeric,
     purchase_value numeric,
     purchase_value_7d_click numeric,
     purchase_value_1d_view numeric,
     conversions integer,
     impressions integer,
     reach integer,
     link_clicks integer,
     clicks_all integer,
     landing_page_views integer,
     add_to_cart integer,
     initiate_checkout integer,
     video_views_3s integer,
     video_thruplay integer,
     country text,
     platform text,
     placement text,
     device text,
     age text,
     gender text,
     date_start date NOT NULL,
     date_end date NOT NULL,
     organization_id text
   )`,
  `CREATE TABLE performance_monthly_summary (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     month date NOT NULL,
     spend numeric,
     purchase_value numeric,
     purchase_value_7d_click numeric,
     purchase_value_1d_view numeric,
     conversions integer,
     impressions integer,
     link_clicks integer,
     clicks_all integer,
     landing_page_views integer,
     add_to_cart integer,
     initiate_checkout integer,
     video_views_3s integer,
     video_thruplay integer,
     days_with_data integer NOT NULL DEFAULT 0,
     source_row_count integer NOT NULL DEFAULT 0,
     rolled_up_at timestamp NOT NULL DEFAULT now(),
     created_at timestamp NOT NULL DEFAULT now(),
     updated_at timestamp NOT NULL DEFAULT now(),
     CONSTRAINT performance_monthly_summary_org_month_uniq UNIQUE (organization_id, month)
   )`,
  `CREATE TABLE klaviyo_event (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     shopify_store_id text NOT NULL,
     connection_id text NOT NULL,
     occurred_at timestamp NOT NULL
   )`,
  `CREATE TABLE klaviyo_event_run_observation (
     organization_id text NOT NULL,
     shopify_store_id text NOT NULL,
     connection_id text NOT NULL,
     sync_run_id text NOT NULL,
     event_id text NOT NULL,
     observed_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE klaviyo_sync_run (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     shopify_store_id text NOT NULL,
     connection_id text NOT NULL,
     status text NOT NULL,
     requested_to timestamp
   )`,
  `CREATE TABLE shopify_order_line (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     order_id text NOT NULL,
     created_at timestamp NOT NULL
   )`,
  `CREATE TABLE source_identity_hmac (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     created_at timestamp NOT NULL
   )`,
  `CREATE TABLE shopify_evidence_sync_run (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     status text NOT NULL,
     requested_to timestamp NOT NULL
   )`,
  `CREATE TABLE shopify_evidence_run_observation (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     evidence_run_id text NOT NULL,
     order_id text NOT NULL,
     observed_at timestamp NOT NULL
   )`,
  `CREATE TABLE shopify_evidence_run_identity_observation (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     evidence_run_id text NOT NULL,
     order_id text NOT NULL,
     identity_hmac_id text NOT NULL,
     observed_at timestamp NOT NULL
   )`,
  // Cascade tables: transcribed with the ON DELETE CASCADE FKs the plan's
  // blast-radius counts and the event-delete tests depend on.
  `CREATE TABLE klaviyo_attribution_claim (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     conversion_event_id text NOT NULL REFERENCES klaviyo_event(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE klaviyo_match_candidate (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     event_id text NOT NULL REFERENCES klaviyo_event(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE klaviyo_event_match_result (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     event_id text NOT NULL REFERENCES klaviyo_event(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE klaviyo_order_match_result (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     selected_event_id text REFERENCES klaviyo_event(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE klaviyo_product_evidence_link (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     ordered_product_event_id text NOT NULL REFERENCES klaviyo_event(id) ON DELETE CASCADE,
     placed_order_event_id text NOT NULL REFERENCES klaviyo_event(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE klaviyo_event_product (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     event_id text NOT NULL REFERENCES klaviyo_event(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE klaviyo_match_run (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     connection_id text NOT NULL,
     source_run_id text NOT NULL,
     shopify_evidence_run_id text NOT NULL
   )`,
];

const TABLES = [
  "performance_log",
  "performance_monthly_summary",
  "klaviyo_event",
  "klaviyo_event_run_observation",
  "klaviyo_sync_run",
  "shopify_order_line",
  "source_identity_hmac",
  "shopify_evidence_sync_run",
  "shopify_evidence_run_observation",
  "shopify_evidence_run_identity_observation",
  "klaviyo_attribution_claim",
  "klaviyo_match_candidate",
  "klaviyo_event_match_result",
  "klaviyo_order_match_result",
  "klaviyo_product_evidence_link",
  "klaviyo_event_product",
  "klaviyo_match_run",
];

type PerfRow = {
  id: string;
  date: string;
  spend?: number;
  purchaseValue?: number;
  conversions?: number;
  impressions?: number;
  linkClicks?: number;
  age?: string;
  dateEnd?: string;
  organizationId?: string;
};

async function seedPerf(row: PerfRow) {
  await testDb!.execute(sql`
    INSERT INTO performance_log (
      id, ad_id, spend, purchase_value, conversions, impressions, link_clicks,
      age, date_start, date_end, organization_id
    ) VALUES (
      ${row.id}, ${"ad_1"}, ${row.spend ?? null}, ${row.purchaseValue ?? null},
      ${row.conversions ?? null}, ${row.impressions ?? null}, ${row.linkClicks ?? null},
      ${row.age ?? null}, ${row.date}, ${row.dateEnd ?? row.date},
      ${row.organizationId ?? ORG}
    )
  `);
}

async function countRows(table: string, organizationId = ORG) {
  const result = await testDb!.execute(sql`
    SELECT count(*)::integer AS count FROM ${sql.raw(table)}
    WHERE organization_id = ${organizationId}
  `);
  return Number((result.rows[0] as { count: number }).count);
}

async function idsIn(table: string) {
  const result = await testDb!.execute(sql`
    SELECT id FROM ${sql.raw(table)} ORDER BY id
  `);
  return result.rows.map((row) => (row as { id: string }).id);
}

const describeIfDb = baseConnectionString ? describe : describe.skip;

describeIfDb("retention library", () => {
  beforeAll(async () => {
    const adminPool = new Pool({
      connectionString: withDatabase(baseConnectionString!, "postgres"),
    });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
      await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    } finally {
      await adminPool.end();
    }
    for (const statement of FIXTURE_DDL) {
      await testDb!.execute(sql.raw(statement));
    }
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
  });

  beforeEach(async () => {
    await testDb!.execute(
      sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`),
    );
  });

  describe("performance rows", () => {
    beforeEach(async () => {
      // Retained base rows across two months.
      await seedPerf({
        id: "base_aug_01",
        date: "2026-08-01",
        spend: 100,
        purchaseValue: 400,
        conversions: 4,
        impressions: 1000,
        linkClicks: 50,
      });
      await seedPerf({
        id: "base_aug_02",
        date: "2026-08-02",
        spend: 50,
        purchaseValue: 100,
        conversions: 1,
        impressions: 500,
        linkClicks: 25,
      });
      await seedPerf({
        id: "base_jul_01",
        date: "2026-07-15",
        spend: 20,
        purchaseValue: 60,
        conversions: 2,
        impressions: 200,
        linkClicks: 10,
      });
      // Expired base rows: one on the last expired day, one a month earlier.
      await seedPerf({
        id: "base_expired_1",
        date: shiftYmd(CUTOFFS.base, -1),
        spend: 999,
        conversions: 9,
        impressions: 99,
      });
      await seedPerf({
        id: "base_expired_2",
        date: shiftYmd(CUTOFFS.base, -40),
        spend: 888,
        conversions: 8,
        impressions: 88,
      });
      // Exactly on the cutoff: retained (cutoffs are exclusive).
      await seedPerf({
        id: "base_on_cutoff",
        date: CUTOFFS.base,
        spend: 7,
        purchaseValue: 14,
        conversions: 1,
        impressions: 70,
        linkClicks: 7,
      });
      // Legacy multi-day base row, expired by date_end.
      await seedPerf({
        id: "base_legacy_multiday",
        date: shiftYmd(CUTOFFS.base, -20),
        dateEnd: shiftYmd(CUTOFFS.base, -10),
        spend: 500,
      });
      // Breakdown rows: retained, on-cutoff retained, expired.
      await seedPerf({
        id: "bd_recent",
        date: "2026-08-05",
        spend: 10,
        age: "25-34",
      });
      await seedPerf({
        id: "bd_on_cutoff",
        date: CUTOFFS.breakdown,
        spend: 10,
        age: "25-34",
      });
      await seedPerf({
        id: "bd_expired_1",
        date: shiftYmd(CUTOFFS.breakdown, -1),
        spend: 11,
        age: "25-34",
      });
      await seedPerf({
        id: "bd_expired_2",
        date: shiftYmd(CUTOFFS.base, -5),
        spend: 12,
        age: "35-44",
      });
      // Another organization: never a candidate.
      await seedPerf({
        id: "other_org_expired",
        date: shiftYmd(CUTOFFS.base, -30),
        spend: 1,
        organizationId: OTHER_ORG,
      });
    });

    it("counts candidates per grain with their date extents", async () => {
      const plan = await planRetention({ organizationId: ORG, today: TODAY });

      expect(plan.cutoffs).toEqual(CUTOFFS);
      const breakdown = plan.categories.find(
        (category) => category.key === "performance_breakdown",
      );
      const base = plan.categories.find(
        (category) => category.key === "performance_base",
      );
      const multiDay = plan.categories.find(
        (category) => category.key === "performance_base_multi_day",
      );

      expect(breakdown).toEqual({
        key: "performance_breakdown",
        table: "performance_log",
        candidateRows: 2,
        oldestDate: shiftYmd(CUTOFFS.base, -5),
        newestDate: shiftYmd(CUTOFFS.breakdown, -1),
        cascadeOnly: false,
      });
      expect(base).toEqual({
        key: "performance_base",
        table: "performance_log",
        candidateRows: 2,
        oldestDate: shiftYmd(CUTOFFS.base, -40),
        newestDate: shiftYmd(CUTOFFS.base, -1),
        cascadeOnly: false,
      });
      // Legacy multi-day rows are counted apart: their spend leaves without
      // ever entering a monthly summary, and the approver must see that.
      expect(multiDay).toEqual({
        key: "performance_base_multi_day",
        table: "performance_log",
        candidateRows: 1,
        oldestDate: shiftYmd(CUTOFFS.base, -10),
        newestDate: shiftYmd(CUTOFFS.base, -10),
        cascadeOnly: false,
      });
    });

    it("defaults to a dry run that deletes nothing", async () => {
      const result = await executeRetention({ organizationId: ORG, today: TODAY });

      expect(result.dryRun).toBe(true);
      expect(result.deleted).toEqual({});
      expect(await countRows("performance_log")).toBe(11);
      expect(await countRows("performance_monthly_summary")).toBe(0);
    });

    it("deletes only expired rows and rolls months up first", async () => {
      const result = await executeRetention({
        organizationId: ORG,
        today: TODAY,
        dryRun: false,
        batchSize: 2,
      });

      expect(result.dryRun).toBe(false);
      expect(result.deleted.performance_breakdown).toBe(2);
      expect(result.deleted.performance_base).toBe(2);
      expect(result.deleted.performance_base_multi_day).toBe(1);

      expect(await idsIn("performance_log")).toEqual([
        "base_aug_01",
        "base_aug_02",
        "base_jul_01",
        "base_on_cutoff",
        "bd_on_cutoff",
        "bd_recent",
        "other_org_expired",
      ]);

      const summaries = await testDb!.execute(sql`
        SELECT month::text AS month, spend::float8 AS spend,
               purchase_value::float8 AS purchase_value, conversions,
               impressions, link_clicks, days_with_data, source_row_count
        FROM performance_monthly_summary
        WHERE organization_id = ${ORG}
        ORDER BY month
      `);
      const rows = summaries.rows as Array<Record<string, number | string>>;
      const august = rows.find((row) => row.month === "2026-08-01");

      // Rollup ran before the deletes, so the expired months are captured.
      expect(rows.map((row) => row.month)).toEqual([
        `${shiftYmd(CUTOFFS.base, -40).slice(0, 7)}-01`,
        `${CUTOFFS.base.slice(0, 7)}-01`,
        "2026-07-01",
        "2026-08-01",
      ]);
      expect(august).toEqual({
        month: "2026-08-01",
        spend: 150,
        purchase_value: 500,
        conversions: 5,
        impressions: 1500,
        link_clicks: 75,
        days_with_data: 2,
        source_row_count: 2,
      });
      // base_on_cutoff (2026-02-13) is a daily base row; the legacy multi-day
      // row and the breakdown rows are excluded from the rollup.
      const cutoffMonth = rows.find(
        (row) => row.month === `${CUTOFFS.base.slice(0, 7)}-01`,
      );
      expect(cutoffMonth).toMatchObject({
        spend: 1006,
        source_row_count: 2,
        days_with_data: 2,
      });
    });

    it("is idempotent on a second run", async () => {
      async function summaries() {
        const result = await testDb!.execute(sql`
          SELECT month::text AS month, spend::float8 AS spend, source_row_count
          FROM performance_monthly_summary WHERE organization_id = ${ORG}
          ORDER BY month
        `);
        return result.rows;
      }

      await executeRetention({ organizationId: ORG, today: TODAY, dryRun: false });
      const second = await executeRetention({
        organizationId: ORG,
        today: TODAY,
        dryRun: false,
      });
      const afterSecond = await summaries();
      await executeRetention({ organizationId: ORG, today: TODAY, dryRun: false });

      expect(second.plan.totalCandidateRows).toBe(0);
      expect(Object.values(second.deleted).every((count) => count === 0)).toBe(true);
      expect(await summaries()).toEqual(afterSecond);
      expect(await countRows("performance_log")).toBe(6);

      // Months that start before the base cutoff keep the sums captured on the
      // first run — including the month straddling the cutoff, whose surviving
      // row alone would report 7 instead of 1006.
      expect(afterSecond).toEqual([
        {
          month: `${shiftYmd(CUTOFFS.base, -40).slice(0, 7)}-01`,
          spend: 888,
          source_row_count: 1,
        },
        {
          month: `${CUTOFFS.base.slice(0, 7)}-01`,
          spend: 1006,
          source_row_count: 2,
        },
        { month: "2026-07-01", spend: 20, source_row_count: 1 },
        { month: "2026-08-01", spend: 150, source_row_count: 2 },
      ]);
    });

    it("captures a pre-cutoff month once and never rewrites it", async () => {
      const staleMonth = `${CUTOFFS.base.slice(0, 7)}-01`;
      await testDb!.execute(sql`
        INSERT INTO performance_monthly_summary
          (id, organization_id, month, spend, days_with_data, source_row_count)
        VALUES ('sum_stale', ${ORG}, ${staleMonth}::date, 4242, 31, 31)
      `);

      await rollupMonthlySummaries({ organizationId: ORG, today: TODAY });

      const result = await testDb!.execute(sql`
        SELECT month::text AS month, spend::float8 AS spend, source_row_count
        FROM performance_monthly_summary WHERE organization_id = ${ORG}
        ORDER BY month
      `);

      expect(result.rows).toEqual([
        // No row existed: initial capture of a fully expired month.
        {
          month: `${shiftYmd(CUTOFFS.base, -40).slice(0, 7)}-01`,
          spend: 888,
          source_row_count: 1,
        },
        // A row existed and the month starts before the cutoff: left alone.
        { month: staleMonth, spend: 4242, source_row_count: 31 },
        { month: "2026-07-01", spend: 20, source_row_count: 1 },
        { month: "2026-08-01", spend: 150, source_row_count: 2 },
      ]);
    });

    it("rolls up daily base rows only and recomputes retained months in place", async () => {
      const first = await rollupMonthlySummaries({
        organizationId: ORG,
        today: TODAY,
      });
      const second = await rollupMonthlySummaries({
        organizationId: ORG,
        today: TODAY,
      });

      // Four months captured; the two starting before the base cutoff are
      // frozen, so the second run only touches July and August.
      expect(first.monthsUpserted).toBe(4);
      expect(second.monthsUpserted).toBe(2);
      expect(await countRows("performance_monthly_summary")).toBe(4);
      expect(await countRows("performance_monthly_summary", OTHER_ORG)).toBe(0);
    });
  });

  describe("evidence", () => {
    const oldStamp = `${shiftYmd(CUTOFFS.evidence, -1)} 12:00:00`;
    const freshStamp = `${shiftYmd(CUTOFFS.evidence, 5)} 12:00:00`;

    beforeEach(async () => {
      await testDb!.execute(sql`
        INSERT INTO klaviyo_event (id, organization_id, shopify_store_id, connection_id, occurred_at)
        VALUES
          ('ke_old', ${ORG}, 'store_1', 'conn_1', ${oldStamp}::timestamp),
          ('ke_fresh', ${ORG}, 'store_1', 'conn_1', ${freshStamp}::timestamp),
          ('ke_other_org', ${OTHER_ORG}, 'store_1', 'conn_1', ${oldStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO shopify_order_line (id, organization_id, store_id, order_id, created_at)
        VALUES
          ('sol_old', ${ORG}, 'store_1', 'order_1', ${oldStamp}::timestamp),
          ('sol_fresh', ${ORG}, 'store_1', 'order_2', ${freshStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO source_identity_hmac (id, organization_id, store_id, created_at)
        VALUES
          ('sih_old', ${ORG}, 'store_1', ${oldStamp}::timestamp),
          ('sih_fresh', ${ORG}, 'store_1', ${freshStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO shopify_evidence_run_observation
          (id, organization_id, store_id, evidence_run_id, order_id, observed_at)
        VALUES
          ('sero_old', ${ORG}, 'store_1', 'ser_fresh', 'order_1', ${oldStamp}::timestamp),
          ('sero_fresh', ${ORG}, 'store_1', 'ser_old_guarded', 'order_2', ${freshStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO shopify_evidence_run_identity_observation
          (id, organization_id, store_id, evidence_run_id, order_id, identity_hmac_id, observed_at)
        VALUES
          ('serio_old', ${ORG}, 'store_1', 'ser_fresh', 'order_1', 'sih_old', ${oldStamp}::timestamp),
          ('serio_fresh', ${ORG}, 'store_1', 'ser_old_guarded', 'order_2', 'sih_fresh', ${freshStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO shopify_evidence_sync_run (id, organization_id, store_id, status, requested_to)
        VALUES
          ('ser_old_unguarded', ${ORG}, 'store_1', 'success', ${oldStamp}::timestamp),
          ('ser_old_guarded', ${ORG}, 'store_1', 'success', ${oldStamp}::timestamp),
          ('ser_running', ${ORG}, 'store_1', 'running', ${oldStamp}::timestamp),
          ('ser_fresh', ${ORG}, 'store_1', 'success', ${freshStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO klaviyo_sync_run (id, organization_id, shopify_store_id, connection_id, status, requested_to)
        VALUES
          ('ksr_old_unguarded', ${ORG}, 'store_1', 'conn_1', 'success', ${oldStamp}::timestamp),
          ('ksr_old_guarded', ${ORG}, 'store_1', 'conn_1', 'failed', ${oldStamp}::timestamp),
          ('ksr_running', ${ORG}, 'store_1', 'conn_1', 'running', ${oldStamp}::timestamp),
          ('ksr_fresh', ${ORG}, 'store_1', 'conn_1', 'success', ${freshStamp}::timestamp),
          ('ksr_no_window', ${ORG}, 'store_1', 'conn_1', 'success', NULL)
      `);
      await testDb!.execute(sql`
        INSERT INTO klaviyo_event_run_observation
          (organization_id, shopify_store_id, connection_id, sync_run_id, event_id)
        VALUES (${ORG}, 'store_1', 'conn_1', 'ksr_old_guarded', 'ke_fresh')
      `);
      // Old terminal runs on both sides, guarded only by a retained match run.
      await testDb!.execute(sql`
        INSERT INTO klaviyo_sync_run (id, organization_id, shopify_store_id, connection_id, status, requested_to)
        VALUES ('ksr_old_match_guarded', ${ORG}, 'store_1', 'conn_1', 'success', ${oldStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO shopify_evidence_sync_run (id, organization_id, store_id, status, requested_to)
        VALUES ('ser_old_match_guarded', ${ORG}, 'store_1', 'success', ${oldStamp}::timestamp)
      `);
      await testDb!.execute(sql`
        INSERT INTO klaviyo_match_run (id, organization_id, connection_id, source_run_id, shopify_evidence_run_id)
        VALUES ('kmr_1', ${ORG}, 'conn_1', 'ksr_old_match_guarded', 'ser_old_match_guarded')
      `);
      // Rows that cascade from the doomed event; the plan must count them.
      await testDb!.execute(sql`
        INSERT INTO klaviyo_attribution_claim (id, organization_id, conversion_event_id)
        VALUES
          ('kac_doomed', ${ORG}, 'ke_old'),
          ('kac_kept', ${ORG}, 'ke_fresh')
      `);
      await testDb!.execute(sql`
        INSERT INTO klaviyo_match_candidate (id, organization_id, event_id)
        VALUES ('kmc_doomed', ${ORG}, 'ke_old')
      `);
    });

    it("plans one candidate per evidence table and spares guarded runs", async () => {
      const plan = await planRetention({ organizationId: ORG, today: TODAY });
      const counts = Object.fromEntries(
        plan.categories.map((category) => [category.key, category.candidateRows]),
      );

      expect(counts).toMatchObject({
        klaviyo_event: 1,
        shopify_order_line: 1,
        source_identity_hmac: 1,
        shopify_evidence_run_observation: 1,
        shopify_evidence_run_identity_observation: 1,
        klaviyo_sync_run: 1,
        shopify_evidence_sync_run: 1,
        klaviyo_attribution_claim: 1,
        klaviyo_match_candidate: 1,
        klaviyo_event_match_result: 0,
      });

      const cascadeFlags = Object.fromEntries(
        plan.categories.map((category) => [category.key, category.cascadeOnly]),
      );
      expect(cascadeFlags.klaviyo_attribution_claim).toBe(true);
      expect(cascadeFlags.klaviyo_event).toBe(false);
    });

    it("deletes expired evidence and leaves everything else", async () => {
      const result = await executeRetention({
        organizationId: ORG,
        today: TODAY,
        dryRun: false,
        batchSize: 1,
      });

      expect(result.deleted).toMatchObject({
        klaviyo_event: 1,
        shopify_order_line: 1,
        source_identity_hmac: 1,
        shopify_evidence_run_observation: 1,
        shopify_evidence_run_identity_observation: 1,
        klaviyo_sync_run: 1,
        shopify_evidence_sync_run: 1,
      });

      expect(await idsIn("klaviyo_event")).toEqual(["ke_fresh", "ke_other_org"]);
      expect(await idsIn("shopify_order_line")).toEqual(["sol_fresh"]);
      expect(await idsIn("source_identity_hmac")).toEqual(["sih_fresh"]);
      expect(await idsIn("shopify_evidence_run_observation")).toEqual(["sero_fresh"]);
      expect(await idsIn("shopify_evidence_run_identity_observation")).toEqual([
        "serio_fresh",
      ]);
      expect(await idsIn("shopify_evidence_sync_run")).toEqual([
        "ser_fresh",
        "ser_old_guarded",
        "ser_old_match_guarded",
        "ser_running",
      ]);
      expect(await idsIn("klaviyo_sync_run")).toEqual([
        "ksr_fresh",
        "ksr_no_window",
        "ksr_old_guarded",
        "ksr_old_match_guarded",
        "ksr_running",
      ]);
      // The doomed event took its claim and candidate with it via cascade;
      // the executor never touched those tables directly.
      expect(await idsIn("klaviyo_attribution_claim")).toEqual(["kac_kept"]);
      expect(await idsIn("klaviyo_match_candidate")).toEqual([]);
      expect(result.deleted).not.toHaveProperty("klaviyo_attribution_claim");
    });
  });
});
