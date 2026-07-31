import { pgTable, text, timestamp, numeric } from "drizzle-orm/pg-core";

// App-owned. Better Auth owns `organization`, so no FK to it — same as other
// app tables that key off organization_id.
export const orgSettings = pgTable("org_settings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  organizationId: text("organization_id").notNull().unique(),
  roasTarget: numeric("roas_target").notNull().default("1.5"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
