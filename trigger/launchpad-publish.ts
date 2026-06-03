import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import {
  LAUNCHPAD_MAX_ITEMS,
  PAUSED_META_STATUS,
} from "@/lib/launchpad-constants";
import { createApiClient, getEnvConfig } from "./client";

type LaunchpadPublishPayload = {
  organizationId: string;
  runId: string;
  itemIds: string[];
  requestedStatus: typeof PAUSED_META_STATUS;
};

function launchpadOrgTag(organizationId: string) {
  return `launchpad-publish:org:${organizationId}`;
}

export const launchpadPublishTask = task({
  id: "launchpad-publish",
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload: LaunchpadPublishPayload) => {
    const { apiUrl, apiKey } = getEnvConfig();
    const client = createApiClient(apiUrl, apiKey, payload.organizationId);

    await tags.add(launchpadOrgTag(payload.organizationId));
    metadata.set("status", "publishing");
    metadata.set("organizationId", payload.organizationId);
    metadata.set("runId", payload.runId);
    metadata.set("itemCount", payload.itemIds.length);

    if (payload.requestedStatus !== PAUSED_META_STATUS) {
      throw new Error("Launchpad publish task only supports PAUSED Meta ads");
    }

    if (payload.itemIds.length < 1 || payload.itemIds.length > LAUNCHPAD_MAX_ITEMS) {
      throw new Error(`Launchpad publish task supports 1-${LAUNCHPAD_MAX_ITEMS} items`);
    }

    metadata.set("step", "Calling internal publish procedure");

    logger.info("Starting Launchpad publish task", {
      organizationId: payload.organizationId,
      runId: payload.runId,
      itemCount: payload.itemIds.length,
      requestedStatus: payload.requestedStatus,
    });

    const results = [];
    for (const [index, itemId] of payload.itemIds.entries()) {
      metadata.set("itemId", itemId);
      metadata.set("currentItem", index + 1);
      metadata.set("progress", Math.round((index / payload.itemIds.length) * 100));

      const result = await client.launchpad.workerExecuteLivePublish.mutate({
        runId: payload.runId,
        itemId,
        requestedStatus: PAUSED_META_STATUS,
      });

      results.push({ itemId, result });
      metadata.set("status", result.runStatus);

      logger.info("Completed Launchpad publish item", {
        organizationId: payload.organizationId,
        runId: payload.runId,
        itemId,
        status: result.status,
        runStatus: result.runStatus,
        replayed: "replayed" in result ? result.replayed : false,
      });
    }

    const lastResult = results.at(-1)?.result;
    const status = lastResult?.runStatus ?? "success";
    metadata.set("status", status);
    metadata.set("progress", 100);
    metadata.set("step", "Launchpad publish task completed");

    logger.info("Completed Launchpad publish task", {
      organizationId: payload.organizationId,
      runId: payload.runId,
      itemCount: payload.itemIds.length,
      status,
    });

    return { status, itemCount: payload.itemIds.length, results };
  },
});
