import "server-only";

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { KLAVIYO_API_REVISIONS, KlaviyoApiClient } from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  normalizeDimensionSnapshot,
  type DimensionTraversalInput,
  type NormalizedMarketingObject,
  type NormalizedTrackingSetting,
} from "@/lib/klaviyo/dimensions";
import {
  finishKlaviyoSyncRun,
  getConnectionRecord,
  prepareKlaviyoOperationRun,
  renewKlaviyoSyncRunHeartbeat,
  withKlaviyoConnectionLock,
} from "@/lib/klaviyo/source-store";
import {
  assertExactDimensionCheckpoint,
  type KlaviyoConnectionScope,
  type KlaviyoDimensionCheckpoint,
} from "@/lib/klaviyo/types";
import { klaviyoSyncRuns } from "@/schema/klaviyo";
import {
  klaviyoMarketingObjects,
  klaviyoTrackingSettings,
} from "@/schema/klaviyo-claim";

export const MAX_DIMENSION_REQUESTS_PER_BATCH = 10;

export type DimensionPage = {
  objects: NormalizedMarketingObject[];
  trackingSettings: NormalizedTrackingSetting[];
  warnings: string[];
  apiRevision: string;
};

export function initialDimensionCheckpoint(): KlaviyoDimensionCheckpoint {
  return {
    operation: "dimensions",
    stage: "campaigns_email",
    parentExternalId: null,
    cursor: null,
    page: 0,
  };
}

function sameDimensionCheckpoint(
  left: KlaviyoDimensionCheckpoint | null,
  right: KlaviyoDimensionCheckpoint | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.stage === right.stage &&
    left.parentExternalId === right.parentExternalId &&
    left.cursor === right.cursor &&
    left.page === right.page
  );
}

export async function startOrResumeDimensionSync(input: {
  scope: KlaviyoConnectionScope;
  triggerType: string;
  now: Date;
}): Promise<{ syncRunId: string; reused: boolean }> {
  return prepareKlaviyoOperationRun({
    scope: input.scope,
    operation: "dimensions",
    triggerType: input.triggerType,
    requestParameters: { operation: "dimensions" },
    now: input.now,
  });
}

/**
 * Commit one traversed dimension page: scoped upsert by external identity,
 * same-connection parent resolution (foreign parents are rejected), and an
 * atomic checkpoint/heartbeat/count advance guarded by compare-and-set.
 * Partial or failed traversals never delete previously observed objects.
 */
export async function commitKlaviyoDimensionPage(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  page: DimensionPage;
  expectedCheckpoint: KlaviyoDimensionCheckpoint | null;
  nextCheckpoint: KlaviyoDimensionCheckpoint | null;
  now: Date;
}): Promise<{ objectsUpserted: number; trackingUpserted: number }> {
  if (input.expectedCheckpoint !== null) {
    assertExactDimensionCheckpoint(input.expectedCheckpoint);
  }
  if (input.nextCheckpoint !== null) {
    assertExactDimensionCheckpoint(input.nextCheckpoint);
  }
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid commit time");

  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({
        status: klaviyoSyncRuns.status,
        checkpoint: klaviyoSyncRuns.checkpoint,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "dimensions"),
        ),
      )
      .for("update");
    if (!run) {
      throw new Error("Klaviyo dimension run is outside this scoped operation");
    }
    if (run.status !== "running") {
      throw new Error("Klaviyo dimension run is not active");
    }
    const storedCheckpoint =
      run.checkpoint === null
        ? null
        : (() => {
            assertExactDimensionCheckpoint(run.checkpoint);
            return run.checkpoint;
          })();
    if (!sameDimensionCheckpoint(storedCheckpoint, input.expectedCheckpoint)) {
      throw new Error("Klaviyo dimension checkpoint moved; replay this batch");
    }

    let objectsUpserted = 0;
    for (const object of input.page.objects) {
      let parentId: string | null = null;
      if (object.parentExternalId !== null) {
        if (object.parentObjectType === null) {
          throw new Error("Klaviyo dimension parent type is missing");
        }
        const [parent] = await tx
          .select({ id: klaviyoMarketingObjects.id })
          .from(klaviyoMarketingObjects)
          .where(
            and(
              eq(
                klaviyoMarketingObjects.connectionId,
                input.scope.connectionId,
              ),
              eq(klaviyoMarketingObjects.objectType, object.parentObjectType),
              eq(klaviyoMarketingObjects.externalId, object.parentExternalId),
            ),
          )
          .limit(1);
        if (!parent) {
          throw new Error(
            "Klaviyo dimension parent is outside this connection",
          );
        }
        parentId = parent.id;
      }
      await tx
        .insert(klaviyoMarketingObjects)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          objectType: object.objectType,
          externalId: object.externalId,
          parentId,
          name: object.name,
          channel: object.channel,
          status: object.status,
          providerCreatedAt: object.providerCreatedAt,
          providerUpdatedAt: object.providerUpdatedAt,
          trackingProjection: object.trackingProjection,
          sourceChecksum: `dimension:${object.objectType}:${object.externalId}`,
          apiRevision: input.page.apiRevision,
          fetchedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            klaviyoMarketingObjects.connectionId,
            klaviyoMarketingObjects.objectType,
            klaviyoMarketingObjects.externalId,
          ],
          set: {
            parentId,
            name: object.name,
            channel: object.channel,
            status: object.status,
            providerCreatedAt: object.providerCreatedAt,
            providerUpdatedAt: object.providerUpdatedAt,
            trackingProjection: object.trackingProjection,
            apiRevision: input.page.apiRevision,
            fetchedAt: now,
            updatedAt: now,
          },
        });
      objectsUpserted += 1;
    }

    let trackingUpserted = 0;
    for (const setting of input.page.trackingSettings) {
      let marketingObjectId: string | null = null;
      if (setting.marketingObjectExternalId !== null) {
        if (setting.marketingObjectType === null) {
          throw new Error("Klaviyo tracking setting object type is missing");
        }
        const [object] = await tx
          .select({ id: klaviyoMarketingObjects.id })
          .from(klaviyoMarketingObjects)
          .where(
            and(
              eq(
                klaviyoMarketingObjects.connectionId,
                input.scope.connectionId,
              ),
              eq(
                klaviyoMarketingObjects.objectType,
                setting.marketingObjectType,
              ),
              eq(
                klaviyoMarketingObjects.externalId,
                setting.marketingObjectExternalId,
              ),
            ),
          )
          .limit(1);
        if (!object) {
          throw new Error(
            "Klaviyo tracking setting object is outside this connection",
          );
        }
        marketingObjectId = object.id;
      }
      // The uniqueness guard is an expression index (coalesced object ID),
      // so upsert manually under the connection lock.
      const updated = await tx
        .update(klaviyoTrackingSettings)
        .set({
          valueMode: setting.valueMode,
          sanitizedValue: setting.sanitizedValue,
          enabled: setting.enabled ? 1 : 0,
          apiRevision: input.page.apiRevision,
          fetchedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(klaviyoTrackingSettings.connectionId, input.scope.connectionId),
            eq(klaviyoTrackingSettings.scope, setting.scope),
            marketingObjectId === null
              ? isNull(klaviyoTrackingSettings.marketingObjectId)
              : eq(klaviyoTrackingSettings.marketingObjectId, marketingObjectId),
            eq(klaviyoTrackingSettings.parameterName, setting.parameterName),
          ),
        )
        .returning({ id: klaviyoTrackingSettings.id });
      if (updated.length === 0) {
        await tx.insert(klaviyoTrackingSettings).values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          scope: setting.scope,
          marketingObjectId,
          marketingObjectType: setting.marketingObjectType,
          parameterName: setting.parameterName,
          valueMode: setting.valueMode,
          sanitizedValue: setting.sanitizedValue,
          enabled: setting.enabled ? 1 : 0,
          apiRevision: input.page.apiRevision,
          fetchedAt: now,
        });
      }
      trackingUpserted += 1;
    }

    const advanced = await tx
      .update(klaviyoSyncRuns)
      .set({
        checkpoint: input.nextCheckpoint,
        heartbeatAt: now,
        rowsRead: sql`${klaviyoSyncRuns.rowsRead} + ${input.page.objects.length}`,
        rowsInserted: sql`${klaviyoSyncRuns.rowsInserted} + ${objectsUpserted}`,
        warningCount: sql`${klaviyoSyncRuns.warningCount} + ${input.page.warnings.length}`,
        apiRevision: input.page.apiRevision,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (advanced.length !== 1) {
      throw new Error("Klaviyo dimension checkpoint advance raced");
    }
    return { objectsUpserted, trackingUpserted };
  });
}

async function listParentExternalIds(
  scope: KlaviyoConnectionScope,
  objectType: "campaign" | "flow",
  afterExternalId: string | null,
): Promise<string[]> {
  const rows = await db
    .select({ externalId: klaviyoMarketingObjects.externalId })
    .from(klaviyoMarketingObjects)
    .where(
      and(
        eq(klaviyoMarketingObjects.organizationId, scope.organizationId),
        eq(klaviyoMarketingObjects.storeId, scope.storeId),
        eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
        eq(klaviyoMarketingObjects.objectType, objectType),
        ...(afterExternalId === null
          ? []
          : [gt(klaviyoMarketingObjects.externalId, afterExternalId)]),
      ),
    )
    .orderBy(asc(klaviyoMarketingObjects.externalId));
  return rows.map((row) => row.externalId);
}

export type DimensionClient = Pick<
  KlaviyoApiClient,
  | "listCampaigns"
  | "listCampaignMessages"
  | "listFlows"
  | "listFlowActions"
  | "listFlowMessages"
  | "getTrackingSettings"
>;

export type DimensionRunnerDependencies = {
  createClient?: (privateApiKey: string) => DimensionClient;
  credentialProvider?: KlaviyoCredentialProvider;
  now?: () => Date;
  loadConnection?: typeof getConnectionRecord;
  renewHeartbeat?: typeof renewKlaviyoSyncRunHeartbeat;
  commitPage?: typeof commitKlaviyoDimensionPage;
  finishRun?: typeof finishKlaviyoSyncRun;
  listParents?: typeof listParentExternalIds;
  loadRun?: (
    scope: KlaviyoConnectionScope,
    syncRunId: string,
  ) => Promise<{
    status: string;
    checkpoint: KlaviyoDimensionCheckpoint | null;
    startedFresh: boolean;
  }>;
};

async function defaultLoadDimensionRun(
  scope: KlaviyoConnectionScope,
  syncRunId: string,
): Promise<{
  status: string;
  checkpoint: KlaviyoDimensionCheckpoint | null;
  startedFresh: boolean;
}> {
  const [run] = await db
    .select({
      status: klaviyoSyncRuns.status,
      checkpoint: klaviyoSyncRuns.checkpoint,
      rowsRead: klaviyoSyncRuns.rowsRead,
    })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.id, syncRunId),
        eq(klaviyoSyncRuns.organizationId, scope.organizationId),
        eq(klaviyoSyncRuns.storeId, scope.storeId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
        eq(klaviyoSyncRuns.operation, "dimensions"),
      ),
    )
    .limit(1);
  if (!run) {
    throw new Error("Klaviyo dimension run is outside this scoped operation");
  }
  const checkpoint =
    run.checkpoint === null
      ? null
      : (() => {
          assertExactDimensionCheckpoint(run.checkpoint);
          return run.checkpoint as KlaviyoDimensionCheckpoint;
        })();
  return {
    status: run.status,
    checkpoint,
    startedFresh: run.checkpoint === null && run.rowsRead === 0,
  };
}

export type DimensionBatchResult =
  | { done: false; checkpoint: KlaviyoDimensionCheckpoint }
  | { done: true; checkpoint: null };

function emptyTraversal(): DimensionTraversalInput {
  return {
    campaigns: [],
    campaignMessages: [],
    flows: [],
    flowActions: [],
    flowMessages: [],
    accountTrackingSettings: [],
    messageTrackingSettings: [],
    apiRevisions: {},
  };
}

function pageFromTraversal(
  traversal: DimensionTraversalInput,
  apiRevision: string,
): DimensionPage {
  const snapshot = normalizeDimensionSnapshot(traversal);
  return {
    objects: snapshot.objects,
    trackingSettings: snapshot.trackingSettings,
    warnings: snapshot.warnings,
    apiRevision,
  };
}

/**
 * Bounded dimension traversal batch. Stages advance
 * campaigns_email → campaigns_sms → campaign_messages → flows →
 * flow_messages → tracking_account; each committed page atomically stores
 * data, checkpoint, and heartbeat, so any retry replays from the durable
 * checkpoint without duplicating observed objects.
 */
export async function processDimensionBatch(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
    maxRequests?: number;
  },
  dependencies: DimensionRunnerDependencies = {},
): Promise<DimensionBatchResult & { requestsUsed: number }> {
  const now = dependencies.now ?? (() => new Date());
  const loadRun = dependencies.loadRun ?? defaultLoadDimensionRun;
  const loadConnection = dependencies.loadConnection ?? getConnectionRecord;
  const renewHeartbeat =
    dependencies.renewHeartbeat ?? renewKlaviyoSyncRunHeartbeat;
  const commitPage = dependencies.commitPage ?? commitKlaviyoDimensionPage;
  const finishRun = dependencies.finishRun ?? finishKlaviyoSyncRun;
  const listParents = dependencies.listParents ?? listParentExternalIds;
  const maxRequests = input.maxRequests ?? MAX_DIMENSION_REQUESTS_PER_BATCH;

  const run = await loadRun(input.scope, input.syncRunId);
  if (run.status !== "running") {
    throw new Error("Klaviyo dimension run is not active");
  }
  const connection = await loadConnection(input.scope);
  if (!connection) {
    throw new Error("Klaviyo connection is outside this scope");
  }
  if (connection.status === "disabled") {
    throw new Error("Klaviyo connection is disabled");
  }
  const credentialProvider =
    dependencies.credentialProvider ??
    new EnvironmentKlaviyoCredentialProvider();
  const credential = await credentialProvider.resolve({
    connectionId: connection.connectionId,
    credentialReference: connection.credentialReference,
    persistedKlaviyoAccountId: connection.klaviyoAccountId,
    shopDomain: connection.shopDomain,
  });
  const createClient =
    dependencies.createClient ??
    ((privateApiKey: string): DimensionClient =>
      new KlaviyoApiClient({ privateApiKey }));
  const client = createClient(credential.privateApiKey);

  let checkpoint: KlaviyoDimensionCheckpoint =
    run.checkpoint ?? initialDimensionCheckpoint();
  let requestsUsed = 0;
  let storedCheckpoint = run.checkpoint;

  const commitWithExpected = async (
    traversal: DimensionTraversalInput,
    apiRevision: string,
    nextCheckpoint: KlaviyoDimensionCheckpoint | null,
  ): Promise<void> => {
    await commitPage({
      scope: input.scope,
      syncRunId: input.syncRunId,
      page: pageFromTraversal(traversal, apiRevision),
      expectedCheckpoint: storedCheckpoint,
      nextCheckpoint,
      now: now(),
    });
    storedCheckpoint = nextCheckpoint;
    if (nextCheckpoint !== null) checkpoint = nextCheckpoint;
  };

  while (requestsUsed < maxRequests) {
    await renewHeartbeat({
      scope: input.scope,
      syncRunId: input.syncRunId,
      operation: "dimensions",
      now: now(),
    });

    if (
      checkpoint.stage === "campaigns_email" ||
      checkpoint.stage === "campaigns_sms"
    ) {
      const channel = checkpoint.stage === "campaigns_email" ? "email" : "sms";
      const page = await client.listCampaigns({
        channel,
        cursor: checkpoint.cursor,
      });
      requestsUsed += 1;
      const traversal = emptyTraversal();
      traversal.campaigns = page.data
        .filter((resource) => resource.type === "campaign")
        .map((resource) => ({ channel, resource }));
      traversal.apiRevisions.campaigns = page.apiRevision;
      const nextCheckpoint: KlaviyoDimensionCheckpoint =
        page.nextCursor !== null
          ? { ...checkpoint, cursor: page.nextCursor, page: checkpoint.page + 1 }
          : channel === "email"
            ? {
                operation: "dimensions",
                stage: "campaigns_sms",
                parentExternalId: null,
                cursor: null,
                page: 0,
              }
            : {
                operation: "dimensions",
                stage: "campaign_messages",
                parentExternalId: null,
                cursor: null,
                page: 0,
              };
      await commitWithExpected(traversal, page.apiRevision, nextCheckpoint);
      continue;
    }

    if (checkpoint.stage === "campaign_messages") {
      const [parent] = await listParents(
        input.scope,
        "campaign",
        checkpoint.parentExternalId,
      );
      if (parent === undefined) {
        checkpoint = {
          operation: "dimensions",
          stage: "flows",
          parentExternalId: null,
          cursor: null,
          page: 0,
        };
        await commitWithExpected(
          emptyTraversal(),
          KLAVIYO_API_REVISIONS.campaigns,
          checkpoint,
        );
        continue;
      }
      const traversal = emptyTraversal();
      traversal.campaigns = [];
      let cursor: string | null = null;
      do {
        const page = await client.listCampaignMessages({
          campaignId: parent,
          cursor,
        });
        requestsUsed += 1;
        traversal.campaignMessages.push(
          ...page.data
            .filter((resource) => resource.type === "campaign-message")
            .map((resource) => ({ campaignExternalId: parent, resource })),
        );
        traversal.apiRevisions.campaigns = page.apiRevision;
        cursor = page.nextCursor;
      } while (cursor !== null);
      // The normalizer proves campaign-message parents against the input
      // campaign set; page-level commits resolve parents from the store.
      traversal.campaigns = traversal.campaignMessages.map((message) => ({
        channel: "email" as const,
        resource: { type: "campaign", id: message.campaignExternalId },
      }));
      const traversalObjects = normalizeDimensionSnapshot(traversal);
      const messagesOnly: DimensionPage = {
        objects: traversalObjects.objects.filter(
          (object) => object.objectType === "campaign_message",
        ),
        trackingSettings: [],
        warnings: traversalObjects.warnings,
        apiRevision: KLAVIYO_API_REVISIONS.campaigns,
      };
      const nextCheckpoint: KlaviyoDimensionCheckpoint = {
        operation: "dimensions",
        stage: "campaign_messages",
        parentExternalId: parent,
        cursor: null,
        page: checkpoint.page + 1,
      };
      await commitPage({
        scope: input.scope,
        syncRunId: input.syncRunId,
        page: messagesOnly,
        expectedCheckpoint: storedCheckpoint,
        nextCheckpoint,
        now: now(),
      });
      storedCheckpoint = nextCheckpoint;
      checkpoint = nextCheckpoint;
      continue;
    }

    if (checkpoint.stage === "flows") {
      const page = await client.listFlows({ cursor: checkpoint.cursor });
      requestsUsed += 1;
      const traversal = emptyTraversal();
      traversal.flows = page.data.filter(
        (resource) => resource.type === "flow",
      );
      traversal.apiRevisions.flows = page.apiRevision;
      const nextCheckpoint: KlaviyoDimensionCheckpoint =
        page.nextCursor !== null
          ? { ...checkpoint, cursor: page.nextCursor, page: checkpoint.page + 1 }
          : {
              operation: "dimensions",
              stage: "flow_messages",
              parentExternalId: null,
              cursor: null,
              page: 0,
            };
      await commitWithExpected(traversal, page.apiRevision, nextCheckpoint);
      continue;
    }

    if (checkpoint.stage === "flow_messages") {
      const [parent] = await listParents(
        input.scope,
        "flow",
        checkpoint.parentExternalId,
      );
      if (parent === undefined) {
        checkpoint = {
          operation: "dimensions",
          stage: "tracking_account",
          parentExternalId: null,
          cursor: null,
          page: 0,
        };
        await commitWithExpected(
          emptyTraversal(),
          KLAVIYO_API_REVISIONS.flows,
          checkpoint,
        );
        continue;
      }
      const traversal = emptyTraversal();
      traversal.flows = [{ type: "flow", id: parent }];
      let actionCursor: string | null = null;
      const actionIds: string[] = [];
      do {
        const page = await client.listFlowActions({
          flowId: parent,
          cursor: actionCursor,
        });
        requestsUsed += 1;
        for (const resource of page.data) {
          if (resource.type !== "flow-action") continue;
          traversal.flowActions.push({ flowExternalId: parent, resource });
          actionIds.push(resource.id);
        }
        traversal.apiRevisions.flows = page.apiRevision;
        actionCursor = page.nextCursor;
      } while (actionCursor !== null);
      for (const actionId of actionIds) {
        let messageCursor: string | null = null;
        do {
          const page = await client.listFlowMessages({
            actionId,
            cursor: messageCursor,
          });
          requestsUsed += 1;
          traversal.flowMessages.push(
            ...page.data
              .filter((resource) => resource.type === "flow-message")
              .map((resource) => ({
                flowExternalId: parent,
                actionExternalId: actionId,
                resource,
              })),
          );
          messageCursor = page.nextCursor;
        } while (messageCursor !== null);
      }
      const normalized = normalizeDimensionSnapshot(traversal);
      const messagesOnly: DimensionPage = {
        objects: normalized.objects.filter(
          (object) => object.objectType === "flow_message",
        ),
        trackingSettings: [],
        warnings: normalized.warnings,
        apiRevision: KLAVIYO_API_REVISIONS.flows,
      };
      const nextCheckpoint: KlaviyoDimensionCheckpoint = {
        operation: "dimensions",
        stage: "flow_messages",
        parentExternalId: parent,
        cursor: null,
        page: checkpoint.page + 1,
      };
      await commitPage({
        scope: input.scope,
        syncRunId: input.syncRunId,
        page: messagesOnly,
        expectedCheckpoint: storedCheckpoint,
        nextCheckpoint,
        now: now(),
      });
      storedCheckpoint = nextCheckpoint;
      checkpoint = nextCheckpoint;
      continue;
    }

    // tracking_account: final stage; terminal empty page finishes success.
    const page = await client.getTrackingSettings({
      scope: "account",
      externalId: null,
      cursor: checkpoint.cursor,
    });
    requestsUsed += 1;
    const traversal = emptyTraversal();
    traversal.accountTrackingSettings = page.data.filter(
      (resource) => resource.type === "tracking-setting",
    );
    traversal.apiRevisions.trackingSettings = page.apiRevision;
    if (page.nextCursor !== null) {
      const nextCheckpoint: KlaviyoDimensionCheckpoint = {
        ...checkpoint,
        cursor: page.nextCursor,
        page: checkpoint.page + 1,
      };
      await commitWithExpected(traversal, page.apiRevision, nextCheckpoint);
      continue;
    }
    await commitWithExpected(traversal, page.apiRevision, null);
    await finishRun({
      scope: input.scope,
      syncRunId: input.syncRunId,
      operation: "dimensions",
      status: "success",
    });
    return { done: true, checkpoint: null, requestsUsed };
  }

  return { done: false, checkpoint, requestsUsed };
}
