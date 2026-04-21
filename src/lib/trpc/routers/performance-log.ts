import { z } from "zod";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { performanceLogs } from "@/schema/performance-log";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";

const dimensionColumn = (dim: "age" | "gender" | "country" | "device") => {
  const map = {
    age: sql.raw("pl.age"),
    gender: sql.raw("pl.gender"),
    country: sql.raw("pl.country"),
    device: sql.raw("pl.device"),
  } as const;
  return map[dim];
};

const PERF_CONFLICT_TARGET = [
  performanceLogs.adId,
  performanceLogs.dateStart,
  performanceLogs.dateEnd,
  performanceLogs.country,
  performanceLogs.platform,
  performanceLogs.placement,
  performanceLogs.device,
  performanceLogs.age,
  performanceLogs.gender,
] as const;

// On conflict with the breakdown tuple, overwrite all mutable metric fields
// with the incoming row's values (via PostgreSQL's `excluded`).
const PERF_CONFLICT_SET = {
  roas: sql`excluded.roas`,
  cpa: sql`excluded.cpa`,
  ctr: sql`excluded.ctr`,
  conversionRate: sql`excluded.conversion_rate`,
  spend: sql`excluded.spend`,
  conversions: sql`excluded.conversions`,
  impressions: sql`excluded.impressions`,
  reach: sql`excluded.reach`,
  frequency: sql`excluded.frequency`,
  cpm: sql`excluded.cpm`,
  linkClicks: sql`excluded.link_clicks`,
  clicksAll: sql`excluded.clicks_all`,
  cpc: sql`excluded.cpc`,
  ctrLinkClick: sql`excluded.ctr_link_click`,
  landingPageViews: sql`excluded.landing_page_views`,
  costPerLpv: sql`excluded.cost_per_lpv`,
  purchaseValue: sql`excluded.purchase_value`,
  addToCart: sql`excluded.add_to_cart`,
  initiateCheckout: sql`excluded.initiate_checkout`,
  costPerAddToCart: sql`excluded.cost_per_add_to_cart`,
  videoViews3s: sql`excluded.video_views_3s`,
  videoThruplay: sql`excluded.video_thruplay`,
  videoAvgWatchTime: sql`excluded.video_avg_watch_time`,
  qualityRanking: sql`excluded.quality_ranking`,
  engagementRateRanking: sql`excluded.engagement_rate_ranking`,
  conversionRateRanking: sql`excluded.conversion_rate_ranking`,
} as const;

const perfFields = {
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
};

const perfFieldsNullable = {
  roas: z.string().nullable().optional(),
  cpa: z.string().nullable().optional(),
  ctr: z.string().nullable().optional(),
  conversionRate: z.string().nullable().optional(),
  spend: z.string().nullable().optional(),
  conversions: z.number().int().nullable().optional(),
  impressions: z.number().int().nullable().optional(),
  reach: z.number().int().nullable().optional(),
  frequency: z.string().nullable().optional(),
  cpm: z.string().nullable().optional(),
  qualityRanking: z.string().nullable().optional(),
  engagementRateRanking: z.string().nullable().optional(),
  conversionRateRanking: z.string().nullable().optional(),
};

export const performanceLogRouter = router({
  listAll: orgProcedure
    .meta(openApiQueryMeta("performanceLog", "listAll"))
    .query(async ({ ctx }) => {
    return db
      .select()
      .from(performanceLogs)
      .where(eq(performanceLogs.organizationId, ctx.organizationId))
      .orderBy(desc(performanceLogs.dateStart));
  }),

  listByAd: orgProcedure
    .meta(openApiQueryMeta("performanceLog", "listByAd"))
    .input(z.object({ adId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select()
        .from(performanceLogs)
        .where(and(eq(performanceLogs.adId, input.adId), eq(performanceLogs.organizationId, ctx.organizationId)))
        .orderBy(desc(performanceLogs.dateStart));
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("performanceLog", "create"))
    .input(
      z.object({
        adId: z.string(),
        dateStart: z.string(),
        dateEnd: z.string(),
        ...perfFields,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [log] = await db
        .insert(performanceLogs)
        .values({ ...input, organizationId: ctx.organizationId })
        .onConflictDoUpdate({
          target: [...PERF_CONFLICT_TARGET],
          set: PERF_CONFLICT_SET,
        })
        .returning();
      return log;
    }),

  bulkCreate: orgWriteProcedure
    .meta(openApiMutationMeta("performanceLog", "bulkCreate"))
    .input(
      z.object({
        adId: z.string(),
        rows: z.array(
          z.object({
            dateStart: z.string(),
            dateEnd: z.string(),
            ...perfFields,
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.rows.length === 0) return [];
      const values = input.rows.map((row) => ({
        ...row,
        adId: input.adId,
        organizationId: ctx.organizationId,
      }));
      return db
        .insert(performanceLogs)
        .values(values)
        .onConflictDoUpdate({
          target: [...PERF_CONFLICT_TARGET],
          set: PERF_CONFLICT_SET,
        })
        .returning();
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("performanceLog", "update"))
    .input(
      z.object({
        id: z.string(),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
        ...perfFieldsNullable,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [log] = await db
        .update(performanceLogs)
        .set(data)
        .where(and(eq(performanceLogs.id, id), eq(performanceLogs.organizationId, ctx.organizationId)))
        .returning();
      return log;
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("performanceLog", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(performanceLogs)
        .where(and(eq(performanceLogs.id, input.id), eq(performanceLogs.organizationId, ctx.organizationId)));
    }),

  demographicBreakdown: orgProcedure
    .input(
      z.object({
        dimension: z.enum(["age", "gender", "country", "device"]),
        from: z.string(),
        to: z.string(),
        accountId: z.string().optional(),
        teamId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const dim = dimensionColumn(input.dimension);
      const accountFilter = input.accountId
        ? sql`AND ad.account_id = ${input.accountId}`
        : sql``;
      const teamFilter = input.teamId
        ? sql`AND ac.team_id = ${input.teamId}`
        : sql``;
      const joinCreative = input.teamId
        ? sql`JOIN ad_creative ac ON ac.id = ad.ad_creative_id`
        : sql``;

      type Row = {
        label: string;
        spend: string | null;
        conversions: string | null;
        roas: string | null;
        impressions: string | null;
      };

      const result = await db.execute(sql`
        SELECT
          ${dim} as label,
          sum(pl.spend)::text as spend,
          sum(pl.conversions)::text as conversions,
          (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          sum(pl.impressions)::text as impressions
        FROM performance_log pl
        JOIN ad ON ad.id = pl.ad_id
        ${joinCreative}
        WHERE pl.date_start <= ${input.to}::date
          AND pl.date_end >= ${input.from}::date
          AND ad.organization_id = ${ctx.organizationId}
          AND ${dim} IS NOT NULL
          AND ${dim} != ''
          ${accountFilter}
          ${teamFilter}
        GROUP BY ${dim}
        ORDER BY sum(pl.spend) DESC NULLS LAST
        LIMIT 15
      `);

      return result.rows as Row[];
    }),

  creativeDemographicBreakdown: orgProcedure
    .input(
      z.object({
        creativeId: z.string(),
        dimension: z.enum(["age", "gender", "country", "device"]),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const dim = dimensionColumn(input.dimension);
      const dateFilter = input.from && input.to
        ? sql`AND pl.date_start <= ${input.to}::date AND pl.date_end >= ${input.from}::date`
        : sql``;

      type Row = {
        label: string;
        spend: string | null;
        conversions: string | null;
        roas: string | null;
        impressions: string | null;
      };

      const result = await db.execute(sql`
        SELECT
          ${dim} as label,
          sum(pl.spend)::text as spend,
          sum(pl.conversions)::text as conversions,
          (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          sum(pl.impressions)::text as impressions
        FROM performance_log pl
        JOIN ad ON ad.id = pl.ad_id
        WHERE ad.ad_creative_id = ${input.creativeId}
          AND ad.organization_id = ${ctx.organizationId}
          AND ${dim} IS NOT NULL
          AND ${dim} != ''
          ${dateFilter}
        GROUP BY ${dim}
        ORDER BY sum(pl.spend) DESC NULLS LAST
        LIMIT 15
      `);

      return result.rows as Row[];
    }),

  exportByAccount: orgProcedure
    .input(
      z.object({
        accountId: z.string(),
        dateFrom: z.string(),
        dateTo: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await db
        .select({
          dateStart: performanceLogs.dateStart,
          dateEnd: performanceLogs.dateEnd,
          campaignName: campaigns.name,
          campaignMetaId: campaigns.metaId,
          adSetName: adSets.name,
          adSetMetaId: adSets.metaId,
          adName: ads.name,
          adMetaId: ads.metaId,
          spend: performanceLogs.spend,
          impressions: performanceLogs.impressions,
          reach: performanceLogs.reach,
          frequency: performanceLogs.frequency,
          cpm: performanceLogs.cpm,
          cpc: performanceLogs.cpc,
          ctr: performanceLogs.ctr,
          conversions: performanceLogs.conversions,
          purchaseValue: performanceLogs.purchaseValue,
          roas: performanceLogs.roas,
          cpa: performanceLogs.cpa,
          linkClicks: performanceLogs.linkClicks,
          landingPageViews: performanceLogs.landingPageViews,
          addToCart: performanceLogs.addToCart,
          initiateCheckout: performanceLogs.initiateCheckout,
          qualityRanking: performanceLogs.qualityRanking,
          engagementRateRanking: performanceLogs.engagementRateRanking,
          conversionRateRanking: performanceLogs.conversionRateRanking,
          videoViews3s: performanceLogs.videoViews3s,
          videoThruplay: performanceLogs.videoThruplay,
          videoAvgWatchTime: performanceLogs.videoAvgWatchTime,
          country: performanceLogs.country,
          platform: performanceLogs.platform,
          placement: performanceLogs.placement,
          device: performanceLogs.device,
          age: performanceLogs.age,
          gender: performanceLogs.gender,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .where(
          and(
            eq(ads.accountId, input.accountId),
            eq(performanceLogs.organizationId, ctx.organizationId),
            gte(performanceLogs.dateStart, input.dateFrom),
            lte(performanceLogs.dateEnd, input.dateTo),
          ),
        )
        .orderBy(desc(performanceLogs.dateStart));

      return rows;
    }),
});
