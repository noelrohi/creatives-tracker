import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { pageTypeEnum, funnelPositionEnum } from "./enums";

export const landingPages = pgTable(
  "landing_page",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    url: text("url").notNull(),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("landing_page_organization_id_idx").on(table.organizationId),
  ],
);

export const landingPageVersions = pgTable(
  "landing_page_version",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    landingPageId: text("landing_page_id")
      .notNull()
      .references(() => landingPages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    url: text("url"),
    screenshotUrl: text("screenshot_url"),
    pageType: pageTypeEnum("page_type").notNull(),
    heroCopy: text("hero_copy").notNull(),
    benefits: text("benefits").array().notNull(),
    socialProofType: text("social_proof_type").array().notNull(),
    funnelPosition: funnelPositionEnum("funnel_position").notNull(),
    notes: text("notes"),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("lp_version_landing_page_id_idx").on(table.landingPageId),
    index("lp_version_organization_id_idx").on(table.organizationId),
  ],
);

export const landingPageRelations = relations(landingPages, ({ many }) => ({
  versions: many(landingPageVersions),
}));

export const landingPageVersionRelations = relations(
  landingPageVersions,
  ({ one }) => ({
    landingPage: one(landingPages, {
      fields: [landingPageVersions.landingPageId],
      references: [landingPages.id],
    }),
  }),
);
