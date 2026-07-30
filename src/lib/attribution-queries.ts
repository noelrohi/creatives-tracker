/**
 * Attribution checker reads: bucket totals, the revenue identity, Meta
 * claimed-vs-verified, and connector freshness.
 *
 * Plain async functions on purpose — the findings job reuses them, so nothing
 * in here may depend on tRPC context. Money is summed in SQL and converted once,
 * at the edge, through the ingest cents helpers (numeric columns arrive as
 * strings; they are never parsed into floats).
 */

import { and, between, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { toCents } from "@/lib/shopify-ingest";
import { orgSettings } from "@/schema/org-settings";
import { performanceLogs } from "@/schema/performance-log";
import {
  attributionBucketEnum,
  shopifyOrders,
  shopifyRefunds,
  shopifyStores,
  shopifySyncRuns,
} from "@/schema/shopify";
import { orgSyncRuns } from "@/schema/sync-run";

export const ATTRIBUTION_BUCKETS = attributionBucketEnum.enumValues;

export const DEFAULT_ROAS_TARGET = 1.5;

const HOUR_MS = 60 * 60 * 1000;

/** Shopify sync runs hourly; Meta once a day. Stale = older than 2× the cycle. */
export const SHOPIFY_SYNC_CYCLE_MS = 1 * HOUR_MS;
export const META_SYNC_CYCLE_MS = 24 * HOUR_MS;

/**
 * Meta freshness reads `org_sync_run` (the org-level table; `account_sync_run`
 * is per ad account and would report "fresh" whenever any single account ran).
 * `partial_success` counts as successful: some accounts landed rows, so the org
 * did receive data that cycle.
 */
const META_SUCCESS_RESULTS = ["success", "partial_success"] as const;

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested — no DB)                                  */
/* ------------------------------------------------------------------ */

/** A connector is stale when nothing succeeded within 2× its sync cycle. */
export function isConnectorStale(
  lastSuccessAt: Date | null,
  cycleMs: number,
  now: Date = new Date(),
): boolean {
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() > 2 * cycleMs;
}

/**
 * The identity check, in integer cents: every order in the range lands in
 * exactly one bucket, or in pending. Pending is compared explicitly rather than
 * folded into a bucket, so an unbucketed backlog never fails the check — only
 * revenue genuinely lost by the grouping or the refund join does.
 */
export function identityMatches(params: {
  sumOfBucketsCents: number;
  pendingCents: number;
  actualCents: number;
}): boolean {
  return (
    params.sumOfBucketsCents + params.pendingCents === params.actualCents
  );
}

/** Share of rows carrying attribution-window columns; 0 when there are none. */
export function labeledShare(labeledRows: number, totalRows: number): number {
  if (totalRows <= 0) return 0;
  return labeledRows / totalRows;
}

/** ROAS is undefined without spend or without claims data — never a fake 0. */
export function computeRoas(
  revenueCents: number,
  spendCents: number,
): number | null {
  if (spendCents <= 0) return null;
  return revenueCents / spendCents;
}

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type DateRange = { dateFrom: string; dateTo: string };

export type StoreScope = { organizationId: string; storeId: string } & DateRange;

export type ShopifyStoreRow = typeof shopifyStores.$inferSelect;

export type BucketTotal = {
  bucket: AttributionBucket;
  revenueCents: number;
  orderCount: number;
};

export type BucketTotals = {
  buckets: BucketTotal[];
  pending: { count: number; revenueCents: number };
  totalCents: number;
  identity: {
    sumOfBucketsCents: number;
    actualCents: number;
    matches: boolean;
  };
};

export type DailyBucketPoint = {
  day: string;
  buckets: Record<AttributionBucket, number>;
  pendingNetCents: number;
  totalNetCents: number;
};

export type MetaClaims = {
  claimedCents: number;
  claimed7dClickCents: number | null;
  claimed1dViewCents: number | null;
  spendCents: number;
  labeledRowShare: number;
};

export type MetaVerified = {
  verifiedRevenueCents: number;
  verifiedOrderCount: number;
  verificationPendingCount: number;
};

export type SyncHealth = {
  shopify: { lastSuccessAt: Date | null; stale: boolean };
  meta: { lastSuccessAt: Date | null; stale: boolean };
};

function emptyBucketMap(): Record<AttributionBucket, number> {
  return Object.fromEntries(
    ATTRIBUTION_BUCKETS.map((bucket) => [bucket, 0]),
  ) as Record<AttributionBucket, number>;
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

/** v1 is one store per org; the newest row wins if that ever stops holding. */
export async function getStoreForOrg(
  organizationId: string,
): Promise<ShopifyStoreRow | null> {
  const [store] = await db
    .select()
    .from(shopifyStores)
    .where(eq(shopifyStores.organizationId, organizationId))
    .orderBy(desc(shopifyStores.createdAt))
    .limit(1);

  return store ?? null;
}

/* ------------------------------------------------------------------ */
/* Bucket totals + identity                                            */
/* ------------------------------------------------------------------ */

function orderRangeWhere(scope: StoreScope) {
  return and(
    eq(shopifyOrders.organizationId, scope.organizationId),
    eq(shopifyOrders.storeId, scope.storeId),
    between(shopifyOrders.orderDay, scope.dateFrom, scope.dateTo),
  );
}

function refundRangeWhere(scope: StoreScope) {
  return and(
    eq(shopifyRefunds.organizationId, scope.organizationId),
    eq(shopifyRefunds.storeId, scope.storeId),
    between(shopifyRefunds.refundDay, scope.dateFrom, scope.dateTo),
  );
}

export async function getBucketTotals(
  scope: StoreScope,
): Promise<BucketTotals> {
  const [orderRows, refundRows, [grossTotal], [refundTotal]] =
    await Promise.all([
    db
      .select({
        bucket: shopifyOrders.bucket,
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(shopifyOrders)
      .where(orderRangeWhere(scope))
      .groupBy(shopifyOrders.bucket),

    // Refunds carry no bucket by design — they inherit the order's.
    db
      .select({
        bucket: shopifyOrders.bucket,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .where(refundRangeWhere(scope))
      .groupBy(shopifyOrders.bucket),

    // Independent, ungrouped: the right-hand side of the identity. These do not
    // touch the grouping or the refund join, so anything the grouped queries
    // drop shows up as a mismatch.
    db
      .select({
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      })
      .from(shopifyOrders)
      .where(orderRangeWhere(scope)),

    db
      .select({
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .where(refundRangeWhere(scope)),
    ]);

  const grossByBucket = new Map<AttributionBucket, number>();
  const countByBucket = new Map<AttributionBucket, number>();
  let pendingGrossCents = 0;
  let pendingCount = 0;

  for (const row of orderRows) {
    const cents = toCents(row.gross);
    if (row.bucket === null) {
      pendingGrossCents += cents;
      pendingCount += row.orderCount;
      continue;
    }
    grossByBucket.set(row.bucket, cents);
    countByBucket.set(row.bucket, row.orderCount);
  }

  let pendingRefundCents = 0;
  const refundByBucket = new Map<AttributionBucket, number>();

  for (const row of refundRows) {
    const cents = toCents(row.refunded);
    if (row.bucket === null) {
      pendingRefundCents += cents;
      continue;
    }
    refundByBucket.set(row.bucket, cents);
  }

  const buckets: BucketTotal[] = ATTRIBUTION_BUCKETS.map((bucket) => ({
    bucket,
    revenueCents:
      (grossByBucket.get(bucket) ?? 0) - (refundByBucket.get(bucket) ?? 0),
    orderCount: countByBucket.get(bucket) ?? 0,
  }));

  const sumOfBucketsCents = buckets.reduce(
    (total, entry) => total + entry.revenueCents,
    0,
  );
  const pendingCents = pendingGrossCents - pendingRefundCents;
  const actualCents =
    toCents(grossTotal?.gross) - toCents(refundTotal?.refunded);

  return {
    buckets,
    pending: { count: pendingCount, revenueCents: pendingCents },
    totalCents: actualCents,
    identity: {
      sumOfBucketsCents,
      actualCents,
      matches: identityMatches({
        sumOfBucketsCents,
        pendingCents,
        actualCents,
      }),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Daily series                                                        */
/* ------------------------------------------------------------------ */

/**
 * Per store-timezone day, per bucket: orders booked on `order_day` minus
 * refunds booked on `refund_day`. Days with no rows on either side are omitted.
 */
export async function getDailyBucketSeries(
  scope: StoreScope,
): Promise<DailyBucketPoint[]> {
  const [orderRows, refundRows] = await Promise.all([
    db
      .select({
        day: shopifyOrders.orderDay,
        bucket: shopifyOrders.bucket,
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      })
      .from(shopifyOrders)
      .where(orderRangeWhere(scope))
      .groupBy(shopifyOrders.orderDay, shopifyOrders.bucket),

    db
      .select({
        day: shopifyRefunds.refundDay,
        bucket: shopifyOrders.bucket,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .where(refundRangeWhere(scope))
      .groupBy(shopifyRefunds.refundDay, shopifyOrders.bucket),
  ]);

  const byDay = new Map<string, DailyBucketPoint>();

  function pointFor(day: string) {
    const existing = byDay.get(day);
    if (existing) return existing;
    const created: DailyBucketPoint = {
      day,
      buckets: emptyBucketMap(),
      pendingNetCents: 0,
      totalNetCents: 0,
    };
    byDay.set(day, created);
    return created;
  }

  for (const row of orderRows) {
    const point = pointFor(row.day);
    const cents = toCents(row.gross);
    if (row.bucket === null) point.pendingNetCents += cents;
    else point.buckets[row.bucket] += cents;
    point.totalNetCents += cents;
  }

  for (const row of refundRows) {
    const point = pointFor(row.day);
    const cents = toCents(row.refunded);
    if (row.bucket === null) point.pendingNetCents -= cents;
    else point.buckets[row.bucket] -= cents;
    point.totalNetCents -= cents;
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/* ------------------------------------------------------------------ */
/* Meta claims (what Meta says) vs verified revenue (what Shopify saw)  */
/* ------------------------------------------------------------------ */

/** Base rows only: any breakdown column set means the row double-counts. */
function baseRowsOnly() {
  return and(
    isNull(performanceLogs.country),
    isNull(performanceLogs.platform),
    isNull(performanceLogs.placement),
    isNull(performanceLogs.device),
    isNull(performanceLogs.age),
    isNull(performanceLogs.gender),
  );
}

export async function getMetaClaims(params: {
  organizationId: string;
} & DateRange): Promise<MetaClaims> {
  const [row] = await db
    .select({
      claimed: sql<string>`coalesce(sum(${performanceLogs.purchaseValue}), 0)`,
      claimed7dClick: sql<
        string | null
      >`sum(${performanceLogs.purchaseValue7dClick})`,
      claimed1dView: sql<
        string | null
      >`sum(${performanceLogs.purchaseValue1dView})`,
      spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
      totalRows: sql<number>`count(*)::int`,
      labeledRows: sql<number>`count(*) filter (
        where ${performanceLogs.purchaseValue7dClick} is not null
           or ${performanceLogs.purchaseValue1dView} is not null
      )::int`,
    })
    .from(performanceLogs)
    .where(
      and(
        eq(performanceLogs.organizationId, params.organizationId),
        between(performanceLogs.dateStart, params.dateFrom, params.dateTo),
        baseRowsOnly(),
      ),
    );

  const labeledRows = row?.labeledRows ?? 0;

  return {
    claimedCents: toCents(row?.claimed),
    // Null, not 0: history predating the window columns is unlabeled.
    claimed7dClickCents:
      labeledRows > 0 && row?.claimed7dClick != null
        ? toCents(row.claimed7dClick)
        : null,
    claimed1dViewCents:
      labeledRows > 0 && row?.claimed1dView != null
        ? toCents(row.claimed1dView)
        : null,
    spendCents: toCents(row?.spend),
    labeledRowShare: labeledShare(labeledRows, row?.totalRows ?? 0),
  };
}

export async function getMetaVerified(scope: StoreScope): Promise<MetaVerified> {
  const metaVerifiedOrders = and(
    orderRangeWhere(scope),
    eq(shopifyOrders.bucket, "meta"),
    eq(shopifyOrders.metaVerified, true),
  );

  const [[orderRow], [refundRow], [pendingRow]] = await Promise.all([
    db
      .select({
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(shopifyOrders)
      .where(metaVerifiedOrders),

    db
      .select({
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .where(
        and(
          refundRangeWhere(scope),
          eq(shopifyOrders.bucket, "meta"),
          eq(shopifyOrders.metaVerified, true),
        ),
      ),

    db
      .select({ pendingCount: sql<number>`count(*)::int` })
      .from(shopifyOrders)
      .where(
        and(orderRangeWhere(scope), eq(shopifyOrders.verificationPending, true)),
      ),
  ]);

  return {
    verifiedRevenueCents:
      toCents(orderRow?.gross) - toCents(refundRow?.refunded),
    verifiedOrderCount: orderRow?.orderCount ?? 0,
    verificationPendingCount: pendingRow?.pendingCount ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Freshness + settings                                                */
/* ------------------------------------------------------------------ */

export async function getSyncHealth(params: {
  organizationId: string;
  storeId: string;
  now?: Date;
}): Promise<SyncHealth> {
  const now = params.now ?? new Date();

  const [[shopifyRun], [metaRun]] = await Promise.all([
    db
      .select({ finishedAt: shopifySyncRuns.finishedAt })
      .from(shopifySyncRuns)
      .where(
        and(
          eq(shopifySyncRuns.organizationId, params.organizationId),
          eq(shopifySyncRuns.storeId, params.storeId),
          eq(shopifySyncRuns.result, "success"),
        ),
      )
      .orderBy(desc(shopifySyncRuns.finishedAt))
      .limit(1),

    db
      .select({ finishedAt: orgSyncRuns.finishedAt })
      .from(orgSyncRuns)
      .where(
        and(
          eq(orgSyncRuns.organizationId, params.organizationId),
          inArray(orgSyncRuns.result, [...META_SUCCESS_RESULTS]),
        ),
      )
      .orderBy(desc(orgSyncRuns.finishedAt))
      .limit(1),
  ]);

  const shopifyLastSuccessAt = shopifyRun?.finishedAt ?? null;
  const metaLastSuccessAt = metaRun?.finishedAt ?? null;

  return {
    shopify: {
      lastSuccessAt: shopifyLastSuccessAt,
      stale: isConnectorStale(shopifyLastSuccessAt, SHOPIFY_SYNC_CYCLE_MS, now),
    },
    meta: {
      lastSuccessAt: metaLastSuccessAt,
      stale: isConnectorStale(metaLastSuccessAt, META_SYNC_CYCLE_MS, now),
    },
  };
}

export async function getRoasTarget(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ roasTarget: orgSettings.roasTarget })
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);

  if (!row?.roasTarget) return DEFAULT_ROAS_TARGET;

  const parsed = Number(row.roasTarget);
  return Number.isFinite(parsed) ? parsed : DEFAULT_ROAS_TARGET;
}

/* ------------------------------------------------------------------ */
/* Bucket drill-down                                                   */
/* ------------------------------------------------------------------ */

export type BucketOrderRow = {
  id: string;
  shopifyOrderId: string;
  orderDay: string;
  orderCreatedAt: Date;
  netSales: string;
  bucket: AttributionBucket | null;
  bucketRuleVersion: number | null;
  metaVerified: boolean;
  metaCampaignId: string | null;
  verificationPending: boolean;
  orderSourceName: string | null;
  lastClickUtmSource: string | null;
  lastClickUtmMedium: string | null;
  lastClickUtmCampaign: string | null;
};

type OrderCursor = { orderCreatedAt: Date; id: string };

export function encodeOrderCursor(cursor: OrderCursor): string {
  return `${cursor.orderCreatedAt.toISOString()}|${cursor.id}`;
}

export function decodeOrderCursor(value: string): OrderCursor | null {
  const separator = value.indexOf("|");
  if (separator < 0) return null;
  const orderCreatedAt = new Date(value.slice(0, separator));
  if (Number.isNaN(orderCreatedAt.getTime())) return null;
  const id = value.slice(separator + 1);
  if (!id) return null;
  return { orderCreatedAt, id };
}

/** Keyset pagination on (orderCreatedAt, id) desc — same shape as sync runs. */
export async function listBucketOrders(
  params: StoreScope & {
    bucket: AttributionBucket;
    limit: number;
    cursor?: string | null;
  },
): Promise<{ orders: BucketOrderRow[]; nextCursor: string | null }> {
  const cursor = params.cursor ? decodeOrderCursor(params.cursor) : null;

  const rows = await db
    .select({
      id: shopifyOrders.id,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderDay: shopifyOrders.orderDay,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
      netSales: shopifyOrders.netSales,
      bucket: shopifyOrders.bucket,
      bucketRuleVersion: shopifyOrders.bucketRuleVersion,
      metaVerified: shopifyOrders.metaVerified,
      metaCampaignId: shopifyOrders.metaCampaignId,
      verificationPending: shopifyOrders.verificationPending,
      orderSourceName: shopifyOrders.orderSourceName,
      lastClickUtmSource: shopifyOrders.lastClickUtmSource,
      lastClickUtmMedium: shopifyOrders.lastClickUtmMedium,
      lastClickUtmCampaign: shopifyOrders.lastClickUtmCampaign,
    })
    .from(shopifyOrders)
    .where(
      and(
        orderRangeWhere(params),
        eq(shopifyOrders.bucket, params.bucket),
        cursor
          ? sql`(${shopifyOrders.orderCreatedAt}, ${shopifyOrders.id}) < (${cursor.orderCreatedAt}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(shopifyOrders.orderCreatedAt), desc(shopifyOrders.id))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const orders = hasMore ? rows.slice(0, params.limit) : rows;
  const last = orders.at(-1);

  return {
    orders,
    nextCursor: hasMore && last ? encodeOrderCursor(last) : null,
  };
}
