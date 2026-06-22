import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mockState = {
  executeRows: [] as Array<Record<string, unknown>[]>,
  selectRows: [] as Array<Record<string, unknown>[]>,
  executedSql: [] as unknown[],
};

const mockDb = {
  execute: vi.fn(async (query: unknown) => {
    mockState.executedSql.push(query);
    return { rows: mockState.executeRows.shift() ?? [] };
  }),
  select: vi.fn(() => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(async () => mockState.selectRows.shift() ?? []),
    };
    return chain;
  }),
};

const mockComputeCreativeHealthByCreativeId = vi.fn();

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/creative-health-rollup", () => ({
  computeCreativeHealthByCreativeId: mockComputeCreativeHealthByCreativeId,
}));
vi.mock("server-only", () => ({}));

const { createMockCaller } = await import("../test-helpers");

function queueExecuteRows(...rowSets: Array<Record<string, unknown>[]>) {
  mockState.executeRows.push(...rowSets);
}

function compileSql(query: unknown): string {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("adCreative analytics procedures", () => {
  beforeEach(() => {
    mockState.executeRows = [];
    mockState.selectRows = [];
    mockState.executedSql = [];
    vi.clearAllMocks();
    mockComputeCreativeHealthByCreativeId.mockResolvedValue(new Map());
  });

  describe("dashboardStats", () => {
    it("maps portfolio, leaderboard rows, and health rollups without changing public shape", async () => {
      mockComputeCreativeHealthByCreativeId.mockResolvedValue(
        new Map([
          ["creative_top", { health: "winner", reasons: ["High ROAS"] }],
          ["creative_bottom", { health: "fatigued", reasons: ["CPA rising"] }],
          ["creative_survivor", { health: "stable", reasons: ["Still profitable"] }],
        ]),
      );
      queueExecuteRows(
        [
          {
            total_spend: "1000",
            total_purchase_value: "2400",
            portfolio_roas: "2.4",
            portfolio_cpa: "50",
            portfolio_ctr: "0.012",
            total_conversions: "20",
          },
        ],
        [
          {
            id: "creative_top",
            name: "Top Creative",
            format: "video",
            asset_url: "https://example.com/top.png",
            video_url: "https://example.com/top.mp4",
            total_spend: "500",
            roas: "3.2",
            cpa: "25",
            ctr: "0.02",
            total_conversions: "20",
            ad_status: "active",
            running_days: 16,
          },
        ],
        [
          {
            id: "creative_survivor",
            name: "Survivor Creative",
            format: "static",
            asset_url: "https://example.com/survivor.png",
            video_url: null,
            total_spend: "350",
            roas: "1.5",
            cpa: "70",
            ctr: "0.01",
            total_conversions: "5",
            ad_status: "active",
            running_days: 24,
          },
        ],
        [
          {
            id: "creative_bottom",
            name: "Bottom Creative",
            format: "ugc",
            asset_url: "https://example.com/bottom.png",
            video_url: "https://example.com/bottom.mp4",
            total_spend: "250",
            roas: "0.4",
            cpa: "125",
            ctr: null,
            total_conversions: "2",
            ad_status: "active",
            bleeder_count: 2,
            active_ad_count: 3,
            bleeder_spend: "175",
            bleeder_at_risk: "105",
            has_winner: true,
            bleeder_meta_ids: ["meta_1", null, "meta_2"],
            tier: "pause_now",
          },
        ],
      );

      const caller = createMockCaller({ role: "admin", organizationId: "org_1" });
      const result = await caller.adCreative.dashboardStats({
        from: "2026-06-01",
        to: "2026-06-07",
        accountId: "acct_1",
        teamId: "team_1",
      });

      expect(result.portfolio).toEqual({
        totalSpend: "1000",
        totalRevenue: "2400",
        roas: "2.4",
        cpa: "50",
        ctr: "0.012",
        conversions: "20",
      });
      expect(result.topPerformers).toEqual([
        expect.objectContaining({
          id: "creative_top",
          name: "Top Creative",
          assetUrl: "https://example.com/top.png",
          videoUrl: "https://example.com/top.mp4",
          totalSpend: "500",
          roas: "3.2",
          cpa: "25",
          ctr: "0.02",
          conversions: "20",
          adStatus: "active",
          runningDays: 16,
          isEvergreen: true,
          health: "winner",
          healthReasons: ["High ROAS"],
        }),
      ]);
      expect(result.bottomPerformers).toEqual([
        expect.objectContaining({
          id: "creative_bottom",
          bleederAdCount: 2,
          activeAdCount: 3,
          bleederSpend: "175",
          bleederDollarsAtRisk: "105",
          hasWinnerAd: true,
          bleederMetaIds: ["meta_1", "meta_2"],
          tier: "pause_now",
          health: "fatigued",
          healthReasons: ["CPA rising"],
        }),
      ]);
      expect(result.survivingCreatives).toEqual([
        expect.objectContaining({
          id: "creative_survivor",
          name: "Survivor Creative",
          runningDays: 24,
          health: "stable",
          healthReasons: ["Still profitable"],
        }),
      ]);
      expect(mockComputeCreativeHealthByCreativeId).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org_1",
          creativeIds: ["creative_top", "creative_bottom", "creative_survivor"],
        }),
      );
    });
  });

  describe("portfolioSummary", () => {
    it("maps the same portfolio row shape as dashboardStats.portfolio", async () => {
      queueExecuteRows([
        {
          total_spend: "1000",
          total_purchase_value: "2400",
          portfolio_roas: "2.4",
          portfolio_cpa: "50",
          portfolio_ctr: "0.012",
          total_conversions: "20",
        },
      ]);

      const caller = createMockCaller({ role: "admin" });
      await expect(
        caller.adCreative.portfolioSummary({
          from: "2026-06-01",
          to: "2026-06-07",
          accountId: "acct_1",
          teamId: "team_1",
        }),
      ).resolves.toEqual({
        totalSpend: "1000",
        totalRevenue: "2400",
        roas: "2.4",
        cpa: "50",
        ctr: "0.012",
        conversions: "20",
      });
    });
  });

  describe("getDailyPortfolioPerformance", () => {
    it("fills missing middle zero-spend rows and trims trailing zero-spend rows", async () => {
      queueExecuteRows([
        {
          date_start: "2026-06-01",
          date_end: "2026-06-01",
          spend: "100",
          purchase_value: "250",
          roas: "2.5",
          cpa: "50",
          ctr: "0.01",
          conversions: 2,
          impressions: 1000,
          reach: 900,
          cpm: "100",
          link_clicks: 10,
        },
        {
          date_start: "2026-06-03",
          date_end: "2026-06-03",
          spend: "50",
          purchase_value: "75",
          roas: "1.5",
          cpa: "50",
          ctr: "0.02",
          conversions: 1,
          impressions: 500,
          reach: 450,
          cpm: "100",
          link_clicks: 8,
        },
        {
          date_start: "2026-06-04",
          date_end: "2026-06-04",
          spend: "0",
          purchase_value: "0",
          roas: null,
          cpa: null,
          ctr: null,
          conversions: 0,
          impressions: 0,
          reach: 0,
          cpm: null,
          link_clicks: 0,
        },
      ]);

      const caller = createMockCaller({ role: "admin" });
      const result = await caller.adCreative.getDailyPortfolioPerformance({
        from: "2026-06-01",
        to: "2026-06-04",
      });

      expect(result.map((row) => row.dateStart)).toEqual([
        "2026-06-01",
        "2026-06-02",
        "2026-06-03",
      ]);
      expect(result[1]).toEqual(
        expect.objectContaining({
          spend: "0",
          purchaseValue: "0",
          conversions: 0,
        }),
      );
    });
  });

  describe("getMerAccountBreakdown", () => {
    it("maps deltas and trims trailing zero-spend sparkline points", async () => {
      queueExecuteRows([
        {
          account_id: "acct_1",
          account_name: "Account One",
          spend: "300",
          revenue: "900",
          roas: "3",
          prior_spend: "250",
          prior_roas: "2.5",
          sparkline: [
            { date: "2026-06-01", spend: 100, revenue: 200, roas: 2 },
            { date: "2026-06-02", spend: 0, revenue: 0, roas: null },
            { date: "2026-06-03", spend: 200, revenue: 700, roas: 3.5 },
            { date: "2026-06-04", spend: 0, revenue: 0, roas: null },
          ],
        },
      ]);

      const caller = createMockCaller({ role: "admin" });
      const result = await caller.adCreative.getMerAccountBreakdown({
        from: "2026-06-01",
        to: "2026-06-04",
      });

      expect(result).toEqual([
        expect.objectContaining({
          accountId: "acct_1",
          accountName: "Account One",
          spendDelta: "50",
          roasDelta: "0.5",
          sparkline: [
            { date: "2026-06-01", spend: 100, revenue: 200, roas: 2 },
            { date: "2026-06-02", spend: 0, revenue: 0, roas: null },
            { date: "2026-06-03", spend: 200, revenue: 700, roas: 3.5 },
          ],
        }),
      ]);
    });
  });

  describe("adCreative.list", () => {
    it("returns the public fields used by the creatives page and includes health rollup data", async () => {
      mockComputeCreativeHealthByCreativeId.mockResolvedValue(
        new Map([["creative_1", { health: "winner", reasons: ["Efficient spend"] }]]),
      );
      queueExecuteRows([
        {
          id: "creative_1",
          name: "Creative One",
          asset_url: "https://example.com/asset.png",
          video_url: "https://example.com/video.mp4",
          destination_url: "https://example.com",
          format: "video",
          angle: "problem",
          persona: "founder",
          awareness_level: "problem_aware",
          hook: "Stop wasting spend",
          tone: "direct",
          cta: "Shop now",
          ownership: "ours",
          team_id: "team_1",
          notes: "note",
          created_at: new Date("2026-06-01T00:00:00.000Z"),
          updated_at: new Date("2026-06-02T00:00:00.000Z"),
          total_spend: "123.45",
          avg_roas: "2.25",
          total_conversions: 4,
          ad_status: "active",
          meta_ad_id: "meta_ad_1",
          avg_cpa: "30.86",
          avg_ctr: "0.012",
          meta_campaign_id: "meta_campaign_1",
          meta_ad_set_id: "meta_adset_1",
          account_name: "Main Account",
          recent_ctr: "0.013",
          recent_cpc: "1.1",
          avg_cpc: "1.2",
          avg_frequency: "1.8",
          recent_hook_rate: "0.2",
          prior_hook_rate: "0.15",
          recent_cpa: "28",
          thumbstop_ratio: "0.19",
        },
      ]);

      const caller = createMockCaller({ role: "admin", organizationId: "org_1" });
      const result = await caller.adCreative.list({
        from: "2026-06-01",
        to: "2026-06-07",
      });

      expect(result).toEqual([
        expect.objectContaining({
          id: "creative_1",
          name: "Creative One",
          assetUrl: "https://example.com/asset.png",
          videoUrl: "https://example.com/video.mp4",
          destinationUrl: "https://example.com",
          format: "video",
          angle: "problem",
          persona: "founder",
          awarenessLevel: "problem_aware",
          hook: "Stop wasting spend",
          tone: "direct",
          cta: "Shop now",
          ownership: "ours",
          teamId: "team_1",
          notes: "note",
          totalSpend: "123.45",
          avgRoas: "2.25",
          avgCpa: "30.86",
          avgCtr: "0.012",
          totalConversions: 4,
          adStatus: "active",
          metaAdId: "meta_ad_1",
          metaCampaignId: "meta_campaign_1",
          metaAdSetId: "meta_adset_1",
          accountName: "Main Account",
          recentCtr: "0.013",
          recentCpc: "1.1",
          avgCpc: "1.2",
          avgFrequency: "1.8",
          recentHookRate: "0.2",
          priorHookRate: "0.15",
          recentCpa: "28",
          thumbstopRatio: "0.19",
          health: "winner",
          healthReasons: ["Efficient spend"],
        }),
      ]);
      expect(mockComputeCreativeHealthByCreativeId).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org_1",
          creativeIds: ["creative_1"],
        }),
      );
    });

    it("can skip health rollup while preserving health fields", async () => {
      queueExecuteRows([
        {
          id: "creative_1",
          name: "Creative One",
          asset_url: null,
          video_url: null,
          destination_url: null,
          format: null,
          angle: null,
          persona: null,
          awareness_level: null,
          hook: null,
          tone: null,
          cta: null,
          ownership: null,
          team_id: null,
          notes: null,
          created_at: new Date("2026-06-01T00:00:00.000Z"),
          updated_at: new Date("2026-06-02T00:00:00.000Z"),
          total_spend: null,
          avg_roas: null,
          total_conversions: null,
          ad_status: null,
          meta_ad_id: null,
          avg_cpa: null,
          avg_ctr: null,
          meta_campaign_id: null,
          meta_ad_set_id: null,
          account_name: null,
          recent_ctr: null,
          recent_cpc: null,
          avg_cpc: null,
          avg_frequency: null,
          recent_hook_rate: null,
          prior_hook_rate: null,
          recent_cpa: null,
          thumbstop_ratio: null,
        },
      ]);

      const caller = createMockCaller({ role: "admin" });
      const result = await caller.adCreative.list({ includeHealth: false });

      expect(mockComputeCreativeHealthByCreativeId).not.toHaveBeenCalled();
      expect(result).toEqual([
        expect.objectContaining({
          id: "creative_1",
          health: null,
          healthReasons: [],
        }),
      ]);
    });

    it("filters are preserved in the set-based SQL path", async () => {
      queueExecuteRows([]);

      const caller = createMockCaller({ role: "admin", organizationId: "org_1" });
      await caller.adCreative.list({
        format: "video",
        awarenessLevel: "problem_aware",
        search: "hook",
        accountId: "acct_1",
        adSetIds: ["adset_1", "adset_2"],
        ownership: "theirs",
        teamId: "none",
        untaggedOnly: true,
        from: "2026-06-01",
        to: "2026-06-07",
        includeHealth: false,
      });

      const query = compileSql(mockState.executedSql[0]);
      expect(query).toContain("ac.organization_id =");
      expect(query).toContain("ac.format =");
      expect(query).toContain("ac.awareness_level =");
      expect(query).toContain("ac.name ILIKE");
      expect(query).toContain("ad.account_id =");
      expect(query).toContain("ad.ad_set_id IN");
      expect(query).toContain("ac.ownership IS NULL OR ac.ownership != 'ours'");
      expect(query).toContain("ac.team_id IS NULL");
      expect(query).toContain("ac.format IS NULL AND ac.angle IS NULL AND ac.awareness_level IS NULL");
      expect(query).toContain("pl.date_start >=");
      expect(query).toContain("pl.date_start <=");
    });
  });
});
