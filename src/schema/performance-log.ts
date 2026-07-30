import { relations } from "drizzle-orm";
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
import { ads } from "./ad";

export const performanceLogs = pgTable(
  "performance_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    adId: text("ad_id")
      .notNull()
      .references(() => ads.id, { onDelete: "cascade" }),
    metaAdId: text("meta_ad_id"),
    // Core metrics
    roas: numeric("roas"),
    cpa: numeric("cpa"),
    ctr: numeric("ctr"),
    conversionRate: numeric("conversion_rate"),
    spend: numeric("spend"),
    conversions: integer("conversions"),
    // Reach & delivery
    impressions: integer("impressions"),
    reach: integer("reach"),
    frequency: numeric("frequency"),
    cpm: numeric("cpm"),
    // Clicks & engagement
    linkClicks: integer("link_clicks"),
    clicksAll: integer("clicks_all"),
    cpc: numeric("cpc"),
    ctrLinkClick: numeric("ctr_link_click"),
    // Landing page
    landingPageViews: integer("landing_page_views"),
    costPerLpv: numeric("cost_per_lpv"),
    // Purchase value
    purchaseValue: numeric("purchase_value"),
    purchaseValue7dClick: numeric("purchase_value_7d_click"),
    purchaseValue1dView: numeric("purchase_value_1d_view"),
    attributionWindows: text("attribution_windows"),
    // Ecom funnel
    addToCart: integer("add_to_cart"),
    initiateCheckout: integer("initiate_checkout"),
    costPerAddToCart: numeric("cost_per_add_to_cart"),
    // Video metrics
    videoViews3s: integer("video_views_3s"),
    videoThruplay: integer("video_thruplay"),
    videoAvgWatchTime: numeric("video_avg_watch_time"),
    // Breakdowns
    country: text("country"),
    platform: text("platform"),
    placement: text("placement"),
    device: text("device"),
    age: text("age"),
    gender: text("gender"),
    // Ad quality (from Meta)
    qualityRanking: text("quality_ranking"),
    engagementRateRanking: text("engagement_rate_ranking"),
    conversionRateRanking: text("conversion_rate_ranking"),
    // Date range
    dateStart: date("date_start").notNull(),
    dateEnd: date("date_end").notNull(),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("performance_log_ad_id_idx").on(table.adId),
    index("performance_log_organization_id_idx").on(table.organizationId),
    index("performance_log_meta_ad_id_idx").on(table.metaAdId),
    index("performance_log_org_ad_date_idx").on(
      table.organizationId,
      table.adId,
      table.dateStart,
      table.dateEnd,
    ),
    unique("performance_log_ad_date_breakdown_uniq")
      .on(
        table.adId,
        table.dateStart,
        table.dateEnd,
        table.country,
        table.platform,
        table.placement,
        table.device,
        table.age,
        table.gender,
      )
      .nullsNotDistinct(),
  ],
);

export const performanceLogRelations = relations(performanceLogs, ({ one }) => ({
  ad: one(ads, {
    fields: [performanceLogs.adId],
    references: [ads.id],
  }),
}));
