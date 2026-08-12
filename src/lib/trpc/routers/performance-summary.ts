import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, orgProcedure } from "../init";
import { db } from "@/db";
import { performanceMonthlySummaries } from "@/schema/performance-monthly-summary";

const monthlyOverviewRowSchema = z.object({
  month: z.string(),
  spend: z.string().nullable(),
  purchaseValue: z.string().nullable(),
  purchaseValue7dClick: z.string().nullable(),
  purchaseValue1dView: z.string().nullable(),
  conversions: z.number().int().nullable(),
  impressions: z.number().int().nullable(),
  linkClicks: z.number().int().nullable(),
  clicksAll: z.number().int().nullable(),
  landingPageViews: z.number().int().nullable(),
  addToCart: z.number().int().nullable(),
  initiateCheckout: z.number().int().nullable(),
  videoViews3s: z.number().int().nullable(),
  videoThruplay: z.number().int().nullable(),
  daysWithData: z.number().int(),
  sourceRowCount: z.number().int(),
  roas: z.number().nullable(),
  cpa: z.number().nullable(),
  ctr: z.number().nullable(),
});

/** Null unless both sides are present and the denominator is non-zero. */
function ratio(
  numerator: string | number | null,
  denominator: string | number | null,
) {
  if (numerator === null || denominator === null) return null;
  const bottom = Number(denominator);
  if (!Number.isFinite(bottom) || bottom === 0) return null;
  const top = Number(numerator);
  return Number.isFinite(top) ? top / bottom : null;
}

export const performanceSummaryRouter = router({
  // The long-term monthly trend read path: it keeps working after retention
  // deletes base rows older than 180 days.
  monthlyOverview: orgProcedure
    // No openapi meta: the OpenAPI path inventory is a pinned contract.
    .input(
      z
        .object({ months: z.number().int().min(1).max(60).default(24) })
        .default({ months: 24 }),
    )
    .output(z.array(monthlyOverviewRowSchema))
    .query(async ({ ctx, input }) => {
      const rows = await db
        .select()
        .from(performanceMonthlySummaries)
        .where(eq(performanceMonthlySummaries.organizationId, ctx.organizationId))
        .orderBy(desc(performanceMonthlySummaries.month))
        .limit(input.months);

      return rows.map((row) => ({
        month: row.month,
        spend: row.spend,
        purchaseValue: row.purchaseValue,
        purchaseValue7dClick: row.purchaseValue7dClick,
        purchaseValue1dView: row.purchaseValue1dView,
        conversions: row.conversions,
        impressions: row.impressions,
        linkClicks: row.linkClicks,
        clicksAll: row.clicksAll,
        landingPageViews: row.landingPageViews,
        addToCart: row.addToCart,
        initiateCheckout: row.initiateCheckout,
        videoViews3s: row.videoViews3s,
        videoThruplay: row.videoThruplay,
        daysWithData: row.daysWithData,
        sourceRowCount: row.sourceRowCount,
        roas: ratio(row.purchaseValue, row.spend),
        cpa: ratio(row.spend, row.conversions),
        ctr: ratio(row.linkClicks, row.impressions),
      }));
    }),
});
