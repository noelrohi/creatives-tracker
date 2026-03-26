import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

export const apiKeys = pgTable(
  "api_key",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    scopes: text("scopes").array(),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("api_key_prefix_uidx").on(table.prefix),
    index("api_key_organization_id_idx").on(table.organizationId),
    index("api_key_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organization, {
    fields: [apiKeys.organizationId],
    references: [organization.id],
  }),
  createdByUser: one(user, {
    fields: [apiKeys.createdByUserId],
    references: [user.id],
  }),
}));
