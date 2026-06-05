import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  launchpadErrorCategories,
  launchpadItemStatuses,
  launchpadPrincipalTypes,
  launchpadReconciliationStatuses,
  launchpadRunStatuses,
  launchpadSourceTemplateStatuses,
} from "../lib/launchpad-constants";
import { adAccounts } from "./account";
import { ads } from "./ad";
import { adCreatives } from "./ad-creative";
import { adSets } from "./ad-set";
import { campaigns } from "./campaign";

export const launchpadRunStatusEnum = pgEnum(
  "launchpad_run_status",
  launchpadRunStatuses,
);

export const launchpadItemStatusEnum = pgEnum(
  "launchpad_item_status",
  launchpadItemStatuses,
);

export const launchpadErrorCategoryEnum = pgEnum(
  "launchpad_error_category",
  launchpadErrorCategories,
);

export const launchpadReconciliationStatusEnum = pgEnum(
  "launchpad_reconciliation_status",
  launchpadReconciliationStatuses,
);

export const launchpadPrincipalTypeEnum = pgEnum(
  "launchpad_principal_type",
  launchpadPrincipalTypes,
);

export const launchpadSourceTemplateStatusEnum = pgEnum(
  "launchpad_source_template_status",
  launchpadSourceTemplateStatuses,
);

export const launchpadSourceTemplates = pgTable(
  "launchpad_source_template",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    accountId: text("account_id").references(() => adAccounts.id, {
      onDelete: "set null",
    }),
    sourceCampaignId: text("source_campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    sourceCampaignMetaId: text("source_campaign_meta_id").notNull(),
    sourceAdSetId: text("source_ad_set_id").references(() => adSets.id, {
      onDelete: "set null",
    }),
    sourceAdSetMetaId: text("source_ad_set_meta_id").notNull(),
    label: text("label").notNull(),
    notes: text("notes"),
    status: launchpadSourceTemplateStatusEnum("status")
      .notNull()
      .default("needs_review"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at"),
    lastValidatedAt: timestamp("last_validated_at"),
    expiresAt: timestamp("expires_at"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("launchpad_source_template_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("launchpad_source_template_account_idx").on(table.accountId),
    index("launchpad_source_template_source_campaign_idx").on(
      table.sourceCampaignId,
    ),
    index("launchpad_source_template_source_ad_set_idx").on(
      table.sourceAdSetId,
    ),
    index("launchpad_source_template_expires_at_idx").on(table.expiresAt),
  ],
);

export const launchpadPublishRuns = pgTable(
  "launchpad_publish_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    status: launchpadRunStatusEnum("status").notNull().default("validation"),
    mode: text("mode").notNull().default("validation"),
    requestedStatus: text("requested_status").notNull().default("PAUSED"),
    itemCount: integer("item_count").notNull().default(0),
    maxItemCap: integer("max_item_cap").notNull().default(25),

    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifestLockedAt: timestamp("manifest_locked_at").defaultNow().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),

    requestedByUserId: text("requested_by_user_id"),
    requestedByPrincipalType: launchpadPrincipalTypeEnum(
      "requested_by_principal_type",
    ).notNull(),
    requestedByRole: text("requested_by_role"),

    actorAccountId: text("actor_account_id").references(() => adAccounts.id, {
      onDelete: "set null",
    }),
    actorAccountMetaId: text("actor_account_meta_id"),
    actorPageId: text("actor_page_id"),
    actorInstagramId: text("actor_instagram_id"),
    destinationAdSetId: text("destination_ad_set_id").references(() => adSets.id, {
      onDelete: "set null",
    }),
    destinationAdSetMetaId: text("destination_ad_set_meta_id"),

    livePublishEnabledAtValidation: boolean(
      "live_publish_enabled_at_validation",
    )
      .notNull()
      .default(false),
    externalTriggerRunId: text("external_trigger_run_id"),

    retryCount: integer("retry_count").notNull().default(0),
    lastRetryRequestedAt: timestamp("last_retry_requested_at"),
    lastRetryRequestedByUserId: text("last_retry_requested_by_user_id"),
    lastRetryRequestedByPrincipalType: launchpadPrincipalTypeEnum(
      "last_retry_requested_by_principal_type",
    ),
    lastRetryRequestedByRole: text("last_retry_requested_by_role"),

    errorCategory: launchpadErrorCategoryEnum("error_category"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorDetails: jsonb("error_details").$type<Record<string, unknown> | null>(),

    reconciliationStatus: launchpadReconciliationStatusEnum(
      "reconciliation_status",
    )
      .notNull()
      .default("not_required"),
    reconciliationCheckedAt: timestamp("reconciliation_checked_at"),
    manualInterventionReason: text("manual_intervention_reason"),

    validatedAt: timestamp("validated_at"),
    queuedAt: timestamp("queued_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("launchpad_run_org_idx").on(table.organizationId),
    index("launchpad_run_status_idx").on(table.status),
    index("launchpad_run_created_at_idx").on(table.createdAt),
    index("launchpad_run_actor_account_idx").on(table.actorAccountId),
    index("launchpad_run_destination_ad_set_idx").on(table.destinationAdSetId),
    uniqueIndex("launchpad_run_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex("launchpad_run_org_dedupe_uidx").on(
      table.organizationId,
      table.dedupeKey,
    ),
  ],
);

export const launchpadPublishItems = pgTable(
  "launchpad_publish_item",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => launchpadPublishRuns.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    status: launchpadItemStatusEnum("status").notNull().default("validation"),
    requestedStatus: text("requested_status").notNull().default("PAUSED"),

    creativeId: text("creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),
    localAdId: text("local_ad_id").references(() => ads.id, {
      onDelete: "set null",
    }),
    accountId: text("account_id").references(() => adAccounts.id, {
      onDelete: "set null",
    }),
    adSetId: text("ad_set_id").references(() => adSets.id, {
      onDelete: "set null",
    }),
    actorPageId: text("actor_page_id"),
    actorInstagramId: text("actor_instagram_id"),

    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadLockedAt: timestamp("payload_locked_at").defaultNow().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),

    retryCount: integer("retry_count").notNull().default(0),
    lastRetryRequestedAt: timestamp("last_retry_requested_at"),
    lastRetryRequestedByUserId: text("last_retry_requested_by_user_id"),
    lastRetryRequestedByPrincipalType: launchpadPrincipalTypeEnum(
      "last_retry_requested_by_principal_type",
    ),
    lastRetryRequestedByRole: text("last_retry_requested_by_role"),

    requestedAdName: text("requested_ad_name"),
    externalMetaImageHash: text("external_meta_image_hash"),
    externalMetaVideoId: text("external_meta_video_id"),
    externalMetaCreativeId: text("external_meta_creative_id"),
    externalMetaAdId: text("external_meta_ad_id"),
    rawMetaConfiguredStatus: text("raw_meta_configured_status"),
    rawMetaEffectiveStatus: text("raw_meta_effective_status"),

    createdByUserId: text("created_by_user_id"),
    createdByPrincipalType: launchpadPrincipalTypeEnum(
      "created_by_principal_type",
    ).notNull(),
    createdByRole: text("created_by_role"),

    errorCategory: launchpadErrorCategoryEnum("error_category"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorDetails: jsonb("error_details").$type<Record<string, unknown> | null>(),

    reconciliationStatus: launchpadReconciliationStatusEnum(
      "reconciliation_status",
    )
      .notNull()
      .default("not_required"),
    reconciliationCheckedAt: timestamp("reconciliation_checked_at"),
    manualInterventionReason: text("manual_intervention_reason"),

    validatedAt: timestamp("validated_at"),
    queuedAt: timestamp("queued_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    skippedAt: timestamp("skipped_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("launchpad_item_run_idx").on(table.runId),
    index("launchpad_item_org_idx").on(table.organizationId),
    index("launchpad_item_status_idx").on(table.status),
    index("launchpad_item_creative_idx").on(table.creativeId),
    index("launchpad_item_local_ad_idx").on(table.localAdId),
    index("launchpad_item_external_meta_ad_idx").on(table.externalMetaAdId),
    index("launchpad_item_reconciliation_idx").on(table.reconciliationStatus),
    uniqueIndex("launchpad_item_run_position_uidx").on(table.runId, table.position),
    uniqueIndex("launchpad_item_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex("launchpad_item_org_dedupe_uidx").on(
      table.organizationId,
      table.dedupeKey,
    ),
  ],
);

export const launchpadSourceTemplateRelations = relations(
  launchpadSourceTemplates,
  ({ one }) => ({
    account: one(adAccounts, {
      fields: [launchpadSourceTemplates.accountId],
      references: [adAccounts.id],
    }),
    sourceCampaign: one(campaigns, {
      fields: [launchpadSourceTemplates.sourceCampaignId],
      references: [campaigns.id],
    }),
    sourceAdSet: one(adSets, {
      fields: [launchpadSourceTemplates.sourceAdSetId],
      references: [adSets.id],
    }),
  }),
);

export const launchpadPublishRunRelations = relations(
  launchpadPublishRuns,
  ({ many, one }) => ({
    account: one(adAccounts, {
      fields: [launchpadPublishRuns.actorAccountId],
      references: [adAccounts.id],
    }),
    destinationAdSet: one(adSets, {
      fields: [launchpadPublishRuns.destinationAdSetId],
      references: [adSets.id],
    }),
    items: many(launchpadPublishItems),
  }),
);

export const launchpadPublishItemRelations = relations(
  launchpadPublishItems,
  ({ one }) => ({
    run: one(launchpadPublishRuns, {
      fields: [launchpadPublishItems.runId],
      references: [launchpadPublishRuns.id],
    }),
    creative: one(adCreatives, {
      fields: [launchpadPublishItems.creativeId],
      references: [adCreatives.id],
    }),
    localAd: one(ads, {
      fields: [launchpadPublishItems.localAdId],
      references: [ads.id],
    }),
    account: one(adAccounts, {
      fields: [launchpadPublishItems.accountId],
      references: [adAccounts.id],
    }),
    adSet: one(adSets, {
      fields: [launchpadPublishItems.adSetId],
      references: [adSets.id],
    }),
  }),
);
