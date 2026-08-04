import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { formatEnum, awarenessLevelEnum, ownershipEnum } from "./enums";
import { teams } from "./team";

export type CreativeAttributes = {
  visualElements?: string[];
  visualStyle?: string;
  mode?: string;
  hook?: string;
  supportingTexts?: string[];
  cta?: string;
  promos?: string;
  disclaimer?: string;
};

export const adCreatives = pgTable(
  "ad_creative",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Untitled Creative"),
    assetUrl: text("asset_url"),
    videoUrl: text("video_url"),
    format: formatEnum("format"),
    angle: text("angle"),
    persona: text("persona"),
    awarenessLevel: awarenessLevelEnum("awareness_level"),
    attributes: jsonb("attributes")
      .$type<CreativeAttributes>()
      .notNull()
      .default({}),
    attributesMeta: jsonb("attributes_meta")
      .$type<
        Record<string, { source: "ai" | "human"; confidence?: number }>
      >()
      .notNull()
      .default({}),
    tone: text("tone").array(),
    ownership: ownershipEnum("ownership"),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    notes: text("notes"),
    organizationId: text("organization_id"),
    enrichmentAttemptedAt: timestamp("enrichment_attempted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ad_creative_format_idx").on(table.format),
    index("ad_creative_awareness_level_idx").on(table.awarenessLevel),
    index("ad_creative_organization_id_idx").on(table.organizationId),
    index("ad_creative_team_id_idx").on(table.teamId),
  ],
);
