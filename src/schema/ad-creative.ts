import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { landingPages } from "./landing-page";
import { formatEnum, awarenessLevelEnum, ownershipEnum } from "./enums";

export const adCreatives = pgTable(
  "ad_creative",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Creative"),
    assetUrl: text("asset_url"),
    videoUrl: text("video_url"),
    format: formatEnum("format"),
    angle: text("angle"),
    persona: text("persona"),
    awarenessLevel: awarenessLevelEnum("awareness_level"),
    hook: text("hook"),
    tone: text("tone").array(),
    cta: text("cta"),
    landingPageId: text("landing_page_id").references(
      () => landingPages.id,
      { onDelete: "set null" },
    ),
    ownership: ownershipEnum("ownership"),
    notes: text("notes"),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ad_creative_landing_page_id_idx").on(table.landingPageId),
    index("ad_creative_format_idx").on(table.format),
    index("ad_creative_awareness_level_idx").on(table.awarenessLevel),
    index("ad_creative_organization_id_idx").on(table.organizationId),
  ],
);

export const adCreativeRelations = relations(adCreatives, ({ one }) => ({
  landingPage: one(landingPages, {
    fields: [adCreatives.landingPageId],
    references: [landingPages.id],
  }),
}));
