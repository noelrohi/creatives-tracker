import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, ne, or, isNull, desc, and, inArray, sql, type SQL } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";
import { adAccounts } from "@/schema/account";
import { adSets } from "@/schema/ad-set";
import { fetchMetaCreativePreview, fetchMetaAdPreviewUrl } from "@/lib/meta-creative-assets";
import { importMetaRows } from "@/lib/meta-import";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { assertBreakdownRange } from "@/lib/retention/window-guard";
import { computeCreativeHealthByCreativeId, type CreativeRollup } from "@/lib/creative-health-rollup";
import { fetchAgentExportRows } from "@/lib/ad-export";
import { effectiveAdActiveSql, effectiveAdStatusSql } from "@/lib/effective-ad-status";
import { ANGLE_TYPES, MODES, VISUAL_STYLES } from "@/lib/creative-taxonomy";

type CreativeAttributes = (typeof adCreatives.$inferSelect)["attributes"];
type CreativeAttributesMeta = (typeof adCreatives.$inferSelect)["attributesMeta"];

function enumerateDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

const creativeFormatSchema = z.enum(["static", "video", "ugc", "carousel"]);

const dashboardAnalyticsFilterSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
  from: z.string().optional(),
  to: z.string().optional(),
  accountId: z.string().optional(),
  campaignIds: z.array(z.string()).optional(),
  adSetIds: z.array(z.string()).optional(),
  statuses: z.array(z.enum(["active", "paused", "archived"])).optional(),
  ownership: z.enum(["ours", "theirs"]).optional(),
  teamId: z.string().optional(),
  format: creativeFormatSchema.optional(),
});

const dashboardAnalyticsInputSchema = dashboardAnalyticsFilterSchema.optional();
const dashboardStatsInputSchema = dashboardAnalyticsFilterSchema
  .extend({
    includePortfolio: z.boolean().optional(),
    /**
     * Rows per leaderboard, applied to all three the same way. The screen wants
     * ten; an API client reading "best and worst this week" wants three and
     * pays for the other seven in its context window on every call.
     */
    limit: z.number().int().min(1).max(50).default(10),
    /**
     * The surviving-creatives leaderboard is the one an API client is most
     * likely not to read; skipping it drops its query as well as its rows.
     */
    includeSurviving: z.boolean().optional(),
  })
  .optional();

const awarenessLevelSchema = z.enum([
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
]);
const ownershipSchema = z.enum(["ours", "theirs"]);
/**
 * The OUTPUT shape, deliberately permissive: legacy blobs predate the closed
 * vocabularies and must still read back. The write path validates instead —
 * see `creativeAttributesPatchSchema`.
 */
const creativeAttributesSchema = z.object({
  visualElements: z.array(z.string()).optional(),
  visualStyle: z.string().optional(),
  mode: z.string().optional(),
  hook: z.string().optional(),
  supportingTexts: z.array(z.string()).optional(),
  cta: z.string().optional(),
  promos: z.string().optional(),
  disclaimer: z.string().optional(),
});

/**
 * The human write path (spec §3: the vocabulary is "validated at the app layer
 * on write"). All eight captured attributes, so a person can write everything
 * the AI path writes, with the two closed fields held to the same vocabularies
 * the enrichment run enforces. `null` clears a field; omitted leaves it alone.
 */
const creativeAttributesPatchSchema = z.object({
  visualElements: z.array(z.string()).nullable().optional(),
  visualStyle: z.enum(VISUAL_STYLES).nullable().optional(),
  mode: z.enum(MODES).nullable().optional(),
  hook: z.string().nullable().optional(),
  supportingTexts: z.array(z.string()).nullable().optional(),
  cta: z.string().nullable().optional(),
  promos: z.string().nullable().optional(),
  disclaimer: z.string().nullable().optional(),
});

const CREATIVE_ATTRIBUTE_FIELDS = [
  "visualElements",
  "visualStyle",
  "mode",
  "hook",
  "supportingTexts",
  "cta",
  "promos",
  "disclaimer",
] as const satisfies readonly (keyof CreativeAttributes)[];
const creativeAttributesMetaSchema = z.record(
  z.string(),
  z.object({
    source: z.enum(["ai", "human"]),
    confidence: z.number().optional(),
  }),
);
const creativeHealthSchema = z.enum(["healthy", "warning", "critical"]);
const adStatusSchema = z.enum(["active", "paused", "archived"]);

const adCreativeRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  format: creativeFormatSchema.nullable(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awarenessLevel: awarenessLevelSchema.nullable(),
  attributes: creativeAttributesSchema,
  attributesMeta: creativeAttributesMetaSchema,
  tone: z.array(z.string()).nullable(),
  ownership: ownershipSchema.nullable(),
  teamId: z.string().nullable(),
  notes: z.string().nullable(),
  organizationId: z.string().nullable(),
  enrichmentAttemptedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const adCreativeListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  format: creativeFormatSchema.nullable(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awarenessLevel: awarenessLevelSchema.nullable(),
  attributes: creativeAttributesSchema,
  attributesMeta: creativeAttributesMetaSchema,
  tone: z.array(z.string()).nullable(),
  ownership: ownershipSchema.nullable(),
  teamId: z.string().nullable(),
  notes: z.string().nullable(),
  // The list resolver goes through raw SQL (db.execute), so timestamps
  // arrive as strings, not Date objects like the drizzle-select paths.
  createdAt: z.string(),
  updatedAt: z.string(),
  firstSeen: z.string().nullable(),
  totalSpend: z.string().nullable(),
  avgRoas: z.string().nullable(),
  totalConversions: z.string().nullable(),
  adStatus: adStatusSchema.nullable(),
  metaAdId: z.string().nullable(),
  avgCpa: z.string().nullable(),
  avgCtr: z.string().nullable(),
  metaCampaignId: z.string().nullable(),
  metaAdSetId: z.string().nullable(),
  accountName: z.string().nullable(),
  recentCtr: z.string().nullable(),
  recentCpc: z.string().nullable(),
  avgCpc: z.string().nullable(),
  avgFrequency: z.string().nullable(),
  recentHookRate: z.string().nullable(),
  priorHookRate: z.string().nullable(),
  recentCpa: z.string().nullable(),
  thumbstopRatio: z.string().nullable(),
  health: creativeHealthSchema.nullable(),
  healthReasons: z.array(z.string()),
  campaignNames: z.array(z.string()),
  campaignCount: z.number(),
  adSetNames: z.array(z.string()),
  adSetCount: z.number(),
  adCount: z.number(),
});
const adCreativeListOutputSchema = z.array(adCreativeListItemSchema);

const landingPagesOutputSchema = z.array(z.string());

const adExportRowSchema = z.object({
  adId: z.string(),
  metaAdId: z.string().nullable(),
  adName: z.string(),
  creativeId: z.string(),
  creativeName: z.string(),
  adSetId: z.string().nullable(),
  metaAdSetId: z.string().nullable(),
  adSetName: z.string().nullable(),
  campaignId: z.string().nullable(),
  metaCampaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  accountId: z.string().nullable(),
  accountName: z.string().nullable(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  format: z.string().nullable(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awarenessLevel: z.string().nullable(),
  hook: z.string().nullable(),
  cta: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  status: z.string().nullable(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  runningDays: z.number().nullable(),
  daysInWindow: z.number().nullable(),
  lastLogAt: z.string().nullable(),
  activeInWindow: z.boolean(),
  windowSpend: z.number().nullable(),
  windowRevenue: z.number().nullable(),
  windowConversions: z.number().nullable(),
  windowRoas: z.number().nullable(),
  windowCpa: z.number().nullable(),
  windowCtr: z.number().nullable(),
  windowCpc: z.number().nullable(),
  windowFrequency: z.number().nullable(),
  windowImpressions: z.number().nullable(),
  windowClicks: z.number().nullable(),
  windowHookRate: z.number().nullable(),
  demoWindowFrom: z.string(),
  demoWindowTo: z.string(),
  genderBreakdown: z.string().nullable(),
  ageBreakdown: z.string().nullable(),
  countryBreakdown: z.string().nullable(),
  deviceBreakdown: z.string().nullable(),
  lifetimeSpend: z.number().nullable(),
  lifetimeConversions: z.number().nullable(),
  lifetimeRoas: z.number().nullable(),
  ctrDeltaPct: z.number().nullable(),
  cpcDeltaPct: z.number().nullable(),
  cpaDeltaPct: z.number().nullable(),
  hookRateDeltaPct: z.number().nullable(),
  adHealth: creativeHealthSchema.nullable(),
  adHealthReasons: z.array(z.string()),
  creativeRollupHealth: creativeHealthSchema.nullable(),
  creativeRollupReasons: z.array(z.string()),
  dollarsAtRisk: z.number(),
  flagDisableCandidate: z.boolean(),
  flagScaleCandidate: z.boolean(),
  flagReviewCandidate: z.boolean(),
  disableTier: z.enum(["pause_now", "watch", "cooking"]).nullable(),
  creativeHasWinners: z.boolean(),
});

const creativeExportRowSchema = z.object({
  creativeId: z.string(),
  creativeName: z.string(),
  accountId: z.string().nullable(),
  accountName: z.string().nullable(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  format: z.string().nullable(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awarenessLevel: z.string().nullable(),
  hook: z.string().nullable(),
  cta: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  adCount: z.number(),
  activeAdCount: z.number(),
  activeInWindow: z.boolean(),
  windowSpend: z.number().nullable(),
  windowRevenue: z.number().nullable(),
  windowConversions: z.number().nullable(),
  windowRoas: z.number().nullable(),
  windowCpa: z.number().nullable(),
  windowCtr: z.number().nullable(),
  lifetimeSpend: z.number().nullable(),
  lifetimeConversions: z.number().nullable(),
  lifetimeRoas: z.number().nullable(),
  runningDays: z.number().nullable(),
  lastLogAt: z.string().nullable(),
  rollupHealth: creativeHealthSchema.nullable(),
  rollupReasons: z.array(z.string()),
  dollarsAtRisk: z.number(),
  flagDisableCandidate: z.boolean(),
  flagScaleCandidate: z.boolean(),
  flagReviewCandidate: z.boolean(),
});

const exportAgentRowsOutputSchema = z.object({
  ads: z.array(adExportRowSchema),
  creatives: z.array(creativeExportRowSchema),
});

const trackerListItemSchema = z.object({
  adId: z.string(),
  adName: z.string(),
  creativeId: z.string().nullable(),
  creativeName: z.string().nullable(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  format: creativeFormatSchema.nullable(),
  ownership: ownershipSchema.nullable(),
  destinationUrl: z.string().nullable(),
  dateStart: z.string(),
  dateEnd: z.string(),
  spend: z.string().nullable(),
  roas: z.string().nullable(),
  cpa: z.string().nullable(),
  ctr: z.string().nullable(),
  conversions: z.number().nullable(),
  impressions: z.number().nullable(),
  linkClicks: z.number().nullable(),
  purchaseValue: z.string().nullable(),
  landingPageViews: z.number().nullable(),
});
const trackerListOutputSchema = z.array(trackerListItemSchema);

const portfolioSummarySchema = z.object({
  totalSpend: z.string().nullable(),
  totalRevenue: z.string().nullable(),
  roas: z.string().nullable(),
  cpa: z.string().nullable(),
  ctr: z.string().nullable(),
  conversions: z.string().nullable(),
});

const dashboardPerformerSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: creativeFormatSchema.nullable(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  totalSpend: z.string(),
  roas: z.string(),
  cpa: z.string().nullable(),
  ctr: z.string().nullable(),
  conversions: z.string().nullable(),
  adStatus: z.string().nullable(),
  health: creativeHealthSchema.nullable(),
  healthReasons: z.array(z.string()),
});

const dashboardStatsOutputSchema = z.object({
  portfolio: portfolioSummarySchema,
  topPerformers: z.array(dashboardPerformerSchema.extend({
    runningDays: z.number(),
    isEvergreen: z.boolean(),
  })),
  bottomPerformers: z.array(dashboardPerformerSchema.extend({
    bleederAdCount: z.number(),
    activeAdCount: z.number(),
    bleederSpend: z.string(),
    bleederDollarsAtRisk: z.string(),
    hasWinnerAd: z.boolean(),
    bleederMetaIds: z.array(z.string()),
    tier: z.enum(["pause_now", "watch"]),
  })),
  survivingCreatives: z.array(dashboardPerformerSchema.extend({
    runningDays: z.number(),
  })),
});

const dashboardExportRowSchema = z.object({
  date_start: z.string(),
  date_end: z.string(),
  campaign_name: z.string().nullable(),
  ad_set_name: z.string().nullable(),
  ad_name: z.string(),
  ad_status: z.string(),
  caption: z.string().nullable(),
  destination_url: z.string().nullable(),
  creative_name: z.string(),
  format: creativeFormatSchema.nullable(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awareness_level: awarenessLevelSchema.nullable(),
  ownership: ownershipSchema.nullable(),
  asset_url: z.string().nullable(),
  video_url: z.string().nullable(),
  spend: z.string().nullable(),
  impressions: z.number().nullable(),
  reach: z.number().nullable(),
  frequency: z.string().nullable(),
  cpm: z.string().nullable(),
  cpc: z.string().nullable(),
  link_clicks: z.number().nullable(),
  ctr: z.string().nullable(),
  landing_page_views: z.number().nullable(),
  cost_per_lpv: z.string().nullable(),
  conversions: z.number().nullable(),
  purchase_value: z.string().nullable(),
  roas: z.string().nullable(),
  cpa: z.string().nullable(),
  add_to_cart: z.number().nullable(),
  initiate_checkout: z.number().nullable(),
  cost_per_add_to_cart: z.string().nullable(),
  video_views_3s: z.number().nullable(),
  video_thruplay: z.number().nullable(),
  video_avg_watch_time: z.string().nullable(),
  country: z.string().nullable(),
  platform: z.string().nullable(),
  placement: z.string().nullable(),
  device: z.string().nullable(),
  age: z.string().nullable(),
  gender: z.string().nullable(),
  quality_ranking: z.string().nullable(),
  engagement_rate_ranking: z.string().nullable(),
  conversion_rate_ranking: z.string().nullable(),
});
const dashboardExportOutputSchema = z.array(dashboardExportRowSchema);

const dailyPortfolioPerformanceRowSchema = z.object({
  dateStart: z.string(),
  dateEnd: z.string(),
  spend: z.string().nullable(),
  purchaseValue: z.string().nullable(),
  roas: z.string().nullable(),
  cpa: z.string().nullable(),
  ctr: z.string().nullable(),
  conversions: z.number(),
  impressions: z.number(),
  reach: z.number(),
  cpm: z.string().nullable(),
  linkClicks: z.number(),
});
const dailyPortfolioPerformanceOutputSchema = z.array(dailyPortfolioPerformanceRowSchema);

const merSparklinePointSchema = z.object({
  date: z.string(),
  spend: z.number(),
  revenue: z.number(),
  roas: z.number().nullable(),
});
const merAccountBreakdownOutputSchema = z.array(z.object({
  accountId: z.string(),
  accountName: z.string(),
  spend: z.string().nullable(),
  revenue: z.string().nullable(),
  roas: z.string().nullable(),
  priorSpend: z.string().nullable(),
  priorRoas: z.string().nullable(),
  spendDelta: z.string().nullable(),
  roasDelta: z.string().nullable(),
  sparkline: z.array(merSparklinePointSchema),
}));

const adCreativeDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  format: creativeFormatSchema.nullable(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awarenessLevel: awarenessLevelSchema.nullable(),
  attributes: creativeAttributesSchema,
  attributesMeta: creativeAttributesMetaSchema,
  tone: z.array(z.string()).nullable(),
  ownership: ownershipSchema.nullable(),
  teamId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const adPreviewUrlOutputSchema = z.object({
  previewUrl: z.string().nullable(),
});

const metaCreativePreviewSchema = z.object({
  assetUrl: z.string().nullable(),
  format: z.enum(["static", "video"]).nullable(),
  videoUrl: z.string().optional(),
  destinationUrl: z.string().optional(),
  caption: z.string().optional(),
});

const bulkUpdateOutputSchema = z.object({ updated: z.number() });
const bulkImportOutputSchema = z.object({
  created: z.array(z.object({ id: z.string(), name: z.string() })),
  totalRows: z.number(),
  uniqueAds: z.number(),
  perfLogs: z.number(),
  // Rows the staging guard refused because they fall outside their retention
  // window. Reported so the import UI can say what didn't land.
  droppedExpiredRows: z.number(),
});

const creativePerformanceOutputSchema = z.object({
  totalSpend: z.string().nullable(),
  avgRoas: z.string().nullable(),
  avgCpa: z.string().nullable(),
  avgCtr: z.string().nullable(),
  totalConversions: z.string().nullable(),
  totalImpressions: z.string().nullable(),
  totalClicks: z.string().nullable(),
  logCount: z.string(),
  minDate: z.string().nullable(),
  maxDate: z.string().nullable(),
  portfolioAvgRoas: z.string().nullable(),
  portfolioAvgCpa: z.string().nullable(),
  portfolioAvgCtr: z.string().nullable(),
  liveStatus: z.enum(["no_ads", "active", "paused"]),
});

const dailyPerformanceRowSchema = z.object({
  dateStart: z.string(),
  dateEnd: z.string(),
  spend: z.string().nullable(),
  purchaseValue: z.string().nullable(),
  roas: z.string().nullable(),
  cpa: z.string().nullable(),
  ctr: z.string().nullable(),
  conversions: z.string().nullable(),
  impressions: z.string().nullable(),
  reach: z.string().nullable(),
  cpm: z.string().nullable(),
  linkClicks: z.string().nullable(),
});
const dailyPerformanceOutputSchema = z.array(dailyPerformanceRowSchema);

type DashboardAnalyticsInput = z.infer<typeof dashboardAnalyticsInputSchema>;

type PortfolioRow = {
  total_spend: string | null;
  total_purchase_value: string | null;
  portfolio_roas: string | null;
  portfolio_cpa: string | null;
  portfolio_ctr: string | null;
  total_conversions: string | null;
};

function buildDashboardAnalyticsFilters(input: DashboardAnalyticsInput, organizationId: string) {
  const days = input?.days ?? 7;
  const accountFilter = input?.accountId
    ? sql`AND ad.account_id = ${input.accountId}`
    : sql``;
  const ownershipFilter = input?.ownership
    ? input.ownership === "theirs"
      ? sql`AND (ac.ownership IS NULL OR ac.ownership != 'ours')`
      : sql`AND ac.ownership = ${input.ownership}`
    : sql``;
  const teamFilter = input?.teamId
    ? sql`AND ac.team_id = ${input.teamId}`
    : sql``;
  const formatFilter = input?.format
    ? sql`AND ac.format = ${input.format}`
    : sql``;
  const basePl = basePerformanceLogFilter("pl");
  const campaignFilter = input?.campaignIds?.length
    ? sql`AND ad.ad_set_id IN (SELECT ast.id FROM ad_set ast WHERE ast.campaign_id IN (${sql.join(input.campaignIds.map((id) => sql`${id}`), sql`, `)}))`
    : sql``;
  const adSetFilter = input?.adSetIds?.length
    ? sql`AND ad.ad_set_id IN (${sql.join(input.adSetIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const statusFilter = input?.statuses?.length
    ? sql`AND ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} IN (${sql.join(input.statuses.map((s) => sql`${s}`), sql`, `)})`
    : sql``;

  const dateFilter = input?.from && input?.to
    ? sql`pl.date_start <= ${input.to}::date AND pl.date_end >= ${input.from}::date`
    : sql`pl.date_start <= current_date AND pl.date_end >= current_date - ${days}::int`;

  return {
    accountFilter,
    ownershipFilter,
    teamFilter,
    formatFilter,
    basePl,
    campaignFilter,
    adSetFilter,
    statusFilter,
    dateFilter,
    organizationId,
  };
}

async function fetchPortfolioRow(filters: ReturnType<typeof buildDashboardAnalyticsFilters>) {
  const portfolioResult = await db.execute(sql`
    SELECT
      sum(pl.spend)::text as total_spend,
      sum(pl.purchase_value)::text as total_purchase_value,
      (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as portfolio_roas,
      (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as portfolio_cpa,
      avg(pl.ctr)::text as portfolio_ctr,
      sum(pl.conversions)::text as total_conversions
    FROM performance_log pl
    JOIN ad ON ad.id = pl.ad_id
    LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
    JOIN ad_creative ac ON ac.id = ad.ad_creative_id
    WHERE ${filters.dateFilter}
      AND ${filters.basePl}
      AND ad.organization_id = ${filters.organizationId}
      ${filters.accountFilter}
      ${filters.campaignFilter}
      ${filters.adSetFilter}
      ${filters.statusFilter}
      ${filters.ownershipFilter}
      ${filters.teamFilter}
      ${filters.formatFilter}
  `);
  return (portfolioResult.rows as PortfolioRow[])[0];
}

function mapPortfolioRow(portfolio: PortfolioRow | undefined) {
  return {
    totalSpend: portfolio?.total_spend ?? null,
    totalRevenue: portfolio?.total_purchase_value ?? null,
    roas: portfolio?.portfolio_roas ?? null,
    cpa: portfolio?.portfolio_cpa ?? null,
    ctr: portfolio?.portfolio_ctr ?? null,
    conversions: portfolio?.total_conversions ?? null,
  };
}

export const adCreativeRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("adCreative", "list"))
    .output(adCreativeListOutputSchema)
    .input(
      z
        .object({
          format: z
            .enum(["static", "video", "ugc", "carousel"])
            .optional(),
          awarenessLevel: z
            .enum([
              "unaware",
              "problem_aware",
              "solution_aware",
              "product_aware",
              "most_aware",
            ])
            .optional(),
          search: z.string().optional(),
          accountId: z.string().optional(),
          adSetIds: z.array(z.string()).optional(),
          campaignIds: z.array(z.string()).optional(),
          landingPageUrls: z.array(z.string()).optional(),
          statuses: z.array(adStatusSchema).optional(),
          ownership: z.enum(["ours", "theirs"]).optional(),
          teamId: z.string().optional(),
          untaggedOnly: z.boolean().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          includeHealth: z.boolean().optional(),
          minRoas: z.number().finite().nonnegative().optional(),
          minConversions: z.number().finite().nonnegative().optional(),
          minCtr: z.number().finite().nonnegative().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const includeHealth = input?.includeHealth ?? true;
      const conditions: SQL[] = [sql`ac.organization_id = ${ctx.organizationId}`];
      if (input?.format) {
        conditions.push(sql`ac.format = ${input.format}`);
      }
      if (input?.awarenessLevel) {
        conditions.push(sql`ac.awareness_level = ${input.awarenessLevel}`);
      }
      if (input?.search) {
        conditions.push(sql`ac.name ILIKE ${`%${input.search}%`}`);
      }
      // Per-ad predicates, written against the `ad` / `ad_set ast` aliases so the
      // same fragments drive both the filtered_creatives EXISTS and ad_rollup.
      const adConditions: SQL[] = [];
      if (input?.accountId) {
        adConditions.push(sql`ad.account_id = ${input.accountId}`);
      }
      if (input?.adSetIds?.length) {
        const inList = sql.join(input.adSetIds.map((id) => sql`${id}`), sql`, `);
        adConditions.push(sql`ad.ad_set_id IN (${inList})`);
      }
      if (input?.campaignIds?.length) {
        const inList = sql.join(input.campaignIds.map((id) => sql`${id}`), sql`, `);
        adConditions.push(sql`ast.campaign_id IN (${inList})`);
      }
      if (input?.landingPageUrls?.length) {
        const urls = sql.join(input.landingPageUrls.map((url) => sql`${url}`), sql`, `);
        adConditions.push(sql`split_part(ad.destination_url, '?', 1) IN (${urls})`);
      }
      if (input?.statuses?.length) {
        const inList = sql.join(input.statuses.map((status) => sql`${status}`), sql`, `);
        adConditions.push(sql`${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} IN (${inList})`);
      }
      if (adConditions.length) {
        conditions.push(sql`EXISTS (SELECT 1 FROM ad LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id WHERE ad.ad_creative_id = ac.id AND ${sql.join(adConditions, sql` AND `)})`);
      }
      if (input?.ownership) {
        if (input.ownership === "theirs") {
          conditions.push(sql`(ac.ownership IS NULL OR ac.ownership != 'ours')`);
        } else {
          conditions.push(sql`ac.ownership = ${input.ownership}`);
        }
      }
      if (input?.teamId === "none") {
        conditions.push(sql`ac.team_id IS NULL`);
      } else if (input?.teamId) {
        conditions.push(sql`ac.team_id = ${input.teamId}`);
      }
      if (input?.untaggedOnly) {
        conditions.push(sql`(ac.format IS NULL AND ac.angle IS NULL AND ac.awareness_level IS NULL)`);
      }

      const { from, to } = input ?? {};
      const plBase = basePerformanceLogFilter("pl");
      const plWindowFilter = from && to
        ? sql`pl.date_start >= ${from}::date AND pl.date_start <= ${to}::date AND ${plBase}`
        : plBase;
      const dateFilterForRollup = from && to
        ? sql`pl.date_start >= ${from}::date AND pl.date_start <= ${to}::date`
        : undefined;
      const performanceConditions: SQL[] = [sql`TRUE`];
      if (input?.minRoas != null) performanceConditions.push(sql`window_perf.avg_roas::numeric > ${input.minRoas}`);
      if (input?.minConversions != null) performanceConditions.push(sql`window_perf.total_conversions::numeric > ${input.minConversions}`);
      if (input?.minCtr != null) performanceConditions.push(sql`window_perf.avg_ctr::numeric > ${input.minCtr}`);

      type ListRow = {
        id: string;
        name: string;
        asset_url: string | null;
        video_url: string | null;
        destination_url: string | null;
        format: z.infer<typeof creativeFormatSchema> | null;
        angle: string | null;
        persona: string | null;
        awareness_level: z.infer<typeof awarenessLevelSchema> | null;
        attributes: CreativeAttributes;
        attributes_meta: CreativeAttributesMeta;
        tone: string[] | null;
        ownership: z.infer<typeof ownershipSchema> | null;
        team_id: string | null;
        notes: string | null;
        // db.execute returns raw pg values: timestamps arrive as strings here
        created_at: string;
        updated_at: string;
        first_seen: string | null;
        total_spend: string | null;
        avg_roas: string | null;
        total_conversions: string | null;
        ad_status: z.infer<typeof adStatusSchema> | null;
        meta_ad_id: string | null;
        avg_cpa: string | null;
        avg_ctr: string | null;
        meta_campaign_id: string | null;
        meta_ad_set_id: string | null;
        account_name: string | null;
        recent_ctr: string | null;
        recent_cpc: string | null;
        avg_cpc: string | null;
        avg_frequency: string | null;
        recent_hook_rate: string | null;
        prior_hook_rate: string | null;
        recent_cpa: string | null;
        thumbstop_ratio: string | null;
        campaign_names: string[] | null;
        campaign_count: number | null;
        ad_set_names: string[] | null;
        ad_set_count: number | null;
        ad_count: number | null;
      };

      const result = await db.execute(sql`
        WITH filtered_creatives AS (
          SELECT
            ac.id,
            ac.name,
            ac.asset_url,
            ac.video_url,
            ac.format,
            ac.angle,
            ac.persona,
            ac.awareness_level,
            ac.attributes,
            ac.attributes_meta,
            ac.tone,
            ac.ownership,
            ac.team_id,
            ac.notes,
            ac.created_at,
            ac.updated_at
          FROM ad_creative ac
          WHERE ${sql.join(conditions, sql` AND `)}
        ),
        first_delivery AS (
          SELECT
            ad.ad_creative_id,
            min(pl.date_start)::text AS first_seen
          FROM filtered_creatives fc
          JOIN ad ON ad.ad_creative_id = fc.id
          JOIN performance_log pl ON pl.ad_id = ad.id
          GROUP BY ad.ad_creative_id
        ),
        window_perf AS (
          SELECT
            ad.ad_creative_id,
            sum(pl.spend)::text AS total_spend,
            (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text AS avg_roas,
            sum(pl.conversions) AS total_conversions,
            (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text AS avg_cpa,
            avg(pl.ctr)::text AS avg_ctr,
            avg(pl.cpc)::text AS avg_cpc,
            avg(pl.frequency)::text AS avg_frequency,
            (sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0))::text AS thumbstop_ratio
          FROM filtered_creatives fc
          JOIN ad ON ad.ad_creative_id = fc.id
          JOIN performance_log pl ON pl.ad_id = ad.id
          WHERE ${plWindowFilter}
          GROUP BY ad.ad_creative_id
        ),
        recent_cutoff AS (
          SELECT
            ad.ad_creative_id,
            max(pl.date_end) - 3 AS cutoff
          FROM filtered_creatives fc
          JOIN ad ON ad.ad_creative_id = fc.id
          JOIN performance_log pl ON pl.ad_id = ad.id
          WHERE ${plWindowFilter}
          GROUP BY ad.ad_creative_id
        ),
        recent_perf AS (
          SELECT
            ad.ad_creative_id,
            (coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0))::text AS recent_ctr,
            avg(pl.cpc)::text AS recent_cpc,
            (sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0))::text AS recent_hook_rate,
            (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text AS recent_cpa
          FROM recent_cutoff rc
          JOIN ad ON ad.ad_creative_id = rc.ad_creative_id
          JOIN performance_log pl ON pl.ad_id = ad.id
          WHERE ${plWindowFilter}
            AND pl.date_start > rc.cutoff
          GROUP BY ad.ad_creative_id
        ),
        prior_perf AS (
          SELECT
            ad.ad_creative_id,
            (sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0))::text AS prior_hook_rate
          FROM recent_cutoff rc
          JOIN ad ON ad.ad_creative_id = rc.ad_creative_id
          JOIN performance_log pl ON pl.ad_id = ad.id
          WHERE ${plWindowFilter}
            AND pl.date_end <= rc.cutoff
          GROUP BY ad.ad_creative_id
        ),
        ad_rollup AS (
          SELECT
            ad.ad_creative_id,
            count(DISTINCT ad.id)::int AS ad_count,
            count(DISTINCT c.id)::int AS campaign_count,
            array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL) AS campaign_names,
            count(DISTINCT ast.id)::int AS ad_set_count,
            array_agg(DISTINCT ast.name) FILTER (WHERE ast.name IS NOT NULL) AS ad_set_names
          FROM filtered_creatives fc
          JOIN ad ON ad.ad_creative_id = fc.id
          LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
          LEFT JOIN campaign c ON c.id = ast.campaign_id
          WHERE ${sql.join([sql`TRUE`, ...adConditions], sql` AND `)}
          GROUP BY ad.ad_creative_id
        ),
        latest_ad AS (
          SELECT DISTINCT ON (ad.ad_creative_id)
            ad.ad_creative_id,
            ad.destination_url,
            ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} AS ad_status,
            ad.meta_id AS meta_ad_id,
            c.meta_id AS meta_campaign_id,
            ast.meta_id AS meta_ad_set_id,
            acc.name AS account_name
          FROM filtered_creatives fc
          JOIN ad ON ad.ad_creative_id = fc.id
          LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
          LEFT JOIN campaign c ON c.id = ast.campaign_id
          LEFT JOIN ad_account acc ON acc.id = ad.account_id
          WHERE ${sql.join([sql`TRUE`, ...adConditions], sql` AND `)}
          ORDER BY
            ad.ad_creative_id,
            ${effectiveAdActiveSql(sql`ad.status`, sql`ast.status`)} DESC,
            (ad.destination_url IS NOT NULL) DESC,
            ad.updated_at DESC NULLS LAST,
            ad.created_at DESC
        )
        SELECT
          fc.id,
          fc.name,
          fc.asset_url,
          fc.video_url,
          latest_ad.destination_url,
          fc.format,
          fc.angle,
          fc.persona,
          fc.awareness_level,
          fc.attributes,
          fc.attributes_meta,
          fc.tone,
          fc.ownership,
          fc.team_id,
          fc.notes,
          fc.created_at,
          fc.updated_at,
          first_delivery.first_seen,
          window_perf.total_spend,
          window_perf.avg_roas,
          window_perf.total_conversions,
          latest_ad.ad_status,
          latest_ad.meta_ad_id,
          window_perf.avg_cpa,
          window_perf.avg_ctr,
          latest_ad.meta_campaign_id,
          latest_ad.meta_ad_set_id,
          latest_ad.account_name,
          recent_perf.recent_ctr,
          recent_perf.recent_cpc,
          window_perf.avg_cpc,
          window_perf.avg_frequency,
          recent_perf.recent_hook_rate,
          prior_perf.prior_hook_rate,
          recent_perf.recent_cpa,
          window_perf.thumbstop_ratio,
          ad_rollup.campaign_names,
          ad_rollup.campaign_count,
          ad_rollup.ad_set_names,
          ad_rollup.ad_set_count,
          ad_rollup.ad_count
        FROM filtered_creatives fc
        LEFT JOIN first_delivery ON first_delivery.ad_creative_id = fc.id
        LEFT JOIN window_perf ON window_perf.ad_creative_id = fc.id
        LEFT JOIN recent_perf ON recent_perf.ad_creative_id = fc.id
        LEFT JOIN prior_perf ON prior_perf.ad_creative_id = fc.id
        LEFT JOIN latest_ad ON latest_ad.ad_creative_id = fc.id
        LEFT JOIN ad_rollup ON ad_rollup.ad_creative_id = fc.id
        WHERE ${sql.join(performanceConditions, sql` AND `)}
        ORDER BY fc.created_at DESC
      `);
      const rows = result.rows as ListRow[];

      const healthByCreative = includeHealth
        ? await computeCreativeHealthByCreativeId({
            organizationId: ctx.organizationId,
            creativeIds: rows.map((r) => r.id),
            dateFilter: dateFilterForRollup,
          })
        : new Map<string, CreativeRollup>();

      return rows.map((r) => {
        const rollup = healthByCreative.get(r.id);
        return {
          id: r.id,
          name: r.name,
          assetUrl: r.asset_url,
          videoUrl: r.video_url,
          destinationUrl: r.destination_url,
          format: r.format,
          angle: r.angle,
          persona: r.persona,
          awarenessLevel: r.awareness_level,
          attributes: r.attributes,
          attributesMeta: r.attributes_meta,
          tone: r.tone,
          ownership: r.ownership,
          teamId: r.team_id,
          notes: r.notes,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          firstSeen: r.first_seen,
          totalSpend: r.total_spend,
          avgRoas: r.avg_roas,
          totalConversions: r.total_conversions,
          adStatus: r.ad_status,
          metaAdId: r.meta_ad_id,
          avgCpa: r.avg_cpa,
          avgCtr: r.avg_ctr,
          metaCampaignId: r.meta_campaign_id,
          metaAdSetId: r.meta_ad_set_id,
          accountName: r.account_name,
          recentCtr: r.recent_ctr,
          recentCpc: r.recent_cpc,
          avgCpc: r.avg_cpc,
          avgFrequency: r.avg_frequency,
          recentHookRate: r.recent_hook_rate,
          priorHookRate: r.prior_hook_rate,
          recentCpa: r.recent_cpa,
          thumbstopRatio: r.thumbstop_ratio,
          health: rollup?.health ?? null,
          healthReasons: rollup?.reasons ?? [],
          campaignNames: r.campaign_names ?? [],
          campaignCount: r.campaign_count ?? 0,
          adSetNames: r.ad_set_names ?? [],
          adSetCount: r.ad_set_count ?? 0,
          adCount: r.ad_count ?? 0,
        };
      });
    }),

  landingPages: orgProcedure
    .meta(openApiQueryMeta("adCreative", "landingPages"))
    .output(landingPagesOutputSchema)
    .query(async ({ ctx }) => {
    const result = await db.execute(sql`
      SELECT DISTINCT split_part(destination_url, '?', 1) AS destination_url
      FROM ad
      WHERE organization_id = ${ctx.organizationId}
        AND destination_url IS NOT NULL
        AND btrim(destination_url) <> ''
      ORDER BY destination_url
    `);
    return (result.rows as { destination_url: string }[]).map((row) => row.destination_url);
  }),

  exportAgentRows: orgProcedure
    .meta(openApiQueryMeta("adCreative", "exportAgentRows"))
    .output(exportAgentRowsOutputSchema)
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        accountId: z.string().optional(),
        adSetIds: z.array(z.string()).optional(),
        campaignIds: z.array(z.string()).optional(),
        landingPageUrls: z.array(z.string()).optional(),
        statuses: z.array(adStatusSchema).optional(),
        teamId: z.string().optional(),
        format: z.string().optional(),
        awarenessLevel: z.string().optional(),
        ownership: z.enum(["ours", "theirs"]).optional(),
        search: z.string().optional(),
        untaggedOnly: z.boolean().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return fetchAgentExportRows({
        organizationId: ctx.organizationId,
        from: input.from,
        to: input.to,
        filter: {
          accountId: input.accountId ?? null,
          adSetIds: input.adSetIds ?? null,
          campaignIds: input.campaignIds ?? null,
          landingPageUrls: input.landingPageUrls ?? null,
          statuses: input.statuses ?? null,
          teamId: input.teamId ?? null,
          format: input.format ?? null,
          awarenessLevel: input.awarenessLevel ?? null,
          ownership: input.ownership ?? null,
          search: input.search ?? null,
          untaggedOnly: input.untaggedOnly ?? null,
        },
      });
    }),

  trackerList: orgProcedure
    .meta(openApiQueryMeta("adCreative", "trackerList"))
    .output(trackerListOutputSchema)
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        accountId: z.string().nullish(),
        ownership: z.enum(["ours", "theirs"]).nullish(),
        teamId: z.string().nullish(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const conditions: SQL[] = [
        eq(ads.organizationId, ctx.organizationId),
        effectiveAdActiveSql(ads.status, adSets.status),
      ];
      if (input?.accountId) {
        conditions.push(eq(ads.accountId, input.accountId));
      }
      if (input?.ownership) {
        if (input.ownership === "theirs") {
          conditions.push(or(ne(adCreatives.ownership, "ours"), isNull(adCreatives.ownership))!);
        } else {
          conditions.push(eq(adCreatives.ownership, input.ownership));
        }
      }
      if (input?.teamId === "none") {
        conditions.push(isNull(adCreatives.teamId));
      } else if (input?.teamId) {
        conditions.push(eq(adCreatives.teamId, input.teamId));
      }
      // Performance rows can be stored as multi-day windows (for example a
      // 7-day imported report), so the tracker should include any row that
      // overlaps the selected range instead of requiring full containment.
      if (input?.from && input?.to) {
        conditions.push(sql`${performanceLogs.dateStart} <= ${input.to}`);
        conditions.push(sql`${performanceLogs.dateEnd} >= ${input.from}`);
      } else if (input?.from) {
        conditions.push(sql`${performanceLogs.dateEnd} >= ${input.from}`);
      } else if (input?.to) {
        conditions.push(sql`${performanceLogs.dateStart} <= ${input.to}`);
      }

      return db
        .select({
          adId: ads.id,
          adName: ads.name,
          creativeId: adCreatives.id,
          creativeName: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          videoUrl: adCreatives.videoUrl,
          format: adCreatives.format,
          ownership: adCreatives.ownership,
          destinationUrl: ads.destinationUrl,
          dateStart: performanceLogs.dateStart,
          dateEnd: performanceLogs.dateEnd,
          spend: performanceLogs.spend,
          roas: performanceLogs.roas,
          cpa: performanceLogs.cpa,
          ctr: performanceLogs.ctr,
          conversions: performanceLogs.conversions,
          impressions: performanceLogs.impressions,
          linkClicks: performanceLogs.linkClicks,
          purchaseValue: performanceLogs.purchaseValue,
          landingPageViews: performanceLogs.landingPageViews,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .where(and(...conditions))
        .orderBy(desc(performanceLogs.dateStart), ads.name);
    }),

  portfolioSummary: orgProcedure
    .meta(openApiQueryMeta("adCreative", "portfolioSummary"))
    .output(portfolioSummarySchema)
    .input(dashboardAnalyticsInputSchema)
    .query(async ({ input, ctx }) => {
      const filters = buildDashboardAnalyticsFilters(input, ctx.organizationId);
      const portfolio = await fetchPortfolioRow(filters);
      return mapPortfolioRow(portfolio);
    }),

  dashboardStats: orgProcedure
    .meta(openApiQueryMeta("adCreative", "dashboardStats"))
    .output(dashboardStatsOutputSchema)
    .input(dashboardStatsInputSchema)
    .query(async ({ input, ctx }) => {
      const filters = buildDashboardAnalyticsFilters(input, ctx.organizationId);
      const {
        accountFilter,
        ownershipFilter,
        teamFilter,
        formatFilter,
        basePl,
        campaignFilter,
        adSetFilter,
        statusFilter,
        dateFilter,
      } = filters;
      const includePortfolio = input?.includePortfolio !== false;
      const limit = input?.limit ?? 10;
      const includeSurviving = input?.includeSurviving !== false;
      const portfolio = includePortfolio
        ? await fetchPortfolioRow(filters)
        : undefined;

      // "Fair shot" floor: an ad needs to have spent ~one portfolio CPA before
      // we can confidently call it dead. Floor at $50 in case portfolio CPA is
      // unusually low (e.g. low-priced product or sparse data).
      const portfolioCpaNum = portfolio?.portfolio_cpa != null ? parseFloat(portfolio.portfolio_cpa) : null;
      const fairShotSpend = Math.max(50, portfolioCpaNum && Number.isFinite(portfolioCpaNum) ? portfolioCpaNum : 50);
      const fairShotSpendSql = includePortfolio ? sql`${fairShotSpend}` : sql`pw.fair_shot_spend`;
      const portfolioWindowCte = includePortfolio
        ? sql``
        : sql`
        portfolio_window AS (
          SELECT
            greatest(50, coalesce(sum(spend) / nullif(sum(conversions), 0), 50)) AS fair_shot_spend
          FROM ad_window
        ),
      `;
      const portfolioWindowJoin = includePortfolio ? sql`` : sql`CROSS JOIN portfolio_window pw`;

      type CreativeRow = {
        id: string;
        name: string;
        format: z.infer<typeof creativeFormatSchema> | null;
        asset_url: string | null;
        video_url: string | null;
        total_spend: string;
        roas: string;
        cpa: string | null;
        ctr: string | null;
        total_conversions: string | null;
        ad_status: string | null;
      };

      // Top performers by ROAS (min $50 spend). Displayed metrics aggregate
      // ALL ads in the window (matches Meta's report — paused-ad late
      // attribution counts because revenue is real). But the creative only
      // qualifies if at least one active ad has window spend, so the panel
      // never recommends "scale this" on a creative with nothing to scale.
      // Tracks running_days for the "evergreen" tag.
      const topResult = await db.execute(sql`
        SELECT
          ac.id,
          ac.name,
          ac.format,
          ac.asset_url,
          ac.video_url,
          sum(pl.spend)::text as total_spend,
          (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as cpa,
          avg(pl.ctr)::text as ctr,
          sum(pl.conversions)::text as total_conversions,
          CASE WHEN bool_or(${effectiveAdActiveSql(sql`ad.status`, sql`ast.status`)}) THEN 'active' ELSE 'paused' END AS ad_status,
          (max(pl.date_end)::date - min(pl.date_start)::date) as running_days
        FROM ad_creative ac
        JOIN ad ON ad.ad_creative_id = ac.id
        LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
        JOIN performance_log pl ON pl.ad_id = ad.id
        WHERE ${dateFilter} AND ${basePl} AND ad.organization_id = ${ctx.organizationId} ${accountFilter} ${campaignFilter} ${adSetFilter} ${statusFilter} ${ownershipFilter} ${teamFilter} ${formatFilter}
        GROUP BY ac.id, ac.name, ac.format, ac.asset_url, ac.video_url
        HAVING sum(pl.spend) >= 50
          AND coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) >= 1
          AND bool_or(${effectiveAdActiveSql(sql`ad.status`, sql`ast.status`)} AND pl.spend > 0)
        ORDER BY sum(pl.conversions) DESC NULLS LAST, coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) DESC NULLS LAST
        LIMIT ${limit}
      `);
      const topPerformers = topResult.rows as (CreativeRow & { running_days: number })[];

      const topIds = topPerformers.map((r) => r.id);
      // Surviving creatives: long-running profitable concepts that didn't crack
      // the Top Performers top-10. Same display-vs-qualify split — metrics
      // aggregate all ads (matches Meta) but the creative only qualifies if at
      // least one active ad has spend (something is currently runnable).
      const survivingExclude = topIds.length
        ? sql`AND ac.id NOT IN (${sql.join(topIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
      const survivingResult = includeSurviving ? await db.execute(sql`
        SELECT
          ac.id,
          ac.name,
          ac.format,
          ac.asset_url,
          ac.video_url,
          sum(pl.spend)::text as total_spend,
          (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as cpa,
          avg(pl.ctr)::text as ctr,
          sum(pl.conversions)::text as total_conversions,
          CASE WHEN bool_or(${effectiveAdActiveSql(sql`ad.status`, sql`ast.status`)}) THEN 'active' ELSE 'paused' END AS ad_status,
          (max(pl.date_end)::date - min(pl.date_start)::date) as running_days
        FROM ad_creative ac
        JOIN ad ON ad.ad_creative_id = ac.id
        LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
        JOIN performance_log pl ON pl.ad_id = ad.id
        WHERE ad.organization_id = ${ctx.organizationId}
          AND ${basePl}
          ${accountFilter} ${campaignFilter} ${adSetFilter} ${ownershipFilter} ${teamFilter} ${formatFilter}
          ${survivingExclude}
        GROUP BY ac.id, ac.name, ac.format, ac.asset_url, ac.video_url
        HAVING sum(pl.spend) >= 50
          AND coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) >= 1
          AND (max(pl.date_end)::date - min(pl.date_start)::date) >= 14
          AND bool_or(${effectiveAdActiveSql(sql`ad.status`, sql`ast.status`)} AND pl.spend > 0)
        ORDER BY (max(pl.date_end)::date - min(pl.date_start)::date) DESC, coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) DESC NULLS LAST
        LIMIT ${limit}
      `) : null;
      const survivingCreatives = (survivingResult?.rows ?? []) as (CreativeRow & { running_days: number })[];

      // Bleeders: per-ad rule, tiered by whether the ad has had a "fair shot."
      // An ad needs both age (running_days >= 5) and spend (>= ~1× portfolio CPA)
      // before we'll call it confidently dead — pausing it earlier means we'd
      // strangle ads that haven't had time for delivery to learn.
      //
      //   tier = pause_now  if spend >= fair-shot AND days >= 5 AND (0 conv OR ROAS < 1.0)
      //   tier = watch      if one threshold met AND (0 conv OR ROAS < 1.0)
      //   tier = cooking    otherwise — hidden from Needs Attention
      //
      // A creative inherits the most urgent tier of its bleeder ads.
      type BleederRow = CreativeRow & {
        bleeder_count: number;
        active_ad_count: number;
        bleeder_spend: string;
        bleeder_at_risk: string;
        has_winner: boolean;
        bleeder_meta_ids: (string | null)[] | null;
        tier: "pause_now" | "watch";
      };
      const scopedAdFilters = sql`
        ${accountFilter} ${campaignFilter} ${adSetFilter} ${ownershipFilter} ${teamFilter} ${formatFilter}
      `;
      const bottomResult = await db.execute(sql`
        WITH scoped_ads AS NOT MATERIALIZED (
          SELECT
            ad.id,
            ad.meta_id,
            ad.ad_creative_id,
            ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} AS status
          FROM ad
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
          WHERE ad.organization_id = ${ctx.organizationId}
            ${scopedAdFilters}
        ),
        ad_lifetime_days AS MATERIALIZED (
          -- Lifetime running_days, NOT window-bounded. A buyer judges an ad on
          -- its absolute age ("if I gave this 3 weeks, it's done"), not on
          -- how many days it happened to deliver inside the dashboard window.
          -- Also matches what the CSV export uses for disable_tier.
          SELECT
            pl.ad_id,
            (max(pl.date_end)::date - min(pl.date_start)::date) AS running_days
          FROM performance_log pl
          JOIN scoped_ads ra ON ra.id = pl.ad_id
          WHERE ${basePl}
          GROUP BY pl.ad_id
        ),
        ad_window AS (
          SELECT
            ra.id AS ad_id,
            ra.meta_id AS meta_ad_id,
            ra.ad_creative_id,
            ra.status,
            sum(pl.spend) AS spend,
            sum(pl.purchase_value) AS revenue,
            sum(pl.conversions) AS conversions,
            coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) AS roas,
            coalesce(ald.running_days, 0) AS running_days
          FROM scoped_ads ra
          JOIN performance_log pl ON pl.ad_id = ra.id
          LEFT JOIN ad_lifetime_days ald ON ald.ad_id = ra.id
          WHERE ${dateFilter}
            AND ${basePl}
          GROUP BY ra.id, ra.meta_id, ra.ad_creative_id, ra.status, ald.running_days
        ),
        ${portfolioWindowCte}
        bleeder AS (
          SELECT
            aw.*,
            CASE
              WHEN aw.spend >= ${fairShotSpendSql} AND aw.running_days >= 5 THEN 'pause_now'
              WHEN aw.spend >= ${fairShotSpendSql} OR aw.running_days >= 7 THEN 'watch'
              ELSE 'cooking'
            END AS tier
          FROM ad_window aw
          ${portfolioWindowJoin}
          WHERE aw.status = 'active'
            AND (
              coalesce(aw.conversions, 0) = 0
              OR (aw.roas IS NOT NULL AND aw.roas < 1.0)
            )
            AND aw.spend >= 25
        ),
        actionable AS (
          SELECT * FROM bleeder WHERE tier IN ('pause_now', 'watch')
        ),
        creative_window AS (
          -- Per-creative window totals across ALL ads on the creative (active
          -- + paused). Drives the displayed Spend/Conv/ROAS/CPA columns so a
          -- buyer sees the creative's true window performance — not just the
          -- bleeder slice, which is already surfaced in the action badge.
          SELECT
            aw.ad_creative_id,
            sum(aw.spend) AS spend,
            sum(aw.revenue) AS revenue,
            sum(aw.conversions) AS conversions
          FROM ad_window aw
          GROUP BY aw.ad_creative_id
        )
        SELECT
          ac.id,
          ac.name,
          ac.format::text AS format,
          ac.asset_url,
          ac.video_url,
          coalesce(cw.spend, 0)::text AS total_spend,
          (coalesce(cw.revenue, 0) / nullif(cw.spend, 0))::text AS roas,
          (coalesce(cw.spend, 0) / nullif(cw.conversions, 0))::text AS cpa,
          NULL::text AS ctr,
          coalesce(cw.conversions, 0)::text AS total_conversions,
          'active'::text AS ad_status,
          count(*)::int AS bleeder_count,
          (
            SELECT count(*)::int FROM ad_window aw
            WHERE aw.ad_creative_id = ac.id AND aw.status = 'active'
          ) AS active_ad_count,
          sum(b.spend)::text AS bleeder_spend,
          sum(coalesce(b.spend, 0) * (1 - coalesce(b.roas, 0)))::text AS bleeder_at_risk,
          array_agg(b.meta_ad_id ORDER BY b.spend DESC NULLS LAST) AS bleeder_meta_ids,
          (CASE WHEN bool_or(b.tier = 'pause_now') THEN 'pause_now' ELSE 'watch' END)::text AS tier,
          EXISTS (
            SELECT 1 FROM ad_window aw
            WHERE aw.ad_creative_id = ac.id
              AND aw.status = 'active'
              AND coalesce(aw.conversions, 0) >= 1
              AND aw.roas >= 1
          ) AS has_winner
        FROM actionable b
        JOIN ad_creative ac ON ac.id = b.ad_creative_id
        JOIN creative_window cw ON cw.ad_creative_id = ac.id
        ${topIds.length ? sql`WHERE ac.id NOT IN (${sql.join(topIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
        GROUP BY ac.id, ac.name, ac.format, ac.asset_url, ac.video_url, cw.spend, cw.revenue, cw.conversions
        ORDER BY
          (CASE WHEN bool_or(b.tier = 'pause_now') THEN 0 ELSE 1 END),
          sum(coalesce(b.spend, 0) * (1 - coalesce(b.roas, 0))) DESC NULLS LAST
        LIMIT ${limit}
      `);
      const bottomPerformers = bottomResult.rows as BleederRow[];

      const leaderboardIds = Array.from(
        new Set([
          ...topPerformers.map((r) => r.id),
          ...bottomPerformers.map((r) => r.id),
          ...survivingCreatives.map((r) => r.id),
        ]),
      );
      const healthByCreative = await computeCreativeHealthByCreativeId({
        organizationId: ctx.organizationId,
        creativeIds: leaderboardIds,
        dateFilter,
      });

      return {
        portfolio: mapPortfolioRow(portfolio),
        topPerformers: topPerformers.map((r) => ({
          id: r.id,
          name: r.name,
          format: r.format,
          assetUrl: r.asset_url,
          videoUrl: r.video_url,
          totalSpend: r.total_spend,
          roas: r.roas,
          cpa: r.cpa,
          ctr: r.ctr,
          conversions: r.total_conversions,
          adStatus: r.ad_status,
          runningDays: r.running_days,
          // A top performer also qualifies for Surviving Creatives if it's been
          // running 14+ days. Mark it so the UI shows an "evergreen" badge.
          isEvergreen: r.ad_status === "active" && (r.running_days ?? 0) >= 14,
          health: healthByCreative.get(r.id)?.health ?? null,
          healthReasons: healthByCreative.get(r.id)?.reasons ?? [],
        })),
        bottomPerformers: bottomPerformers.map((r) => {
          const rollup = healthByCreative.get(r.id);
          return {
            id: r.id,
            name: r.name,
            format: r.format,
            assetUrl: r.asset_url,
            videoUrl: r.video_url,
            totalSpend: r.total_spend,
            roas: r.roas,
            cpa: r.cpa,
            ctr: r.ctr,
            conversions: r.total_conversions,
            adStatus: r.ad_status,
            health: rollup?.health ?? null,
            healthReasons: rollup?.reasons ?? [],
            bleederAdCount: r.bleeder_count,
            activeAdCount: r.active_ad_count,
            bleederSpend: r.bleeder_spend,
            bleederDollarsAtRisk: r.bleeder_at_risk,
            hasWinnerAd: r.has_winner,
            bleederMetaIds: (r.bleeder_meta_ids ?? []).filter((id): id is string => Boolean(id)),
            tier: r.tier,
          };
        }),
        survivingCreatives: survivingCreatives.map((r) => ({
          id: r.id,
          name: r.name,
          format: r.format,
          assetUrl: r.asset_url,
          videoUrl: r.video_url,
          totalSpend: r.total_spend,
          roas: r.roas,
          cpa: r.cpa,
          ctr: r.ctr,
          conversions: r.total_conversions,
          adStatus: r.ad_status,
          runningDays: r.running_days,
          health: healthByCreative.get(r.id)?.health ?? null,
          healthReasons: healthByCreative.get(r.id)?.reasons ?? [],
        })),
      };
    }),

  dashboardExport: orgProcedure
    .meta(openApiQueryMeta("adCreative", "dashboardExport"))
    .output(dashboardExportOutputSchema)
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        accountId: z.string().optional(),
        ownership: z.enum(["ours", "theirs"]).optional(),
        teamId: z.string().optional(),
        format: creativeFormatSchema.optional(),
        // "all" includes breakdown rows and is therefore capped at the
        // breakdown window; "base" drops them and works over any range.
        scope: z.enum(["all", "base"]).default("all"),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (input.scope === "all") assertBreakdownRange(input.from);

      const scopeFilter = input.scope === "base"
        ? sql`AND ${basePerformanceLogFilter("pl")}`
        : sql``;
      const accountFilter = input.accountId
        ? sql`AND ad.account_id = ${input.accountId}`
        : sql``;
      const ownershipFilter = input.ownership
        ? input.ownership === "theirs"
          ? sql`AND (ac.ownership IS NULL OR ac.ownership != 'ours')`
          : sql`AND ac.ownership = ${input.ownership}`
        : sql``;
      const teamFilter = input.teamId
        ? sql`AND ac.team_id = ${input.teamId}`
        : sql``;
      const formatFilter = input.format
        ? sql`AND ac.format = ${input.format}`
        : sql``;

      const rows = await db.execute(sql`
        SELECT
          pl.date_start,
          pl.date_end,
          c.name   AS campaign_name,
          ast.name AS ad_set_name,
          ad.name  AS ad_name,
          ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} AS ad_status,
          ad.caption,
          ad.destination_url,
          ac.name  AS creative_name,
          ac.format,
          ac.angle,
          ac.persona,
          ac.awareness_level,
          ac.ownership,
          ac.asset_url,
          ac.video_url,
          pl.spend,
          pl.impressions,
          pl.reach,
          pl.frequency,
          pl.cpm,
          pl.cpc,
          pl.link_clicks,
          pl.ctr,
          pl.landing_page_views,
          pl.cost_per_lpv,
          pl.conversions,
          pl.purchase_value,
          pl.roas,
          pl.cpa,
          pl.add_to_cart,
          pl.initiate_checkout,
          pl.cost_per_add_to_cart,
          pl.video_views_3s,
          pl.video_thruplay,
          pl.video_avg_watch_time,
          pl.country,
          pl.platform,
          pl.placement,
          pl.device,
          pl.age,
          pl.gender,
          pl.quality_ranking,
          pl.engagement_rate_ranking,
          pl.conversion_rate_ranking
        FROM performance_log pl
        JOIN ad ON ad.id = pl.ad_id
        JOIN ad_creative ac ON ac.id = ad.ad_creative_id
        LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
        LEFT JOIN campaign c ON c.id = ast.campaign_id
        WHERE pl.date_start <= ${input.to}::date
          AND pl.date_end >= ${input.from}::date
          AND pl.organization_id = ${ctx.organizationId}
          ${scopeFilter} ${accountFilter} ${ownershipFilter} ${teamFilter} ${formatFilter}
        ORDER BY pl.date_start DESC, ad.name
      `);

      return rows.rows as z.infer<typeof dashboardExportOutputSchema>;
    }),

  getDailyPortfolioPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getDailyPortfolioPerformance"))
    .output(dailyPortfolioPerformanceOutputSchema)
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
        ownership: z.enum(["ours", "theirs"]).optional(),
        teamId: z.string().optional(),
        format: creativeFormatSchema.optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const accountFilter = input?.accountId
        ? sql`AND ad.account_id = ${input.accountId}`
        : sql``;
      const ownershipFilter = input?.ownership
        ? input.ownership === "theirs"
          ? sql`AND (ac.ownership IS NULL OR ac.ownership != 'ours')`
          : sql`AND ac.ownership = ${input.ownership}`
        : sql``;
      const teamFilter = input?.teamId
        ? sql`AND ac.team_id = ${input.teamId}`
        : sql``;
      const formatFilter = input?.format
        ? sql`AND ac.format = ${input.format}`
        : sql``;
      const basePl = basePerformanceLogFilter("pl");

      const today = new Date();
      const defaultTo = today.toISOString().slice(0, 10);
      const defaultFrom = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const fromStr = input?.from ?? defaultFrom;
      const toStr = input?.to ?? defaultTo;

      type DailyRow = {
        date_start: string;
        date_end: string;
        spend: string | null;
        purchase_value: string | null;
        roas: string | null;
        cpa: string | null;
        ctr: string | null;
        conversions: number;
        impressions: number;
        reach: number;
        cpm: string | null;
        link_clicks: number;
      };

      const result = await db.execute(sql`
        SELECT
          pl.date_start::text as date_start,
          pl.date_start::text as date_end,
          COALESCE(sum(pl.spend), 0)::text as spend,
          COALESCE(sum(pl.purchase_value), 0)::text as purchase_value,
          (COALESCE(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          (COALESCE(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as cpa,
          (COALESCE(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0))::text as ctr,
          COALESCE(sum(pl.conversions), 0)::int as conversions,
          COALESCE(sum(pl.impressions), 0)::int as impressions,
          COALESCE(sum(pl.reach), 0)::int as reach,
          (CASE WHEN sum(pl.impressions) > 0 THEN (sum(pl.spend) / sum(pl.impressions)) * 1000 ELSE NULL END)::text as cpm,
          COALESCE(sum(pl.link_clicks), 0)::int as link_clicks
        FROM performance_log pl
        JOIN ad ON ad.id = pl.ad_id
        JOIN ad_creative ac ON ac.id = ad.ad_creative_id
        WHERE pl.date_start >= ${fromStr}::date
          AND pl.date_start <= ${toStr}::date
          AND ad.organization_id = ${ctx.organizationId}
          AND ${basePl}
          ${accountFilter} ${ownershipFilter} ${teamFilter} ${formatFilter}
        GROUP BY pl.date_start
        ORDER BY pl.date_start
      `);

      const rowsByDate = new Map(
        (result.rows as DailyRow[]).map((row) => [row.date_start, row]),
      );
      const rows = enumerateDateRange(fromStr, toStr).map((date) => (
        rowsByDate.get(date) ?? {
          date_start: date,
          date_end: date,
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
        }
      ));
      let lastWithSpend = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        const s = rows[i].spend ? parseFloat(rows[i].spend!) : 0;
        if (s > 0) {
          lastWithSpend = i;
          break;
        }
      }
      const trimmed = lastWithSpend >= 0 ? rows.slice(0, lastWithSpend + 1) : rows;

      return trimmed.map((r) => ({
        dateStart: r.date_start,
        dateEnd: r.date_end,
        spend: r.spend,
        purchaseValue: r.purchase_value,
        roas: r.roas,
        cpa: r.cpa,
        ctr: r.ctr,
        conversions: r.conversions,
        impressions: r.impressions,
        reach: r.reach,
        cpm: r.cpm,
        linkClicks: r.link_clicks,
      }));
    }),

  getMerAccountBreakdown: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getMerAccountBreakdown"))
    .output(merAccountBreakdownOutputSchema)
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        teamId: z.string().optional(),
        accountId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const teamFilter = input.teamId
        ? sql`AND ac.team_id = ${input.teamId}`
        : sql``;
      const accountFilterAd = input.accountId
        ? sql`AND ad.account_id = ${input.accountId}`
        : sql``;
      const accountFilterAcc = input.accountId
        ? sql`AND acc.id = ${input.accountId}`
        : sql``;
      const basePl = basePerformanceLogFilter("pl");

      type Row = {
        account_id: string;
        account_name: string;
        spend: string | null;
        revenue: string | null;
        roas: string | null;
        prior_spend: string | null;
        prior_roas: string | null;
        sparkline: Array<{ date: string; spend: number; revenue: number; roas: number | null }> | null;
      };

      const result = await db.execute(sql`
        WITH current_period AS (
          SELECT
            ad.account_id,
            sum(pl.spend) as spend,
            sum(pl.purchase_value) as revenue,
            (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0)) as roas
          FROM performance_log pl
          JOIN ad ON ad.id = pl.ad_id
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          WHERE pl.date_start <= ${input.to}::date
            AND pl.date_end >= ${input.from}::date
            AND ${basePl}
            AND ad.organization_id = ${ctx.organizationId}
            ${teamFilter}
            ${accountFilterAd}
          GROUP BY ad.account_id
        ),
        prior_period AS (
          SELECT
            ad.account_id,
            sum(pl.spend) as prior_spend,
            (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0)) as prior_roas
          FROM performance_log pl
          JOIN ad ON ad.id = pl.ad_id
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          WHERE pl.date_start <= (${input.from}::date - 1)
            AND pl.date_end >= (${input.from}::date - (${input.to}::date - ${input.from}::date + 1))
            AND ${basePl}
            AND ad.organization_id = ${ctx.organizationId}
            ${teamFilter}
            ${accountFilterAd}
          GROUP BY ad.account_id
        ),
        days AS (
          SELECT generate_series(${input.from}::date, ${input.to}::date, '1 day'::interval)::date AS day
        ),
        daily_per_account AS (
          SELECT
            ad.account_id,
            pl.date_start::date AS day,
            sum(pl.spend) AS spend,
            sum(pl.purchase_value) AS revenue
          FROM performance_log pl
          JOIN ad ON ad.id = pl.ad_id
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          WHERE pl.date_start >= ${input.from}::date
            AND pl.date_start <= ${input.to}::date
            AND ad.organization_id = ${ctx.organizationId}
            AND ${basePl}
            ${teamFilter}
            ${accountFilterAd}
          GROUP BY ad.account_id, pl.date_start
        ),
        sparkline_rows AS (
          SELECT
            acc.id AS account_id,
            json_agg(json_build_object(
              'date', d.day::text,
              'spend', COALESCE(dpa.spend, 0)::float,
              'revenue', COALESCE(dpa.revenue, 0)::float,
              'roas', (COALESCE(dpa.revenue, 0) / nullif(dpa.spend, 0))::float
            ) ORDER BY d.day) AS points
          FROM ad_account acc
          CROSS JOIN days d
          LEFT JOIN daily_per_account dpa ON dpa.account_id = acc.id AND dpa.day = d.day
          WHERE acc.organization_id = ${ctx.organizationId}
            ${accountFilterAcc}
          GROUP BY acc.id
        )
        SELECT
          acc.id as account_id,
          acc.name as account_name,
          cp.spend::text as spend,
          cp.revenue::text as revenue,
          cp.roas::text as roas,
          pp.prior_spend::text as prior_spend,
          pp.prior_roas::text as prior_roas,
          COALESCE(s.points, '[]'::json) as sparkline
        FROM ad_account acc
        JOIN current_period cp ON cp.account_id = acc.id
        LEFT JOIN prior_period pp ON pp.account_id = acc.id
        LEFT JOIN sparkline_rows s ON s.account_id = acc.id
        WHERE acc.organization_id = ${ctx.organizationId}
          ${accountFilterAcc}
        ORDER BY cp.spend DESC NULLS LAST
      `);

      return (result.rows as Row[]).map((r) => {
        const spend = r.spend ? parseFloat(r.spend) : null;
        const roas = r.roas ? parseFloat(r.roas) : null;
        const priorSpend = r.prior_spend ? parseFloat(r.prior_spend) : null;
        const priorRoas = r.prior_roas ? parseFloat(r.prior_roas) : null;
        const spendDelta = spend != null && priorSpend != null ? spend - priorSpend : null;
        const roasDelta = roas != null && priorRoas != null ? roas - priorRoas : null;
        return {
          accountId: r.account_id,
          accountName: r.account_name,
          spend: r.spend,
          revenue: r.revenue,
          roas: r.roas,
          priorSpend: r.prior_spend,
          priorRoas: r.prior_roas,
          spendDelta: spendDelta != null ? String(spendDelta) : null,
          roasDelta: roasDelta != null ? String(roasDelta) : null,
          sparkline: (() => {
            const points = r.sparkline ?? [];
            let last = -1;
            for (let i = points.length - 1; i >= 0; i--) {
              if ((points[i]?.spend ?? 0) > 0) {
                last = i;
                break;
              }
            }
            return last >= 0 ? points.slice(0, last + 1) : points;
          })(),
        };
      });
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getById"))
    .output(adCreativeDetailSchema)
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [creative] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          videoUrl: adCreatives.videoUrl,
          destinationUrl: sql<string | null>`(
            SELECT ad.destination_url FROM ad
            WHERE ad.ad_creative_id = "ad_creative"."id"
              AND ad.destination_url IS NOT NULL
            ORDER BY ad.updated_at DESC NULLS LAST, ad.created_at DESC
            LIMIT 1
          )`.as("destination_url"),
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          attributes: adCreatives.attributes,
          attributesMeta: adCreatives.attributesMeta,
          tone: adCreatives.tone,
          ownership: adCreatives.ownership,
          teamId: adCreatives.teamId,
          notes: adCreatives.notes,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
        })
        .from(adCreatives)
        .where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
      if (!creative) throw new Error("Ad creative not found");
      return creative;
    }),

  getAdPreviewUrl: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getAdPreviewUrl"))
    .output(adPreviewUrlOutputSchema)
    .input(z.object({ id: z.string(), adId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const conditions: SQL[] = [
        eq(ads.adCreativeId, input.id),
        eq(ads.organizationId, ctx.organizationId),
        sql`${ads.metaId} IS NOT NULL`,
        sql`${adAccounts.metaAccessToken} IS NOT NULL`,
      ];
      if (input.adId) {
        conditions.push(eq(ads.id, input.adId));
      }

      const [linkedMetaAd] = await db
        .select({
          metaAdId: ads.metaId,
          metaAccessToken: adAccounts.metaAccessToken,
        })
        .from(ads)
        .innerJoin(adAccounts, eq(ads.accountId, adAccounts.id))
        .where(and(...conditions))
        .limit(1);

      if (!linkedMetaAd?.metaAdId || !linkedMetaAd.metaAccessToken) {
        return { previewUrl: null };
      }

      const previewUrl = await fetchMetaAdPreviewUrl({
        adMetaId: linkedMetaAd.metaAdId,
        accessToken: linkedMetaAd.metaAccessToken,
      });

      return { previewUrl };
    }),

  fetchMetaPreview: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "fetchMetaPreview"))
    .output(metaCreativePreviewSchema)
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [linkedMetaAd] = await db
        .select({
          metaAdId: ads.metaId,
          metaAccountId: adAccounts.metaAccountId,
          metaAccessToken: adAccounts.metaAccessToken,
        })
        .from(ads)
        .innerJoin(adAccounts, eq(ads.accountId, adAccounts.id))
        .where(
          and(
            eq(ads.adCreativeId, input.id),
            eq(ads.organizationId, ctx.organizationId),
            sql`${ads.metaId} IS NOT NULL`,
            sql`${adAccounts.metaAccessToken} IS NOT NULL`,
          ),
        )
        .limit(1);

      if (!linkedMetaAd?.metaAdId || !linkedMetaAd.metaAccessToken) {
        throw new Error("No linked Meta ad with API access was found for this creative");
      }

      const preview = await fetchMetaCreativePreview({
        adMetaId: linkedMetaAd.metaAdId,
        metaAccountId: linkedMetaAd.metaAccountId,
        accessToken: linkedMetaAd.metaAccessToken,
        videoUrlMode: "direct",
      });

      if (!preview) {
        throw new Error("Meta preview is not available for this creative");
      }

      return preview;
    }),

  /**
   * §6.1's hard gate, server side: "Studio and manual creatives require the
   * four enforced tags at save." The fourth — funnel stage — lives on the ad,
   * and a manual creative has no ad yet, so the trio a creative can actually
   * carry at birth is persona + angle + awareness. Nothing may create an
   * untagged creative; legacy rows that predate the gate are only ever edited.
   */
  create: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "create"))
    .output(adCreativeRowSchema)
    .input(
      z.object({
        name: z.string().optional(),
        persona: z.string().trim().min(1),
        angle: z.enum(ANGLE_TYPES),
        awarenessLevel: awarenessLevelSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [creative] = await db
        .insert(adCreatives)
        .values({
          name: input.name ?? "Untitled Creative",
          persona: input.persona.trim(),
          angle: input.angle,
          awarenessLevel: input.awarenessLevel,
          // Human-supplied from the first save, so AI re-enrichment leaves the
          // trio alone from here on.
          attributesMeta: {
            persona: { source: "human" },
            angle: { source: "human" },
            awarenessLevel: { source: "human" },
          },
          organizationId: ctx.organizationId,
        })
        .returning();
      return creative;
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "update"))
    .output(adCreativeRowSchema)
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        assetUrl: z.string().nullable().optional(),
        format: z.enum(["static", "video", "ugc", "carousel"]).nullable().optional(),
        // The enforced trio stays optional — a legacy untagged creative can be
        // edited without being retagged in the same breath — but it can never
        // be cleared: an explicit null is rejected, not stored (§6.1).
        angle: z.enum(ANGLE_TYPES).optional(),
        persona: z.string().trim().min(1).optional(),
        awarenessLevel: awarenessLevelSchema.optional(),
        attributes: creativeAttributesPatchSchema.optional(),
        tone: z.array(z.string()).nullable().optional(),
        ownership: z.enum(["ours", "theirs"]).nullable().optional(),
        teamId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, attributes: attributesPatch, ...data } = input;
      const [existing] = await db
        .select({
          attributes: adCreatives.attributes,
          attributesMeta: adCreatives.attributesMeta,
        })
        .from(adCreatives)
        .where(
          and(
            eq(adCreatives.id, id),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Ad creative not found" });
      }
      const attributes: CreativeAttributes = { ...existing.attributes };
      // Anything a person writes here is theirs from now on: `human`
      // provenance is what makes a value stick against AI re-enrichment.
      const attributesMeta: CreativeAttributesMeta = { ...existing.attributesMeta };
      for (const field of CREATIVE_ATTRIBUTE_FIELDS) {
        const value = attributesPatch?.[field];
        if (value === undefined) continue;
        if (value === null) {
          delete attributes[field];
          delete attributesMeta[field];
          continue;
        }
        // Each field's own type; the patch schema already validated it.
        (attributes[field] as unknown) = value;
        attributesMeta[field] = { source: "human" };
      }
      for (const field of ["persona", "angle", "awarenessLevel"] as const) {
        if (data[field] !== undefined) attributesMeta[field] = { source: "human" };
      }
      const [creative] = await db
        .update(adCreatives)
        .set({ ...data, attributes, attributesMeta })
        .where(and(eq(adCreatives.id, id), eq(adCreatives.organizationId, ctx.organizationId)))
        .returning();
      if (!creative) throw new TRPCError({ code: "NOT_FOUND", message: "Ad creative not found" });
      return creative;
    }),

  duplicate: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "duplicate"))
    .output(adCreativeRowSchema)
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(adCreatives)
        .where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Ad creative not found");
      const [duplicate] = await db
        .insert(adCreatives)
        .values({
          name: `Copy of ${source.name}`,
          assetUrl: source.assetUrl,
          videoUrl: source.videoUrl,
          format: source.format,
          angle: source.angle,
          persona: source.persona,
          awarenessLevel: source.awarenessLevel,
          attributes: source.attributes,
          attributesMeta: source.attributesMeta,
          tone: source.tone,
          ownership: source.ownership,
          teamId: source.teamId,
          notes: source.notes,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkUpdateOwnership: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "bulkUpdateOwnership"))
    .output(bulkUpdateOutputSchema)
    .input(
      z.object({
        ids: z.array(z.string()).min(1),
        ownership: z.enum(["ours", "theirs"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await db
        .update(adCreatives)
        .set({ ownership: input.ownership })
        .where(
          and(
            inArray(adCreatives.id, input.ids),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        );
      return { updated: input.ids.length };
    }),

  bulkUpdateTeam: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "bulkUpdateTeam"))
    .output(bulkUpdateOutputSchema)
    .input(
      z.object({
        ids: z.array(z.string()).min(1),
        teamId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await db
        .update(adCreatives)
        .set({ teamId: input.teamId })
        .where(
          and(
            inArray(adCreatives.id, input.ids),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        );
      return { updated: input.ids.length };
    }),

  bulkImport: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "bulkImport"))
    .output(bulkImportOutputSchema)
    .input(
      z.object({
        accountId: z.string().optional(),
        rows: z.array(
          z.object({
            name: z.string(),
            assetUrl: z.string().optional(),
            videoUrl: z.string().optional(),
            format: z.enum(["static", "video", "ugc", "carousel"]).optional(),
            roas: z.string().optional(),
            cpa: z.string().optional(),
            ctr: z.string().optional(),
            conversionRate: z.string().optional(),
            spend: z.string().optional(),
            conversions: z.number().int().optional(),
            impressions: z.number().int().optional(),
            reach: z.number().int().optional(),
            frequency: z.string().optional(),
            cpm: z.string().optional(),
            qualityRanking: z.string().optional(),
            engagementRateRanking: z.string().optional(),
            conversionRateRanking: z.string().optional(),
            linkClicks: z.number().int().optional(),
            clicksAll: z.number().int().optional(),
            cpc: z.string().optional(),
            ctrLinkClick: z.string().optional(),
            landingPageViews: z.number().int().optional(),
            costPerLpv: z.string().optional(),
            purchaseValue: z.string().optional(),
            addToCart: z.number().int().optional(),
            initiateCheckout: z.number().int().optional(),
            costPerAddToCart: z.string().optional(),
            videoViews3s: z.number().int().optional(),
            videoThruplay: z.number().int().optional(),
            videoAvgWatchTime: z.string().optional(),
            country: z.string().optional(),
            platform: z.string().optional(),
            placement: z.string().optional(),
            device: z.string().optional(),
            age: z.string().optional(),
            gender: z.string().optional(),
            delivery: z.string().optional(),
            adId: z.string().optional(),
            destinationUrl: z.string().optional(),
            campaignName: z.string().optional(),
            campaignId: z.string().optional(),
            adSetName: z.string().optional(),
            adSetId: z.string().optional(),
            dateStart: z.string(),
            dateEnd: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await importMetaRows({
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        rows: input.rows,
      });

      return {
        created: result.created,
        totalRows: result.totalRows,
        uniqueAds: result.uniqueAds,
        perfLogs: result.perfLogs,
        droppedExpiredRows: result.droppedExpiredRows,
      };
    }),

  getPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getPerformance"))
    .output(creativePerformanceOutputSchema)
    .input(z.object({ id: z.string(), from: z.string().optional(), to: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const basePl = basePerformanceLogFilter("performance_log");
      const dateConditions: SQL[] = [
        eq(ads.adCreativeId, input.id),
        eq(ads.organizationId, ctx.organizationId),
        basePl,
      ];
      if (input.from) {
        dateConditions.push(sql`${performanceLogs.dateEnd} >= ${input.from}::date`);
      }
      if (input.to) {
        dateConditions.push(sql`${performanceLogs.dateStart} <= ${input.to}::date`);
      }

      // Creative-level aggregated metrics
      const [creative] = await db
        .select({
          totalSpend: sql<string | null>`sum(${performanceLogs.spend})`,
          avgRoas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
          avgCpa: sql<string | null>`coalesce(sum(${performanceLogs.spend}), 0) / nullif(sum(${performanceLogs.conversions}), 0)`,
          avgCtr: sql<string | null>`coalesce(sum(${performanceLogs.ctr} * ${performanceLogs.impressions}), 0) / nullif(sum(${performanceLogs.impressions}), 0)`,
          totalConversions: sql<string | null>`sum(${performanceLogs.conversions})`,
          totalImpressions: sql<string | null>`sum(${performanceLogs.impressions})`,
          totalClicks: sql<string | null>`sum(${performanceLogs.linkClicks})`,
          logCount: sql<string>`count(*)`,
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`,
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(and(...dateConditions));

      // Portfolio averages for comparison (same date range)
      const portfolioDateConditions: SQL[] = [
        eq(ads.organizationId, ctx.organizationId),
        basePl,
      ];
      if (input.from) {
        portfolioDateConditions.push(sql`${performanceLogs.dateEnd} >= ${input.from}::date`);
      }
      if (input.to) {
        portfolioDateConditions.push(sql`${performanceLogs.dateStart} <= ${input.to}::date`);
      }

      const [portfolio] = await db
        .select({
          avgRoas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
          avgCpa: sql<string | null>`coalesce(sum(${performanceLogs.spend}), 0) / nullif(sum(${performanceLogs.conversions}), 0)`,
          avgCtr: sql<string | null>`coalesce(sum(${performanceLogs.ctr} * ${performanceLogs.impressions}), 0) / nullif(sum(${performanceLogs.impressions}), 0)`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(and(...portfolioDateConditions));

      // Derive live status from linked ads
      const adStatuses = await db
        .select({
          status: effectiveAdStatusSql(ads.status, adSets.status),
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .where(
          and(
            eq(ads.adCreativeId, input.id),
            eq(ads.organizationId, ctx.organizationId),
          ),
        );

      const liveStatus = adStatuses.length === 0
        ? "no_ads"
        : adStatuses.some((a) => a.status === "active")
          ? "active"
          : "paused";

      return {
        totalSpend: creative?.totalSpend ?? null,
        avgRoas: creative?.avgRoas ?? null,
        avgCpa: creative?.avgCpa ?? null,
        avgCtr: creative?.avgCtr ?? null,
        totalConversions: creative?.totalConversions ?? null,
        totalImpressions: creative?.totalImpressions ?? null,
        totalClicks: creative?.totalClicks ?? null,
        logCount: creative?.logCount ?? "0",
        minDate: creative?.minDate ?? null,
        maxDate: creative?.maxDate ?? null,
        portfolioAvgRoas: portfolio?.avgRoas ?? null,
        portfolioAvgCpa: portfolio?.avgCpa ?? null,
        portfolioAvgCtr: portfolio?.avgCtr ?? null,
        liveStatus,
      };
    }),

  getDailyPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getDailyPerformance"))
    .output(dailyPerformanceOutputSchema)
    .input(z.object({ id: z.string(), from: z.string().optional(), to: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const basePl = basePerformanceLogFilter("performance_log");
      const conditions: SQL[] = [
        eq(ads.adCreativeId, input.id),
        eq(ads.organizationId, ctx.organizationId),
        basePl,
      ];
      if (input.from) {
        conditions.push(sql`${performanceLogs.dateEnd} >= ${input.from}::date`);
      }
      if (input.to) {
        conditions.push(sql`${performanceLogs.dateStart} <= ${input.to}::date`);
      }

      const rows = await db
        .select({
          dateStart: performanceLogs.dateStart,
          dateEnd: performanceLogs.dateEnd,
          spend: sql<string | null>`sum(${performanceLogs.spend})`,
          purchaseValue: sql<string | null>`sum(${performanceLogs.purchaseValue})`,
          roas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
          cpa: sql<string | null>`coalesce(sum(${performanceLogs.spend}), 0) / nullif(sum(${performanceLogs.conversions}), 0)`,
          ctr: sql<string | null>`coalesce(sum(${performanceLogs.ctr} * ${performanceLogs.impressions}), 0) / nullif(sum(${performanceLogs.impressions}), 0)`,
          conversions: sql<string | null>`sum(${performanceLogs.conversions})`,
          impressions: sql<string | null>`sum(${performanceLogs.impressions})`,
          reach: sql<string | null>`sum(${performanceLogs.reach})`,
          cpm: sql<string | null>`case when sum(${performanceLogs.impressions}) > 0 then (sum(${performanceLogs.spend}) / sum(${performanceLogs.impressions})) * 1000 else null end`,
          linkClicks: sql<string | null>`sum(${performanceLogs.linkClicks})`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(and(...conditions))
        .groupBy(performanceLogs.dateStart, performanceLogs.dateEnd)
        .orderBy(performanceLogs.dateStart);

      return rows;
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("adCreative", "delete"))
    .output(z.void())
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Delete linked ads (cascades to performance_logs via FK)
      await db.delete(ads).where(
        and(
          eq(ads.adCreativeId, input.id),
          eq(ads.organizationId, ctx.organizationId),
        ),
      );
      await db.delete(adCreatives).where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
    }),
});
