import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { objectiveEnum } from "./enums";

export const campaignConfigs = pgTable(
  "campaign_config",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Campaign"),
    objective: objectiveEnum("objective"),
    costCap: text("cost_cap"),
    targetingMethod: text("targeting_method").array(),
    demographics: text("demographics"),
    geos: text("geos").array(),
    dailyBudget: numeric("daily_budget"),
    placements: text("placements").array(),
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
  (table) => [index("campaign_config_created_by_idx").on(table.createdBy)],
);

export const campaignConfigRelations = relations(campaignConfigs, ({ one }) => ({
  creator: one(user, {
    fields: [campaignConfigs.createdBy],
    references: [user.id],
  }),
}));
