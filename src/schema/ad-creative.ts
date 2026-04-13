import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { formatEnum, awarenessLevelEnum, ownershipEnum } from "./enums";
import { teams } from "./team";

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
    hook: text("hook"),
    tone: text("tone").array(),
    cta: text("cta"),
    ownership: ownershipEnum("ownership"),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    notes: text("notes"),
    organizationId: text("organization_id"),
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
