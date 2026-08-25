import { relations } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { funnelStageEnum, statusEnum } from "./enums";
import { adSets } from "./ad-set";
import { adCreatives } from "./ad-creative";
import { adAccounts } from "./account";
import { landingPages } from "./landing-page";

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
    urlTags: text("url_tags"),
    urlTagsCheckedAt: timestamp("url_tags_checked_at"),
    funnelStage: funnelStageEnum("funnel_stage"),
    funnelStageSource: text("funnel_stage_source"),
    funnelStageConfidence: numeric("funnel_stage_confidence"),
    landingPageId: text("landing_page_id").references(() => landingPages.id, {
      onDelete: "set null",
    }),
    metaId: text("meta_id").unique(),
    metaImageHash: text("meta_image_hash"),
    metaVideoId: text("meta_video_id"),
    metaCreativeId: text("meta_creative_id"),
    rawMetaConfiguredStatus: text("raw_meta_configured_status"),
    rawMetaEffectiveStatus: text("raw_meta_effective_status"),
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
    index("ad_funnel_stage_idx").on(table.funnelStage),
    index("ad_landing_page_id_idx").on(table.landingPageId),
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
