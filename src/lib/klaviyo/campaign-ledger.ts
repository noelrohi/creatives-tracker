import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { emailLinkJoin, utcTimestamp } from "@/lib/klaviyo/email-link-sql";
import type { HalfOpenUtcWindow } from "@/lib/klaviyo/queries";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";

/**
 * Read-only loaders for the lab's campaign ledger. The window is the
 * Klaviyo ACCOUNT-timezone day range converted to half-open UTC — the same
 * key the report request uses, so "the current generation for this window"
 * is an exact match.
 *
 * Row rule (spec §4): a campaign is selected by its send time and carries
 * every confirmed order whose primary claim names it, with no order-date
 * filter; a flow carries orders whose primary claim's interaction falls in
 * the window. Refunds net per order lifetime.
 */

export type LedgerKind = "campaign" | "flow";

export type LedgerKlaviyoStats = {
  recipients: number | null;
  delivered: number | null;
  uniqueOpens: number | null;
  uniqueClicks: number | null;
  bounced: number | null;
  unsubscribes: number | null;
  spamComplaints: number | null;
  conversions: number | null;
  conversionValue: string | null;
};

export type LedgerRates = {
  delivered: number | null;
  open: number | null;
  click: number | null;
  unsubscribe: number | null;
};

export type LedgerRow = {
  objectId: string;
  objectType: LedgerKind;
  name: string;
  channel: string | null;
  status: string | null;
  sentAt: Date | null;
  messageCount: number;
  klaviyo: LedgerKlaviyoStats | null;
  rates: LedgerRates;
  orderCount: number;
  revenue: string;
};

export type LedgerMessageRow = {
  objectId: string;
  objectType: "campaign_message" | "flow_message";
  name: string;
  subject: string | null;
  channel: string | null;
  klaviyo: LedgerKlaviyoStats | null;
  rates: LedgerRates;
  orderCount: number;
  revenue: string;
};

export type LedgerReportMeta = {
  asOf: Date | null;
  hasCampaignGeneration: boolean;
  hasFlowGeneration: boolean;
};

export type LedgerListResult = { rows: LedgerRow[]; report: LedgerReportMeta };

export type LedgerProduct = {
  productKey: string;
  title: string;
  units: number;
  orderCount: number;
  orderRevenue: string;
};

export type LedgerDayPoint = { label: string; orders: number; revenue: string };

export type LedgerDetail = {
  object: {
    objectId: string;
    objectType: LedgerKind;
    name: string;
    channel: string | null;
    status: string | null;
    sentAt: Date | null;
    subject: string | null;
    messageCount: number;
  };
  klaviyo: LedgerKlaviyoStats | null;
  rates: LedgerRates;
  ours: { orderCount: number; revenue: string };
  reconciliation: {
    unconfirmedOrders: number | null;
    revenuePerRecipient: string | null;
    averageOrderValue: string | null;
  };
  ordersByDay: { mode: "offset" | "calendar"; points: LedgerDayPoint[] };
  topProducts: LedgerProduct[];
  messages: LedgerMessageRow[];
};

const OFFSET_DAYS = 14;
const ZERO_OURS = { orderCount: 0, revenue: "0.00" };

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

/** Klaviyo's own denominators: delivered over recipients, the rest over delivered. */
export function ledgerRates(stats: LedgerKlaviyoStats | null): LedgerRates {
  if (stats === null) {
    return { delivered: null, open: null, click: null, unsubscribe: null };
  }
  return {
    delivered: ratio(stats.delivered, stats.recipients),
    open: ratio(stats.uniqueOpens, stats.delivered),
    click: ratio(stats.uniqueClicks, stats.delivered),
    unsubscribe: ratio(stats.unsubscribes, stats.delivered),
  };
}

/** Report sums arrive as numeric text; counts become numbers, money stays text. */
function countOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * These columns are naive `timestamp`s holding UTC wall time, and
 * node-postgres parses them in the PROCESS's local zone. Selecting the
 * text form and re-stamping it as UTC is the read-side mirror of
 * `utcTimestamp`, so a Date leaving a loader is the real instant.
 */
function utcDateOf(text: string | null): Date | null {
  if (text === null) return null;
  return new Date(`${text.replace(" ", "T")}Z`);
}

function centsOf(money: string): number {
  return Math.round(Number(money) * 100);
}

function moneyRatio(money: string, divisor: number | null): string | null {
  if (divisor === null || divisor <= 0) return null;
  return (centsOf(money) / divisor / 100).toFixed(2);
}

/** `%`, `_`, and `\` are ILIKE metacharacters; a search for them must be literal. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

type FactRow = {
  kind: string;
  object_id: string;
  message_object_id: string | null;
  recipients: string | null;
  delivered: string | null;
  unique_opens: string | null;
  unique_clicks: string | null;
  bounced: string | null;
  unsubscribes: string | null;
  spam_complaints: string | null;
  conversions: string | null;
  conversion_value: string | null;
};

function statsOf(row: FactRow): LedgerKlaviyoStats {
  return {
    recipients: countOf(row.recipients),
    delivered: countOf(row.delivered),
    uniqueOpens: countOf(row.unique_opens),
    uniqueClicks: countOf(row.unique_clicks),
    bounced: countOf(row.bounced),
    unsubscribes: countOf(row.unsubscribes),
    spamComplaints: countOf(row.spam_complaints),
    conversions: countOf(row.conversions),
    conversionValue: row.conversion_value,
  };
}

/**
 * Email-linked orders under the ledger's window rule, as a CTE named
 * `linked`. Campaign orders are unwindowed; flow orders are kept when the
 * primary claim's interaction is inside the window.
 *
 * `objectIds` bounds the scan to the campaigns and flows the caller will
 * actually render — one id for a single-object read, the listed page's ids
 * for the list. Without it a campaign read scans every email-linked order the
 * store ever had, because campaign orders carry no date filter. `null` means
 * "every object", which no caller needs today.
 *
 * `revenue` is the order's LIFETIME refund-net money — refunds are not
 * re-windowed here, unlike the attribution panel's in-window mirror. Every
 * consumer sums this one column, so the headline, the day strip and the
 * product table can never disagree about what one order was worth.
 */
function linkedOrdersCte(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  objectIds: readonly string[] | null,
) {
  return sql`
    linked as (
      select pc.kind, pc.object_id, pc.message_object_id,
             o.id as order_id, o.order_created_at,
             o.net_sales - coalesce((
               select sum(rf.amount)
                 from shopify_refund rf
                where rf.organization_id = o.organization_id
                  and rf.store_id = o.store_id
                  and rf.order_id = o.id), 0) as revenue
        from shopify_order o
        ${emailLinkJoin(scope)}
       where o.organization_id = ${scope.organizationId}
         and o.store_id = ${scope.storeId}
         and (pc.kind = 'campaign'
              or (pc.interaction_occurred_at >= ${utcTimestamp(window.from)}
                  and pc.interaction_occurred_at < ${utcTimestamp(window.to)}))
         ${
           objectIds === null
             ? sql``
             : sql`and pc.object_id in (${sql.join(
                 objectIds.map((id) => sql`${id}`),
                 sql`, `,
               )})`
         }
    )`;
}

/** Refund-net order count and revenue per (object, optionally message). */
async function loadOurSide(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  objectIds: readonly string[] | null,
  byMessage: boolean,
): Promise<Map<string, { orderCount: number; revenue: string }>> {
  const result = new Map<string, { orderCount: number; revenue: string }>();
  // Nothing listed, nothing to scan.
  if (objectIds !== null && objectIds.length === 0) return result;
  const rows = await db.execute<{
    key: string | null;
    orders: number;
    revenue: string;
  }>(sql`
    with ${linkedOrdersCte(scope, window, objectIds)}
    select ${byMessage ? sql`l.message_object_id` : sql`l.object_id`} as key,
           count(*)::int as orders,
           round(coalesce(sum(l.revenue), 0), 2)::text as revenue
      from linked l
     group by 1`);
  for (const row of rows.rows) {
    if (row.key === null) continue;
    result.set(row.key, { orderCount: row.orders, revenue: row.revenue });
  }
  return result;
}

/**
 * The ONE generation each kind's numbers come from, as a CTE named
 * `current_generation`.
 *
 * The unique index that keeps a generation `current` is per publication
 * fingerprint, not per (kind, window): a historical duplicate — the same kind
 * and window published under a different fingerprint — can sit alongside the
 * live one and would otherwise double every sum. `distinct on (kind)` keeps
 * the newest published row per kind and drops the rest.
 */
function currentGenerationsCte(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  kinds: readonly string[],
) {
  return sql`
    current_generation as (
      select distinct on (kind) id, kind, published_at
        from klaviyo_report_generation
       where organization_id = ${scope.organizationId}
         and shopify_store_id = ${scope.storeId}
         and connection_id = ${scope.connectionId}
         and status = 'current'
         and kind in (${sql.join(
           kinds.map((kind) => sql`${kind}`),
           sql`, `,
         )})
         and requested_from = ${utcTimestamp(window.from)}
         and requested_to = ${utcTimestamp(window.to)}
       order by kind, published_at desc nulls last, id desc
    )`;
}

/**
 * Klaviyo's numbers from the current generation for this exact window,
 * summed per object (parent kinds arrive one row per send date). Keyed by
 * object id for parent kinds and by message id for message kinds.
 */
async function loadKlaviyoSide(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  kinds: readonly string[],
  objectId: string | null,
): Promise<Map<string, LedgerKlaviyoStats>> {
  const rows = await db.execute<FactRow>(sql`
    with ${currentGenerationsCte(scope, window, kinds)}
    select g.kind,
           coalesce(f.campaign_object_id, f.flow_object_id) as object_id,
           f.message_object_id,
           sum(f.recipients)::text as recipients,
           sum(f.delivered)::text as delivered,
           sum(f.unique_opens)::text as unique_opens,
           sum(f.unique_clicks)::text as unique_clicks,
           sum(f.bounced)::text as bounced,
           sum(f.unsubscribes)::text as unsubscribes,
           sum(f.spam_complaints)::text as spam_complaints,
           sum(f.conversions)::text as conversions,
           round(sum(f.conversion_value), 2)::text as conversion_value
      from klaviyo_report_fact f
      join current_generation g on g.id = f.generation_id
     where coalesce(f.campaign_object_id, f.flow_object_id) is not null
       ${
         objectId === null
           ? sql``
           : sql`and coalesce(f.campaign_object_id, f.flow_object_id) = ${objectId}`
       }
     group by 1, 2, 3`);
  const result = new Map<string, LedgerKlaviyoStats>();
  for (const row of rows.rows) {
    const key = row.message_object_id ?? row.object_id;
    result.set(key, statsOf(row));
  }
  return result;
}

async function loadReportMeta(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
): Promise<LedgerReportMeta> {
  const rows = await db.execute<{ kind: string; published_at: string | null }>(sql`
    with ${currentGenerationsCte(scope, window, ["campaign", "flow"])}
    select kind, published_at::text as published_at
      from current_generation`);
  let asOf: Date | null = null;
  for (const row of rows.rows) {
    const publishedAt = utcDateOf(row.published_at);
    if (publishedAt !== null && (asOf === null || publishedAt > asOf)) {
      asOf = publishedAt;
    }
  }
  return {
    asOf,
    hasCampaignGeneration: rows.rows.some((row) => row.kind === "campaign"),
    hasFlowGeneration: rows.rows.some((row) => row.kind === "flow"),
  };
}

type ObjectRow = {
  id: string;
  object_type: LedgerKind;
  name: string;
  channel: string | null;
  status: string | null;
  sent_at: string | null;
  message_count: number;
};

export async function loadLedgerRows(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  kind?: LedgerKind;
  channel?: "email" | "sms";
  search?: string;
}): Promise<LedgerListResult> {
  const { scope, window } = input;
  const search = input.search?.trim() ?? "";
  const objects = await db.execute<ObjectRow>(sql`
    select o.id, o.object_type, o.name, o.channel, o.status,
           o.sent_at::text as sent_at,
           (select count(*)::int from klaviyo_marketing_object m
             where m.connection_id = o.connection_id and m.parent_id = o.id)
             as message_count
      from klaviyo_marketing_object o
     where o.organization_id = ${scope.organizationId}
       and o.shopify_store_id = ${scope.storeId}
       and o.connection_id = ${scope.connectionId}
       and o.object_type in ('campaign', 'flow')
       and (o.object_type = 'flow'
            or (o.sent_at >= ${utcTimestamp(window.from)}
                and o.sent_at < ${utcTimestamp(window.to)}))
       ${input.kind ? sql`and o.object_type = ${input.kind}` : sql``}
       ${
         input.channel
           ? sql`and (o.object_type = 'flow' or o.channel = ${input.channel})`
           : sql``
       }
       ${search ? sql`and o.name ilike ${likePattern(search)}` : sql``}
     order by o.sent_at desc nulls last, o.name asc, o.id asc`);

  const [ours, klaviyo, report] = await Promise.all([
    loadOurSide(scope, window, objects.rows.map((object) => object.id), false),
    loadKlaviyoSide(scope, window, ["campaign", "flow"], null),
    loadReportMeta(scope, window),
  ]);

  const rows: LedgerRow[] = [];
  for (const object of objects.rows) {
    const stats = klaviyo.get(object.id) ?? null;
    const own = ours.get(object.id) ?? ZERO_OURS;
    // A flow with nothing in the range stays out rather than showing dashes.
    if (object.object_type === "flow" && stats === null && own.orderCount === 0) {
      continue;
    }
    rows.push({
      objectId: object.id,
      objectType: object.object_type,
      name: object.name,
      channel: object.channel,
      status: object.status,
      sentAt: utcDateOf(object.sent_at),
      messageCount: object.message_count,
      klaviyo: stats,
      rates: ledgerRates(stats),
      orderCount: own.orderCount,
      revenue: own.revenue,
    });
  }
  return { rows, report };
}

async function loadObject(
  scope: KlaviyoConnectionScope,
  objectId: string,
): Promise<(ObjectRow & { subject: string | null }) | null> {
  const rows = await db.execute<ObjectRow & { subject: string | null }>(sql`
    select o.id, o.object_type, o.name, o.channel, o.status,
           o.sent_at::text as sent_at,
           (select count(*)::int from klaviyo_marketing_object m
             where m.connection_id = o.connection_id and m.parent_id = o.id)
             as message_count,
           (select m.subject from klaviyo_marketing_object m
             where m.connection_id = o.connection_id and m.parent_id = o.id
             order by m.provider_created_at asc nulls last, m.id asc
             limit 1) as subject
      from klaviyo_marketing_object o
     where o.organization_id = ${scope.organizationId}
       and o.shopify_store_id = ${scope.storeId}
       and o.connection_id = ${scope.connectionId}
       and o.id = ${objectId}
       and o.object_type in ('campaign', 'flow')`);
  return rows.rows[0] ?? null;
}

export async function loadLedgerMessages(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  objectId: string;
}): Promise<LedgerMessageRow[] | null> {
  const { scope, window, objectId } = input;
  const parent = await loadObject(scope, objectId);
  if (parent === null) return null;
  const messages = await db.execute<{
    id: string;
    object_type: "campaign_message" | "flow_message";
    name: string;
    subject: string | null;
    channel: string | null;
  }>(sql`
    select m.id, m.object_type, m.name, m.subject, m.channel
      from klaviyo_marketing_object m
     where m.connection_id = ${scope.connectionId}
       and m.parent_id = ${objectId}
       and m.object_type in ('campaign_message', 'flow_message')
     order by m.provider_created_at asc nulls last, m.name asc, m.id asc`);
  const messageKind =
    parent.object_type === "campaign" ? "campaign_message" : "flow_message";
  const [ours, klaviyo] = await Promise.all([
    loadOurSide(scope, window, [objectId], true),
    loadKlaviyoSide(scope, window, [messageKind], objectId),
  ]);
  return messages.rows.map((message) => {
    const stats = klaviyo.get(message.id) ?? null;
    const own = ours.get(message.id) ?? ZERO_OURS;
    return {
      objectId: message.id,
      objectType: message.object_type,
      name: message.name,
      subject: message.subject,
      channel: message.channel,
      klaviyo: stats,
      rates: ledgerRates(stats),
      orderCount: own.orderCount,
      revenue: own.revenue,
    };
  });
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

export async function loadLedgerDetail(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  objectId: string;
}): Promise<LedgerDetail | null> {
  const { scope, window, objectId } = input;
  const object = await loadObject(scope, objectId);
  if (object === null) return null;
  const sentAt = utcDateOf(object.sent_at);

  const [ours, klaviyoMap] = await Promise.all([
    loadOurSide(scope, window, [objectId], false),
    loadKlaviyoSide(scope, window, [object.object_type], objectId),
  ]);
  const own = ours.get(objectId) ?? ZERO_OURS;
  const stats = klaviyoMap.get(objectId) ?? null;

  // Orders by day: offset from the send for a campaign (first 14 days), UTC
  // calendar day across the window for a flow.
  let ordersByDay: LedgerDetail["ordersByDay"];
  if (object.object_type === "campaign" && sentAt !== null) {
    const rows = await db.execute<{
      day_offset: number;
      orders: number;
      revenue: string;
    }>(sql`
      with ${linkedOrdersCte(scope, window, [objectId])}
      select day_offset, count(*)::int as orders,
             round(sum(revenue), 2)::text as revenue
        from (select floor(extract(epoch from
                       (order_created_at - ${utcTimestamp(sentAt)})) / 86400)::int
                       as day_offset,
                     revenue
                from linked) d
       where day_offset between 0 and ${OFFSET_DAYS - 1}
       group by 1 order by 1`);
    const byOffset = new Map(rows.rows.map((row) => [row.day_offset, row]));
    ordersByDay = {
      mode: "offset",
      points: Array.from({ length: OFFSET_DAYS }, (_, offset) => {
        const row = byOffset.get(offset);
        return {
          label: String(offset),
          orders: row?.orders ?? 0,
          revenue: row?.revenue ?? "0.00",
        };
      }),
    };
  } else {
    const rows = await db.execute<{
      day: string;
      orders: number;
      revenue: string;
    }>(sql`
      with ${linkedOrdersCte(scope, window, [objectId])}
      select to_char(order_created_at, 'YYYY-MM-DD') as day,
             count(*)::int as orders,
             round(sum(revenue), 2)::text as revenue
        from linked
       group by 1 order by 1`);
    const byDay = new Map(rows.rows.map((row) => [row.day, row]));
    const points: LedgerDayPoint[] = [];
    const last = utcDay(new Date(window.to.getTime() - 1));
    for (let day = utcDay(window.from); day <= last; day = addUtcDays(day, 1)) {
      const row = byDay.get(day);
      points.push({
        label: day,
        orders: row?.orders ?? 0,
        revenue: row?.revenue ?? "0.00",
      });
    }
    ordersByDay = { mode: "calendar", points };
  }

  // Top products among this object's confirmed orders; an order with
  // several products counts toward each, once per order.
  const products = await db.execute<{
    product_key: string;
    title: string;
    units: number;
    order_count: number;
    order_revenue: string;
  }>(sql`
    with ${linkedOrdersCte(scope, window, [objectId])}
    select product_key,
           min(title) as title,
           sum(units)::int as units,
           count(*)::int as order_count,
           round(sum(revenue), 2)::text as order_revenue
      from (
        select coalesce(l.shopify_product_id, 'title:' || l.product_title)
                 as product_key,
               min(l.product_title) as title,
               sum(l.quantity) as units,
               l.order_id,
               min(linked.revenue) as revenue
          from shopify_order_line l
          join linked on linked.order_id = l.order_id
         where l.organization_id = ${scope.organizationId}
           and l.store_id = ${scope.storeId}
         group by 1, l.order_id
      ) per_order
     group by product_key
     order by sum(revenue) desc, product_key asc
     limit 10`);

  const messages =
    object.message_count > 1
      ? ((await loadLedgerMessages({ scope, window, objectId })) ?? [])
      : [];

  return {
    object: {
      objectId: object.id,
      objectType: object.object_type,
      name: object.name,
      channel: object.channel,
      status: object.status,
      sentAt,
      subject: object.subject,
      messageCount: object.message_count,
    },
    klaviyo: stats,
    rates: ledgerRates(stats),
    ours: own,
    reconciliation: {
      unconfirmedOrders:
        stats?.conversions == null
          ? null
          : Math.max(0, stats.conversions - own.orderCount),
      revenuePerRecipient: moneyRatio(own.revenue, stats?.recipients ?? null),
      averageOrderValue: moneyRatio(own.revenue, own.orderCount),
    },
    ordersByDay,
    topProducts: products.rows.map((row) => ({
      productKey: row.product_key,
      title: row.title,
      units: row.units,
      orderCount: row.order_count,
      orderRevenue: row.order_revenue,
    })),
    messages,
  };
}
