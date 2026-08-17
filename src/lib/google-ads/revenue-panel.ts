import "server-only";

/**
 * Google Ads revenue panel aggregate: splits our own google-bucket Shopify
 * revenue into free-listings feed vs paid, and — when a connection with
 * synced facts exists — pairs it with what Google Ads itself reports for the
 * same range. Aggregate-only (spec: 2026-08-17-google-ads-revenue-panel-design.md,
 * "Data contract" + "Definitions"): no order-level click-id matching.
 *
 * The our-side split MUST mirror `getBucketTotals`'s own windowing and refund
 * treatment (attribution-queries.ts) exactly, so feed + paid sum to the same
 * "google" bucket row the rest of the attribution page shows — that
 * ledger-agreement invariant is what the integration suite enforces.
 */

import { and, between, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { GOOGLE_FEED_MEDIUMS } from "@/lib/attribution-bucket";
import { getBucketTotals } from "@/lib/attribution-queries";
import { listCampaignFactsSummary } from "@/lib/google-ads/queries";
import { getPilotGoogleAdsConnectionForOrganization } from "@/lib/google-ads/sync-store";
import { toCents } from "@/lib/money";
import { shopifyOrders, shopifyRefunds } from "@/schema/shopify";

export type PaidCampaignSlice = {
  utmCampaign: string | null;
  revenueCents: number;
  orders: number;
};

export type RevenuePanelSummary = {
  connection: {
    status: string;
    lastFactsSyncedAt: Date | null;
    backfillCompletedAt: Date | null;
  } | null;
  googleCurrencyCode: string | null;
  ourSide: {
    bucketRevenueCents: number;
    bucketOrders: number;
    feedRevenueCents: number;
    feedOrders: number;
    paidRevenueCents: number;
    paidOrders: number;
    paidByCampaign: PaidCampaignSlice[];
  };
  googleSays: {
    spendCents: number;
    conversions: number;
    conversionsValueCents: number;
    byCampaign: Array<{
      campaignId: string;
      campaignName: string;
      spendCents: number;
      conversions: number;
      conversionsValueCents: number;
      matchedUtmCampaign: string | null;
    }>;
  } | null;
};

/**
 * Exact, trimmed, case-insensitive equality between a Google campaign name
 * and one of the paid slices' `utmCampaign` values (spec: "Campaign
 * matching" — no fuzzy matching, and it is never persisted). The null-utm
 * slice (paid revenue with no campaign tag) can never match a real name, and
 * an empty needle never matches anything.
 */
export function matchCampaignNames(
  campaignName: string,
  paidByCampaign: PaidCampaignSlice[],
): string | null {
  const needle = campaignName.trim().toLowerCase();
  if (!needle) return null;
  for (const slice of paidByCampaign) {
    if (slice.utmCampaign === null) continue;
    if (slice.utmCampaign.trim().toLowerCase() === needle) {
      return slice.utmCampaign;
    }
  }
  return null;
}

const FEED_MEDIUMS_LOWER = GOOGLE_FEED_MEDIUMS.map((medium) =>
  medium.toLowerCase(),
);

/**
 * `GOOGLE_FEED_MEDIUMS` as a literal SQL `IN` list, not bind parameters:
 * Postgres's GROUP BY validity check compares parse trees, and two separate
 * bind-parameter placeholders for the same value (one in SELECT, one in
 * GROUP BY) are NOT recognized as the same expression — only identical
 * literal text is. Safe to inline: this is a fixed internal constant, never
 * user input.
 */
const FEED_MEDIUMS_SQL_LIST = FEED_MEDIUMS_LOWER.map(
  (medium) => `'${medium.replace(/'/g, "''")}'`,
).join(", ");

/**
 * Mirrors `isGoogleFeedMedium` (attribution-bucket.ts) in SQL: trimmed,
 * lowercased, exact membership in `GOOGLE_FEED_MEDIUMS`. Reused verbatim
 * across the queries below so SELECT and GROUP BY agree on the same
 * expression.
 */
const isFeedMediumSql = sql<boolean>`lower(trim(coalesce(${shopifyOrders.lastClickUtmMedium}, ''))) in (${sql.raw(FEED_MEDIUMS_SQL_LIST)})`;

type OurSideScope = {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
};

/** Same order windowing as `getBucketTotals`'s `orderRangeWhere`, plus the google bucket. */
function bucketOrderScope(scope: OurSideScope) {
  return and(
    eq(shopifyOrders.organizationId, scope.organizationId),
    eq(shopifyOrders.storeId, scope.storeId),
    between(shopifyOrders.orderDay, scope.dateFrom, scope.dateTo),
    eq(shopifyOrders.bucket, "google"),
  );
}

/** Same refund windowing as `getBucketTotals`'s `refundRangeWhere`, joined to a google-bucket order. */
function bucketRefundScope(scope: OurSideScope) {
  return and(
    eq(shopifyRefunds.organizationId, scope.organizationId),
    eq(shopifyRefunds.storeId, scope.storeId),
    between(shopifyRefunds.refundDay, scope.dateFrom, scope.dateTo),
    eq(shopifyOrders.bucket, "google"),
  );
}

type OurSide = RevenuePanelSummary["ourSide"];

/**
 * Our side of the panel. `bucketRevenueCents`/`bucketOrders` come straight
 * from `getBucketTotals`'s own "google" row — the authoritative figure the
 * rest of the attribution page shows. The feed/paid split is a second,
 * independent set of queries windowed identically; refunds are netted per
 * slice by joining to their parent order's feed/paid classification, exactly
 * as `getBucketTotals` nets refunds by joining to the parent order's bucket.
 */
async function loadOurSide(scope: OurSideScope): Promise<OurSide> {
  const bucketTotals = await getBucketTotals({
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
  });
  const googleBucket = bucketTotals.buckets.find(
    (bucket) => bucket.bucket === "google",
  );

  const [splitRows, campaignGrossRows, refundSplitRows, refundCampaignRows] =
    await Promise.all([
      // Gross + order count, split feed vs paid.
      db
        .select({
          isFeed: isFeedMediumSql,
          gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
          orderCount: sql<number>`count(*)::int`,
        })
        .from(shopifyOrders)
        .where(bucketOrderScope(scope))
        .groupBy(isFeedMediumSql),

      // Gross + order count for the paid slice only, by campaign.
      db
        .select({
          utmCampaign: shopifyOrders.lastClickUtmCampaign,
          gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
          orderCount: sql<number>`count(*)::int`,
        })
        .from(shopifyOrders)
        .where(and(bucketOrderScope(scope), sql`not (${isFeedMediumSql})`))
        .groupBy(shopifyOrders.lastClickUtmCampaign),

      // Refunds against google-bucket orders, split by the parent order's
      // feed/paid classification (refunds carry no medium of their own).
      db
        .select({
          isFeed: isFeedMediumSql,
          refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
        })
        .from(shopifyRefunds)
        .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
        .where(bucketRefundScope(scope))
        .groupBy(isFeedMediumSql),

      // Same refunds, grouped by the parent (paid) order's campaign, so
      // paidByCampaign nets refunds the same way the paid slice total does.
      db
        .select({
          utmCampaign: shopifyOrders.lastClickUtmCampaign,
          refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
        })
        .from(shopifyRefunds)
        .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
        .where(and(bucketRefundScope(scope), sql`not (${isFeedMediumSql})`))
        .groupBy(shopifyOrders.lastClickUtmCampaign),
    ]);

  // Per-group SQL sums arrive as decimal strings; `toCents` parses them
  // without float drift. That parse is exact only because the ingest write
  // path guarantees `net_sales`/`amount` never carry more than 2 decimal
  // places (see `centsToAmount` in shopify-ingest.ts) — the same exposure
  // `getBucketTotals`'s own identity check rests on.
  let feedGrossCents = 0;
  let feedOrders = 0;
  let paidGrossCents = 0;
  let paidOrders = 0;
  for (const row of splitRows) {
    if (row.isFeed) {
      feedGrossCents += toCents(row.gross);
      feedOrders += row.orderCount;
    } else {
      paidGrossCents += toCents(row.gross);
      paidOrders += row.orderCount;
    }
  }

  let feedRefundCents = 0;
  let paidRefundCents = 0;
  for (const row of refundSplitRows) {
    if (row.isFeed) feedRefundCents += toCents(row.refunded);
    else paidRefundCents += toCents(row.refunded);
  }

  const refundByCampaign = new Map<string | null, number>();
  for (const row of refundCampaignRows) {
    refundByCampaign.set(row.utmCampaign, toCents(row.refunded));
  }

  const grossByCampaign = new Map<
    string | null,
    { gross: string; orderCount: number }
  >();
  for (const row of campaignGrossRows) {
    grossByCampaign.set(row.utmCampaign, row);
  }

  // Union of campaigns seen via orders AND via refunds: a refund against an
  // order outside the current window (paid, out-of-range parent day) still
  // has no matching entry in campaignGrossRows, but its refund still nets
  // against the paid total — so its campaign must still get a slice, or the
  // slice list would under-account relative to paidRevenueCents.
  const campaignKeys = new Set<string | null>([
    ...grossByCampaign.keys(),
    ...refundByCampaign.keys(),
  ]);

  const paidByCampaign: PaidCampaignSlice[] = Array.from(campaignKeys).map(
    (utmCampaign) => {
      const grossRow = grossByCampaign.get(utmCampaign);
      return {
        utmCampaign,
        revenueCents:
          (grossRow ? toCents(grossRow.gross) : 0) -
          (refundByCampaign.get(utmCampaign) ?? 0),
        orders: grossRow?.orderCount ?? 0,
      };
    },
  );
  // Deterministic order: highest revenue first, then campaign name; the
  // null-campaign slice always sorts last.
  paidByCampaign.sort((a, b) => {
    if (b.revenueCents !== a.revenueCents) return b.revenueCents - a.revenueCents;
    if (a.utmCampaign === null) return 1;
    if (b.utmCampaign === null) return -1;
    return a.utmCampaign.localeCompare(b.utmCampaign);
  });

  return {
    bucketRevenueCents: googleBucket?.revenueCents ?? 0,
    bucketOrders: googleBucket?.orderCount ?? 0,
    feedRevenueCents: feedGrossCents - feedRefundCents,
    feedOrders,
    paidRevenueCents: paidGrossCents - paidRefundCents,
    paidOrders,
    paidByCampaign,
  };
}

/**
 * Google's own side: `google_ads_campaign_fact` rows summed over the
 * inclusive page range (spec: "'Google says'"). Empty range → null, per the
 * data contract, never an empty-but-present object.
 */
async function loadGoogleSays(params: {
  connectionId: string;
  dateFrom: string;
  dateTo: string;
  paidByCampaign: PaidCampaignSlice[];
}): Promise<RevenuePanelSummary["googleSays"]> {
  const rows = await listCampaignFactsSummary({
    connectionId: params.connectionId,
    fromDay: params.dateFrom,
    toDay: params.dateTo,
  });
  if (rows.length === 0) return null;

  const byCampaign = rows.map((row) => ({
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    spendCents: Math.round(row.costMicros / 10_000),
    conversions: row.conversions,
    conversionsValueCents: Math.round(row.conversionsValue * 100),
    matchedUtmCampaign: matchCampaignNames(
      row.campaignName,
      params.paidByCampaign,
    ),
  }));

  return {
    spendCents: byCampaign.reduce((total, row) => total + row.spendCents, 0),
    conversions: byCampaign.reduce((total, row) => total + row.conversions, 0),
    conversionsValueCents: byCampaign.reduce(
      (total, row) => total + row.conversionsValueCents,
      0,
    ),
    byCampaign,
  };
}

/** Loads the full Google Ads revenue panel for one org/store/date range. Read-only. */
export async function loadGoogleAdsRevenuePanel(params: {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<RevenuePanelSummary> {
  const [connection, ourSide] = await Promise.all([
    getPilotGoogleAdsConnectionForOrganization(params.organizationId),
    loadOurSide(params),
  ]);

  const googleSays = connection
    ? await loadGoogleSays({
        connectionId: connection.id,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        paidByCampaign: ourSide.paidByCampaign,
      })
    : null;

  return {
    connection: connection
      ? {
          status: connection.status,
          lastFactsSyncedAt: connection.lastFactsSyncedAt,
          backfillCompletedAt: connection.backfillCompletedAt,
        }
      : null,
    googleCurrencyCode: connection?.currencyCode ?? null,
    ourSide,
    googleSays,
  };
}
