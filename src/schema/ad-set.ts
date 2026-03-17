import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { user, organization } from "./auth";
import { adCreatives } from "./ad-creative";
import { landingPageVersions } from "./landing-page";
import { campaignConfigs } from "./campaign-config";

export const adSets = pgTable(
  "ad_set",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Ad Set"),
    adCreativeId: text("ad_creative_id").references(
      () => adCreatives.id,
      { onDelete: "set null" },
    ),
    landingPageVersionId: text("landing_page_version_id").references(
      () => landingPageVersions.id,
      { onDelete: "set null" },
    ),
    campaignConfigId: text("campaign_config_id").references(
      () => campaignConfigs.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
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
    index("ad_set_organization_id_idx").on(table.organizationId),
    index("ad_set_created_by_idx").on(table.createdBy),
    index("ad_set_ad_creative_id_idx").on(table.adCreativeId),
    index("ad_set_lp_version_id_idx").on(table.landingPageVersionId),
    index("ad_set_campaign_config_id_idx").on(table.campaignConfigId),
  ],
);

export const adSetRelations = relations(adSets, ({ one }) => ({
  adCreative: one(adCreatives, {
    fields: [adSets.adCreativeId],
    references: [adCreatives.id],
  }),
  landingPageVersion: one(landingPageVersions, {
    fields: [adSets.landingPageVersionId],
    references: [landingPageVersions.id],
  }),
  campaignConfig: one(campaignConfigs, {
    fields: [adSets.campaignConfigId],
    references: [campaignConfigs.id],
  }),
  creator: one(user, {
    fields: [adSets.createdBy],
    references: [user.id],
  }),
}));
