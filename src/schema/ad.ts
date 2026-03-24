import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { statusEnum } from "./enums";
import { adSets } from "./ad-set";
import { adCreatives } from "./ad-creative";
import { landingPageVersions } from "./landing-page";
import { accounts } from "./account";

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
    landingPageVersionId: text("landing_page_version_id").references(
      () => landingPageVersions.id,
      { onDelete: "set null" },
    ),
    accountId: text("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    metaId: text("meta_id").unique(),
    status: statusEnum("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ad_ad_set_id_idx").on(table.adSetId),
    index("ad_creative_id_idx").on(table.adCreativeId),
    index("ad_lp_version_id_idx").on(table.landingPageVersionId),
  ],
);

export const adRelations = relations(ads, ({ one }) => ({
  account: one(accounts, {
    fields: [ads.accountId],
    references: [accounts.id],
  }),
  adSet: one(adSets, {
    fields: [ads.adSetId],
    references: [adSets.id],
  }),
  adCreative: one(adCreatives, {
    fields: [ads.adCreativeId],
    references: [adCreatives.id],
  }),
  landingPageVersion: one(landingPageVersions, {
    fields: [ads.landingPageVersionId],
    references: [landingPageVersions.id],
  }),
}));
