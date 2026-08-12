import { TRPCError } from "@trpc/server";
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
import { formatDateOnly } from "@/lib/date";
import { baseWindowStart } from "@/lib/retention/policy";

const pgAggregateStringSchema = z.preprocess((value) => value, z.string());

const adSchema = z.object({
  id: z.string(),
  name: z.string(),
  adSetId: z.string().nullable(),
  adCreativeId: z.string().nullable(),
  accountId: z.string().nullable(),
  caption: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  metaId: z.string().nullable(),
  metaImageHash: z.string().nullable(),
  metaVideoId: z.string().nullable(),
  metaCreativeId: z.string().nullable(),
  rawMetaConfiguredStatus: z.string().nullable(),
  rawMetaEffectiveStatus: z.string().nullable(),
  organizationId: z.string().nullable(),
  status: z.enum(["active", "paused", "archived"]),
  notes: z.string().nullable(),
  enrichmentAttemptedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const adDetailsSchema = z.object({
  id: z.string(),
  name: z.string(),
  adSetId: z.string().nullable(),
  adSetName: z.string().nullable(),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  adCreativeId: z.string().nullable(),
  adCreativeName: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  status: z.enum(["active", "paused", "archived"]),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const adSetListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  adCreativeId: z.string().nullable(),
  adCreativeName: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  status: z.enum(["active", "paused", "archived"]),
  notes: z.string().nullable(),
  createdAt: z.date(),
});

const adCreativeListItemSchema = z.object({
  id: z.string(),
  metaId: z.string().nullable(),
  name: z.string(),
  caption: z.string().nullable(),
  adSetId: z.string().nullable(),
  adSetName: z.string().nullable(),
  campaignName: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  status: z.enum(["active", "paused", "archived"]),
  notes: z.string().nullable(),
  createdAt: z.date(),
  totalSpend: z.string().nullable(),
  avgRoas: z.string().nullable(),
  totalConversions: pgAggregateStringSchema.nullable(),
  runningDays: z.number(),
  disableTier: z.enum(["pause_now", "watch"]).nullable(),
  minDate: z.string().nullable(),
  maxDate: z.string().nullable(),
});

const pauseMetaAdsResultSchema = z.object({
  paused: z.array(z.object({
    id: z.string(),
    metaId: z.string(),
    name: z.string(),
  })),
  failed: z.array(z.object({
    id: z.string(),
    metaId: z.string().nullable(),
    name: z.string(),
    error: z.string(),
    metaPaused: z.boolean().optional(),
  })),
});

const renameMetaAdResultSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const adImportResultSchema = z.object({
  adId: z.string(),
  name: z.string(),
});

const adBulkImportResultSchema = z.object({
  ads: z.array(adImportResultSchema),
  skippedExpiredPerformanceRows: z.number().int(),
});

type MetaApiErrorBody = {
  error?: {
    type?: string;
    message?: string;
  };
};

async function postToMetaObject(input: {
  metaId: string;
  accessToken: string;
  fields: Record<string, string>;
}) {
  const body = new URLSearchParams({
    access_token: input.accessToken,
    ...input.fields,
  });

  const response = await fetch(`${META_GRAPH_API_BASE}/${input.metaId}`, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as MetaApiErrorBody | null;
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

async function assertAdSetBelongsToOrg(adSetId: string, organizationId: string) {
  const [adSet] = await db
    .select({ id: adSets.id })
    .from(adSets)
    .where(
      and(
        eq(adSets.id, adSetId),
        eq(adSets.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!adSet) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Ad set does not exist in this organization",
    });
  }
}

async function assertCreativeBelongsToOrg(
  adCreativeId: string,
  organizationId: string,
) {
  const [creative] = await db
    .select({ id: adCreatives.id })
    .from(adCreatives)
    .where(
      and(
        eq(adCreatives.id, adCreativeId),
        eq(adCreatives.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!creative) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Creative does not exist in this organization",
    });
  }
}

async function assertWritableAdReferencesBelongToOrg(input: {
  adSetId?: string | null;
  adCreativeId?: string | null;
  organizationId: string;
}) {
  if (input.adSetId) {
    await assertAdSetBelongsToOrg(input.adSetId, input.organizationId);
  }

  if (input.adCreativeId) {
    await assertCreativeBelongsToOrg(input.adCreativeId, input.organizationId);
  }
}

export const adRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("ad", "list"))
    .output(z.array(adDetailsSchema))
    .query(async ({ ctx }) => {
      return db
        .select({
          id: ads.id,
          name: ads.name,
          adSetId: adSets.id,
          adSetName: adSets.name,
          campaignId: campaigns.id,
          campaignName: campaigns.name,
          adCreativeId: adCreatives.id,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
          updatedAt: ads.updatedAt,
        })
        .from(ads)
        .leftJoin(
          adSets,
          and(
            eq(ads.adSetId, adSets.id),
            eq(adSets.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          campaigns,
          and(
            eq(adSets.campaignId, campaigns.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          adCreatives,
          and(
            eq(ads.adCreativeId, adCreatives.id),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .where(eq(ads.organizationId, ctx.organizationId))
        .orderBy(desc(ads.createdAt));
    }),

  listByAdSet: orgProcedure
    .meta(openApiQueryMeta("ad", "listByAdSet"))
    .input(z.object({ adSetId: z.string() }))
    .output(z.array(adSetListItemSchema))
    .query(async ({ input, ctx }) => {
      await assertAdSetBelongsToOrg(input.adSetId, ctx.organizationId);

      return db
        .select({
          id: ads.id,
          name: ads.name,
          adCreativeId: adCreatives.id,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
        })
        .from(ads)
        .leftJoin(
          adCreatives,
          and(
            eq(ads.adCreativeId, adCreatives.id),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          adSets,
          and(
            eq(ads.adSetId, adSets.id),
            eq(adSets.organizationId, ctx.organizationId),
          ),
        )
        .where(and(eq(adSets.id, input.adSetId), eq(ads.organizationId, ctx.organizationId)))
        .orderBy(desc(ads.createdAt));
    }),

  listByCreative: orgProcedure
    .meta(openApiQueryMeta("ad", "listByCreative"))
    .input(z.object({
      adCreativeId: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .output(z.array(adCreativeListItemSchema))
    .query(async ({ input, ctx }) => {
      await assertCreativeBelongsToOrg(input.adCreativeId, ctx.organizationId);

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
        JOIN ad ad_portfolio
          ON ad_portfolio.id = pl_portfolio.ad_id
         AND ad_portfolio.organization_id = ${ctx.organizationId}
        WHERE pl_portfolio.organization_id = ${ctx.organizationId}
          AND ${portfolioBasePl}
          AND ${portfolioDateFilter}
      `);
      const portfolio = portfolioResult.rows[0] as { portfolio_cpa: string | null } | undefined;
      const portfolioCpa = portfolio?.portfolio_cpa ? parseFloat(portfolio.portfolio_cpa) : null;
      const fairShotSpend = Math.max(50, portfolioCpa && Number.isFinite(portfolioCpa) ? portfolioCpa : 50);
      const runningDaysSql = sql<number>`coalesce((
        SELECT max(pl_lifetime.date_end)::date - min(pl_lifetime.date_start)::date
        FROM performance_log pl_lifetime
        WHERE pl_lifetime.ad_id = ${ads.id}
          AND pl_lifetime.organization_id = ${ctx.organizationId}
          AND ${lifetimeBasePl}
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
          adSetId: adSets.id,
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
        .leftJoin(
          adSets,
          and(
            eq(ads.adSetId, adSets.id),
            eq(adSets.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          campaigns,
          and(
            eq(adSets.campaignId, campaigns.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          performanceLogs,
          and(
            eq(performanceLogs.adId, ads.id),
            eq(performanceLogs.organizationId, ctx.organizationId),
            dateFilter,
          ),
        )
        .where(and(eq(ads.adCreativeId, input.adCreativeId), eq(ads.organizationId, ctx.organizationId)))
        .groupBy(ads.id, ads.metaId, ads.name, ads.caption, adSets.id, adSets.name, adSets.status, campaigns.name, ads.destinationUrl, ads.status, ads.notes, ads.createdAt)
        .orderBy(desc(ads.createdAt));
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("ad", "getById"))
    .input(z.object({ id: z.string() }))
    .output(adDetailsSchema)
    .query(async ({ input, ctx }) => {
      const [ad] = await db
        .select({
          id: ads.id,
          name: ads.name,
          adSetId: adSets.id,
          adSetName: adSets.name,
          campaignId: campaigns.id,
          campaignName: campaigns.name,
          adCreativeId: adCreatives.id,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
          updatedAt: ads.updatedAt,
        })
        .from(ads)
        .leftJoin(
          adSets,
          and(
            eq(ads.adSetId, adSets.id),
            eq(adSets.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          campaigns,
          and(
            eq(adSets.campaignId, campaigns.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          adCreatives,
          and(
            eq(ads.adCreativeId, adCreatives.id),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
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
    .output(adSchema)
    .mutation(async ({ input, ctx }) => {
      await assertWritableAdReferencesBelongToOrg({
        adSetId: input.adSetId,
        adCreativeId: input.adCreativeId,
        organizationId: ctx.organizationId,
      });

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
    .output(adSchema)
    .mutation(async ({ input, ctx }) => {
      await assertWritableAdReferencesBelongToOrg({
        adSetId: input.adSetId,
        adCreativeId: input.adCreativeId,
        organizationId: ctx.organizationId,
      });

      const { id, ...data } = input;
      const [ad] = await db
        .update(ads)
        .set(data)
        .where(and(eq(ads.id, id), eq(ads.organizationId, ctx.organizationId)))
        .returning();
      if (!ad) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Ad does not exist in this organization",
        });
      }
      return ad;
    }),

  pauseMetaAds: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "pauseMetaAds", "Pause selected ads in Meta and mirror successful pauses locally"))
    .input(z.object({ adIds: z.array(z.string()).min(1).max(25) }))
    .output(pauseMetaAdsResultSchema)
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
        .leftJoin(
          adAccounts,
          and(
            eq(ads.accountId, adAccounts.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        )
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
            await postToMetaObject({
              metaId: row.metaId,
              accessToken: row.metaAccessToken,
              fields: { status: "PAUSED" },
            });
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

  renameMetaAd: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "renameMetaAd", "Rename an ad in Meta and mirror the new name locally"))
    .input(z.object({ adId: z.string(), name: z.string().trim().min(1).max(512) }))
    .output(renameMetaAdResultSchema)
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .select({
          id: ads.id,
          metaId: ads.metaId,
          metaAccessToken: adAccounts.metaAccessToken,
        })
        .from(ads)
        .leftJoin(
          adAccounts,
          and(
            eq(ads.accountId, adAccounts.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        )
        .where(and(eq(ads.id, input.adId), eq(ads.organizationId, ctx.organizationId)))
        .limit(1);

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Ad does not exist in this organization",
        });
      }

      if (!row.metaId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This ad is not linked to Meta, so it cannot be renamed there",
        });
      }

      if (!row.metaAccessToken) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This ad's account has no Meta access token connected",
        });
      }

      await postToMetaObject({
        metaId: row.metaId,
        accessToken: row.metaAccessToken,
        fields: { name: input.name },
      });

      let updatedRows: { id: string }[] = [];
      try {
        updatedRows = await db
          .update(ads)
          .set({ name: input.name })
          .where(and(eq(ads.id, input.adId), eq(ads.organizationId, ctx.organizationId)))
          .returning({ id: ads.id });
      } catch {
        // Treated the same as matching no rows below.
      }

      if (updatedRows.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Renamed on Meta, but the local update failed. The next sync will reconcile it.",
        });
      }

      return { id: row.id, name: input.name };
    }),

  duplicate: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "duplicate"))
    .input(z.object({ id: z.string() }))
    .output(adSchema)
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(ads)
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Ad not found");
      await assertWritableAdReferencesBelongToOrg({
        adSetId: source.adSetId,
        adCreativeId: source.adCreativeId,
        organizationId: ctx.organizationId,
      });

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
    .output(adBulkImportResultSchema)
    .mutation(async ({ input, ctx }) => {
      if (input.rows.length === 0) {
        return { ads: [], skippedExpiredPerformanceRows: 0 };
      }
      await assertAdSetBelongsToOrg(input.adSetId, ctx.organizationId);

      const insertedAds = await db
        .insert(ads)
        .values(input.rows.map((row) => ({
          name: row.name,
          adSetId: input.adSetId,
          organizationId: ctx.organizationId,
        })))
        .returning({ id: ads.id, name: ads.name });

      const windowStart = baseWindowStart(formatDateOnly(new Date()));
      let skippedExpiredPerformanceRows = 0;
      const performanceRows = input.rows.flatMap((row, index) => {
        const ad = insertedAds[index];
        const hasPerf = row.spend || row.roas || row.conversions;
        if (!ad || !hasPerf || !row.dateStart || !row.dateEnd) return [];
        if (row.dateEnd < windowStart) {
          skippedExpiredPerformanceRows += 1;
          return [];
        }

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

      return {
        ads: insertedAds.map((ad) => ({ adId: ad.id, name: ad.name })),
        skippedExpiredPerformanceRows,
      };
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "delete"))
    .input(z.object({ id: z.string() }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(ads)
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
    }),
});
