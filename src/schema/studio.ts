import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SuggestionElements } from "@/lib/studio-suggestions";
import { adCreatives } from "./ad-creative";
import { awarenessLevelEnum } from "./enums";

export const studioTaxonomyValues = pgTable(
  "studio_taxonomy_value",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("studio_taxonomy_value_org_kind_slug_uidx").on(
      table.organizationId,
      table.kind,
      table.slug,
    ),
    index("studio_taxonomy_value_org_kind_idx").on(
      table.organizationId,
      table.kind,
    ),
  ],
);

/**
 * One row per organization: who "our brand" is when Studio prompts say
 * "replace with ours". The product image rides along as an extra reference
 * image so the model renders the real product instead of inventing one.
 */
export const studioBrandProfiles = pgTable(
  "studio_brand_profile",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    brandName: text("brand_name").notNull(),
    productDescription: text("product_description").notNull(),
    offer: text("offer"),
    productImageUrl: text("product_image_url"),
    // Accuracy notes the product photo can't carry (e.g. a shallow blind-
    // debossed wordmark); injected into every generation prompt.
    productNotes: text("product_notes"),
    prohibitedClaims: jsonb("prohibited_claims")
      .$type<string[]>()
      .notNull()
      .default([]),
    requiredDisclaimers: jsonb("required_disclaimers")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("studio_brand_profile_org_uidx").on(table.organizationId),
  ],
);

export const studioSwipes = pgTable(
  "studio_swipe",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    imageUrl: text("image_url").notNull(),
    imageHash: text("image_hash"),
    sourceUrl: text("source_url"),
    brandName: text("brand_name"),
    angleId: text("angle_id").references(() => studioTaxonomyValues.id, {
      onDelete: "set null",
    }),
    hookTypeId: text("hook_type_id").references(() => studioTaxonomyValues.id, {
      onDelete: "set null",
    }),
    visualStyleId: text("visual_style_id").references(
      () => studioTaxonomyValues.id,
      { onDelete: "set null" },
    ),
    whyItWorks: text("why_it_works"),
    elements: jsonb("elements").$type<SuggestionElements | null>(),
    addedBy: text("added_by"),
    archivedAt: timestamp("archived_at"),
    lastTriedAt: timestamp("last_tried_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_swipe_organization_id_idx").on(table.organizationId),
    index("studio_swipe_org_image_hash_idx").on(
      table.organizationId,
      table.imageHash,
    ),
    uniqueIndex("studio_swipe_org_source_url_uidx").on(
      table.organizationId,
      table.sourceUrl,
    ),
    index("studio_swipe_angle_id_idx").on(table.angleId),
    index("studio_swipe_hook_type_id_idx").on(table.hookTypeId),
    index("studio_swipe_visual_style_id_idx").on(table.visualStyleId),
  ],
);

export const studioCopyPackages = pgTable(
  "studio_copy_package",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    angleId: text("angle_id").references(() => studioTaxonomyValues.id, {
      onDelete: "set null",
    }),
    primaryText: text("primary_text").notNull(),
    headline: text("headline").notNull(),
    description: text("description").notNull(),
    sourceCreativeId: text("source_creative_id").references(
      () => adCreatives.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_copy_package_organization_id_idx").on(table.organizationId),
    index("studio_copy_package_angle_id_idx").on(table.angleId),
  ],
);

export const studioGenerations = pgTable(
  "studio_generation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    runId: text("run_id"),
    brief: text("brief").notNull(),
    angle: text("angle"),
    persona: text("persona"),
    awarenessLevel: awarenessLevelEnum("awareness_level"),
    count: integer("count").notNull(),
    format: text("format").notNull().default("portrait"),
    referenceImageUrls: jsonb("reference_image_urls").$type<string[] | null>(),
    sourceCreativeId: text("source_creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),
    swipeId: text("swipe_id").references(() => studioSwipes.id, {
      onDelete: "set null",
    }),
    copyPackageId: text("copy_package_id").references(
      () => studioCopyPackages.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("generating"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_generation_organization_id_idx").on(table.organizationId),
    index("studio_generation_created_at_idx").on(table.createdAt),
  ],
);

export const studioSuggestions = pgTable(
  "studio_suggestion",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    sourceCreativeId: text("source_creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),
    swipeId: text("swipe_id").references(() => studioSwipes.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    whyLine: text("why_line").notNull(),
    // One-sentence single-variable test hypothesis written by the LLM.
    hypothesis: text("hypothesis"),
    evidence: text("evidence"),
    brief: text("brief"),
    elements: jsonb("elements").$type<SuggestionElements | null>(),
    angle: text("angle"),
    angleId: text("angle_id").references(() => studioTaxonomyValues.id, {
      onDelete: "set null",
    }),
    hookTypeId: text("hook_type_id").references(() => studioTaxonomyValues.id, {
      onDelete: "set null",
    }),
    visualStyleId: text("visual_style_id").references(
      () => studioTaxonomyValues.id,
      { onDelete: "set null" },
    ),
    persona: text("persona"),
    awarenessLevel: awarenessLevelEnum("awareness_level"),
    roas: text("roas"),
    purchases: integer("purchases"),
    spend: text("spend"),
    format: text("format").notNull().default("square"),
    count: integer("count").notNull().default(3),
    copyPackageId: text("copy_package_id").references(
      () => studioCopyPackages.id,
      { onDelete: "set null" },
    ),
    generationId: text("generation_id").references(() => studioGenerations.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("proposed"),
    claimedAt: timestamp("claimed_at"),
    actionedAt: timestamp("actioned_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_suggestion_organization_id_idx").on(table.organizationId),
    index("studio_suggestion_created_at_idx").on(table.createdAt),
    index("studio_suggestion_hook_type_id_idx").on(table.hookTypeId),
    index("studio_suggestion_status_idx").on(table.organizationId, table.status),
  ],
);

export const studioVariants = pgTable(
  "studio_variant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    generationId: text("generation_id")
      .notNull()
      .references(() => studioGenerations.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    index: integer("index").notNull(),
    status: text("status").notNull().default("pending"),
    imageUrl: text("image_url"),
    prompt: text("prompt"),
    mark: text("mark"),
    // When the current mark was set — the stable clock for the trailing
    // 90-day Good/Bad tallies (updatedAt moves on publish/link too).
    markedAt: timestamp("marked_at"),
    publishedAt: timestamp("published_at"),
    // The live ad creative this published variant became — closes the loop
    // from studio output to real market performance.
    linkedCreativeId: text("linked_creative_id").references(
      () => adCreatives.id,
      { onDelete: "set null" },
    ),
    copyPackageId: text("copy_package_id").references(
      () => studioCopyPackages.id,
      { onDelete: "set null" },
    ),
    moderationReason: text("moderation_reason"),
    retryWithoutImageAt: timestamp("retry_without_image_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_variant_generation_id_idx").on(table.generationId),
    index("studio_variant_organization_id_idx").on(table.organizationId),
    index("studio_variant_mark_idx").on(table.organizationId, table.mark),
  ],
);

/** Legacy rows are retained for migration safety; Studio v2 acts on cards. */
export const studioSuggestionVariants = pgTable(
  "studio_suggestion_variant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    suggestionId: text("suggestion_id")
      .notNull()
      .references(() => studioSuggestions.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    index: integer("index").notNull(),
    headline: text("headline").notNull(),
    diffSummary: text("diff_summary").notNull(),
    copyLine: text("copy_line").notNull(),
    elements: jsonb("elements").$type<SuggestionElements>().notNull(),
    format: text("format").notNull().default("square"),
    status: text("status").notNull().default("suggested"),
    generationId: text("generation_id").references(() => studioGenerations.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_suggestion_variant_suggestion_id_idx").on(table.suggestionId),
    index("studio_suggestion_variant_organization_id_idx").on(
      table.organizationId,
    ),
  ],
);
