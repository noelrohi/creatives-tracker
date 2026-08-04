import { relations } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  date,
  index,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";
import { shopifyStores } from "./shopify";

export const findingTypeEnum = pgEnum("finding_type", [
  "meta_overclaim",
  "unattributed_spike",
  "broken_utm_template",
  "sync_failure",
  "roas_below_target",
  "ad_lp_funnel_mismatch",
  "untagged_spend",
  "utm_template_drift",
]);

/** How a finding closed: someone dealt with it, or its rule stopped holding. */
export const findingResolutionEnum = pgEnum("finding_resolution", [
  "handled",
  "retired",
]);

export const findings = pgTable(
  "finding",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").references(() => shopifyStores.id, {
      onDelete: "cascade",
    }),
    type: findingTypeEnum("type").notNull(),
    firedAt: timestamp("fired_at").defaultNow().notNull(),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    // Numbers frozen at fire time
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    resolvedAt: timestamp("resolved_at"),
    // Null on rows closed before the distinction existed — they say nothing.
    resolution: findingResolutionEnum("resolution"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("finding_organization_id_idx").on(table.organizationId),
    index("finding_org_store_fired_at_idx").on(
      table.organizationId,
      table.storeId,
      table.firedAt,
    ),
  ],
);

export const findingMutes = pgTable(
  "finding_mute",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    type: findingTypeEnum("type").notNull(),
    mutedUntil: timestamp("muted_until").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("finding_mute_org_type_uniq").on(table.organizationId, table.type),
  ],
);

export const findingRelations = relations(findings, ({ one }) => ({
  store: one(shopifyStores, {
    fields: [findings.storeId],
    references: [shopifyStores.id],
  }),
}));
