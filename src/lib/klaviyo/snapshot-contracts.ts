import { createHash } from "node:crypto";
import { z } from "zod";
import {
  klaviyoCampaignMessageRecordSchema,
  klaviyoCampaignRecordSchema,
  klaviyoCampaignValueRecordSchema,
  klaviyoEventRecordSchema,
  klaviyoMetricRecordSchema,
} from "./record-contracts";

/**
 * Pure Klaviyo snapshot contracts: dataset/scope canonicalization, durable
 * checkpoint shapes, response states and fixed error codes shared by the
 * collector (Trigger workers) and the DB-backed read service. This module
 * must not import the database, provider transport or credential resolver.
 */

export const KLAVIYO_SNAPSHOT_DATASETS = [
  "campaigns",
  "metrics",
  "events",
  "campaign_values",
] as const;
export type KlaviyoSnapshotDataset = (typeof KLAVIYO_SNAPSHOT_DATASETS)[number];

export type KlaviyoSnapshotResourceKind =
  | "campaign"
  | "campaign_message"
  | "metric"
  | "event"
  | "campaign_value_row";

/** Pinned to the reviewed provider adapters' revision. */
export const KLAVIYO_SNAPSHOT_API_REVISION = "2026-07-15";

// Fixed reviewed adapter warnings only; never persist arbitrary provider text.
export const KLAVIYO_SNAPSHOT_REPORT_WARNINGS = [
  "Pagination is unverified: page_cursor is accepted but no next-cursor response field is documented; null continuation does not establish completeness.",
  "Provider times are account-local wall clocks; their Z suffix is not UTC. End rounds through its local hour; exact instant filtering and DST-fold interpretation are unverified.",
  "Statistics are send-date campaign performance, not event-time or Shopify revenue.",
  "Subsecond boundaries cannot be represented exactly by the provider's hourly end rounding; fractional instants are interpreted at JavaScript millisecond precision.",
  "Response reached the 10000-row safety limit; additional rows may exist. No rows were discarded.",
  "Some requested statistics were absent and are represented as null, not zero.",
] as const;

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const METRIC_ID_PATTERN = /^[A-Za-z0-9]+$/;

// ---------------------------------------------------------------------------
// Scope canonicalization and fingerprints
// ---------------------------------------------------------------------------

export const snapshotInstantSchema = z
  .string()
  .max(64)
  .datetime({ offset: true });

const metricIdListSchema = z
  .array(z.string().min(1).max(128).regex(METRIC_ID_PATTERN))
  .min(1)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);

const windowFields = { since: snapshotInstantSchema, until: snapshotInstantSchema };

const halfOpenWindowSchema = z.object(windowFields).strict();

const windowRefine = ({ since, until }: { since: string; until: string }) => {
  const span = Date.parse(until) - Date.parse(since);
  return span > 0 && span <= YEAR_MS;
};

export const snapshotEventsScopeInputSchema = z
  .object({ metricIds: metricIdListSchema, ...windowFields })
  .strict()
  .refine(windowRefine, {
    message: "Window must be positive and at most 365 days",
  });

export const snapshotCampaignValuesScopeInputSchema = z
  .object({
    conversionMetricId: z.string().min(1).max(256).regex(METRIC_ID_PATTERN),
    ...windowFields,
  })
  .strict()
  .refine(windowRefine, {
    message: "Window must be positive and at most 365 days",
  });

/**
 * The canonical resolved request scope of a snapshot run. Server-owned; the
 * caller's equivalent spellings (metric order, timezone offsets) collapse
 * onto one identity.
 */
export type KlaviyoSnapshotResolvedScope =
  | { dataset: "campaigns" }
  | { dataset: "metrics" }
  | {
      dataset: "events";
      metricIds: string[];
      since: string;
      until: string;
    }
  | {
      dataset: "campaign_values";
      conversionMetricId: string;
      since: string;
      until: string;
    };

/** Klaviyo report wall-clock encoding: Z is syntax, not a UTC assertion. */
export function snapshotReportProviderWindow(scope: { since: string; until: string }, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const start = Date.parse(scope.since), end = Date.parse(scope.until);
  const wall = (ms: number) => {
    const parts = formatter.formatToParts(new Date(ms));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
    const fraction = ms % 1000 ? `.${String(ms % 1000).padStart(3, "0")}` : "";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${fraction}Z`;
  };
  const result = { start: wall(start), end: wall(Math.max(start, Math.ceil(end / 1000) * 1000 - 1000)) };
  if (Date.parse(result.end) < Date.parse(result.start)) throw new Error("Unrepresentable snapshot report window");
  return result;
}

export function canonicalInstant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid snapshot instant");
  return new Date(ms).toISOString();
}

/** Canonicalize caller/definition scope spelling into the stored identity. */
export function canonicalizeSnapshotScope(
  scope: KlaviyoSnapshotResolvedScope,
): KlaviyoSnapshotResolvedScope {
  switch (scope.dataset) {
    case "campaigns":
    case "metrics":
      return { dataset: scope.dataset };
    case "events": {
      const parsed = snapshotEventsScopeInputSchema.parse({
        metricIds: [...scope.metricIds].sort(),
        since: canonicalInstant(scope.since),
        until: canonicalInstant(scope.until),
      });
      return {
        dataset: "events",
        metricIds: parsed.metricIds,
        since: parsed.since,
        until: parsed.until,
      };
    }
    case "campaign_values": {
      const parsed = snapshotCampaignValuesScopeInputSchema.parse({
        conversionMetricId: scope.conversionMetricId,
        since: canonicalInstant(scope.since),
        until: canonicalInstant(scope.until),
      });
      return {
        dataset: "campaign_values",
        conversionMetricId: parsed.conversionMetricId,
        since: parsed.since,
        until: parsed.until,
      };
    }
  }
}

/**
 * Deterministic JSON serialization (recursively sorted object keys) used
 * for stable content digests across snapshots and replays.
 */
export function canonicalSnapshotJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSnapshotJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${canonicalSnapshotJson(entryValue)}`,
    )
    .join(",")}}`;
}

export function snapshotScopeFingerprint(
  scope: KlaviyoSnapshotResolvedScope,
): string {
  const canonical = canonicalizeSnapshotScope(scope);
  const identity =
    canonical.dataset === "campaigns" || canonical.dataset === "metrics"
      ? [canonical.dataset]
      : canonical.dataset === "events"
        ? [canonical.dataset, canonical.metricIds, canonical.since, canonical.until]
        : [
            canonical.dataset,
            canonical.conversionMetricId,
            canonical.since,
            canonical.until,
          ];
  return createHash("sha256")
    .update(JSON.stringify(["klaviyo-snapshot-scope-v1", identity]))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Durable checkpoints
// ---------------------------------------------------------------------------

/**
 * Durable per-run collection position. `continuation` is the reviewed
 * provider adapter's opaque traversal state — worker-only, never exposed
 * through any API. It is `null` before the first page; a `null` value with
 * `page > 0` means every known page/chain has been collected and the run
 * is ready to publish. Campaign values never carry a continuation (one
 * bounded response by provider contract). Volume meters live on the run
 * row, not the position.
 */
export type KlaviyoSnapshotCheckpoint = {
  dataset: KlaviyoSnapshotDataset;
  continuation: string | null;
  page: number;
};

const continuationShape = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/);

const checkpointShape = z
  .object({
    dataset: z.enum(KLAVIYO_SNAPSHOT_DATASETS),
    continuation: continuationShape.nullable(),
    page: z.number().int().min(0),
  })
  .strict();

export function assertExactSnapshotCheckpoint(
  value: unknown,
): asserts value is KlaviyoSnapshotCheckpoint {
  const parsed = checkpointShape.safeParse(value);
  if (!parsed.success) {
    throw new Error("Klaviyo snapshot checkpoint is malformed");
  }
  const checkpoint = parsed.data;
  if (
    (checkpoint.page === 0 && checkpoint.continuation !== null) ||
    (checkpoint.dataset === "campaign_values" &&
      (checkpoint.continuation !== null || checkpoint.page > 1))
  ) {
    throw new Error("Klaviyo snapshot checkpoint is malformed");
  }
}

export function initialSnapshotCheckpoint(
  dataset: KlaviyoSnapshotDataset,
): KlaviyoSnapshotCheckpoint {
  return { dataset, continuation: null, page: 0 };
}

export function snapshotCheckpointComplete(
  checkpoint: KlaviyoSnapshotCheckpoint,
): boolean {
  return checkpoint.continuation === null && checkpoint.page > 0;
}

// ---------------------------------------------------------------------------
// Staged records (collector → store page commits)
// ---------------------------------------------------------------------------

export type KlaviyoStagedSnapshotRecord = {
  resourceKind: KlaviyoSnapshotResourceKind;
  providerIdentity: string;
  orderingKey: string;
  content: Record<string, unknown>;
  profileId?: string | null;
  metricId?: string | null;
  eventDatetime?: string | null;
  /**
   * Identity material for identifiable event records, derived transiently
   * from the page's sparse profile email. Absent for non-identifiable
   * (profile-less) events and every other resource kind.
   */
  identity?: {
    keyVersion: string;
    emailDigest: string;
    profileDigest: string;
  };
};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const KLAVIYO_SNAPSHOT_MAX_PAGES_PER_BATCH = 5;
export const KLAVIYO_SNAPSHOT_MAX_PAGES_PER_RUN = 20_000;
export const KLAVIYO_SNAPSHOT_MAX_RECORDS_PER_RUN = 100_000;
export const KLAVIYO_SNAPSHOT_MAX_RUN_BYTES = 256 * 1024 * 1024;
export const KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS = 6 * 60 * 60 * 1000;
export const KLAVIYO_SNAPSHOT_READ_PAGE_SIZE = 200;
export const KLAVIYO_SNAPSHOT_FRESHNESS_TARGET_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixed, safe error codes (never carry provider data)
// ---------------------------------------------------------------------------

export const KLAVIYO_SNAPSHOT_ERRORS = {
  failed: {
    code: "KLAVIYO_SNAPSHOT_FAILED",
    message: "Klaviyo snapshot refresh did not complete",
  },
  leaseExpired: {
    code: "KLAVIYO_SNAPSHOT_LEASE_EXPIRED",
    message: "Klaviyo snapshot task lease expired before completion",
  },
  retriesExhausted: {
    code: "KLAVIYO_SNAPSHOT_RETRIES_EXHAUSTED",
    message: "Klaviyo snapshot task retries were exhausted",
  },
  incomplete: {
    code: "KLAVIYO_SNAPSHOT_INCOMPLETE",
    message:
      "Klaviyo reported additional data that cannot be collected; the prior published snapshot was kept",
  },
  limitExceeded: {
    code: "KLAVIYO_SNAPSHOT_LIMIT_EXCEEDED",
    message: "Klaviyo snapshot run exceeded a page, record, byte or time bound",
  },
  privacyUnresolved: {
    code: "KLAVIYO_SNAPSHOT_PRIVACY_UNRESOLVED",
    message:
      "Klaviyo snapshot event identity could not be resolved for privacy erasure; the refresh was not published",
  },
  superseded: {
    code: "KLAVIYO_SNAPSHOT_SUPERSEDED",
    message:
      "A newer snapshot publication owns this scope; the older collection was not published",
  },
} as const;

export type KlaviyoSnapshotErrorCode = keyof typeof KLAVIYO_SNAPSHOT_ERRORS;

// ---------------------------------------------------------------------------
// Read request/response contracts
// ---------------------------------------------------------------------------

const snapshotIdSchema = z.string().min(1).max(64);
const readContinuationSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/);

export const snapshotCampaignsReadInputSchema = z
  .object({
    continuation: readContinuationSchema.optional(),
    snapshotId: snapshotIdSchema.optional(),
  })
  .strict();
export const snapshotMetricsReadInputSchema = snapshotCampaignsReadInputSchema;

export const snapshotEventsReadInputSchema = z
  .object({
    metricIds: metricIdListSchema,
    ...windowFields,
    continuation: readContinuationSchema.optional(),
    snapshotId: snapshotIdSchema.optional(),
  })
  .strict()
  .refine(windowRefine, {
    message: "Window must be positive and at most 365 days",
  });

export const snapshotCampaignValuesReadInputSchema = z
  .object({
    conversionMetricId: z.string().min(1).max(256).regex(METRIC_ID_PATTERN),
    ...windowFields,
    continuation: readContinuationSchema.optional(),
    snapshotId: snapshotIdSchema.optional(),
  })
  .strict()
  .refine(windowRefine, {
    message: "Window must be positive and at most 365 days",
  });

export type KlaviyoSnapshotReadInput =
  | (z.infer<typeof snapshotCampaignsReadInputSchema> & { dataset: "campaigns" })
  | (z.infer<typeof snapshotMetricsReadInputSchema> & { dataset: "metrics" })
  | (z.infer<typeof snapshotEventsReadInputSchema> & { dataset: "events" })
  | (z.infer<typeof snapshotCampaignValuesReadInputSchema> & {
      dataset: "campaign_values";
    });

export const KLAVIYO_SNAPSHOT_NOT_AVAILABLE_REASONS = [
  "not_configured",
  "not_synced",
  "snapshot_not_found",
  "scope_not_synced",
] as const;
export type KlaviyoSnapshotNotAvailableReason =
  (typeof KLAVIYO_SNAPSHOT_NOT_AVAILABLE_REASONS)[number];

const NOT_AVAILABLE_MESSAGES: Record<
  KlaviyoSnapshotNotAvailableReason,
  string
> = {
  not_configured:
    "The organization's Klaviyo connection is not configured and ready",
  not_synced: "No snapshot has been published for this dataset; configure and run a sync first",
  snapshot_not_found:
    "The requested snapshot does not exist for this connection and scope",
  scope_not_synced:
    "No snapshot has been published for the exact requested scope; request a sync for this scope",
};

const requiredSyncRequestSchema = z
  .object({
    dataset: z.enum(KLAVIYO_SNAPSHOT_DATASETS),
    metricIds: z.array(z.string()).optional(),
    conversionMetricId: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  })
  .strict();

export const snapshotNotAvailableSchema = z
  .object({
    state: z.literal("not_available"),
    dataset: z.enum(KLAVIYO_SNAPSHOT_DATASETS),
    reason: z.enum(KLAVIYO_SNAPSHOT_NOT_AVAILABLE_REASONS),
    message: z.string(),
    requiredSyncRequest: requiredSyncRequestSchema.nullable(),
  })
  .strict();
export type KlaviyoSnapshotNotAvailable = z.infer<
  typeof snapshotNotAvailableSchema
>;

export function buildSnapshotNotAvailable(
  dataset: KlaviyoSnapshotDataset,
  reason: KlaviyoSnapshotNotAvailableReason,
  scope?: KlaviyoSnapshotResolvedScope,
): KlaviyoSnapshotNotAvailable {
  const requiredSyncRequest =
    reason === "not_synced" || reason === "scope_not_synced"
      ? scope === undefined ||
          scope.dataset === "campaigns" ||
          scope.dataset === "metrics"
        ? { dataset }
        : scope.dataset === "events"
          ? {
              dataset,
              metricIds: scope.metricIds,
              since: scope.since,
              until: scope.until,
            }
          : {
              dataset,
              conversionMetricId: scope.conversionMetricId,
              since: scope.since,
              until: scope.until,
            }
      : null;
  return snapshotNotAvailableSchema.parse({
    state: "not_available",
    dataset,
    reason,
    message: NOT_AVAILABLE_MESSAGES[reason],
    requiredSyncRequest,
  });
}

const snapshotMetadataSchema = z
  .object({
    snapshotId: z.string(),
    dataset: z.enum(KLAVIYO_SNAPSHOT_DATASETS),
    configurationVersion: z.number().int(),
    triggerType: z.enum(["daily", "manual"]),
    apiRevision: z.string(),
    collectionInterval: z
      .object({ start: z.string(), end: z.string() })
      .strict(),
    publishedAt: z.string(),
    requestedWindow: halfOpenWindowSchema.nullable(),
    providerWindow: z
      .object({ start: z.string(), end: z.string() })
      .strict()
      .nullable(),
    timezone: z.string().nullable(),
    providerCompleteness: z.enum(["complete", "unverified"]),
    warnings: z.array(z.string().max(512)).max(16),
    freshness: z.enum(["fresh", "stale"]),
    recordCount: z.number().int().min(0),
    privacy: z
      .object({
        adjusted: z.boolean(),
        adjustedAt: z.string().nullable(),
        removedRecords: z.number().int().min(0),
      })
      .strict(),
    latestRefresh: z
      .object({
        status: z.enum(["running", "failed", "published"]),
        startedAt: z.string(),
        errorCode: z.string().nullable(),
        errorMessage: z.string().nullable(),
      })
      .nullable(),
  })
  .strict();
export type KlaviyoSnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;

const readContinuationOut = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();

export const snapshotCampaignsReadOutputSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      snapshot: snapshotMetadataSchema,
      campaigns: z.array(klaviyoCampaignRecordSchema),
      messages: z.array(klaviyoCampaignMessageRecordSchema),
      nextContinuation: readContinuationOut,
    })
    .strict(),
  snapshotNotAvailableSchema,
]);

export const snapshotMetricsReadOutputSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      snapshot: snapshotMetadataSchema,
      metrics: z.array(klaviyoMetricRecordSchema),
      nextContinuation: readContinuationOut,
    })
    .strict(),
  snapshotNotAvailableSchema,
]);

export const snapshotEventsReadOutputSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      snapshot: snapshotMetadataSchema,
      events: z.array(klaviyoEventRecordSchema),
      nextContinuation: readContinuationOut,
    })
    .strict(),
  snapshotNotAvailableSchema,
]);

export const snapshotCampaignValuesReadOutputSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("available"),
        snapshot: snapshotMetadataSchema,
        rows: z.array(klaviyoCampaignValueRecordSchema),
        nextContinuation: readContinuationOut,
      })
      .strict(),
    snapshotNotAvailableSchema,
  ],
);

/**
 * DB pagination token. Pins the exact snapshot and keyset position; never
 * contains or accepts a provider cursor/URL. Each page revalidates org,
 * dataset, request fingerprint and snapshot identity.
 */
export type KlaviyoSnapshotReadContinuation = {
  version: 1;
  snapshotId: string;
  dataset: KlaviyoSnapshotDataset;
  scopeFingerprint: string;
  position: { resourceKind: KlaviyoSnapshotResourceKind; orderingKey: string } | null;
};

export function encodeSnapshotReadContinuation(
  token: KlaviyoSnapshotReadContinuation,
): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

export function decodeSnapshotReadContinuation(
  value: string,
): KlaviyoSnapshotReadContinuation | null {
  try {
    if (value.length > 8192) return null;
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    const token = z
      .object({
        version: z.literal(1),
        snapshotId: z.string().min(1).max(64),
        dataset: z.enum(KLAVIYO_SNAPSHOT_DATASETS),
        scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        position: z
          .object({
            resourceKind: z.enum([
              "campaign",
              "campaign_message",
              "metric",
              "event",
              "campaign_value_row",
            ]),
            orderingKey: z.string().min(1).max(1024),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .parse(decoded);
    const kinds: Record<KlaviyoSnapshotDataset, KlaviyoSnapshotResourceKind[]> = {
      campaigns: ["campaign", "campaign_message"], metrics: ["metric"], events: ["event"], campaign_values: ["campaign_value_row"],
    };
    if (token.position && !kinds[token.dataset].includes(token.position.resourceKind)) return null;
    return token;
  } catch {
    return null;
  }
}
