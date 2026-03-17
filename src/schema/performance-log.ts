import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  date,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { adSets } from "./ad-set";

export const performanceLogs = pgTable(
  "performance_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    adSetId: text("ad_set_id")
      .notNull()
      .references(() => adSets.id, { onDelete: "cascade" }),
    roas: numeric("roas"),
    cpa: numeric("cpa"),
    ctr: numeric("ctr"),
    conversionRate: numeric("conversion_rate"),
    spend: numeric("spend"),
    conversions: integer("conversions"),
    dateStart: date("date_start").notNull(),
    dateEnd: date("date_end").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("performance_log_ad_set_id_idx").on(table.adSetId),
    index("performance_log_organization_id_idx").on(table.organizationId),
  ],
);

export const performanceLogRelations = relations(performanceLogs, ({ one }) => ({
  adSet: one(adSets, {
    fields: [performanceLogs.adSetId],
    references: [adSets.id],
  }),
}));
