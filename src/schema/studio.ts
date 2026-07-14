import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { awarenessLevelEnum } from "./enums";
import { adCreatives } from "./ad-creative";
import type { SuggestionElements } from "@/lib/studio-suggestions";

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
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    whyLine: text("why_line").notNull(),
    angle: text("angle"),
    persona: text("persona"),
    awarenessLevel: awarenessLevelEnum("awareness_level"),
    roas: text("roas"),
    purchases: integer("purchases"),
    spend: text("spend"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_suggestion_organization_id_idx").on(table.organizationId),
    index("studio_suggestion_created_at_idx").on(table.createdAt),
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
    starredAt: timestamp("starred_at"),
    savedCreativeId: text("saved_creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_variant_generation_id_idx").on(table.generationId),
    index("studio_variant_organization_id_idx").on(table.organizationId),
  ],
);

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
