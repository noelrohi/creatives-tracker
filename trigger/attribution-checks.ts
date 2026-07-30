import { logger, metadata, schedules, tags, task } from "@trigger.dev/sdk";
import {
  evaluateFindingsForStore,
  getFirstSyncState,
} from "@/lib/findings";
import { listShopifyStores, type ShopifyStoreRecord } from "@/lib/shopify-ingest";

const ATTRIBUTION_CHECKS_QUEUE = {
  name: "attribution-checks",
  concurrencyLimit: 1,
};

type ChecksPayload = {
  organizationId: string;
  triggerType?: string;
};

function attributionChecksOrgTag(organizationId: string) {
  return `attribution-checks:org:${organizationId}`;
}

/**
 * Findings compare against history, so a store still on its first backfill has
 * nothing to compare against — it is skipped rather than flooded with alerts.
 */
async function runChecksForStore(store: ShopifyStoreRecord) {
  const firstSync = await getFirstSyncState({
    organizationId: store.organizationId,
    storeId: store.id,
  });

  if (!firstSync.hasCompletedBackfill) {
    logger.info("Skipping attribution checks — no completed backfill yet", {
      organizationId: store.organizationId,
      storeId: store.id,
      shopDomain: store.shopDomain,
    });
    return { storeId: store.id, skipped: "first_sync" as const };
  }

  const summary = await evaluateFindingsForStore({
    organizationId: store.organizationId,
    storeId: store.id,
  });

  logger.info("Evaluated attribution findings", {
    organizationId: store.organizationId,
    storeId: store.id,
    shopDomain: store.shopDomain,
    ...summary,
  });

  return { storeId: store.id, ...summary };
}

export const attributionChecksTask = task({
  id: "attribution-checks",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
  },
  queue: ATTRIBUTION_CHECKS_QUEUE,
  run: async (payload: ChecksPayload) => {
    await tags.add(attributionChecksOrgTag(payload.organizationId));

    metadata.set("status", "loading_stores");
    metadata.set("step", "Loading Shopify stores");

    const stores = (await listShopifyStores()).filter(
      (store) => store.organizationId === payload.organizationId,
    );

    if (stores.length === 0) {
      logger.warn("No shopify_store rows for organization — nothing to check", {
        organizationId: payload.organizationId,
      });
      return { stores: 0, results: [] };
    }

    metadata.set("status", "evaluating");
    const results = [];
    for (const store of stores) {
      metadata.set("step", `Evaluating findings for ${store.shopDomain}`);
      results.push(await runChecksForStore(store));
    }

    metadata.set("status", "completed");
    return { stores: stores.length, results };
  },
});

export const attributionChecksScheduled = schedules.task({
  id: "attribution-checks-daily",
  // 3:30am PHT — after the Meta daily sync (0 18 * * *) and the hourly Shopify sync.
  cron: "30 19 * * *",
  run: async () => {
    const stores = await listShopifyStores();
    if (stores.length === 0) {
      logger.warn("No shopify_store rows found — nothing to check");
      return { stores: 0, results: [] };
    }

    const results = [];
    for (const store of stores) {
      results.push(await runChecksForStore(store));
    }

    return { stores: stores.length, results };
  },
});
