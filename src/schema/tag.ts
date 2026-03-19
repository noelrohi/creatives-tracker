import { relations } from "drizzle-orm";
import { pgTable, pgEnum, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth";

export const entityTypeEnum = pgEnum("entity_type", [
  "ad_creative",
  "landing_page",
  "campaign_config",
  "ad_set",
]);

export const tags = pgTable(
  "tag",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    color: text("color"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("tag_organization_id_idx").on(table.organizationId),
    unique("tag_name_org_unique").on(table.name, table.organizationId),
  ],
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
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("entity_tag_entity_idx").on(table.entityType, table.entityId),
    index("entity_tag_tag_id_idx").on(table.tagId),
    index("entity_tag_organization_id_idx").on(table.organizationId),
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
