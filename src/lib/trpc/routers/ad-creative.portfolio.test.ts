import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

// The portfolio aggregates are pure SQL — weighting and join shape only mean
// something against a real Postgres, so these tests build a throwaway database
// from a hand-written fixture schema and query it through the router.
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
const TEST_DATABASE = "adsolute_ad_creative_portfolio_test";

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

const { createMockCaller } = await import("../test-helpers");

const ORG = "org_portfolio_test";
const FROM = "2026-06-01";
const TO = "2026-06-07";

// The committed migration chain is not replayable from an empty database, so
// the fixture transcribes the columns the portfolio queries touch straight
// from src/schema.
const FIXTURE_DDL = [
  `CREATE TYPE "status" AS ENUM ('active', 'paused', 'archived')`,
  `CREATE TYPE "format" AS ENUM ('static', 'video', 'ugc', 'carousel')`,
  `CREATE TYPE "ownership" AS ENUM ('ours', 'theirs')`,
  `CREATE TABLE ad_account (
     id text PRIMARY KEY,
     name text NOT NULL,
     meta_account_id text NOT NULL UNIQUE,
     organization_id text
   )`,
  `CREATE TABLE campaign (
     id text PRIMARY KEY,
     name text NOT NULL DEFAULT 'Untitled Campaign',
     organization_id text,
     account_id text REFERENCES ad_account(id) ON DELETE SET NULL,
     status "status" NOT NULL DEFAULT 'active',
     meta_id text UNIQUE
   )`,
  `CREATE TABLE ad_set (
     id text PRIMARY KEY,
     name text NOT NULL DEFAULT 'Untitled Ad Set',
     campaign_id text NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
     account_id text REFERENCES ad_account(id) ON DELETE SET NULL,
     meta_id text UNIQUE,
     organization_id text,
     status "status" NOT NULL DEFAULT 'active'
   )`,
  `CREATE TABLE ad_creative (
     id text PRIMARY KEY,
     name text NOT NULL DEFAULT 'Untitled Creative',
     asset_url text,
     video_url text,
     format "format",
     angle text,
     persona text,
     awareness_level text,
     attributes jsonb NOT NULL DEFAULT '{}',
     attributes_meta jsonb NOT NULL DEFAULT '{}',
     tone text[],
     ownership "ownership",
     team_id text,
     notes text,
     organization_id text,
     created_at timestamp NOT NULL DEFAULT now(),
     updated_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE ad (
     id text PRIMARY KEY,
     name text NOT NULL DEFAULT 'Untitled Ad',
     ad_set_id text REFERENCES ad_set(id) ON DELETE SET NULL,
     account_id text REFERENCES ad_account(id) ON DELETE SET NULL,
     ad_creative_id text REFERENCES ad_creative(id) ON DELETE SET NULL,
     meta_id text UNIQUE,
     destination_url text,
     organization_id text,
     status "status" NOT NULL DEFAULT 'active',
     created_at timestamp NOT NULL DEFAULT now(),
     updated_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE performance_log (
     id text PRIMARY KEY,
     ad_id text NOT NULL REFERENCES ad(id) ON DELETE CASCADE,
     meta_ad_id text,
     roas numeric,
     cpa numeric,
     ctr numeric,
     cpc numeric,
     frequency numeric,
     spend numeric,
     conversions integer,
     impressions integer,
     reach integer,
     link_clicks integer,
     clicks_all integer,
     video_views_3s integer,
     purchase_value numeric,
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
  `CREATE INDEX performance_log_org_ad_date_idx
     ON performance_log (organization_id, ad_id, date_start, date_end)`,
  `CREATE UNIQUE INDEX performance_log_ad_date_breakdown_uniq
     ON performance_log (ad_id, date_start, date_end, country, platform, placement, device, age, gender)
     NULLS NOT DISTINCT`,
];

async function createFixtureSchema() {
  for (const statement of FIXTURE_DDL) {
    await testDb!.execute(sql.raw(statement));
  }
}

async function seedCreative(
  id: string,
  opts: { format?: string; ownership?: string; teamId?: string } = {},
) {
  await testDb!.execute(sql`
    INSERT INTO ad_creative (id, name, format, ownership, team_id, organization_id)
    VALUES (
      ${id}, ${id}, ${opts.format ?? null}, ${opts.ownership ?? null},
      ${opts.teamId ?? null}, ${ORG}
    )
  `);
}

async function seedAd(
  id: string,
  opts: { creativeId?: string; accountId?: string; status?: string } = {},
) {
  await testDb!.execute(sql`
    INSERT INTO ad (id, name, ad_set_id, account_id, ad_creative_id, meta_id, status, organization_id)
    VALUES (
      ${id}, ${id}, 'set_1', ${opts.accountId ?? "acc_1"}, ${opts.creativeId ?? null},
      ${`meta_${id}`}, ${opts.status ?? "active"}, ${ORG}
    )
  `);
}

type PerfRow = {
  adId: string;
  date: string;
  spend?: number;
  purchaseValue?: number;
  conversions?: number;
  ctr?: number;
  impressions?: number;
  // Meta's own per-row cpc. Seeded so a test can tell a ratio of sums apart
  // from an average of these, which is what the aggregates used to return.
  cpc?: number;
  clicksAll?: number;
  age?: string;
};

async function seedPerf(row: PerfRow) {
  await testDb!.execute(sql`
    INSERT INTO performance_log (
      id, ad_id, meta_ad_id, spend, purchase_value, conversions, ctr, impressions,
      cpc, clicks_all, age, date_start, date_end, organization_id
    )
    VALUES (
      ${`pl_${row.adId}_${row.date}_${row.age ?? "base"}`}, ${row.adId}, ${`meta_${row.adId}`},
      ${row.spend ?? null}, ${row.purchaseValue ?? null}, ${row.conversions ?? null},
      ${row.ctr ?? null}, ${row.impressions ?? null}, ${row.cpc ?? null},
      ${row.clicksAll ?? null}, ${row.age ?? null},
      ${row.date}, ${row.date}, ${ORG}
    )
  `);
}

function num(value: string | null): number {
  expect(value).not.toBeNull();
  return Number(value);
}

const describeIfDb = baseConnectionString ? describe : describe.skip;

describeIfDb("ad-creative portfolio aggregates", () => {
  const caller = createMockCaller({ role: "member", organizationId: ORG });

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
    await createFixtureSchema();
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
  });

  beforeEach(async () => {
    await testDb!.execute(
      sql.raw(
        "TRUNCATE performance_log, ad, ad_creative, ad_set, campaign, ad_account RESTART IDENTITY CASCADE",
      ),
    );
    await testDb!.execute(sql`
      INSERT INTO ad_account (id, name, meta_account_id, organization_id)
      VALUES ('acc_1', 'Acme', 'act_acc_1', ${ORG})
    `);
    await testDb!.execute(sql`
      INSERT INTO campaign (id, name, meta_id, account_id, organization_id)
      VALUES ('cmp_1', 'Prospecting', 'meta_cmp_1', 'acc_1', ${ORG})
    `);
    await testDb!.execute(sql`
      INSERT INTO ad_set (id, name, campaign_id, meta_id, organization_id)
      VALUES ('set_1', 'Broad', 'cmp_1', 'meta_set_1', ${ORG})
    `);
  });

  describe("CTR weighting", () => {
    // A high-volume ad at a low CTR and a tiny ad at a high CTR. An unweighted
    // mean of the two per-row ratios lands at 4.5%; the portfolio's actual CTR
    // is 401,600 clicks-equivalent over 400,200 impressions ≈ 1.0035%.
    beforeEach(async () => {
      await seedCreative("cr_1");
      await seedCreative("cr_2");
      await seedAd("ad_big", { creativeId: "cr_1" });
      await seedAd("ad_small", { creativeId: "cr_2" });
      await seedPerf({
        adId: "ad_big",
        date: "2026-06-02",
        spend: 4000,
        purchaseValue: 8000,
        conversions: 100,
        ctr: 1,
        impressions: 400_000,
      });
      await seedPerf({
        adId: "ad_small",
        date: "2026-06-02",
        spend: 5,
        purchaseValue: 10,
        conversions: 1,
        ctr: 8,
        impressions: 200,
      });
    });

    it("weights portfolio CTR by impressions rather than averaging per-row ratios", async () => {
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      expect(num(portfolio.ctr)).toBeCloseTo(1.0035, 3);
    });

    it("does not let a 200-impression ad drag the portfolio CTR toward its own", async () => {
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      // The unweighted mean of 1% and 8%. Pinned so the bug cannot come back
      // by way of a copied `avg(pl.ctr)` from a neighbouring query.
      expect(num(portfolio.ctr)).not.toBeCloseTo(4.5, 1);
    });

    it("keeps CTR impression-weighted across days for a single ad", async () => {
      await testDb!.execute(sql.raw("TRUNCATE performance_log"));
      await seedPerf({
        adId: "ad_big",
        date: "2026-06-02",
        spend: 100,
        ctr: 1,
        impressions: 90_000,
      });
      await seedPerf({
        adId: "ad_big",
        date: "2026-06-03",
        spend: 100,
        ctr: 10,
        impressions: 10_000,
      });
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      // (1 * 90k + 10 * 10k) / 100k = 1.9, not the 5.5 midpoint.
      expect(num(portfolio.ctr)).toBeCloseTo(1.9, 4);
    });

    it("ignores impressions on rows Meta reported no CTR for", async () => {
      // A NULL ctr means the row carries no CTR, not that it earned no clicks
      // — Meta sends an explicit 0 for that. Counting those impressions in the
      // denominator would drag the result toward zero on a number we never
      // got. Here the only reported CTR is 4% over 1,000 impressions.
      await testDb!.execute(sql.raw("TRUNCATE performance_log"));
      await seedPerf({
        adId: "ad_big",
        date: "2026-06-02",
        spend: 100,
        ctr: 4,
        impressions: 1_000,
      });
      await seedPerf({
        adId: "ad_small",
        date: "2026-06-02",
        spend: 100,
        impressions: 9_000,
      });
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      expect(num(portfolio.ctr)).toBeCloseTo(4, 6);
    });

    it("returns null CTR when the window has no impressions", async () => {
      await testDb!.execute(sql.raw("TRUNCATE performance_log"));
      await seedPerf({ adId: "ad_big", date: "2026-06-02", spend: 10 });
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      expect(portfolio.ctr).toBeNull();
    });
  });

  describe("CPC weighting", () => {
    // Two days for one creative with opposite click volumes: 3 clicks bought at
    // $10 each, then 3,000 bought at $0.10. CPC is spend / clicks, so the
    // creative's CPC is $330 / 3,003 ≈ $0.1099 — nowhere near the $5.05 midpoint
    // an average of the two per-row ratios returns.
    //
    // The two rows also cover both denominator paths. The first carries
    // `clicks_all` (rows synced after #231) and a deliberately contradictory
    // impressions × ctr, so preferring the implied figure over the real one
    // would show. The second carries only impressions and ctr, as every
    // historical row does, and its clicks are implied as 300,000 * 1% = 3,000.
    beforeEach(async () => {
      await seedCreative("cr_cpc");
      await seedAd("ad_cpc", { creativeId: "cr_cpc" });
      await seedPerf({
        adId: "ad_cpc",
        date: "2026-06-05",
        spend: 30,
        clicksAll: 3,
        cpc: 10,
        impressions: 1_000,
        ctr: 50,
      });
      await seedPerf({
        adId: "ad_cpc",
        date: "2026-06-06",
        spend: 300,
        cpc: 0.1,
        impressions: 300_000,
        ctr: 1,
      });
    });

    it("weights CPC by clicks rather than averaging per-row ratios", async () => {
      const [creative] = await caller.adCreative.list({
        from: FROM,
        to: TO,
        includeHealth: false,
      });
      expect(num(creative.avgCpc)).toBeCloseTo(330 / 3003, 6);
    });

    it("does not let a 3-click day drag the CPC toward its own", async () => {
      const [creative] = await caller.adCreative.list({
        from: FROM,
        to: TO,
        includeHealth: false,
      });
      // The unweighted mean of $10 and $0.10. Pinned so `avg(pl.cpc)` cannot
      // come back by way of a copied line from a neighbouring query.
      expect(num(creative.avgCpc)).not.toBeCloseTo(5.05, 1);
    });

    it("prefers a row's own clicks_all over clicks implied from its ctr", async () => {
      const [creative] = await caller.adCreative.list({
        from: FROM,
        to: TO,
        includeHealth: false,
      });
      // Reading the first row's impressions × ctr instead of its clicks_all
      // would put 500 clicks in the denominator, not 3.
      expect(num(creative.avgCpc)).not.toBeCloseTo(330 / 3500, 4);
    });

    it("weights the recent-window CPC the same way", async () => {
      const [creative] = await caller.adCreative.list({
        from: FROM,
        to: TO,
        includeHealth: false,
      });
      // The recent window is the last 3 days of delivery, which both rows fall
      // inside, so it lands on the same weighted figure.
      expect(num(creative.recentCpc)).toBeCloseTo(330 / 3003, 6);
    });

    it("implies clicks from impressions and ctr on rows with no clicks_all", async () => {
      // Every row synced before #231 has a NULL clicks_all. Summing that column
      // alone would leave CPC NULL for the whole of history, so the clicks are
      // implied from Meta's all-clicks CTR instead: 300,000 * 1% = 3,000 clicks
      // for $300 of spend.
      await testDb!.execute(sql.raw("TRUNCATE performance_log"));
      await seedPerf({
        adId: "ad_cpc",
        date: "2026-06-05",
        spend: 300,
        cpc: 9.99,
        impressions: 300_000,
        ctr: 1,
      });
      const [creative] = await caller.adCreative.list({
        from: FROM,
        to: TO,
        includeHealth: false,
      });
      // 9.99 is the row's own cpc field, which the aggregate no longer reads.
      expect(num(creative.avgCpc)).toBeCloseTo(0.1, 6);
    });

    it("returns null CPC when the window bought no clicks", async () => {
      await testDb!.execute(sql.raw("TRUNCATE performance_log"));
      await seedPerf({ adId: "ad_cpc", date: "2026-06-05", spend: 10 });
      const [creative] = await caller.adCreative.list({
        from: FROM,
        to: TO,
        includeHealth: false,
      });
      expect(creative.avgCpc).toBeNull();
    });
  });

  describe("CPC weighting in the health rollup", () => {
    // The health rollup compares an ad's recent CPC against its window CPC, so
    // both sides have to be weighted the same way or the comparison invents a
    // trend. Here one ad buys 2,000 clicks at $0.05, then 1,000 at $0.10 with a
    // 10-click $0.01 straggler on the last day.
    //
    // Weighted, the recent window costs $100.10 / 1,010 = $0.0991 against a
    // window CPC of $200.10 / 3,010 = $0.0665 — a real 49% rise. Averaging the
    // two recent per-row ratios gives $0.055, which reads as CPC *falling* and
    // hides the rise entirely.
    beforeEach(async () => {
      await seedCreative("cr_health");
      await seedAd("ad_health", { creativeId: "cr_health" });
      await seedPerf({
        adId: "ad_health",
        date: "2026-06-02",
        spend: 100,
        clicksAll: 2000,
        cpc: 0.05,
        impressions: 50_000,
        ctr: 2,
        conversions: 5,
        purchaseValue: 400,
      });
      await seedPerf({
        adId: "ad_health",
        date: "2026-06-06",
        spend: 100,
        clicksAll: 1000,
        cpc: 0.1,
        impressions: 25_000,
        ctr: 2,
        conversions: 2,
        purchaseValue: 300,
      });
      await seedPerf({
        adId: "ad_health",
        date: "2026-06-07",
        spend: 0.1,
        clicksAll: 10,
        cpc: 0.01,
        impressions: 250,
        ctr: 2,
        conversions: 0,
        purchaseValue: 0,
      });
    });

    it("flags the CPC rise the weighted recent window actually shows", async () => {
      const [creative] = await caller.adCreative.list({ from: FROM, to: TO });
      expect(creative.healthReasons).toContain("CPC up 49% vs your average");
    });
  });

  describe("ads with no creative record", () => {
    // Two tagged ads and one ad Meta delivered without any matching
    // ad_creative row. The creative-less ad's spend is real money and belongs
    // in the portfolio total.
    beforeEach(async () => {
      await seedCreative("cr_1", { format: "video", ownership: "ours", teamId: "team_1" });
      await seedAd("ad_tagged", { creativeId: "cr_1" });
      await seedAd("ad_orphan");
      await seedPerf({
        adId: "ad_tagged",
        date: "2026-06-02",
        spend: 100,
        purchaseValue: 300,
        conversions: 4,
        ctr: 2,
        impressions: 10_000,
      });
      await seedPerf({
        adId: "ad_orphan",
        date: "2026-06-02",
        spend: 250,
        purchaseValue: 500,
        conversions: 5,
        ctr: 1,
        impressions: 40_000,
      });
    });

    it("counts creative-less ads in portfolio spend, revenue and conversions", async () => {
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      expect(num(portfolio.totalSpend)).toBeCloseTo(350, 6);
      expect(num(portfolio.totalRevenue)).toBeCloseTo(800, 6);
      expect(num(portfolio.conversions)).toBe(9);
    });

    it("derives portfolio ROAS and CPA from totals that include creative-less ads", async () => {
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      expect(num(portfolio.roas)).toBeCloseTo(800 / 350, 6);
      expect(num(portfolio.cpa)).toBeCloseTo(350 / 9, 6);
    });

    it("counts creative-less ads in the daily portfolio series", async () => {
      const [day] = await caller.adCreative.getDailyPortfolioPerformance({
        from: "2026-06-02",
        to: "2026-06-02",
      });
      expect(num(day.spend)).toBeCloseTo(350, 6);
      expect(num(day.purchaseValue)).toBeCloseTo(800, 6);
    });

    it("counts creative-less ads in the MER account breakdown", async () => {
      const [account] = await caller.adCreative.getMerAccountBreakdown({
        from: FROM,
        to: TO,
      });
      expect(account.accountId).toBe("acc_1");
      expect(num(account.spend)).toBeCloseTo(350, 6);
      expect(num(account.revenue)).toBeCloseTo(800, 6);
    });

    it("counts creative-less ads in the MER prior period and sparkline", async () => {
      // The breakdown runs three separate CTEs over the same ads. current_period
      // is covered above; these are the other two, which regress independently.
      await seedPerf({
        adId: "ad_orphan",
        date: "2026-05-28",
        spend: 70,
        purchaseValue: 140,
        conversions: 2,
        ctr: 1,
        impressions: 9_000,
      });
      const [account] = await caller.adCreative.getMerAccountBreakdown({
        from: FROM,
        to: TO,
      });
      // Prior window is the same length immediately before FROM, so 2026-05-28
      // falls inside it and only the orphan spent there.
      expect(num(account.priorSpend)).toBeCloseTo(70, 6);

      const day = account.sparkline.find((p) => p.date === "2026-06-02");
      expect(day?.spend).toBeCloseTo(350, 6);
      expect(day?.revenue).toBeCloseTo(800, 6);
    });

    it("still excludes creative-less ads when a creative attribute is filtered on", async () => {
      const byFormat = await caller.adCreative.portfolioSummary({
        from: FROM,
        to: TO,
        format: "video",
      });
      expect(num(byFormat.totalSpend)).toBeCloseTo(100, 6);

      const byTeam = await caller.adCreative.portfolioSummary({
        from: FROM,
        to: TO,
        teamId: "team_1",
      });
      expect(num(byTeam.totalSpend)).toBeCloseTo(100, 6);

      const ours = await caller.adCreative.portfolioSummary({
        from: FROM,
        to: TO,
        ownership: "ours",
      });
      expect(num(ours.totalSpend)).toBeCloseTo(100, 6);
    });

    it("groups creative-less ads with unknown ownership under 'theirs'", async () => {
      // `theirs` is already defined as "not explicitly ours", which is how a
      // creative with a null ownership is treated. An ad with no creative row
      // at all has the same unknown ownership, so it lands in the same bucket
      // rather than vanishing from both sides of the split.
      const theirs = await caller.adCreative.portfolioSummary({
        from: FROM,
        to: TO,
        ownership: "theirs",
      });
      expect(num(theirs.totalSpend)).toBeCloseTo(250, 6);
    });

    it("keeps ignoring demographic breakdown rows for creative-less ads", async () => {
      // The base-row filter and the join fix have to hold at the same time: an
      // age-split duplicate of the orphan's day must not double its spend.
      await seedPerf({
        adId: "ad_orphan",
        date: "2026-06-02",
        spend: 250,
        purchaseValue: 500,
        conversions: 5,
        ctr: 1,
        impressions: 40_000,
        age: "25-34",
      });
      const portfolio = await caller.adCreative.portfolioSummary({ from: FROM, to: TO });
      expect(num(portfolio.totalSpend)).toBeCloseTo(350, 6);
    });
  });
});

// The behavioural tests above only reach `portfolioSummary`. The same
// aggregation appears in five more queries in this router whose procedures
// need far more of the schema than the fixture carries, so the cheap guard is
// the source itself: the bug came back by copying a neighbouring line, and
// that is exactly what this catches. It says nothing about whether the
// weighting is correct — the tests above do that.
describe("no unweighted CTR aggregates survive in the router", () => {
  it("has no remaining avg(pl.ctr) in ad-creative.ts", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/trpc/routers/ad-creative.ts"),
      "utf8",
    );
    expect(source).not.toContain("avg(pl.ctr");
  });

  it("has no remaining avg(pl.cpc) in ad-creative.ts", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/trpc/routers/ad-creative.ts"),
      "utf8",
    );
    expect(source).not.toContain("avg(pl.cpc");
    expect(source).toContain('clickWeightedCpc("pl")');
  });

  it("has no remaining avg(pl2.cpc) in creative-health-rollup.ts", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/creative-health-rollup.ts"),
      "utf8",
    );
    // The recent-window CPC lives in a correlated subquery on the pl2 alias, so
    // a grep for `avg(pl.cpc` walks straight past it.
    expect(source).not.toContain("avg(pl2.cpc");
    expect(source).toContain('clickWeightedCpc("pl2")');
  });

  it("routes every CTR aggregate through the shared helper", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/trpc/routers/ad-creative.ts"),
      "utf8",
    );
    // Nobody should be hand-rolling sum(ctr * impressions) alongside the
    // helper; one spelling keeps the weighting reviewable in one place.
    expect(source).not.toContain("sum(pl.ctr * pl.impressions)");
    expect(source).toContain('impressionWeightedCtr("pl")');
  });
});
