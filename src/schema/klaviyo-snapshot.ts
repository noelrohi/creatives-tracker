import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { klaviyoConnections } from "./klaviyo";
import type {
  KlaviyoSnapshotResolvedScope,
  KlaviyoSnapshotCheckpoint,
} from "@/lib/klaviyo/snapshot-contracts";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/**
 * Versioned snapshot storage for the four OpenAPI Klaviyo reads. These
 * tables are a new durable storage purpose, deliberately separate from the
 * attribution-facing evidence tables: they hold reviewed source-data
 * versions only, never a second general connector platform. Nothing here
 * references `klaviyo_sync_run`; snapshot history outlives short-lived sync
 * runs and cascades only from the connection (uninstall).
 */
export const klaviyoSnapshotDefinitions = pgTable(
  "klaviyo_snapshot_definition",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    dataset: text("dataset").notNull(),
    dailyEnabled: integer("daily_enabled").notNull().default(0),
    configurationVersion: integer("configuration_version").notNull().default(1),
    windowMode: text("window_mode").notNull().default("rolling_days"),
    rollingDays: integer("rolling_days"),
    fixedFrom: timestamp("fixed_from"),
    fixedTo: timestamp("fixed_to"),
    timezone: text("timezone").notNull().default("UTC"),
    selectedMetricIds: jsonb("selected_metric_ids").$type<string[]>(),
    conversionMetricId: text("conversion_metric_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_snapshot_definition_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_snapshot_definition_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
      table.dataset,
    ),
    unique("klaviyo_snapshot_definition_dataset_uniq").on(
      table.connectionId,
      table.dataset,
    ),
    check(
      "klaviyo_snapshot_definition_dataset_check",
      sql`${table.dataset} in ('campaigns', 'metrics', 'events', 'campaign_values')`,
    ),
    check(
      "klaviyo_snapshot_definition_daily_check",
      sql`${table.dailyEnabled} in (0, 1)`,
    ),
    check(
      "klaviyo_snapshot_definition_window_mode_check",
      sql`${table.windowMode} in ('rolling_days', 'fixed')`,
    ),
    check(
      "klaviyo_snapshot_definition_rolling_days_check",
      sql`(${table.windowMode} <> 'rolling_days')
        or (${table.rollingDays} is not null and ${table.rollingDays} between 1 and 365
          and ${table.fixedFrom} is null and ${table.fixedTo} is null)`,
    ),
    check(
      "klaviyo_snapshot_definition_fixed_pair_check",
      sql`(${table.windowMode} <> 'fixed')
        or (${table.fixedFrom} is not null and ${table.fixedTo} is not null
          and ${table.fixedFrom} < ${table.fixedTo} and ${table.rollingDays} is null)`,
    ),
    check("klaviyo_snapshot_definition_config_check", sql`
      ${table.configurationVersion} > 0 and
      ((${table.dataset} = 'events' and ${table.selectedMetricIds} is not null
         and jsonb_typeof(${table.selectedMetricIds}) = 'array'
         and jsonb_array_length(${table.selectedMetricIds}) between 1 and 20
         and ${table.conversionMetricId} is null)
       or (${table.dataset} = 'campaign_values' and ${table.conversionMetricId} is not null
         and ${table.selectedMetricIds} is null)
       or (${table.dataset} in ('campaigns', 'metrics') and ${table.selectedMetricIds} is null
         and ${table.conversionMetricId} is null))`,
    ),
  ],
);

export const klaviyoSnapshotRuns = pgTable(
  "klaviyo_snapshot_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    definitionId: text("definition_id"),
    dataset: text("dataset").notNull(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    resolvedScope: jsonb("resolved_scope")
      .$type<KlaviyoSnapshotResolvedScope>()
      .notNull(),
    configurationVersion: integer("configuration_version").notNull(),
    triggerType: text("trigger_type").notNull(),
    state: text("state").notNull().default("running"),
    isCurrent: integer("is_current").notNull().default(0),
    leaseToken: text("lease_token").notNull(),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    checkpoint: jsonb("checkpoint").$type<KlaviyoSnapshotCheckpoint | null>(),
    apiRevision: text("api_revision").notNull(),
    schemaRevision: integer("schema_revision").notNull().default(1),
    accountId: text("account_id").notNull(),
    leaseOwner: text("lease_owner"),
    requestedFrom: timestamp("requested_from"),
    requestedTo: timestamp("requested_to"),
    providerWindowStart: text("provider_window_start"),
    providerWindowEnd: text("provider_window_end"),
    timezone: text("timezone"),
    anchorAt: timestamp("anchor_at"),
    pageCount: integer("page_count").notNull().default(0),
    recordCount: integer("record_count").notNull().default(0),
    bytesStaged: integer("bytes_staged").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    providerCompleteness: text("provider_completeness"),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    privacyAdjusted: integer("privacy_adjusted").notNull().default(0),
    privacyAdjustedAt: timestamp("privacy_adjusted_at"),
    privacyRemovedCount: integer("privacy_removed_count").notNull().default(0),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    publishedAt: timestamp("published_at"),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_snapshot_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_snapshot_run_definition_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.definitionId,
        table.dataset,
      ],
      foreignColumns: [
        klaviyoSnapshotDefinitions.organizationId,
        klaviyoSnapshotDefinitions.storeId,
        klaviyoSnapshotDefinitions.connectionId,
        klaviyoSnapshotDefinitions.id,
        klaviyoSnapshotDefinitions.dataset,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_snapshot_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    unique("klaviyo_snapshot_run_scope_fingerprint_uniq").on(
      table.connectionId,
      table.dataset,
      table.scopeFingerprint,
      table.id,
    ),
    check(
      "klaviyo_snapshot_run_dataset_check",
      sql`${table.dataset} in ('campaigns', 'metrics', 'events', 'campaign_values')`,
    ),
    check(
      "klaviyo_snapshot_run_trigger_type_check",
      sql`${table.triggerType} in ('daily', 'manual')`,
    ),
    check(
      "klaviyo_snapshot_run_state_check",
      sql`${table.state} in ('running', 'published', 'failed')`,
    ),
    check(
      "klaviyo_snapshot_run_current_check",
      sql`${table.isCurrent} in (0, 1) and (${table.isCurrent} = 0 or ${table.state} = 'published')`,
    ),
    check(
      "klaviyo_snapshot_run_published_checkpoint_check",
      sql`(${table.state} <> 'published' or ${table.checkpoint} is null)
        and (${table.state} <> 'running' or (${table.checkpoint} is not null
          and coalesce(${table.checkpoint}->>'dataset' = ${table.dataset}, false)))`,
    ),
    check(
      "klaviyo_snapshot_run_privacy_check",
      sql`${table.privacyAdjusted} in (0, 1) and (${table.privacyRemovedCount} >= 0)`,
    ),
    check(
      "klaviyo_snapshot_run_provider_completeness_check",
      sql`${table.providerCompleteness} is null
        or ${table.providerCompleteness} in ('complete', 'unverified')`,
    ),
    check(
      "klaviyo_snapshot_run_counts_check",
      sql`${table.pageCount} >= 0 and ${table.recordCount} >= 0
        and ${table.bytesStaged} >= 0 and ${table.suppressedCount} >= 0`,
    ),
    check(
      "klaviyo_snapshot_run_publish_state_check",
      sql`(${table.state} <> 'published')
        or (${table.publishedAt} is not null and ${table.finishedAt} is not null)`,
    ),
    check(
      "klaviyo_snapshot_run_scope_shape_check",
      sql`${table.configurationVersion} >= 0 and ${table.schemaRevision} = 1 and
        coalesce(${table.resolvedScope}->>'dataset' = ${table.dataset}, false) and
        ((${table.dataset} in ('campaigns','metrics') and ${table.requestedFrom} is null
          and ${table.requestedTo} is null)
         or (${table.dataset} in ('events','campaign_values') and ${table.requestedFrom} is not null
          and ${table.requestedTo} is not null and ${table.requestedFrom} < ${table.requestedTo}
          and ${table.anchorAt} is not null))`,
    ),
    // Exactly one live collection per exact publication scope.
    uniqueIndex("klaviyo_snapshot_run_one_running_uidx")
      .on(table.connectionId, table.dataset, table.scopeFingerprint)
      .where(sql`${table.state} = 'running'`),
    // The transactional one-current-snapshot constraint per exact scope.
    uniqueIndex("klaviyo_snapshot_run_one_current_uidx")
      .on(table.connectionId, table.dataset, table.scopeFingerprint)
      .where(sql`${table.state} = 'published' and ${table.isCurrent} = 1`),
    index("klaviyo_snapshot_run_scope_history_idx").on(
      table.connectionId,
      table.dataset,
      table.scopeFingerprint,
      table.state,
      table.publishedAt,
    ),
    index("klaviyo_snapshot_run_connection_state_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.dataset,
      table.state,
      table.startedAt,
    ),
  ],
);

/**
 * Connection-scoped immutable content versions. Identical reviewed payloads
 * share one row across snapshots instead of duplicating the event payload
 * per observation. Privacy erasure removes versions together with every
 * referencing record.
 */
export const klaviyoSnapshotContents = pgTable(
  "klaviyo_snapshot_content",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    resourceKind: text("resource_kind").notNull(),
    contentDigest: text("content_digest").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_snapshot_content_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_snapshot_content_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
      table.resourceKind,
    ),
    unique("klaviyo_snapshot_content_identity_uniq").on(
      table.connectionId,
      table.resourceKind,
      table.contentDigest,
    ),
    check("klaviyo_snapshot_content_payload_check", sql`
      ${table.contentDigest} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${table.content}) = 'object'`),
    check(
      "klaviyo_snapshot_content_kind_check",
      sql`${table.resourceKind} in (
        'campaign', 'campaign_message', 'metric', 'event', 'campaign_value_row'
      )`,
    ),
  ],
);

export const klaviyoSnapshotRecords = pgTable(
  "klaviyo_snapshot_record",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    snapshotRunId: text("snapshot_run_id").notNull(),
    contentId: text("content_id").notNull(),
    resourceKind: text("resource_kind").notNull(),
    providerIdentity: text("provider_identity").notNull(),
    orderingKey: text("ordering_key").notNull(),
    profileId: text("profile_id"),
    metricId: text("metric_id"),
    eventDatetime: timestamp("event_datetime"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_snapshot_record_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_snapshot_record_run_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.snapshotRunId,
      ],
      foreignColumns: [
        klaviyoSnapshotRuns.organizationId,
        klaviyoSnapshotRuns.storeId,
        klaviyoSnapshotRuns.connectionId,
        klaviyoSnapshotRuns.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_snapshot_record_content_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.contentId,
        table.resourceKind,
      ],
      foreignColumns: [
        klaviyoSnapshotContents.organizationId,
        klaviyoSnapshotContents.storeId,
        klaviyoSnapshotContents.connectionId,
        klaviyoSnapshotContents.id,
        klaviyoSnapshotContents.resourceKind,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_snapshot_record_identity_uniq").on(
      table.snapshotRunId,
      table.resourceKind,
      table.providerIdentity,
    ),
    unique("klaviyo_snapshot_record_ordering_uniq").on(
      table.snapshotRunId,
      table.resourceKind,
      table.orderingKey,
    ),
    check(
      "klaviyo_snapshot_record_kind_check",
      sql`${table.resourceKind} in (
        'campaign', 'campaign_message', 'metric', 'event', 'campaign_value_row'
      )`,
    ),
    index("klaviyo_snapshot_record_content_idx").on(table.contentId),
    check("klaviyo_snapshot_record_event_check", sql`
      (${table.resourceKind} = 'event' and ${table.metricId} is not null and ${table.eventDatetime} is not null)
      or (${table.resourceKind} <> 'event' and ${table.profileId} is null
        and ${table.metricId} is null and ${table.eventDatetime} is null)`),
    index("klaviyo_snapshot_record_profile_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.profileId,
    ),
    index("klaviyo_snapshot_record_metric_time_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.metricId,
      table.eventDatetime,
    ),
  ],
);

/**
 * Private identity associations: connection-scoped profile IDs observed with
 * a versioned email-suppression HMAC, independent of canonical event FKs.
 * Privacy-maintenance metadata only — never part of OpenAPI record output,
 * never carrying plaintext email. Previously observed associations are
 * retained while referenced history survives so a profile email change
 * cannot make old snapshots uneraseable.
 */
export const klaviyoSnapshotProfileSuppressions = pgTable(
  "klaviyo_snapshot_profile_suppression",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    profileId: text("profile_id").notNull(),
    keyVersion: text("key_version").notNull(),
    digest: text("digest").notNull(),
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_snapshot_profile_suppression_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_snapshot_profile_suppression_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    check("klaviyo_snapshot_profile_suppression_digest_check", sql`
      ${table.digest} ~ '^[A-Za-z0-9_-]{43}$' and ${table.keyVersion} ~ '^[A-Za-z0-9._-]{1,64}$'`),
    unique("klaviyo_snapshot_profile_suppression_identity_uniq").on(
      table.connectionId,
      table.profileId,
      table.keyVersion,
      table.digest,
    ),
    index("klaviyo_snapshot_profile_suppression_digest_idx").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.digest,
    ),
    index("klaviyo_snapshot_profile_suppression_profile_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.profileId,
    ),
  ],
);
