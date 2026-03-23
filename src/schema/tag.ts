import { relations } from "drizzle-orm";
import { pgTable, pgEnum, text, timestamp, index, unique } from "drizzle-orm/pg-core";

export const entityTypeEnum = pgEnum("entity_type", [
  "ad_creative",
  "landing_page",
  "campaign",
  "ad_set",
  "ad",
]);

export const tags = pgTable(
  "tag",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [unique("tag_name_unique").on(table.name)],
);

export const entityTags = pgTable(
  "entity_tag",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    entityType: entityTypeEnum("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("entity_tag_entity_idx").on(table.entityType, table.entityId),
    index("entity_tag_tag_id_idx").on(table.tagId),
    unique("entity_tag_unique").on(table.entityType, table.entityId, table.tagId),
  ],
);

export const tagRelations = relations(tags, ({ many }) => ({
  entityTags: many(entityTags),
}));

export const entityTagRelations = relations(entityTags, ({ one }) => ({
  tag: one(tags, {
    fields: [entityTags.tagId],
    references: [tags.id],
  }),
}));
