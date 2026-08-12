import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { identityMatchingKeyBindings } from "@/schema/identity-registry";
import { klaviyoConnections, klaviyoEvents } from "@/schema/klaviyo";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";

export const sourceIdentityKindEnum = pgEnum("source_identity_kind", [
  "shopify_order",
  "klaviyo_event",
]);

export const identityHmacRotationStateEnum = pgEnum(
  "identity_hmac_rotation_state",
  ["active", "rotation_previous"],
);

export const identityErasureSuppressionKindEnum = pgEnum(
  "identity_erasure_suppression_kind",
  ["email", "shopify_customer_id", "klaviyo_profile_id"],
);

export const shopifyEvidenceRunStatusEnum = pgEnum(
  "shopify_evidence_run_status",
  ["running", "success", "partial", "failed"],
);

export const shopifyEvidenceCapabilityEnum = pgEnum(
  "shopify_evidence_capability",
  ["unknown", "available", "unavailable"],
);

export const shopifyEvidenceCompletenessEnum = pgEnum(
  "shopify_evidence_completeness",
  ["unknown", "complete", "partial", "unavailable"],
);

export const shopifyOrderLines = pgTable(
  "shopify_order_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    orderId: text("order_id").notNull(),
    shopifyLineItemId: text("shopify_line_item_id").notNull(),
    shopifyProductId: text("shopify_product_id"),
    shopifyVariantId: text("shopify_variant_id"),
    sku: text("sku"),
    productTitle: text("product_title").notNull(),
    variantTitle: text("variant_title"),
    quantity: integer("quantity").notNull(),
    sourcePosition: integer("source_position"),
    parentOrderUpdatedAt: timestamp("parent_order_updated_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "shopify_order_line_org_store_order_fk",
      columns: [table.organizationId, table.storeId, table.orderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("cascade"),
    unique("shopify_order_line_store_external_uniq").on(
      table.storeId,
      table.shopifyLineItemId,
    ),
    check("shopify_order_line_quantity_positive", sql`${table.quantity} > 0`),
    index("shopify_order_line_order_idx").on(table.orderId),
    index("shopify_order_line_store_product_idx").on(
      table.storeId,
      table.shopifyProductId,
    ),
    index("shopify_order_line_store_variant_idx").on(
      table.storeId,
      table.shopifyVariantId,
    ),
    index("shopify_order_line_store_sku_idx").on(table.storeId, table.sku),
  ],
);

export const sourceIdentityHmacs = pgTable(
  "source_identity_hmac",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    sourceKind: sourceIdentityKindEnum("source_kind").notNull(),
    shopifyOrderId: text("shopify_order_id"),
    klaviyoConnectionId: text("klaviyo_connection_id"),
    klaviyoEventId: text("klaviyo_event_id"),
    keyVersion: text("key_version").notNull(),
    digest: text("digest").notNull(),
    rotationState: identityHmacRotationStateEnum("rotation_state").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "source_identity_hmac_shopify_order_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.shopifyOrderId,
      ],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("cascade"),
    check(
      "source_identity_hmac_exactly_one_source",
      // Text casts keep the check applyable in the same transaction that
      // adds the new enum value (PostgreSQL check_safe_enum_use).
      sql`((${table.sourceKind})::text = 'shopify_order' AND ${table.shopifyOrderId} IS NOT NULL
        AND ${table.klaviyoConnectionId} IS NULL AND ${table.klaviyoEventId} IS NULL)
      OR ((${table.sourceKind})::text = 'klaviyo_event' AND ${table.shopifyOrderId} IS NULL
        AND ${table.klaviyoConnectionId} IS NOT NULL AND ${table.klaviyoEventId} IS NOT NULL)`,
    ),
    uniqueIndex("source_identity_hmac_shopify_version_uidx")
      .on(table.shopifyOrderId, table.keyVersion)
      .where(sql`${table.shopifyOrderId} is not null`),
    uniqueIndex("source_identity_hmac_klaviyo_version_uidx")
      .on(table.klaviyoConnectionId, table.klaviyoEventId, table.keyVersion)
      .where(sql`${table.klaviyoConnectionId} is not null`),
    foreignKey({
      name: "source_identity_hmac_klaviyo_connection_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.klaviyoConnectionId,
      ],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "source_identity_hmac_klaviyo_event_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.klaviyoConnectionId,
        table.klaviyoEventId,
      ],
      foreignColumns: [
        klaviyoEvents.organizationId,
        klaviyoEvents.storeId,
        klaviyoEvents.connectionId,
        klaviyoEvents.id,
      ],
    }).onDelete("cascade"),
    unique("source_identity_hmac_scope_event_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.klaviyoConnectionId,
      table.klaviyoEventId,
      table.id,
    ),
    index("source_identity_hmac_klaviyo_digest_idx").on(
      table.klaviyoConnectionId,
      table.keyVersion,
      table.digest,
    ),
    unique("source_identity_hmac_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    unique("source_identity_hmac_scope_order_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.shopifyOrderId,
      table.id,
    ),
    index("source_identity_hmac_scope_digest_idx").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.digest,
    ),
  ],
);

export const identityErasureSuppressions = pgTable(
  "identity_erasure_suppression",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    kind: identityErasureSuppressionKindEnum("kind").notNull(),
    keyVersion: text("key_version").notNull(),
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "identity_erasure_suppression_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    unique("identity_erasure_suppression_scope_digest_uniq").on(
      table.organizationId,
      table.storeId,
      table.kind,
      table.keyVersion,
      table.digest,
    ),
    unique("identity_erasure_suppression_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    index("identity_erasure_suppression_lookup_idx").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.kind,
      table.digest,
    ),
  ],
);

// Moved to src/schema/identity-registry.ts so the Klaviyo connection gate
// can reference it without a module cycle; re-exported for compatibility.
export { identityMatchingKeyBindings } from "@/schema/identity-registry";

export const identityCryptoPolicies = pgTable(
  "identity_crypto_policy",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    matchingCurrentVersion: text("matching_current_version").notNull(),
    matchingCurrentKeyCheck: text("matching_current_key_check").notNull(),
    matchingPreviousVersion: text("matching_previous_version"),
    matchingPreviousKeyCheck: text("matching_previous_key_check"),
    suppressionVersion: text("suppression_version").notNull(),
    suppressionKeyCheck: text("suppression_key_check").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "identity_crypto_policy_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "identity_crypto_policy_current_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.matchingCurrentVersion,
        table.matchingCurrentKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    foreignKey({
      name: "identity_crypto_policy_previous_binding_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.matchingPreviousVersion,
        table.matchingPreviousKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
    }),
    unique("identity_crypto_policy_org_store_uniq").on(
      table.organizationId,
      table.storeId,
    ),
    check(
      "identity_crypto_policy_previous_pair",
      sql`(${table.matchingPreviousVersion} IS NULL AND ${table.matchingPreviousKeyCheck} IS NULL) OR (${table.matchingPreviousVersion} IS NOT NULL AND ${table.matchingPreviousKeyCheck} IS NOT NULL)`,
    ),
    check(
      "identity_crypto_policy_versions_distinct",
      sql`${table.matchingPreviousVersion} IS NULL OR ${table.matchingPreviousVersion} <> ${table.matchingCurrentVersion}`,
    ),
  ],
);

export const shopifyEvidenceSyncRuns = pgTable(
  "shopify_evidence_sync_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    startTriggerRunId: text("start_trigger_run_id").notNull(),
    firstBatchTriggerRunId: text("first_batch_trigger_run_id"),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    mode: text("mode").notNull(),
    storeTimezone: text("store_timezone").notNull(),
    anchorStoreDay: text("anchor_store_day").notNull(),
    requestedFrom: timestamp("requested_from").notNull(),
    requestedTo: timestamp("requested_to").notNull(),
    cursor: text("cursor"),
    status: shopifyEvidenceRunStatusEnum("status")
      .default("running")
      .notNull(),
    identityCapability: shopifyEvidenceCapabilityEnum("identity_capability")
      .default("unknown")
      .notNull(),
    lineCompleteness: shopifyEvidenceCompletenessEnum("line_completeness")
      .default("unknown")
      .notNull(),
    ordersRead: integer("orders_read").default(0).notNull(),
    ordersEnriched: integer("orders_enriched").default(0).notNull(),
    ordersPartial: integer("orders_partial").default(0).notNull(),
    ordersUnavailable: integer("orders_unavailable").default(0).notNull(),
    warnings: integer("warnings").default(0).notNull(),
    failures: integer("failures").default(0).notNull(),
    error: text("error"),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "shopify_evidence_sync_run_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    check(
      "shopify_evidence_sync_run_window_valid",
      sql`${table.requestedFrom} < ${table.requestedTo}`,
    ),
    check(
      "shopify_evidence_sync_run_mode_check",
      sql`${table.mode} IN ('initial_90d', 'incremental_7d')`,
    ),
    unique("shopify_evidence_sync_run_start_trigger_uniq").on(
      table.startTriggerRunId,
    ),
    unique("shopify_evidence_sync_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    uniqueIndex("shopify_evidence_sync_run_one_running_store_uidx")
      .on(table.storeId)
      .where(sql`${table.status} = 'running'`),
    index("shopify_evidence_sync_run_scope_started_idx").on(
      table.organizationId,
      table.storeId,
      table.startedAt,
    ),
  ],
);

export const shopifyEvidenceRunObservations = pgTable(
  "shopify_evidence_run_observation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    evidenceRunId: text("evidence_run_id").notNull(),
    orderId: text("order_id").notNull(),
    lineDisposition: text("line_disposition").notNull(),
    identityDisposition: text("identity_disposition").notNull(),
    observedContentChecksum: text("observed_content_checksum").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "shopify_evidence_observation_run_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.evidenceRunId,
      ],
      foreignColumns: [
        shopifyEvidenceSyncRuns.organizationId,
        shopifyEvidenceSyncRuns.storeId,
        shopifyEvidenceSyncRuns.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "shopify_evidence_observation_order_fk",
      columns: [table.organizationId, table.storeId, table.orderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }).onDelete("cascade"),
    check(
      "shopify_evidence_observation_line_disposition_check",
      sql`${table.lineDisposition} IN ('complete', 'preserved_partial')`,
    ),
    check(
      "shopify_evidence_observation_identity_disposition_check",
      sql`${table.identityDisposition} IN ('available', 'unavailable', 'not_refreshed', 'suppressed')`,
    ),
    unique("shopify_evidence_observation_scope_run_order_uniq").on(
      table.organizationId,
      table.storeId,
      table.evidenceRunId,
      table.orderId,
    ),
    index("shopify_evidence_observation_run_order_idx").on(
      table.organizationId,
      table.storeId,
      table.evidenceRunId,
      table.orderId,
    ),
  ],
);

export const shopifyEvidenceRunIdentityObservations = pgTable(
  "shopify_evidence_run_identity_observation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    evidenceRunId: text("evidence_run_id").notNull(),
    orderId: text("order_id").notNull(),
    identityHmacId: text("identity_hmac_id").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "shopify_evidence_identity_observation_content_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.evidenceRunId,
        table.orderId,
      ],
      foreignColumns: [
        shopifyEvidenceRunObservations.organizationId,
        shopifyEvidenceRunObservations.storeId,
        shopifyEvidenceRunObservations.evidenceRunId,
        shopifyEvidenceRunObservations.orderId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "shopify_evidence_identity_observation_hmac_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.orderId,
        table.identityHmacId,
      ],
      foreignColumns: [
        sourceIdentityHmacs.organizationId,
        sourceIdentityHmacs.storeId,
        sourceIdentityHmacs.shopifyOrderId,
        sourceIdentityHmacs.id,
      ],
    }).onDelete("cascade"),
    unique("shopify_evidence_identity_observation_run_order_uniq").on(
      table.storeId,
      table.evidenceRunId,
      table.orderId,
    ),
    index("shopify_evidence_identity_observation_run_idx").on(
      table.organizationId,
      table.storeId,
      table.evidenceRunId,
    ),
  ],
);

export const shopifyOrderLineRelations = relations(
  shopifyOrderLines,
  ({ one }) => ({
    order: one(shopifyOrders, {
      fields: [
        shopifyOrderLines.organizationId,
        shopifyOrderLines.storeId,
        shopifyOrderLines.orderId,
      ],
      references: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }),
  }),
);

export const sourceIdentityHmacRelations = relations(
  sourceIdentityHmacs,
  ({ one }) => ({
    order: one(shopifyOrders, {
      fields: [
        sourceIdentityHmacs.organizationId,
        sourceIdentityHmacs.storeId,
        sourceIdentityHmacs.shopifyOrderId,
      ],
      references: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }),
  }),
);

export const shopifyEvidenceSyncRunRelations = relations(
  shopifyEvidenceSyncRuns,
  ({ one, many }) => ({
    store: one(shopifyStores, {
      fields: [
        shopifyEvidenceSyncRuns.organizationId,
        shopifyEvidenceSyncRuns.storeId,
      ],
      references: [shopifyStores.organizationId, shopifyStores.id],
    }),
    observations: many(shopifyEvidenceRunObservations),
    identityObservations: many(shopifyEvidenceRunIdentityObservations, {
      relationName: "shopifyEvidenceRunIdentityObservationsRun",
    }),
  }),
);

export const shopifyEvidenceRunObservationRelations = relations(
  shopifyEvidenceRunObservations,
  ({ one, many }) => ({
    run: one(shopifyEvidenceSyncRuns, {
      fields: [
        shopifyEvidenceRunObservations.organizationId,
        shopifyEvidenceRunObservations.storeId,
        shopifyEvidenceRunObservations.evidenceRunId,
      ],
      references: [
        shopifyEvidenceSyncRuns.organizationId,
        shopifyEvidenceSyncRuns.storeId,
        shopifyEvidenceSyncRuns.id,
      ],
    }),
    order: one(shopifyOrders, {
      fields: [
        shopifyEvidenceRunObservations.organizationId,
        shopifyEvidenceRunObservations.storeId,
        shopifyEvidenceRunObservations.orderId,
      ],
      references: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
    }),
    identityObservations: many(shopifyEvidenceRunIdentityObservations),
  }),
);

export const shopifyEvidenceRunIdentityObservationRelations = relations(
  shopifyEvidenceRunIdentityObservations,
  ({ one }) => ({
    run: one(shopifyEvidenceSyncRuns, {
      relationName: "shopifyEvidenceRunIdentityObservationsRun",
      fields: [
        shopifyEvidenceRunIdentityObservations.organizationId,
        shopifyEvidenceRunIdentityObservations.storeId,
        shopifyEvidenceRunIdentityObservations.evidenceRunId,
      ],
      references: [
        shopifyEvidenceSyncRuns.organizationId,
        shopifyEvidenceSyncRuns.storeId,
        shopifyEvidenceSyncRuns.id,
      ],
    }),
    observation: one(shopifyEvidenceRunObservations, {
      fields: [
        shopifyEvidenceRunIdentityObservations.organizationId,
        shopifyEvidenceRunIdentityObservations.storeId,
        shopifyEvidenceRunIdentityObservations.evidenceRunId,
        shopifyEvidenceRunIdentityObservations.orderId,
      ],
      references: [
        shopifyEvidenceRunObservations.organizationId,
        shopifyEvidenceRunObservations.storeId,
        shopifyEvidenceRunObservations.evidenceRunId,
        shopifyEvidenceRunObservations.orderId,
      ],
    }),
    identity: one(sourceIdentityHmacs, {
      fields: [
        shopifyEvidenceRunIdentityObservations.organizationId,
        shopifyEvidenceRunIdentityObservations.storeId,
        shopifyEvidenceRunIdentityObservations.orderId,
        shopifyEvidenceRunIdentityObservations.identityHmacId,
      ],
      references: [
        sourceIdentityHmacs.organizationId,
        sourceIdentityHmacs.storeId,
        sourceIdentityHmacs.shopifyOrderId,
        sourceIdentityHmacs.id,
      ],
    }),
  }),
);
