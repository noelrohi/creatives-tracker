import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { shopifySyncRuns } from "@/schema/shopify";
import {
  ATTRIBUTION_BUCKETS,
  computeRoas,
  getBucketTotals,
  getCampaignLedger,
  getDailyBucketSeries,
  getMetaClaims,
  getMetaVerified,
  getRoasTarget,
  getSyncHealth,
  listBucketOrders,
} from "@/lib/attribution-queries";
// Money crosses the wire as decimal strings, same as the `netSales` column.
import { centsToAmount } from "@/lib/money";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import { orgProcedure, router } from "../init";
import { openApiQueryMeta } from "../openapi-meta";
import {
  dateRangeSchema,
  dateRangeShape,
  orderedRange,
  requireStore,
} from "./attribution.shared";

const bucketSchema = z.enum(ATTRIBUTION_BUCKETS);

export function computeAov(
  revenueCents: number,
  orderCount: number,
): string | null {
  return orderCount === 0
    ? null
    : centsToAmount(Math.round(revenueCents / orderCount));
}

// Output schemas exist for the OpenAPI surface (the generator requires a typed
// response) and must mirror the resolver returns exactly — these procedures
// also serve the web UI, and output parsing strips anything undeclared.
const rangeSchema = z.object({ dateFrom: z.string(), dateTo: z.string() });

const connectorHealthSchema = z.object({
  lastSuccessAt: z.date().nullable(),
  stale: z.boolean(),
});

const syncHealthSchema = z.object({
  shopify: connectorHealthSchema,
  meta: connectorHealthSchema,
});

const overviewOutputSchema = z.object({
  store: z.object({
    id: z.string(),
    shopDomain: z.string(),
    ianaTimezone: z.string(),
    currency: z.string().nullable(),
    todayInStoreTz: z.string(),
  }),
  range: rangeSchema,
  buckets: z.array(
    z.object({
      bucket: bucketSchema,
      revenue: z.string(),
      orderCount: z.number(),
      aov: z.string().nullable(),
    }),
  ),
  pending: z.object({ count: z.number(), revenue: z.string() }),
  total: z.string(),
  aov: z.string().nullable(),
  identity: z.object({
    sumOfBuckets: z.string(),
    actual: z.string(),
    difference: z.string(),
    matches: z.boolean(),
  }),
  syncHealth: syncHealthSchema,
});

const metaCheckOutputSchema = z.object({
  range: rangeSchema,
  claims: z.object({
    claimed: z.string().nullable(),
    claimed7dClick: z.string().nullable(),
    claimed1dView: z.string().nullable(),
    labeledRowShare: z.number(),
  }),
  spend: z.string(),
  verifiedRevenue: z.string(),
  verifiedOrderCount: z.number(),
  verificationPendingCount: z.number(),
  verifiedRoas: z.number().nullable(),
  roasTarget: z.number(),
});

const campaignLedgerOutputSchema = z.object({
  range: rangeSchema,
  campaigns: z.array(
    z.object({
      campaignId: z.string(),
      name: z.string(),
      spend: z.string().nullable(),
      claimed: z.string().nullable(),
      confirmedRevenue: z.string(),
      orderCount: z.number(),
      roas: z.number().nullable(),
    }),
  ),
  unresolved: z
    .object({
      confirmedRevenue: z.string(),
      orderCount: z.number(),
      spend: z.string().nullable(),
      claimed: z.string().nullable(),
    })
    .nullable(),
  roasTarget: z.number(),
});

const dailySeriesOutputSchema = z.object({
  range: rangeSchema,
  days: z.array(
    z.object({
      day: z.string(),
      buckets: z.record(bucketSchema, z.string()),
      pendingNet: z.string(),
      totalNet: z.string(),
    }),
  ),
});

const syncStatusOutputSchema = z.object({
  run: z
    .object({
      phase: z.string(),
      result: z.string().nullable(),
      requestedAt: z.date(),
      finishedAt: z.date().nullable(),
      ordersSynced: z.number().nullable(),
      meta: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
});

export const attributionRouter = router({
  overview: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "overview",
        "Verified revenue overview",
        "Shopify-verified net revenue for a day range, split by attribution bucket (meta, google, klaviyo, …), with the store's timezone/currency, pending-order totals, and connector sync health.",
      ),
    )
    .input(dateRangeSchema)
    .output(overviewOutputSchema)
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

      const verifiedTotals = totals.buckets.reduce(
        (sum, bucket) => ({
          revenueCents: sum.revenueCents + bucket.revenueCents,
          orderCount: sum.orderCount + bucket.orderCount,
        }),
        { revenueCents: 0, orderCount: 0 },
      );

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
          revenue: centsToAmount(bucket.revenueCents),
          orderCount: bucket.orderCount,
          aov: computeAov(bucket.revenueCents, bucket.orderCount),
        })),
        pending: {
          count: totals.pending.count,
          revenue: centsToAmount(totals.pending.revenueCents),
        },
        total: centsToAmount(totals.totalCents),
        aov: computeAov(
          verifiedTotals.revenueCents,
          verifiedTotals.orderCount,
        ),
        identity: {
          sumOfBuckets: centsToAmount(totals.identity.sumOfBucketsCents),
          actual: centsToAmount(totals.identity.actualCents),
          difference: centsToAmount(totals.identity.differenceCents),
          matches: totals.identity.matches,
        },
        syncHealth,
      };
    }),

  metaCheck: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "metaCheck",
        "Meta claimed vs verified revenue",
        "For a day range: Meta ad spend, what Meta claims it drove (null when unlabeled — not $0), Shopify-verified revenue and orders, the verified ROAS, and the org's ROAS target.",
      ),
    )
    .input(dateRangeSchema)
    .output(metaCheckOutputSchema)
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
          // Null, not "0.00": no labeled claim for the range is "no data yet".
          claimed:
            claims.claimedCents === null ? null : centsToAmount(claims.claimedCents),
          claimed7dClick:
            claims.claimed7dClickCents === null
              ? null
              : centsToAmount(claims.claimed7dClickCents),
          claimed1dView:
            claims.claimed1dViewCents === null
              ? null
              : centsToAmount(claims.claimed1dViewCents),
          labeledRowShare: claims.labeledRowShare,
        },
        spend: centsToAmount(claims.spendCents),
        verifiedRevenue: centsToAmount(verified.verifiedRevenueCents),
        verifiedOrderCount: verified.verifiedOrderCount,
        verificationPendingCount: verified.verificationPendingCount,
        // Null when there is no spend — "can't compute", not zero.
        verifiedRoas,
        roasTarget,
      };
    }),

  /**
   * The same range, cut by campaign: what each one spent, what Meta claims for
   * it, and which orders we can actually put behind it. Read-only over data
   * already stamped — it widens nothing.
   */
  campaignLedger: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "campaignLedger",
        "Per-campaign spend and verified revenue",
        "The same day range cut by campaign: spend, Meta's claim, Shopify-confirmed revenue, order count, and ROAS per campaign, plus an unresolved row for spend/orders no campaign could be named for.",
      ),
    )
    .input(dateRangeSchema)
    .output(campaignLedgerOutputSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);

      const [ledger, roasTarget] = await Promise.all([
        getCampaignLedger({
          organizationId: ctx.organizationId,
          storeId: store.id,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        }),
        getRoasTarget(ctx.organizationId),
      ]);

      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        campaigns: ledger.campaigns.map((row) => ({
          campaignId: row.campaignId,
          name: row.name,
          // Null, not "0.00": Meta reported nothing for this campaign at all.
          spend: row.spendCents === null ? null : centsToAmount(row.spendCents),
          claimed:
            row.claimedCents === null ? null : centsToAmount(row.claimedCents),
          confirmedRevenue: centsToAmount(row.confirmedRevenueCents),
          orderCount: row.orderCount,
          // Null when there is no spend — "can't compute", not zero.
          roas: row.roas,
        })),
        unresolved: ledger.unresolved
          ? {
              confirmedRevenue: centsToAmount(
                ledger.unresolved.confirmedRevenueCents,
              ),
              orderCount: ledger.unresolved.orderCount,
              // Null when no spend was orphaned, and a claim stays null unless
              // an orphaned row was labeled.
              spend:
                ledger.unresolved.spendCents === null
                  ? null
                  : centsToAmount(ledger.unresolved.spendCents),
              claimed:
                ledger.unresolved.claimedCents === null
                  ? null
                  : centsToAmount(ledger.unresolved.claimedCents),
            }
          : null,
        roasTarget,
      };
    }),

  dailySeries: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "dailySeries",
        "Daily verified revenue series",
        "Per-day Shopify-verified net revenue for a day range, split by attribution bucket, with pending and total per day.",
      ),
    )
    .input(dateRangeSchema)
    .output(dailySeriesOutputSchema)
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
              centsToAmount(point.buckets[bucket]),
            ]),
          ) as Record<(typeof ATTRIBUTION_BUCKETS)[number], string>,
          pendingNet: centsToAmount(point.pendingNetCents),
          totalNet: centsToAmount(point.totalNetCents),
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

  /**
   * The newest `shopify_sync_run` row for the org's store. The first-load screen
   * polls this while a backfill is in flight, so it reports the run as-is —
   * `result` is "running" until the run finishes.
   */
  syncStatus: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "syncStatus",
        "Latest Shopify sync run",
        "The newest shopify_sync_run for the org's store, as-is — result is \"running\" until the run finishes.",
      ),
    )
    .output(syncStatusOutputSchema)
    .query(async ({ ctx }) => {
    const store = await requireStore(ctx.organizationId);

    const [run] = await db
      .select({
        phase: shopifySyncRuns.phase,
        result: shopifySyncRuns.result,
        requestedAt: shopifySyncRuns.requestedAt,
        finishedAt: shopifySyncRuns.finishedAt,
        ordersSynced: shopifySyncRuns.ordersSynced,
        meta: shopifySyncRuns.meta,
      })
      .from(shopifySyncRuns)
      .where(
        and(
          eq(shopifySyncRuns.organizationId, ctx.organizationId),
          eq(shopifySyncRuns.storeId, store.id),
        ),
      )
      .orderBy(desc(shopifySyncRuns.requestedAt))
      .limit(1);

    return { run: run ?? null };
  }),
});
