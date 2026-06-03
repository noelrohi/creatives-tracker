import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import { PAUSED_META_STATUS } from "@/lib/launchpad-constants";
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

    if (payload.itemIds.length !== 1) {
      throw new Error("Launchpad publish task only supports one item in this release");
    }

    const itemId = payload.itemIds[0];
    metadata.set("itemId", itemId);
    metadata.set("step", "Calling internal publish procedure");

    logger.info("Starting Launchpad publish task", {
      organizationId: payload.organizationId,
      runId: payload.runId,
      itemId,
      requestedStatus: payload.requestedStatus,
    });

    const result = await client.launchpad.workerExecuteLivePublish.mutate({
      runId: payload.runId,
      itemId,
      requestedStatus: PAUSED_META_STATUS,
    });

    metadata.set("status", result.status);
    metadata.set("step", "Launchpad publish task completed");

    logger.info("Completed Launchpad publish task", {
      organizationId: payload.organizationId,
      runId: payload.runId,
      itemId,
      status: result.status,
      replayed: "replayed" in result ? result.replayed : false,
    });

    return result;
  },
});
