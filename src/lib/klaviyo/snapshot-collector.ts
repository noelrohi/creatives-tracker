import "server-only";
import { z } from "zod";

import { computeErasureSuppressionDigests, parseErasureSuppressionKey, parseIdentityHmacKeyring, type IdentityHmacKeyring, type ErasureSuppressionKey } from "@/lib/identity-hmac";
import { readCampaigns, readMetrics, readEventsForCollection } from "./collection-reads";
import { readCampaignValues } from "./campaign-value-reads";
import { EnvironmentKlaviyoCredentialProvider, type KlaviyoCredentialProvider } from "./credential-provider";
import { KlaviyoReadError, KlaviyoReadTransport, type KlaviyoReadRequester } from "./read-transport";
import { getConnectionRecord } from "./source-store";
import { commitSnapshotPage, loadSnapshotRun, publishSnapshotRun, failSnapshotRun } from "./snapshot-store";
import {
  assertExactSnapshotCheckpoint, canonicalInstant, canonicalSnapshotJson,
  snapshotCheckpointComplete, KLAVIYO_SNAPSHOT_MAX_PAGES_PER_BATCH,
  type KlaviyoStagedSnapshotRecord, type KlaviyoSnapshotErrorCode, type KlaviyoSnapshotCheckpoint,
} from "./snapshot-contracts";

const accountResponseSchema = z.object({
  data: z.array(z.object({ type: z.literal("account"), id: z.string().min(1) })).length(1),
  links: z.object({ next: z.null().optional() }).nullish(),
});

/** Worker-only orchestration. Provider bodies and emails never enter checkpoints or task output. */
export async function processSnapshotBatch(
  snapshotRunId: string,
  dependencies: {
    credentialProvider?: KlaviyoCredentialProvider;
    createClient?: (key: string) => KlaviyoReadRequester;
    loadSuppressionKey?: () => ErasureSuppressionKey;
    loadIdentityKeyring?: () => IdentityHmacKeyring;
    now?: () => Date;
    leaseToken?: string;
  } = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const { scope, row } = await loadSnapshotRun(snapshotRunId);
  if (row.state !== "running") return { done: true, state: row.state, page: row.pageCount };
  if (dependencies.leaseToken && dependencies.leaseToken !== row.leaseToken) {
    return { done: true, state: "lease_lost", page: row.pageCount };
  }
  const connection = await getConnectionRecord(scope);
  if (!connection || connection.status !== "ready" || !connection.klaviyoAccountId) {
    await failSnapshotRun({ scope, snapshotRunId, leaseToken: row.leaseToken, code: "failed", now: now() });
    return { done: true, state: "failed", page: row.pageCount };
  }
  let failureCode: KlaviyoSnapshotErrorCode = "failed";
  try {
    const credential = await (dependencies.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider()).resolve({
      connectionId: scope.connectionId,
      credentialReference: connection.credentialReference,
      persistedKlaviyoAccountId: connection.klaviyoAccountId,
      shopDomain: connection.shopDomain,
    });
    if (credential.expectedAccountId !== connection.klaviyoAccountId || row.accountId !== connection.klaviyoAccountId) throw new Error("Account binding mismatch");
    const client = (dependencies.createClient ?? ((key) => new KlaviyoReadTransport({ privateApiKey: key })))(credential.privateApiKey);
    // Environment expectedAccountId is configuration, not proof of key ownership.
    // Verify using the very same keyed transport on every batch/resume, before
    // any dataset IO or publication. Never persist the account response body.
    const account = accountResponseSchema.safeParse(await client.request({ resource: "accounts" }));
    if (!account.success || account.data.data[0].id !== row.accountId) {
      throw new KlaviyoReadError("credential_rejected");
    }
    const request = row.resolvedScope;
    // A completed checkpoint may be resumed directly into publication; always
    // reload the validated crypto key rather than checkpointing private material.
    if (request.dataset === "events") failureCode = "privacyUnresolved";
    const suppressionKey = request.dataset === "events"
      ? (dependencies.loadSuppressionKey ?? parseErasureSuppressionKey)() : null;
    const privacyKeys = suppressionKey ? {
      suppressionKey, keyring: (dependencies.loadIdentityKeyring ?? parseIdentityHmacKeyring)(),
    } : undefined;
    failureCode = "failed";
    assertExactSnapshotCheckpoint(row.checkpoint);
    let checkpoint: KlaviyoSnapshotCheckpoint = row.checkpoint;
    for (let page = 0; page < KLAVIYO_SNAPSHOT_MAX_PAGES_PER_BATCH; page++) {
      if (snapshotCheckpointComplete(checkpoint)) {
        const result = await publishSnapshotRun({
          scope, snapshotRunId, leaseToken: row.leaseToken, now: now(), suppressionKey, privacyKeys,
          providerCompleteness: row.providerCompleteness === "unverified" ? "unverified" : "complete",
          warnings: row.warnings,
        });
        return { done: true, state: result.published ? "published" : "failed", page: checkpoint.page };
      }
      const continuation = checkpoint.continuation ?? undefined;
      let records: KlaviyoStagedSnapshotRecord[];
      let next: string | null;
      let reportMetadata: Parameters<typeof commitSnapshotPage>[0]["reportMetadata"];
      if (request.dataset === "campaigns") {
        const result = await readCampaigns(client, scope, { continuation });
        records = [
          ...result.campaigns.map((content) => ({ resourceKind: "campaign" as const, providerIdentity: content.campaignId, orderingKey: content.campaignId, content })),
          ...result.messages.map((content) => ({ resourceKind: "campaign_message" as const, providerIdentity: content.messageId, orderingKey: content.messageId, content })),
        ];
        next = result.nextContinuation;
      } else if (request.dataset === "metrics") {
        const result = await readMetrics(client, scope, { continuation });
        records = result.metrics.map((content) => ({ resourceKind: "metric", providerIdentity: content.metricId, orderingKey: content.metricId, content }));
        next = result.nextContinuation;
      } else if (request.dataset === "events") {
        const result = await readEventsForCollection(client, scope, {
          metricIds: request.metricIds, since: request.since, until: request.until, continuation,
        }, row.anchorAt!);
        records = result.events.map((content) => {
          const record: KlaviyoStagedSnapshotRecord = {
            resourceKind: "event", providerIdentity: content.eventId,
            orderingKey: JSON.stringify([canonicalInstant(content.datetime), content.eventId]),
            content, profileId: content.profileId, metricId: content.metricId,
            eventDatetime: content.datetime,
          };
          if (content.profileId !== null) {
            const email = result.profileEmailById.get(content.profileId);
            if (!email) {
              failureCode = "privacyUnresolved";
              throw new Error("Profile privacy resolution unavailable");
            }
            const digests = computeErasureSuppressionDigests({ scope, key: suppressionKey!, email, klaviyoProfileId: content.profileId });
            record.identity = {
              keyVersion: suppressionKey!.version,
              emailDigest: digests.find((item) => item.kind === "email")!.digest,
              profileDigest: digests.find((item) => item.kind === "klaviyo_profile_id")!.digest,
            };
          }
          return record;
        });
        next = result.nextContinuation;
      } else {
        if (!row.timezone || row.timezone !== connection.accountTimezone) throw new Error("Account timezone changed");
        const result = await readCampaignValues(client, { ...scope, accountTimezone: row.timezone }, {
          conversionMetricId: request.conversionMetricId, since: request.since, until: request.until,
        }, row.anchorAt!);
        if (result.completeness === "more_available") {
          failureCode = "incomplete";
          throw new Error("Known incomplete report");
        }
        reportMetadata = result;
        records = result.rows.map((content) => {
          const identity = JSON.stringify([content.campaignId, content.campaignMessageId, content.sendChannel]);
          return { resourceKind: "campaign_value_row", providerIdentity: identity, orderingKey: identity, content };
        });
        next = null;
      }
      const unique = new Map<string, KlaviyoStagedSnapshotRecord>();
      for (const record of records) {
        const key = JSON.stringify([record.resourceKind, record.providerIdentity]);
        const prior = unique.get(key);
        if (prior && canonicalSnapshotJson(prior.content) !== canonicalSnapshotJson(record.content)) {
          throw new Error("Conflicting record identity in provider page");
        }
        unique.set(key, record);
      }
      const nextCheckpoint: KlaviyoSnapshotCheckpoint = { dataset: request.dataset, continuation: next, page: checkpoint.page + 1 };
      const committed = await commitSnapshotPage({ scope, snapshotRunId, leaseToken: row.leaseToken,
        expectedCheckpoint: checkpoint, nextCheckpoint, records: [...unique.values()], reportMetadata, privacyKeys, now: now() });
      if (!committed.committed) return { done: false, state: "running", page: checkpoint.page };
      checkpoint = nextCheckpoint;
      if (reportMetadata) {
        row.providerCompleteness = "unverified";
        row.warnings = reportMetadata.warnings;
      }
    }
    return { done: false, state: "running", page: checkpoint.page };
  } catch (error) {
    // Transient transport failures retain the checkpoint for a task retry;
    // no provider exception text crosses the worker boundary.
    if (error instanceof KlaviyoReadError && ["rate_limited", "unavailable"].includes(error.code)) {
      throw new KlaviyoReadError(error.code, error.retryAfterMs);
    }
    await failSnapshotRun({ scope, snapshotRunId, leaseToken: row.leaseToken, code: failureCode, now: now() });
    return { done: true, state: "failed", page: row.pageCount };
  }
}
