import { relations } from "drizzle-orm";
import { pgTable, pgEnum, text, timestamp, index } from "drizzle-orm/pg-core";
import { ads } from "./ad";

export const abTestStatusEnum = pgEnum("ab_test_status", [
  "running",
  "completed",
  "paused",
]);

export const abTests = pgTable("ab_test", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().default("Untitled Test"),
  hypothesis: text("hypothesis"),
  status: abTestStatusEnum("status").notNull().default("running"),
  winnerVariantId: text("winner_variant_id").references(() => ads.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const abTestRelations = relations(abTests, ({ one, many }) => ({
  winnerVariant: one(ads, {
    fields: [abTests.winnerVariantId],
    references: [ads.id],
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
    adId: text("ad_id")
      .notNull()
      .references(() => ads.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("variant"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ab_test_variant_ab_test_id_idx").on(table.abTestId),
    index("ab_test_variant_ad_id_idx").on(table.adId),
  ],
);

export const abTestVariantRelations = relations(abTestVariants, ({ one }) => ({
  abTest: one(abTests, {
    fields: [abTestVariants.abTestId],
    references: [abTests.id],
  }),
  ad: one(ads, {
    fields: [abTestVariants.adId],
    references: [ads.id],
  }),
}));
