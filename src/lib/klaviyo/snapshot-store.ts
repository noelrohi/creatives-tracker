import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  computeErasureSuppressionDigests,
  computeIdentityCryptoKeyChecks,
  type IdentityHmacKeyring,
  type ErasureSuppressionKey,
} from "@/lib/identity-hmac";
import {
  withKlaviyoConnectionLock,
  withKlaviyoStoreConnectionLock,
  type KlaviyoStoreTransaction,
} from "@/lib/klaviyo/source-store";
import {
  inclusiveStoreDaysToHalfOpenUtc,
  type KlaviyoConnectionScope,
} from "@/lib/klaviyo/types";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import { klaviyoConnections, klaviyoEvents } from "@/schema/klaviyo";
import { eraseSuppressedKlaviyoEventEvidence } from "./privacy-match-closure";
import {
  klaviyoSnapshotContents,
  klaviyoSnapshotDefinitions,
  klaviyoSnapshotProfileSuppressions,
  klaviyoSnapshotRecords,
  klaviyoSnapshotRuns,
} from "@/schema/klaviyo-snapshot";
import {
  identityCryptoPolicies,
  identityErasureSuppressions,
} from "@/schema/shopify-evidence";
import {
  assertExactSnapshotCheckpoint,
  canonicalSnapshotJson,
  initialSnapshotCheckpoint,
  KLAVIYO_SNAPSHOT_API_REVISION,
  KLAVIYO_SNAPSHOT_ERRORS,
  KLAVIYO_SNAPSHOT_FRESHNESS_TARGET_MS,
  KLAVIYO_SNAPSHOT_MAX_PAGES_PER_RUN,
  KLAVIYO_SNAPSHOT_MAX_RECORDS_PER_RUN,
  KLAVIYO_SNAPSHOT_MAX_RUN_BYTES,
  KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS,
  canonicalizeSnapshotScope,
  snapshotCampaignValuesScopeInputSchema,
  snapshotEventsScopeInputSchema,
  snapshotScopeFingerprint,
  snapshotCheckpointComplete,
  KLAVIYO_SNAPSHOT_DATASETS,
  snapshotReportProviderWindow,
  canonicalInstant,
  KLAVIYO_SNAPSHOT_REPORT_WARNINGS,
  type KlaviyoSnapshotCheckpoint,
  type KlaviyoSnapshotDataset,
  type KlaviyoSnapshotResolvedScope,
  type KlaviyoSnapshotResourceKind,
  type KlaviyoSnapshotErrorCode,
  type KlaviyoStagedSnapshotRecord,
} from "@/lib/klaviyo/snapshot-contracts";
import {
  klaviyoCampaignMessageRecordSchema,
  klaviyoCampaignRecordSchema,
  klaviyoCampaignValueRecordSchema,
  klaviyoEventRecordSchema,
  klaviyoMetricRecordSchema,
} from "@/lib/klaviyo/record-contracts";

export const KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS = 20 * 60 * 1000;
const CHUNK_SIZE = 1_000;

function chunk<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    chunks.push(rows.slice(index, index + CHUNK_SIZE));
  }
  return chunks;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function nowDate(value: Date): Date {
  const copy = new Date(value.getTime());
  if (Number.isNaN(copy.getTime())) throw new Error("Invalid snapshot time");
  return copy;
}

const RECORD_SCHEMAS: Record<KlaviyoSnapshotResourceKind, {
  safeParse: (value: unknown) => { success: boolean };
}> = {
  campaign: klaviyoCampaignRecordSchema,
  campaign_message: klaviyoCampaignMessageRecordSchema,
  metric: klaviyoMetricRecordSchema,
  event: klaviyoEventRecordSchema,
  campaign_value_row: klaviyoCampaignValueRecordSchema,
};

function assertValidStagedRecord(record: KlaviyoStagedSnapshotRecord): void {
  if (
    typeof record.providerIdentity !== "string" ||
    record.providerIdentity.length === 0 ||
    record.providerIdentity.length > 1024
  ) {
    throw new Error("Klaviyo snapshot record identity is invalid");
  }
  if (
    typeof record.orderingKey !== "string" ||
    record.orderingKey.length === 0 ||
    record.orderingKey.length > 1024
  ) {
    throw new Error("Klaviyo snapshot record ordering key is invalid");
  }
  const parsed = RECORD_SCHEMAS[record.resourceKind].safeParse(record.content);
  if (!parsed.success) {
    throw new Error("Klaviyo snapshot record content is invalid");
  }
  const contentId = record.resourceKind === "campaign" ? record.content.campaignId
    : record.resourceKind === "campaign_message" ? record.content.messageId
    : record.resourceKind === "metric" ? record.content.metricId
    : record.resourceKind === "event" ? record.content.eventId
    : JSON.stringify([record.content.campaignId, record.content.campaignMessageId, record.content.sendChannel]);
  const orderingKey = record.resourceKind === "event"
    ? JSON.stringify([canonicalInstant(String(record.content.datetime)), contentId]) : contentId;
  if (record.providerIdentity !== contentId || record.orderingKey !== orderingKey) {
    throw new Error("Klaviyo snapshot record identity/order does not match content");
  }
  if (record.resourceKind === "event") {
    const content = klaviyoEventRecordSchema.parse(record.content);
    if ((content.profileId === null && content.profileExternalId !== null) ||
        record.profileId !== content.profileId || record.metricId !== content.metricId ||
        !record.eventDatetime || new Date(record.eventDatetime).getTime() !== Date.parse(content.datetime) ||
        record.providerIdentity !== content.eventId) {
      throw new Error("Klaviyo snapshot event indexes disagree with content");
    }
  } else if (record.profileId != null || record.metricId != null || record.eventDatetime != null) {
    throw new Error("Klaviyo snapshot non-event carries identity indexes");
  }
  if (record.identity !== undefined) {
    if (
      typeof record.identity.keyVersion !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(record.identity.keyVersion) ||
      typeof record.identity.emailDigest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.identity.emailDigest) ||
      typeof record.identity.profileDigest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.identity.profileDigest)
    ) {
      throw new Error("Klaviyo snapshot record identity is invalid");
    }
    if (record.resourceKind !== "event" || record.profileId == null) {
      throw new Error("Klaviyo snapshot identity requires an event profile");
    }
  }
  // Fail closed: an identifiable event (profile ID present) must carry
  // resolvable identity material, or it could never be erased by email.
  if (
    record.resourceKind === "event" &&
    record.profileId != null &&
    record.identity === undefined
  ) {
    throw new Error(
      "Klaviyo snapshot identifiable event requires identity material",
    );
  }
}

function scopePredicate(scope: KlaviyoConnectionScope) {
  return and(
    eq(klaviyoSnapshotRuns.organizationId, scope.organizationId),
    eq(klaviyoSnapshotRuns.storeId, scope.storeId),
    eq(klaviyoSnapshotRuns.connectionId, scope.connectionId),
  );
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export type KlaviyoSnapshotDefinitionRecord = {
  id: string;
  dataset: KlaviyoSnapshotDataset;
  dailyEnabled: boolean;
  configurationVersion: number;
  windowMode: "rolling_days" | "fixed";
  rollingDays: number | null;
  fixedFrom: Date | null;
  fixedTo: Date | null;
  timezone: string;
  selectedMetricIds: string[] | null;
  conversionMetricId: string | null;
};

type DefinitionRow = typeof klaviyoSnapshotDefinitions.$inferSelect;

function toDefinitionRecord(row: DefinitionRow): KlaviyoSnapshotDefinitionRecord {
  return {
    id: row.id,
    dataset: row.dataset as KlaviyoSnapshotDataset,
    dailyEnabled: row.dailyEnabled === 1,
    configurationVersion: row.configurationVersion,
    windowMode: row.windowMode as "rolling_days" | "fixed",
    rollingDays: row.rollingDays,
    fixedFrom: row.fixedFrom,
    fixedTo: row.fixedTo,
    timezone: row.timezone,
    selectedMetricIds: row.selectedMetricIds ?? null,
    conversionMetricId: row.conversionMetricId,
  };
}

export type ConfigureSnapshotDefinitionInput = {
  scope: KlaviyoConnectionScope;
  dataset: KlaviyoSnapshotDataset;
  dailyEnabled: boolean;
  eventsMetricIds?: string[];
  conversionMetricId?: string;
  window?:
    | { mode: "rolling_days"; rollingDays: number }
    | { mode: "fixed"; from: Date; to: Date };
  now: Date;
};

/**
 * Configure or update one dataset's sync definition under the connection
 * lock. Every accepted change bumps the persisted configuration version;
 * prior snapshots and their scopes are never rewritten. Events require an
 * explicit validated metric set; campaign values require one explicit
 * conversion metric. Campaigns and metric catalogs need no metric/window
 * configuration at all.
 */
export async function configureSnapshotDefinition(
  input: ConfigureSnapshotDefinitionInput,
): Promise<KlaviyoSnapshotDefinitionRecord> {
  const now = nowDate(input.now);
  z.enum(KLAVIYO_SNAPSHOT_DATASETS).parse(input.dataset);
  z.boolean().parse(input.dailyEnabled);
  if ((input.dataset !== "events" && input.eventsMetricIds !== undefined) ||
      (input.dataset !== "campaign_values" && input.conversionMetricId !== undefined)) {
    throw new Error("Klaviyo snapshot metric configuration does not match dataset");
  }
  const eventsMetricIds =
    input.dataset === "events" ? input.eventsMetricIds : undefined;
  const conversionMetricId =
    input.dataset === "campaign_values" ? input.conversionMetricId : undefined;
  const window:
    | { mode: "rolling_days"; rollingDays: number }
    | { mode: "fixed"; from: Date; to: Date } =
    input.dataset === "campaigns" || input.dataset === "metrics"
      ? { mode: "rolling_days", rollingDays: 7 }
      : (input.window ?? { mode: "rolling_days" as const, rollingDays: 7 });

  if (input.dataset === "events") {
    snapshotEventsScopeInputSchema.parse({
      metricIds: eventsMetricIds ?? [],
      since: "2026-01-01T00:00:00Z",
      until: "2026-01-02T00:00:00Z",
    });
  } else if (input.dataset === "campaign_values") {
    snapshotCampaignValuesScopeInputSchema.parse({
      conversionMetricId: conversionMetricId ?? "",
      since: "2026-01-01T00:00:00Z",
      until: "2026-01-02T00:00:00Z",
    });
  }
  if (
    (input.dataset === "campaigns" || input.dataset === "metrics") &&
    input.window !== undefined
  ) {
    throw new Error("Klaviyo snapshot dataset does not accept a window");
  }
  if (window.mode === "rolling_days") {
    if (
      !Number.isInteger(window.rollingDays) ||
      window.rollingDays < 1 ||
      window.rollingDays > 365
    ) {
      throw new Error("Klaviyo snapshot rolling window must be 1-365 days");
    }
  } else if (window.mode === "fixed") {
    const from = nowDate(window.from), to = nowDate(window.to);
    if (from >= to || to.getTime() - from.getTime() > 365 * 86400000 || to > now) {
      throw new Error("Klaviyo snapshot fixed window is invalid");
    }
  } else {
    throw new Error("Klaviyo snapshot window mode is invalid");
  }

  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [connection] = await tx
      .select({ timezone: klaviyoConnections.timezone })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      )
      .limit(1);
    if (!connection) throw new Error("Klaviyo connection is outside this scope");
    if ((input.dataset === "events" || input.dataset === "campaign_values") && !connection.timezone) {
      throw new Error("Klaviyo snapshot account timezone is unavailable");
    }
    const timezone = connection.timezone ?? "UTC";
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);

    const [existing] = await tx
      .select()
      .from(klaviyoSnapshotDefinitions)
      .where(
        and(
          eq(klaviyoSnapshotDefinitions.connectionId, input.scope.connectionId),
          eq(klaviyoSnapshotDefinitions.dataset, input.dataset),
        ),
      )
      .for("update");

    const values = {
      dailyEnabled: input.dailyEnabled ? 1 : 0,
      windowMode: window.mode,
      rollingDays: window.mode === "rolling_days" ? window.rollingDays : null,
      fixedFrom: window.mode === "fixed" ? window.from : null,
      fixedTo: window.mode === "fixed" ? window.to : null,
      timezone,
      selectedMetricIds:
        input.dataset === "events" ? [...(eventsMetricIds ?? [])].sort() : null,
      conversionMetricId:
        input.dataset === "campaign_values" ? conversionMetricId! : null,
      updatedAt: now,
    };

    if (existing) {
      const [updated] = await tx
        .update(klaviyoSnapshotDefinitions)
        .set({
          ...values,
          configurationVersion: existing.configurationVersion + 1,
        })
        .where(eq(klaviyoSnapshotDefinitions.id, existing.id))
        .returning();
      return toDefinitionRecord(updated);
    }
    const [inserted] = await tx
      .insert(klaviyoSnapshotDefinitions)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        dataset: input.dataset,
        configurationVersion: 1,
        ...values,
      })
      .returning();
    return toDefinitionRecord(inserted);
  });
}

export async function listSnapshotDefinitions(
  scope: KlaviyoConnectionScope,
): Promise<KlaviyoSnapshotDefinitionRecord[]> {
  const rows = await db
    .select()
    .from(klaviyoSnapshotDefinitions)
    .where(
      and(
        eq(klaviyoSnapshotDefinitions.organizationId, scope.organizationId),
        eq(klaviyoSnapshotDefinitions.storeId, scope.storeId),
        eq(klaviyoSnapshotDefinitions.connectionId, scope.connectionId),
      ),
    )
    .orderBy(asc(klaviyoSnapshotDefinitions.dataset));
  return rows.map(toDefinitionRecord);
}

/**
 * Resolve a definition's exact collection scope once, at run creation, in
 * the definition's timezone. Recurring rolling windows resolve to a
 * bounded trailing window; fixed windows repeat their persisted instants.
 * The resolved scope is canonicalized and persisted on the run — snapshot
 * writes never reuse a moving "now" mid-pagination.
 */
export function resolveDefinitionSnapshotScope(
  definition: KlaviyoSnapshotDefinitionRecord,
  now: Date,
): KlaviyoSnapshotResolvedScope {
  const nowCopy = nowDate(now);
  if (definition.dataset === "campaigns" || definition.dataset === "metrics") {
    return { dataset: definition.dataset };
  }
  let from: Date;
  let to: Date;
  if (definition.windowMode === "rolling_days") {
    const days = definition.rollingDays!;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error("Klaviyo snapshot rolling window is invalid");
    }
    const today = deriveDayInTimezone(nowCopy, definition.timezone);
    const dateFrom = new Date(
      Date.parse(`${today}T00:00:00Z`) - (days - 1) * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    from = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom,
      dateTo: today,
      timeZone: definition.timezone,
    }).from;
    to = nowCopy;
  } else {
    if (definition.windowMode !== "fixed" || !definition.fixedFrom || !definition.fixedTo) {
      throw new Error("Klaviyo snapshot definition window is invalid");
    }
    from = nowDate(definition.fixedFrom);
    to = nowDate(definition.fixedTo);
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error("Klaviyo snapshot definition window is invalid");
  }
  if (definition.dataset === "events") {
    return canonicalizeSnapshotScope({
      dataset: "events",
      metricIds: definition.selectedMetricIds ?? [],
      since: from.toISOString(),
      until: to.toISOString(),
    });
  }
  return canonicalizeSnapshotScope({
    dataset: "campaign_values",
    conversionMetricId: definition.conversionMetricId ?? "",
    since: from.toISOString(),
    until: to.toISOString(),
  });
}

/**
 * Manual refresh request: either an explicit one-off scope (which never
 * touches or becomes recurring work) or the dataset's configured
 * definition scope. Returns the durable snapshot run ID immediately.
 */
export async function requestSnapshotRefresh(input: {
  scope: KlaviyoConnectionScope;
  dataset: KlaviyoSnapshotDataset;
  oneOff?:
    | {
        metricIds: string[];
        since: string;
        until: string;
      }
    | {
        conversionMetricId: string;
        since: string;
        until: string;
      };
  now: Date;
}): Promise<PrepareSnapshotRunResult> {
  if (
    (input.dataset === "campaigns" || input.dataset === "metrics") &&
    input.oneOff !== undefined
  ) {
    throw new Error("Klaviyo snapshot dataset does not accept a one-off scope");
  }
  if (input.oneOff !== undefined) {
    const resolvedScope: KlaviyoSnapshotResolvedScope =
      input.dataset === "events"
        ? {
            dataset: "events",
            metricIds: "metricIds" in input.oneOff ? input.oneOff.metricIds : [],
            since: input.oneOff.since,
            until: input.oneOff.until,
          }
        : input.dataset === "campaign_values"
          ? {
              dataset: "campaign_values",
              conversionMetricId: "conversionMetricId" in input.oneOff ? input.oneOff.conversionMetricId : "",
              since: input.oneOff.since,
              until: input.oneOff.until,
            }
          : (() => {
              throw new Error(
                "Klaviyo snapshot one-off scope does not match the dataset",
              );
            })();
    return prepareSnapshotRun({
      scope: input.scope,
      dataset: input.dataset,
      triggerType: "manual",
      resolvedScope,
      definitionId: null,
      configurationVersion: 0,
      now: input.now,
    });
  }
  const definitions = await listSnapshotDefinitions(input.scope);
  const definition = definitions.find(
    (candidate) => candidate.dataset === input.dataset,
  );
  if (!definition) {
    if (input.dataset === "campaigns" || input.dataset === "metrics") {
      return prepareSnapshotRun({ scope: input.scope, dataset: input.dataset,
        triggerType: "manual", resolvedScope: { dataset: input.dataset }, now: input.now });
    }
    throw new Error("Klaviyo snapshot sync definition is not configured for this dataset");
  }
  return prepareSnapshotRun({
    scope: input.scope,
    dataset: input.dataset,
    triggerType: "manual",
    resolvedScope: resolveDefinitionSnapshotScope(definition, input.now),
    definitionId: definition.id,
    configurationVersion: definition.configurationVersion,
    now: input.now,
  });
}

export type DailySnapshotPreparation =
  | {
      dataset: KlaviyoSnapshotDataset;
      kind: "started" | "reused" | "fresh";
      snapshotRunId: string | null;
    }
  | {
      dataset: KlaviyoSnapshotDataset;
      kind: "skipped";
      snapshotRunId: null;
      reason: string;
    };

/**
 * Resolve every daily-enabled definition of one connection into prepared
 * runs. Each definition resolves and prepares independently; one invalid
 * definition records a skip and never blocks the others or any existing
 * consent/evidence/claim/report job.
 */
function dailySnapshotOccurrence(now: Date): Date {
  const anchor = nowDate(now);
  anchor.setUTCHours(20, 30, 0, 0);
  if (anchor > now) anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor;
}

export async function prepareDailySnapshotRuns(input: {
  scope: KlaviyoConnectionScope;
  now: Date;
}): Promise<DailySnapshotPreparation[]> {
  const definitions = await listSnapshotDefinitions(input.scope);
  const results: DailySnapshotPreparation[] = [];
  for (const definition of definitions) {
    if (!definition.dailyEnabled) continue;
    try {
      const resolvedScope = resolveDefinitionSnapshotScope(
        definition,
        dailySnapshotOccurrence(input.now),
      );
      const prepared = await prepareSnapshotRun({
        scope: input.scope,
        dataset: definition.dataset,
        triggerType: "daily",
        resolvedScope,
        definitionId: definition.id,
        configurationVersion: definition.configurationVersion,
        now: input.now,
      });
      results.push({
        dataset: definition.dataset,
        kind: prepared.kind,
        snapshotRunId: prepared.snapshotRunId,
      });
    } catch {
      results.push({
        dataset: definition.dataset,
        kind: "skipped",
        snapshotRunId: null,
        reason: "definition_resolution_failed",
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Run preparation, leases and failure
// ---------------------------------------------------------------------------

export type PrepareSnapshotRunResult =
  | { kind: "started"; snapshotRunId: string }
  | { kind: "reused"; snapshotRunId: string }
  | { kind: "fresh"; snapshotRunId: null };

function validateRunnableScope(
  scope: KlaviyoSnapshotResolvedScope,
  now: Date,
): void {
  if (scope.dataset === "campaigns" || scope.dataset === "metrics") return;
  const sinceMs = Date.parse(scope.since);
  const untilMs = Date.parse(scope.until);
  if (
    !Number.isFinite(sinceMs) ||
    !Number.isFinite(untilMs) ||
    sinceMs >= untilMs ||
    untilMs - sinceMs > 365 * 24 * 60 * 60 * 1000
  ) {
    throw new Error("Klaviyo snapshot window is invalid");
  }
  // Provider adapters reject windows outside the bounded historical range;
  // fail preparation with a fixed error instead of a wedged run.
  if (sinceMs < now.getTime() - 365 * 24 * 60 * 60 * 1000) {
    throw new Error(
      "Klaviyo snapshot window must start within the previous 365 days",
    );
  }
  if (untilMs > now.getTime()) {
    throw new Error("Klaviyo snapshot window must not end in the future");
  }
}

/**
 * Prepare exactly one durable, scope-leased collection run under the
 * connection lock: reuse a live identical request, fail an expired lease
 * with its fixed code, or insert a fresh running row. Daily preparations
 * skip scopes whose current snapshot already meets the 24-hour freshness
 * target. Manual one-off scopes never touch the definitions.
 */
export async function prepareSnapshotRun(input: {
  scope: KlaviyoConnectionScope;
  dataset: KlaviyoSnapshotDataset;
  triggerType: "daily" | "manual";
  resolvedScope: KlaviyoSnapshotResolvedScope;
  definitionId?: string | null;
  configurationVersion?: number;
  now: Date;
}): Promise<PrepareSnapshotRunResult> {
  const now = nowDate(input.now);
  const resolvedScope = canonicalizeSnapshotScope(input.resolvedScope);
  if (resolvedScope.dataset !== input.dataset) {
    throw new Error("Klaviyo snapshot scope does not match the dataset");
  }
  validateRunnableScope(resolvedScope, now);
  const scopeFingerprint = snapshotScopeFingerprint(resolvedScope);
  const staleAt = new Date(now.getTime() - KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS);
  const occurrence = input.triggerType === "daily" && input.definitionId ? dailySnapshotOccurrence(now) : null;

  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [connection] = await tx.select().from(klaviyoConnections).where(and(
      eq(klaviyoConnections.id, input.scope.connectionId),
      eq(klaviyoConnections.organizationId, input.scope.organizationId),
      eq(klaviyoConnections.storeId, input.scope.storeId),
    ));
    if (!connection || connection.status !== "ready" || !connection.klaviyoAccountId) {
      throw new Error("Klaviyo snapshot connection is not ready");
    }
    if (input.dataset === "campaign_values" && !connection.timezone) {
      throw new Error("Klaviyo snapshot account timezone is unavailable");
    }
    if (connection.timezone) new Intl.DateTimeFormat("en", { timeZone: connection.timezone }).format(now);
    if (input.definitionId) {
      const [definition] = await tx.select().from(klaviyoSnapshotDefinitions).where(and(
        eq(klaviyoSnapshotDefinitions.id, input.definitionId),
        eq(klaviyoSnapshotDefinitions.connectionId, input.scope.connectionId),
        eq(klaviyoSnapshotDefinitions.dataset, input.dataset),
      ));
      if (!definition || definition.configurationVersion !== input.configurationVersion ||
          (input.triggerType === "daily" && definition.dailyEnabled !== 1)) {
        throw new Error("Klaviyo snapshot configuration changed; retry");
      }
      if (occurrence) {
        if (snapshotScopeFingerprint(resolveDefinitionSnapshotScope(toDefinitionRecord(definition), occurrence)) !== scopeFingerprint) {
          throw new Error("Klaviyo daily snapshot scope does not match its scheduled occurrence");
        }
        // The connection lock serializes concurrent deliveries. Occurrence
        // identity survives success/failure and never depends on moving now.
        const [observed] = await tx.select({ id: klaviyoSnapshotRuns.id }).from(klaviyoSnapshotRuns).where(and(
          scopePredicate(input.scope), eq(klaviyoSnapshotRuns.definitionId, definition.id),
          eq(klaviyoSnapshotRuns.configurationVersion, definition.configurationVersion),
          eq(klaviyoSnapshotRuns.triggerType, "daily"), eq(klaviyoSnapshotRuns.anchorAt, occurrence),
        )).limit(1);
        if (observed) return { kind: "reused" as const, snapshotRunId: observed.id };
      }
    }
    const [running] = await tx
      .select({
        id: klaviyoSnapshotRuns.id,
        heartbeatAt: klaviyoSnapshotRuns.heartbeatAt,
        definitionId: klaviyoSnapshotRuns.definitionId,
        configurationVersion: klaviyoSnapshotRuns.configurationVersion,
      })
      .from(klaviyoSnapshotRuns)
      .where(
        and(
          eq(klaviyoSnapshotRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSnapshotRuns.dataset, input.dataset),
          eq(klaviyoSnapshotRuns.scopeFingerprint, scopeFingerprint),
          eq(klaviyoSnapshotRuns.state, "running"),
        ),
      )
      .for("update");
    if (running) {
      let superseded = false;
      if (running.definitionId) {
        const [definition] = await tx.select({ version: klaviyoSnapshotDefinitions.configurationVersion })
          .from(klaviyoSnapshotDefinitions).where(eq(klaviyoSnapshotDefinitions.id, running.definitionId));
        superseded = !definition || definition.version !== running.configurationVersion;
      }
      if (!superseded && running.heartbeatAt.getTime() > staleAt.getTime()) {
        return { kind: "reused" as const, snapshotRunId: running.id };
      }
      const reaped = await tx
        .update(klaviyoSnapshotRuns)
        .set({
          state: "failed",
          errorCode: KLAVIYO_SNAPSHOT_ERRORS[superseded ? "superseded" : "leaseExpired"].code,
          errorMessage: KLAVIYO_SNAPSHOT_ERRORS[superseded ? "superseded" : "leaseExpired"].message,
          finishedAt: now,
        })
        .where(
          and(
            eq(klaviyoSnapshotRuns.id, running.id),
            eq(klaviyoSnapshotRuns.state, "running"),
          ),
        )
        .returning({ id: klaviyoSnapshotRuns.id });
      if (reaped.length !== 1) {
        throw new Error("Klaviyo snapshot expired run reap raced; retry");
      }
    } else if (input.triggerType === "daily") {
      const [current] = await tx
        .select({ id: klaviyoSnapshotRuns.id })
        .from(klaviyoSnapshotRuns)
        .where(
          and(
            eq(klaviyoSnapshotRuns.connectionId, input.scope.connectionId),
            eq(klaviyoSnapshotRuns.dataset, input.dataset),
            eq(klaviyoSnapshotRuns.scopeFingerprint, scopeFingerprint),
            eq(klaviyoSnapshotRuns.state, "published"),
            eq(klaviyoSnapshotRuns.isCurrent, 1),
            sql`${klaviyoSnapshotRuns.publishedAt} > ${new Date(
              now.getTime() - KLAVIYO_SNAPSHOT_FRESHNESS_TARGET_MS,
            )}`,
          ),
        )
        .limit(1);
      if (current) return { kind: "fresh" as const, snapshotRunId: null };
    }

    const [run] = await tx
      .insert(klaviyoSnapshotRuns)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        definitionId: input.definitionId ?? null,
        dataset: input.dataset,
        scopeFingerprint,
        resolvedScope,
        configurationVersion: input.configurationVersion ?? 0,
        triggerType: input.triggerType,
        state: "running",
        isCurrent: 0,
        leaseToken: crypto.randomUUID(),
        heartbeatAt: now,
        checkpoint: initialSnapshotCheckpoint(input.dataset),
        apiRevision: KLAVIYO_SNAPSHOT_API_REVISION,
        accountId: connection.klaviyoAccountId!,
        timezone: connection.timezone ?? "UTC",
        requestedFrom:
          resolvedScope.dataset === "campaigns" ||
          resolvedScope.dataset === "metrics"
            ? null
            : new Date(resolvedScope.since),
        requestedTo:
          resolvedScope.dataset === "campaigns" ||
          resolvedScope.dataset === "metrics"
            ? null
            : new Date(resolvedScope.until),
        anchorAt: occurrence ?? (
          resolvedScope.dataset === "campaigns" ||
          resolvedScope.dataset === "metrics"
            ? null
            : now),
        startedAt: now,
      })
      .returning({ id: klaviyoSnapshotRuns.id });
    return { kind: "started" as const, snapshotRunId: run.id };
  });
}

/** Claim a batch before provider IO. A retry by the same task owner rotates
 * the fencing token; a different live owner must wait. Release after a bounded
 * batch (not after a transient failure); provider retries keep their owner ID. */
export async function claimSnapshotLease(input: {
  scope: KlaviyoConnectionScope; snapshotRunId: string; owner: string; now: Date;
}): Promise<string | null> {
  const now = nowDate(input.now);
  if (!input.owner || input.owner.length > 256) throw new Error("Invalid snapshot lease owner");
  return withKlaviyoConnectionLock(input.scope, async tx => {
    const [run] = await tx.select().from(klaviyoSnapshotRuns).where(and(
      scopePredicate(input.scope), eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
    )).for("update");
    if (!run || run.state !== "running") return null;
    if (now.getTime() - run.startedAt.getTime() > KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS) {
      await failSnapshotRunLocked(tx, run.id, "limitExceeded", now);
      return null;
    }
    if (run.leaseOwner && run.leaseOwner !== input.owner &&
        now.getTime() - run.heartbeatAt.getTime() < KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS) return null;
    const token = crypto.randomUUID();
    await tx.update(klaviyoSnapshotRuns).set({ leaseOwner: input.owner, leaseToken: token,
      heartbeatAt: new Date(Math.max(now.getTime(), run.heartbeatAt.getTime())) })
      .where(eq(klaviyoSnapshotRuns.id, run.id));
    return token;
  });
}

export async function releaseSnapshotLease(input: {
  scope: KlaviyoConnectionScope; snapshotRunId: string; leaseToken: string;
}): Promise<void> {
  await withKlaviyoConnectionLock(input.scope, async tx => {
    await tx.update(klaviyoSnapshotRuns).set({ leaseOwner: null, leaseToken: crypto.randomUUID() }).where(and(
      scopePredicate(input.scope), eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
      eq(klaviyoSnapshotRuns.state, "running"), eq(klaviyoSnapshotRuns.leaseToken, input.leaseToken),
    ));
  });
}

export type LoadedSnapshotRun = {
  scope: KlaviyoConnectionScope;
  row: typeof klaviyoSnapshotRuns.$inferSelect;
};

export async function loadSnapshotRun(
  snapshotRunId: string,
): Promise<LoadedSnapshotRun> {
  const [row] = await db
    .select()
    .from(klaviyoSnapshotRuns)
    .where(eq(klaviyoSnapshotRuns.id, snapshotRunId))
    .limit(1);
  if (!row) throw new Error("Klaviyo snapshot run not found");
  return {
    scope: {
      organizationId: row.organizationId,
      storeId: row.storeId,
      connectionId: row.connectionId,
    },
    row,
  };
}

/**
 * Fixed-code failure finalization. A failed or partial collection is never
 * queryable as a published snapshot and never replaces the previous good
 * one; the checkpoint stays for operator forensics.
 */
export async function failSnapshotRun(input: {
  scope: KlaviyoConnectionScope;
  snapshotRunId: string;
  code: KlaviyoSnapshotErrorCode;
  leaseToken?: string;
  now: Date;
}): Promise<{ changed: boolean }> {
  const now = nowDate(input.now);
  const error = KLAVIYO_SNAPSHOT_ERRORS[input.code];
  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({ state: klaviyoSnapshotRuns.state, leaseToken: klaviyoSnapshotRuns.leaseToken, leaseOwner: klaviyoSnapshotRuns.leaseOwner })
      .from(klaviyoSnapshotRuns)
      .where(
        and(
          eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
          eq(klaviyoSnapshotRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSnapshotRuns.storeId, input.scope.storeId),
          eq(klaviyoSnapshotRuns.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo snapshot run is outside this scope");
    if (run.state !== "running" ||
        (input.leaseToken !== undefined && input.leaseToken !== run.leaseToken) ||
        (run.leaseOwner !== null && input.leaseToken === undefined)) return { changed: false };
    await tx
      .update(klaviyoSnapshotRuns)
      .set({
        state: "failed",
        errorCode: error.code,
        errorMessage: error.message,
        finishedAt: now,
        heartbeatAt: sql`greatest(
          ${klaviyoSnapshotRuns.heartbeatAt},
          ${sql.param(now, klaviyoSnapshotRuns.heartbeatAt)}
        )`,
      })
      .where(
        and(
          eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
          eq(klaviyoSnapshotRuns.state, "running"),
        ),
      );
    return { changed: true };
  });
}

// ---------------------------------------------------------------------------
// Page commits
// ---------------------------------------------------------------------------

type CommitPageResult =
  | { committed: true; inserted: number; suppressed: number }
  | { committed: false; reason: "checkpoint_moved" };

export type SnapshotPrivacyKeys = { keyring: IdentityHmacKeyring; suppressionKey: ErasureSuppressionKey };

async function identityGateAgrees(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  keys: SnapshotPrivacyKeys,
): Promise<boolean> {
  const [gate] = await tx
    .select({
      mode: klaviyoConnections.identityWriteMode,
      currentVersion: klaviyoConnections.identityCurrentKeyVersion,
      currentCheck: klaviyoConnections.identityCurrentKeyCheck,
      previousVersion: klaviyoConnections.identityPreviousKeyVersion,
      previousCheck: klaviyoConnections.identityPreviousKeyCheck,
    })
    .from(klaviyoConnections)
    .where(
      and(
        eq(klaviyoConnections.organizationId, scope.organizationId),
        eq(klaviyoConnections.storeId, scope.storeId),
        eq(klaviyoConnections.id, scope.connectionId),
      ),
    );
  const [policy] = await tx
    .select({
      matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
      matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
      matchingPreviousVersion: identityCryptoPolicies.matchingPreviousVersion,
      matchingPreviousKeyCheck:
        identityCryptoPolicies.matchingPreviousKeyCheck,
      suppressionVersion: identityCryptoPolicies.suppressionVersion,
      suppressionKeyCheck: identityCryptoPolicies.suppressionKeyCheck,
    })
    .from(identityCryptoPolicies)
    .where(
      and(
        eq(identityCryptoPolicies.organizationId, scope.organizationId),
        eq(identityCryptoPolicies.storeId, scope.storeId),
      ),
    );
  if (!gate || gate.currentVersion === null || !policy) return false;
  const checks = computeIdentityCryptoKeyChecks({ scope, ...keys });
  if (policy.suppressionVersion !== checks.suppression.keyVersion ||
      !constantTimeEqual(policy.suppressionKeyCheck, checks.suppression.keyCheck) ||
      checks.matching[0].keyVersion !== policy.matchingCurrentVersion ||
      !constantTimeEqual(checks.matching[0].keyCheck, policy.matchingCurrentKeyCheck) ||
      (checks.matching[1]?.keyVersion ?? null) !== policy.matchingPreviousVersion ||
      (checks.matching[1]?.keyCheck ?? null) !== policy.matchingPreviousKeyCheck) return false;
  if (
    policy.matchingCurrentVersion !== gate.currentVersion ||
    !constantTimeEqual(policy.matchingCurrentKeyCheck, gate.currentCheck ?? "")
  ) {
    return false;
  }
  if (gate.mode === "dual") {
    if (
      policy.matchingPreviousVersion !== gate.previousVersion ||
      gate.previousVersion === null ||
      gate.previousCheck === null ||
      policy.matchingPreviousKeyCheck === null ||
      !constantTimeEqual(policy.matchingPreviousKeyCheck, gate.previousCheck)
    ) {
      return false;
    }
  } else if (policy.matchingPreviousVersion !== null) {
    return false;
  }
  return true;
}

/**
 * Stage one collected page and its checkpoint in a single transaction under
 * the shared store→connection lock order. Retries upsert the same
 * snapshot-record identity; they can neither double-count rows nor skip an
 * uncommitted page. Identifiable event records are suppressed against
 * email/profile tombstones before acceptance and their private profile
 * email-suppression associations are persisted — never the plaintext
 * email.
 */
export async function commitSnapshotPage(input: {
  scope: KlaviyoConnectionScope;
  snapshotRunId: string;
  leaseToken: string;
  expectedCheckpoint: KlaviyoSnapshotCheckpoint;
  nextCheckpoint: KlaviyoSnapshotCheckpoint;
  records: KlaviyoStagedSnapshotRecord[];
  privacyKeys?: SnapshotPrivacyKeys;
  reportMetadata?: {
    providerWindow: { start: string; end: string };
    accountTimezone: string;
    warnings: string[];
  };
  now: Date;
}): Promise<CommitPageResult> {
  const now = nowDate(input.now);
  assertExactSnapshotCheckpoint(input.expectedCheckpoint);
  assertExactSnapshotCheckpoint(input.nextCheckpoint);
  if (input.leaseToken.length === 0) {
    throw new Error("Klaviyo snapshot lease token is required");
  }
  const unique = new Map<string, KlaviyoStagedSnapshotRecord>();
  for (const record of input.records) {
    assertValidStagedRecord(record);
    const key = JSON.stringify([record.resourceKind, record.providerIdentity]);
    const prior = unique.get(key);
    if (prior && canonicalSnapshotJson(prior) !== canonicalSnapshotJson(record)) {
      throw new Error("Klaviyo snapshot conflicting duplicate identity");
    }
    unique.set(key, record);
  }
  input = { ...input, records: [...unique.values()] };
  const stagedBytes = input.records.reduce(
    (total, record) =>
      total + Buffer.byteLength(canonicalSnapshotJson(record.content), "utf8"),
    0,
  );

  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({
        state: klaviyoSnapshotRuns.state,
        leaseToken: klaviyoSnapshotRuns.leaseToken,
        checkpoint: klaviyoSnapshotRuns.checkpoint,
        startedAt: klaviyoSnapshotRuns.startedAt,
        recordCount: klaviyoSnapshotRuns.recordCount,
        bytesStaged: klaviyoSnapshotRuns.bytesStaged,
        resolvedScope: klaviyoSnapshotRuns.resolvedScope,
        timezone: klaviyoSnapshotRuns.timezone,
        accountId: klaviyoSnapshotRuns.accountId,
        dataset: klaviyoSnapshotRuns.dataset,
        heartbeatAt: klaviyoSnapshotRuns.heartbeatAt,
      })
      .from(klaviyoSnapshotRuns)
      .where(
        and(
          eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
          eq(klaviyoSnapshotRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSnapshotRuns.storeId, input.scope.storeId),
          eq(klaviyoSnapshotRuns.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo snapshot run is outside this scope");
    if (run.state !== "running" || run.leaseToken !== input.leaseToken) {
      throw new Error("Klaviyo snapshot run is not active for this lease");
    }
    if (run.checkpoint === null) {
      throw new Error("Klaviyo snapshot run checkpoint is missing");
    }
    assertExactSnapshotCheckpoint(run.checkpoint);
    if (now.getTime() - run.heartbeatAt.getTime() >= KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS) {
      throw new Error("Klaviyo snapshot lease expired");
    }
    if (
      run.dataset !== input.expectedCheckpoint.dataset ||
      run.dataset !== input.nextCheckpoint.dataset ||
      input.nextCheckpoint.page !== input.expectedCheckpoint.page + 1
    ) {
      throw new Error("Klaviyo snapshot checkpoint transition is invalid");
    }
    const [connection] = await tx.select().from(klaviyoConnections).where(eq(klaviyoConnections.id, input.scope.connectionId));
    if (!connection || connection.status !== "ready" || connection.klaviyoAccountId !== run.accountId) {
      throw new Error("Klaviyo snapshot connection binding changed");
    }
    for (const record of input.records) {
      if (run.resolvedScope.dataset === "events") {
        const event = klaviyoEventRecordSchema.parse(record.content);
        if (!run.resolvedScope.metricIds.includes(event.metricId) ||
            Date.parse(event.datetime) < Date.parse(run.resolvedScope.since) ||
            Date.parse(event.datetime) >= Date.parse(run.resolvedScope.until)) {
          throw new Error("Klaviyo snapshot event is outside requested scope");
        }
      }
    }
    if (run.resolvedScope.dataset === "campaign_values") {
      const metadata = input.reportMetadata;
      const expected = snapshotReportProviderWindow(run.resolvedScope, run.timezone!);
      if (!metadata || metadata.accountTimezone !== run.timezone ||
          canonicalSnapshotJson(metadata.providerWindow) !== canonicalSnapshotJson(expected) ||
          input.nextCheckpoint.continuation !== null || input.expectedCheckpoint.page !== 0) {
        throw new Error("Klaviyo snapshot report metadata is incomplete or outside scope");
      }
      z.array(z.enum(KLAVIYO_SNAPSHOT_REPORT_WARNINGS)).max(16).parse(metadata.warnings);
      if (!KLAVIYO_SNAPSHOT_REPORT_WARNINGS.slice(0, 3).every(warning => metadata.warnings.includes(warning))) {
        throw new Error("Klaviyo snapshot report coverage warnings are missing");
      }
      for (const record of input.records) {
        const report = klaviyoCampaignValueRecordSchema.parse(record.content);
        if (report.conversionMetricId !== run.resolvedScope.conversionMetricId ||
            report.timeframeStart !== expected.start || report.timeframeEnd !== expected.end) {
          throw new Error("Klaviyo snapshot report row is outside requested scope");
        }
      }
    } else if (input.reportMetadata) {
      throw new Error("Klaviyo snapshot report metadata dataset mismatch");
    }
    const allowedKinds: Record<string, string[]> = {
      campaigns: ["campaign", "campaign_message"],
      metrics: ["metric"], events: ["event"],
      campaign_values: ["campaign_value_row"],
    };
    if (input.records.some((record) => !allowedKinds[run.dataset]?.includes(record.resourceKind))) {
      throw new Error("Klaviyo snapshot record dataset mismatch");
    }
    if (
      run.checkpoint.continuation !== input.expectedCheckpoint.continuation ||
      run.checkpoint.page !== input.expectedCheckpoint.page
    ) {
      return { committed: false as const, reason: "checkpoint_moved" as const };
    }

    if (snapshotCheckpointComplete(run.checkpoint)) {
      throw new Error("Klaviyo snapshot collection is already complete");
    }
    if (now.getTime() - run.startedAt.getTime() > KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS ||
        input.expectedCheckpoint.page + 1 > KLAVIYO_SNAPSHOT_MAX_PAGES_PER_RUN ||
        run.recordCount + input.records.length > KLAVIYO_SNAPSHOT_MAX_RECORDS_PER_RUN ||
        run.bytesStaged + stagedBytes > KLAVIYO_SNAPSHOT_MAX_RUN_BYTES) {
      await failSnapshotRunLocked(tx, input.snapshotRunId, "limitExceeded", now);
      return { error: KLAVIYO_SNAPSHOT_ERRORS.limitExceeded.message };
    }
    if (run.dataset === "events") {
      if (!input.privacyKeys || !await identityGateAgrees(tx, input.scope, input.privacyKeys)) {
        await failSnapshotRunLocked(tx, input.snapshotRunId, "privacyUnresolved", now);
        return { error: KLAVIYO_SNAPSHOT_ERRORS.privacyUnresolved.message };
      }
      for (const record of input.records) {
        if (!record.identity) continue;
        const [profile] = computeErasureSuppressionDigests({ scope: input.scope,
          key: input.privacyKeys.suppressionKey, klaviyoProfileId: record.profileId });
        if (record.identity.keyVersion !== profile.keyVersion ||
            !constantTimeEqual(record.identity.profileDigest, profile.digest)) {
          throw new Error("Klaviyo snapshot profile digest does not match validated key");
        }
      }
    }

    // Suppression check before accepting event rows: drop suppressed
    // subjects entirely — only a safe counter survives.
    const suppressedRecordIndexes = new Set<number>();
    const candidateTuples = new Set<string>();
    for (const record of input.records) {
      if (record.identity === undefined) continue;
      candidateTuples.add(
        JSON.stringify(["email", record.identity.keyVersion, record.identity.emailDigest]),
      );
      candidateTuples.add(
        JSON.stringify([
          "klaviyo_profile_id",
          record.identity.keyVersion,
          record.identity.profileDigest,
        ]),
      );
    }
    const suppressedTuples = new Set<string>();
    for (const candidateChunk of chunk([...candidateTuples])) {
      const parsed = candidateChunk.map((value) => {
        const [kind, keyVersion, digest] = JSON.parse(value) as [
          "email" | "klaviyo_profile_id", string, string,
        ];
        return { kind, keyVersion, digest };
      });
      const hits = await tx
        .select({
          kind: identityErasureSuppressions.kind,
          keyVersion: identityErasureSuppressions.keyVersion,
          digest: identityErasureSuppressions.digest,
        })
        .from(identityErasureSuppressions)
        .where(
          and(
            eq(identityErasureSuppressions.organizationId, input.scope.organizationId),
            eq(identityErasureSuppressions.storeId, input.scope.storeId),
            or(
              ...parsed.map((candidate) =>
                and(
                  eq(identityErasureSuppressions.kind, candidate.kind),
                  eq(identityErasureSuppressions.keyVersion, candidate.keyVersion),
                  eq(identityErasureSuppressions.digest, candidate.digest),
                ),
              ),
            ),
          ),
        );
      for (const hit of hits) {
        suppressedTuples.add(JSON.stringify([hit.kind, hit.keyVersion, hit.digest]));
      }
    }
    for (const [index, record] of input.records.entries()) {
      if (record.identity === undefined) continue;
      if (
        suppressedTuples.has(
          JSON.stringify(["email", record.identity.keyVersion, record.identity.emailDigest]),
        ) ||
        suppressedTuples.has(
          JSON.stringify([
            "klaviyo_profile_id",
            record.identity.keyVersion,
            record.identity.profileDigest,
          ]),
        )
      ) {
        suppressedRecordIndexes.add(index);
      }
    }
    if (input.privacyKeys) {
      const previouslySuppressed = new Set(await findSuppressedSnapshotProfiles(tx, input.scope,
        [...new Set(input.records.flatMap(record => record.profileId ? [record.profileId] : []))],
        input.privacyKeys.suppressionKey));
      for (const [index, record] of input.records.entries()) {
        if (record.profileId && previouslySuppressed.has(record.profileId)) suppressedRecordIndexes.add(index);
      }
    }
    if (input.privacyKeys && suppressedRecordIndexes.size) {
      const suppressedProfiles = [...new Set([...suppressedRecordIndexes].flatMap(index =>
        input.records[index].profileId ? [input.records[index].profileId!] : []))];
      await closeSuppressedSnapshotProfiles({ tx, scope: input.scope, profileIds: suppressedProfiles,
        suppressionKey: input.privacyKeys.suppressionKey, now });
      // Another row for this profile can carry a changed email in this same
      // page. Once identified as erased, drop the entire subject, not only A.
      const erased = new Set(suppressedProfiles);
      for (const [index, record] of input.records.entries()) {
        if (record.profileId && erased.has(record.profileId)) suppressedRecordIndexes.add(index);
      }
    }
    const keptRecords = input.records.filter(
      (_, index) => !suppressedRecordIndexes.has(index),
    );

    // Private profile → versioned email-suppression HMAC associations.
    const associationRows = keptRecords
      .filter((record) => record.identity !== undefined && record.profileId != null)
      .map((record) => ({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        profileId: record.profileId!,
        keyVersion: record.identity!.keyVersion,
        digest: record.identity!.emailDigest,
        lastSeenAt: now,
      }));
    const uniqueAssociations = [...new Map(associationRows.map(row => [
      JSON.stringify([row.connectionId, row.profileId, row.keyVersion, row.digest]), row,
    ])).values()];
    for (const associationChunk of chunk(uniqueAssociations)) {
      await tx
        .insert(klaviyoSnapshotProfileSuppressions)
        .values(associationChunk)
        .onConflictDoUpdate({
          target: [
            klaviyoSnapshotProfileSuppressions.connectionId,
            klaviyoSnapshotProfileSuppressions.profileId,
            klaviyoSnapshotProfileSuppressions.keyVersion,
            klaviyoSnapshotProfileSuppressions.digest,
          ],
          set: { lastSeenAt: now },
        });
    }

    // Immutable connection-scoped content versions, shared across snapshots.
    const contentDigest = (content: Record<string, unknown>) =>
      createHash("sha256").update(canonicalSnapshotJson(content)).digest("hex");
    const contentRows = keptRecords.map((record) => ({
      organizationId: input.scope.organizationId,
      storeId: input.scope.storeId,
      connectionId: input.scope.connectionId,
      resourceKind: record.resourceKind,
      contentDigest: contentDigest(record.content),
      content: record.content,
    }));
    const contentIdByDigest = new Map<string, string>();
    for (const contentChunk of chunk(contentRows)) {
      await tx
        .insert(klaviyoSnapshotContents)
        .values(contentChunk)
        .onConflictDoNothing({
          target: [
            klaviyoSnapshotContents.connectionId,
            klaviyoSnapshotContents.resourceKind,
            klaviyoSnapshotContents.contentDigest,
          ],
        });
      const pairs = [
        ...new Set(
          contentChunk.map((row) => `${row.resourceKind}\0${row.contentDigest}`),
        ),
      ].map((pair) => {
        const [resourceKind, digest] = pair.split("\0");
        return { resourceKind, digest };
      });
      for (const pairChunk of chunk(pairs)) {
        const existing = await tx
          .select({
            id: klaviyoSnapshotContents.id,
            resourceKind: klaviyoSnapshotContents.resourceKind,
            contentDigest: klaviyoSnapshotContents.contentDigest,
          })
          .from(klaviyoSnapshotContents)
          .where(
            and(
              eq(klaviyoSnapshotContents.connectionId, input.scope.connectionId),
              or(
                ...pairChunk.map((pair) =>
                  and(
                    eq(
                      klaviyoSnapshotContents.resourceKind,
                      pair.resourceKind as KlaviyoSnapshotResourceKind,
                    ),
                    eq(klaviyoSnapshotContents.contentDigest, pair.digest!),
                  ),
                ),
              ),
            ),
          );
        for (const row of existing) {
          contentIdByDigest.set(
            `${row.resourceKind}\0${row.contentDigest}`,
            row.id,
          );
        }
      }
    }

    let inserted = 0;
    for (const recordChunk of chunk(keptRecords)) {
      const stored = await tx
        .insert(klaviyoSnapshotRecords)
        .values(
          recordChunk.map((record) => ({
            organizationId: input.scope.organizationId,
            storeId: input.scope.storeId,
            connectionId: input.scope.connectionId,
            snapshotRunId: input.snapshotRunId,
            contentId: contentIdByDigest.get(
              `${record.resourceKind}\0${contentDigest(record.content)}`,
            )!,
            resourceKind: record.resourceKind,
            providerIdentity: record.providerIdentity,
            orderingKey: record.orderingKey,
            profileId: record.profileId ?? null,
            metricId: record.metricId ?? null,
            eventDatetime: record.eventDatetime
              ? new Date(record.eventDatetime)
              : null,
          })),
        )
        .onConflictDoNothing({
          target: [
            klaviyoSnapshotRecords.snapshotRunId,
            klaviyoSnapshotRecords.resourceKind,
            klaviyoSnapshotRecords.providerIdentity,
          ],
        })
        .returning({ id: klaviyoSnapshotRecords.id });
      inserted += stored.length;
    }

    // A repeated provider identity may overlap pages, but it cannot change
    // payload/order inside one observed generation. Roll back the entire page
    // on conflict, including newly inserted content and identity associations.
    for (const recordChunk of chunk(keptRecords)) {
      const stored = await tx.select().from(klaviyoSnapshotRecords).where(and(
        eq(klaviyoSnapshotRecords.snapshotRunId, input.snapshotRunId),
        or(...recordChunk.map(record => and(
          eq(klaviyoSnapshotRecords.resourceKind, record.resourceKind),
          eq(klaviyoSnapshotRecords.providerIdentity, record.providerIdentity),
        ))),
      ));
      const byIdentity = new Map(stored.map(row => [JSON.stringify([row.resourceKind, row.providerIdentity]), row]));
      for (const record of recordChunk) {
        const row = byIdentity.get(JSON.stringify([record.resourceKind, record.providerIdentity]));
        if (!row || row.contentId !== contentIdByDigest.get(`${record.resourceKind}\0${contentDigest(record.content)}`) ||
            row.orderingKey !== record.orderingKey) {
          throw new Error("Klaviyo snapshot conflicting duplicate identity");
        }
      }
    }
    const suppressedCount = suppressedRecordIndexes.size;
    const advanced = await tx
      .update(klaviyoSnapshotRuns)
      .set({
        checkpoint: input.nextCheckpoint,
        ...(input.reportMetadata ? {
          providerWindowStart: input.reportMetadata.providerWindow.start,
          providerWindowEnd: input.reportMetadata.providerWindow.end,
          timezone: input.reportMetadata.accountTimezone,
          warnings: input.reportMetadata.warnings,
          providerCompleteness: "unverified",
        } : {}),
        heartbeatAt: sql`greatest(
          ${klaviyoSnapshotRuns.heartbeatAt},
          ${sql.param(now, klaviyoSnapshotRuns.heartbeatAt)}
        )`,
        pageCount: sql`${klaviyoSnapshotRuns.pageCount} + 1`,
        recordCount: sql`${klaviyoSnapshotRuns.recordCount} + ${inserted}`,
        bytesStaged: sql`${klaviyoSnapshotRuns.bytesStaged} + ${stagedBytes}`,
        suppressedCount: sql`${klaviyoSnapshotRuns.suppressedCount} + ${suppressedCount}`,
      })
      .where(
        and(
          eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
          eq(klaviyoSnapshotRuns.state, "running"),
          eq(klaviyoSnapshotRuns.leaseToken, input.leaseToken),
        ),
      )
      .returning({ id: klaviyoSnapshotRuns.id });
    if (advanced.length !== 1) {
      throw new Error("Klaviyo snapshot page commit raced");
    }
    return { committed: true as const, inserted, suppressed: suppressedCount };
  }).then(result => {
    if ("error" in result) throw new Error(result.error);
    return result;
  });
}

async function failSnapshotRunLocked(
  tx: KlaviyoStoreTransaction,
  snapshotRunId: string,
  code: KlaviyoSnapshotErrorCode,
  now: Date,
): Promise<void> {
  const error = KLAVIYO_SNAPSHOT_ERRORS[code];
  await tx
    .update(klaviyoSnapshotRuns)
    .set({
      state: "failed",
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: now,
    })
    .where(
      and(
        eq(klaviyoSnapshotRuns.id, snapshotRunId),
        eq(klaviyoSnapshotRuns.state, "running"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Atomic publication
// ---------------------------------------------------------------------------

export type PublishSnapshotRunResult =
  | { published: true; recordCount: number; removedForPrivacy: number }
  | { published: false; reason: "superseded" };

/**
 * The one atomic terminal publication: under the shared store→connection
 * lock order, re-check suppressions for identifiable staged records at the
 * erasure-concurrency boundary, refuse to publish an older concurrent
 * collection over a newer current snapshot, then mark this snapshot
 * published, supersede the previous current pointer and recompute visible
 * counts — all in one transaction. A failed re-check or race rolls back
 * without touching the previous good snapshot.
 */
export async function publishSnapshotRun(input: {
  scope: KlaviyoConnectionScope;
  snapshotRunId: string;
  leaseToken: string;
  providerCompleteness: "complete" | "unverified";
  warnings: string[];
  suppressionKey: ErasureSuppressionKey | null;
  privacyKeys?: SnapshotPrivacyKeys;
  now: Date;
}): Promise<PublishSnapshotRunResult> {
  const now = nowDate(input.now);
  if (input.warnings.length > 16) {
    throw new Error("Klaviyo snapshot publication warnings are invalid");
  }
  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({
        id: klaviyoSnapshotRuns.id,
        dataset: klaviyoSnapshotRuns.dataset,
        scopeFingerprint: klaviyoSnapshotRuns.scopeFingerprint,
        state: klaviyoSnapshotRuns.state,
        leaseToken: klaviyoSnapshotRuns.leaseToken,
        checkpoint: klaviyoSnapshotRuns.checkpoint,
        startedAt: klaviyoSnapshotRuns.startedAt,
        heartbeatAt: klaviyoSnapshotRuns.heartbeatAt,
        definitionId: klaviyoSnapshotRuns.definitionId,
        configurationVersion: klaviyoSnapshotRuns.configurationVersion,
        accountId: klaviyoSnapshotRuns.accountId,
        providerCompleteness: klaviyoSnapshotRuns.providerCompleteness,
        providerWindowStart: klaviyoSnapshotRuns.providerWindowStart,
        providerWindowEnd: klaviyoSnapshotRuns.providerWindowEnd,
        warnings: klaviyoSnapshotRuns.warnings,
      })
      .from(klaviyoSnapshotRuns)
      .where(
        and(
          eq(klaviyoSnapshotRuns.id, input.snapshotRunId),
          eq(klaviyoSnapshotRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSnapshotRuns.storeId, input.scope.storeId),
          eq(klaviyoSnapshotRuns.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo snapshot run is outside this scope");
    if (run.state !== "running" || run.leaseToken !== input.leaseToken) {
      throw new Error("Klaviyo snapshot run is not active for this lease");
    }
    if (run.checkpoint === null) {
      throw new Error("Klaviyo snapshot run checkpoint is missing");
    }
    assertExactSnapshotCheckpoint(run.checkpoint);
    if (!snapshotCheckpointComplete(run.checkpoint)) {
      throw new Error("Klaviyo snapshot collection is not complete");
    }
    if (now.getTime() - run.heartbeatAt.getTime() >= KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS ||
        now.getTime() - run.startedAt.getTime() > KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS) {
      throw new Error("Klaviyo snapshot lease expired");
    }
    const [connection] = await tx.select().from(klaviyoConnections).where(eq(klaviyoConnections.id, input.scope.connectionId));
    if (!connection || connection.status !== "ready" || connection.klaviyoAccountId !== run.accountId) {
      throw new Error("Klaviyo snapshot connection binding changed");
    }
    if (run.dataset !== "campaign_values" && (input.warnings.length || input.providerCompleteness !== "complete")) {
      throw new Error("Klaviyo snapshot collection completeness is invalid");
    }
    if (run.dataset === "campaign_values" &&
        (run.providerCompleteness !== "unverified" || !run.providerWindowStart || !run.providerWindowEnd ||
         input.providerCompleteness !== "unverified" || canonicalSnapshotJson(input.warnings) !== canonicalSnapshotJson(run.warnings))) {
      throw new Error("Klaviyo snapshot report cannot certify provider completeness");
    }
    if (run.definitionId) {
      const [definition] = await tx.select().from(klaviyoSnapshotDefinitions)
        .where(eq(klaviyoSnapshotDefinitions.id, run.definitionId));
      if (!definition || definition.configurationVersion !== run.configurationVersion) {
        await failSnapshotRunLocked(tx, run.id, "superseded", now);
        return { published: false as const, reason: "superseded" as const };
      }
    }
    if (run.dataset === "events" && (!input.privacyKeys || !input.suppressionKey ||
        !await identityGateAgrees(tx, input.scope, input.privacyKeys) ||
        input.suppressionKey.version !== input.privacyKeys.suppressionKey.version ||
        !Buffer.from(input.suppressionKey.secret).equals(Buffer.from(input.privacyKeys.suppressionKey.secret)))) {
      await failSnapshotRunLocked(tx, run.id, "privacyUnresolved", now);
      return { error: KLAVIYO_SNAPSHOT_ERRORS.privacyUnresolved.message };
    }

    // An older concurrent collection must not replace a newer publication.
    const [current] = await tx
      .select({
        id: klaviyoSnapshotRuns.id,
        startedAt: klaviyoSnapshotRuns.startedAt,
      })
      .from(klaviyoSnapshotRuns)
      .where(
        and(
          eq(klaviyoSnapshotRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSnapshotRuns.dataset, run.dataset),
          eq(klaviyoSnapshotRuns.scopeFingerprint, run.scopeFingerprint),
          eq(klaviyoSnapshotRuns.state, "published"),
          eq(klaviyoSnapshotRuns.isCurrent, 1),
        ),
      )
      .for("update");
    if (
      current &&
      current.startedAt.getTime() > run.startedAt.getTime()
    ) {
      await failSnapshotRunLocked(tx, run.id, "superseded", now);
      return { published: false as const, reason: "superseded" as const };
    }

    // Erasure-concurrency boundary: remove any staged identifiable records
    // whose subjects became suppressed while this run collected.
    let removedForPrivacy = 0;
    if (input.suppressionKey !== null) {
      const profileRows = await tx
        .selectDistinct({ profileId: klaviyoSnapshotRecords.profileId })
        .from(klaviyoSnapshotRecords)
        .where(
          and(
            eq(klaviyoSnapshotRecords.snapshotRunId, run.id),
            sql`${klaviyoSnapshotRecords.profileId} is not null`,
          ),
        );
      const profileIds = profileRows
        .map((row) => row.profileId)
        .filter((value): value is string => value !== null);
      const suppressedProfileIds = await findSuppressedSnapshotProfiles(
        tx,
        input.scope,
        profileIds,
        input.suppressionKey,
      );
      if (suppressedProfileIds.length > 0) {
        const outcome = await closeSuppressedSnapshotProfiles({
          scope: input.scope, profileIds: suppressedProfileIds, tx, now,
          suppressionKey: input.suppressionKey,
        });
        removedForPrivacy = outcome.recordsDeleted;
      }
    }

    if (current && current.id !== run.id) {
      await tx
        .update(klaviyoSnapshotRuns)
        .set({ isCurrent: 0 })
        .where(eq(klaviyoSnapshotRuns.id, current.id));
    }
    const [recount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoSnapshotRecords)
      .where(eq(klaviyoSnapshotRecords.snapshotRunId, run.id));
    const recordCount = recount?.count ?? 0;
    const published = await tx
      .update(klaviyoSnapshotRuns)
      .set({
        state: "published",
        isCurrent: 1,
        publishedAt: now,
        finishedAt: now,
        checkpoint: null,
        providerCompleteness: input.providerCompleteness,
        warnings: input.warnings,
        recordCount,
        heartbeatAt: sql`greatest(
          ${klaviyoSnapshotRuns.heartbeatAt},
          ${sql.param(now, klaviyoSnapshotRuns.heartbeatAt)}
        )`,
        // eraseSnapshotProfileEvidence already adjusted each affected run's
        // privacy count; do not count those deletions twice here.
      })
      .where(
        and(
          eq(klaviyoSnapshotRuns.id, run.id),
          eq(klaviyoSnapshotRuns.state, "running"),
          eq(klaviyoSnapshotRuns.leaseToken, input.leaseToken),
        ),
      )
      .returning({ id: klaviyoSnapshotRuns.id });
    if (published.length !== 1) {
      throw new Error("Klaviyo snapshot publication raced");
    }
    return { published: true as const, recordCount, removedForPrivacy };
  }).then(result => {
    if ("error" in result) throw new Error(result.error);
    return result;
  });
}

/**
 * Profiles whose snapshot associations or profile identity hit an erasure
 * tombstone. Pure lookup; callers hold the store lock.
 */
async function findSuppressedSnapshotProfiles(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  profileIds: string[],
  suppressionKey: ErasureSuppressionKey,
): Promise<string[]> {
  if (profileIds.length === 0) return [];
  const identityScope = {
    organizationId: scope.organizationId,
    storeId: scope.storeId,
  };
  const profileDigestByProfileId = new Map<string, string>();
  for (const profileId of profileIds) {
    const [digest] = computeErasureSuppressionDigests({
      scope: identityScope,
      key: suppressionKey,
      klaviyoProfileId: profileId,
    });
    profileDigestByProfileId.set(profileId, digest.digest);
  }
  const suppressed = new Set<string>();
  for (const profileChunk of chunk(profileIds)) {
    const associations = await tx
      .select({
        profileId: klaviyoSnapshotProfileSuppressions.profileId,
        keyVersion: klaviyoSnapshotProfileSuppressions.keyVersion,
        digest: klaviyoSnapshotProfileSuppressions.digest,
      })
      .from(klaviyoSnapshotProfileSuppressions)
      .where(
        and(
          eq(
            klaviyoSnapshotProfileSuppressions.organizationId,
            scope.organizationId,
          ),
          eq(klaviyoSnapshotProfileSuppressions.storeId, scope.storeId),
          eq(
            klaviyoSnapshotProfileSuppressions.connectionId,
            scope.connectionId,
          ),
          inArray(klaviyoSnapshotProfileSuppressions.profileId, profileChunk),
        ),
      );
    const associationTuples = [
      ...new Set(
        associations.map((association) =>
          JSON.stringify([
            "email",
            association.keyVersion,
            association.digest,
          ]),
        ),
      ),
    ].map((value) => {
      const [, keyVersion, digest] = JSON.parse(value) as [string, string, string];
      return { keyVersion, digest };
    });
    const emailHits = new Set<string>();
    for (const tupleChunk of chunk(associationTuples)) {
      const hits = await tx
        .select({
          keyVersion: identityErasureSuppressions.keyVersion,
          digest: identityErasureSuppressions.digest,
        })
        .from(identityErasureSuppressions)
        .where(
          and(
            eq(
              identityErasureSuppressions.organizationId,
              scope.organizationId,
            ),
            eq(identityErasureSuppressions.storeId, scope.storeId),
            eq(identityErasureSuppressions.kind, "email"),
            or(
              ...tupleChunk.map((tuple) =>
                and(
                  eq(identityErasureSuppressions.keyVersion, tuple.keyVersion),
                  eq(identityErasureSuppressions.digest, tuple.digest),
                ),
              ),
            ),
          ),
        );
      for (const hit of hits) {
        emailHits.add(JSON.stringify([hit.keyVersion, hit.digest]));
      }
    }
    for (const association of associations) {
      if (emailHits.has(JSON.stringify([association.keyVersion, association.digest]))) {
        suppressed.add(association.profileId);
      }
    }
    const profileDigests = profileChunk.map(
      (profileId) => profileDigestByProfileId.get(profileId)!,
    );
    const profileHits = await tx
      .select({ digest: identityErasureSuppressions.digest })
      .from(identityErasureSuppressions)
      .where(
        and(
          eq(identityErasureSuppressions.organizationId, scope.organizationId),
          eq(identityErasureSuppressions.storeId, scope.storeId),
          eq(identityErasureSuppressions.kind, "klaviyo_profile_id"),
          eq(identityErasureSuppressions.keyVersion, suppressionKey.version),
          inArray(identityErasureSuppressions.digest, profileDigests),
        ),
      );
    const hitDigests = new Set(profileHits.map((row) => row.digest));
    for (const profileId of profileChunk) {
      if (hitDigests.has(profileDigestByProfileId.get(profileId)!)) {
        suppressed.add(profileId);
      }
    }
  }
  return [...suppressed];
}

/**
 * Privacy-erasure exception to snapshot immutability. Removes every record
 * of the given profiles from every historical and staging snapshot of the
 * connection, deletes orphaned shared content versions, marks affected
 * runs privacy-adjusted and recomputes visible counts. The caller holds the
 * store→connection lock order. Previously observed email associations are
 * retained while referenced history survives.
 */
async function closeSuppressedSnapshotProfiles(input: {
  scope: KlaviyoConnectionScope; profileIds: string[]; tx: KlaviyoStoreTransaction;
  suppressionKey: ErasureSuppressionKey; now: Date;
}) {
  const { tx, scope } = input;
  for (const profiles of chunk([...new Set(input.profileIds)])) {
    const digests = profiles.map(profileId => ({ profileId, ...computeErasureSuppressionDigests({
      scope, key: input.suppressionKey, klaviyoProfileId: profileId,
    })[0] }));
    await tx.insert(identityErasureSuppressions).values(digests.map(({ kind, keyVersion, digest }) => ({
      organizationId: scope.organizationId, storeId: scope.storeId, kind, keyVersion, digest,
    }))).onConflictDoNothing();
    const tombstones = await tx.select().from(identityErasureSuppressions).where(and(
      eq(identityErasureSuppressions.organizationId, scope.organizationId),
      eq(identityErasureSuppressions.storeId, scope.storeId),
      eq(identityErasureSuppressions.kind, "klaviyo_profile_id"),
      eq(identityErasureSuppressions.keyVersion, input.suppressionKey.version),
      inArray(identityErasureSuppressions.digest, digests.map(row => row.digest)),
    ));
    const tombstoneByDigest = new Map(tombstones.map(row => [row.digest, row.id]));
    const tombstoneByProfile = new Map(digests.map(row => [row.profileId, tombstoneByDigest.get(row.digest)!]));
    const canonical = await tx.select({ id: klaviyoEvents.id, profileId: klaviyoEvents.profileId }).from(klaviyoEvents).where(and(
      eq(klaviyoEvents.organizationId, scope.organizationId), eq(klaviyoEvents.storeId, scope.storeId),
      eq(klaviyoEvents.connectionId, scope.connectionId), inArray(klaviyoEvents.profileId, profiles),
    ));
    for (const event of canonical) {
      await eraseSuppressedKlaviyoEventEvidence({ scope, tx, eventId: event.id,
        suppressionId: tombstoneByProfile.get(event.profileId!)! });
    }
  }
  return eraseSnapshotProfileEvidence(input);
}

export async function eraseSnapshotProfileEvidence(input: {
  scope: KlaviyoConnectionScope;
  profileIds: string[];
  tx: KlaviyoStoreTransaction;
  now: Date;
}): Promise<{
  recordsDeleted: number;
  contentsDeleted: number;
  affectedRunIds: string[];
}> {
  const { tx, scope } = input;
  if (input.profileIds.length === 0) {
    return { recordsDeleted: 0, contentsDeleted: 0, affectedRunIds: [] };
  }
  const contentIds: string[] = [];
  const recordsDeletedByRun = new Map<string, number>();
  let recordsDeleted = 0;
  for (const profileChunk of chunk(input.profileIds)) {
    // Erasure callers have established profile tombstones under this lock;
    // no historical email association needs to survive the erased history.
    await tx.delete(klaviyoSnapshotProfileSuppressions).where(and(
      eq(klaviyoSnapshotProfileSuppressions.organizationId, scope.organizationId),
      eq(klaviyoSnapshotProfileSuppressions.storeId, scope.storeId),
      eq(klaviyoSnapshotProfileSuppressions.connectionId, scope.connectionId),
      inArray(klaviyoSnapshotProfileSuppressions.profileId, profileChunk),
    ));
    const deletedRecords = await tx
      .delete(klaviyoSnapshotRecords)
      .where(
        and(
          eq(klaviyoSnapshotRecords.organizationId, scope.organizationId),
          eq(klaviyoSnapshotRecords.storeId, scope.storeId),
          eq(klaviyoSnapshotRecords.connectionId, scope.connectionId),
          inArray(klaviyoSnapshotRecords.profileId, profileChunk),
        ),
      )
      .returning({
        contentId: klaviyoSnapshotRecords.contentId,
        snapshotRunId: klaviyoSnapshotRecords.snapshotRunId,
      });
    recordsDeleted += deletedRecords.length;
    for (const row of deletedRecords) {
      contentIds.push(row.contentId);
      recordsDeletedByRun.set(
        row.snapshotRunId,
        (recordsDeletedByRun.get(row.snapshotRunId) ?? 0) + 1,
      );
    }
  }
  // Also remove unreferenced identifiable payloads, including any orphan left
  // by a historical failed writer. Do not depend solely on live record FKs.
  for (const profileChunk of chunk(input.profileIds)) {
    const orphanCandidates = await tx.select({ id: klaviyoSnapshotContents.id }).from(klaviyoSnapshotContents).where(and(
      eq(klaviyoSnapshotContents.connectionId, scope.connectionId),
      eq(klaviyoSnapshotContents.organizationId, scope.organizationId),
      eq(klaviyoSnapshotContents.storeId, scope.storeId),
      eq(klaviyoSnapshotContents.resourceKind, "event"),
      inArray(sql<string>`${klaviyoSnapshotContents.content}->>'profileId'`, profileChunk),
    ));
    contentIds.push(...orphanCandidates.map(row => row.id));
  }
  let contentsDeleted = 0;
  for (const contentChunk of chunk([...new Set(contentIds)])) {
    const orphaned = await tx
      .delete(klaviyoSnapshotContents)
      .where(
        and(
          eq(klaviyoSnapshotContents.organizationId, scope.organizationId),
          eq(klaviyoSnapshotContents.storeId, scope.storeId),
          eq(klaviyoSnapshotContents.connectionId, scope.connectionId),
          inArray(klaviyoSnapshotContents.id, contentChunk),
          sql`not exists (
            select 1 from ${klaviyoSnapshotRecords}
            where ${klaviyoSnapshotRecords.contentId} = ${klaviyoSnapshotContents.id}
          )`,
        ),
      )
      .returning({ id: klaviyoSnapshotContents.id });
    contentsDeleted += orphaned.length;
  }
  // Mark affected runs privacy-adjusted and recompute visible counts
  // consistently; ordering keys of remaining records stay stable.
  const runIds = [...recordsDeletedByRun.keys()];
  for (const runId of runIds) {
    const [recount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoSnapshotRecords)
      .where(eq(klaviyoSnapshotRecords.snapshotRunId, runId));
    await tx
      .update(klaviyoSnapshotRuns)
      .set({
        privacyAdjusted: 1,
        privacyAdjustedAt: input.now,
        privacyRemovedCount: sql`${klaviyoSnapshotRuns.privacyRemovedCount} + ${recordsDeletedByRun.get(runId)}`,
        recordCount: recount?.count ?? 0,
      })
      .where(eq(klaviyoSnapshotRuns.id, runId));
  }
  return { recordsDeleted, contentsDeleted, affectedRunIds: runIds };
}

// ---------------------------------------------------------------------------
// Reads and operator inspection
// ---------------------------------------------------------------------------

export type SnapshotRecordRow = {
  id: string;
  resourceKind: KlaviyoSnapshotResourceKind;
  providerIdentity: string;
  orderingKey: string;
  content: Record<string, unknown>;
};

/**
 * One bounded, stable DB page of a published snapshot, ordered by
 * (resource kind, ordering key) keyset — never a mutable offset across
 * generations.
 */
export async function querySnapshotRecords(input: {
  snapshotRunId: string;
  limit: number;
  after: { resourceKind: KlaviyoSnapshotResourceKind; orderingKey: string } | null;
}): Promise<SnapshotRecordRow[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1001) {
    throw new Error("Klaviyo snapshot page limit is invalid");
  }
  const after = input.after;
  const rows = await db
    .select({
      id: klaviyoSnapshotRecords.id,
      resourceKind: klaviyoSnapshotRecords.resourceKind,
      providerIdentity: klaviyoSnapshotRecords.providerIdentity,
      orderingKey: klaviyoSnapshotRecords.orderingKey,
      content: klaviyoSnapshotContents.content,
    })
    .from(klaviyoSnapshotRecords)
    .innerJoin(klaviyoSnapshotRuns, and(
      eq(klaviyoSnapshotRuns.id, klaviyoSnapshotRecords.snapshotRunId),
      eq(klaviyoSnapshotRuns.state, "published"),
    ))
    .innerJoin(
      klaviyoSnapshotContents,
      eq(klaviyoSnapshotContents.id, klaviyoSnapshotRecords.contentId),
    )
    .where(
      and(
        eq(klaviyoSnapshotRecords.snapshotRunId, input.snapshotRunId),
        after
          ? or(
              and(
                eq(klaviyoSnapshotRecords.resourceKind, after.resourceKind),
                gt(klaviyoSnapshotRecords.orderingKey, after.orderingKey),
              ),
              gt(klaviyoSnapshotRecords.resourceKind, after.resourceKind),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(klaviyoSnapshotRecords.resourceKind),
      asc(klaviyoSnapshotRecords.orderingKey),
    )
    .limit(input.limit);
  return rows.map((row) => ({
    id: row.id,
    resourceKind: row.resourceKind as KlaviyoSnapshotResourceKind,
    providerIdentity: row.providerIdentity,
    orderingKey: row.orderingKey,
    content: row.content as Record<string, unknown>,
  }));
}

export type SnapshotRunSummary = {
  id: string;
  dataset: KlaviyoSnapshotDataset;
  scopeFingerprint: string;
  resolvedScope: KlaviyoSnapshotResolvedScope;
  configurationVersion: number;
  triggerType: "daily" | "manual";
  state: "running" | "published" | "failed";
  isCurrent: boolean;
  recordCount: number;
  pageCount: number;
  suppressedCount: number;
  providerCompleteness: "complete" | "unverified" | null;
  privacyAdjusted: boolean;
  privacyRemovedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  requestedFrom: Date | null;
  requestedTo: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  publishedAt: Date | null;
  stale: boolean;
};

function toRunSummary(row: typeof klaviyoSnapshotRuns.$inferSelect): SnapshotRunSummary {
  return {
    id: row.id,
    dataset: row.dataset as KlaviyoSnapshotDataset,
    scopeFingerprint: row.scopeFingerprint,
    resolvedScope: row.resolvedScope as KlaviyoSnapshotResolvedScope,
    configurationVersion: row.configurationVersion,
    triggerType: row.triggerType as "daily" | "manual",
    state: row.state as "running" | "published" | "failed",
    isCurrent: row.isCurrent === 1,
    recordCount: row.recordCount,
    pageCount: row.pageCount,
    suppressedCount: row.suppressedCount,
    providerCompleteness:
      (row.providerCompleteness as "complete" | "unverified" | null) ?? null,
    privacyAdjusted: row.privacyAdjusted === 1,
    privacyRemovedCount: row.privacyRemovedCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    requestedFrom: row.requestedFrom,
    requestedTo: row.requestedTo,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    publishedAt: row.publishedAt,
    stale:
      row.state === "running" &&
      Date.now() - row.heartbeatAt.getTime() > KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS,
  };
}

export async function listSnapshotRunSummaries(input: {
  scope: KlaviyoConnectionScope;
  dataset?: KlaviyoSnapshotDataset;
  limit: number;
  cursor: { startedAt: Date; id: string } | null;
}): Promise<{ items: SnapshotRunSummary[]; nextCursor: { startedAt: Date; id: string } | null }> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Klaviyo snapshot run limit must be between 1 and 100");
  }
  const rows = await db
    .select()
    .from(klaviyoSnapshotRuns)
    .where(
      and(
        scopePredicate(input.scope),
        input.dataset ? eq(klaviyoSnapshotRuns.dataset, input.dataset) : undefined,
        input.cursor
          ? or(
              lt(klaviyoSnapshotRuns.startedAt, input.cursor.startedAt),
              and(
                eq(klaviyoSnapshotRuns.startedAt, input.cursor.startedAt),
                lt(klaviyoSnapshotRuns.id, input.cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(klaviyoSnapshotRuns.startedAt), desc(klaviyoSnapshotRuns.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map(toRunSummary),
    nextCursor:
      hasMore && last
        ? { startedAt: last.startedAt, id: last.id }
        : null,
  };
}

/**
 * Operator inspection: definition configuration, the current published
 * snapshots per dataset and the latest refresh state — separate from the
 * published snapshot's own state.
 */
export async function getSnapshotSyncStatus(
  scope: KlaviyoConnectionScope,
): Promise<{
  definitions: KlaviyoSnapshotDefinitionRecord[];
  datasets: Array<{
    dataset: KlaviyoSnapshotDataset;
    current: Array<{
      snapshotRunId: string;
      resolvedScope: KlaviyoSnapshotResolvedScope;
      publishedAt: Date;
      recordCount: number;
      privacyAdjusted: boolean;
      providerCompleteness: "complete" | "unverified";
    }>;
    latestRun: SnapshotRunSummary | null;
  }>;
}> {
  const definitions = await listSnapshotDefinitions(scope);
  // Bound each dataset independently: a long event history must not hide
  // the catalog's current/latest status. Full history uses the paged API.
  const currentRows = (await Promise.all(KLAVIYO_SNAPSHOT_DATASETS.map(dataset => db
    .select().from(klaviyoSnapshotRuns).where(and(
      scopePredicate(scope), eq(klaviyoSnapshotRuns.dataset, dataset),
      eq(klaviyoSnapshotRuns.state, "published"), eq(klaviyoSnapshotRuns.isCurrent, 1),
    )).orderBy(desc(klaviyoSnapshotRuns.publishedAt), desc(klaviyoSnapshotRuns.id)).limit(50)))).flat();
  const latestRows = (await Promise.all(KLAVIYO_SNAPSHOT_DATASETS.map(dataset => db
    .select().from(klaviyoSnapshotRuns).where(and(scopePredicate(scope), eq(klaviyoSnapshotRuns.dataset, dataset)))
    .orderBy(desc(klaviyoSnapshotRuns.startedAt), desc(klaviyoSnapshotRuns.id)).limit(1)))).flat();
  const latestByDataset = new Map<string, SnapshotRunSummary>();
  for (const row of latestRows) {
    if (!latestByDataset.has(row.dataset)) {
      latestByDataset.set(row.dataset, toRunSummary(row));
    }
  }
  return {
    definitions,
    datasets: (
      ["campaigns", "metrics", "events", "campaign_values"] as const
    ).map((dataset) => ({
      dataset,
      current: currentRows
        .filter((row) => row.dataset === dataset)
        .map((row) => ({
          snapshotRunId: row.id,
          resolvedScope: row.resolvedScope as KlaviyoSnapshotResolvedScope,
          publishedAt: row.publishedAt!,
          recordCount: row.recordCount,
          privacyAdjusted: row.privacyAdjusted === 1,
          providerCompleteness: row.providerCompleteness as "complete" | "unverified",
        })),
      latestRun: latestByDataset.get(dataset) ?? null,
    })),
  };
}
