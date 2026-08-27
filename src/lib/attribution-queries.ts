/**
 * Attribution checker reads: bucket totals, the revenue identity, Meta
 * claimed-vs-verified, and connector freshness.
 *
 * Plain async functions on purpose — the findings job reuses them, so nothing
 * in here may depend on tRPC context. Money is summed in SQL and converted once,
 * at the edge, through the ingest cents helpers (numeric columns arrive as
 * strings; they are never parsed into floats).
 */

import {
  and,
  between,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { toCents } from "@/lib/money";
import { adAccounts } from "@/schema/account";
import { adSets } from "@/schema/ad-set";
import { ads } from "@/schema/ad";
import { campaigns } from "@/schema/campaign";
import { orgSettings } from "@/schema/org-settings";
import { performanceLogs } from "@/schema/performance-log";
import {
  attributionBucketEnum,
  shopifyOrders,
  shopifyRefunds,
  shopifyStores,
  shopifySyncRuns,
} from "@/schema/shopify";
import { accountSyncRuns } from "@/schema/sync-run";

export const ATTRIBUTION_BUCKETS = attributionBucketEnum.enumValues;

export const DEFAULT_ROAS_TARGET = 1.5;

const HOUR_MS = 60 * 60 * 1000;

/** Shopify sync runs hourly; Meta once a day. Stale = older than 2× the cycle. */
export const SHOPIFY_SYNC_CYCLE_MS = 1 * HOUR_MS;
export const META_SYNC_CYCLE_MS = 24 * HOUR_MS;

/**
 * Meta freshness is the freshness of the account that ran least recently: the
 * org has heard from Meta only once every connected account has. Reading the
 * newest run instead would report "fresh" whenever any single account synced,
 * which is the failure this rule exists to avoid.
 *
 * (`org_sync_run` would say this in one row, but nothing writes that table —
 * `createOrgSyncRun` and `refreshOrgSyncRunAggregate` have no callers — so an
 * org-level read reports "never connected" forever.)
 *
 * `partial_success` counts as successful: the account landed rows that cycle.
 */
const META_SUCCESS_RESULTS = ["success", "partial_success"] as const;

export type AccountFreshness = { lastSuccessAt: Date | null };

/**
 * An org with no Meta accounts connected is not "disconnected from Meta" — it
 * simply does not use Meta, and must never raise a connection alert. One that
 * has accounts but has never synced one of them is genuinely never-connected.
 */
export function summarizeMetaFreshness(
  accounts: readonly AccountFreshness[],
  now: Date = new Date(),
): { lastSuccessAt: Date | null; stale: boolean } {
  if (accounts.length === 0) return { lastSuccessAt: null, stale: false };

  let oldest: Date | null = null;
  for (const account of accounts) {
    if (!account.lastSuccessAt) return { lastSuccessAt: null, stale: true };
    if (!oldest || account.lastSuccessAt < oldest) {
      oldest = account.lastSuccessAt;
    }
  }

  return {
    lastSuccessAt: oldest,
    stale: isConnectorStale(oldest, META_SYNC_CYCLE_MS, now),
  };
}

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
    differenceCents: number;
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
  /**
   * The standard claim (§3.2): `7d_click + 1d_view`, summed from the labeled
   * columns only. Null when no row in the range carries window labels — "no
   * data yet", never a $0 that reads like Meta claimed nothing.
   */
  claimedCents: number | null;
  claimed7dClickCents: number | null;
  claimed1dViewCents: number | null;
  spendCents: number;
  /**
   * How many Meta rows the range actually had. `spendCents` sums to 0 whether
   * Meta reported a zero-spend day or has not reported the day at all, and the
   * difference decides whether a rule may draw a conclusion — so the count that
   * separates them travels with the figure rather than being re-derived.
   */
  spendRowCount: number;
  labeledRowShare: number;
};

export type MetaVerified = {
  verifiedRevenueCents: number;
  verifiedOrderCount: number;
  verificationPendingCount: number;
};

export type CampaignLedgerRow = {
  /** Our own campaign row id — a join/render key, never a printed figure. */
  campaignId: string;
  name: string;
  /** Null when Meta reported no rows for this campaign in the range. */
  spendCents: number | null;
  /** Null when no row in the range carries window labels (§3.2). */
  claimedCents: number | null;
  confirmedRevenueCents: number;
  orderCount: number;
  /** Payback per $1 — null without spend, never a fake 0. */
  roas: number | null;
};

/**
 * What could not be put behind a campaign, on both sides of the ledger: Meta
 * orders whose campaign the stamped id and the ad set on the link both failed
 * to name, and spend whose ad has been orphaned from its ad set. They exist so
 * the campaign rows plus this one still sum to the Meta bucket for the range.
 */
export type CampaignLedgerUnresolved = {
  confirmedRevenueCents: number;
  orderCount: number;
  /** Null when every performance row reached a campaign. */
  spendCents: number | null;
  /** Null when no orphaned row carries window labels — never a fake $0. */
  claimedCents: number | null;
};

export type CampaignLedger = {
  campaigns: CampaignLedgerRow[];
  unresolved: CampaignLedgerUnresolved | null;
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
      differenceCents: actualCents - sumOfBucketsCents - pendingCents,
      matches: identityMatches({
        sumOfBucketsCents,
        pendingCents,
        actualCents,
      }),
    },
  };
}

/**
 * Refunds of every kind whose refund day lands in the range — the same rows
 * (and the same `refundRangeWhere`) the ledger nets out of gross sales, so
 * the Refunds card always agrees with the tie-out.
 */
export async function getRefundsTotal(
  scope: StoreScope,
): Promise<{ refundedCents: number; count: number }> {
  const [row] = await db
    .select({
      refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(shopifyRefunds)
    .where(refundRangeWhere(scope));

  return { refundedCents: toCents(row?.refunded ?? "0"), count: row?.count ?? 0 };
}

/**
 * One store-day's orders bucketed by the hour they were placed, on the store's
 * clock. `order_created_at` is a naive UTC timestamp, so the wall-clock hour
 * needs the double conversion; the day filter is the already-stamped
 * `order_day`, keeping "which orders belong to the day" identical to every
 * other read. Always 24 rows, zero-filled.
 */
export async function getHourlySales(params: {
  organizationId: string;
  storeId: string;
  day: string;
  timeZone: string;
}): Promise<Array<{ hour: number; netCents: number; orders: number }>> {
  const hourExpression = sql<number>`extract(hour from ((${shopifyOrders.orderCreatedAt} at time zone 'utc') at time zone ${params.timeZone}))::int`;
  const rows = await db
    .select({
      hour: hourExpression,
      net: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      orders: sql<number>`count(*)::int`,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, params.organizationId),
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.orderDay, params.day),
      ),
    )
    // Group by ordinal position, not the expression a second time: Drizzle
    // renders the same `sql` fragment differently in the select list (bare)
    // than in GROUP BY (table-qualified), and Postgres then treats them as
    // two different expressions and rejects the ungrouped select column.
    .groupBy(sql`1`);

  const byHour = new Map(rows.map((row) => [row.hour, row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour);
    return {
      hour,
      netCents: row ? toCents(row.net) : 0,
      orders: row?.orders ?? 0,
    };
  });
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

/**
 * The standard claim (§3.2): `7d_click + 1d_view`, over labeled rows only. Never
 * `purchase_value` — that column carries the account's default attribution
 * setting, so summing it would compare a differently-windowed number against
 * Shopify. Exported so the contract is testable without a database.
 */
export const CLAIMED_WINDOWS_EXPRESSION = sql<string | null>`sum(
  coalesce(${performanceLogs.purchaseValue7dClick}, 0)
  + coalesce(${performanceLogs.purchaseValue1dView}, 0)
) filter (
  where ${performanceLogs.purchaseValue7dClick} is not null
     or ${performanceLogs.purchaseValue1dView} is not null
)`;

/**
 * What Meta says it made, read from the labeled window columns. Rows that
 * predate the labels contribute nothing; `labeledRowShare` reports how much of
 * the range is answerable at all.
 */
export async function getMetaClaims(params: {
  organizationId: string;
} & DateRange): Promise<MetaClaims> {
  const [row] = await db
    .select({
      claimed: CLAIMED_WINDOWS_EXPRESSION,
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

  return metaClaimsFromRow(row);
}

export type MetaClaimsRow = {
  claimed: string | null;
  claimed7dClick: string | null;
  claimed1dView: string | null;
  spend: string;
  totalRows: number;
  labeledRows: number;
};

/**
 * The null-not-zero rule for a claim, in one place: with no labeled row behind
 * it a claim is unknown — "no data yet", never a $0 that would read as "Meta
 * claimed nothing" (§7.2). The per-campaign ledger reads claims through the
 * same rule.
 */
export function labeledClaimCents(
  value: string | null | undefined,
  labeledRows: number,
): number | null {
  return labeledRows > 0 && value != null ? toCents(value) : null;
}

/**
 * Numeric columns arrive as strings and become cents exactly once. With no
 * labeled row in the range every claim figure is null — "no data yet", never a
 * $0 that would read as "Meta claimed nothing" (§7.2).
 */
export function metaClaimsFromRow(
  row: MetaClaimsRow | undefined,
): MetaClaims {
  const labeledRows = row?.labeledRows ?? 0;
  const labeled = (value: string | null | undefined) =>
    labeledClaimCents(value, labeledRows);

  const totalRows = row?.totalRows ?? 0;

  return {
    claimedCents: labeled(row?.claimed),
    claimed7dClickCents: labeled(row?.claimed7dClick),
    claimed1dViewCents: labeled(row?.claimed1dView),
    spendCents: toCents(row?.spend),
    spendRowCount: totalRows,
    labeledRowShare: labeledShare(labeledRows, totalRows),
  };
}

/**
 * One row per day over the same range, for callers that need a series rather
 * than a total: the per-day loop it replaces issued a query per day.
 *
 * Same predicate, same expressions, and every row goes through
 * `metaClaimsFromRow` — the null-not-zero rule (§7.2) and the `spendRowCount`
 * that separates "Meta reported zero" from "Meta has not reported" live in one
 * place, so the grouped and per-day paths cannot drift apart.
 *
 * Days Meta has no row for are absent from the map rather than present as a
 * zero: that is the same distinction `spendRowCount` draws, and a caller
 * reading a missing day through `metaClaimsFromRow(undefined)` gets exactly
 * what `getMetaClaims` returns for an empty day.
 */
export async function getMetaClaimsByDay(params: {
  organizationId: string;
} & DateRange): Promise<Map<string, MetaClaims>> {
  const rows = await db
    .select({
      day: performanceLogs.dateStart,
      claimed: CLAIMED_WINDOWS_EXPRESSION,
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
    )
    .groupBy(performanceLogs.dateStart);

  return new Map(rows.map((row) => [row.day, metaClaimsFromRow(row)]));
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

/** What `getMetaVerified` answers for a day nothing landed on. */
export const EMPTY_META_VERIFIED: MetaVerified = Object.freeze({
  verifiedRevenueCents: 0,
  verifiedOrderCount: 0,
  verificationPendingCount: 0,
});

/**
 * `getMetaVerified` per day, in two queries instead of three per day. The
 * split mirrors the per-day function exactly: orders (and the pending count)
 * group on `order_day`, refunds group on `refund_day`, and a day's verified
 * revenue is its gross minus the refunds booked that day — so a refund lands on
 * the day it was issued, not the day the order was.
 *
 * Days with nothing on either side are absent; read them through
 * {@link EMPTY_META_VERIFIED}, which is what the per-day function returns for
 * an empty range.
 */
export async function getMetaVerifiedByDay(
  scope: StoreScope,
): Promise<Map<string, MetaVerified>> {
  const isMetaVerified = sql`${shopifyOrders.bucket} = 'meta'
    and ${shopifyOrders.metaVerified}`;

  const [orderRows, refundRows] = await Promise.all([
    db
      .select({
        day: shopifyOrders.orderDay,
        gross: sql<string>`coalesce(
          sum(${shopifyOrders.netSales}) filter (where ${isMetaVerified}), 0
        )`,
        orderCount: sql<number>`count(*) filter (where ${isMetaVerified})::int`,
        pendingCount: sql<number>`count(*) filter (
          where ${shopifyOrders.verificationPending}
        )::int`,
      })
      .from(shopifyOrders)
      .where(orderRangeWhere(scope))
      .groupBy(shopifyOrders.orderDay),

    db
      .select({
        day: shopifyRefunds.refundDay,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .where(and(refundRangeWhere(scope), isMetaVerified))
      .groupBy(shopifyRefunds.refundDay),
  ]);

  const byDay = new Map<string, MetaVerified>();

  function entryFor(day: string) {
    const existing = byDay.get(day);
    if (existing) return existing;
    const created: MetaVerified = { ...EMPTY_META_VERIFIED };
    byDay.set(day, created);
    return created;
  }

  for (const row of orderRows) {
    const entry = entryFor(row.day);
    entry.verifiedRevenueCents += toCents(row.gross);
    entry.verifiedOrderCount = row.orderCount;
    entry.verificationPendingCount = row.pendingCount;
  }

  for (const row of refundRows) {
    entryFor(row.day).verifiedRevenueCents -= toCents(row.refunded);
  }

  return byDay;
}

/* ------------------------------------------------------------------ */
/* Per-campaign ledger                                                 */
/* ------------------------------------------------------------------ */

/**
 * The ad set id Shopify carries on the last visit. Two things about it: it is
 * the reliable side of the link (the campaign tag is a name as often as an id),
 * and one order arrived with a `?fbclid=…` glued onto the end, so everything
 * from the `?` on is dropped before the join.
 */
const JOURNEY_AD_SET_ID_EXPRESSION = sql`lower(split_part(
  ${shopifyOrders.customerJourney}->'lastVisit'->'utmParameters'->>'term',
  '?',
  1
))`;

export type CampaignMetaSideRow = {
  /** Null when the ad behind the row has been orphaned from its ad set. */
  campaignId: string | null;
  name: string | null;
  spend: string;
  claimed: string | null;
  /** Only what `labeledClaimCents` needs to tell a real $0 from no data. */
  labeledRows: number;
};

export type CampaignOrderSideRow = {
  campaignId: string | null;
  name: string | null;
  gross: string;
  orderCount: number;
};

export type CampaignRefundSideRow = {
  campaignId: string | null;
  name: string | null;
  refunded: string;
};

/**
 * Spend and claims per campaign, against the orders we can actually put behind
 * each one — the cut list. Read-only over data already stamped: nothing here
 * widens verification, so a campaign's confirmed revenue is every Meta-bucket
 * order that resolves to it, not only the ones `meta_verified` covers.
 *
 * An order resolves through the stamped `meta_campaign_id` first and through the
 * ad set id on the link second. The two paths never disagreed on the measured
 * range; the second one simply reaches the four campaigns in five whose links
 * are tagged with a name rather than an id.
 */
export async function getCampaignLedger(
  scope: StoreScope,
): Promise<CampaignLedger> {
  // The campaign an order names outright, and the campaign its ad set belongs
  // to. Both are left joins: an order that resolves through neither is counted
  // as unresolved rather than dropped.
  const stampedCampaign = alias(campaigns, "stamped_campaign");
  const journeyAdSet = alias(adSets, "journey_ad_set");
  const journeyCampaign = alias(campaigns, "journey_campaign");

  const resolvedCampaignId = sql<string | null>`coalesce(
    ${stampedCampaign.id}, ${journeyCampaign.id}
  )`;
  const resolvedCampaignName = sql<string | null>`coalesce(
    ${stampedCampaign.name}, ${journeyCampaign.name}
  )`;

  /**
   * `meta_campaign_id` is only ever stamped from this org's own campaign ids,
   * so scoping the lookup by org loses nothing and keeps the ad set join's
   * scoping rule (globally unique column, still scoped) consistent.
   */
  const stampedJoin = and(
    eq(stampedCampaign.organizationId, scope.organizationId),
    sql`lower(${stampedCampaign.metaId}) = ${shopifyOrders.metaCampaignId}`,
  );
  const journeyAdSetJoin = and(
    eq(journeyAdSet.organizationId, scope.organizationId),
    sql`lower(${journeyAdSet.metaId}) = ${JOURNEY_AD_SET_ID_EXPRESSION}`,
  );

  const metaOrders = and(orderRangeWhere(scope), eq(shopifyOrders.bucket, "meta"));

  const [metaSide, orderSide, refundSide] = await Promise.all([
    // Meta's own side: the `getMetaClaims` aggregation, base rows only, reached
    // through the hierarchy because `performance_log` carries no campaign. The
    // hierarchy is walked with left joins: `ad.ad_set_id` is nullable and
    // deleting an ad set orphans its ads while their performance rows live on,
    // so inner joins would drop that spend from the ledger while the Meta total
    // above it still counted the money.
    db
      .select({
        campaignId: campaigns.id,
        name: campaigns.name,
        spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
        claimed: CLAIMED_WINDOWS_EXPRESSION,
        labeledRows: sql<number>`count(*) filter (
          where ${performanceLogs.purchaseValue7dClick} is not null
             or ${performanceLogs.purchaseValue1dView} is not null
        )::int`,
      })
      .from(performanceLogs)
      .leftJoin(ads, eq(ads.id, performanceLogs.adId))
      .leftJoin(adSets, eq(adSets.id, ads.adSetId))
      .leftJoin(campaigns, eq(campaigns.id, adSets.campaignId))
      .where(
        and(
          eq(performanceLogs.organizationId, scope.organizationId),
          between(performanceLogs.dateStart, scope.dateFrom, scope.dateTo),
          baseRowsOnly(),
        ),
      )
      .groupBy(campaigns.id, campaigns.name),

    db
      .select({
        campaignId: resolvedCampaignId,
        name: resolvedCampaignName,
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(shopifyOrders)
      .leftJoin(stampedCampaign, stampedJoin)
      .leftJoin(journeyAdSet, journeyAdSetJoin)
      .leftJoin(journeyCampaign, eq(journeyCampaign.id, journeyAdSet.campaignId))
      .where(metaOrders)
      .groupBy(resolvedCampaignId, resolvedCampaignName),

    // Refunds carry no campaign of their own — they inherit their order's, and
    // book on `refund_day`, exactly as the bucket totals do. Without that these
    // rows stop summing to the Meta bucket.
    db
      .select({
        campaignId: resolvedCampaignId,
        name: resolvedCampaignName,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .leftJoin(stampedCampaign, stampedJoin)
      .leftJoin(journeyAdSet, journeyAdSetJoin)
      .leftJoin(journeyCampaign, eq(journeyCampaign.id, journeyAdSet.campaignId))
      .where(and(refundRangeWhere(scope), eq(shopifyOrders.bucket, "meta")))
      .groupBy(resolvedCampaignId, resolvedCampaignName),
  ]);

  return mergeCampaignLedger({ metaSide, orderSide, refundSide });
}

/**
 * The full outer join, done where it can be tested without a database: a
 * campaign with spend and no orders stays visible, an unspent campaign that
 * converted stays visible, and whatever named no campaign at all — orders on
 * one side, orphaned spend on the other — becomes the `unresolved` row.
 *
 * Money arrives as numeric strings and becomes cents exactly once, here.
 */
export function mergeCampaignLedger(params: {
  metaSide: readonly CampaignMetaSideRow[];
  orderSide: readonly CampaignOrderSideRow[];
  refundSide: readonly CampaignRefundSideRow[];
}): CampaignLedger {
  const rows = new Map<string, CampaignLedgerRow>();
  const unresolved: CampaignLedgerUnresolved = {
    confirmedRevenueCents: 0,
    orderCount: 0,
    spendCents: null,
    claimedCents: null,
  };
  let sawUnresolved = false;

  function rowFor(campaignId: string, name: string): CampaignLedgerRow {
    const existing = rows.get(campaignId);
    if (existing) {
      // A name is only missing on the side that did not resolve one.
      if (existing.name.length === 0 && name.length > 0) existing.name = name;
      return existing;
    }
    const created: CampaignLedgerRow = {
      campaignId,
      name,
      spendCents: null,
      claimedCents: null,
      confirmedRevenueCents: 0,
      orderCount: 0,
      roas: null,
    };
    rows.set(campaignId, created);
    return created;
  }

  for (const entry of params.metaSide) {
    if (!entry.campaignId) {
      // Spend whose ad no longer hangs off an ad set. It is real money and it
      // is in the Meta total above, so it belongs in the unresolved row rather
      // than nowhere.
      unresolved.spendCents = (unresolved.spendCents ?? 0) + toCents(entry.spend);
      const claimed = labeledClaimCents(entry.claimed, entry.labeledRows);
      if (claimed !== null) {
        unresolved.claimedCents = (unresolved.claimedCents ?? 0) + claimed;
      }
      sawUnresolved = true;
      continue;
    }
    const row = rowFor(entry.campaignId, entry.name ?? "");
    row.spendCents = toCents(entry.spend);
    row.claimedCents = labeledClaimCents(entry.claimed, entry.labeledRows);
  }

  for (const entry of params.orderSide) {
    if (!entry.campaignId) {
      unresolved.confirmedRevenueCents += toCents(entry.gross);
      unresolved.orderCount += entry.orderCount;
      sawUnresolved = true;
      continue;
    }
    const row = rowFor(entry.campaignId, entry.name ?? "");
    row.confirmedRevenueCents += toCents(entry.gross);
    row.orderCount += entry.orderCount;
  }

  for (const entry of params.refundSide) {
    if (!entry.campaignId) {
      unresolved.confirmedRevenueCents -= toCents(entry.refunded);
      sawUnresolved = true;
      continue;
    }
    // A refund can be the only thing a campaign has in the range — a paused
    // campaign, no spend, its old order given back today. Creating the row
    // rather than skipping it keeps the rows summing to the Meta bucket.
    const row = rowFor(entry.campaignId, entry.name ?? "");
    row.confirmedRevenueCents -= toCents(entry.refunded);
  }

  for (const row of rows.values()) {
    row.roas = computeRoas(row.confirmedRevenueCents, row.spendCents ?? 0);
  }

  return {
    campaigns: sortCampaignLedger([...rows.values()]),
    unresolved: sawUnresolved ? unresolved : null,
  };
}

/**
 * Lowest payback first — this is a cut list, so the worst row is the first row.
 * Two campaigns paying back the same are ranked by what they spent doing it:
 * $1,367 returning nothing is a bigger decision than $250 returning nothing.
 *
 * A campaign with no spend has no payback to rank on and sits at the bottom,
 * biggest first, rather than being read as the best or the worst.
 */
export function sortCampaignLedger(
  rows: readonly CampaignLedgerRow[],
): CampaignLedgerRow[] {
  return [...rows].sort((a, b) => {
    if (a.roas === null || b.roas === null) {
      if (a.roas !== b.roas) return a.roas === null ? 1 : -1;
      if (a.confirmedRevenueCents !== b.confirmedRevenueCents) {
        return b.confirmedRevenueCents - a.confirmedRevenueCents;
      }
      return a.name.localeCompare(b.name);
    }

    if (a.roas !== b.roas) return a.roas - b.roas;
    if (a.spendCents !== b.spendCents) {
      return (b.spendCents ?? 0) - (a.spendCents ?? 0);
    }
    return a.name.localeCompare(b.name);
  });
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

  const [[shopifyRun], metaAccounts] = await Promise.all([
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

    // One row per connected Meta account, carrying its own newest good run.
    // `mapWith` reads the aggregate through the column's own driver mapping:
    // Postgres hands back a bare "2026-07-27 18:07:55.172" for max() over a
    // timestamp, and parsing that by hand would read UTC as local time.
    db
      .select({
        lastSuccessAt: sql<Date | null>`max(${accountSyncRuns.finishedAt})`.mapWith(
          accountSyncRuns.finishedAt,
        ),
      })
      .from(adAccounts)
      .leftJoin(
        accountSyncRuns,
        and(
          eq(accountSyncRuns.accountId, adAccounts.id),
          inArray(accountSyncRuns.result, [...META_SUCCESS_RESULTS]),
        ),
      )
      .where(
        and(
          eq(adAccounts.organizationId, params.organizationId),
          isNotNull(adAccounts.metaAccessToken),
          eq(adAccounts.isDisabled, false),
        ),
      )
      .groupBy(adAccounts.id),
  ]);

  const shopifyLastSuccessAt = shopifyRun?.finishedAt ?? null;

  return {
    shopify: {
      lastSuccessAt: shopifyLastSuccessAt,
      stale: isConnectorStale(shopifyLastSuccessAt, SHOPIFY_SYNC_CYCLE_MS, now),
    },
    meta: summarizeMetaFreshness(metaAccounts, now),
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
  orderName: string | null;
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
      orderName: shopifyOrders.orderName,
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
