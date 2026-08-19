import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const competitorStatusEnum = pgEnum("competitor_status", [
  "active",
  "archived",
]);

export const intelSourceEnum = pgEnum("intel_source", [
  "meta_ads_collector",
  "scrapecreators",
]);

export const intelPipelineStatusEnum = pgEnum("intel_pipeline_status", [
  "received",
  "mirroring",
  "scoring",
  "complete",
  "failed",
]);

export const clusterTierEnum = pgEnum("cluster_tier", [
  "high",
  "moderate",
  "watch",
]);

export const clusterVerdictEnum = pgEnum("cluster_verdict", [
  "high",
  "medium",
  "low",
]);

export const testPlanFormatEnum = pgEnum("test_plan_format", [
  "static",
  "video",
]);

export const testPlanAdStatusEnum = pgEnum("test_plan_ad_status", [
  "proposed",
  "approved",
  "testing",
  "done",
  "rejected",
]);

export const testPlanHookRatingEnum = pgEnum("test_plan_hook_rating", [
  "up",
  "down",
]);

export const planRuleSourceEnum = pgEnum("plan_rule_source", [
  "feedback",
  "manual",
]);

type CompetitorAdVariant = {
  bodyText: string | null;
  title: string | null;
  linkUrl: string | null;
  media: Record<string, unknown> | null;
};

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const competitors = pgTable(
  "competitor",
  {
    id: id(),
    organizationId: text("organization_id"),
    metaPageId: text("meta_page_id").notNull(),
    name: text("name").notNull(),
    status: competitorStatusEnum("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("competitor_organization_id_meta_page_id_uidx").on(
      table.organizationId,
      table.metaPageId,
    ),
    index("competitor_organization_id_idx").on(table.organizationId),
  ],
);

export const intelSnapshots = pgTable(
  "intel_snapshot",
  {
    id: id(),
    organizationId: text("organization_id"),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    source: intelSourceEnum("source").notNull(),
    adCount: integer("ad_count").notNull(),
    pipelineStatus: intelPipelineStatusEnum("pipeline_status")
      .notNull()
      .default("received"),
    error: text("error"),
    mirroredCount: integer("mirrored_count").notNull().default(0),
    filledAt: timestamp("filled_at").defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    index("intel_snapshot_organization_id_idx").on(table.organizationId),
    index("intel_snapshot_competitor_id_idx").on(table.competitorId),
  ],
);

export const copyClusters = pgTable(
  "copy_cluster",
  {
    id: id(),
    organizationId: text("organization_id"),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => intelSnapshots.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    angle: text("angle"),
    summary: text("summary").notNull(),
    adCount: integer("ad_count").notNull(),
    score: doublePrecision("score"),
    tier: clusterTierEnum("tier"),
    longevityPoints: doublePrecision("longevity_points"),
    variantPoints: doublePrecision("variant_points"),
    strategicPoints: doublePrecision("strategic_points"),
    formatPoints: doublePrecision("format_points"),
    landingPoints: doublePrecision("landing_points"),
    verdict: clusterVerdictEnum("verdict"),
    verdictRationale: text("verdict_rationale"),
    ...timestamps,
  },
  (table) => [
    index("copy_cluster_organization_id_idx").on(table.organizationId),
    index("copy_cluster_competitor_id_idx").on(table.competitorId),
  ],
);

export const competitorAds = pgTable(
  "competitor_ad",
  {
    id: id(),
    organizationId: text("organization_id"),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    archiveId: text("archive_id").notNull(),
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date"),
    bodyText: text("body_text").notNull(),
    title: text("title"),
    linkUrl: text("link_url").notNull(),
    linkDescription: text("link_description"),
    ctaText: text("cta_text"),
    ctaType: text("cta_type"),
    displayFormat: text("display_format").notNull(),
    publisherPlatforms: jsonb("publisher_platforms")
      .$type<string[]>()
      .notNull(),
    collationId: text("collation_id"),
    collationCount: integer("collation_count"),
    variants: jsonb("variants").$type<CompetitorAdVariant[]>().notNull(),
    /**
     * The media kinds this ad's creatives carry, resolved by the harness from
     * the source creatives (§4). Format breadth scores from this rather than
     * from the mirrored columns, so a cluster's score describes the competitor
     * and not how much of their media we happened to copy. Empty on rows filled
     * before the field existed — those fall back to the mirror.
     */
    mediaKinds: jsonb("media_kinds")
      .$type<("image" | "video")[]>()
      .notNull()
      .default([]),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    mirroredImageUrl: text("mirrored_image_url"),
    mirroredVideoUrl: text("mirrored_video_url"),
    mirroredPreviewUrl: text("mirrored_preview_url"),
    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    noLongerSeenAt: timestamp("no_longer_seen_at"),
    copyClusterId: text("copy_cluster_id").references(() => copyClusters.id, {
      onDelete: "set null",
    }),
    lastSnapshotId: text("last_snapshot_id").references(
      () => intelSnapshots.id,
      { onDelete: "set null" },
    ),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("competitor_ad_organization_id_archive_id_uidx").on(
      table.organizationId,
      table.archiveId,
    ),
    index("competitor_ad_organization_id_idx").on(table.organizationId),
    index("competitor_ad_competitor_id_idx").on(table.competitorId),
  ],
);

export const testPlanConcepts = pgTable(
  "test_plan_concept",
  {
    id: id(),
    organizationId: text("organization_id"),
    title: text("title").notNull(),
    angle: text("angle").notNull(),
    audience: text("audience").notNull(),
    evidenceClusterIds: jsonb("evidence_cluster_ids")
      .$type<string[]>()
      .notNull(),
    evidenceCitation: text("evidence_citation").notNull(),
    measurementPlan: text("measurement_plan").notNull(),
    claimGuardrail: text("claim_guardrail"),
    hooks: jsonb("hooks").$type<string[]>().notNull(),
    /**
     * Per-hook ad copy, one entry per hook in `hooks`. Nullable: concepts
     * generated before the field existed degrade to a hook-only row.
     */
    hookCopy: jsonb("hook_copy").$type<
      { hook: string; headline: string; description: string; cta: string }[]
    >(),
    generatedSnapshotId: text("generated_snapshot_id").references(
      () => intelSnapshots.id,
      { onDelete: "set null" },
    ),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    index("test_plan_concept_organization_id_idx").on(table.organizationId),
  ],
);

export const testPlanAds = pgTable(
  "test_plan_ad",
  {
    id: id(),
    organizationId: text("organization_id"),
    conceptId: text("concept_id")
      .notNull()
      .references(() => testPlanConcepts.id, { onDelete: "cascade" }),
    hook: text("hook").notNull(),
    format: testPlanFormatEnum("format").notNull(),
    status: testPlanAdStatusEnum("status").notNull().default("proposed"),
    sortOrder: integer("sort_order").notNull(),
    ...timestamps,
  },
  (table) => [
    index("test_plan_ad_organization_id_idx").on(table.organizationId),
  ],
);

export const planRules = pgTable(
  "plan_rule",
  {
    id: id(),
    organizationId: text("organization_id"),
    text: text("text").notNull(),
    source: planRuleSourceEnum("source").notNull(),
    active: boolean("active").notNull().default(true),
    /**
     * Snapshotted at creation — the comment author for promoted rules, the
     * creator for manual ones. Snapshot because comments cascade-delete.
     */
    attributionName: text("attribution_name").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [index("plan_rule_organization_id_idx").on(table.organizationId)],
);

export const testPlanHookFeedback = pgTable(
  "test_plan_hook_feedback",
  {
    id: id(),
    organizationId: text("organization_id"),
    conceptId: text("concept_id")
      .notNull()
      .references(() => testPlanConcepts.id, { onDelete: "cascade" }),
    hook: text("hook").notNull(),
    rating: testPlanHookRatingEnum("rating").notNull(),
    /** Reason slugs from `HOOK_FEEDBACK_REASONS`; meaningful only while down. */
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("test_plan_hook_feedback_concept_id_hook_uidx").on(
      table.conceptId,
      table.hook,
    ),
    index("test_plan_hook_feedback_organization_id_idx").on(
      table.organizationId,
    ),
  ],
);

export const testPlanComments = pgTable(
  "test_plan_comment",
  {
    id: id(),
    organizationId: text("organization_id"),
    conceptId: text("concept_id")
      .notNull()
      .references(() => testPlanConcepts.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id),
    text: text("text").notNull(),
    promotedRuleId: text("promoted_rule_id").references(() => planRules.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    index("test_plan_comment_organization_id_idx").on(table.organizationId),
  ],
);

export const competitorRelations = relations(competitors, ({ many }) => ({
  snapshots: many(intelSnapshots),
  ads: many(competitorAds),
  copyClusters: many(copyClusters),
}));

export const intelSnapshotRelations = relations(
  intelSnapshots,
  ({ one, many }) => ({
    competitor: one(competitors, {
      fields: [intelSnapshots.competitorId],
      references: [competitors.id],
    }),
    ads: many(competitorAds),
    copyClusters: many(copyClusters),
    generatedConcepts: many(testPlanConcepts),
  }),
);

export const copyClusterRelations = relations(
  copyClusters,
  ({ one, many }) => ({
    competitor: one(competitors, {
      fields: [copyClusters.competitorId],
      references: [competitors.id],
    }),
    snapshot: one(intelSnapshots, {
      fields: [copyClusters.snapshotId],
      references: [intelSnapshots.id],
    }),
    ads: many(competitorAds),
  }),
);

export const competitorAdRelations = relations(competitorAds, ({ one }) => ({
  competitor: one(competitors, {
    fields: [competitorAds.competitorId],
    references: [competitors.id],
  }),
  copyCluster: one(copyClusters, {
    fields: [competitorAds.copyClusterId],
    references: [copyClusters.id],
  }),
  lastSnapshot: one(intelSnapshots, {
    fields: [competitorAds.lastSnapshotId],
    references: [intelSnapshots.id],
  }),
}));

export const testPlanConceptRelations = relations(
  testPlanConcepts,
  ({ one, many }) => ({
    generatedSnapshot: one(intelSnapshots, {
      fields: [testPlanConcepts.generatedSnapshotId],
      references: [intelSnapshots.id],
    }),
    ads: many(testPlanAds),
    feedback: many(testPlanHookFeedback),
    comments: many(testPlanComments),
  }),
);

export const testPlanAdRelations = relations(testPlanAds, ({ one }) => ({
  concept: one(testPlanConcepts, {
    fields: [testPlanAds.conceptId],
    references: [testPlanConcepts.id],
  }),
}));

export const testPlanHookFeedbackRelations = relations(
  testPlanHookFeedback,
  ({ one }) => ({
    concept: one(testPlanConcepts, {
      fields: [testPlanHookFeedback.conceptId],
      references: [testPlanConcepts.id],
    }),
  }),
);

export const testPlanCommentRelations = relations(
  testPlanComments,
  ({ one }) => ({
    concept: one(testPlanConcepts, {
      fields: [testPlanComments.conceptId],
      references: [testPlanConcepts.id],
    }),
    author: one(user, {
      fields: [testPlanComments.authorUserId],
      references: [user.id],
    }),
    promotedRule: one(planRules, {
      fields: [testPlanComments.promotedRuleId],
      references: [planRules.id],
    }),
  }),
);

export const planRuleRelations = relations(planRules, ({ one, many }) => ({
  createdBy: one(user, {
    fields: [planRules.createdByUserId],
    references: [user.id],
  }),
  promotedFromComments: many(testPlanComments),
}));
