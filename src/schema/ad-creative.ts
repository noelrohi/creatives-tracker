import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { landingPages } from "./landing-page";
import { formatEnum, awarenessLevelEnum } from "./enums";

export const adCreatives = pgTable(
  "ad_creative",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Creative"),
    assetUrl: text("asset_url"),
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
    notes: text("notes"),
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
    index("ad_creative_created_by_idx").on(table.createdBy),
    index("ad_creative_landing_page_id_idx").on(table.landingPageId),
    index("ad_creative_format_idx").on(table.format),
    index("ad_creative_awareness_level_idx").on(table.awarenessLevel),
  ],
);

export const adCreativeRelations = relations(adCreatives, ({ one }) => ({
  landingPage: one(landingPages, {
    fields: [adCreatives.landingPageId],
    references: [landingPages.id],
  }),
  creator: one(user, {
    fields: [adCreatives.createdBy],
    references: [user.id],
  }),
}));
