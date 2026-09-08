import { sql } from "drizzle-orm";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";

/**
 * SQL fragments shared by the attribution panel and the campaign ledger so
 * "which campaign or flow gets this order" is decided in exactly one place.
 * Every fragment expects the enclosing query to alias shopify_order as `o`
 * and the current order-match result as `r`.
 */

/**
 * node-postgres serializes a raw Date parameter for a naive `timestamp`
 * column in the PROCESS's local time, while these columns store UTC wall
 * time. Interpolate the UTC ISO text and cast; Postgres drops the trailing
 * Z and keeps the UTC wall-clock value.
 */
export function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

/** A non-bot claim pointing at a campaign or flow qualifies an order as email-linked. */
export const QUALIFYING_CLAIM = sql`
  select 1 from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1`;

/**
 * Last non-bot touch decides campaign-vs-flow assignment. Ties on timestamp
 * (or all-null timestamps) break deterministically on the provider
 * attribution id. Exposes the message and the interaction instant so the
 * ledger can apply its send-time window rule and per-message rows.
 */
export const PRIMARY_CLAIM_LATERAL = sql`
  select case when c.campaign_object_id is not null then 'campaign'
              else 'flow' end as kind,
         coalesce(c.campaign_object_id, c.flow_object_id) as object_id,
         c.message_object_id,
         c.interaction_occurred_at
    from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1
   order by c.interaction_occurred_at desc nulls last,
            c.klaviyo_attribution_id desc
   limit 1`;

/**
 * Confirms an `o` shopify_order alias as email-linked and exposes the
 * primary claim as `pc` (kind, object_id, message_object_id,
 * interaction_occurred_at).
 */
export function emailLinkJoin(scope: KlaviyoConnectionScope) {
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
