/**
 * The Creative insights screen's reads (spec §9). Everything is org-scoped
 * through the connected store, and every money figure crosses the wire as a
 * decimal string — the same contract the attribution router keeps.
 */

import { z } from "zod";
import {
  COVERAGE_WINDOW_DAYS,
  INSIGHT_MIN_SPEND,
  SLICE_DIMENSIONS,
  TAGGED_SPEND_MIN_SHARE,
  getCoverage,
  getDrillIn,
  getSlices,
  getTaggingQueue,
  pickInsightCards,
} from "@/lib/creative-insights-queries";
import { centsToAmount } from "@/lib/money";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import { orgProcedure, router } from "../init";
import {
  dateRangeSchema,
  dateRangeShape,
  orderedRange,
  requireStore,
} from "./attribution.shared";

const dimensionSchema = z.enum(SLICE_DIMENSIONS);

const sliceInputSchema = z
  .object({ ...dateRangeShape, dimension: dimensionSchema })
  .refine(orderedRange.check, orderedRange.message);

const drillInInputSchema = z
  .object({
    ...dateRangeShape,
    dimension: dimensionSchema,
    value: z.string().min(1),
  })
  .refine(orderedRange.check, orderedRange.message);

function sliceOutput(rows: Awaited<ReturnType<typeof getSlices>>) {
  return rows.map((row) => ({
    key: row.key,
    revenue: centsToAmount(row.revenueCents),
    orderCount: row.orderCount,
    spend: row.spendCents === null ? null : centsToAmount(row.spendCents),
    backPer1: row.backPer1,
  }));
}

/** Coverage and the queue both read the last complete trailing window. */
async function storeToday(organizationId: string) {
  const store = await requireStore(organizationId);
  return { store, today: deriveDayInTimezone(new Date(), store.ianaTimezone) };
}

export const creativeInsightsRouter = router({
  /**
   * Revenue and spend by the dimension of the order's ad. Two rows are always
   * present — `no_tags_yet` and `unmatched_ad` — so the list still sums to the
   * Meta bucket's total for the same days.
   */
  slices: orgProcedure
    .input(sliceInputSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);
      const rows = await getSlices(
        {
          organizationId: ctx.organizationId,
          storeId: store.id,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        },
        input.dimension,
      );

      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        dimension: input.dimension,
        rows: sliceOutput(rows),
      };
    }),

  /**
   * The gate (§6.4) and the store facts the screen's ranges are measured from.
   * Called first: it needs no range of its own, and it answers what "today" is
   * where the store lives.
   */
  coverage: orgProcedure.query(async ({ ctx }) => {
    const { store, today } = await storeToday(ctx.organizationId);
    const coverage = await getCoverage({
      organizationId: ctx.organizationId,
      day: today,
    });

    return {
      store: {
        id: store.id,
        shopDomain: store.shopDomain,
        ianaTimezone: store.ianaTimezone,
        currency: store.currency,
        todayInStoreTz: today,
      },
      windowDays: COVERAGE_WINDOW_DAYS,
      minShare: TAGGED_SPEND_MIN_SHARE,
      totalActiveSpend: centsToAmount(coverage.totalActiveSpendCents),
      taggedSpend: centsToAmount(coverage.taggedSpendCents),
      untaggedSpend: centsToAmount(coverage.untaggedSpendCents),
      // Null when nothing was spent — a share of nothing is not zero.
      share: coverage.share,
      gated: coverage.gated,
      activeAdCount: coverage.activeAdCount,
      untaggedAdCount: coverage.untaggedAdCount,
      topUntaggedAds: coverage.topUntaggedAds.map((ad) => ({
        adId: ad.adId,
        adName: ad.adName,
        creativeId: ad.creativeId,
        spend: centsToAmount(ad.spendCents),
        missing: ad.missing,
      })),
    };
  }),

  drillIn: orgProcedure
    .input(drillInInputSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);
      const rows = await getDrillIn(
        {
          organizationId: ctx.organizationId,
          storeId: store.id,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        },
        { dimension: input.dimension, value: input.value },
      );

      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        dimension: input.dimension,
        value: input.value,
        ads: rows.map((row) => ({
          adId: row.adId,
          adName: row.adName,
          spend: centsToAmount(row.spendCents),
          revenue: centsToAmount(row.revenueCents),
          backPer1: row.backPer1,
          clicks: row.clicks,
          landingPageViews: row.landingPageViews,
          addToCart: row.addToCart,
        })),
      };
    }),

  /**
   * The claims on top of the screen, decided server-side so the copy has only
   * to render them. The coverage share rides along: below the line the client
   * prepends the alarm card instead of leading with a claim.
   */
  insightCards: orgProcedure
    .input(dateRangeSchema)
    .query(async ({ input, ctx }) => {
      const { store, today } = await storeToday(ctx.organizationId);
      const scope = {
        organizationId: ctx.organizationId,
        storeId: store.id,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      };

      const [angle, awareness, coverage] = await Promise.all([
        getSlices(scope, "angle"),
        getSlices(scope, "awareness"),
        getCoverage({ organizationId: ctx.organizationId, day: today }),
      ]);

      const cards = pickInsightCards({ slices: { angle, awareness } });

      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        minSpend: INSIGHT_MIN_SPEND,
        coverageShare: coverage.share,
        gated: coverage.gated,
        cards: cards.map((card) => ({
          dimension: card.dimension,
          value: card.value,
          backPer1: card.backPer1,
          spend: centsToAmount(card.spendCents),
          revenue: centsToAmount(card.revenueCents),
          runnerUp: card.runnerUp,
          bars: card.bars,
        })),
      };
    }),

  /** Untagged active ads, biggest spender first — the ordering is the queue. */
  taggingQueue: orgProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const { today } = await storeToday(ctx.organizationId);
      const rows = await getTaggingQueue({
        organizationId: ctx.organizationId,
        day: today,
        limit: input?.limit,
      });

      return {
        windowDays: COVERAGE_WINDOW_DAYS,
        ads: rows.map((row) => ({
          adId: row.adId,
          adName: row.adName,
          creativeId: row.creativeId,
          adSetName: row.adSetName,
          campaignName: row.campaignName,
          spend: centsToAmount(row.spendCents),
          missing: row.missing,
        })),
      };
    }),
});
