import { relations, sql } from "drizzle-orm";
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
import { organization } from "./auth";
import { identityMatchingKeyBindings } from "@/schema/identity-registry";
import { shopifyStores } from "./shopify";
import type {
  JsonValue,
  KlaviyoEventAliasField,
  KlaviyoEventCheckpoint,
  KlaviyoMetricKind,
  PropertyFingerprintEntry,
  RedactedProbeExample,
} from "@/lib/klaviyo/types";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const klaviyoConnections = pgTable(
  "klaviyo_connection",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    storeId: text("shopify_store_id").notNull(),
    klaviyoAccountId: text("klaviyo_account_id"),
    accountName: text("account_name"),
    timezone: text("timezone"),
    currency: text("currency"),
    status: text("status").notNull().default("pending"),
    authenticationMode: text("authentication_mode")
      .notNull()
      .default("environment"),
    credentialReference: text("credential_reference")
      .notNull()
      .default("reviv_environment"),
    lastDiscoverySyncedAt: timestamp("last_discovery_synced_at"),
    lastEventSyncedAt: timestamp("last_event_synced_at"),
    lastReportSyncedAt: timestamp("last_report_synced_at"),
    identityWriteMode: text("identity_write_mode")
      .notNull()
      .default("current_only"),
    identityCurrentKeyVersion: text("identity_current_key_version"),
    identityCurrentKeyCheck: text("identity_current_key_check"),
    identityPreviousKeyVersion: text("identity_previous_key_version"),
    identityPreviousKeyCheck: text("identity_previous_key_check"),
    initialSourceFrom: timestamp("initial_source_from"),
    initialSourceTo: timestamp("initial_source_to"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("klaviyo_connection_org_store_uniq").on(
      table.organizationId,
      table.storeId,
    ),
    unique("klaviyo_connection_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    uniqueIndex("klaviyo_connection_active_account_uidx")
      .on(table.klaviyoAccountId)
      .where(
        sql`${table.klaviyoAccountId} is not null and ${table.status} <> 'disabled'`,
      ),
    foreignKey({
      name: "klaviyo_connection_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    check(
      "klaviyo_connection_status_check",
      sql`${table.status} in ('pending', 'ready', 'degraded', 'disabled')`,
    ),
    check(
      "klaviyo_connection_auth_mode_check",
      sql`${table.authenticationMode} = 'environment'`,
    ),
    check(
      "klaviyo_connection_credential_ref_check",
      sql`${table.credentialReference} = 'reviv_environment'`,
    ),
    check(
      "klaviyo_connection_identity_write_mode_check",
      sql`${table.identityWriteMode} in ('current_only', 'dual')`,
    ),
    check(
      "klaviyo_connection_identity_current_pair_check",
      sql`(${table.identityCurrentKeyVersion} is null and ${table.identityCurrentKeyCheck} is null)
        or (${table.identityCurrentKeyVersion} is not null and ${table.identityCurrentKeyCheck} is not null)`,
    ),
    check(
      "klaviyo_connection_identity_previous_pair_check",
      sql`(${table.identityPreviousKeyVersion} is null and ${table.identityPreviousKeyCheck} is null)
        or (${table.identityPreviousKeyVersion} is not null and ${table.identityPreviousKeyCheck} is not null)`,
    ),
    check(
      "klaviyo_connection_identity_gate_shape_check",
      sql`(${table.identityWriteMode} = 'current_only' and ${table.identityPreviousKeyVersion} is null)
        or (${table.identityWriteMode} = 'dual'
          and ${table.identityCurrentKeyVersion} is not null
          and ${table.identityPreviousKeyVersion} is not null
          and ${table.identityCurrentKeyVersion} <> ${table.identityPreviousKeyVersion}
          and ${table.identityCurrentKeyCheck} <> ${table.identityPreviousKeyCheck})`,
    ),
    foreignKey({
      name: "klaviyo_connection_identity_current_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.identityCurrentKeyVersion,
        table.identityCurrentKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    foreignKey({
      name: "klaviyo_connection_identity_previous_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.identityPreviousKeyVersion,
        table.identityPreviousKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    check(
      "klaviyo_connection_initial_source_window_check",
      sql`(${table.initialSourceFrom} is null and ${table.initialSourceTo} is null)
        or (${table.initialSourceFrom} is not null and ${table.initialSourceTo} is not null
          and ${table.initialSourceFrom} < ${table.initialSourceTo})`,
    ),
  ],
);

export const klaviyoMetrics = pgTable(
  "klaviyo_metric",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    externalMetricId: text("external_metric_id").notNull(),
    name: text("name").notNull(),
    integrationName: text("integration_name"),
    integrationCategory: text("integration_category"),
    canonicalKind: text("canonical_kind").$type<KlaviyoMetricKind>(),
    ingestionEnabled: integer("ingestion_enabled").notNull().default(0),
    apiRevision: text("api_revision").notNull(),
    discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_metric_connection_external_uniq").on(
      table.connectionId,
      table.externalMetricId,
    ),
    unique("klaviyo_metric_connection_id_uniq").on(
      table.connectionId,
      table.id,
    ),
    uniqueIndex("klaviyo_metric_enabled_kind_uidx")
      .on(table.connectionId, table.canonicalKind)
      .where(
        sql`${table.canonicalKind} is not null and ${table.ingestionEnabled} = 1`,
      ),
    foreignKey({
      name: "klaviyo_metric_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    index("klaviyo_metric_scope_kind_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.canonicalKind,
    ),
  ],
);

export const klaviyoSyncRuns = pgTable(
  "klaviyo_sync_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    operation: text("operation").notNull(),
    triggerType: text("trigger_type").notNull(),
    requestParameters: jsonb("request_parameters")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
    requestedFrom: timestamp("requested_from"),
    requestedTo: timestamp("requested_to"),
    checkpoint: jsonb("checkpoint").$type<KlaviyoEventCheckpoint | null>(),
    apiRevision: text("api_revision"),
    status: text("status").notNull().default("running"),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsInserted: integer("rows_inserted").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    rowsIgnored: integer("rows_ignored").notNull().default(0),
    eventsSuppressed: integer("events_suppressed").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    check(
      "klaviyo_sync_run_events_suppressed_check",
      sql`${table.eventsSuppressed} >= 0`,
    ),
    foreignKey({
      name: "klaviyo_sync_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_sync_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    uniqueIndex("klaviyo_sync_run_one_running_discovery_uidx")
      .on(table.connectionId)
      .where(
        sql`${table.operation} = 'discovery' and ${table.status} = 'running'`,
      ),
    uniqueIndex("klaviyo_sync_run_one_running_probe_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'probe' and ${table.status} = 'running'`),
    uniqueIndex("klaviyo_sync_run_one_running_events_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'events' and ${table.status} = 'running'`),
    uniqueIndex("klaviyo_sync_run_one_running_dimension_report_uidx")
      .on(table.connectionId, table.operation)
      .where(
        sql`${table.operation} in ('dimensions', 'reports') and ${table.status} = 'running'`,
      ),
    check(
      "klaviyo_sync_run_operation_check",
      sql`${table.operation} in ('discovery', 'probe', 'dimensions', 'events', 'reports')`,
    ),
    check(
      "klaviyo_sync_run_status_check",
      sql`${table.status} in ('running', 'success', 'partial', 'failed')`,
    ),
    index("klaviyo_sync_run_scope_started_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.startedAt,
    ),
  ],
);

export const klaviyoProbeReports = pgTable(
  "klaviyo_probe_report",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    syncRunId: text("sync_run_id").notNull(),
    sampledFrom: timestamp("sampled_from").notNull(),
    sampledTo: timestamp("sampled_to").notNull(),
    sampledShopifyOrders: integer("sampled_shopify_orders").notNull(),
    sampledKlaviyoEvents: integer("sampled_klaviyo_events").notNull(),
    bindingOverlapCount: integer("binding_overlap_count").notNull(),
    keyTypeShapes: jsonb("key_type_shapes")
      .$type<PropertyFingerprintEntry[]>()
      .notNull(),
    identifierCoverage: jsonb("identifier_coverage")
      .$type<Record<string, number>>()
      .notNull(),
    collisionSummary: jsonb("collision_summary")
      .$type<Record<string, number>>()
      .notNull(),
    unmatchedSummary: jsonb("unmatched_summary")
      .$type<Record<string, number>>()
      .notNull(),
    unmatchedExamples: jsonb("unmatched_examples")
      .$type<RedactedProbeExample[]>()
      .notNull(),
    productCoverage: jsonb("product_coverage")
      .$type<Record<string, number>>()
      .notNull(),
    attributionCoverage: jsonb("attribution_coverage")
      .$type<Record<string, number>>()
      .notNull(),
    redactionVerified: integer("redaction_verified").notNull().default(0),
    status: text("status").notNull().default("pending"),
    reviewerId: text("reviewer_id"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at"),
    checksum: text("checksum").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_probe_report_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_probe_report_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    foreignKey({
      name: "klaviyo_probe_report_run_scope_fk",
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
      "klaviyo_probe_report_status_check",
      sql`${table.status} in ('pending', 'passed', 'failed')`,
    ),
    check(
      "klaviyo_probe_report_sample_size_check",
      sql`${table.sampledShopifyOrders} between 20 and 50`,
    ),
    check(
      "klaviyo_probe_report_overlap_check",
      sql`${table.bindingOverlapCount} >= 0`,
    ),
  ],
);

export const klaviyoEventAliases = pgTable(
  "klaviyo_event_alias",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    metricId: text("metric_id").notNull(),
    probeReportId: text("probe_report_id").notNull(),
    canonicalField: text("canonical_field")
      .$type<KlaviyoEventAliasField>()
      .notNull(),
    sourceProperty: text("source_property").notNull(),
    state: text("state").notNull().default("candidate"),
    observedPopulated: integer("observed_populated").notNull(),
    observedMalformed: integer("observed_malformed").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_alias_report_metric_field_uniq").on(
      table.probeReportId,
      table.metricId,
      table.canonicalField,
    ),
    unique("klaviyo_event_alias_report_metric_source_uniq").on(
      table.probeReportId,
      table.metricId,
      table.sourceProperty,
    ),
    uniqueIndex("klaviyo_event_alias_approved_metric_field_uniq")
      .on(table.connectionId, table.metricId, table.canonicalField)
      .where(sql`${table.state} = 'approved'`),
    uniqueIndex("klaviyo_event_alias_approved_metric_source_uniq")
      .on(table.connectionId, table.metricId, table.sourceProperty)
      .where(sql`${table.state} = 'approved'`),
    foreignKey({
      name: "klaviyo_event_alias_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_alias_metric_fk",
      columns: [table.connectionId, table.metricId],
      foreignColumns: [klaviyoMetrics.connectionId, klaviyoMetrics.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_alias_report_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.probeReportId,
      ],
      foreignColumns: [
        klaviyoProbeReports.organizationId,
        klaviyoProbeReports.storeId,
        klaviyoProbeReports.connectionId,
        klaviyoProbeReports.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_alias_field_check",
      sql`${table.canonicalField} in ('orderId', 'uniqueEventId', 'productId',
        'variantId', 'sku', 'productName', 'variantName', 'quantity', 'value',
        'currency', 'items')`,
    ),
    check(
      "klaviyo_event_alias_state_check",
      sql`${table.state} in ('candidate', 'approved', 'rejected', 'disabled')`,
    ),
    check(
      "klaviyo_event_alias_counts_check",
      sql`${table.observedPopulated} > 0 and ${table.observedMalformed} >= 0`,
    ),
  ],
);

export const klaviyoJoinRules = pgTable(
  "klaviyo_join_rule",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    probeReportId: text("probe_report_id").notNull(),
    eventKind: text("event_kind").notNull(),
    sourceProperty: text("source_property").notNull(),
    targetNamespace: text("target_namespace").notNull(),
    canonicalizer: text("canonicalizer").notNull(),
    state: text("state").notNull().default("candidate"),
    observedPopulated: integer("observed_populated").notNull(),
    observedCollisions: integer("observed_collisions").notNull(),
    approverId: text("approver_id"),
    reviewNote: text("review_note"),
    approvedAt: timestamp("approved_at"),
    matcherVersion: text("matcher_version"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_join_rule_report_source_uniq").on(
      table.probeReportId,
      table.eventKind,
      table.sourceProperty,
      table.targetNamespace,
    ),
    uniqueIndex("klaviyo_join_rule_approved_source_uidx")
      .on(
        table.connectionId,
        table.eventKind,
        table.sourceProperty,
        table.targetNamespace,
      )
      .where(sql`${table.state} = 'approved'`),
    foreignKey({
      name: "klaviyo_join_rule_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_join_rule_report_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.probeReportId,
      ],
      foreignColumns: [
        klaviyoProbeReports.organizationId,
        klaviyoProbeReports.storeId,
        klaviyoProbeReports.connectionId,
        klaviyoProbeReports.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_join_rule_state_check",
      sql`${table.state} in ('candidate', 'approved', 'rejected', 'disabled')`,
    ),
    check(
      "klaviyo_join_rule_canonicalizer_check",
      sql`${table.canonicalizer} in ('shopify_order_gid', 'trimmed_exact')`,
    ),
  ],
);

export const klaviyoEvents = pgTable(
  "klaviyo_event",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    metricId: text("metric_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventUuid: text("event_uuid"),
    occurredAt: timestamp("occurred_at").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    profileId: text("profile_id"),
    explicitOrderIdCandidate: text("explicit_order_id_candidate"),
    providerUniqueIdCandidate: text("provider_unique_id_candidate"),
    providerValue: numeric("provider_value"),
    providerCurrency: text("provider_currency"),
    attributionRelationshipIds: jsonb("attribution_relationship_ids")
      .$type<string[]>()
      .notNull(),
    redactedProperties: jsonb("redacted_properties")
      .$type<Record<string, JsonValue>>()
      .notNull(),
    keyTypeFingerprint: jsonb("key_type_fingerprint")
      .$type<PropertyFingerprintEntry[]>()
      .notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull(),
    productEvidenceCompleteness: text("product_evidence_completeness")
      .notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    apiRevision: text("api_revision").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_connection_external_uniq").on(
      table.connectionId,
      table.externalEventId,
    ),
    unique("klaviyo_event_connection_id_uniq").on(
      table.connectionId,
      table.id,
    ),
    unique("klaviyo_event_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    foreignKey({
      name: "klaviyo_event_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_product_completeness_check",
      sql`${table.productEvidenceCompleteness} in ('complete', 'incomplete', 'unavailable')`,
    ),
    foreignKey({
      name: "klaviyo_event_metric_fk",
      columns: [table.connectionId, table.metricId],
      foreignColumns: [klaviyoMetrics.connectionId, klaviyoMetrics.id],
    }).onDelete("cascade"),
    index("klaviyo_event_scope_metric_time_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.metricId,
      table.occurredAt,
    ),
    index("klaviyo_event_scope_profile_time_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.profileId,
      table.occurredAt,
    ),
  ],
);

export const klaviyoEventRunObservations = pgTable(
  "klaviyo_event_run_observation",
  {
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    syncRunId: text("sync_run_id").notNull(),
    eventId: text("event_id").notNull(),
    observedSourceChecksum: text("observed_source_checksum").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_run_observation_membership_uniq").on(
      table.connectionId,
      table.syncRunId,
      table.eventId,
    ),
    foreignKey({
      name: "klaviyo_event_run_observation_run_scope_fk",
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
    foreignKey({
      name: "klaviyo_event_run_observation_event_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.eventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    index("klaviyo_event_run_observation_exact_run_idx").on(
      table.connectionId,
      table.syncRunId,
      table.eventId,
    ),
  ],
);

export const klaviyoEventProducts = pgTable(
  "klaviyo_event_product",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    eventId: text("event_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    productId: text("product_id"),
    variantId: text("variant_id"),
    sku: text("sku"),
    productName: text("product_name"),
    variantName: text("variant_name"),
    quantity: integer("quantity"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_product_ordinal_uniq").on(
      table.eventId,
      table.sourceOrdinal,
    ),
    foreignKey({
      name: "klaviyo_event_product_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_product_event_fk",
      columns: [table.connectionId, table.eventId],
      foreignColumns: [klaviyoEvents.connectionId, klaviyoEvents.id],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_product_quantity_check",
      sql`${table.quantity} is null or ${table.quantity} > 0`,
    ),
    index("klaviyo_event_product_variant_idx").on(
      table.organizationId,
      table.storeId,
      table.variantId,
    ),
    index("klaviyo_event_product_product_idx").on(
      table.organizationId,
      table.storeId,
      table.productId,
    ),
    index("klaviyo_event_product_sku_idx").on(
      table.organizationId,
      table.storeId,
      table.sku,
    ),
  ],
);

export const klaviyoConnectionRelations = relations(
  klaviyoConnections,
  ({ many }) => ({
    metrics: many(klaviyoMetrics),
    eventAliases: many(klaviyoEventAliases),
    syncRuns: many(klaviyoSyncRuns),
    probeReports: many(klaviyoProbeReports),
    joinRules: many(klaviyoJoinRules),
    events: many(klaviyoEvents),
    eventRunObservations: many(klaviyoEventRunObservations),
  }),
);

export const klaviyoSyncRunRelations = relations(
  klaviyoSyncRuns,
  ({ many }) => ({ observations: many(klaviyoEventRunObservations) }),
);

export const klaviyoEventRelations = relations(
  klaviyoEvents,
  ({ many }) => ({
    products: many(klaviyoEventProducts),
    runObservations: many(klaviyoEventRunObservations),
  }),
);
