import { z } from "zod";
import { eq, desc, ilike, and, sql, type SQL } from "drizzle-orm";
import { router, orgProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { landingPages } from "@/schema/landing-page";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";
import { adAccounts } from "@/schema/account";

export const adCreativeRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("adCreative", "list"))
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
          untaggedOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const conditions: SQL[] = [eq(adCreatives.organizationId, ctx.organizationId)];
      if (input?.format) {
        conditions.push(eq(adCreatives.format, input.format));
      }
      if (input?.awarenessLevel) {
        conditions.push(
          eq(adCreatives.awarenessLevel, input.awarenessLevel),
        );
      }
      if (input?.search) {
        conditions.push(ilike(adCreatives.name, `%${input.search}%`));
      }
      if (input?.accountId) {
        conditions.push(sql`EXISTS (SELECT 1 FROM ad WHERE ad.ad_creative_id = ${adCreatives.id} AND ad.account_id = ${input.accountId})`);
      }
      if (input?.adSetIds?.length) {
        const placeholders = input.adSetIds.map((id) => sql`${id}`);
        const inList = sql.join(placeholders, sql`, `);
        conditions.push(sql`EXISTS (SELECT 1 FROM ad WHERE ad.ad_creative_id = ${adCreatives.id} AND ad.ad_set_id IN (${inList}))`);
      }
      if (input?.untaggedOnly) {
        conditions.push(sql`(${adCreatives.format} IS NULL AND ${adCreatives.angle} IS NULL AND ${adCreatives.awarenessLevel} IS NULL)`);
      }

      return db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          videoUrl: adCreatives.videoUrl,
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
          landingPageId: adCreatives.landingPageId,
          landingPageName: landingPages.name,
          notes: adCreatives.notes,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
          totalSpend: sql<string | null>`(
            SELECT sum(pl.spend) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("total_spend"),
          avgRoas: sql<string | null>`(
            SELECT coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("avg_roas"),
          totalConversions: sql<number | null>`(
            SELECT sum(pl.conversions) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("total_conversions"),
          adStatus: sql<string | null>`(
            SELECT ad.status FROM ad
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("ad_status"),
          metaAdId: sql<string | null>`(
            SELECT ad.meta_id FROM ad
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("meta_ad_id"),
          avgCpa: sql<string | null>`(
            SELECT coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("avg_cpa"),
          avgCtr: sql<string | null>`(
            SELECT avg(pl.ctr)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("avg_ctr"),
          metaCampaignId: sql<string | null>`(
            SELECT c.meta_id FROM ad
            JOIN ad_set ast ON ast.id = ad.ad_set_id
            JOIN campaign c ON c.id = ast.campaign_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("meta_campaign_id"),
          metaAdSetId: sql<string | null>`(
            SELECT ast.meta_id FROM ad
            JOIN ad_set ast ON ast.id = ad.ad_set_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("meta_ad_set_id"),
          accountName: sql<string | null>`(
            SELECT acc.name FROM ad
            JOIN ad_account acc ON acc.id = ad.account_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("account_name"),
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(adCreatives.createdAt));
    }),

  dashboardStats: orgProcedure
    .meta(openApiQueryMeta("adCreative", "dashboardStats"))
    .input(
      z
        .object({
          days: z.number().int().min(1).max(90).default(7),
          from: z.string().optional(),
          to: z.string().optional(),
          accountId: z.string().optional(),
          campaignIds: z.array(z.string()).optional(),
          adSetIds: z.array(z.string()).optional(),
          statuses: z.array(z.enum(["active", "paused", "archived"])).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const days = input?.days ?? 7;
      const accountFilter = input?.accountId
        ? sql`AND ad.account_id = ${input.accountId}`
        : sql``;
      const campaignFilter = input?.campaignIds?.length
        ? sql`AND ad.ad_set_id IN (SELECT ast.id FROM ad_set ast WHERE ast.campaign_id IN (${sql.join(input.campaignIds.map((id) => sql`${id}`), sql`, `)}))`
        : sql``;
      const adSetFilter = input?.adSetIds?.length
        ? sql`AND ad.ad_set_id IN (${sql.join(input.adSetIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
      const statusFilter = input?.statuses?.length
        ? sql`AND ad.status::text IN (${sql.join(input.statuses.map((s) => sql`${s}`), sql`, `)})`
        : sql``;

      const dateFilter = input?.from && input?.to
        ? sql`pl.date_start <= ${input.to}::date AND pl.date_end >= ${input.from}::date`
        : sql`pl.date_start <= current_date AND pl.date_end >= current_date - ${days}::int`;

      type PortfolioRow = {
        total_spend: string | null;
        total_purchase_value: string | null;
        portfolio_roas: string | null;
        portfolio_cpa: string | null;
        portfolio_ctr: string | null;
        total_conversions: string | null;
      };
      // Portfolio KPIs
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
        WHERE ${dateFilter} AND ad.organization_id = ${ctx.organizationId} ${accountFilter} ${campaignFilter} ${adSetFilter} ${statusFilter}
      `);
      const portfolio = (portfolioResult.rows as PortfolioRow[])[0];

      type CreativeRow = {
        id: string;
        name: string;
        format: string | null;
        total_spend: string;
        roas: string;
        cpa: string | null;
        ctr: string | null;
        total_conversions: string;
        ad_status: string | null;
      };

      // Top performers by ROAS (min $50 spend)
      const topResult = await db.execute(sql`
        SELECT
          ac.id,
          ac.name,
          ac.format,
          sum(pl.spend)::text as total_spend,
          (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as cpa,
          avg(pl.ctr)::text as ctr,
          sum(pl.conversions)::text as total_conversions,
          (SELECT ad2.status FROM ad ad2 WHERE ad2.ad_creative_id = ac.id LIMIT 1) as ad_status
        FROM ad_creative ac
        JOIN ad ON ad.ad_creative_id = ac.id
        JOIN performance_log pl ON pl.ad_id = ad.id
        WHERE ${dateFilter} AND ad.organization_id = ${ctx.organizationId} ${accountFilter} ${campaignFilter} ${adSetFilter} ${statusFilter}
        GROUP BY ac.id, ac.name, ac.format
        HAVING sum(pl.spend) >= 50
        ORDER BY coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) DESC NULLS LAST
        LIMIT 5
      `);
      const topPerformers = topResult.rows as CreativeRow[];

      // Bottom performers by ROAS (min $50 spend, excluding top performers)
      const topIds = topPerformers.map((r) => r.id);
      const topExclude = topIds.length
        ? sql`AND ac.id NOT IN (${sql.join(topIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
      const bottomResult = await db.execute(sql`
        SELECT
          ac.id,
          ac.name,
          ac.format,
          sum(pl.spend)::text as total_spend,
          (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as roas,
          (coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as cpa,
          avg(pl.ctr)::text as ctr,
          sum(pl.conversions)::text as total_conversions,
          (SELECT ad2.status FROM ad ad2 WHERE ad2.ad_creative_id = ac.id LIMIT 1) as ad_status
        FROM ad_creative ac
        JOIN ad ON ad.ad_creative_id = ac.id
        JOIN performance_log pl ON pl.ad_id = ad.id
        WHERE ${dateFilter} AND ad.organization_id = ${ctx.organizationId} ${accountFilter} ${campaignFilter} ${adSetFilter} ${statusFilter} ${topExclude}
        GROUP BY ac.id, ac.name, ac.format
        HAVING sum(pl.spend) >= 50
        ORDER BY coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) ASC NULLS FIRST
        LIMIT 5
      `);
      const bottomPerformers = bottomResult.rows as CreativeRow[];

      return {
        portfolio: {
          totalSpend: portfolio?.total_spend ?? null,
          totalRevenue: portfolio?.total_purchase_value ?? null,
          roas: portfolio?.portfolio_roas ?? null,
          cpa: portfolio?.portfolio_cpa ?? null,
          ctr: portfolio?.portfolio_ctr ?? null,
          conversions: portfolio?.total_conversions ?? null,
        },
        topPerformers: topPerformers.map((r) => ({
          id: r.id,
          name: r.name,
          format: r.format,
          totalSpend: r.total_spend,
          roas: r.roas,
          cpa: r.cpa,
          ctr: r.ctr,
          conversions: r.total_conversions,
          adStatus: r.ad_status,
        })),
        bottomPerformers: bottomPerformers.map((r) => ({
          id: r.id,
          name: r.name,
          format: r.format,
          totalSpend: r.total_spend,
          roas: r.roas,
          cpa: r.cpa,
          ctr: r.ctr,
          conversions: r.total_conversions,
          adStatus: r.ad_status,
        })),
      };
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [creative] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          videoUrl: adCreatives.videoUrl,
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
          landingPageId: adCreatives.landingPageId,
          landingPageName: landingPages.name,
          notes: adCreatives.notes,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
      if (!creative) throw new Error("Ad creative not found");
      return creative;
    }),

  create: orgProcedure
    .meta(openApiMutationMeta("adCreative", "create"))
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(async ({ input, ctx }) => {
      const [creative] = await db
        .insert(adCreatives)
        .values({
          name: input?.name ?? "Untitled Creative",
          organizationId: ctx.organizationId,
        })
        .returning();
      return creative;
    }),

  update: orgProcedure
    .meta(openApiMutationMeta("adCreative", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        assetUrl: z.string().nullable().optional(),
        format: z.enum(["static", "video", "ugc", "carousel"]).nullable().optional(),
        angle: z.string().nullable().optional(),
        persona: z.string().nullable().optional(),
        awarenessLevel: z
          .enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"])
          .nullable()
          .optional(),
        hook: z.string().nullable().optional(),
        tone: z.array(z.string()).nullable().optional(),
        cta: z.string().nullable().optional(),
        landingPageId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [creative] = await db
        .update(adCreatives)
        .set(data)
        .where(and(eq(adCreatives.id, id), eq(adCreatives.organizationId, ctx.organizationId)))
        .returning();
      return creative;
    }),

  duplicate: orgProcedure
    .meta(openApiMutationMeta("adCreative", "duplicate"))
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
          hook: source.hook,
          tone: source.tone,
          cta: source.cta,
          landingPageId: source.landingPageId,
          notes: source.notes,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: orgProcedure
    .meta(openApiMutationMeta("adCreative", "bulkImport"))
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
      const normalizeName = (value?: string | null) => value?.trim() || undefined;
      const normalizeDimension = (value?: string | null) => value?.trim() || "";
      const normalizeDateValue = (value: string | Date) =>
        typeof value === "string" ? value : value.toISOString().slice(0, 10);
      const normalizeStatus = (delivery?: string) =>
        delivery === "active"
          ? "active" as const
          : delivery === "inactive" || delivery === "not_delivering"
            ? "paused" as const
            : "active" as const;
      const buildPerfRowKey = (row: {
        adId: string;
        dateStart: string | Date;
        dateEnd: string | Date;
        country?: string | null;
        platform?: string | null;
        placement?: string | null;
        device?: string | null;
        age?: string | null;
        gender?: string | null;
      }) => [
        row.adId,
        normalizeDateValue(row.dateStart),
        normalizeDateValue(row.dateEnd),
        normalizeDimension(row.country),
        normalizeDimension(row.platform),
        normalizeDimension(row.placement),
        normalizeDimension(row.device),
        normalizeDimension(row.age),
        normalizeDimension(row.gender),
      ].join("|");

      // 1. Upsert campaigns from imported hierarchy data
      const campaignInfoMap = new Map<string, { name: string; metaId?: string }>();
      for (const row of input.rows) {
        const campaignName = normalizeName(row.campaignName);
        const campaignMetaId = normalizeName(row.campaignId);
        if (!campaignName && !campaignMetaId) continue;
        const key = campaignMetaId ?? `name:${campaignName}`;
        if (!campaignInfoMap.has(key)) {
          campaignInfoMap.set(key, {
            name: campaignName ?? `Campaign ${campaignMetaId}`,
            metaId: campaignMetaId,
          });
        }
      }

      const existingCampaignByMetaId = new Map<string, { id: string; name: string; metaId: string | null }>();
      const campaignMetaIds = [...campaignInfoMap.values()]
        .map((campaign) => campaign.metaId)
        .filter(Boolean) as string[];
      if (campaignMetaIds.length > 0) {
        const rows = await db
          .select({ id: campaigns.id, name: campaigns.name, metaId: campaigns.metaId })
          .from(campaigns)
          .where(
            and(
              sql`${campaigns.metaId} IN (${sql.join(campaignMetaIds.map((id) => sql`${id}`), sql`, `)})`,
              eq(campaigns.organizationId, ctx.organizationId),
            ),
          );
        for (const row of rows) {
          if (row.metaId) existingCampaignByMetaId.set(row.metaId, row);
        }
      }

      const campaignNamesWithoutMeta = [...campaignInfoMap.values()]
        .filter((campaign) => !campaign.metaId)
        .map((campaign) => campaign.name);
      const existingCampaignByName = new Map<string, { id: string; name: string; metaId: string | null }>();
      if (campaignNamesWithoutMeta.length > 0) {
        const rows = await db
          .select({ id: campaigns.id, name: campaigns.name, metaId: campaigns.metaId })
          .from(campaigns)
          .where(
            and(
              sql`${campaigns.name} IN (${sql.join(campaignNamesWithoutMeta.map((name) => sql`${name}`), sql`, `)})`,
              eq(campaigns.organizationId, ctx.organizationId),
            ),
          );
        for (const row of rows) {
          existingCampaignByName.set(row.name, row);
        }
      }

      const campaignIdByKey = new Map<string, string>();
      const campaignsToCreate: { key: string; name: string; metaId?: string }[] = [];

      for (const [key, campaign] of campaignInfoMap) {
        const existing = (campaign.metaId && existingCampaignByMetaId.get(campaign.metaId))
          || existingCampaignByName.get(campaign.name);
        if (existing) {
          campaignIdByKey.set(key, existing.id);
          const needsUpdate =
            existing.name !== campaign.name ||
            (campaign.metaId && existing.metaId !== campaign.metaId);
          if (needsUpdate) {
            await db.update(campaigns).set({
              name: campaign.name,
              ...(campaign.metaId ? { metaId: campaign.metaId } : {}),
            }).where(
              and(
                eq(campaigns.id, existing.id),
                eq(campaigns.organizationId, ctx.organizationId),
              ),
            );
          }
          continue;
        }
        campaignsToCreate.push({ key, name: campaign.name, metaId: campaign.metaId });
      }

      if (campaignsToCreate.length > 0) {
        for (let i = 0; i < campaignsToCreate.length; i += 500) {
          const batch = campaignsToCreate.slice(i, i + 500);
          const inserted = await db.insert(campaigns).values(
            batch.map((campaign) => ({
              name: campaign.name,
              metaId: campaign.metaId,
              organizationId: ctx.organizationId,
            })),
          ).returning({ id: campaigns.id, name: campaigns.name, metaId: campaigns.metaId });
          inserted.forEach((row, index) => {
            campaignIdByKey.set(batch[index]!.key, row.id);
          });
        }
      }

      // 2. Upsert ad sets from imported hierarchy data
      const adSetInfoMap = new Map<string, { name: string; metaId?: string; campaignDbId: string }>();
      for (const row of input.rows) {
        const adSetName = normalizeName(row.adSetName);
        const adSetMetaId = normalizeName(row.adSetId);
        const campaignName = normalizeName(row.campaignName);
        const campaignMetaId = normalizeName(row.campaignId);
        const campaignKey = campaignMetaId ?? (campaignName ? `name:${campaignName}` : undefined);
        const campaignDbId = campaignKey ? campaignIdByKey.get(campaignKey) : undefined;
        if (!campaignDbId || (!adSetName && !adSetMetaId)) continue;
        const key = adSetMetaId ?? `${campaignDbId}:${adSetName}`;
        if (!adSetInfoMap.has(key)) {
          adSetInfoMap.set(key, {
            name: adSetName ?? `Ad Set ${adSetMetaId}`,
            metaId: adSetMetaId,
            campaignDbId,
          });
        }
      }

      const existingAdSetByMetaId = new Map<string, { id: string; name: string; metaId: string | null; campaignId: string }>();
      const adSetMetaIds = [...adSetInfoMap.values()]
        .map((adSet) => adSet.metaId)
        .filter(Boolean) as string[];
      if (adSetMetaIds.length > 0) {
        const rows = await db
          .select({ id: adSets.id, name: adSets.name, metaId: adSets.metaId, campaignId: adSets.campaignId })
          .from(adSets)
          .where(
            and(
              sql`${adSets.metaId} IN (${sql.join(adSetMetaIds.map((id) => sql`${id}`), sql`, `)})`,
              eq(adSets.organizationId, ctx.organizationId),
            ),
          );
        for (const row of rows) {
          if (row.metaId) existingAdSetByMetaId.set(row.metaId, row);
        }
      }

      const adSetNamesWithoutMeta = [...new Set(
        [...adSetInfoMap.values()].filter((adSet) => !adSet.metaId).map((adSet) => adSet.name),
      )];
      const existingAdSetsByName = new Map<string, { id: string; name: string; metaId: string | null; campaignId: string }[]>();
      if (adSetNamesWithoutMeta.length > 0) {
        const rows = await db
          .select({ id: adSets.id, name: adSets.name, metaId: adSets.metaId, campaignId: adSets.campaignId })
          .from(adSets)
          .where(
            and(
              sql`${adSets.name} IN (${sql.join(adSetNamesWithoutMeta.map((name) => sql`${name}`), sql`, `)})`,
              eq(adSets.organizationId, ctx.organizationId),
            ),
          );
        for (const row of rows) {
          const matches = existingAdSetsByName.get(row.name) ?? [];
          matches.push(row);
          existingAdSetsByName.set(row.name, matches);
        }
      }

      const adSetIdByKey = new Map<string, string>();
      const adSetsToCreate: { key: string; name: string; metaId?: string; campaignDbId: string }[] = [];

      for (const [key, adSet] of adSetInfoMap) {
        const existing = (adSet.metaId && existingAdSetByMetaId.get(adSet.metaId))
          || (existingAdSetsByName.get(adSet.name) ?? []).find((row) => row.campaignId === adSet.campaignDbId);
        if (existing) {
          adSetIdByKey.set(key, existing.id);
          const needsUpdate =
            existing.name !== adSet.name ||
            existing.campaignId !== adSet.campaignDbId ||
            (adSet.metaId && existing.metaId !== adSet.metaId);
          if (needsUpdate) {
            await db.update(adSets).set({
              name: adSet.name,
              campaignId: adSet.campaignDbId,
              ...(adSet.metaId ? { metaId: adSet.metaId } : {}),
            }).where(
              and(
                eq(adSets.id, existing.id),
                eq(adSets.organizationId, ctx.organizationId),
              ),
            );
          }
          continue;
        }
        adSetsToCreate.push({
          key,
          name: adSet.name,
          metaId: adSet.metaId,
          campaignDbId: adSet.campaignDbId,
        });
      }

      if (adSetsToCreate.length > 0) {
        for (let i = 0; i < adSetsToCreate.length; i += 500) {
          const batch = adSetsToCreate.slice(i, i + 500);
          const inserted = await db.insert(adSets).values(
            batch.map((adSet) => ({
              name: adSet.name,
              metaId: adSet.metaId,
              campaignId: adSet.campaignDbId,
              organizationId: ctx.organizationId,
            })),
          ).returning({ id: adSets.id });
          inserted.forEach((row, index) => {
            adSetIdByKey.set(batch[index]!.key, row.id);
          });
        }
      }

      // 1. Collect unique ads from import, keyed by metaAdId (primary) or name (fallback)
      const adInfoMap = new Map<string, { name: string; delivery?: string; metaAdId?: string; adSetDbId?: string }>();
      for (const row of input.rows) {
        const key = row.adId || row.name;
        const adSetKey = normalizeName(row.adSetId)
          ?? (() => {
            const adSetName = normalizeName(row.adSetName);
            const campaignKey = normalizeName(row.campaignId)
              ?? (normalizeName(row.campaignName) ? `name:${normalizeName(row.campaignName)}` : undefined);
            const campaignDbId = campaignKey ? campaignIdByKey.get(campaignKey) : undefined;
            return adSetName && campaignDbId ? `${campaignDbId}:${adSetName}` : undefined;
          })();
        if (!adInfoMap.has(key)) {
          adInfoMap.set(key, {
            name: row.name,
            delivery: row.delivery,
            metaAdId: row.adId,
            adSetDbId: adSetKey ? adSetIdByKey.get(adSetKey) : undefined,
          });
        }
      }

      // 3. Fetch existing ads by meta_id first, then by name for any unmatched
      const metaIds = [...adInfoMap.values()].map((a) => a.metaAdId).filter(Boolean) as string[];
      const existingByMetaId = new Map<string, { id: string; name: string; adCreativeId: string | null; adSetId: string | null }>();
      if (metaIds.length > 0) {
        const rows = await db
          .select({ id: ads.id, name: ads.name, adCreativeId: ads.adCreativeId, adSetId: ads.adSetId, metaId: ads.metaId })
          .from(ads)
          .where(
            and(
              sql`${ads.metaId} IN (${sql.join(metaIds.map((m) => sql`${m}`), sql`, `)})`,
              eq(ads.organizationId, ctx.organizationId),
            ),
          );
        for (const row of rows) {
          if (row.metaId) existingByMetaId.set(row.metaId, row);
        }
      }

      const unmatchedNames: string[] = [];
      for (const info of adInfoMap.values()) {
        if (info.metaAdId && existingByMetaId.has(info.metaAdId)) continue;
        if (!info.metaAdId) unmatchedNames.push(info.name);
      }

      const existingByName = new Map<string, { id: string; name: string; adCreativeId: string | null; adSetId: string | null }>();
      if (unmatchedNames.length > 0) {
        const rows = await db
          .select({ id: ads.id, name: ads.name, adCreativeId: ads.adCreativeId, adSetId: ads.adSetId })
          .from(ads)
          .where(
            and(
              sql`${ads.name} IN (${sql.join(unmatchedNames.map((n) => sql`${n}`), sql`, `)})`,
              eq(ads.organizationId, ctx.organizationId),
            ),
          );
        for (const row of rows) {
          existingByName.set(row.name, row);
        }
      }

      // Build a unified map of existing ads (metaId match takes priority)
      const existingMap = new Map<string, { id: string; name: string; adCreativeId: string | null; adSetId: string | null }>();
      for (const [key, info] of adInfoMap) {
        const byMeta = info.metaAdId ? existingByMetaId.get(info.metaAdId) : undefined;
        const byName = existingByName.get(info.name);
        const existing = byMeta || byName;
        if (existing) existingMap.set(key, existing);
      }

      const newKeys = [...adInfoMap.keys()].filter((k) => !existingMap.has(k));

      // 4. Resolve a single canonical creative per imported name
      const importedCreativeNames = [...new Set([...adInfoMap.values()].map((ad) => ad.name))];
      const importedCreativeMetaByName = new Map<string, {
        assetUrl?: string;
        videoUrl?: string;
        format?: "static" | "video" | "ugc" | "carousel";
      }>();
      for (const row of input.rows) {
        if (!row.assetUrl && !row.videoUrl && !row.format) continue;
        const existing = importedCreativeMetaByName.get(row.name);
        importedCreativeMetaByName.set(row.name, {
          assetUrl: existing?.assetUrl ?? row.assetUrl,
          videoUrl: existing?.videoUrl ?? row.videoUrl,
          format: existing?.format ?? row.format,
        });
      }
      const creativeIdByName = new Map<string, string>();
      const createdCreatives: { id: string; name: string }[] = [];

      if (importedCreativeNames.length > 0) {
        const existingCreativeRows = await db
          .select({
            id: adCreatives.id,
            name: adCreatives.name,
            createdAt: adCreatives.createdAt,
            linkedAds: sql<number>`count(${ads.id})`.as("linked_ads"),
          })
          .from(adCreatives)
          .leftJoin(ads, eq(ads.adCreativeId, adCreatives.id))
          .where(and(
            sql`${adCreatives.name} IN (${sql.join(importedCreativeNames.map((name) => sql`${name}`), sql`, `)})`,
            eq(adCreatives.organizationId, ctx.organizationId),
          ))
          .groupBy(adCreatives.id, adCreatives.name, adCreatives.createdAt)
          .orderBy(adCreatives.name, desc(sql<number>`count(${ads.id})`), adCreatives.createdAt);

        for (const row of existingCreativeRows) {
          if (!creativeIdByName.has(row.name)) {
            creativeIdByName.set(row.name, row.id);
          }
        }
      }

      const creativeNamesToCreate = importedCreativeNames.filter((name) => !creativeIdByName.has(name));
      if (creativeNamesToCreate.length > 0) {
        for (let i = 0; i < creativeNamesToCreate.length; i += 500) {
          const batch = creativeNamesToCreate.slice(i, i + 500);
          const inserted = await db.insert(adCreatives).values(
            batch.map((name) => ({
              name,
              organizationId: ctx.organizationId,
              assetUrl: importedCreativeMetaByName.get(name)?.assetUrl,
              videoUrl: importedCreativeMetaByName.get(name)?.videoUrl,
              format: importedCreativeMetaByName.get(name)?.format,
            })),
          ).returning({ id: adCreatives.id, name: adCreatives.name });
          for (const creative of inserted) {
            creativeIdByName.set(creative.name, creative.id);
            createdCreatives.push(creative);
          }
        }
      }

      for (const [name, creativeId] of creativeIdByName) {
        const meta = importedCreativeMetaByName.get(name);
        if (!meta?.assetUrl && !meta?.videoUrl && !meta?.format) continue;

        await db.update(adCreatives).set({
          ...(meta.assetUrl ? { assetUrl: meta.assetUrl } : {}),
          ...(meta.videoUrl ? { videoUrl: meta.videoUrl } : {}),
          ...(meta.format ? { format: meta.format } : {}),
        }).where(
          and(
            eq(adCreatives.id, creativeId),
            eq(adCreatives.organizationId, ctx.organizationId),
            sql`(${adCreatives.assetUrl} IS NULL OR ${adCreatives.videoUrl} IS NULL OR ${adCreatives.format} IS NULL)`,
          ),
        );
      }

      // 5. Batch create new ads
      if (newKeys.length > 0) {
        const newAdsValues = newKeys.map((key) => {
          const info = adInfoMap.get(key)!;
          return {
            name: info.name,
            adSetId: info.adSetDbId,
            adCreativeId: creativeIdByName.get(info.name),
            status: normalizeStatus(info.delivery),
            metaId: info.metaAdId,
            accountId: input.accountId,
            organizationId: ctx.organizationId,
          };
        });

        for (let i = 0; i < newAdsValues.length; i += 500) {
          const batch = newAdsValues.slice(i, i + 500);
          await db.insert(ads).values(batch).returning();
        }
      }

      // 6. Update existing ads (name, status, metaId, accountId, adSetId, creative)
      for (const [key, existing] of existingMap) {
        const info = adInfoMap.get(key)!;
        await db.update(ads).set({
          name: info.name,
          status: normalizeStatus(info.delivery),
          ...(creativeIdByName.get(info.name) ? { adCreativeId: creativeIdByName.get(info.name) } : {}),
          ...(info.adSetDbId ? { adSetId: info.adSetDbId } : {}),
          ...(info.metaAdId ? { metaId: info.metaAdId } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
        }).where(
          and(eq(ads.id, existing.id), eq(ads.organizationId, ctx.organizationId)),
        );
      }

      if (importedCreativeNames.length > 0) {
        const canonicalCreativeIds = [...new Set([...creativeIdByName.values()])];
        const orphanDuplicateCreatives = await db
          .select({ id: adCreatives.id })
          .from(adCreatives)
          .leftJoin(ads, eq(ads.adCreativeId, adCreatives.id))
          .where(
            and(
              sql`${adCreatives.name} IN (${sql.join(importedCreativeNames.map((name) => sql`${name}`), sql`, `)})`,
              sql`${adCreatives.id} NOT IN (${sql.join(canonicalCreativeIds.map((id) => sql`${id}`), sql`, `)})`,
              eq(adCreatives.organizationId, ctx.organizationId),
            ),
          )
          .groupBy(adCreatives.id)
          .having(sql`count(${ads.id}) = 0`);

        if (orphanDuplicateCreatives.length > 0) {
          await db.delete(adCreatives).where(
            sql`${adCreatives.id} IN (${sql.join(orphanDuplicateCreatives.map((creative) => sql`${creative.id}`), sql`, `)})`,
          );
        }
      }

      // 7. Re-fetch all ads to build name→id map (use current names after updates)
      const allAdNames = [...adInfoMap.values()].map((a) => a.name);
      const allAds = allAdNames.length > 0
        ? await db
            .select({ id: ads.id, name: ads.name, metaId: ads.metaId })
            .from(ads)
            .where(
              and(
                sql`${ads.name} IN (${sql.join(allAdNames.map((n) => sql`${n}`), sql`, `)})`,
                eq(ads.organizationId, ctx.organizationId),
              ),
            )
        : [];
      const adIdByName = new Map(allAds.map((a) => [a.name, a.id]));
      const adIdByMetaId = new Map(allAds.filter((a) => a.metaId).map((a) => [a.metaId!, a.id]));

      // 8. Replace only the exact imported breakdown rows, then bulk insert
      const perfRows: (typeof performanceLogs.$inferInsert)[] = [];

      for (const row of input.rows) {
        const adId = (row.adId && adIdByMetaId.get(row.adId)) || adIdByName.get(row.name);
        if (!adId) continue;

        const {
          name: _name,
          delivery: _delivery,
          adId: _adId,
          campaignName: _campaignName,
          campaignId: _campaignId,
          adSetName: _adSetName,
          adSetId: _adSetId,
          ...perfData
        } = row;
        void _name;
        void _delivery;
        void _adId;
        void _campaignName;
        void _campaignId;
        void _adSetName;
        void _adSetId;
        const hasPerf = perfData.spend || perfData.roas || perfData.conversions || perfData.linkClicks || perfData.impressions;
        if (!hasPerf) continue;

        // Compute conversionRate from conversions / linkClicks if not provided
        const { conversionRate: initialConversionRate, ...perfPayload } = perfData;
        let conversionRate = initialConversionRate;
        if (!conversionRate && perfPayload.conversions && perfPayload.linkClicks && perfPayload.linkClicks > 0) {
          conversionRate = ((perfPayload.conversions / perfPayload.linkClicks) * 100).toFixed(2);
        }

        perfRows.push({
          ...perfPayload,
          conversionRate,
          adId,
          organizationId: ctx.organizationId,
        });
      }

      if (perfRows.length > 0) {
        const importAdIds = [...new Set(perfRows.map((r) => r.adId))];
        const dateStarts = perfRows.map((r) => r.dateStart).filter(Boolean) as string[];
        const dateEnds = perfRows.map((r) => r.dateEnd).filter(Boolean) as string[];
        const minDate = dateStarts.sort()[0];
        const maxDate = dateEnds.sort().reverse()[0];

        if (importAdIds.length > 0 && minDate && maxDate) {
          const existingPerfRows = await db
            .select({
              id: performanceLogs.id,
              adId: performanceLogs.adId,
              dateStart: performanceLogs.dateStart,
              dateEnd: performanceLogs.dateEnd,
              country: performanceLogs.country,
              platform: performanceLogs.platform,
              placement: performanceLogs.placement,
              device: performanceLogs.device,
              age: performanceLogs.age,
              gender: performanceLogs.gender,
            })
            .from(performanceLogs)
            .where(
              and(
                sql`${performanceLogs.adId} IN (${sql.join(importAdIds.map((id) => sql`${id}`), sql`, `)})`,
                sql`${performanceLogs.dateStart} >= ${minDate}`,
                sql`${performanceLogs.dateEnd} <= ${maxDate}`,
                eq(performanceLogs.organizationId, ctx.organizationId),
              ),
            );

          const importedPerfKeys = new Set(perfRows.map((row) => buildPerfRowKey({
            adId: row.adId,
            dateStart: row.dateStart,
            dateEnd: row.dateEnd,
            country: row.country,
            platform: row.platform,
            placement: row.placement,
            device: row.device,
            age: row.age,
            gender: row.gender,
          })));

          const idsToDelete = existingPerfRows
            .filter((row) => importedPerfKeys.has(buildPerfRowKey(row)))
            .map((row) => row.id);

          for (let i = 0; i < idsToDelete.length; i += 1000) {
            const batch = idsToDelete.slice(i, i + 1000);
            await db.delete(performanceLogs).where(
              sql`${performanceLogs.id} IN (${sql.join(batch.map((id) => sql`${id}`), sql`, `)})`,
            );
          }
        }

        for (let i = 0; i < perfRows.length; i += 1000) {
          const batch = perfRows.slice(i, i + 1000);
          await db.insert(performanceLogs).values(batch);
        }
      }

      // Build results
      const results = newKeys.map((key) => {
        const info = adInfoMap.get(key)!;
        const adId = (info.metaAdId && adIdByMetaId.get(info.metaAdId)) || adIdByName.get(info.name) || key;
        return { id: adId, name: info.name };
      });

      // Stamp account with import timestamp and latest data date
      if (input.accountId) {
        const dateEnds = perfRows.map((r) => r.dateEnd).filter(Boolean) as string[];
        const maxDataDate = dateEnds.sort().reverse()[0] ?? null;
        const [account] = await db
          .select({ dataDateEnd: adAccounts.dataDateEnd })
          .from(adAccounts)
          .where(
            and(
              eq(adAccounts.id, input.accountId),
              eq(adAccounts.organizationId, ctx.organizationId),
            ),
          );
        const nextDataDateEnd = account?.dataDateEnd && maxDataDate
          ? (account.dataDateEnd > maxDataDate ? account.dataDateEnd : maxDataDate)
          : account?.dataDateEnd ?? maxDataDate;

        await db.update(adAccounts).set({
          lastImportedAt: new Date(),
          ...(nextDataDateEnd ? { dataDateEnd: nextDataDateEnd } : {}),
        }).where(
          and(
            eq(adAccounts.id, input.accountId),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        );
      }

      return {
        created: results,
        totalRows: input.rows.length,
        uniqueAds: adInfoMap.size,
        perfLogs: perfRows.length,
      };
    }),

  getPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getPerformance"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      // Creative-level aggregated metrics
      const [creative] = await db
        .select({
          totalSpend: sql<string | null>`sum(${performanceLogs.spend})`,
          avgRoas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
          avgCpa: sql<string | null>`coalesce(sum(${performanceLogs.spend}), 0) / nullif(sum(${performanceLogs.conversions}), 0)`,
          avgCtr: sql<string | null>`coalesce(sum(${performanceLogs.ctr} * ${performanceLogs.impressions}), 0) / nullif(sum(${performanceLogs.impressions}), 0)`,
          totalConversions: sql<number | null>`sum(${performanceLogs.conversions})`,
          totalImpressions: sql<number | null>`sum(${performanceLogs.impressions})`,
          totalClicks: sql<number | null>`sum(${performanceLogs.linkClicks})`,
          logCount: sql<number>`count(*)`,
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`,
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(
          and(
            eq(ads.adCreativeId, input.id),
            eq(ads.organizationId, ctx.organizationId),
          ),
        );

      // Portfolio averages for comparison
      const [portfolio] = await db
        .select({
          avgRoas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
          avgCpa: sql<string | null>`coalesce(sum(${performanceLogs.spend}), 0) / nullif(sum(${performanceLogs.conversions}), 0)`,
          avgCtr: sql<string | null>`coalesce(sum(${performanceLogs.ctr} * ${performanceLogs.impressions}), 0) / nullif(sum(${performanceLogs.impressions}), 0)`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(eq(ads.organizationId, ctx.organizationId));

      // Derive live status from linked ads
      const adStatuses = await db
        .select({ status: ads.status })
        .from(ads)
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
        logCount: creative?.logCount ?? 0,
        minDate: creative?.minDate ?? null,
        maxDate: creative?.maxDate ?? null,
        portfolioAvgRoas: portfolio?.avgRoas ?? null,
        portfolioAvgCpa: portfolio?.avgCpa ?? null,
        portfolioAvgCtr: portfolio?.avgCtr ?? null,
        liveStatus,
      };
    }),

  delete: orgProcedure
    .meta(openApiMutationMeta("adCreative", "delete"))
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
