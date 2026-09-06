import { sql } from "drizzle-orm";
import { db } from "@/db";
import { FULFILLMENT_STATUSES, summarizeFulfillment, type FulfillmentGroup } from "./shopify-fulfillment";

export async function getUnfulfilledOrders(input: {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const result = await db.execute<FulfillmentGroup>(sql`
    SELECT
      CASE WHEN cancelled_at IS NOT NULL THEN 'CANCELLED'
        WHEN fulfillment_status_observed_at IS NOT NULL
          AND fulfillment_status IN (${sql.join(FULFILLMENT_STATUSES.map((status) => sql`${status}`), sql`, `)})
        THEN fulfillment_status ELSE 'UNKNOWN' END AS status,
      count(DISTINCT shopify_order_id)::int AS count,
      (extract(epoch FROM min(fulfillment_status_observed_at) AT TIME ZONE 'UTC') * 1000)::float8 AS "oldestMs",
      (extract(epoch FROM max(fulfillment_status_observed_at) AT TIME ZONE 'UTC') * 1000)::float8 AS "newestMs"
    FROM shopify_order
    WHERE organization_id = ${input.organizationId} AND store_id = ${input.storeId}
      AND order_day BETWEEN ${input.dateFrom}::date AND ${input.dateTo}::date
    GROUP BY 1
  `);
  return summarizeFulfillment(result.rows);
}
