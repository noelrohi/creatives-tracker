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
import type {
  EventMatchStatus,
  MatchCandidateClass,
  MatchRunStatus,
  OrderMatchStatus,
  ProductMatchStatus,
  ResultSupersessionReason,
} from "@/lib/klaviyo/match-types";
import type { JsonValue } from "@/lib/klaviyo/types";
import { identityMatchingKeyBindings } from "@/schema/identity-registry";
import {
  klaviyoConnections,
  klaviyoEventRunObservations,
  klaviyoEvents,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";
import {
  identityErasureSuppressions,
  shopifyEvidenceSyncRuns,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/**
 * One terminal matching attempt. There is deliberately no persisted
 * `running` row: an attempt exists only as a complete `published`
 * publication or a sanitized `failed` audit row.
 */
export const klaviyoMatchRuns = pgTable(
  "klaviyo_match_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    shopifyEvidenceRunId: text("shopify_evidence_run_id").notNull(),
    matcherVersion: text("matcher_version").notNull(),
    publicationScopeFingerprint: text("publication_scope_fingerprint").notNull(),
    invocationFingerprint: text("invocation_fingerprint").notNull(),
    status: text("status").$type<MatchRunStatus>().notNull(),
    failureCode: text("failure_code"),
    eventWindowFrom: timestamp("event_window_from"),
    eventWindowTo: timestamp("event_window_to"),
    shopifyWindowFrom: timestamp("shopify_window_from"),
    shopifyWindowTo: timestamp("shopify_window_to"),
    klaviyoSourceChecksum: text("klaviyo_source_checksum"),
    shopifyEvidenceChecksum: text("shopify_evidence_checksum"),
    ruleChecksum: text("rule_checksum"),
    configChecksum: text("config_checksum"),
    expectedOrderCount: integer("expected_order_count"),
    expectedEventCount: integer("expected_event_count"),
    resultOrderCount: integer("result_order_count"),
    resultEventCount: integer("result_event_count"),
    candidateCount: integer("candidate_count"),
    startedAt: timestamp("started_at").notNull(),
    completedAt: timestamp("completed_at").notNull(),
    publishedAt: timestamp("published_at"),
    supersededAt: timestamp("superseded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_match_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    unique("klaviyo_match_run_scope_status_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
      table.status,
    ),
    foreignKey({
      name: "klaviyo_match_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_match_run_source_run_fk",
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
      name: "klaviyo_match_run_evidence_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.shopifyEvidenceRunId,
      ],
      foreignColumns: [
        shopifyEvidenceSyncRuns.organizationId,
        shopifyEvidenceSyncRuns.storeId,
        shopifyEvidenceSyncRuns.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_match_run_status_check",
      sql`${table.status} in ('published', 'failed')`,
    ),
    check(
      "klaviyo_match_run_terminal_shape_check",
      sql`(${table.status} = 'published'
          and ${table.publishedAt} is not null
          and ${table.failureCode} is null
          and ${table.eventWindowFrom} is not null
          and ${table.eventWindowTo} is not null
          and ${table.shopifyWindowFrom} is not null
          and ${table.shopifyWindowTo} is not null
          and ${table.klaviyoSourceChecksum} is not null
          and ${table.shopifyEvidenceChecksum} is not null
          and ${table.ruleChecksum} is not null
          and ${table.configChecksum} is not null
          and ${table.expectedOrderCount} is not null and ${table.expectedOrderCount} >= 0
          and ${table.expectedEventCount} is not null and ${table.expectedEventCount} >= 0
          and ${table.resultOrderCount} is not null and ${table.resultOrderCount} >= 0
          and ${table.resultEventCount} is not null and ${table.resultEventCount} >= 0
          and ${table.candidateCount} is not null and ${table.candidateCount} >= 0)
        or (${table.status} = 'failed'
          and ${table.failureCode} is not null
          and ${table.publishedAt} is null
          and ${table.supersededAt} is null
          and ${table.eventWindowFrom} is null
          and ${table.eventWindowTo} is null
          and ${table.shopifyWindowFrom} is null
          and ${table.shopifyWindowTo} is null
          and ${table.klaviyoSourceChecksum} is null
          and ${table.shopifyEvidenceChecksum} is null
          and ${table.ruleChecksum} is null
          and ${table.configChecksum} is null
          and ${table.expectedOrderCount} is null
          and ${table.expectedEventCount} is null
          and ${table.resultOrderCount} is null
          and ${table.resultEventCount} is null
          and ${table.candidateCount} is null)`,
    ),
    check(
      "klaviyo_match_run_supersession_check",
      sql`${table.supersededAt} is null or ${table.publishedAt} <= ${table.supersededAt}`,
    ),
    uniqueIndex("klaviyo_match_run_published_invocation_uidx")
      .on(table.connectionId, table.invocationFingerprint)
      .where(sql`${table.status} = 'published'`),
    index("klaviyo_match_run_invocation_idx").on(
      table.connectionId,
      table.invocationFingerprint,
    ),
    index("klaviyo_match_run_scope_time_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.completedAt,
    ),
  ],
);

export const klaviyoMatchCandidates = pgTable(
  "klaviyo_match_candidate",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    runId: text("run_id").notNull(),
    runStatus: text("run_status").notNull().default("published"),
    eventId: text("event_id").notNull(),
    orderId: text("order_id").notNull(),
    candidateClass: text("candidate_class")
      .$type<MatchCandidateClass>()
      .notNull(),
    method: text("method").notNull(),
    featureVector: jsonb("feature_vector")
      .$type<Record<string, JsonValue>>()
      .notNull(),
    weights: jsonb("weights").$type<Record<string, JsonValue>>().notNull(),
    tolerances: jsonb("tolerances").$type<Record<string, JsonValue>>().notNull(),
    score: numeric("score").notNull(),
    confidence: numeric("confidence").notNull(),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_match_candidate_run_edge_uniq").on(
      table.runId,
      table.eventId,
      table.orderId,
    ),
    unique("klaviyo_match_candidate_selected_edge_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.runId,
      table.id,
      table.candidateClass,
    ),
    foreignKey({
      name: "klaviyo_match_candidate_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.runId,
        table.runStatus,
      ],
      foreignColumns: [
        klaviyoMatchRuns.organizationId,
        klaviyoMatchRuns.storeId,
        klaviyoMatchRuns.connectionId,
        klaviyoMatchRuns.id,
        klaviyoMatchRuns.status,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_match_candidate_event_fk",
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
    foreignKey({
      name: "klaviyo_match_candidate_order_fk",
      columns: [table.organizationId, table.storeId, table.orderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_match_candidate_run_status_check",
      sql`${table.runStatus} = 'published'`,
    ),
    check(
      "klaviyo_match_candidate_class_check",
      sql`${table.candidateClass} in ('deterministic', 'diagnostic')`,
    ),
    check(
      "klaviyo_match_candidate_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    index("klaviyo_match_candidate_event_idx").on(
      table.connectionId,
      table.eventId,
    ),
    index("klaviyo_match_candidate_order_idx").on(
      table.organizationId,
      table.storeId,
      table.orderId,
    ),
  ],
);

export const klaviyoEventMatchResults = pgTable(
  "klaviyo_event_match_result",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    runId: text("run_id").notNull(),
    runStatus: text("run_status").notNull().default("published"),
    eventId: text("event_id").notNull(),
    status: text("status").$type<EventMatchStatus>().notNull(),
    selectedCandidateId: text("selected_candidate_id"),
    selectedClass: text("selected_class").$type<MatchCandidateClass | null>(),
    candidateCount: integer("candidate_count").notNull().default(0),
    duplicateWarning: integer("duplicate_warning").notNull().default(0),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
    publishedAt: timestamp("published_at").notNull(),
    supersededAt: timestamp("superseded_at"),
    supersessionReason: text("supersession_reason")
      .$type<ResultSupersessionReason | null>(),
  },
  (table) => [
    unique("klaviyo_event_match_result_run_event_uniq").on(
      table.runId,
      table.eventId,
    ),
    uniqueIndex("klaviyo_event_match_result_current_uidx")
      .on(table.connectionId, table.eventId)
      .where(sql`${table.supersededAt} is null`),
    foreignKey({
      name: "klaviyo_event_match_result_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.runId,
        table.runStatus,
      ],
      foreignColumns: [
        klaviyoMatchRuns.organizationId,
        klaviyoMatchRuns.storeId,
        klaviyoMatchRuns.connectionId,
        klaviyoMatchRuns.id,
        klaviyoMatchRuns.status,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_match_result_event_fk",
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
    foreignKey({
      name: "klaviyo_event_match_result_selected_edge_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.runId,
        table.selectedCandidateId,
        table.selectedClass,
      ],
      foreignColumns: [
        klaviyoMatchCandidates.organizationId,
        klaviyoMatchCandidates.storeId,
        klaviyoMatchCandidates.connectionId,
        klaviyoMatchCandidates.runId,
        klaviyoMatchCandidates.id,
        klaviyoMatchCandidates.candidateClass,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_match_result_run_status_check",
      sql`${table.runStatus} = 'published'`,
    ),
    check(
      "klaviyo_event_match_result_status_check",
      sql`${table.status} in ('confirmed', 'candidate', 'ambiguous', 'unmatched')`,
    ),
    check(
      "klaviyo_event_match_result_selection_check",
      sql`(${table.status} = 'confirmed'
          and ${table.selectedCandidateId} is not null
          and ${table.selectedClass} = 'deterministic')
        or (${table.status} = 'candidate'
          and ${table.selectedCandidateId} is not null
          and ${table.selectedClass} = 'diagnostic')
        or (${table.status} in ('ambiguous', 'unmatched')
          and ${table.selectedCandidateId} is null
          and ${table.selectedClass} is null)`,
    ),
    check(
      "klaviyo_event_match_result_counts_check",
      sql`${table.candidateCount} >= 0 and ${table.duplicateWarning} in (0, 1)`,
    ),
    check(
      "klaviyo_event_match_result_supersession_check",
      sql`(${table.supersededAt} is null and ${table.supersessionReason} is null)
        or (${table.supersededAt} is not null
          and ${table.publishedAt} <= ${table.supersededAt}
          and ${table.supersessionReason} in
            ('entity_replaced', 'incident_edge_boundary', 'rotation_key_retired', 'privacy_erasure'))`,
    ),
    index("klaviyo_event_match_result_event_idx").on(
      table.connectionId,
      table.eventId,
    ),
  ],
);

export const klaviyoOrderMatchResults = pgTable(
  "klaviyo_order_match_result",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    runId: text("run_id").notNull(),
    runStatus: text("run_status").notNull().default("published"),
    orderId: text("order_id").notNull(),
    status: text("status").$type<OrderMatchStatus>().notNull(),
    selectedCandidateId: text("selected_candidate_id"),
    selectedClass: text("selected_class").$type<MatchCandidateClass | null>(),
    selectedEventId: text("selected_event_id"),
    productStatus: text("product_status").$type<ProductMatchStatus | null>(),
    claimCount: integer("claim_count").notNull().default(0),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
    matcherVersion: text("matcher_version").notNull(),
    publishedAt: timestamp("published_at").notNull(),
    supersededAt: timestamp("superseded_at"),
    supersessionReason: text("supersession_reason")
      .$type<ResultSupersessionReason | null>(),
  },
  (table) => [
    unique("klaviyo_order_match_result_run_order_uniq").on(
      table.runId,
      table.orderId,
    ),
    uniqueIndex("klaviyo_order_match_result_current_uidx")
      .on(table.connectionId, table.orderId)
      .where(sql`${table.supersededAt} is null`),
    foreignKey({
      name: "klaviyo_order_match_result_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.runId,
        table.runStatus,
      ],
      foreignColumns: [
        klaviyoMatchRuns.organizationId,
        klaviyoMatchRuns.storeId,
        klaviyoMatchRuns.connectionId,
        klaviyoMatchRuns.id,
        klaviyoMatchRuns.status,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_order_match_result_order_fk",
      columns: [table.organizationId, table.storeId, table.orderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_order_match_result_selected_edge_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.runId,
        table.selectedCandidateId,
        table.selectedClass,
      ],
      foreignColumns: [
        klaviyoMatchCandidates.organizationId,
        klaviyoMatchCandidates.storeId,
        klaviyoMatchCandidates.connectionId,
        klaviyoMatchCandidates.runId,
        klaviyoMatchCandidates.id,
        klaviyoMatchCandidates.candidateClass,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_order_match_result_selected_event_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.selectedEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_order_match_result_run_status_check",
      sql`${table.runStatus} = 'published'`,
    ),
    check(
      "klaviyo_order_match_result_status_check",
      sql`${table.status} in
        ('confirmed', 'candidate', 'ambiguous', 'no_klaviyo_event', 'duplicate_conversion_events')`,
    ),
    check(
      "klaviyo_order_match_result_selection_check",
      sql`(${table.status} = 'confirmed'
          and ${table.selectedCandidateId} is not null
          and ${table.selectedClass} = 'deterministic'
          and ${table.selectedEventId} is not null)
        or (${table.status} = 'candidate'
          and ${table.selectedCandidateId} is not null
          and ${table.selectedClass} = 'diagnostic'
          and ${table.selectedEventId} is not null)
        or (${table.status} in ('ambiguous', 'no_klaviyo_event', 'duplicate_conversion_events')
          and ${table.selectedCandidateId} is null
          and ${table.selectedClass} is null
          and ${table.selectedEventId} is null)`,
    ),
    check(
      "klaviyo_order_match_result_product_status_check",
      sql`(${table.productStatus} is null and ${table.status} <> 'confirmed')
        or (${table.status} = 'confirmed'
          and ${table.productStatus} in ('exact', 'partial', 'contradictory', 'unavailable'))`,
    ),
    check(
      "klaviyo_order_match_result_claims_check",
      sql`${table.claimCount} >= 0`,
    ),
    check(
      "klaviyo_order_match_result_supersession_check",
      sql`(${table.supersededAt} is null and ${table.supersessionReason} is null)
        or (${table.supersededAt} is not null
          and ${table.publishedAt} <= ${table.supersededAt}
          and ${table.supersessionReason} in
            ('entity_replaced', 'incident_edge_boundary', 'rotation_key_retired', 'privacy_erasure'))`,
    ),
    index("klaviyo_order_match_result_order_idx").on(
      table.organizationId,
      table.storeId,
      table.orderId,
    ),
  ],
);

/**
 * Deterministic run-scoped link between an `ordered_product` event, its
 * `placed_order` conversion, and the Shopify order. Never carries money.
 */
export const klaviyoProductEvidenceLinks = pgTable(
  "klaviyo_product_evidence_link",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    runId: text("run_id").notNull(),
    runStatus: text("run_status").notNull().default("published"),
    orderedProductEventId: text("ordered_product_event_id").notNull(),
    placedOrderEventId: text("placed_order_event_id").notNull(),
    shopifyOrderId: text("shopify_order_id").notNull(),
    method: text("method").notNull(),
    matcherVersion: text("matcher_version").notNull(),
    status: text("status").$type<ProductMatchStatus>().notNull(),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_product_evidence_link_run_uniq").on(
      table.runId,
      table.orderedProductEventId,
      table.placedOrderEventId,
      table.shopifyOrderId,
    ),
    foreignKey({
      name: "klaviyo_product_evidence_link_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.runId,
        table.runStatus,
      ],
      foreignColumns: [
        klaviyoMatchRuns.organizationId,
        klaviyoMatchRuns.storeId,
        klaviyoMatchRuns.connectionId,
        klaviyoMatchRuns.id,
        klaviyoMatchRuns.status,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_product_evidence_link_op_event_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.orderedProductEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_product_evidence_link_po_event_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.placedOrderEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_product_evidence_link_order_fk",
      columns: [table.organizationId, table.storeId, table.shopifyOrderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_product_evidence_link_run_status_check",
      sql`${table.runStatus} = 'published'`,
    ),
    check(
      "klaviyo_product_evidence_link_method_check",
      sql`${table.method} = 'deterministic'`,
    ),
    check(
      "klaviyo_product_evidence_link_status_check",
      sql`${table.status} in ('exact', 'partial', 'contradictory', 'unavailable')`,
    ),
    index("klaviyo_product_evidence_link_order_idx").on(
      table.organizationId,
      table.storeId,
      table.shopifyOrderId,
    ),
  ],
);

/**
 * Exact source-lineage link from one Plan 2 run/event content observation to
 * the configured-current identity digest row used by that run. Stores no
 * digest, checksum, profile, or provider value.
 */
export const klaviyoEventRunIdentityObservations = pgTable(
  "klaviyo_event_run_identity_observation",
  {
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    syncRunId: text("sync_run_id").notNull(),
    eventId: text("event_id").notNull(),
    identityHmacId: text("identity_hmac_id").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_run_identity_obs_uniq").on(
      table.connectionId,
      table.syncRunId,
      table.eventId,
    ),
    foreignKey({
      name: "klaviyo_event_run_identity_obs_membership_fk",
      columns: [table.connectionId, table.syncRunId, table.eventId],
      foreignColumns: [
        klaviyoEventRunObservations.connectionId,
        klaviyoEventRunObservations.syncRunId,
        klaviyoEventRunObservations.eventId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_run_identity_obs_run_scope_fk",
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
      name: "klaviyo_event_run_identity_obs_hmac_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.eventId,
        table.identityHmacId,
      ],
      foreignColumns: [
        sourceIdentityHmacs.organizationId,
        sourceIdentityHmacs.storeId,
        sourceIdentityHmacs.klaviyoConnectionId,
        sourceIdentityHmacs.klaviyoEventId,
        sourceIdentityHmacs.id,
      ],
    }).onDelete("cascade"),
    index("klaviyo_event_run_identity_obs_run_idx").on(
      table.connectionId,
      table.syncRunId,
      table.eventId,
    ),
  ],
);

export const klaviyoIdentityRotationRuns = pgTable(
  "klaviyo_identity_rotation_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    currentKeyVersion: text("current_key_version").notNull(),
    currentKeyCheck: text("current_key_check").notNull(),
    previousKeyVersion: text("previous_key_version").notNull(),
    previousKeyCheck: text("previous_key_check").notNull(),
    state: text("state").notNull().default("preparing"),
    checkpoint: jsonb("checkpoint").$type<Record<string, JsonValue> | null>(),
    currentAttemptNumber: integer("current_attempt_number").notNull().default(0),
    sourcesPending: integer("sources_pending").notNull().default(0),
    sourcesComplete: integer("sources_complete").notNull().default(0),
    sourcesUnavailable: integer("sources_unavailable").notNull().default(0),
    sourcesSuppressed: integer("sources_suppressed").notNull().default(0),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    unique("klaviyo_identity_rotation_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    uniqueIndex("klaviyo_identity_rotation_run_live_uidx")
      .on(table.connectionId)
      .where(sql`${table.state} not in ('complete', 'failed', 'aborted')`),
    foreignKey({
      name: "klaviyo_identity_rotation_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_identity_rotation_current_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.currentKeyVersion,
        table.currentKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    foreignKey({
      name: "klaviyo_identity_rotation_previous_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.previousKeyVersion,
        table.previousKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    check(
      "klaviyo_identity_rotation_run_state_check",
      sql`${table.state} in
        ('preparing', 'dual_write', 'republishing', 'pruning', 'complete', 'failed', 'aborted')`,
    ),
    check(
      "klaviyo_identity_rotation_run_versions_check",
      sql`${table.currentKeyVersion} <> ${table.previousKeyVersion}`,
    ),
    check(
      "klaviyo_identity_rotation_run_counts_check",
      sql`${table.currentAttemptNumber} >= 0
        and ${table.sourcesPending} >= 0
        and ${table.sourcesComplete} >= 0
        and ${table.sourcesUnavailable} >= 0
        and ${table.sourcesSuppressed} >= 0`,
    ),
  ],
);

export const klaviyoIdentityRotationSources = pgTable(
  "klaviyo_identity_rotation_source",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    rotationId: text("rotation_id").notNull(),
    sourceSnapshotId: text("source_snapshot_id")
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    kind: text("kind").notNull(),
    shopifyOrderId: text("shopify_order_id"),
    klaviyoEventId: text("klaviyo_event_id"),
    suppressionId: text("suppression_id"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    releasedAt: timestamp("released_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_identity_rotation_source_snapshot_uniq").on(
      table.rotationId,
      table.sourceSnapshotId,
    ),
    uniqueIndex("klaviyo_identity_rotation_source_order_uidx")
      .on(table.rotationId, table.shopifyOrderId)
      .where(sql`${table.shopifyOrderId} is not null`),
    uniqueIndex("klaviyo_identity_rotation_source_event_uidx")
      .on(table.rotationId, table.klaviyoEventId)
      .where(sql`${table.klaviyoEventId} is not null`),
    foreignKey({
      name: "klaviyo_identity_rotation_source_rotation_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.rotationId,
      ],
      foreignColumns: [
        klaviyoIdentityRotationRuns.organizationId,
        klaviyoIdentityRotationRuns.storeId,
        klaviyoIdentityRotationRuns.connectionId,
        klaviyoIdentityRotationRuns.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_identity_rotation_source_order_fk",
      columns: [table.organizationId, table.storeId, table.shopifyOrderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("set null"),
    foreignKey({
      name: "klaviyo_identity_rotation_source_event_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.klaviyoEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("set null"),
    foreignKey({
      name: "klaviyo_identity_rotation_source_suppression_fk",
      columns: [table.organizationId, table.storeId, table.suppressionId],
      foreignColumns: [
        identityErasureSuppressions.organizationId,
        identityErasureSuppressions.storeId,
        identityErasureSuppressions.id,
      ],
    }).onDelete("restrict"),
    check(
      "klaviyo_identity_rotation_source_kind_check",
      sql`${table.kind} in ('shopify_order', 'klaviyo_event')`,
    ),
    check(
      "klaviyo_identity_rotation_source_status_check",
      sql`${table.status} in ('pending', 'complete', 'unavailable', 'suppressed', 'released')`,
    ),
    check(
      "klaviyo_identity_rotation_source_live_shape_check",
      sql`not (${table.shopifyOrderId} is not null and ${table.klaviyoEventId} is not null)
        and (${table.shopifyOrderId} is null or ${table.kind} = 'shopify_order')
        and (${table.klaviyoEventId} is null or ${table.kind} = 'klaviyo_event')`,
    ),
    check(
      "klaviyo_identity_rotation_source_terminal_shape_check",
      sql`(${table.status} in ('pending', 'complete', 'unavailable')
          and ${table.suppressionId} is null and ${table.releasedAt} is null)
        or (${table.status} = 'suppressed'
          and ${table.shopifyOrderId} is null and ${table.klaviyoEventId} is null
          and ${table.suppressionId} is not null and ${table.releasedAt} is null)
        or (${table.status} = 'released'
          and ${table.shopifyOrderId} is null and ${table.klaviyoEventId} is null
          and ${table.suppressionId} is null and ${table.releasedAt} is not null)`,
    ),
    check(
      "klaviyo_identity_rotation_source_attempts_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const klaviyoIdentityRotationPublicationAttempts = pgTable(
  "klaviyo_identity_rotation_publication_attempt",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    rotationId: text("rotation_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    stage: text("stage").notNull(),
    triggerRunId: text("trigger_run_id"),
    shopifyEvidenceRunId: text("shopify_evidence_run_id"),
    sourceRunId: text("source_run_id"),
    matchRunId: text("match_run_id"),
    klaviyoSourceChecksum: text("klaviyo_source_checksum"),
    shopifyEvidenceChecksum: text("shopify_evidence_checksum"),
    publicationScopeFingerprint: text("publication_scope_fingerprint"),
    invocationFingerprint: text("invocation_fingerprint"),
    staleCode: text("stale_code"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_identity_rotation_attempt_uniq").on(
      table.rotationId,
      table.attemptNumber,
    ),
    foreignKey({
      name: "klaviyo_identity_rotation_attempt_rotation_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.rotationId,
      ],
      foreignColumns: [
        klaviyoIdentityRotationRuns.organizationId,
        klaviyoIdentityRotationRuns.storeId,
        klaviyoIdentityRotationRuns.connectionId,
        klaviyoIdentityRotationRuns.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_identity_rotation_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "klaviyo_identity_rotation_attempt_stage_check",
      sql`${table.stage} in
        ('refreshing_shopify_evidence', 'refreshing_order_core', 'matching', 'published', 'stale')`,
    ),
  ],
);

/**
 * Store-owned proof that a pilot uninstall retired its keys correctly.
 * Survives connection deletion; cascades only with organization/store.
 */
export const identityPilotUninstallReceipts = pgTable(
  "identity_pilot_uninstall_receipt",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    formerConnectionId: text("former_connection_id").notNull(),
    priorMode: text("prior_mode").notNull(),
    resultingCurrentKeyVersion: text("resulting_current_key_version").notNull(),
    resultingCurrentKeyCheck: text("resulting_current_key_check").notNull(),
    clearedShopifyIdentityRows: integer("cleared_shopify_identity_rows")
      .notNull()
      .default(0),
    clearedKlaviyoIdentityRows: integer("cleared_klaviyo_identity_rows")
      .notNull()
      .default(0),
    status: text("status").notNull().default("complete"),
    completedAt: timestamp("completed_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("identity_pilot_uninstall_receipt_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    unique("identity_pilot_uninstall_receipt_current_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
      table.resultingCurrentKeyVersion,
    ),
    foreignKey({
      name: "identity_pilot_uninstall_receipt_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "identity_pilot_uninstall_receipt_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.resultingCurrentKeyVersion,
        table.resultingCurrentKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    check(
      "identity_pilot_uninstall_receipt_status_check",
      sql`${table.status} = 'complete'`,
    ),
    check(
      "identity_pilot_uninstall_receipt_mode_check",
      sql`${table.priorMode} in ('current_only', 'dual')`,
    ),
    check(
      "identity_pilot_uninstall_receipt_counts_check",
      sql`${table.clearedShopifyIdentityRows} >= 0
        and ${table.clearedKlaviyoIdentityRows} >= 0`,
    ),
  ],
);

export const identityPilotUninstallRetiredKeys = pgTable(
  "identity_pilot_uninstall_retired_key",
  {
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    resultingCurrentKeyVersion: text("resulting_current_key_version").notNull(),
    retiredKeyVersion: text("retired_key_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("identity_pilot_uninstall_retired_key_uniq").on(
      table.organizationId,
      table.storeId,
      table.receiptId,
      table.retiredKeyVersion,
    ),
    foreignKey({
      name: "identity_pilot_uninstall_retired_key_receipt_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.receiptId,
        table.resultingCurrentKeyVersion,
      ],
      foreignColumns: [
        identityPilotUninstallReceipts.organizationId,
        identityPilotUninstallReceipts.storeId,
        identityPilotUninstallReceipts.id,
        identityPilotUninstallReceipts.resultingCurrentKeyVersion,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "identity_pilot_uninstall_retired_key_binding_fk",
      columns: [table.organizationId, table.storeId, table.retiredKeyVersion],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
      ],
    }),
    check(
      "identity_pilot_uninstall_retired_key_not_current_check",
      sql`${table.retiredKeyVersion} <> ${table.resultingCurrentKeyVersion}`,
    ),
  ],
);
