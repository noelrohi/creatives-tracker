import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@/lib/klaviyo/types";
import {
  klaviyoConnections,
  klaviyoEvents,
  klaviyoMetrics,
  klaviyoSyncRuns,
} from "./klaviyo";
import { klaviyoEventMatchResults, klaviyoMatchRuns } from "./klaviyo-match";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const marketingObjectTypes = [
  "campaign",
  "flow",
  "campaign_message",
  "flow_message",
  "flow_message_variation",
] as const;

export const trackingSettingScopes = [
  "account",
  "campaign_message",
  "flow_message",
] as const;

export const trackingValueModes = ["static", "dynamic"] as const;

export type MarketingObjectType = (typeof marketingObjectTypes)[number];
export type TrackingSettingScope = (typeof trackingSettingScopes)[number];
export type TrackingValueMode = (typeof trackingValueModes)[number];

export const claimReplayStateStatuses = [
  "complete",
  "incomplete",
  "failed",
] as const;
export type ClaimReplayStateStatus = (typeof claimReplayStateStatuses)[number];

export const claimReplayRunStatuses = [
  "running",
  "success",
  "partial",
  "failed",
  "stale",
] as const;
export type ClaimReplayRunStatus = (typeof claimReplayRunStatuses)[number];

export const reportKinds = ["campaign", "flow"] as const;
export type ReportKind = (typeof reportKinds)[number];

export const reportGenerationStatuses = [
  "staging",
  "current",
  "failed",
  "superseded",
] as const;
export type ReportGenerationStatus = (typeof reportGenerationStatuses)[number];

/**
 * Marketing dimensions discovered from the pinned campaign/flow traversal.
 * Parent links are proven relationship IDs only; absent relationships stay
 * null rather than being inferred from names or reports.
 */
export const klaviyoMarketingObjects = pgTable(
  "klaviyo_marketing_object",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    objectType: text("object_type").$type<MarketingObjectType>().notNull(),
    externalId: text("external_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    channel: text("channel"),
    status: text("status"),
    providerCreatedAt: timestamp("provider_created_at"),
    providerUpdatedAt: timestamp("provider_updated_at"),
    trackingProjection: jsonb("tracking_projection")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
    sourceChecksum: text("source_checksum").notNull(),
    apiRevision: text("api_revision").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_marketing_object_connection_type_external_uniq").on(
      table.connectionId,
      table.objectType,
      table.externalId,
    ),
    unique("klaviyo_marketing_object_connection_id_uniq").on(
      table.connectionId,
      table.id,
    ),
    unique("klaviyo_marketing_object_connection_type_id_uniq").on(
      table.connectionId,
      table.objectType,
      table.id,
    ),
    foreignKey({
      name: "klaviyo_marketing_object_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_marketing_object_parent_fk",
      columns: [table.connectionId, table.parentId],
      foreignColumns: [table.connectionId, table.id],
    }).onDelete("cascade"),
    check(
      "klaviyo_marketing_object_type_check",
      sql`(${table.objectType})::text in ('campaign', 'flow', 'campaign_message',
        'flow_message', 'flow_message_variation')`,
    ),
    index("klaviyo_marketing_object_scope_type_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.objectType,
    ),
  ],
);

/**
 * Allowlisted UTM/tracking configuration evidence. Configuration never
 * proves a visited URL; account scope carries no marketing object, message
 * scopes require the exact matching message-object type.
 */
export const klaviyoTrackingSettings = pgTable(
  "klaviyo_tracking_setting",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    scope: text("scope").$type<TrackingSettingScope>().notNull(),
    marketingObjectId: text("marketing_object_id"),
    marketingObjectType: text("marketing_object_type")
      .$type<MarketingObjectType | null>(),
    parameterName: text("parameter_name").notNull(),
    valueMode: text("value_mode").$type<TrackingValueMode>().notNull(),
    sanitizedValue: text("sanitized_value"),
    enabled: integer("enabled").notNull().default(1),
    apiRevision: text("api_revision").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("klaviyo_tracking_setting_scope_param_uidx").on(
      table.connectionId,
      table.scope,
      sql`coalesce(${table.marketingObjectId}, '')`,
      table.parameterName,
    ),
    foreignKey({
      name: "klaviyo_tracking_setting_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_tracking_setting_object_fk",
      columns: [
        table.connectionId,
        table.marketingObjectType,
        table.marketingObjectId,
      ],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.objectType,
        klaviyoMarketingObjects.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_tracking_setting_scope_check",
      sql`(${table.scope})::text in ('account', 'campaign_message', 'flow_message')`,
    ),
    check(
      "klaviyo_tracking_setting_value_mode_check",
      sql`(${table.valueMode})::text in ('static', 'dynamic')`,
    ),
    check(
      "klaviyo_tracking_setting_enabled_check",
      sql`${table.enabled} in (0, 1)`,
    ),
    check(
      "klaviyo_tracking_setting_object_shape_check",
      sql`((${table.scope})::text = 'account'
          and ${table.marketingObjectId} is null
          and ${table.marketingObjectType} is null)
        or ((${table.scope})::text = 'campaign_message'
          and ${table.marketingObjectId} is not null
          and (${table.marketingObjectType})::text = 'campaign_message')
        or ((${table.scope})::text = 'flow_message'
          and ${table.marketingObjectId} is not null
          and (${table.marketingObjectType})::text = 'flow_message')`,
    ),
  ],
);

/**
 * Klaviyo's nullable attribution chain attached to one stored conversion
 * event. This is not Adsolute or Shopify attribution; unproven
 * relationships stay null with reason codes and are never guessed.
 */
export const klaviyoAttributionClaims = pgTable(
  "klaviyo_attribution_claim",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    conversionEventId: text("conversion_event_id").notNull(),
    klaviyoAttributionId: text("klaviyo_attribution_id").notNull(),
    attributedInteractionEventId: text("attributed_interaction_event_id"),
    attributedInteractionExternalEventId: text(
      "attributed_interaction_external_event_id",
    ),
    campaignObjectId: text("campaign_object_id"),
    flowObjectId: text("flow_object_id"),
    messageObjectId: text("message_object_id"),
    variationObjectId: text("variation_object_id"),
    externalVariationReference: text("external_variation_reference"),
    interactionType: text("interaction_type"),
    interactionOccurredAt: timestamp("interaction_occurred_at"),
    interactionChannel: text("interaction_channel"),
    interactionHost: text("interaction_host"),
    interactionPath: text("interaction_path"),
    botClick: integer("bot_click"),
    unknownReasonCodes: jsonb("unknown_reason_codes")
      .$type<string[]>()
      .notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    apiRevision: text("api_revision").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_attribution_claim_conversion_uniq").on(
      table.connectionId,
      table.conversionEventId,
      table.klaviyoAttributionId,
    ),
    foreignKey({
      name: "klaviyo_attribution_claim_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_attribution_claim_conversion_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.conversionEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_attribution_claim_interaction_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.attributedInteractionEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_attribution_claim_campaign_fk",
      columns: [table.connectionId, table.campaignObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    foreignKey({
      name: "klaviyo_attribution_claim_flow_fk",
      columns: [table.connectionId, table.flowObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    foreignKey({
      name: "klaviyo_attribution_claim_message_fk",
      columns: [table.connectionId, table.messageObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    foreignKey({
      name: "klaviyo_attribution_claim_variation_fk",
      columns: [table.connectionId, table.variationObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    check(
      "klaviyo_attribution_claim_interaction_type_check",
      sql`${table.interactionType} is null
        or ${table.interactionType} in ('click', 'open', 'delivery', 'sms')`,
    ),
    check(
      "klaviyo_attribution_claim_bot_check",
      sql`${table.botClick} is null or ${table.botClick} in (0, 1)`,
    ),
    index("klaviyo_attribution_claim_conversion_idx").on(
      table.connectionId,
      table.conversionEventId,
    ),
    index("klaviyo_attribution_claim_campaign_idx").on(
      table.connectionId,
      table.campaignObjectId,
    ),
    index("klaviyo_attribution_claim_flow_idx").on(
      table.connectionId,
      table.flowObjectId,
    ),
  ],
);

/**
 * Durable per-conversion claim freshness/incompleteness record, bound to
 * the exact source run, published match run, and current event-result
 * anchor. Contains no provider values, URLs, HMACs, or raw errors.
 */
export const klaviyoClaimReplayStates = pgTable(
  "klaviyo_claim_replay_state",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    matchRunId: text("match_run_id").notNull(),
    conversionEventId: text("conversion_event_id").notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    status: text("status").$type<ClaimReplayStateStatus>().notNull(),
    expectedClaimCount: integer("expected_claim_count").notNull().default(0),
    resolvedClaimCount: integer("resolved_claim_count").notNull().default(0),
    referencedEventFetchCount: integer("referenced_event_fetch_count")
      .notNull()
      .default(0),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
    lastAttemptClaimReplayId: text("last_attempt_claim_replay_id"),
    attemptCount: integer("attempt_count").notNull().default(1),
    attemptedAt: timestamp("attempted_at").notNull(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_claim_replay_state_scope_uniq").on(
      table.connectionId,
      table.sourceRunId,
      table.matchRunId,
      table.conversionEventId,
    ),
    foreignKey({
      name: "klaviyo_claim_replay_state_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_claim_replay_state_source_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.sourceRunId,
      ],
      foreignColumns: [
        klaviyoSyncRuns.organizationId,
        klaviyoSyncRuns.storeId,
        klaviyoSyncRuns.connectionId,
        klaviyoSyncRuns.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_claim_replay_state_match_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.matchRunId,
      ],
      foreignColumns: [
        klaviyoMatchRuns.organizationId,
        klaviyoMatchRuns.storeId,
        klaviyoMatchRuns.connectionId,
        klaviyoMatchRuns.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_claim_replay_state_conversion_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.conversionEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_claim_replay_state_result_anchor_fk",
      columns: [table.matchRunId, table.conversionEventId],
      foreignColumns: [
        klaviyoEventMatchResults.runId,
        klaviyoEventMatchResults.eventId,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_claim_replay_state_status_check",
      sql`(${table.status})::text in ('complete', 'incomplete', 'failed')`,
    ),
    check(
      "klaviyo_claim_replay_state_counts_check",
      sql`${table.expectedClaimCount} >= 0
        and ${table.resolvedClaimCount} >= 0
        and ${table.referencedEventFetchCount} >= 0
        and ${table.attemptCount} >= 1`,
    ),
    check(
      "klaviyo_claim_replay_state_completion_check",
      sql`(${table.status})::text <> 'complete' or ${table.completedAt} is not null`,
    ),
    index("klaviyo_claim_replay_state_match_run_idx").on(
      table.connectionId,
      table.matchRunId,
      table.status,
    ),
  ],
);

/**
 * One live claim replay graph per connection: durable checkpoint, lease,
 * and terminal status authority for bounded claim batches. The checkpoint
 * carries only internal row IDs/times — never provider cursors, event IDs,
 * profiles, or secrets. Graph deletion never cascades the durable
 * per-conversion state above.
 */
export const klaviyoClaimReplayRuns = pgTable(
  "klaviyo_claim_replay_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    matchRunId: text("match_run_id").notNull(),
    checkpoint: jsonb("checkpoint").$type<Record<string, JsonValue> | null>(),
    status: text("status").$type<ClaimReplayRunStatus>().notNull(),
    conversionsComplete: integer("conversions_complete").notNull().default(0),
    conversionsIncomplete: integer("conversions_incomplete")
      .notNull()
      .default(0),
    conversionsFailed: integer("conversions_failed").notNull().default(0),
    supersededSkipped: integer("superseded_skipped").notNull().default(0),
    failureCode: text("failure_code"),
    currentTriggerRunId: text("current_trigger_run_id"),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_claim_replay_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    uniqueIndex("klaviyo_claim_replay_run_one_running_uidx")
      .on(table.connectionId)
      .where(sql`${table.status} = 'running'`),
    foreignKey({
      name: "klaviyo_claim_replay_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_claim_replay_run_source_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.sourceRunId,
      ],
      foreignColumns: [
        klaviyoSyncRuns.organizationId,
        klaviyoSyncRuns.storeId,
        klaviyoSyncRuns.connectionId,
        klaviyoSyncRuns.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_claim_replay_run_match_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.matchRunId,
      ],
      foreignColumns: [
        klaviyoMatchRuns.organizationId,
        klaviyoMatchRuns.storeId,
        klaviyoMatchRuns.connectionId,
        klaviyoMatchRuns.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_claim_replay_run_status_check",
      sql`(${table.status})::text in ('running', 'success', 'partial', 'failed', 'stale')`,
    ),
    check(
      "klaviyo_claim_replay_run_terminal_shape_check",
      sql`((${table.status})::text = 'running' and ${table.finishedAt} is null)
        or ((${table.status})::text <> 'running' and ${table.finishedAt} is not null)`,
    ),
    check(
      "klaviyo_claim_replay_run_failure_shape_check",
      sql`(${table.status})::text <> 'failed' or ${table.failureCode} is not null`,
    ),
    check(
      "klaviyo_claim_replay_run_counts_check",
      sql`${table.conversionsComplete} >= 0
        and ${table.conversionsIncomplete} >= 0
        and ${table.conversionsFailed} >= 0
        and ${table.supersededSkipped} >= 0`,
    ),
    index("klaviyo_claim_replay_run_scope_started_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.startedAt,
    ),
  ],
);

/**
 * One staging/current/superseded generation per report kind under a
 * scoped `reports` sync run. The publication-scope fingerprint identifies
 * the one logical current slot; the refresh fingerprint adds `asOf`.
 */
export const klaviyoReportGenerations = pgTable(
  "klaviyo_report_generation",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    syncRunId: text("sync_run_id").notNull(),
    kind: text("kind").$type<ReportKind>().notNull(),
    requestedFrom: timestamp("requested_from").notNull(),
    requestedTo: timestamp("requested_to").notNull(),
    accountTimezone: text("account_timezone").notNull(),
    publicationScopeFingerprint: text("publication_scope_fingerprint")
      .notNull(),
    refreshFingerprint: text("refresh_fingerprint").notNull(),
    status: text("status").$type<ReportGenerationStatus>().notNull(),
    factCount: integer("fact_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    publishedAt: timestamp("published_at"),
    supersededAt: timestamp("superseded_at"),
  },
  (table) => [
    unique("klaviyo_report_generation_run_kind_uniq").on(
      table.syncRunId,
      table.kind,
    ),
    unique("klaviyo_report_generation_connection_id_uniq").on(
      table.connectionId,
      table.id,
    ),
    unique("klaviyo_report_generation_connection_kind_id_uniq").on(
      table.connectionId,
      table.kind,
      table.id,
    ),
    uniqueIndex("klaviyo_report_generation_current_uidx")
      .on(table.connectionId, table.publicationScopeFingerprint)
      .where(sql`${table.status} = 'current'`),
    foreignKey({
      name: "klaviyo_report_generation_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_report_generation_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.syncRunId,
      ],
      foreignColumns: [
        klaviyoSyncRuns.organizationId,
        klaviyoSyncRuns.storeId,
        klaviyoSyncRuns.connectionId,
        klaviyoSyncRuns.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_report_generation_kind_check",
      sql`(${table.kind})::text in ('campaign', 'flow')`,
    ),
    check(
      "klaviyo_report_generation_status_check",
      sql`(${table.status})::text in ('staging', 'current', 'failed', 'superseded')`,
    ),
    check(
      "klaviyo_report_generation_status_shape_check",
      sql`((${table.status})::text = 'staging'
          and ${table.publishedAt} is null and ${table.supersededAt} is null)
        or ((${table.status})::text = 'failed' and ${table.supersededAt} is null)
        or ((${table.status})::text = 'current'
          and ${table.publishedAt} is not null and ${table.supersededAt} is null)
        or ((${table.status})::text = 'superseded'
          and ${table.publishedAt} is not null and ${table.supersededAt} is not null)`,
    ),
    check(
      "klaviyo_report_generation_window_check",
      sql`${table.requestedFrom} < ${table.requestedTo}`,
    ),
    check(
      "klaviyo_report_generation_fact_count_check",
      sql`${table.factCount} >= 0`,
    ),
    index("klaviyo_report_generation_slot_idx").on(
      table.connectionId,
      table.publicationScopeFingerprint,
      table.status,
    ),
  ],
);

/**
 * Aggregate report facts with Klaviyo account-timezone/send-date
 * semantics. Matcher-inaccessible by design: no event/order/match table
 * references this table, and its values never enter claim chains.
 */
export const klaviyoReportFacts = pgTable(
  "klaviyo_report_fact",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    generationId: text("generation_id").notNull(),
    reportKind: text("report_kind").$type<ReportKind>().notNull(),
    conversionMetricId: text("conversion_metric_id").notNull(),
    campaignObjectId: text("campaign_object_id"),
    flowObjectId: text("flow_object_id"),
    messageObjectId: text("message_object_id"),
    requestedFrom: timestamp("requested_from").notNull(),
    requestedTo: timestamp("requested_to").notNull(),
    accountTimezone: text("account_timezone").notNull(),
    grouping: jsonb("grouping").$type<Record<string, JsonValue>>().notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    factFingerprint: text("fact_fingerprint").notNull(),
    conversions: numeric("conversions"),
    conversionValue: numeric("conversion_value"),
    recipients: numeric("recipients"),
    uniqueClicks: numeric("unique_clicks"),
    uniqueOpens: numeric("unique_opens"),
    additionalStatistics: jsonb("additional_statistics")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
    apiRevision: text("api_revision").notNull(),
    asOf: timestamp("as_of").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_report_fact_generation_fact_uniq").on(
      table.generationId,
      table.factFingerprint,
    ),
    foreignKey({
      name: "klaviyo_report_fact_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_report_fact_generation_fk",
      columns: [table.connectionId, table.reportKind, table.generationId],
      foreignColumns: [
        klaviyoReportGenerations.connectionId,
        klaviyoReportGenerations.kind,
        klaviyoReportGenerations.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_report_fact_metric_fk",
      columns: [table.connectionId, table.conversionMetricId],
      foreignColumns: [klaviyoMetrics.connectionId, klaviyoMetrics.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_report_fact_campaign_fk",
      columns: [table.connectionId, table.campaignObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    foreignKey({
      name: "klaviyo_report_fact_flow_fk",
      columns: [table.connectionId, table.flowObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    foreignKey({
      name: "klaviyo_report_fact_message_fk",
      columns: [table.connectionId, table.messageObjectId],
      foreignColumns: [
        klaviyoMarketingObjects.connectionId,
        klaviyoMarketingObjects.id,
      ],
    }),
    check(
      "klaviyo_report_fact_kind_check",
      sql`(${table.reportKind})::text in ('campaign', 'flow')`,
    ),
    check(
      "klaviyo_report_fact_window_check",
      sql`${table.requestedFrom} < ${table.requestedTo}`,
    ),
    index("klaviyo_report_fact_range_idx").on(
      table.connectionId,
      table.reportKind,
      table.requestedFrom,
      table.requestedTo,
    ),
    index("klaviyo_report_fact_request_idx").on(
      table.connectionId,
      table.requestFingerprint,
    ),
    index("klaviyo_report_fact_campaign_idx").on(
      table.connectionId,
      table.campaignObjectId,
    ),
    index("klaviyo_report_fact_flow_idx").on(
      table.connectionId,
      table.flowObjectId,
    ),
  ],
);
