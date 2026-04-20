import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, ne, or, isNull, desc, ilike, and, inArray, sql, type SQL } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";
import { adAccounts } from "@/schema/account";
import { fetchMetaCreativePreview, fetchMetaAdPreviewUrl } from "@/lib/meta-creative-assets";
import { importMetaRows } from "@/lib/meta-import";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { computeCreativeHealthByCreativeId } from "@/lib/creative-health-rollup";
import { fetchAgentExportRows } from "@/lib/ad-export";

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
          ownership: z.enum(["ours", "theirs"]).optional(),
          teamId: z.string().optional(),
          untaggedOnly: z.boolean().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
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
        conditions.push(sql`EXISTS (SELECT 1 FROM ad WHERE ad.ad_creative_id = "ad_creative"."id" AND ad.account_id = ${input.accountId})`);
      }
      if (input?.adSetIds?.length) {
        const placeholders = input.adSetIds.map((id) => sql`${id}`);
        const inList = sql.join(placeholders, sql`, `);
        conditions.push(sql`EXISTS (SELECT 1 FROM ad WHERE ad.ad_creative_id = "ad_creative"."id" AND ad.ad_set_id IN (${inList}))`);
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
      if (input?.untaggedOnly) {
        conditions.push(sql`(${adCreatives.format} IS NULL AND ${adCreatives.angle} IS NULL AND ${adCreatives.awarenessLevel} IS NULL)`);
      }

      const { from, to } = input ?? {};
      const win = from && to
        ? sql`AND pl.date_start <= ${to}::date AND pl.date_end >= ${from}::date`
        : sql``;
      const win2 = from && to
        ? sql`AND pl2.date_start <= ${to}::date AND pl2.date_end >= ${from}::date`
        : sql``;
      const dateFilterForRollup = from && to
        ? sql`pl.date_start <= ${to}::date AND pl.date_end >= ${from}::date`
        : undefined;

      const rows = await db
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
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
          ownership: adCreatives.ownership,
          teamId: adCreatives.teamId,
          notes: adCreatives.notes,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
          totalSpend: sql<string | null>`(
            SELECT sum(pl.spend) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("total_spend"),
          avgRoas: sql<string | null>`(
            SELECT coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("avg_roas"),
          totalConversions: sql<number | null>`(
            SELECT sum(pl.conversions) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("total_conversions"),
          adStatus: sql<string | null>`(
            SELECT ad.status FROM ad
            WHERE ad.ad_creative_id = "ad_creative"."id"
            LIMIT 1
          )`.as("ad_status"),
          metaAdId: sql<string | null>`(
            SELECT ad.meta_id FROM ad
            WHERE ad.ad_creative_id = "ad_creative"."id"
            LIMIT 1
          )`.as("meta_ad_id"),
          avgCpa: sql<string | null>`(
            SELECT coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("avg_cpa"),
          avgCtr: sql<string | null>`(
            SELECT avg(pl.ctr)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("avg_ctr"),
          metaCampaignId: sql<string | null>`(
            SELECT c.meta_id FROM ad
            JOIN ad_set ast ON ast.id = ad.ad_set_id
            JOIN campaign c ON c.id = ast.campaign_id
            WHERE ad.ad_creative_id = "ad_creative"."id"
            LIMIT 1
          )`.as("meta_campaign_id"),
          metaAdSetId: sql<string | null>`(
            SELECT ast.meta_id FROM ad
            JOIN ad_set ast ON ast.id = ad.ad_set_id
            WHERE ad.ad_creative_id = "ad_creative"."id"
            LIMIT 1
          )`.as("meta_ad_set_id"),
          accountName: sql<string | null>`(
            SELECT acc.name FROM ad
            JOIN ad_account acc ON acc.id = ad.account_id
            WHERE ad.ad_creative_id = "ad_creative"."id"
            LIMIT 1
          )`.as("account_name"),
          // Trend metrics for health computation
          recentCtr: sql<string | null>`(
            SELECT coalesce(sum(pl.ctr * pl.impressions), 0) / nullif(sum(pl.impressions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
              AND pl.date_start > (
                SELECT max(pl2.date_end) - 3
                FROM performance_log pl2 JOIN ad a2 ON a2.id = pl2.ad_id
                WHERE a2.ad_creative_id = "ad_creative"."id" ${win2}
              )
          )`.as("recent_ctr"),
          recentCpc: sql<string | null>`(
            SELECT avg(pl.cpc)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
              AND pl.date_start > (
                SELECT max(pl2.date_end) - 3
                FROM performance_log pl2 JOIN ad a2 ON a2.id = pl2.ad_id
                WHERE a2.ad_creative_id = "ad_creative"."id" ${win2}
              )
          )`.as("recent_cpc"),
          avgCpc: sql<string | null>`(
            SELECT avg(pl.cpc)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("avg_cpc"),
          avgFrequency: sql<string | null>`(
            SELECT avg(pl.frequency)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("avg_frequency"),
          recentHookRate: sql<string | null>`(
            SELECT sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
              AND pl.date_start > (
                SELECT max(pl2.date_end) - 3
                FROM performance_log pl2 JOIN ad a2 ON a2.id = pl2.ad_id
                WHERE a2.ad_creative_id = "ad_creative"."id" ${win2}
              )
          )`.as("recent_hook_rate"),
          priorHookRate: sql<string | null>`(
            SELECT sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
              AND pl.date_end <= (
                SELECT max(pl2.date_end) - 3
                FROM performance_log pl2 JOIN ad a2 ON a2.id = pl2.ad_id
                WHERE a2.ad_creative_id = "ad_creative"."id" ${win2}
              )
          )`.as("prior_hook_rate"),
          recentCpa: sql<string | null>`(
            SELECT coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
              AND pl.date_start > (
                SELECT max(pl2.date_end) - 3
                FROM performance_log pl2 JOIN ad a2 ON a2.id = pl2.ad_id
                WHERE a2.ad_creative_id = "ad_creative"."id" ${win2}
              )
          )`.as("recent_cpa"),
          thumbstopRatio: sql<string | null>`(
            SELECT sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0)
            FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
          )`.as("thumbstop_ratio"),
        })
        .from(adCreatives)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(adCreatives.createdAt));

      const healthByCreative = await computeCreativeHealthByCreativeId({
        organizationId: ctx.organizationId,
        creativeIds: rows.map((r) => r.id),
        dateFilter: dateFilterForRollup,
      });

      return rows.map((r) => {
        const rollup = healthByCreative.get(r.id);
        return {
          ...r,
          health: rollup?.health ?? null,
          healthReasons: rollup?.reasons ?? [],
        };
      });
    }),

  exportAgentRows: orgProcedure
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        accountId: z.string().optional(),
        adSetIds: z.array(z.string()).optional(),
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
        eq(ads.status, "active"),
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
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .where(and(...conditions))
        .orderBy(desc(performanceLogs.dateStart), ads.name);
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
          ownership: z.enum(["ours", "theirs"]).optional(),
          teamId: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
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
      const basePl = basePerformanceLogFilter("pl");
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
        JOIN ad_creative ac ON ac.id = ad.ad_creative_id
        WHERE ${dateFilter} AND ${basePl} AND ad.organization_id = ${ctx.organizationId} ${accountFilter} ${campaignFilter} ${adSetFilter} ${statusFilter} ${ownershipFilter} ${teamFilter}
      `);
      const portfolio = (portfolioResult.rows as PortfolioRow[])[0];

      // "Fair shot" floor: an ad needs to have spent ~one portfolio CPA before
      // we can confidently call it dead. Floor at $50 in case portfolio CPA is
      // unusually low (e.g. low-priced product or sparse data).
      const portfolioCpaNum = portfolio?.portfolio_cpa != null ? parseFloat(portfolio.portfolio_cpa) : null;
      const fairShotSpend = Math.max(50, portfolioCpaNum && Number.isFinite(portfolioCpaNum) ? portfolioCpaNum : 50);

      type CreativeRow = {
        id: string;
        name: string;
        format: string | null;
        asset_url: string | null;
        video_url: string | null;
        total_spend: string;
        roas: string;
        cpa: string | null;
        ctr: string | null;
        total_conversions: string;
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
          CASE WHEN bool_or(ad.status = 'active') THEN 'active' ELSE 'paused' END AS ad_status,
          (max(pl.date_end)::date - min(pl.date_start)::date) as running_days
        FROM ad_creative ac
        JOIN ad ON ad.ad_creative_id = ac.id
        JOIN performance_log pl ON pl.ad_id = ad.id
        WHERE ${dateFilter} AND ${basePl} AND ad.organization_id = ${ctx.organizationId} ${accountFilter} ${campaignFilter} ${adSetFilter} ${statusFilter} ${ownershipFilter} ${teamFilter}
        GROUP BY ac.id, ac.name, ac.format, ac.asset_url, ac.video_url
        HAVING sum(pl.spend) >= 50
          AND coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) >= 1
          AND bool_or(ad.status = 'active' AND pl.spend > 0)
        ORDER BY sum(pl.conversions) DESC NULLS LAST, coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) DESC NULLS LAST
        LIMIT 10
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
      const survivingResult = await db.execute(sql`
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
          CASE WHEN bool_or(ad.status = 'active') THEN 'active' ELSE 'paused' END AS ad_status,
          (max(pl.date_end)::date - min(pl.date_start)::date) as running_days
        FROM ad_creative ac
        JOIN ad ON ad.ad_creative_id = ac.id
        JOIN performance_log pl ON pl.ad_id = ad.id
        WHERE ad.organization_id = ${ctx.organizationId}
          AND ${basePl}
          ${accountFilter} ${campaignFilter} ${adSetFilter} ${ownershipFilter} ${teamFilter}
          ${survivingExclude}
        GROUP BY ac.id, ac.name, ac.format, ac.asset_url, ac.video_url
        HAVING sum(pl.spend) >= 50
          AND coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) >= 1
          AND (max(pl.date_end)::date - min(pl.date_start)::date) >= 14
          AND bool_or(ad.status = 'active' AND pl.spend > 0)
        ORDER BY (max(pl.date_end)::date - min(pl.date_start)::date) DESC, coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) DESC NULLS LAST
        LIMIT 10
      `);
      const survivingCreatives = survivingResult.rows as (CreativeRow & { running_days: number })[];

      // Bleeders: per-ad rule, tiered by whether the ad has had a "fair shot."
      // An ad needs both age (running_days >= 5) and spend (>= ~1× portfolio CPA)
      // before we'll call it confidently dead — pausing it earlier means we'd
      // strangle ads that haven't had time for delivery to learn.
      //
      //   tier = pause_now  if spend >= fair-shot AND days >= 5 AND (0 conv OR ROAS < 0.5)
      //   tier = watch      if one threshold met AND (0 conv OR ROAS < 0.5)
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
      const bottomResult = await db.execute(sql`
        WITH ad_lifetime_days AS (
          -- Lifetime running_days, NOT window-bounded. A buyer judges an ad on
          -- its absolute age ("if I gave this 3 weeks, it's done"), not on
          -- how many days it happened to deliver inside the dashboard window.
          -- Also matches what the CSV export uses for disable_tier.
          SELECT
            pl.ad_id,
            (max(pl.date_end)::date - min(pl.date_start)::date) AS running_days
          FROM performance_log pl
          WHERE ${basePl}
          GROUP BY pl.ad_id
        ),
        ad_window AS (
          SELECT
            ad.id AS ad_id,
            ad.meta_id AS meta_ad_id,
            ad.ad_creative_id,
            ad.status::text AS status,
            sum(pl.spend) AS spend,
            sum(pl.purchase_value) AS revenue,
            sum(pl.conversions) AS conversions,
            coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0) AS roas,
            coalesce(ald.running_days, 0) AS running_days
          FROM ad
          JOIN performance_log pl ON pl.ad_id = ad.id
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          LEFT JOIN ad_lifetime_days ald ON ald.ad_id = ad.id
          WHERE ${dateFilter}
            AND ${basePl}
            AND ad.organization_id = ${ctx.organizationId}
            ${accountFilter} ${campaignFilter} ${adSetFilter} ${ownershipFilter} ${teamFilter}
          GROUP BY ad.id, ad.meta_id, ad.ad_creative_id, ad.status, ald.running_days
        ),
        bleeder AS (
          SELECT
            *,
            CASE
              WHEN spend >= ${fairShotSpend} AND running_days >= 5 THEN 'pause_now'
              WHEN spend >= ${fairShotSpend} OR running_days >= 7 THEN 'watch'
              ELSE 'cooking'
            END AS tier
          FROM ad_window
          WHERE status = 'active'
            AND (
              coalesce(conversions, 0) = 0
              OR (roas IS NOT NULL AND roas < 0.5)
            )
            AND spend >= 25
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
        LIMIT 10
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
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        accountId: z.string().optional(),
        ownership: z.enum(["ours", "theirs"]).optional(),
        teamId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
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

      const rows = await db.execute(sql`
        SELECT
          pl.date_start,
          pl.date_end,
          c.name   AS campaign_name,
          ast.name AS ad_set_name,
          ad.name  AS ad_name,
          ad.status AS ad_status,
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
          ${accountFilter} ${ownershipFilter} ${teamFilter}
        ORDER BY pl.date_start DESC, ad.name
      `);

      return rows.rows as Record<string, unknown>[];
    }),

  getDailyPortfolioPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getDailyPortfolioPerformance"))
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
        ownership: z.enum(["ours", "theirs"]).optional(),
        teamId: z.string().optional(),
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
        conversions: number | null;
        impressions: number | null;
        reach: number | null;
        cpm: string | null;
        link_clicks: number | null;
      };

      const result = await db.execute(sql`
        WITH days AS (
          SELECT generate_series(${fromStr}::date, ${toStr}::date, '1 day'::interval)::date AS day
        ),
        daily AS (
          SELECT
            d.day,
            sum(pl.spend / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS spend,
            sum(pl.purchase_value / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS purchase_value,
            sum(pl.conversions::numeric / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS conversions,
            sum(pl.impressions::numeric / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS impressions,
            sum(pl.reach::numeric / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS reach,
            sum(pl.ctr * pl.impressions / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS ctr_weighted,
            sum(pl.link_clicks::numeric / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS link_clicks
          FROM days d
          JOIN performance_log pl ON d.day BETWEEN pl.date_start AND pl.date_end
          JOIN ad ON ad.id = pl.ad_id
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          WHERE ad.organization_id = ${ctx.organizationId}
            AND ${basePl}
            ${accountFilter} ${ownershipFilter} ${teamFilter}
          GROUP BY d.day
        )
        SELECT
          d.day::text as date_start,
          d.day::text as date_end,
          COALESCE(daily.spend, 0)::text as spend,
          COALESCE(daily.purchase_value, 0)::text as purchase_value,
          (COALESCE(daily.purchase_value, 0) / nullif(daily.spend, 0))::text as roas,
          (COALESCE(daily.spend, 0) / nullif(daily.conversions, 0))::text as cpa,
          (COALESCE(daily.ctr_weighted, 0) / nullif(daily.impressions, 0))::text as ctr,
          COALESCE(daily.conversions, 0)::int as conversions,
          COALESCE(daily.impressions, 0)::int as impressions,
          COALESCE(daily.reach, 0)::int as reach,
          (CASE WHEN daily.impressions > 0 THEN (daily.spend / daily.impressions) * 1000 ELSE NULL END)::text as cpm,
          COALESCE(daily.link_clicks, 0)::int as link_clicks
        FROM days d
        LEFT JOIN daily ON daily.day = d.day
        ORDER BY d.day
      `);

      const rows = result.rows as DailyRow[];
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
            d.day,
            sum(pl.spend / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS spend,
            sum(pl.purchase_value / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS revenue
          FROM days d
          JOIN performance_log pl ON d.day BETWEEN pl.date_start AND pl.date_end
          JOIN ad ON ad.id = pl.ad_id
          JOIN ad_creative ac ON ac.id = ad.ad_creative_id
          WHERE ad.organization_id = ${ctx.organizationId}
            AND ${basePl}
            ${teamFilter}
            ${accountFilterAd}
          GROUP BY ad.account_id, d.day
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
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
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
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [linkedMetaAd] = await db
        .select({
          metaAdId: ads.metaId,
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

  create: orgWriteProcedure
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

  update: orgWriteProcedure
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
        ownership: z.enum(["ours", "theirs"]).nullable().optional(),
        teamId: z.string().nullable().optional(),
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
      if (!creative) throw new TRPCError({ code: "NOT_FOUND", message: "Ad creative not found" });
      return creative;
    }),

  duplicate: orgWriteProcedure
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
      };
    }),

  getPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getPerformance"))
    .input(z.object({ id: z.string(), from: z.string().optional(), to: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const dateConditions: SQL[] = [
        eq(ads.adCreativeId, input.id),
        eq(ads.organizationId, ctx.organizationId),
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
          totalConversions: sql<number | null>`sum(${performanceLogs.conversions})`,
          totalImpressions: sql<number | null>`sum(${performanceLogs.impressions})`,
          totalClicks: sql<number | null>`sum(${performanceLogs.linkClicks})`,
          logCount: sql<number>`count(*)`,
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`,
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(and(...dateConditions));

      // Portfolio averages for comparison (same date range)
      const portfolioDateConditions: SQL[] = [
        eq(ads.organizationId, ctx.organizationId),
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

  getDailyPerformance: orgProcedure
    .meta(openApiQueryMeta("adCreative", "getDailyPerformance"))
    .input(z.object({ id: z.string(), from: z.string().optional(), to: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const conditions: SQL[] = [
        eq(ads.adCreativeId, input.id),
        eq(ads.organizationId, ctx.organizationId),
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
          conversions: sql<number | null>`sum(${performanceLogs.conversions})`,
          impressions: sql<number | null>`sum(${performanceLogs.impressions})`,
          reach: sql<number | null>`sum(${performanceLogs.reach})`,
          cpm: sql<string | null>`case when sum(${performanceLogs.impressions}) > 0 then (sum(${performanceLogs.spend}) / sum(${performanceLogs.impressions})) * 1000 else null end`,
          linkClicks: sql<number | null>`sum(${performanceLogs.linkClicks})`,
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
