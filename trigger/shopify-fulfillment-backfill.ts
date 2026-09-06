import { metadata, schemaTask, tags } from "@trigger.dev/sdk";
import { backfillFulfillmentStatuses, fulfillmentBackfillInputSchema } from "@/lib/shopify-fulfillment-backfill";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

/** No schedule: run explicitly after applying the migration and checking historical order access. */
export const shopifyFulfillmentBackfill = schemaTask({
  id: "shopify-fulfillment-backfill",
  schema: fulfillmentBackfillInputSchema,
  queue: { name: "shopify-sync", concurrencyLimit: 1 },
  retry: ATTRIBUTION_TASK_RETRY,
  run: async (payload) => {
    await tags.add(`shopify-sync:org:${payload.organizationId}`);
    metadata.set("status", "backfilling_fulfillment");
    const result = await backfillFulfillmentStatuses(payload, undefined, (progress) => {
      metadata.set("progress", progress);
    });
    metadata.set("status", result.hasMore ? "continuation_required" : "batch_scan_finished");
    metadata.set("result", result);
    return result;
  },
});
