import { relations } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  date,
  index,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";

export const attributionBucketEnum = pgEnum("attribution_bucket", [
  "meta",
  "google",
  "klaviyo",
  "tiktok",
  "organic_direct",
  "unattributed",
  "untracked",
]);

export const shopifyStores = pgTable(
  "shopify_store",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    shopDomain: text("shop_domain").notNull().unique(),
    // Nullable: v1 reads the Admin API token from env, not the DB.
    accessToken: text("access_token"),
    ianaTimezone: text("iana_timezone").notNull(),
    currency: text("currency"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("shopify_store_organization_id_idx").on(table.organizationId)],
);

export const shopifyOrders = pgTable(
  "shopify_order",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => shopifyStores.id, { onDelete: "cascade" }),
    shopifyOrderId: text("shopify_order_id").notNull(),
    orderName: text("order_name"),
    // Shopify createdAt, UTC
    orderCreatedAt: timestamp("order_created_at").notNull(),
    orderUpdatedAt: timestamp("order_updated_at"),
    // Store-timezone day, derived at ingest
    orderDay: date("order_day").notNull(),
    netSales: numeric("net_sales").notNull(),
    taxesIncluded: boolean("taxes_included"),
    customerJourney: jsonb("customer_journey").$type<Record<
      string,
      unknown
    > | null>(),
    journeyReady: boolean("journey_ready").default(false).notNull(),
    pendingSince: timestamp("pending_since"),
    lastClickUtmSource: text("last_click_utm_source"),
    lastClickUtmMedium: text("last_click_utm_medium"),
    lastClickUtmCampaign: text("last_click_utm_campaign"),
    // Null = bucketing still pending
    bucket: attributionBucketEnum("bucket"),
    bucketRuleVersion: integer("bucket_rule_version"),
    metaVerified: boolean("meta_verified").default(false).notNull(),
    metaCampaignId: text("meta_campaign_id"),
    verificationPending: boolean("verification_pending")
      .default(false)
      .notNull(),
    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason"),
    // Shopify source_name: web/pos/draft/subscription detection
    orderSourceName: text("order_source_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("shopify_order_store_order_uniq").on(
      table.storeId,
      table.shopifyOrderId,
    ),
    index("shopify_order_organization_id_idx").on(table.organizationId),
    index("shopify_order_org_store_day_idx").on(
      table.organizationId,
      table.storeId,
      table.orderDay,
    ),
    index("shopify_order_org_store_bucket_idx").on(
      table.organizationId,
      table.storeId,
      table.bucket,
    ),
  ],
);

export const shopifyRefunds = pgTable(
  "shopify_refund",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => shopifyStores.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .references(() => shopifyOrders.id, { onDelete: "cascade" }),
    shopifyRefundId: text("shopify_refund_id").notNull(),
    // Store-timezone day
    refundDay: date("refund_day").notNull(),
    // Σ refundLineItems.subtotalSet, tax-adjusted — computed at ingest
    amount: numeric("amount").notNull(),
    /**
     * "refund" = a real Shopify refund; "cancellation" = the give-back a
     * cancelled order books on its cancel day when Shopify recorded no refund
     * of its own (spec §5.3). Both sides of the identity read the same column.
     */
    kind: text("kind").default("refund").notNull(),
    refundCreatedAt: timestamp("refund_created_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("shopify_refund_store_refund_uniq").on(
      table.storeId,
      table.shopifyRefundId,
    ),
    index("shopify_refund_organization_id_idx").on(table.organizationId),
    index("shopify_refund_org_store_day_idx").on(
      table.organizationId,
      table.storeId,
      table.refundDay,
    ),
  ],
);

export const shopifySyncRuns = pgTable(
  "shopify_sync_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => shopifyStores.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(),
    // "backfill" | "incremental" | "rebucket"
    phase: text("phase").notNull(),
    dateFrom: date("date_from"),
    dateTo: date("date_to"),
    result: text("result"),
    ordersSynced: integer("orders_synced"),
    error: text("error"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index("shopify_sync_run_organization_id_idx").on(table.organizationId),
    index("shopify_sync_run_org_store_requested_at_idx").on(
      table.organizationId,
      table.storeId,
      table.requestedAt,
    ),
  ],
);

export const shopifyStoreRelations = relations(shopifyStores, ({ many }) => ({
  orders: many(shopifyOrders),
  refunds: many(shopifyRefunds),
  syncRuns: many(shopifySyncRuns),
}));

export const shopifyOrderRelations = relations(
  shopifyOrders,
  ({ one, many }) => ({
    store: one(shopifyStores, {
      fields: [shopifyOrders.storeId],
      references: [shopifyStores.id],
    }),
    refunds: many(shopifyRefunds),
  }),
);

export const shopifyRefundRelations = relations(shopifyRefunds, ({ one }) => ({
  order: one(shopifyOrders, {
    fields: [shopifyRefunds.orderId],
    references: [shopifyOrders.id],
  }),
  store: one(shopifyStores, {
    fields: [shopifyRefunds.storeId],
    references: [shopifyStores.id],
  }),
}));

export const shopifySyncRunRelations = relations(shopifySyncRuns, ({ one }) => ({
  store: one(shopifyStores, {
    fields: [shopifySyncRuns.storeId],
    references: [shopifyStores.id],
  }),
}));
