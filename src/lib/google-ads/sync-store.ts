import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  googleAdsCampaignFacts,
  googleAdsConnections,
  googleAdsSyncRuns,
} from "@/schema/google-ads";
import { shopifyStores } from "@/schema/shopify";
import {
  EnvironmentGoogleAdsCredentialProvider,
  type GoogleAdsCredentialProvider,
} from "@/lib/google-ads/credential-provider";
import type { NormalizedCampaignFact } from "@/lib/google-ads/facts";
import type { GoogleAdsScope } from "@/lib/google-ads/types";

export type ConnectionRecord = typeof googleAdsConnections.$inferSelect;
export type SyncRunRecord = typeof googleAdsSyncRuns.$inferSelect;

export type SanitizedSyncError = { code: string; message: string };

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/**
 * Resolves the pilot store from the provider's server-side shop-domain
 * binding and returns (creating if absent) its single pending connection.
 * Never accepts caller-supplied scope.
 */
export async function ensurePilotGoogleAdsConnection(
  provider: GoogleAdsCredentialProvider = new EnvironmentGoogleAdsCredentialProvider(),
): Promise<ConnectionRecord> {
  const binding = await provider.getPilotBinding();
  const [store] = await db
    .select({ id: shopifyStores.id, organizationId: shopifyStores.organizationId })
    .from(shopifyStores)
    .where(eq(shopifyStores.shopDomain, binding.shopDomain))
    .limit(1);
  if (!store) {
    throw new Error("Configured Google Ads shop domain has no Shopify store");
  }
  const existing = await getPilotGoogleAdsConnectionForOrganization(
    store.organizationId,
  );
  if (existing) return existing;
  const [created] = await db
    .insert(googleAdsConnections)
    .values({ organizationId: store.organizationId, storeId: store.id })
    .onConflictDoNothing({
      target: [googleAdsConnections.organizationId, googleAdsConnections.storeId],
    })
    .returning();
  if (created) return created;
  const raced = await getPilotGoogleAdsConnectionForOrganization(store.organizationId);
  if (!raced) throw new Error("Google Ads connection bootstrap raced and lost");
  return raced;
}

export async function getPilotGoogleAdsConnectionForOrganization(
  organizationId: string,
): Promise<ConnectionRecord | null> {
  const [connection] = await db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.organizationId, organizationId))
    .limit(1);
  return connection ?? null;
}

export function connectionScope(connection: ConnectionRecord): GoogleAdsScope {
  return {
    organizationId: connection.organizationId,
    storeId: connection.storeId,
    connectionId: connection.id,
  };
}

export async function createGoogleAdsSyncRun(params: {
  scope: GoogleAdsScope;
  operation: "discovery" | "facts";
  windowFromDay?: string;
  windowToDay?: string;
  apiVersion: string;
}): Promise<SyncRunRecord> {
  const [run] = await db
    .insert(googleAdsSyncRuns)
    .values({
      organizationId: params.scope.organizationId,
      storeId: params.scope.storeId,
      connectionId: params.scope.connectionId,
      operation: params.operation,
      windowFromDay: params.windowFromDay ?? null,
      windowToDay: params.windowToDay ?? null,
      apiVersion: params.apiVersion,
    })
    .returning();
  return run;
}

/** Loads a run plus its scope for a durable task; throws if the ID is unknown. */
export async function resolveGoogleAdsSyncRun(
  syncRunId: string,
): Promise<{ run: SyncRunRecord; scope: GoogleAdsScope }> {
  const [run] = await db
    .select()
    .from(googleAdsSyncRuns)
    .where(eq(googleAdsSyncRuns.id, syncRunId))
    .limit(1);
  if (!run) throw new Error("Google Ads sync run does not exist");
  return {
    run,
    scope: {
      organizationId: run.organizationId,
      storeId: run.storeId,
      connectionId: run.connectionId,
    },
  };
}

/**
 * One transaction per chunk: upsert the chunk's facts, advance the
 * checkpoint, and bump counters. A retried chunk re-upserts harmlessly.
 */
export async function commitCampaignFactsChunk(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  facts: NormalizedCampaignFact[];
  checkpointDay: string;
  rowsRead: number;
  failureCount: number;
  apiVersion: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (params.facts.length > 0) {
      await tx
        .insert(googleAdsCampaignFacts)
        .values(
          params.facts.map((fact) => ({
            organizationId: params.scope.organizationId,
            storeId: params.scope.storeId,
            connectionId: params.scope.connectionId,
            campaignId: fact.campaignId,
            campaignName: fact.campaignName,
            campaignStatus: fact.campaignStatus,
            channelType: fact.channelType,
            factDate: fact.factDate,
            costMicros: fact.costMicros,
            impressions: fact.impressions,
            clicks: fact.clicks,
            conversions: fact.conversions,
            conversionsValue: fact.conversionsValue,
            apiVersion: params.apiVersion,
            fetchedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [
            googleAdsCampaignFacts.connectionId,
            googleAdsCampaignFacts.campaignId,
            googleAdsCampaignFacts.factDate,
          ],
          set: {
            campaignName: sqlExcluded("campaign_name"),
            campaignStatus: sqlExcluded("campaign_status"),
            channelType: sqlExcluded("channel_type"),
            costMicros: sqlExcluded("cost_micros"),
            impressions: sqlExcluded("impressions"),
            clicks: sqlExcluded("clicks"),
            conversions: sqlExcluded("conversions"),
            conversionsValue: sqlExcluded("conversions_value"),
            apiVersion: sqlExcluded("api_version"),
            fetchedAt: sqlExcluded("fetched_at"),
          },
        });
    }
    const [current] = await tx
      .select({
        rowsRead: googleAdsSyncRuns.rowsRead,
        rowsUpserted: googleAdsSyncRuns.rowsUpserted,
        failureCount: googleAdsSyncRuns.failureCount,
      })
      .from(googleAdsSyncRuns)
      .where(eq(googleAdsSyncRuns.id, params.syncRunId))
      .limit(1);
    if (!current) throw new Error("Google Ads sync run vanished mid-chunk");
    await tx
      .update(googleAdsSyncRuns)
      .set({
        checkpointDay: params.checkpointDay,
        rowsRead: current.rowsRead + params.rowsRead,
        rowsUpserted: current.rowsUpserted + params.facts.length,
        failureCount: current.failureCount + params.failureCount,
      })
      .where(eq(googleAdsSyncRuns.id, params.syncRunId));
  });
}

export async function completeGoogleAdsSyncRun(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  operation: "discovery" | "facts";
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(googleAdsSyncRuns)
      .set({ status: "completed", finishedAt: now })
      .where(
        and(
          eq(googleAdsSyncRuns.id, params.syncRunId),
          eq(googleAdsSyncRuns.status, "running"),
        ),
      );
    if (params.operation === "facts") {
      const [connection] = await tx
        .select({ backfillCompletedAt: googleAdsConnections.backfillCompletedAt })
        .from(googleAdsConnections)
        .where(eq(googleAdsConnections.id, params.scope.connectionId))
        .limit(1);
      await tx
        .update(googleAdsConnections)
        .set({
          lastFactsSyncedAt: now,
          // The first completed facts run IS the backfill: incremental runs
          // are only scheduled once this stamp exists.
          backfillCompletedAt: connection?.backfillCompletedAt ?? now,
        })
        .where(eq(googleAdsConnections.id, params.scope.connectionId));
    }
  });
}

export async function failGoogleAdsSyncRun(params: {
  syncRunId: string;
  error: SanitizedSyncError;
}): Promise<void> {
  await db
    .update(googleAdsSyncRuns)
    .set({
      status: "failed",
      errorCode: params.error.code,
      errorMessage: params.error.message,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(googleAdsSyncRuns.id, params.syncRunId),
        eq(googleAdsSyncRuns.status, "running"),
      ),
    );
}

export async function listGoogleAdsSyncRuns(
  connectionId: string,
  limit = 20,
): Promise<SyncRunRecord[]> {
  return db
    .select()
    .from(googleAdsSyncRuns)
    .where(eq(googleAdsSyncRuns.connectionId, connectionId))
    .orderBy(desc(googleAdsSyncRuns.startedAt))
    .limit(limit);
}
