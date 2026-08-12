import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import {
  awarenessLevelEnum,
  funnelStageEnum,
  lpClassificationStatusEnum,
  pageTypeEnum,
} from "./enums";

export const landingPages = pgTable(
  "landing_page",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    family: text("family"),
    firstSeenInAdsAt: timestamp("first_seen_in_ads_at"),
    firstSeenInJourneysAt: timestamp("first_seen_in_journeys_at"),
    pageType: pageTypeEnum("page_type"),
    funnelStage: funnelStageEnum("funnel_stage"),
    awarenessFit: awarenessLevelEnum("awareness_fit"),
    classificationStatus: lpClassificationStatusEnum("classification_status"),
    classificationSource: text("classification_source"),
    classificationConfidence: numeric("classification_confidence"),
    contentHash: text("content_hash"),
    classifiedAt: timestamp("classified_at"),
    confirmedAt: timestamp("confirmed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("landing_page_org_normalized_url_uniq").on(
      table.organizationId,
      table.normalizedUrl,
    ),
    index("landing_page_org_family_idx").on(
      table.organizationId,
      table.family,
    ),
  ],
);
