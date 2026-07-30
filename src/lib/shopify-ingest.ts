/**
 * Shopify order/refund mapping (pure, unit-tested) plus the DB upsert layer
 * used by the Trigger.dev sync tasks.
 */

import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaigns } from "@/schema/campaign";
import {
  shopifyOrders,
  shopifyRefunds,
  shopifyStores,
  shopifySyncRuns,
} from "@/schema/shopify";
import {
  assignBucket,
  BUCKET_RULE_VERSION,
  type AttributionBucket,
} from "@/lib/attribution-bucket";
import {
  fetchOrdersByIds,
  type ShopifyOrderNode,
  type ShopifyRefund,
  type ShopifyRefundLineItem,
} from "@/lib/shopify-admin";

const UPSERT_BATCH_SIZE = 200;

/* ------------------------------------------------------------------ */
/* Money helpers — integer cents internally, decimal strings at the edge */
/* ------------------------------------------------------------------ */

const DECIMAL_PATTERN = /^(-?)(\d*)(?:\.(\d+))?$/;

/** Parses a Shopify money string into integer cents without float drift. */
export function toCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined) return 0;
  const raw = String(amount).trim();
  if (raw.length === 0) return 0;

  const match = DECIMAL_PATTERN.exec(raw);
  if (!match) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }

  const [, sign, whole, fraction = ""] = match;
  const padded = `${fraction}00`;
  const cents =
    Number(whole || "0") * 100 +
    Number(padded.slice(0, 2)) +
    (Number(fraction[2] ?? "0") >= 5 ? 1 : 0);

  return sign === "-" ? -cents : cents;
}

/** Renders integer cents back into a numeric-column-safe decimal string. */
export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function moneyCents(
  set: { shopMoney?: { amount?: string | null } | null } | null | undefined,
): number {
  return toCents(set?.shopMoney?.amount ?? null);
}

/* ------------------------------------------------------------------ */
/* Day derivation                                                      */
/* ------------------------------------------------------------------ */

/** YYYY-MM-DD of `isoTimestamp` as seen in the store's timezone. */
export function deriveDayInTimezone(
  isoTimestamp: string | Date,
  ianaTimezone: string,
): string {
  const date =
    isoTimestamp instanceof Date ? isoTimestamp : new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(isoTimestamp)}`);
  }

  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/* ------------------------------------------------------------------ */
/* Net sales arithmetic (identity-critical — see attribution spec §5)   */
/* ------------------------------------------------------------------ */

/**
 * Σ refundLineItems.subtotalSet, minus Σ refundLineItems.totalTaxSet only when
 * the order books taxes inside its prices.
 */
export function refundAmountCents(
  refund: ShopifyRefund,
  taxesIncluded: boolean,
): number {
  const lineItems = refund.refundLineItems?.nodes ?? [];
  let cents = 0;

  for (const lineItem of lineItems) {
    cents += moneyCents(lineItem.subtotalSet);
    if (taxesIncluded) cents -= moneyCents(lineItem.totalTaxSet);
  }

  return cents;
}

/**
 * Net sales as booked on the order day: the *current* subtotal (which already
 * reflects order edits and refunds) plus every refund added back.
 */
export function netSalesCents(order: ShopifyOrderNode): number {
  const taxesIncluded = order.taxesIncluded === true;
  const currentSubtotal =
    moneyCents(order.currentSubtotalPriceSet) -
    (taxesIncluded ? moneyCents(order.currentTotalTaxSet) : 0);

  const refundedBack = (order.refunds ?? []).reduce(
    (total, refund) => total + refundAmountCents(refund, taxesIncluded),
    0,
  );

  return currentSubtotal + refundedBack;
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

export type ShopifyOrderRow = {
  organizationId: string;
  storeId: string;
  shopifyOrderId: string;
  orderCreatedAt: Date;
  orderUpdatedAt: Date | null;
  orderDay: string;
  netSales: string;
  taxesIncluded: boolean | null;
  customerJourney: Record<string, unknown> | null;
  journeyReady: boolean;
  pendingSince: Date | null;
  lastClickUtmSource: string | null;
  lastClickUtmMedium: string | null;
  lastClickUtmCampaign: string | null;
  cancelledAt: Date | null;
  orderSourceName: string | null;
};

export type ShopifyRefundRow = {
  organizationId: string;
  storeId: string;
  shopifyOrderId: string;
  shopifyRefundId: string;
  refundDay: string;
  amount: string;
  refundCreatedAt: Date | null;
};

export type MapContext = {
  organizationId: string;
  storeId: string;
  storeTimezone: string;
  now?: Date;
};

function lowercaseOrNull(value: string | null | undefined) {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function toDateOrNull(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Test orders never enter the identity — callers must drop them. */
export function isTestOrder(order: ShopifyOrderNode) {
  return order.test === true;
}

export function mapOrderToRow(
  order: ShopifyOrderNode,
  context: MapContext,
): ShopifyOrderRow {
  const journey = order.customerJourneySummary ?? null;
  const journeyReady = journey?.ready === true;
  const utm = journey?.lastVisit?.utmParameters ?? null;
  const now = context.now ?? new Date();

  return {
    organizationId: context.organizationId,
    storeId: context.storeId,
    shopifyOrderId: order.id,
    orderCreatedAt: new Date(order.createdAt),
    orderUpdatedAt: toDateOrNull(order.updatedAt),
    orderDay: deriveDayInTimezone(order.createdAt, context.storeTimezone),
    netSales: centsToAmount(netSalesCents(order)),
    taxesIncluded: order.taxesIncluded ?? null,
    customerJourney: journey
      ? (journey as unknown as Record<string, unknown>)
      : null,
    journeyReady,
    pendingSince: journeyReady ? null : now,
    lastClickUtmSource: lowercaseOrNull(utm?.source),
    lastClickUtmMedium: lowercaseOrNull(utm?.medium),
    lastClickUtmCampaign: lowercaseOrNull(utm?.campaign),
    cancelledAt: toDateOrNull(order.cancelledAt),
    orderSourceName: order.sourceName ?? null,
  };
}

export function mapRefundRows(
  order: ShopifyOrderNode,
  context: MapContext,
): ShopifyRefundRow[] {
  const taxesIncluded = order.taxesIncluded === true;

  return (order.refunds ?? []).map((refund) => ({
    organizationId: context.organizationId,
    storeId: context.storeId,
    shopifyOrderId: order.id,
    shopifyRefundId: refund.id,
    refundDay: deriveDayInTimezone(
      refund.createdAt ?? order.createdAt,
      context.storeTimezone,
    ),
    amount: centsToAmount(refundAmountCents(refund, taxesIncluded)),
    refundCreatedAt: toDateOrNull(refund.createdAt),
  }));
}

/* ------------------------------------------------------------------ */
/* Bulk JSONL assembly                                                 */
/* ------------------------------------------------------------------ */

type JsonlLine = Record<string, unknown> & {
  id?: string;
  __parentId?: string;
};

/**
 * Rebuilds order nodes from a bulk JSONL export. Connections arrive as separate
 * lines carrying `__parentId`; `refunds` is a plain list field so it usually
 * stays inline on the order line.
 */
export function groupBulkOrderLines(lines: JsonlLine[]): ShopifyOrderNode[] {
  const orders: ShopifyOrderNode[] = [];
  const childrenByParent = new Map<string, JsonlLine[]>();

  for (const line of lines) {
    const parentId = line.__parentId;
    if (typeof parentId === "string") {
      const bucket = childrenByParent.get(parentId) ?? [];
      bucket.push(line);
      childrenByParent.set(parentId, bucket);
      continue;
    }
    if (typeof line.id === "string" && line.id.includes("/Order/")) {
      orders.push(line as unknown as ShopifyOrderNode);
    }
  }

  for (const order of orders) {
    const children = childrenByParent.get(order.id) ?? [];
    const standaloneRefunds = children.filter(
      (child) => typeof child.id === "string" && child.id.includes("/Refund/"),
    ) as unknown as ShopifyRefund[];

    const refunds = [...(order.refunds ?? []), ...standaloneRefunds];

    for (const refund of refunds) {
      if (refund.refundLineItems?.nodes?.length) continue;
      const lineItems = childrenByParent.get(refund.id) ?? [];
      if (lineItems.length > 0) {
        refund.refundLineItems = {
          nodes: lineItems as unknown as ShopifyRefundLineItem[],
        };
      }
    }

    order.refunds = refunds;
  }

  return orders;
}

/**
 * Bulk exports that had to drop nested refund line items leave refunds without
 * amounts; re-fetch those orders through the paginated query instead of
 * silently dropping refunds.
 */
export async function hydrateRefundLineItems(
  orders: ShopifyOrderNode[],
): Promise<{ orders: ShopifyOrderNode[]; hydrated: number }> {
  const needsHydration = orders.filter((order) =>
    (order.refunds ?? []).some((refund) => !refund.refundLineItems?.nodes),
  );

  if (needsHydration.length === 0) return { orders, hydrated: 0 };

  const hydrated = await fetchOrdersByIds(
    needsHydration.map((order) => order.id),
  );
  const byId = new Map(hydrated.map((order) => [order.id, order]));

  return {
    orders: orders.map((order) => byId.get(order.id) ?? order),
    hydrated: hydrated.length,
  };
}

/* ------------------------------------------------------------------ */
/* DB layer                                                           */
/* ------------------------------------------------------------------ */

export type ShopifyStoreRecord = {
  id: string;
  organizationId: string;
  shopDomain: string;
  ianaTimezone: string;
  currency: string | null;
};

export async function upsertShopifyStore(params: {
  organizationId: string;
  shopDomain: string;
  ianaTimezone: string;
  currency: string | null;
}): Promise<ShopifyStoreRecord> {
  const [store] = await db
    .insert(shopifyStores)
    .values({
      organizationId: params.organizationId,
      shopDomain: params.shopDomain,
      ianaTimezone: params.ianaTimezone,
      currency: params.currency,
    })
    .onConflictDoUpdate({
      target: shopifyStores.shopDomain,
      set: {
        organizationId: params.organizationId,
        ianaTimezone: params.ianaTimezone,
        currency: params.currency,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      currency: shopifyStores.currency,
    });

  return store;
}

export async function getShopifyStoreByDomain(
  shopDomain: string,
): Promise<ShopifyStoreRecord | null> {
  const [store] = await db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      currency: shopifyStores.currency,
    })
    .from(shopifyStores)
    .where(eq(shopifyStores.shopDomain, shopDomain))
    .limit(1);

  return store ?? null;
}

export async function listShopifyStores(): Promise<ShopifyStoreRecord[]> {
  return db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      currency: shopifyStores.currency,
    })
    .from(shopifyStores);
}

export async function touchStoreLastSyncedAt(storeId: string) {
  await db
    .update(shopifyStores)
    .set({ lastSyncedAt: new Date() })
    .where(eq(shopifyStores.id, storeId));
}

export async function startSyncRun(params: {
  organizationId: string;
  storeId: string;
  triggerType: string;
  phase: "backfill" | "incremental" | "rebucket";
  dateFrom?: string | null;
  dateTo?: string | null;
}) {
  const [run] = await db
    .insert(shopifySyncRuns)
    .values({
      organizationId: params.organizationId,
      storeId: params.storeId,
      triggerType: params.triggerType,
      phase: params.phase,
      dateFrom: params.dateFrom ?? null,
      dateTo: params.dateTo ?? null,
      result: "running",
    })
    .returning({
      id: shopifySyncRuns.id,
      requestedAt: shopifySyncRuns.requestedAt,
    });

  return run;
}

export async function finishSyncRun(params: {
  runId: string;
  result: "success" | "failed";
  ordersSynced?: number;
  error?: string | null;
  meta?: Record<string, unknown> | null;
}) {
  await db
    .update(shopifySyncRuns)
    .set({
      result: params.result,
      ordersSynced: params.ordersSynced ?? null,
      error: params.error ?? null,
      meta: params.meta ?? null,
      finishedAt: new Date(),
    })
    .where(eq(shopifySyncRuns.id, params.runId));
}

/** Started-at of the newest successful run, used as the incremental watermark. */
export async function getLastSuccessfulRunStartedAt(params: {
  storeId: string;
  phase?: "backfill" | "incremental";
}): Promise<Date | null> {
  const conditions = [
    eq(shopifySyncRuns.storeId, params.storeId),
    eq(shopifySyncRuns.result, "success"),
  ];
  if (params.phase) conditions.push(eq(shopifySyncRuns.phase, params.phase));

  const [run] = await db
    .select({ requestedAt: shopifySyncRuns.requestedAt })
    .from(shopifySyncRuns)
    .where(and(...conditions))
    .orderBy(sql`${shopifySyncRuns.requestedAt} desc`)
    .limit(1);

  return run?.requestedAt ?? null;
}

export async function loadSyncedMetaCampaignIds(
  organizationId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ metaId: campaigns.metaId })
    .from(campaigns)
    .where(eq(campaigns.organizationId, organizationId));

  const ids = new Set<string>();
  for (const row of rows) {
    const metaId = row.metaId?.trim().toLowerCase();
    if (metaId) ids.add(metaId);
  }
  return ids;
}

async function upsertOrderRows(rows: ShopifyOrderRow[]) {
  const idByShopifyOrderId = new Map<string, string>();

  for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + UPSERT_BATCH_SIZE);
    const inserted = await db
      .insert(shopifyOrders)
      .values(batch)
      .onConflictDoUpdate({
        target: [shopifyOrders.storeId, shopifyOrders.shopifyOrderId],
        set: {
          organizationId: sql`excluded.organization_id`,
          orderCreatedAt: sql`excluded.order_created_at`,
          orderUpdatedAt: sql`excluded.order_updated_at`,
          orderDay: sql`excluded.order_day`,
          netSales: sql`excluded.net_sales`,
          taxesIncluded: sql`excluded.taxes_included`,
          customerJourney: sql`excluded.customer_journey`,
          journeyReady: sql`excluded.journey_ready`,
          // Keep the original pendingSince while an order stays unresolved.
          pendingSince: sql`case when excluded.journey_ready then null else coalesce(${shopifyOrders.pendingSince}, excluded.pending_since) end`,
          lastClickUtmSource: sql`excluded.last_click_utm_source`,
          lastClickUtmMedium: sql`excluded.last_click_utm_medium`,
          lastClickUtmCampaign: sql`excluded.last_click_utm_campaign`,
          cancelledAt: sql`excluded.cancelled_at`,
          orderSourceName: sql`excluded.order_source_name`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: shopifyOrders.id,
        shopifyOrderId: shopifyOrders.shopifyOrderId,
      });

    for (const row of inserted) {
      idByShopifyOrderId.set(row.shopifyOrderId, row.id);
    }
  }

  return idByShopifyOrderId;
}

async function upsertRefundRows(
  rows: ShopifyRefundRow[],
  orderIdByShopifyOrderId: Map<string, string>,
) {
  const values = rows
    .map((row) => {
      const orderId = orderIdByShopifyOrderId.get(row.shopifyOrderId);
      if (!orderId) return null;
      return {
        organizationId: row.organizationId,
        storeId: row.storeId,
        orderId,
        shopifyRefundId: row.shopifyRefundId,
        refundDay: row.refundDay,
        amount: row.amount,
        refundCreatedAt: row.refundCreatedAt,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  for (let index = 0; index < values.length; index += UPSERT_BATCH_SIZE) {
    const batch = values.slice(index, index + UPSERT_BATCH_SIZE);
    await db
      .insert(shopifyRefunds)
      .values(batch)
      .onConflictDoUpdate({
        target: [shopifyRefunds.storeId, shopifyRefunds.shopifyRefundId],
        set: {
          organizationId: sql`excluded.organization_id`,
          orderId: sql`excluded.order_id`,
          refundDay: sql`excluded.refund_day`,
          amount: sql`excluded.amount`,
          refundCreatedAt: sql`excluded.refund_created_at`,
        },
      });
  }

  return values.length;
}

/** Maps + upserts a page of order nodes together with their refunds. */
export async function ingestOrderNodes(params: {
  organizationId: string;
  store: { id: string; ianaTimezone: string };
  orders: ShopifyOrderNode[];
  now?: Date;
}): Promise<{
  ordersUpserted: number;
  refundsUpserted: number;
  testOrdersSkipped: number;
}> {
  const context: MapContext = {
    organizationId: params.organizationId,
    storeId: params.store.id,
    storeTimezone: params.store.ianaTimezone,
    now: params.now,
  };

  const liveOrders = params.orders.filter((order) => !isTestOrder(order));
  const testOrdersSkipped = params.orders.length - liveOrders.length;

  if (liveOrders.length === 0) {
    return { ordersUpserted: 0, refundsUpserted: 0, testOrdersSkipped };
  }

  const orderRows = liveOrders.map((order) => mapOrderToRow(order, context));
  const refundRows = liveOrders.flatMap((order) =>
    mapRefundRows(order, context),
  );

  const orderIds = await upsertOrderRows(orderRows);
  const refundsUpserted = await upsertRefundRows(refundRows, orderIds);

  return {
    ordersUpserted: orderRows.length,
    refundsUpserted,
    testOrdersSkipped,
  };
}

/** Orders whose customer journey is still unresolved and worth re-polling. */
export async function listOrdersNeedingJourneyRepoll(params: {
  storeId: string;
  withinDays?: number;
  limit?: number;
}): Promise<string[]> {
  const cutoff = new Date(
    Date.now() - (params.withinDays ?? 3) * 24 * 60 * 60 * 1000,
  );

  const rows = await db
    .select({ shopifyOrderId: shopifyOrders.shopifyOrderId })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.journeyReady, false),
        gt(shopifyOrders.pendingSince, cutoff),
      ),
    )
    .limit(params.limit ?? 1000);

  return rows.map((row) => row.shopifyOrderId);
}

type BucketCandidate = {
  id: string;
  orderSourceName: string | null;
  journeyReady: boolean;
  lastClickUtmSource: string | null;
  lastClickUtmMedium: string | null;
  lastClickUtmCampaign: string | null;
  customerJourney: Record<string, unknown> | null;
};

function candidateLastVisit(candidate: BucketCandidate) {
  const journey = candidate.customerJourney as
    | { lastVisit?: Record<string, unknown> | null }
    | null;
  const lastVisit = journey?.lastVisit ?? null;

  if (
    !lastVisit &&
    !candidate.lastClickUtmSource &&
    !candidate.lastClickUtmMedium &&
    !candidate.lastClickUtmCampaign
  ) {
    return null;
  }

  return {
    utmSource: candidate.lastClickUtmSource,
    utmMedium: candidate.lastClickUtmMedium,
    utmCampaign: candidate.lastClickUtmCampaign,
    referrerUrl: (lastVisit?.referrerUrl as string | null) ?? null,
    source: (lastVisit?.source as string | null) ?? null,
  };
}

/**
 * Writes buckets for rows that need one.
 *  - "pending": freshly upserted rows (no bucket yet, or an older rule version)
 *  - "rebucket": every row on an older rule version or awaiting Meta verification
 */
export async function stampBuckets(params: {
  organizationId: string;
  storeId: string;
  scope?: "pending" | "rebucket";
  syncedMetaCampaignIds?: ReadonlySet<string>;
}): Promise<{ scanned: number; stamped: number }> {
  const scope = params.scope ?? "pending";
  const syncedMetaCampaignIds =
    params.syncedMetaCampaignIds ??
    (await loadSyncedMetaCampaignIds(params.organizationId));

  const staleVersion = or(
    isNull(shopifyOrders.bucketRuleVersion),
    lt(shopifyOrders.bucketRuleVersion, BUCKET_RULE_VERSION),
  );

  // Non-web orders never get a ready journey, but they are still bucketable
  // (rule 1 → untracked), so they must not be gated on journeyReady.
  const needsFirstStamp = and(
    isNull(shopifyOrders.bucket),
    or(
      eq(shopifyOrders.journeyReady, true),
      isNull(shopifyOrders.orderSourceName),
      sql`lower(${shopifyOrders.orderSourceName}) <> 'web'`,
    ),
  );

  const where =
    scope === "rebucket"
      ? and(
          eq(shopifyOrders.storeId, params.storeId),
          or(
            staleVersion,
            eq(shopifyOrders.verificationPending, true),
            needsFirstStamp,
          ),
        )
      : and(
          eq(shopifyOrders.storeId, params.storeId),
          or(needsFirstStamp, staleVersion),
        );

  const candidates: BucketCandidate[] = await db
    .select({
      id: shopifyOrders.id,
      orderSourceName: shopifyOrders.orderSourceName,
      journeyReady: shopifyOrders.journeyReady,
      lastClickUtmSource: shopifyOrders.lastClickUtmSource,
      lastClickUtmMedium: shopifyOrders.lastClickUtmMedium,
      lastClickUtmCampaign: shopifyOrders.lastClickUtmCampaign,
      customerJourney: shopifyOrders.customerJourney,
    })
    .from(shopifyOrders)
    .where(where);

  type Group = {
    bucket: AttributionBucket;
    metaVerified: boolean;
    metaCampaignId: string | null;
    verificationPending: boolean;
    ids: string[];
  };
  const groups = new Map<string, Group>();

  for (const candidate of candidates) {
    const result = assignBucket({
      orderSourceName: candidate.orderSourceName,
      journeyReady: candidate.journeyReady,
      lastVisit: candidateLastVisit(candidate),
      syncedMetaCampaignIds,
    });

    // Still pending: leave the row unbucketed for the next run.
    if (!result.bucket) continue;

    const key = [
      result.bucket,
      result.metaVerified,
      result.metaCampaignId ?? "",
      result.verificationPending,
    ].join("|");

    const group = groups.get(key) ?? {
      bucket: result.bucket,
      metaVerified: result.metaVerified,
      metaCampaignId: result.metaCampaignId,
      verificationPending: result.verificationPending,
      ids: [],
    };
    group.ids.push(candidate.id);
    groups.set(key, group);
  }

  let stamped = 0;

  for (const group of groups.values()) {
    for (let index = 0; index < group.ids.length; index += UPSERT_BATCH_SIZE) {
      const ids = group.ids.slice(index, index + UPSERT_BATCH_SIZE);
      await db
        .update(shopifyOrders)
        .set({
          bucket: group.bucket,
          bucketRuleVersion: BUCKET_RULE_VERSION,
          metaVerified: group.metaVerified,
          metaCampaignId: group.metaCampaignId,
          verificationPending: group.verificationPending,
          updatedAt: new Date(),
        })
        .where(inArray(shopifyOrders.id, ids));
      stamped += ids.length;
    }
  }

  return { scanned: candidates.length, stamped };
}
