import { z } from "zod";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { adCreatives } from "@/schema/ad-creative";
import { campaigns } from "@/schema/campaign";
import { adAccounts } from "@/schema/account";
import { performanceLogs } from "@/schema/performance-log";
import { effectiveAdStatusSql } from "@/lib/effective-ad-status";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { handleMetaApiError, META_GRAPH_API_BASE } from "@/lib/meta-insights-sync";

type MetaPauseErrorBody = {
  error?: {
    type?: string;
    message?: string;
  };
};

async function pauseMetaAd(input: { metaId: string; accessToken: string }) {
  const body = new URLSearchParams({
    access_token: input.accessToken,
    status: "PAUSED",
  });

  const response = await fetch(`${META_GRAPH_API_BASE}/${input.metaId}`, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as MetaPauseErrorBody | null;
    handleMetaApiError(response, errorBody);
  }
}

async function markAdsPausedWithRetry(adIds: string[]) {
  if (adIds.length === 0) return [];

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db
        .update(ads)
        .set({ status: "paused" })
        .where(inArray(ads.id, adIds))
        .returning({ id: ads.id });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

export const adRouter = router({
  list: orgProcedure.meta(openApiQueryMeta("ad", "list")).query(async ({ ctx }) => {
    return db
      .select({
        id: ads.id,
        name: ads.name,
        adSetId: ads.adSetId,
        adSetName: adSets.name,
        campaignId: adSets.campaignId,
        campaignName: campaigns.name,
        adCreativeId: ads.adCreativeId,
        adCreativeName: adCreatives.name,
        destinationUrl: ads.destinationUrl,
        status: effectiveAdStatusSql(ads.status, adSets.status),
        notes: ads.notes,
        createdAt: ads.createdAt,
        updatedAt: ads.updatedAt,
      })
      .from(ads)
      .leftJoin(adSets, eq(ads.adSetId, adSets.id))
      .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(eq(ads.organizationId, ctx.organizationId))
      .orderBy(desc(ads.createdAt));
  }),

  listByAdSet: orgProcedure
    .meta(openApiQueryMeta("ad", "listByAdSet"))
    .input(z.object({ adSetId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select({
          id: ads.id,
          name: ads.name,
          adCreativeId: ads.adCreativeId,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
        })
        .from(ads)
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .where(and(eq(ads.adSetId, input.adSetId), eq(ads.organizationId, ctx.organizationId)))
        .orderBy(desc(ads.createdAt));
    }),

  listByCreative: orgProcedure
    .meta(openApiQueryMeta("ad", "listByCreative"))
    .input(z.object({
      adCreativeId: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const basePl = basePerformanceLogFilter("performance_log");
      const lifetimeBasePl = basePerformanceLogFilter("pl_lifetime");
      const dateFilter = and(
        basePl,
        input.from ? sql`${performanceLogs.dateStart} >= ${input.from}` : undefined,
        input.to ? sql`${performanceLogs.dateEnd} <= ${input.to}` : undefined,
      );
      const portfolioBasePl = basePerformanceLogFilter("pl_portfolio");
      const portfolioDateFilter = input.from && input.to
        ? sql`pl_portfolio.date_start <= ${input.to}::date AND pl_portfolio.date_end >= ${input.from}::date`
        : sql`true`;
      const portfolioResult = await db.execute(sql`
        SELECT (coalesce(sum(pl_portfolio.spend), 0) / nullif(sum(pl_portfolio.conversions), 0))::text AS portfolio_cpa
        FROM performance_log pl_portfolio
        JOIN ad ad_portfolio ON ad_portfolio.id = pl_portfolio.ad_id
        WHERE ${portfolioBasePl}
          AND ${portfolioDateFilter}
          AND ad_portfolio.organization_id = ${ctx.organizationId}
      `);
      const portfolio = portfolioResult.rows[0] as { portfolio_cpa: string | null } | undefined;
      const portfolioCpa = portfolio?.portfolio_cpa ? parseFloat(portfolio.portfolio_cpa) : null;
      const fairShotSpend = Math.max(50, portfolioCpa && Number.isFinite(portfolioCpa) ? portfolioCpa : 50);
      const runningDaysSql = sql<number>`coalesce((
        SELECT max(pl_lifetime.date_end)::date - min(pl_lifetime.date_start)::date
        FROM performance_log pl_lifetime
        WHERE pl_lifetime.ad_id = ${ads.id} AND ${lifetimeBasePl}
      ), 0)`;
      const spendSql = sql`coalesce(sum(${performanceLogs.spend}), 0)`;
      const conversionsSql = sql`coalesce(sum(${performanceLogs.conversions}), 0)`;
      const roasSql = sql`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`;
      const effectiveStatus = effectiveAdStatusSql(ads.status, adSets.status);
      return db
        .select({
          id: ads.id,
          metaId: ads.metaId,
          name: ads.name,
          caption: ads.caption,
          adSetId: ads.adSetId,
          adSetName: adSets.name,
          campaignName: campaigns.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveStatus,
          notes: ads.notes,
          createdAt: ads.createdAt,
          totalSpend: sql<string | null>`sum(${performanceLogs.spend})`.as("total_spend"),
          avgRoas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`.as("avg_roas"),
          totalConversions: sql<number | null>`sum(${performanceLogs.conversions})`.as("total_conversions"),
          runningDays: runningDaysSql.as("running_days"),
          disableTier: sql<"pause_now" | "watch" | null>`
            CASE
              WHEN ${effectiveStatus} = 'active'
                AND ${spendSql} >= 25
                AND (${conversionsSql} = 0 OR (${roasSql} IS NOT NULL AND ${roasSql} < 1.0))
              THEN CASE
                WHEN ${spendSql} >= ${fairShotSpend} AND ${runningDaysSql} >= 5 THEN 'pause_now'
                WHEN ${spendSql} >= ${fairShotSpend} OR ${runningDaysSql} >= 7 THEN 'watch'
                ELSE NULL
              END
              ELSE NULL
            END
          `.as("disable_tier"),
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`.as("min_date"),
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`.as("max_date"),
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .leftJoin(performanceLogs, and(eq(performanceLogs.adId, ads.id), dateFilter))
        .where(and(eq(ads.adCreativeId, input.adCreativeId), eq(ads.organizationId, ctx.organizationId)))
        .groupBy(ads.id, ads.metaId, ads.name, ads.caption, ads.adSetId, adSets.name, adSets.status, campaigns.name, ads.destinationUrl, ads.status, ads.notes, ads.createdAt)
        .orderBy(desc(ads.createdAt));
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("ad", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [ad] = await db
        .select({
          id: ads.id,
          name: ads.name,
          adSetId: ads.adSetId,
          adSetName: adSets.name,
          campaignId: adSets.campaignId,
          campaignName: campaigns.name,
          adCreativeId: ads.adCreativeId,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
          updatedAt: ads.updatedAt,
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
      if (!ad) throw new Error("Ad not found");
      return ad;
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "create"))
    .input(
      z.object({
        name: z.string().optional(),
        adSetId: z.string().optional(),
        adCreativeId: z.string().optional(),
        metaId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [ad] = await db
        .insert(ads)
        .values({
          name: input.name ?? "Untitled Ad",
          adSetId: input.adSetId,
          adCreativeId: input.adCreativeId,
          metaId: input.metaId,
          organizationId: ctx.organizationId,
        })
        .returning();
      return ad;
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        adSetId: z.string().optional(),
        adCreativeId: z.string().nullable().optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        metaId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [ad] = await db
        .update(ads)
        .set(data)
        .where(and(eq(ads.id, id), eq(ads.organizationId, ctx.organizationId)))
        .returning();
      return ad;
    }),

  pauseMetaAds: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "pauseMetaAds", "Pause selected ads in Meta and mirror successful pauses locally"))
    .input(z.object({ adIds: z.array(z.string()).min(1).max(25) }))
    .mutation(async ({ input, ctx }) => {
      const uniqueAdIds = [...new Set(input.adIds)];
      const rows = await db
        .select({
          id: ads.id,
          name: ads.name,
          metaId: ads.metaId,
          metaAccessToken: adAccounts.metaAccessToken,
        })
        .from(ads)
        .leftJoin(adAccounts, eq(ads.accountId, adAccounts.id))
        .where(and(eq(ads.organizationId, ctx.organizationId), inArray(ads.id, uniqueAdIds)));

      const foundIds = new Set(rows.map((row) => row.id));
      const missing = uniqueAdIds
        .filter((adId) => !foundIds.has(adId))
        .map((adId) => ({ id: adId, metaId: null, name: "Unknown ad", error: "Ad not found" }));

      const failed: { id: string; metaId: string | null; name: string; error: string; metaPaused?: boolean }[] = [...missing];
      const pauseableRows = rows.filter((row): row is typeof row & { metaId: string; metaAccessToken: string } => {
        if (!row.metaId) {
          failed.push({ id: row.id, metaId: null, name: row.name, error: "This ad has no Meta ID" });
          return false;
        }

        if (!row.metaAccessToken) {
          failed.push({ id: row.id, metaId: row.metaId, name: row.name, error: "This ad's account has no Meta access token" });
          return false;
        }

        return true;
      });

      const metaResults = await Promise.all(
        pauseableRows.map(async (row) => {
          try {
            await pauseMetaAd({ metaId: row.metaId, accessToken: row.metaAccessToken });
            return { row, ok: true as const };
          } catch (error) {
            return {
              row,
              ok: false as const,
              error: error instanceof Error ? error.message : "Meta pause failed",
            };
          }
        }),
      );

      for (const result of metaResults) {
        if (!result.ok) {
          failed.push({
            id: result.row.id,
            metaId: result.row.metaId,
            name: result.row.name,
            error: result.error,
          });
        }
      }

      const metaPausedRows = metaResults
        .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
        .map((result) => result.row);
      const paused: { id: string; metaId: string; name: string }[] = [];

      try {
        const updatedRows = await markAdsPausedWithRetry(metaPausedRows.map((row) => row.id));
        const updatedIds = new Set(updatedRows.map((row) => row.id));

        for (const row of metaPausedRows) {
          if (updatedIds.has(row.id)) {
            paused.push({ id: row.id, metaId: row.metaId, name: row.name });
          } else {
            failed.push({
              id: row.id,
              metaId: row.metaId,
              name: row.name,
              error: "Meta paused, but local DB update did not update this ad",
              metaPaused: true,
            });
          }
        }
      } catch (error) {
        for (const row of metaPausedRows) {
          failed.push({
            id: row.id,
            metaId: row.metaId,
            name: row.name,
            error: error instanceof Error ? error.message : "Meta paused, but local DB update failed",
            metaPaused: true,
          });
        }
      }

      return { paused, failed };
    }),

  duplicate: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "duplicate"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(ads)
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Ad not found");
      const [duplicate] = await db
        .insert(ads)
        .values({
          name: `Copy of ${source.name}`,
          adSetId: source.adSetId,
          adCreativeId: source.adCreativeId,
          status: source.status,
          notes: source.notes,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "bulkImport"))
    .input(
      z.object({
        adSetId: z.string(),
        rows: z.array(
          z.object({
            name: z.string(),
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
            dateStart: z.string().optional(),
            dateEnd: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.rows.length === 0) return [];

      const insertedAds = await db
        .insert(ads)
        .values(input.rows.map((row) => ({
          name: row.name,
          adSetId: input.adSetId,
          organizationId: ctx.organizationId,
        })))
        .returning({ id: ads.id, name: ads.name });

      const performanceRows = input.rows.flatMap((row, index) => {
        const ad = insertedAds[index];
        const hasPerf = row.spend || row.roas || row.conversions;
        if (!ad || !hasPerf || !row.dateStart || !row.dateEnd) return [];

        return [{
          adId: ad.id,
          organizationId: ctx.organizationId,
          roas: row.roas,
          cpa: row.cpa,
          ctr: row.ctr,
          conversionRate: row.conversionRate,
          spend: row.spend,
          conversions: row.conversions,
          impressions: row.impressions,
          reach: row.reach,
          frequency: row.frequency,
          cpm: row.cpm,
          qualityRanking: row.qualityRanking,
          engagementRateRanking: row.engagementRateRanking,
          conversionRateRanking: row.conversionRateRanking,
          dateStart: row.dateStart,
          dateEnd: row.dateEnd,
        }];
      });

      if (performanceRows.length > 0) {
        await db
          .insert(performanceLogs)
          .values(performanceRows)
          .onConflictDoNothing({
            target: [
              performanceLogs.adId,
              performanceLogs.dateStart,
              performanceLogs.dateEnd,
              performanceLogs.country,
              performanceLogs.platform,
              performanceLogs.placement,
              performanceLogs.device,
              performanceLogs.age,
              performanceLogs.gender,
            ],
          });
      }

      return insertedAds.map((ad) => ({ adId: ad.id, name: ad.name }));
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(ads)
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
    }),
});
