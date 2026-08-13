import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
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
import { shopifyStores } from "./shopify";
import type { GclidProbeSummary } from "@/lib/google-ads/types";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const googleAdsConnections = pgTable(
  "google_ads_connection",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    storeId: text("shopify_store_id").notNull(),
    googleCustomerId: text("google_customer_id"),
    descriptiveName: text("descriptive_name"),
    currencyCode: text("currency_code"),
    timezone: text("timezone"),
    status: text("status").notNull().default("pending"),
    authenticationMode: text("authentication_mode")
      .notNull()
      .default("environment"),
    credentialReference: text("credential_reference")
      .notNull()
      .default("reviv_environment"),
    lastDiscoverySyncedAt: timestamp("last_discovery_synced_at"),
    lastFactsSyncedAt: timestamp("last_facts_synced_at"),
    backfillCompletedAt: timestamp("backfill_completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("google_ads_connection_org_store_uniq").on(
      table.organizationId,
      table.storeId,
    ),
    unique("google_ads_connection_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    uniqueIndex("google_ads_connection_active_customer_uidx")
      .on(table.googleCustomerId)
      .where(
        sql`${table.googleCustomerId} is not null and ${table.status} <> 'disabled'`,
      ),
    foreignKey({
      name: "google_ads_connection_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    check(
      "google_ads_connection_status_check",
      sql`${table.status} in ('pending', 'ready', 'degraded', 'disabled')`,
    ),
    check(
      "google_ads_connection_auth_mode_check",
      sql`${table.authenticationMode} = 'environment'`,
    ),
    check(
      "google_ads_connection_credential_ref_check",
      sql`${table.credentialReference} = 'reviv_environment'`,
    ),
  ],
);

export const googleAdsSyncRuns = pgTable(
  "google_ads_sync_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    operation: text("operation").notNull(),
    /** Inclusive account-timezone day range; null for discovery runs. */
    windowFromDay: date("window_from_day"),
    windowToDay: date("window_to_day"),
    /** Last fully committed account-timezone day. */
    checkpointDay: date("checkpoint_day"),
    status: text("status").notNull().default("running"),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsUpserted: integer("rows_upserted").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    apiVersion: text("api_version").notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "google_ads_sync_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        googleAdsConnections.organizationId,
        googleAdsConnections.storeId,
        googleAdsConnections.id,
      ],
    }).onDelete("cascade"),
    index("google_ads_sync_run_connection_idx").on(
      table.connectionId,
      table.startedAt,
    ),
    uniqueIndex("google_ads_sync_run_one_running_discovery_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'discovery' and ${table.status} = 'running'`),
    uniqueIndex("google_ads_sync_run_one_running_facts_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'facts' and ${table.status} = 'running'`),
    check(
      "google_ads_sync_run_operation_check",
      sql`${table.operation} in ('discovery', 'facts')`,
    ),
    check(
      "google_ads_sync_run_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "google_ads_sync_run_window_check",
      sql`(${table.operation} = 'discovery' and ${table.windowFromDay} is null and ${table.windowToDay} is null)
        or (${table.operation} = 'facts' and ${table.windowFromDay} is not null and ${table.windowToDay} is not null
          and ${table.windowFromDay} <= ${table.windowToDay})`,
    ),
    check(
      "google_ads_sync_run_counters_check",
      sql`${table.rowsRead} >= 0 and ${table.rowsUpserted} >= 0 and ${table.failureCount} >= 0`,
    ),
  ],
);

export const googleAdsCampaignFacts = pgTable(
  "google_ads_campaign_fact",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    campaignName: text("campaign_name").notNull(),
    campaignStatus: text("campaign_status"),
    channelType: text("channel_type"),
    /** Google reporting day in the ad account's timezone. */
    factDate: date("fact_date").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    impressions: bigint("impressions", { mode: "number" }).notNull(),
    clicks: bigint("clicks", { mode: "number" }).notNull(),
    conversions: numeric("conversions").notNull(),
    conversionsValue: numeric("conversions_value").notNull(),
    currencyCode: text("currency_code"),
    apiVersion: text("api_version").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "google_ads_campaign_fact_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        googleAdsConnections.organizationId,
        googleAdsConnections.storeId,
        googleAdsConnections.id,
      ],
    }).onDelete("cascade"),
    unique("google_ads_campaign_fact_day_uniq").on(
      table.connectionId,
      table.campaignId,
      table.factDate,
    ),
    index("google_ads_campaign_fact_date_idx").on(
      table.connectionId,
      table.factDate,
    ),
    check(
      "google_ads_campaign_fact_nonnegative_check",
      sql`${table.costMicros} >= 0 and ${table.impressions} >= 0 and ${table.clicks} >= 0 and ${table.conversions} >= 0 and ${table.conversionsValue} >= 0`,
    ),
  ],
);

export const gclidProbeReports = pgTable(
  "gclid_probe_report",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    /** Inclusive store-day window scanned. */
    windowFromDay: date("window_from_day").notNull(),
    windowToDay: date("window_to_day").notNull(),
    status: text("status").notNull().default("running"),
    ordersScanned: integer("orders_scanned").notNull().default(0),
    summary: jsonb("summary").$type<GclidProbeSummary | null>(),
    /** sha256 of the canonical summary JSON; immutable once completed. */
    checksum: text("checksum"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "gclid_probe_report_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    index("gclid_probe_report_store_idx").on(table.storeId, table.createdAt),
    check(
      "gclid_probe_report_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "gclid_probe_report_window_check",
      sql`${table.windowFromDay} <= ${table.windowToDay}`,
    ),
    check(
      "gclid_probe_report_completed_shape_check",
      sql`(${table.status} <> 'completed') or (${table.summary} is not null and ${table.checksum} is not null)`,
    ),
  ],
);

export const googleAdsConnectionRelations = relations(
  googleAdsConnections,
  ({ many }) => ({
    syncRuns: many(googleAdsSyncRuns),
    campaignFacts: many(googleAdsCampaignFacts),
  }),
);

export const googleAdsSyncRunRelations = relations(
  googleAdsSyncRuns,
  ({ one }) => ({
    connection: one(googleAdsConnections, {
      fields: [googleAdsSyncRuns.connectionId],
      references: [googleAdsConnections.id],
    }),
  }),
);

export const googleAdsCampaignFactRelations = relations(
  googleAdsCampaignFacts,
  ({ one }) => ({
    connection: one(googleAdsConnections, {
      fields: [googleAdsCampaignFacts.connectionId],
      references: [googleAdsConnections.id],
    }),
  }),
);
