import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { user, organization } from "./auth";
import { pageTypeEnum, funnelPositionEnum } from "./enums";

export const landingPages = pgTable(
  "landing_page",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    url: text("url").notNull(),
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
    index("landing_page_organization_id_idx").on(table.organizationId),
    index("landing_page_created_by_idx").on(table.createdBy),
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
    screenshotUrl: text("screenshot_url"),
    pageType: pageTypeEnum("page_type").notNull(),
    heroCopy: text("hero_copy").notNull(),
    benefits: text("benefits").array().notNull(),
    socialProofType: text("social_proof_type").array().notNull(),
    funnelPosition: funnelPositionEnum("funnel_position").notNull(),
    notes: text("notes"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("lp_version_landing_page_id_idx").on(table.landingPageId),
    index("lp_version_organization_id_idx").on(table.organizationId),
    index("lp_version_created_by_idx").on(table.createdBy),
  ],
);

export const landingPageRelations = relations(landingPages, ({ many, one }) => ({
  versions: many(landingPageVersions),
  creator: one(user, {
    fields: [landingPages.createdBy],
    references: [user.id],
  }),
}));

export const landingPageVersionRelations = relations(
  landingPageVersions,
  ({ one }) => ({
    landingPage: one(landingPages, {
      fields: [landingPageVersions.landingPageId],
      references: [landingPages.id],
    }),
    creator: one(user, {
      fields: [landingPageVersions.createdBy],
      references: [user.id],
    }),
  }),
);
