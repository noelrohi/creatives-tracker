import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

// The manager router is pure aggregate SQL — rollups, LEFT JOIN semantics and
// filter pushdown only mean something against a real Postgres, so these tests
// run the migrations into a throwaway database and query it.
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
const TEST_DATABASE = "adsolute_manager_router_test";

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

const ORG = "org_manager_test";
const OTHER_ORG = "org_other";
const FROM = "2026-06-01";
const TO = "2026-06-07";

// The committed migration chain is not replayable from an empty database
// (0011 re-creates tables 0010 already made), so the fixture transcribes the
// columns, keys and index the manager router touches straight from src/schema.
const FIXTURE_DDL = [
  `CREATE TYPE "status" AS ENUM ('active', 'paused', 'archived')`,
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
  `CREATE TABLE ad (
     id text PRIMARY KEY,
     name text NOT NULL DEFAULT 'Untitled Ad',
     ad_set_id text REFERENCES ad_set(id) ON DELETE SET NULL,
     account_id text REFERENCES ad_account(id) ON DELETE SET NULL,
     meta_id text UNIQUE,
     organization_id text,
     status "status" NOT NULL DEFAULT 'active'
   )`,
  `CREATE TABLE performance_log (
     id text PRIMARY KEY,
     ad_id text NOT NULL REFERENCES ad(id) ON DELETE CASCADE,
     meta_ad_id text,
     roas numeric,
     cpa numeric,
     ctr numeric,
     spend numeric,
     conversions integer,
     impressions integer,
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

type PerfRow = {
  adId: string;
  date: string;
  spend?: number;
  purchaseValue?: number;
  conversions?: number;
  ctr?: number;
  impressions?: number;
  age?: string;
};

async function seedAccount(id: string, name: string) {
  await testDb!.execute(sql`
    INSERT INTO ad_account (id, name, meta_account_id, organization_id)
    VALUES (${id}, ${name}, ${`act_${id}`}, ${ORG})
  `);
}

async function seedCampaign(
  id: string,
  name: string,
  opts: { accountId?: string; status?: string; organizationId?: string } = {},
) {
  await testDb!.execute(sql`
    INSERT INTO campaign (id, name, meta_id, account_id, status, organization_id)
    VALUES (
      ${id}, ${name}, ${`meta_${id}`}, ${opts.accountId ?? null},
      ${opts.status ?? "active"}, ${opts.organizationId ?? ORG}
    )
  `);
}

async function seedAdSet(
  id: string,
  campaignId: string,
  name: string,
  opts: { status?: string; organizationId?: string } = {},
) {
  await testDb!.execute(sql`
    INSERT INTO ad_set (id, name, campaign_id, meta_id, status, organization_id)
    VALUES (
      ${id}, ${name}, ${campaignId}, ${`meta_${id}`},
      ${opts.status ?? "active"}, ${opts.organizationId ?? ORG}
    )
  `);
}

async function seedAd(
  id: string,
  adSetId: string,
  name: string,
  opts: { status?: string; organizationId?: string } = {},
) {
  await testDb!.execute(sql`
    INSERT INTO ad (id, name, ad_set_id, meta_id, status, organization_id)
    VALUES (
      ${id}, ${name}, ${adSetId}, ${`meta_${id}`},
      ${opts.status ?? "active"}, ${opts.organizationId ?? ORG}
    )
  `);
}

async function seedPerf(row: PerfRow) {
  await testDb!.execute(sql`
    INSERT INTO performance_log (
      id, ad_id, meta_ad_id, spend, purchase_value, conversions, ctr, impressions,
      age, date_start, date_end, organization_id
    )
    VALUES (
      ${`pl_${row.adId}_${row.date}_${row.age ?? "base"}`}, ${row.adId}, ${`meta_${row.adId}`},
      ${row.spend ?? null}, ${row.purchaseValue ?? null}, ${row.conversions ?? null},
      ${row.ctr ?? null}, ${row.impressions ?? null}, ${row.age ?? null},
      ${row.date}, ${row.date}, ${ORG}
    )
  `);
}

const describeIfDb = baseConnectionString ? describe : describe.skip;

describeIfDb("manager router aggregates", () => {
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
        "TRUNCATE performance_log, ad, ad_set, campaign, ad_account RESTART IDENTITY CASCADE",
      ),
    );
  });

  describe("rollup formulas", () => {
    beforeEach(async () => {
      await seedAccount("acc_1", "Acme");
      await seedCampaign("cmp_1", "Prospecting", { accountId: "acc_1" });
      await seedAdSet("set_1", "cmp_1", "Broad");
      await seedAd("ad_1", "set_1", "Video A");
      await seedAd("ad_2", "set_1", "Video B");
      // ad_1: two days. ad_2: one day. CTR differs wildly from impressions so a
      // plain average and an impression-weighted average cannot coincide.
      await seedPerf({
        adId: "ad_1",
        date: "2026-06-02",
        spend: 100,
        purchaseValue: 300,
        conversions: 4,
        ctr: 1,
        impressions: 1000,
      });
      await seedPerf({
        adId: "ad_1",
        date: "2026-06-03",
        spend: 50,
        purchaseValue: 100,
        conversions: 1,
        ctr: 3,
        impressions: 1000,
      });
      await seedPerf({
        adId: "ad_2",
        date: "2026-06-02",
        spend: 50,
        purchaseValue: 200,
        conversions: 5,
        ctr: 10,
        impressions: 100,
      });
      // Breakdown row for the same ad/day must never be counted.
      await seedPerf({
        adId: "ad_2",
        date: "2026-06-02",
        spend: 50,
        purchaseValue: 200,
        conversions: 5,
        ctr: 10,
        impressions: 100,
        age: "25-34",
      });
      // Outside the range.
      await seedPerf({
        adId: "ad_1",
        date: "2026-06-20",
        spend: 999,
        purchaseValue: 999,
        conversions: 99,
        ctr: 99,
        impressions: 999,
      });
    });

    it("sums spend and conversions up the tree and derives ratios from the sums", async () => {
      const [campaign] = await caller.manager.campaigns({ from: FROM, to: TO });

      expect(campaign).toMatchObject({
        id: "cmp_1",
        metaId: "meta_cmp_1",
        name: "Prospecting",
        status: "active",
        accountName: "Acme",
        hasChildren: true,
        hasMatches: null,
      });
      // spend 100+50+50, purchase value 300+100+200, conversions 4+1+5
      expect(Number(campaign.spend)).toBe(200);
      expect(campaign.conversions).toBe(10);
      expect(Number(campaign.roas)).toBeCloseTo(600 / 200, 10);
      expect(Number(campaign.cpa)).toBeCloseTo(200 / 10, 10);
    });

    it("weights CTR by impressions rather than averaging per-day ratios", async () => {
      const [campaign] = await caller.manager.campaigns({ from: FROM, to: TO });
      const [adSet] = await caller.manager.adSets({
        campaignId: "cmp_1",
        from: FROM,
        to: TO,
      });

      // (1*1000 + 3*1000 + 10*100) / 2100 = 2.381...; plain AVG would be 4.667
      const weighted = (1 * 1000 + 3 * 1000 + 10 * 100) / 2100;
      expect(Number(campaign.ctr)).toBeCloseTo(weighted, 10);
      expect(Number(adSet.ctr)).toBeCloseTo(weighted, 10);
      expect(Number(campaign.ctr)).not.toBeCloseTo((1 + 3 + 10) / 3, 3);
    });

    it("keeps children summing to their parent at every level", async () => {
      const [campaign] = await caller.manager.campaigns({ from: FROM, to: TO });
      const adSets = await caller.manager.adSets({
        campaignId: "cmp_1",
        from: FROM,
        to: TO,
      });
      const ads = await caller.manager.ads({
        adSetId: "set_1",
        from: FROM,
        to: TO,
      });

      const sum = (rows: Array<{ spend: string }>) =>
        rows.reduce((total, row) => total + Number(row.spend), 0);

      expect(sum(adSets)).toBe(Number(campaign.spend));
      expect(sum(ads)).toBe(Number(campaign.spend));
      expect(ads.map((ad) => ad.id).sort()).toEqual(["ad_1", "ad_2"]);
      expect(ads.every((ad) => ad.hasChildren === false)).toBe(true);
      // Ad rows aggregate only their own days: ad_1 = 100 + 50.
      expect(Number(ads.find((ad) => ad.id === "ad_1")!.spend)).toBe(150);
    });

    it("excludes rows belonging to another organization", async () => {
      await seedCampaign("cmp_other", "Other org campaign", {
        organizationId: OTHER_ORG,
      });

      const rows = await caller.manager.campaigns({ from: FROM, to: TO });

      expect(rows.map((row) => row.id)).toEqual(["cmp_1"]);
    });
  });

  describe("zero activity", () => {
    beforeEach(async () => {
      await seedCampaign("cmp_empty", "Never delivered");
      await seedAdSet("set_empty", "cmp_empty", "Cold audience");
      await seedAd("ad_empty", "set_empty", "Fresh ad");
      await seedPerf({
        adId: "ad_empty",
        date: "2026-07-15",
        spend: 42,
        purchaseValue: 84,
        conversions: 2,
        ctr: 1,
        impressions: 100,
      });
    });

    it("returns entities with no rows in the range, zeroed instead of hidden", async () => {
      const campaigns = await caller.manager.campaigns({ from: FROM, to: TO });
      const adSets = await caller.manager.adSets({
        campaignId: "cmp_empty",
        from: FROM,
        to: TO,
      });
      const ads = await caller.manager.ads({
        adSetId: "set_empty",
        from: FROM,
        to: TO,
      });

      expect(campaigns).toHaveLength(1);
      expect(campaigns[0]).toMatchObject({
        id: "cmp_empty",
        spend: "0",
        roas: null,
        cpa: null,
        ctr: null,
        conversions: 0,
        hasChildren: true,
      });
      expect(adSets).toHaveLength(1);
      expect(adSets[0]).toMatchObject({ id: "set_empty", spend: "0", conversions: 0 });
      expect(ads).toHaveLength(1);
      expect(ads[0]).toMatchObject({ id: "ad_empty", spend: "0", conversions: 0 });
    });

    it("returns a campaign that has no ad sets at all", async () => {
      await seedCampaign("cmp_bare", "No ad sets");

      const campaigns = await caller.manager.campaigns({ from: FROM, to: TO });

      expect(campaigns.map((row) => row.id).sort()).toEqual(["cmp_bare", "cmp_empty"]);
      expect(campaigns.find((row) => row.id === "cmp_bare")!.hasChildren).toBe(false);
    });
  });

  describe("filter pushdown", () => {
    beforeEach(async () => {
      // cmp_a: paused ad set holding one active + one paused ad.
      await seedCampaign("cmp_a", "Retargeting core");
      await seedAdSet("set_a", "cmp_a", "Lookalike 1%", { status: "paused" });
      await seedAd("ad_live", "set_a", "Hook winner", { status: "active" });
      await seedAd("ad_off", "set_a", "Hook loser", { status: "paused" });
      await seedPerf({
        adId: "ad_live",
        date: "2026-06-02",
        spend: 60,
        purchaseValue: 120,
        conversions: 3,
        ctr: 2,
        impressions: 500,
      });
      await seedPerf({
        adId: "ad_off",
        date: "2026-06-02",
        spend: 40,
        purchaseValue: 40,
        conversions: 1,
        ctr: 1,
        impressions: 500,
      });

      // cmp_b: everything paused — no active descendant anywhere.
      await seedCampaign("cmp_b", "Dormant brand", { status: "paused" });
      await seedAdSet("set_b", "cmp_b", "Interest stack", { status: "paused" });
      await seedAd("ad_b", "set_b", "Old ad", { status: "paused" });
      await seedPerf({
        adId: "ad_b",
        date: "2026-06-02",
        spend: 500,
        purchaseValue: 500,
        conversions: 10,
        ctr: 1,
        impressions: 100,
      });
    });

    it("keeps only branches with a status match and rolls up the filtered children only", async () => {
      const campaigns = await caller.manager.campaigns({
        from: FROM,
        to: TO,
        status: "active",
      });

      expect(campaigns.map((row) => row.id)).toEqual(["cmp_a"]);
      // 60 from the active ad only; the paused sibling's 40 is excluded.
      expect(Number(campaigns[0].spend)).toBe(60);
      expect(campaigns[0].conversions).toBe(3);

      // The paused ad set survives because it holds an active ad, and its
      // rollup matches the campaign's.
      const adSets = await caller.manager.adSets({
        campaignId: "cmp_a",
        from: FROM,
        to: TO,
        status: "active",
      });
      expect(adSets.map((row) => row.id)).toEqual(["set_a"]);
      expect(adSets[0].status).toBe("paused");
      expect(Number(adSets[0].spend)).toBe(60);

      const ads = await caller.manager.ads({
        adSetId: "set_a",
        from: FROM,
        to: TO,
        status: "active",
      });
      expect(ads.map((row) => row.id)).toEqual(["ad_live"]);
    });

    it("keeps a parent whose descendant matches the search and prunes the rest", async () => {
      const campaigns = await caller.manager.campaigns({
        from: FROM,
        to: TO,
        search: "winner",
      });

      expect(campaigns.map((row) => row.id)).toEqual(["cmp_a"]);
      expect(campaigns[0].hasMatches).toBe(true);
      // Only the matching ad rolls up.
      expect(Number(campaigns[0].spend)).toBe(60);

      const adSets = await caller.manager.adSets({
        campaignId: "cmp_a",
        from: FROM,
        to: TO,
        search: "winner",
      });
      expect(adSets.map((row) => row.id)).toEqual(["set_a"]);
      expect(Number(adSets[0].spend)).toBe(60);

      const ads = await caller.manager.ads({
        adSetId: "set_a",
        from: FROM,
        to: TO,
        search: "winner",
      });
      expect(ads.map((row) => row.id)).toEqual(["ad_live"]);
    });

    it("drops branches with no search match anywhere", async () => {
      const campaigns = await caller.manager.campaigns({
        from: FROM,
        to: TO,
        search: "zzz-nothing",
      });

      expect(campaigns).toEqual([]);
    });

    it("leaves the whole subtree unpruned when a parent itself matches the search", async () => {
      const campaigns = await caller.manager.campaigns({
        from: FROM,
        to: TO,
        search: "Retargeting",
      });

      expect(campaigns.map((row) => row.id)).toEqual(["cmp_a"]);
      expect(campaigns[0].hasMatches).toBe(true);
      // Both ads count even though neither name matches "Retargeting".
      expect(Number(campaigns[0].spend)).toBe(100);

      const ads = await caller.manager.ads({
        adSetId: "set_a",
        from: FROM,
        to: TO,
        search: "Retargeting",
      });
      expect(ads.map((row) => row.id).sort()).toEqual(["ad_live", "ad_off"]);

      // Same for an ad-set-level match.
      const adSetMatchAds = await caller.manager.ads({
        adSetId: "set_a",
        from: FROM,
        to: TO,
        search: "Lookalike",
      });
      expect(adSetMatchAds.map((row) => row.id).sort()).toEqual(["ad_live", "ad_off"]);
    });

    it("combines status and search, and reports hasMatches per campaign", async () => {
      const campaigns = await caller.manager.campaigns({
        from: FROM,
        to: TO,
        status: "active",
        search: "Hook",
      });

      expect(campaigns.map((row) => row.id)).toEqual(["cmp_a"]);
      expect(campaigns[0].hasMatches).toBe(true);
      // "Hook loser" matches the search but fails the status filter.
      expect(Number(campaigns[0].spend)).toBe(60);
    });

    // §6: the client auto-expands every campaign/ad set on the path to a match,
    // so `hasMatches` has to mean "on a match path", not "matches itself".
    describe("adSets hasMatches", () => {
      beforeEach(async () => {
        // A second ad set under cmp_a that survives pruning only because of the
        // status filter, never because of a search.
        await seedAdSet("set_a2", "cmp_a", "Broad audience");
        await seedAd("ad_plain", "set_a2", "Plain creative");
        await seedPerf({
          adId: "ad_plain",
          date: "2026-06-02",
          spend: 10,
          purchaseValue: 10,
          conversions: 1,
          ctr: 1,
          impressions: 100,
        });
      });

      it("is null when no search is active", async () => {
        const adSets = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
        });

        expect(adSets.map((row) => row.id).sort()).toEqual(["set_a", "set_a2"]);
        expect(adSets.every((row) => row.hasMatches === null)).toBe(true);

        // Status-only filtering leaves it null too — only search auto-expands.
        const statusOnly = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          status: "active",
        });
        expect(statusOnly.every((row) => row.hasMatches === null)).toBe(true);
      });

      it("is true for an ad set matching the search itself", async () => {
        const adSets = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          search: "Lookalike",
        });

        expect(adSets.map((row) => row.id)).toEqual(["set_a"]);
        expect(adSets[0].hasMatches).toBe(true);
      });

      it("is true for every ad set when the ancestor campaign matches", async () => {
        const adSets = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          search: "Retargeting",
        });

        // The campaign is the match, so the whole subtree is a match path.
        expect(adSets.map((row) => row.id).sort()).toEqual(["set_a", "set_a2"]);
        expect(adSets.every((row) => row.hasMatches === true)).toBe(true);
      });

      it("is true for an ad set holding a matching ad", async () => {
        const adSets = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          search: "winner",
        });

        expect(adSets.map((row) => row.id)).toEqual(["set_a"]);
        expect(adSets[0].hasMatches).toBe(true);
      });

      it("prunes ad sets that are not on a match path instead of returning them false", async () => {
        // The server already prunes, so an ad set off the match path never
        // reaches the client: "Plain" only hits ad_plain under set_a2, and
        // set_a — which survives a status filter happily — is gone entirely.
        const adSets = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          search: "Plain",
        });

        expect(adSets.map((row) => row.id)).toEqual(["set_a2"]);
        expect(adSets[0].hasMatches).toBe(true);
        // Consequently, with a search active every returned row is a match
        // path: `false` is unreachable, and the client auto-expands all of them.
        expect(adSets.some((row) => row.hasMatches === false)).toBe(false);
      });

      it("ignores a match that the status filter drops", async () => {
        // "Hook" matches both ads in set_a; only the active one counts.
        const adSets = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          status: "active",
          search: "Hook",
        });

        expect(adSets.map((row) => row.id)).toEqual(["set_a"]);
        expect(adSets[0].hasMatches).toBe(true);

        // A search only the paused ad matches: nothing is on a match path once
        // the status filter has dropped it, so no rows come back at all.
        const loserOnly = await caller.manager.adSets({
          campaignId: "cmp_a",
          from: FROM,
          to: TO,
          status: "active",
          search: "loser",
        });
        expect(loserOnly).toEqual([]);
      });
    });

    it("filters campaigns by account", async () => {
      await seedAccount("acc_x", "Account X");
      await seedCampaign("cmp_x", "Account X campaign", { accountId: "acc_x" });

      const rows = await caller.manager.campaigns({
        from: FROM,
        to: TO,
        accountId: "acc_x",
      });

      expect(rows.map((row) => row.id)).toEqual(["cmp_x"]);
      expect(rows[0].accountName).toBe("Account X");
    });
  });
});
