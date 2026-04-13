import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const teams = pgTable(
  "team",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    notes: text("notes"),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("team_organization_id_idx").on(table.organizationId),
    uniqueIndex("team_name_org_unique").on(table.name, table.organizationId),
  ],
);
