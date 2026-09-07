import "server-only";

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { db } from "@/db";
import { klaviyoConnections } from "@/schema/klaviyo";
import { klaviyoSnapshotContents, klaviyoSnapshotRecords, klaviyoSnapshotRuns } from "@/schema/klaviyo-snapshot";
import {
  buildSnapshotNotAvailable, canonicalizeSnapshotScope, decodeSnapshotReadContinuation,
  encodeSnapshotReadContinuation, KLAVIYO_SNAPSHOT_FRESHNESS_TARGET_MS,
  KLAVIYO_SNAPSHOT_READ_PAGE_SIZE, snapshotScopeFingerprint,
  snapshotCampaignsReadOutputSchema, snapshotMetricsReadOutputSchema,
  snapshotEventsReadOutputSchema, snapshotCampaignValuesReadOutputSchema,
  type KlaviyoSnapshotReadInput, type KlaviyoSnapshotResourceKind,
} from "./snapshot-contracts";

/** DB-only boundary: deliberately does not import write-side stores or provider services. */
export async function readSnapshot(organizationId: string, input: KlaviyoSnapshotReadInput) {
  const scope = canonicalizeSnapshotScope(input);
  const fingerprint = snapshotScopeFingerprint(scope);
  const token = input.continuation ? decodeSnapshotReadContinuation(input.continuation) : null;
  if (input.continuation && (!token || token.dataset !== input.dataset ||
    token.scopeFingerprint !== fingerprint || (input.snapshotId && input.snapshotId !== token.snapshotId))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid snapshot continuation" });
  }
  const snapshotId = token?.snapshotId ?? input.snapshotId;
  try {
    // One MVCC view keeps privacy-adjusted metadata and surviving records consistent.
    return await db.transaction(async (tx) => {
      const connections = await tx.select({ id: klaviyoConnections.id, storeId: klaviyoConnections.storeId, accountId: klaviyoConnections.klaviyoAccountId, status: klaviyoConnections.status })
        .from(klaviyoConnections).where(eq(klaviyoConnections.organizationId, organizationId)).limit(2);
      // There is no public connection selector: do not silently choose an account
      // if an organization has more than one stored binding.
      if (connections.length !== 1) return buildSnapshotNotAvailable(input.dataset, "not_configured");
      const connection = connections[0];
      if (connection.status === "disabled" || !connection.accountId) {
        return buildSnapshotNotAvailable(input.dataset, "not_configured");
      }
      const binding = and(
        eq(klaviyoSnapshotRuns.organizationId, organizationId),
        eq(klaviyoSnapshotRuns.storeId, connection.storeId),
        eq(klaviyoSnapshotRuns.connectionId, connection.id),
        eq(klaviyoSnapshotRuns.accountId, connection.accountId),
        eq(klaviyoSnapshotRuns.dataset, input.dataset),
        eq(klaviyoSnapshotRuns.scopeFingerprint, fingerprint),
      );
      const [run] = await tx.select().from(klaviyoSnapshotRuns).where(and(binding,
        eq(klaviyoSnapshotRuns.state, "published"),
        snapshotId ? eq(klaviyoSnapshotRuns.id, snapshotId) : eq(klaviyoSnapshotRuns.isCurrent, 1),
      )).orderBy(desc(klaviyoSnapshotRuns.publishedAt), desc(klaviyoSnapshotRuns.id)).limit(1);
      if (!run) return buildSnapshotNotAvailable(input.dataset,
        snapshotId ? "snapshot_not_found" : scope.dataset === "events" || scope.dataset === "campaign_values" ? "scope_not_synced" : "not_synced", scope);
      const [latest] = await tx.select().from(klaviyoSnapshotRuns).where(binding)
        .orderBy(desc(klaviyoSnapshotRuns.startedAt), desc(klaviyoSnapshotRuns.id)).limit(1);
      const after = token?.position;
      const rows = await tx.select({ resourceKind: klaviyoSnapshotRecords.resourceKind,
        orderingKey: klaviyoSnapshotRecords.orderingKey, content: klaviyoSnapshotContents.content })
        .from(klaviyoSnapshotRecords).innerJoin(klaviyoSnapshotContents,
          eq(klaviyoSnapshotContents.id, klaviyoSnapshotRecords.contentId))
        .where(and(eq(klaviyoSnapshotRecords.snapshotRunId, run.id), after ? or(
          gt(klaviyoSnapshotRecords.resourceKind, after.resourceKind),
          and(eq(klaviyoSnapshotRecords.resourceKind, after.resourceKind), gt(klaviyoSnapshotRecords.orderingKey, after.orderingKey)),
        ) : undefined)).orderBy(asc(klaviyoSnapshotRecords.resourceKind), asc(klaviyoSnapshotRecords.orderingKey))
        .limit(KLAVIYO_SNAPSHOT_READ_PAGE_SIZE + 1);
      const page = rows.slice(0, KLAVIYO_SNAPSHOT_READ_PAGE_SIZE);
      const last = page.at(-1);
      const result = {
        state: "available" as const,
        snapshot: {
          snapshotId: run.id, dataset: run.dataset, configurationVersion: run.configurationVersion,
          triggerType: run.triggerType, apiRevision: run.apiRevision,
          collectionInterval: { start: run.startedAt.toISOString(), end: run.finishedAt!.toISOString() },
          publishedAt: run.publishedAt!.toISOString(),
          requestedWindow: run.requestedFrom && run.requestedTo ? { since: run.requestedFrom.toISOString(), until: run.requestedTo.toISOString() } : null,
          providerWindow: run.providerWindowStart && run.providerWindowEnd ? { start: run.providerWindowStart, end: run.providerWindowEnd } : null,
          timezone: run.timezone, providerCompleteness: run.providerCompleteness, warnings: run.warnings,
          freshness: Date.now() - run.publishedAt!.getTime() >= KLAVIYO_SNAPSHOT_FRESHNESS_TARGET_MS ? "stale" : "fresh",
          recordCount: run.recordCount,
          privacy: { adjusted: run.privacyAdjusted === 1, adjustedAt: run.privacyAdjustedAt?.toISOString() ?? null, removedRecords: run.privacyRemovedCount },
          latestRefresh: latest ? { status: latest.state, startedAt: latest.startedAt.toISOString(), errorCode: latest.errorCode, errorMessage: latest.errorMessage } : null,
        },
        nextContinuation: rows.length > page.length && last ? encodeSnapshotReadContinuation({
          version: 1, snapshotId: run.id, dataset: input.dataset, scopeFingerprint: fingerprint,
          position: { resourceKind: last.resourceKind as KlaviyoSnapshotResourceKind, orderingKey: last.orderingKey },
        }) : null,
      };
      const records = (kind: KlaviyoSnapshotResourceKind) => page.filter((row) => row.resourceKind === kind).map((row) => row.content);
      switch (input.dataset) {
        case "campaigns": return snapshotCampaignsReadOutputSchema.parse({ ...result, campaigns: records("campaign"), messages: records("campaign_message") });
        case "metrics": return snapshotMetricsReadOutputSchema.parse({ ...result, metrics: records("metric") });
        case "events": return snapshotEventsReadOutputSchema.parse({ ...result, events: records("event") });
        case "campaign_values": return snapshotCampaignValuesReadOutputSchema.parse({ ...result, rows: records("campaign_value_row") });
      }
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Klaviyo snapshot read failed" });
  }
}
