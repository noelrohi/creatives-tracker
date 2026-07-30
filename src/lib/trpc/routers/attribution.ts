import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ATTRIBUTION_BUCKETS,
  computeRoas,
  getBucketTotals,
  getDailyBucketSeries,
  getMetaClaims,
  getMetaVerified,
  getRoasTarget,
  getStoreForOrg,
  getSyncHealth,
  listBucketOrders,
} from "@/lib/attribution-queries";
import { centsToAmount, deriveDayInTimezone } from "@/lib/shopify-ingest";
import { orgProcedure, router } from "../init";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dateRangeShape = {
  dateFrom: z.string().regex(DAY_PATTERN, "Expected YYYY-MM-DD"),
  dateTo: z.string().regex(DAY_PATTERN, "Expected YYYY-MM-DD"),
};

const orderedRange = {
  check: (value: { dateFrom: string; dateTo: string }) =>
    value.dateFrom <= value.dateTo,
  message: {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  },
};

const dateRangeSchema = z
  .object(dateRangeShape)
  .refine(orderedRange.check, orderedRange.message);

const bucketSchema = z.enum(ATTRIBUTION_BUCKETS);

/** Money crosses the wire as decimal strings, same as `netSales`. */
const money = centsToAmount;

/**
 * Every read is scoped to the org's single store; `organizationId` always comes
 * from ctx, never from the client.
 */
async function requireStore(organizationId: string) {
  const store = await getStoreForOrg(organizationId);
  if (!store) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No Shopify store is connected for this organization",
    });
  }
  return store;
}

export const attributionRouter = router({
  overview: orgProcedure
    .input(dateRangeSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);

      const [totals, syncHealth] = await Promise.all([
        getBucketTotals({
          organizationId: ctx.organizationId,
          storeId: store.id,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        }),
        getSyncHealth({
          organizationId: ctx.organizationId,
          storeId: store.id,
        }),
      ]);

      return {
        store: {
          id: store.id,
          shopDomain: store.shopDomain,
          ianaTimezone: store.ianaTimezone,
          currency: store.currency,
          todayInStoreTz: deriveDayInTimezone(new Date(), store.ianaTimezone),
        },
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        buckets: totals.buckets.map((bucket) => ({
          bucket: bucket.bucket,
          revenue: money(bucket.revenueCents),
          orderCount: bucket.orderCount,
        })),
        pending: {
          count: totals.pending.count,
          revenue: money(totals.pending.revenueCents),
        },
        total: money(totals.totalCents),
        identity: {
          sumOfBuckets: money(totals.identity.sumOfBucketsCents),
          actual: money(totals.identity.actualCents),
          matches: totals.identity.matches,
        },
        syncHealth,
      };
    }),

  metaCheck: orgProcedure
    .input(dateRangeSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);

      const [claims, verified, roasTarget] = await Promise.all([
        getMetaClaims({
          organizationId: ctx.organizationId,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        }),
        getMetaVerified({
          organizationId: ctx.organizationId,
          storeId: store.id,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        }),
        getRoasTarget(ctx.organizationId),
      ]);

      const verifiedRoas = computeRoas(
        verified.verifiedRevenueCents,
        claims.spendCents,
      );

      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        claims: {
          claimed: money(claims.claimedCents),
          claimed7dClick:
            claims.claimed7dClickCents === null
              ? null
              : money(claims.claimed7dClickCents),
          claimed1dView:
            claims.claimed1dViewCents === null
              ? null
              : money(claims.claimed1dViewCents),
          labeledRowShare: claims.labeledRowShare,
        },
        spend: money(claims.spendCents),
        verifiedRevenue: money(verified.verifiedRevenueCents),
        verifiedOrderCount: verified.verifiedOrderCount,
        verificationPendingCount: verified.verificationPendingCount,
        // Null when there is no spend — "can't compute", not zero.
        verifiedRoas,
        roasTarget,
      };
    }),

  dailySeries: orgProcedure
    .input(dateRangeSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);

      const series = await getDailyBucketSeries({
        organizationId: ctx.organizationId,
        storeId: store.id,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      });

      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        days: series.map((point) => ({
          day: point.day,
          buckets: Object.fromEntries(
            ATTRIBUTION_BUCKETS.map((bucket) => [
              bucket,
              money(point.buckets[bucket]),
            ]),
          ) as Record<(typeof ATTRIBUTION_BUCKETS)[number], string>,
          pendingNet: money(point.pendingNetCents),
          totalNet: money(point.totalNetCents),
        })),
      };
    }),

  bucketOrders: orgProcedure
    .input(
      z
        .object({
          ...dateRangeShape,
          bucket: bucketSchema,
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().nullable().optional(),
        })
        .refine(orderedRange.check, orderedRange.message),
    )
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);

      const { orders, nextCursor } = await listBucketOrders({
        organizationId: ctx.organizationId,
        storeId: store.id,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        bucket: input.bucket,
        limit: input.limit,
        cursor: input.cursor ?? null,
      });

      return { orders, nextCursor };
    }),
});
