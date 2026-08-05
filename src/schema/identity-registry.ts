import { foreignKey, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { shopifyStores } from "@/schema/shopify";

/**
 * Append-only lifetime registry mapping every matching-key label to one
 * non-subject fixed-context check per store. Lives upstream of both the
 * Shopify evidence schema and the Klaviyo connection gate so each can
 * foreign-key it without a module cycle.
 */
export const identityMatchingKeyBindings = pgTable(
  "identity_matching_key_binding",
  {
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    keyVersion: text("key_version").notNull(),
    keyCheck: text("key_check").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "identity_matching_key_binding_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    unique("identity_matching_key_binding_scope_version_uniq").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
    ),
    unique("identity_matching_key_binding_scope_version_check_uniq").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.keyCheck,
    ),
  ],
);
