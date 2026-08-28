import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import type { HalfOpenUtcWindow } from "@/lib/klaviyo/queries";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoMarketingObjects } from "@/schema/klaviyo-claim";

/**
 * Advisory read-only aggregates for the attribution page's email revenue
 * panel. Reads Shopify money and reads claims; never mutates buckets,
 * order rows, or match results. Every money value is summed in SQL and
 * travels as a numeric string.
 *
 * Revenue figures are refund-NET, mirroring the overview's
 * `getBucketTotals`: orders are windowed by `order_created_at` (half-open
 * UTC), refunds independently by the store-day `refund_day` column, and
 * every refund inherits its PARENT ORDER's classification — even when
 * that parent lies outside the window. That keeps the panel's partition
 * summing to the page's headline total by construction.
 */

export type EmailAttributionBucket = { orders: number; revenue: string };

export type EmailAttributionSource = {
  objectId: string;
  objectType: "campaign" | "flow";
  name: string;
  orderCount: number;
  revenue: string;
  klaviyoConversionValue: string | null;
  klaviyoWindow: { requestedFrom: Date; requestedTo: Date; asOf: Date } | null;
};

export type EmailAttributionProduct = {
  productKey: string;
  title: string;
  units: number;
  orderCount: number;
  orderRevenue: string;
};

export type EmailAttributionSummary = {
  email: {
    revenue: string;
    orderCount: number;
    campaignsRevenue: string;
    flowsRevenue: string;
  };
  klaviyoSays: {
    conversionValue: string;
    requestedFrom: Date;
    requestedTo: Date;
    asOf: Date;
  } | null;
  sources: EmailAttributionSource[];
  products: EmailAttributionProduct[];
  /**
   * Of the confirmed orders in range carrying a conversion event, how many
   * have had their claims fetched. `covered < total` means the panel's
   * email figure is still filling in, not that email did nothing.
   */
  claimCoverage: { covered: number; total: number };
  gaps: {
    noEmailLink: EmailAttributionBucket;
    claimsPending: EmailAttributionBucket;
    notEvaluated: EmailAttributionBucket;
    noKlaviyoEvent: EmailAttributionBucket;
    duplicateFlagged: EmailAttributionBucket;
    unmatchedEvents: number;
  };
};

const ZERO_BUCKET: EmailAttributionBucket = { orders: 0, revenue: "0.00" };

/**
 * A claim qualifies an order as email-linked when it points at a campaign
 * or flow and is not a bot click. `r` is the current (unsuperseded)
 * order-match-result alias in the enclosing query.
 */
const QUALIFYING_CLAIM = sql`
  select 1 from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1`;

/**
 * A conversion whose claims have never been fetched. Distinguishing this
 * from a real "no campaign/flow link" matters: an unfetched order is not
 * evidence that email did nothing, and conflating them overstated the
 * no-link bucket by the size of the claims backlog.
 */
const CLAIMS_COVERED = sql`
  select 1 from klaviyo_claim_replay_state s
   where s.connection_id = r.connection_id
     and s.conversion_event_id = r.selected_event_id
     and s.status = 'complete'`;

/**
 * Last non-bot touch decides campaign-vs-flow assignment. Ties on
 * timestamp (or all-null timestamps) break deterministically on the
 * provider attribution id.
 */
const PRIMARY_CLAIM_LATERAL = sql`
  select case when c.campaign_object_id is not null then 'campaign'
              else 'flow' end as kind,
         coalesce(c.campaign_object_id, c.flow_object_id) as object_id
    from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1
   order by c.interaction_occurred_at desc nulls last,
            c.klaviyo_attribution_id desc
   limit 1`;

/**
 * Bucket assignment shared by the order partition and its refund mirror.
 * `r` is the current (unsuperseded) match-result alias left-joined in the
 * enclosing query.
 */
const BUCKET_CASE = sql`
  case
    when r.id is null then 'not_evaluated'
    when r.status = 'no_klaviyo_event' then 'no_klaviyo_event'
    when r.status = 'duplicate_conversion_events' then 'duplicate_flagged'
    when r.status = 'confirmed'
         and r.selected_event_id is not null
         and exists (${QUALIFYING_CLAIM}) then 'email_linked'
    -- Below email_linked deliberately: a qualifying claim is proof Klaviyo
    -- credited a campaign, and proof outranks coverage status.
    when r.status = 'confirmed'
         and r.selected_event_id is not null
         and not exists (${CLAIMS_COVERED}) then 'claims_pending'
    else 'no_email_link'
  end`;

/**
 * node-postgres serializes a raw Date parameter for a naive `timestamp`
 * column in the PROCESS's local time, while these columns store UTC wall
 * time — off-UTC environments would shift every window boundary by the
 * local offset. Interpolate the UTC ISO text and cast; Postgres drops the
 * trailing Z and keeps the UTC wall-clock value.
 */
function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

/** Left join of the current match result onto an `o` shopify_order alias. */
function currentResultLeftJoin(scope: KlaviyoConnectionScope) {
  return sql`
    left join klaviyo_order_match_result r
      on r.organization_id = o.organization_id
     and r.shopify_store_id = o.store_id
     and r.connection_id = ${scope.connectionId}
     and r.order_id = o.id
     and r.superseded_at is null`;
}

/**
 * Confirms an `o` shopify_order alias as email-linked and exposes the
 * primary claim as `pc` (kind, object_id).
 */
function emailLinkJoin(scope: KlaviyoConnectionScope) {
  return sql`
    join klaviyo_order_match_result r
      on r.organization_id = o.organization_id
     and r.shopify_store_id = o.store_id
     and r.connection_id = ${scope.connectionId}
     and r.order_id = o.id
     and r.superseded_at is null
     and r.status = 'confirmed'
     and r.selected_event_id is not null
    cross join lateral (${PRIMARY_CLAIM_LATERAL}) pc`;
}

function emailLinkedFrom(scope: KlaviyoConnectionScope, window: HalfOpenUtcWindow) {
  return sql`
    from shopify_order o
    ${emailLinkJoin(scope)}
   where o.organization_id = ${scope.organizationId}
     and o.store_id = ${scope.storeId}
     and o.order_created_at >= ${utcTimestamp(window.from)}
     and o.order_created_at < ${utcTimestamp(window.to)}`;
}

/**
 * In-window refunds (store-day windowed on `refund_day`, mirroring the
 * overview's `refundRangeWhere`) whose parent order is email-linked. The
 * parent carries NO window filter: a refund landing in range nets against
 * its source even when the order itself is out of range, exactly like
 * `getBucketTotals`.
 */
function emailLinkedRefundsFrom(
  scope: KlaviyoConnectionScope,
  days: StoreDayRange,
) {
  return sql`
    from shopify_refund rf
    join shopify_order o
      on o.organization_id = rf.organization_id
     and o.store_id = rf.store_id
     and o.id = rf.order_id
    ${emailLinkJoin(scope)}
   where rf.organization_id = ${scope.organizationId}
     and rf.store_id = ${scope.storeId}
     and rf.refund_day between ${days.dateFrom} and ${days.dateTo}`;
}

/** Inclusive store-timezone day strings, e.g. "2026-07-01". */
export type StoreDayRange = { dateFrom: string; dateTo: string };

export async function loadEmailAttribution(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  /** Refund window: refunds are day-bucketed, not timestamped. */
  days: StoreDayRange;
}): Promise<EmailAttributionSummary> {
  const { scope, window, days } = input;

  // 1. Partition: every order in range lands in exactly one bucket;
  // in-window refunds net against their parent order's bucket.
  const partition = await db.execute<{
    bucket: string;
    orders: number;
    revenue: string;
  }>(sql`
    with order_buckets as (
      select ${BUCKET_CASE} as bucket,
             count(*)::int as orders,
             coalesce(sum(o.net_sales), 0) as gross
        from shopify_order o
        ${currentResultLeftJoin(scope)}
       where o.organization_id = ${scope.organizationId}
         and o.store_id = ${scope.storeId}
         and o.order_created_at >= ${utcTimestamp(window.from)}
         and o.order_created_at < ${utcTimestamp(window.to)}
       group by 1
    ),
    refund_buckets as (
      select ${BUCKET_CASE} as bucket,
             sum(rf.amount) as refunded
        from shopify_refund rf
        join shopify_order o
          on o.organization_id = rf.organization_id
         and o.store_id = rf.store_id
         and o.id = rf.order_id
        ${currentResultLeftJoin(scope)}
       where rf.organization_id = ${scope.organizationId}
         and rf.store_id = ${scope.storeId}
         and rf.refund_day between ${days.dateFrom} and ${days.dateTo}
       group by 1
    )
    select coalesce(ob.bucket, rb.bucket) as bucket,
           coalesce(ob.orders, 0) as orders,
           round(coalesce(ob.gross, 0) - coalesce(rb.refunded, 0), 2)::text
             as revenue
      from order_buckets ob
      full outer join refund_buckets rb on rb.bucket = ob.bucket`);

  const buckets = new Map(
    partition.rows.map((row) => [
      row.bucket,
      { orders: row.orders, revenue: row.revenue },
    ]),
  );
  const bucket = (key: string): EmailAttributionBucket =>
    buckets.get(key) ?? ZERO_BUCKET;

  // 2. Headline split, summed in SQL so money never crosses JS floats.
  // Revenue is refund-net; orderCount stays the in-window linked orders.
  const headline = await db.execute<{
    orders: number;
    revenue: string;
    campaigns_revenue: string;
    flows_revenue: string;
  }>(sql`
    with linked_orders as (
      select count(*)::int as orders,
             coalesce(sum(o.net_sales), 0) as gross,
             coalesce(sum(o.net_sales)
               filter (where pc.kind = 'campaign'), 0) as campaigns_gross,
             coalesce(sum(o.net_sales)
               filter (where pc.kind = 'flow'), 0) as flows_gross
      ${emailLinkedFrom(scope, window)}
    ),
    linked_refunds as (
      select coalesce(sum(rf.amount), 0) as refunded,
             coalesce(sum(rf.amount)
               filter (where pc.kind = 'campaign'), 0) as campaigns_refunded,
             coalesce(sum(rf.amount)
               filter (where pc.kind = 'flow'), 0) as flows_refunded
      ${emailLinkedRefundsFrom(scope, days)}
    )
    select lo.orders,
           round(lo.gross - lr.refunded, 2)::text as revenue,
           round(lo.campaigns_gross - lr.campaigns_refunded, 2)::text
             as campaigns_revenue,
           round(lo.flows_gross - lr.flows_refunded, 2)::text as flows_revenue
      from linked_orders lo
     cross join linked_refunds lr`);
  const head = headline.rows[0];

  // 3. Per-source rows by primary claim, net of refunds classified through
  // the parent order's own primary claim.
  const sourceRows = await db.execute<{
    kind: "campaign" | "flow";
    object_id: string;
    orders: number;
    revenue: string;
  }>(sql`
    with source_orders as (
      select pc.kind, pc.object_id,
             count(*)::int as orders,
             coalesce(sum(o.net_sales), 0) as gross
      ${emailLinkedFrom(scope, window)}
       group by 1, 2
    ),
    source_refunds as (
      select pc.kind, pc.object_id,
             sum(rf.amount) as refunded
      ${emailLinkedRefundsFrom(scope, days)}
       group by 1, 2
    )
    select coalesce(so.kind, sr.kind) as kind,
           coalesce(so.object_id, sr.object_id) as object_id,
           coalesce(so.orders, 0) as orders,
           round(coalesce(so.gross, 0) - coalesce(sr.refunded, 0), 2)::text
             as revenue
      from source_orders so
      full outer join source_refunds sr
        on sr.kind = so.kind and sr.object_id = so.object_id
     order by coalesce(so.gross, 0) - coalesce(sr.refunded, 0) desc,
              coalesce(so.object_id, sr.object_id) asc`);

  const objectIds = sourceRows.rows.map((row) => row.object_id);
  const objects = objectIds.length
    ? await db
        .select({
          id: klaviyoMarketingObjects.id,
          name: klaviyoMarketingObjects.name,
        })
        .from(klaviyoMarketingObjects)
        .where(
          and(
            eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
            inArray(klaviyoMarketingObjects.id, objectIds),
          ),
        )
    : [];
  const nameById = new Map(objects.map((object) => [object.id, object.name]));

  // 4. Klaviyo's own campaign report facts (current generation only) —
  // their windows travel with the numbers; nothing is re-sliced. Facts
  // arrive one row per (campaign, send-date) grouping, so per-campaign
  // values are summed in SQL; the headline total below spans the same
  // generation without the campaign filter, so facts with no campaign
  // attribution still count toward it.
  const factRows = await db.execute<{
    campaign_object_id: string;
    conversion_value: string;
    requested_from: Date;
    requested_to: Date;
    as_of: Date;
  }>(sql`
    select f.campaign_object_id,
           round(sum(f.conversion_value), 2)::text as conversion_value,
           min(f.requested_from) as requested_from,
           max(f.requested_to) as requested_to,
           max(f.as_of) as as_of
      from klaviyo_report_fact f
      join klaviyo_report_generation g on g.id = f.generation_id
     where g.organization_id = ${scope.organizationId}
       and g.shopify_store_id = ${scope.storeId}
       and g.connection_id = ${scope.connectionId}
       and g.kind = 'campaign'
       and g.status = 'current'
       and f.conversion_value is not null
       and f.campaign_object_id is not null
     group by f.campaign_object_id`);
  const factByCampaign = new Map(
    factRows.rows.map((row) => [row.campaign_object_id, row]),
  );
  const saysTotal = await db.execute<{
    conversion_value: string | null;
    requested_from: Date | null;
    requested_to: Date | null;
    as_of: Date | null;
  }>(sql`
    select round(sum(f.conversion_value), 2)::text as conversion_value,
           min(f.requested_from) as requested_from,
           max(f.requested_to) as requested_to,
           max(f.as_of) as as_of
      from klaviyo_report_fact f
      join klaviyo_report_generation g on g.id = f.generation_id
     where g.organization_id = ${scope.organizationId}
       and g.shopify_store_id = ${scope.storeId}
       and g.connection_id = ${scope.connectionId}
       and g.kind = 'campaign'
       and g.status = 'current'
       and f.conversion_value is not null`);
  const says = saysTotal.rows[0];

  // 5. Top products inside email-linked orders (UI shows 10, expands to the
  // fetched 25). shopify_order_line has no
  // money column, so "orderRevenue" is the summed net_sales of the linked
  // orders containing the product — an order with several products counts
  // toward each (labeled in the UI).
  // `emailLinkedFrom` ends in a WHERE clause, so the line join lives in a
  // CTE consumer, never appended after it.
  const productRows = await db.execute<{
    product_key: string;
    title: string;
    units: number;
    order_count: number;
    order_revenue: string;
  }>(sql`
    with linked as (
      select o.id as order_id, o.net_sales
      ${emailLinkedFrom(scope, window)}
    )
    select product_key,
           min(title) as title,
           sum(units)::int as units,
           count(*)::int as order_count,
           round(sum(net_sales), 2)::text as order_revenue
      from (
        select coalesce(l.shopify_product_id, 'title:' || l.product_title)
                 as product_key,
               min(l.product_title) as title,
               sum(l.quantity) as units,
               l.order_id,
               min(linked.net_sales) as net_sales
          from shopify_order_line l
          join linked on linked.order_id = l.order_id
         where l.organization_id = ${scope.organizationId}
           and l.store_id = ${scope.storeId}
         group by 1, l.order_id
      ) per_order
     group by product_key
     order by sum(net_sales) desc, product_key asc
     limit 25`);

  // 6. Range's non-confirmed placed-order events (same predicate as the
  // Lab's unmatched ledger).
  const unmatched = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
      from klaviyo_event e
      join klaviyo_metric m on m.id = e.metric_id
      left join klaviyo_event_match_result er
        on er.connection_id = e.connection_id
       and er.event_id = e.id
       and er.superseded_at is null
     where e.organization_id = ${scope.organizationId}
       and e.shopify_store_id = ${scope.storeId}
       and e.connection_id = ${scope.connectionId}
       and m.canonical_kind = 'placed_order'
       and e.occurred_at >= ${utcTimestamp(window.from)}
       and e.occurred_at < ${utcTimestamp(window.to)}
       and (er.status is null or er.status <> 'confirmed')`);

  // 7. Claim coverage over the range's confirmed orders: how many have been
  // asked at all. Served by the partial index
  // (connection_id, conversion_event_id) WHERE status = 'complete'.
  const coverage = await db.execute<{ covered: number; total: number }>(sql`
    select count(*) filter (where exists (${CLAIMS_COVERED}))::int as covered,
           count(*)::int as total
      from shopify_order o
      join klaviyo_order_match_result r
        on r.organization_id = o.organization_id
       and r.shopify_store_id = o.store_id
       and r.connection_id = ${scope.connectionId}
       and r.order_id = o.id
       and r.superseded_at is null
       and r.status = 'confirmed'
       and r.selected_event_id is not null
     where o.organization_id = ${scope.organizationId}
       and o.store_id = ${scope.storeId}
       and o.order_created_at >= ${utcTimestamp(window.from)}
       and o.order_created_at < ${utcTimestamp(window.to)}`);

  return {
    email: {
      revenue: head?.revenue ?? "0.00",
      orderCount: head?.orders ?? 0,
      campaignsRevenue: head?.campaigns_revenue ?? "0.00",
      flowsRevenue: head?.flows_revenue ?? "0.00",
    },
    klaviyoSays:
      says?.conversion_value != null &&
      says.requested_from !== null &&
      says.requested_to !== null &&
      says.as_of !== null
        ? {
            conversionValue: says.conversion_value,
            requestedFrom: says.requested_from,
            requestedTo: says.requested_to,
            asOf: says.as_of,
          }
        : null,
    sources: sourceRows.rows.map((row) => {
      const fact = factByCampaign.get(row.object_id);
      return {
        objectId: row.object_id,
        objectType: row.kind,
        name: nameById.get(row.object_id) ?? "",
        orderCount: row.orders,
        revenue: row.revenue,
        klaviyoConversionValue:
          row.kind === "campaign" ? (fact?.conversion_value ?? null) : null,
        klaviyoWindow:
          row.kind === "campaign" && fact
            ? {
                requestedFrom: fact.requested_from,
                requestedTo: fact.requested_to,
                asOf: fact.as_of,
              }
            : null,
      };
    }),
    products: productRows.rows.map((row) => ({
      productKey: row.product_key,
      title: row.title,
      units: row.units,
      orderCount: row.order_count,
      orderRevenue: row.order_revenue,
    })),
    claimCoverage: {
      covered: coverage.rows[0]?.covered ?? 0,
      total: coverage.rows[0]?.total ?? 0,
    },
    gaps: {
      noEmailLink: bucket("no_email_link"),
      claimsPending: bucket("claims_pending"),
      notEvaluated: bucket("not_evaluated"),
      noKlaviyoEvent: bucket("no_klaviyo_event"),
      duplicateFlagged: bucket("duplicate_flagged"),
      unmatchedEvents: unmatched.rows[0]?.count ?? 0,
    },
  };
}
