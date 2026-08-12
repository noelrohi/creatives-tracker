import { logger, metadata, schedules, tags, task } from "@trigger.dev/sdk";
import {
  downloadBulkJsonl,
  fetchAllOrders,
  fetchOrdersByIds,
  fetchShopInfo,
  getShopifyShopDomain,
  startBulkOrdersOperation,
  waitForBulkOperation,
  type ShopifyOrderNode,
} from "@/lib/shopify-admin";
import {
  finishSyncRun,
  updateSyncRunProgress,
  getLastSuccessfulRunStartedAt,
  getShopifyStoreByDomain,
  groupBulkOrderLines,
  hydrateRefundLineItems,
  ingestOrderNodes,
  listOrdersNeedingJourneyRepoll,
  listShopifyStores,
  loadSyncedMetaAds,
  loadSyncedMetaAdSets,
  loadSyncedMetaCampaignIds,
  stampBucketBatch,
  stampBuckets,
  startSyncRun,
  touchStoreLastSyncedAt,
  upsertShopifyStore,
  type ShopifyStoreRecord,
} from "@/lib/shopify-ingest";
import { BUCKET_RULE_VERSION } from "@/lib/attribution-bucket";
import { harvestLandingPages } from "@/lib/landing-page";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const SHOPIFY_SYNC_QUEUE = { name: "shopify-sync", concurrencyLimit: 1 };

const INCREMENTAL_OVERLAP_MS = 15 * 60 * 1000;
const JOURNEY_REPOLL_DAYS = 3;
const REBUCKET_BATCH_SIZE = 500;

type BackfillPayload = {
  organizationId: string;
  days?: number;
  triggerType?: string;
};

type IncrementalPayload = {
  organizationId: string;
  since?: string;
  triggerType?: string;
};

type RebucketPayload = {
  organizationId: string;
  triggerType?: string;
};

function shopifyOrgTag(organizationId: string) {
  return `shopify-sync:org:${organizationId}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Shopify search syntax wants `2026-07-30T00:00:00Z`. */
function shopifyTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Ensures the store row exists and reflects current shop settings. */
async function resolveStore(organizationId: string) {
  const shopDomain = getShopifyShopDomain();
  const shopInfo = await fetchShopInfo();

  logger.info("Resolved Shopify shop info", {
    organizationId,
    shopDomain,
    shopName: shopInfo.name,
    ianaTimezone: shopInfo.ianaTimezone,
    currency: shopInfo.currencyCode,
  });

  return upsertShopifyStore({
    organizationId,
    shopDomain,
    ianaTimezone: shopInfo.ianaTimezone,
    currency: shopInfo.currencyCode,
  });
}

async function ingestAndCount(params: {
  organizationId: string;
  store: ShopifyStoreRecord;
  orders: ShopifyOrderNode[];
  label: string;
}) {
  const { orders, hydrated } = await hydrateRefundLineItems(params.orders);
  if (hydrated > 0) {
    logger.info("Hydrated refund line items via paginated query", {
      storeId: params.store.id,
      label: params.label,
      orders: hydrated,
    });
  }

  const result = await ingestOrderNodes({
    organizationId: params.organizationId,
    store: params.store,
    orders,
  });

  logger.info("Upserted Shopify orders", {
    storeId: params.store.id,
    label: params.label,
    ...result,
  });

  return result;
}

async function stampAndLog(params: {
  organizationId: string;
  storeId: string;
  scope: "pending" | "rebucket";
}) {
  const syncedMetaCampaignIds = await loadSyncedMetaCampaignIds(
    params.organizationId,
  );
  const syncedMetaAdSets = await loadSyncedMetaAdSets(params.organizationId);
  const syncedMetaAds = await loadSyncedMetaAds(params.organizationId);
  const result = await stampBuckets({
    organizationId: params.organizationId,
    storeId: params.storeId,
    scope: params.scope,
    syncedMetaCampaignIds,
    syncedMetaAdSets,
    syncedMetaAds,
  });

  // The journey side of the landing-page harvest (§5.1): orders only carry a
  // landing page once their journey is ready, which is exactly what the pass
  // above just settled.
  try {
    const harvested = await harvestLandingPages({
      organizationId: params.organizationId,
      storeId: params.storeId,
    });
    logger.info("Harvested landing pages", {
      storeId: params.storeId,
      ...harvested,
    });
  } catch (error) {
    logger.error("Landing page harvest failed", {
      storeId: params.storeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("Stamped attribution buckets", {
    storeId: params.storeId,
    scope: params.scope,
    bucketRuleVersion: BUCKET_RULE_VERSION,
    syncedMetaCampaigns: syncedMetaCampaignIds.size,
    syncedMetaAdSets: syncedMetaAdSets.size,
    syncedMetaAds: syncedMetaAds.adMetaIds.size,
    ...result,
  });

  return result;
}

export const shopifyBackfillTask = task({
  id: "shopify-backfill",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: SHOPIFY_SYNC_QUEUE,
  run: async (payload: BackfillPayload) => {
    await tags.add(shopifyOrgTag(payload.organizationId));

    const days = payload.days ?? 90;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const to = new Date();

    metadata.set("status", "resolving_store");
    metadata.set("step", "Loading shop info");
    const store = await resolveStore(payload.organizationId);

    const run = await startSyncRun({
      organizationId: payload.organizationId,
      storeId: store.id,
      triggerType: payload.triggerType ?? "manual_backfill",
      phase: "backfill",
      dateFrom: isoDay(from),
      dateTo: isoDay(to),
    });

    logger.info("Starting Shopify backfill", {
      organizationId: payload.organizationId,
      storeId: store.id,
      days,
      dateFrom: isoDay(from),
      dateTo: isoDay(to),
      syncRunId: run.id,
    });

    try {
      metadata.set("status", "bulk_operation");
      metadata.set("step", `Starting bulk export for last ${days} days`);

      const { bulkOperationId, includesRefundLineItems } =
        await startBulkOrdersOperation(
          `created_at:>=${shopifyTimestamp(from)}`,
        );

      if (!includesRefundLineItems) {
        logger.warn(
          "Bulk API rejected nested refundLineItems — refunds will be hydrated per order",
          { storeId: store.id, bulkOperationId },
        );
      }

      const operation = await waitForBulkOperation(
        bulkOperationId,
        (current, attempt) => {
          metadata.set("bulkStatus", current.status);
          metadata.set("pollAttempt", attempt);
          metadata.set("step", `Bulk export ${current.status.toLowerCase()}`);
        },
      );

      if (!operation.url) {
        // Zero matching orders: Shopify completes with a null url.
        logger.warn("Bulk operation completed with no result url", {
          storeId: store.id,
          bulkOperationId,
          objectCount: operation.objectCount ?? null,
        });

        await finishSyncRun({
          runId: run.id,
          result: "success",
          ordersSynced: 0,
          meta: {
            bulkOperationId,
            includesRefundLineItems,
            orders: 0,
            progress: { daysLoaded: 0, daysTotal: days, ordersSynced: 0 },
          },
        });

        return { ordersSynced: 0, refundsSynced: 0, stamped: 0 };
      }

      metadata.set("status", "downloading");
      metadata.set("step", "Downloading bulk JSONL");
      const lines = await downloadBulkJsonl(operation.url);
      const orders = groupBulkOrderLines(lines);

      logger.info("Parsed bulk JSONL", {
        storeId: store.id,
        lines: lines.length,
        orders: orders.length,
      });

      metadata.set("status", "upserting");
      metadata.set("totalOrders", orders.length);

      let ordersSynced = 0;
      let refundsSynced = 0;
      let testOrdersSkipped = 0;
      const batchSize = 250;
      // Store-timezone days seen so far: what "filling in" means on the
      // first-load screen, and the number it reads out of the sync run.
      const daysLoaded = new Set<string>();

      for (let index = 0; index < orders.length; index += batchSize) {
        const batch = orders.slice(index, index + batchSize);
        metadata.set(
          "step",
          `Upserting orders ${index + 1}-${index + batch.length} of ${orders.length}`,
        );

        const result = await ingestAndCount({
          organizationId: payload.organizationId,
          store,
          orders: batch,
          label: "backfill",
        });

        ordersSynced += result.ordersUpserted;
        refundsSynced += result.refundsUpserted;
        testOrdersSkipped += result.testOrdersSkipped;
        for (const day of result.orderDays) daysLoaded.add(day);

        // §2.1: progress lands in `shopify_sync_run` as each page is written, so
        // the screen can show it live instead of guessing from order rows.
        await updateSyncRunProgress({
          runId: run.id,
          progress: {
            daysLoaded: daysLoaded.size,
            daysTotal: days,
            ordersSynced,
          },
          meta: { bulkOperationId, includesRefundLineItems },
        });
      }

      metadata.set("status", "stamping");
      metadata.set("step", "Stamping attribution buckets");
      const stamped = await stampAndLog({
        organizationId: payload.organizationId,
        storeId: store.id,
        scope: "pending",
      });

      await touchStoreLastSyncedAt(store.id);
      await finishSyncRun({
        runId: run.id,
        result: "success",
        ordersSynced,
        meta: {
          bulkOperationId,
          includesRefundLineItems,
          refundsSynced,
          testOrdersSkipped,
          bucketsStamped: stamped.stamped,
          progress: {
            daysLoaded: daysLoaded.size,
            daysTotal: days,
            ordersSynced,
          },
        },
      });

      metadata.set("status", "completed");
      logger.info("Completed Shopify backfill", {
        organizationId: payload.organizationId,
        storeId: store.id,
        ordersSynced,
        refundsSynced,
        testOrdersSkipped,
        bucketsStamped: stamped.stamped,
      });

      return {
        ordersSynced,
        refundsSynced,
        testOrdersSkipped,
        stamped: stamped.stamped,
        summary: `Backfilled ${ordersSynced} orders over ${days} days`,
      };
    } catch (error) {
      logger.error("Shopify backfill failed", {
        organizationId: payload.organizationId,
        storeId: store.id,
        syncRunId: run.id,
        error: errorMessage(error),
      });

      await finishSyncRun({
        runId: run.id,
        result: "failed",
        error: errorMessage(error),
      });
      throw error;
    }
  },
});

export const shopifyIncrementalTask = task({
  id: "shopify-incremental",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: SHOPIFY_SYNC_QUEUE,
  run: async (payload: IncrementalPayload) => {
    await tags.add(shopifyOrgTag(payload.organizationId));

    metadata.set("status", "resolving_store");
    metadata.set("step", "Loading shop info");
    const store = await resolveStore(payload.organizationId);

    const lastRunStartedAt = await getLastSuccessfulRunStartedAt({
      storeId: store.id,
    });
    const since = payload.since
      ? new Date(payload.since)
      : new Date(
          (lastRunStartedAt?.getTime() ?? Date.now() - 24 * 60 * 60 * 1000) -
            INCREMENTAL_OVERLAP_MS,
        );

    const run = await startSyncRun({
      organizationId: payload.organizationId,
      storeId: store.id,
      triggerType: payload.triggerType ?? "scheduled",
      phase: "incremental",
      dateFrom: isoDay(since),
      dateTo: isoDay(new Date()),
    });

    logger.info("Starting Shopify incremental sync", {
      organizationId: payload.organizationId,
      storeId: store.id,
      since: since.toISOString(),
      syncRunId: run.id,
    });

    try {
      metadata.set("status", "syncing");
      let ordersSynced = 0;
      let refundsSynced = 0;

      await fetchAllOrders(
        `updated_at:>=${shopifyTimestamp(since)}`,
        async (orders, page) => {
          metadata.set("step", `Upserting updated orders (page ${page})`);
          const result = await ingestAndCount({
            organizationId: payload.organizationId,
            store,
            orders,
            label: `incremental page ${page}`,
          });
          ordersSynced += result.ordersUpserted;
          refundsSynced += result.refundsUpserted;
        },
      );

      // Journey re-poll: Shopify resolves visit chains asynchronously, so
      // recently-pending orders get re-fetched by id.
      metadata.set("status", "journey_repoll");
      metadata.set("step", "Re-polling pending customer journeys");

      const pendingIds = await listOrdersNeedingJourneyRepoll({
        storeId: store.id,
        withinDays: JOURNEY_REPOLL_DAYS,
      });

      let journeyRepolled = 0;
      if (pendingIds.length > 0) {
        const repolled = await fetchOrdersByIds(pendingIds);
        const result = await ingestAndCount({
          organizationId: payload.organizationId,
          store,
          orders: repolled,
          label: "journey re-poll",
        });
        journeyRepolled = result.ordersUpserted;
        refundsSynced += result.refundsUpserted;
      }

      logger.info("Completed journey re-poll", {
        storeId: store.id,
        pendingOrders: pendingIds.length,
        journeyRepolled,
      });

      metadata.set("status", "stamping");
      metadata.set("step", "Stamping attribution buckets");
      const stamped = await stampAndLog({
        organizationId: payload.organizationId,
        storeId: store.id,
        scope: "pending",
      });

      await touchStoreLastSyncedAt(store.id);
      await finishSyncRun({
        runId: run.id,
        result: "success",
        ordersSynced,
        meta: {
          since: since.toISOString(),
          refundsSynced,
          journeyRepolled,
          bucketsStamped: stamped.stamped,
        },
      });

      metadata.set("status", "completed");
      logger.info("Completed Shopify incremental sync", {
        organizationId: payload.organizationId,
        storeId: store.id,
        ordersSynced,
        refundsSynced,
        journeyRepolled,
        bucketsStamped: stamped.stamped,
      });

      return {
        ordersSynced,
        refundsSynced,
        journeyRepolled,
        stamped: stamped.stamped,
        summary: `Synced ${ordersSynced} updated orders since ${since.toISOString()}`,
      };
    } catch (error) {
      logger.error("Shopify incremental sync failed", {
        organizationId: payload.organizationId,
        storeId: store.id,
        syncRunId: run.id,
        error: errorMessage(error),
      });

      await finishSyncRun({
        runId: run.id,
        result: "failed",
        error: errorMessage(error),
      });
      throw error;
    }
  },
});

export const shopifyRebucketBatchTask = task({
  id: "shopify-rebucket-batch",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: { name: "shopify-rebucket-batch", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload: {
    organizationId: string;
    storeId: string;
    afterId?: string | null;
    limit?: number;
  }) => {
    const limit = payload.limit ?? REBUCKET_BATCH_SIZE;
    metadata
      .set("step", `Scanning up to ${limit} eligible orders`)
      .set("cursor", payload.afterId ?? null);

    return logger.trace(
      `Scan and stamp up to ${limit} orders`,
      async () => {
        metadata.set("itemStep", "Loading and resolving attribution");
        const result = await stampBucketBatch({
          organizationId: payload.organizationId,
          storeId: payload.storeId,
          scope: "rebucket",
          afterId: payload.afterId,
          limit,
        });
        metadata
          .set("itemStep", "Completed")
          .set("scanned", result.scanned)
          .set("stamped", result.stamped)
          .set("nextCursor", result.nextCursor);
        return result;
      },
      {
        attributes: {
          "intelligence.item.type": "order_batch",
          "intelligence.item.limit": limit,
        },
      },
    );
  },
});

export const shopifyRebucketTask = task({
  id: "shopify-rebucket",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: SHOPIFY_SYNC_QUEUE,
  maxDuration: 3600,
  run: async (payload: RebucketPayload) => {
    await tags.add(shopifyOrgTag(payload.organizationId));

    const shopDomain = getShopifyShopDomain();
    const store = await getShopifyStoreByDomain(shopDomain);
    if (!store) {
      throw new Error(
        `No shopify_store row for the configured shop domain — run shopify-backfill first`,
      );
    }

    const run = await startSyncRun({
      organizationId: payload.organizationId,
      storeId: store.id,
      triggerType: payload.triggerType ?? "manual",
      phase: "rebucket",
    });

    logger.info("Starting Shopify rebucket", {
      organizationId: payload.organizationId,
      storeId: store.id,
      bucketRuleVersion: BUCKET_RULE_VERSION,
      syncRunId: run.id,
    });

    let afterId: string | null = null;
    let scanned = 0;
    let stamped = 0;
    let batch = 0;

    try {
      while (true) {
        batch += 1;
        metadata
          .set("status", "stamping")
          .set("step", `Re-stamping attribution buckets (batch ${batch})`)
          .set("scanned", scanned)
          .set("stamped", stamped)
          .set("cursor", afterId);

        const result = await shopifyRebucketBatchTask.triggerAndWait({
          organizationId: payload.organizationId,
          storeId: store.id,
          afterId,
          limit: REBUCKET_BATCH_SIZE,
        });
        if (!result.ok) {
          throw new Error(
            `Rebucket batch ${batch} failed after ${afterId ?? "start"}: ${String(result.error)}`,
          );
        }

        scanned += result.output.scanned;
        stamped += result.output.stamped;
        if (!result.output.nextCursor) break;
        afterId = result.output.nextCursor;
      }

      await finishSyncRun({
        runId: run.id,
        result: "success",
        ordersSynced: stamped,
        meta: { scanned, batches: batch, bucketRuleVersion: BUCKET_RULE_VERSION },
      });

      metadata
        .set("status", "completed")
        .set("scanned", scanned)
        .set("stamped", stamped);
      return {
        scanned,
        stamped,
        batches: batch,
        summary: `Re-bucketed ${stamped} of ${scanned} orders`,
      };
    } catch (error) {
      logger.error("Shopify rebucket failed", {
        organizationId: payload.organizationId,
        storeId: store.id,
        syncRunId: run.id,
        batch,
        afterId,
        error: errorMessage(error),
      });

      await finishSyncRun({
        runId: run.id,
        result: "failed",
        error: errorMessage(error),
        meta: { scanned, stamped, batch, afterId, bucketRuleVersion: BUCKET_RULE_VERSION },
      });
      throw error;
    }
  },
});

export const shopifyIncrementalScheduled = schedules.task({
  id: "shopify-incremental-scheduled",
  cron: "0 * * * *", // hourly
  run: async () => {
    const stores = await listShopifyStores();
    if (stores.length === 0) {
      logger.warn("No shopify_store rows found — nothing to sync");
      return { stores: 0, results: [] };
    }

    const results = [];

    for (const store of stores) {
      const result = await shopifyIncrementalTask.triggerAndWait({
        organizationId: store.organizationId,
        triggerType: "scheduled",
      });
      if (!result.ok) {
        throw new Error(
          `Scheduled Shopify sync failed for ${store.organizationId}: ${result.error}`,
        );
      }
      results.push(result.output);
    }

    return { stores: stores.length, results };
  },
});
