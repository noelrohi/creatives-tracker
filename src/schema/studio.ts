import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { awarenessLevelEnum } from "./enums";
import { adCreatives } from "./ad-creative";

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
    referenceImageUrls: jsonb("reference_image_urls").$type<string[] | null>(),
    status: text("status").notNull().default("generating"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("studio_generation_organization_id_idx").on(table.organizationId),
    index("studio_generation_created_at_idx").on(table.createdAt),
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
