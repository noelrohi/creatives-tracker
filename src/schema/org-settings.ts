import { pgTable, text, timestamp, numeric, jsonb } from "drizzle-orm/pg-core";
import type { FeatureFlags } from "@/lib/feature-flags";

// App-owned. Better Auth owns `organization`, so no FK to it — same as other
// app tables that key off organization_id.
export const orgSettings = pgTable("org_settings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  organizationId: text("organization_id").notNull().unique(),
  roasTarget: numeric("roas_target").notNull().default("1.5"),
  featureFlags: jsonb("feature_flags")
    .$type<FeatureFlags>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
