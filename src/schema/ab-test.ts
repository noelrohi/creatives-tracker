import { relations } from "drizzle-orm";
import { pgTable, pgEnum, text, timestamp, index } from "drizzle-orm/pg-core";
import { user, organization } from "./auth";
import { adSets } from "./ad-set";

export const abTestStatusEnum = pgEnum("ab_test_status", [
  "running",
  "completed",
  "paused",
]);

export const abTests = pgTable(
  "ab_test",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Test"),
    hypothesis: text("hypothesis"),
    status: abTestStatusEnum("status").notNull().default("running"),
    winnerVariantId: text("winner_variant_id").references(() => adSets.id, {
      onDelete: "set null",
    }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ab_test_organization_id_idx").on(table.organizationId),
    index("ab_test_created_by_idx").on(table.createdBy),
  ],
);

export const abTestRelations = relations(abTests, ({ one, many }) => ({
  winnerVariant: one(adSets, {
    fields: [abTests.winnerVariantId],
    references: [adSets.id],
  }),
  creator: one(user, {
    fields: [abTests.createdBy],
    references: [user.id],
  }),
  variants: many(abTestVariants),
}));

export const abTestVariants = pgTable(
  "ab_test_variant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    abTestId: text("ab_test_id")
      .notNull()
      .references(() => abTests.id, { onDelete: "cascade" }),
    adSetId: text("ad_set_id")
      .notNull()
      .references(() => adSets.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("variant"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ab_test_variant_ab_test_id_idx").on(table.abTestId),
    index("ab_test_variant_ad_set_id_idx").on(table.adSetId),
    index("ab_test_variant_organization_id_idx").on(table.organizationId),
  ],
);

export const abTestVariantRelations = relations(abTestVariants, ({ one }) => ({
  abTest: one(abTests, {
    fields: [abTestVariants.abTestId],
    references: [abTests.id],
  }),
  adSet: one(adSets, {
    fields: [abTestVariants.adSetId],
    references: [adSets.id],
  }),
}));
