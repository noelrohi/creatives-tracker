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

/** Store-scoped (not just org-scoped) lookup used by the bootstrap path. */
async function getConnectionForStore(
  organizationId: string,
  storeId: string,
): Promise<ConnectionRecord | null> {
  const [connection] = await db
    .select()
    .from(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.organizationId, organizationId),
        eq(googleAdsConnections.storeId, storeId),
      ),
    )
    .limit(1);
  return connection ?? null;
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
  const existing = await getConnectionForStore(store.organizationId, store.id);
  if (existing) return existing;
  const [created] = await db
    .insert(googleAdsConnections)
    .values({ organizationId: store.organizationId, storeId: store.id })
    .onConflictDoNothing({
      target: [googleAdsConnections.organizationId, googleAdsConnections.storeId],
    })
    .returning();
  if (created) return created;
  const raced = await getConnectionForStore(store.organizationId, store.id);
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
 * One transaction per chunk: upsert the chunk's facts, then atomically
 * advance the checkpoint and bump counters with a single guarded UPDATE. A
 * retried chunk re-upserts harmlessly. If the run isn't an active `facts`
 * run in this scope, the checkpoint UPDATE matches zero rows and the whole
 * transaction (including the fact upserts) rolls back — this closes the
 * write-to-terminal-run hole.
 */
export async function commitCampaignFactsChunk(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  facts: NormalizedCampaignFact[];
  checkpointDay: string;
  rowsRead: number;
  failureCount: number;
  apiVersion: string;
  currencyCode: string | null;
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
            currencyCode: params.currencyCode,
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
            campaignName: sql`excluded.campaign_name`,
            campaignStatus: sql`excluded.campaign_status`,
            channelType: sql`excluded.channel_type`,
            costMicros: sql`excluded.cost_micros`,
            impressions: sql`excluded.impressions`,
            clicks: sql`excluded.clicks`,
            conversions: sql`excluded.conversions`,
            conversionsValue: sql`excluded.conversions_value`,
            currencyCode: sql`excluded.currency_code`,
            apiVersion: sql`excluded.api_version`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    const advanced = await tx
      .update(googleAdsSyncRuns)
      .set({
        checkpointDay: params.checkpointDay,
        rowsRead: sql`${googleAdsSyncRuns.rowsRead} + ${params.rowsRead}`,
        rowsUpserted: sql`${googleAdsSyncRuns.rowsUpserted} + ${params.facts.length}`,
        failureCount: sql`${googleAdsSyncRuns.failureCount} + ${params.failureCount}`,
      })
      .where(
        and(
          eq(googleAdsSyncRuns.id, params.syncRunId),
          eq(googleAdsSyncRuns.organizationId, params.scope.organizationId),
          eq(googleAdsSyncRuns.storeId, params.scope.storeId),
          eq(googleAdsSyncRuns.connectionId, params.scope.connectionId),
          eq(googleAdsSyncRuns.operation, "facts"),
          eq(googleAdsSyncRuns.status, "running"),
        ),
      )
      .returning({ id: googleAdsSyncRuns.id });
    if (advanced.length !== 1) {
      throw new Error("Google Ads facts checkpoint raced");
    }
  });
}

export async function completeGoogleAdsSyncRun(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  operation: "discovery" | "facts";
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const completed = await tx
      .update(googleAdsSyncRuns)
      .set({ status: "completed", finishedAt: now })
      .where(
        and(
          eq(googleAdsSyncRuns.id, params.syncRunId),
          eq(googleAdsSyncRuns.organizationId, params.scope.organizationId),
          eq(googleAdsSyncRuns.storeId, params.scope.storeId),
          eq(googleAdsSyncRuns.connectionId, params.scope.connectionId),
          eq(googleAdsSyncRuns.operation, params.operation),
          eq(googleAdsSyncRuns.status, "running"),
        ),
      )
      .returning({ id: googleAdsSyncRuns.id });
    if (completed.length !== 1) {
      throw new Error("Google Ads sync run completion raced");
    }
    if (params.operation === "facts") {
      const [connection] = await tx
        .select({ backfillCompletedAt: googleAdsConnections.backfillCompletedAt })
        .from(googleAdsConnections)
        .where(
          and(
            eq(googleAdsConnections.id, params.scope.connectionId),
            eq(googleAdsConnections.organizationId, params.scope.organizationId),
            eq(googleAdsConnections.storeId, params.scope.storeId),
          ),
        )
        .limit(1);
      const refreshed = await tx
        .update(googleAdsConnections)
        .set({
          lastFactsSyncedAt: now,
          // The first completed facts run IS the backfill: incremental runs
          // are only scheduled once this stamp exists.
          backfillCompletedAt: connection?.backfillCompletedAt ?? now,
        })
        .where(
          and(
            eq(googleAdsConnections.id, params.scope.connectionId),
            eq(googleAdsConnections.organizationId, params.scope.organizationId),
            eq(googleAdsConnections.storeId, params.scope.storeId),
          ),
        )
        .returning({ id: googleAdsConnections.id });
      if (refreshed.length !== 1) {
        throw new Error("Google Ads connection is not active in this scope");
      }
    }
  });
}

export async function failGoogleAdsSyncRun(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  operation: "discovery" | "facts";
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
        eq(googleAdsSyncRuns.organizationId, params.scope.organizationId),
        eq(googleAdsSyncRuns.storeId, params.scope.storeId),
        eq(googleAdsSyncRuns.connectionId, params.scope.connectionId),
        eq(googleAdsSyncRuns.operation, params.operation),
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
