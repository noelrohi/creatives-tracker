import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { statusEnum } from "./enums";
import { adSets } from "./ad-set";
import { adCreatives } from "./ad-creative";
import { adAccounts } from "./account";

export const ads = pgTable(
  "ad",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Ad"),
    adSetId: text("ad_set_id").references(() => adSets.id, {
      onDelete: "set null",
    }),
    adCreativeId: text("ad_creative_id").references(
      () => adCreatives.id,
      { onDelete: "set null" },
    ),
    accountId: text("account_id").references(() => adAccounts.id, {
      onDelete: "set null",
    }),
    caption: text("caption"),
    destinationUrl: text("destination_url"),
    metaId: text("meta_id").unique(),
    organizationId: text("organization_id"),
    status: statusEnum("status").notNull().default("active"),
    notes: text("notes"),
    enrichmentAttemptedAt: timestamp("enrichment_attempted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ad_ad_set_id_idx").on(table.adSetId),
    index("ad_creative_id_idx").on(table.adCreativeId),
    index("ad_organization_id_idx").on(table.organizationId),
  ],
);

export const adRelations = relations(ads, ({ one }) => ({
  account: one(adAccounts, {
    fields: [ads.accountId],
    references: [adAccounts.id],
  }),
  adSet: one(adSets, {
    fields: [ads.adSetId],
    references: [adSets.id],
  }),
  adCreative: one(adCreatives, {
    fields: [ads.adCreativeId],
    references: [adCreatives.id],
  }),
}));
