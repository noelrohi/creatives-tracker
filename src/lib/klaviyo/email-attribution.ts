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
  gaps: {
    noEmailLink: EmailAttributionBucket;
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

function emailLinkedFrom(scope: KlaviyoConnectionScope, window: HalfOpenUtcWindow) {
  return sql`
    from shopify_order o
    join klaviyo_order_match_result r
      on r.organization_id = o.organization_id
     and r.shopify_store_id = o.store_id
     and r.connection_id = ${scope.connectionId}
     and r.order_id = o.id
     and r.superseded_at is null
     and r.status = 'confirmed'
     and r.selected_event_id is not null
    cross join lateral (${PRIMARY_CLAIM_LATERAL}) pc
   where o.organization_id = ${scope.organizationId}
     and o.store_id = ${scope.storeId}
     and o.order_created_at >= ${window.from}
     and o.order_created_at < ${window.to}`;
}

export async function loadEmailAttribution(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
}): Promise<EmailAttributionSummary> {
  const { scope, window } = input;

  // 1. Partition: every order in range lands in exactly one bucket.
  const partition = await db.execute<{
    bucket: string;
    orders: number;
    revenue: string;
  }>(sql`
    select case
             when r.id is null then 'not_evaluated'
             when r.status = 'no_klaviyo_event' then 'no_klaviyo_event'
             when r.status = 'duplicate_conversion_events' then 'duplicate_flagged'
             when r.status = 'confirmed'
                  and r.selected_event_id is not null
                  and exists (${QUALIFYING_CLAIM}) then 'email_linked'
             else 'no_email_link'
           end as bucket,
           count(*)::int as orders,
           round(coalesce(sum(o.net_sales), 0), 2)::text as revenue
      from shopify_order o
      left join klaviyo_order_match_result r
        on r.organization_id = o.organization_id
       and r.shopify_store_id = o.store_id
       and r.connection_id = ${scope.connectionId}
       and r.order_id = o.id
       and r.superseded_at is null
     where o.organization_id = ${scope.organizationId}
       and o.store_id = ${scope.storeId}
       and o.order_created_at >= ${window.from}
       and o.order_created_at < ${window.to}
     group by 1`);

  const buckets = new Map(
    partition.rows.map((row) => [
      row.bucket,
      { orders: row.orders, revenue: row.revenue },
    ]),
  );
  const bucket = (key: string): EmailAttributionBucket =>
    buckets.get(key) ?? ZERO_BUCKET;

  // 2. Headline split, summed in SQL so money never crosses JS floats.
  const headline = await db.execute<{
    orders: number;
    revenue: string;
    campaigns_revenue: string;
    flows_revenue: string;
  }>(sql`
    select count(*)::int as orders,
           round(coalesce(sum(o.net_sales), 0), 2)::text as revenue,
           round(coalesce(sum(o.net_sales)
             filter (where pc.kind = 'campaign'), 0), 2)::text as campaigns_revenue,
           round(coalesce(sum(o.net_sales)
             filter (where pc.kind = 'flow'), 0), 2)::text as flows_revenue
    ${emailLinkedFrom(scope, window)}`);
  const head = headline.rows[0];

  // 3. Per-source rows by primary claim.
  const sourceRows = await db.execute<{
    kind: "campaign" | "flow";
    object_id: string;
    orders: number;
    revenue: string;
  }>(sql`
    select pc.kind, pc.object_id,
           count(*)::int as orders,
           round(coalesce(sum(o.net_sales), 0), 2)::text as revenue
    ${emailLinkedFrom(scope, window)}
     group by 1, 2
     order by sum(o.net_sales) desc, pc.object_id asc`);

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
  // their windows travel with the numbers; nothing is re-sliced.
  const factRows = await db.execute<{
    campaign_object_id: string | null;
    conversion_value: string | null;
    requested_from: Date;
    requested_to: Date;
    as_of: Date;
  }>(sql`
    select f.campaign_object_id, f.conversion_value,
           f.requested_from, f.requested_to, f.as_of
      from klaviyo_report_fact f
      join klaviyo_report_generation g on g.id = f.generation_id
     where g.organization_id = ${scope.organizationId}
       and g.shopify_store_id = ${scope.storeId}
       and g.connection_id = ${scope.connectionId}
       and g.kind = 'campaign'
       and g.status = 'current'`);
  const factByCampaign = new Map(
    factRows.rows
      .filter((row) => row.campaign_object_id !== null)
      .map((row) => [row.campaign_object_id as string, row]),
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

  // 5. Top products inside email-linked orders. shopify_order_line has no
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
     limit 10`);

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
       and e.occurred_at >= ${window.from}
       and e.occurred_at < ${window.to}
       and (er.status is null or er.status <> 'confirmed')`);

  return {
    email: {
      revenue: head?.revenue ?? "0",
      orderCount: head?.orders ?? 0,
      campaignsRevenue: head?.campaigns_revenue ?? "0",
      flowsRevenue: head?.flows_revenue ?? "0",
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
    gaps: {
      noEmailLink: bucket("no_email_link"),
      notEvaluated: bucket("not_evaluated"),
      noKlaviyoEvent: bucket("no_klaviyo_event"),
      duplicateFlagged: bucket("duplicate_flagged"),
      unmatchedEvents: unmatched.rows[0]?.count ?? 0,
    },
  };
}
