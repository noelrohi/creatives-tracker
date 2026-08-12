import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  date,
  index,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Indefinite monthly rollup of daily base performance rows, one row per
 * organization and calendar month (`month` is the first day of the month).
 *
 * Only additive sums are stored — ROAS, CPA, CTR and friends are derived at
 * read time. Reach is deliberately absent because daily reach cannot be
 * summed across days. Rolled up before retention deletes base rows, so a
 * month's summary is captured while its source rows still exist.
 */
export const performanceMonthlySummaries = pgTable(
  "performance_monthly_summary",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // App-owned org scoping without FK, same as other org_* tables.
    organizationId: text("organization_id").notNull(),
    month: date("month").notNull(),
    spend: numeric("spend"),
    purchaseValue: numeric("purchase_value"),
    purchaseValue7dClick: numeric("purchase_value_7d_click"),
    purchaseValue1dView: numeric("purchase_value_1d_view"),
    conversions: integer("conversions"),
    impressions: integer("impressions"),
    linkClicks: integer("link_clicks"),
    clicksAll: integer("clicks_all"),
    landingPageViews: integer("landing_page_views"),
    addToCart: integer("add_to_cart"),
    initiateCheckout: integer("initiate_checkout"),
    videoViews3s: integer("video_views_3s"),
    videoThruplay: integer("video_thruplay"),
    daysWithData: integer("days_with_data").notNull().default(0),
    sourceRowCount: integer("source_row_count").notNull().default(0),
    rolledUpAt: timestamp("rolled_up_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("performance_monthly_summary_org_month_uniq").on(
      table.organizationId,
      table.month,
    ),
    index("performance_monthly_summary_org_idx").on(table.organizationId),
  ],
);
