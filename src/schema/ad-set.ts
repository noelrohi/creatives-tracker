import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { statusEnum } from "./enums";
import { campaigns } from "./campaign";

export const adSets = pgTable(
  "ad_set",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Ad Set"),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    costCap: text("cost_cap"),
    dailyBudget: numeric("daily_budget"),
    targetingMethod: text("targeting_method").array(),
    geos: text("geos").array(),
    placements: text("placements").array(),
    demographics: text("demographics"),
    scheduleStart: timestamp("schedule_start"),
    scheduleEnd: timestamp("schedule_end"),
    metaId: text("meta_id").unique(),
    organizationId: text("organization_id"),
    status: statusEnum("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ad_set_campaign_id_idx").on(table.campaignId),
    index("ad_set_organization_id_idx").on(table.organizationId),
  ],
);

export const adSetRelations = relations(adSets, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [adSets.campaignId],
    references: [campaigns.id],
  }),
}));
