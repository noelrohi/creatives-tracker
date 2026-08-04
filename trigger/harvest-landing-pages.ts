/**
 * Landing-page harvest (spec §5.1) as its own task, so the first run over
 * existing ads and orders — which is the backfill — can be triggered by hand
 * with `{ organizationId, storeId? }`. The syncs call the same function inline.
 */
import { logger, metadata, tags, task } from "@trigger.dev/sdk";
import { harvestLandingPages } from "@/lib/landing-page";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

export type HarvestLandingPagesPayload = {
  organizationId: string;
  /** Omitted: every store of the organization. */
  storeId?: string;
};

export const harvestLandingPagesTask = task({
  id: "harvest-landing-pages",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: { name: "harvest-landing-pages", concurrencyLimit: 1 },
  run: async (payload: HarvestLandingPagesPayload) => {
    await tags.add(`harvest-landing-pages:org:${payload.organizationId}`);

    metadata.set("status", "harvesting");
    metadata.set("step", "Harvesting landing pages from ads and journeys");

    const result = await harvestLandingPages({
      organizationId: payload.organizationId,
      storeId: payload.storeId,
    });

    metadata.set("status", "completed");
    logger.info("Harvested landing pages", {
      organizationId: payload.organizationId,
      storeId: payload.storeId,
      ...result,
    });

    return {
      ...result,
      summary: `Harvested ${result.pages} landing pages, linked ${result.adsLinked} ads and ${result.ordersLinked} orders`,
    };
  },
});
