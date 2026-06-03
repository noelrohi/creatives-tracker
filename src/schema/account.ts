import { pgTable, text, timestamp, date, index } from "drizzle-orm/pg-core";

export const adAccounts = pgTable(
  "ad_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    metaAccountId: text("meta_account_id").notNull().unique(),
    metaAccessToken: text("meta_access_token"),
    defaultFacebookPageId: text("default_facebook_page_id"),
    defaultInstagramActorId: text("default_instagram_actor_id"),
    notes: text("notes"),
    lastImportedAt: timestamp("last_imported_at"),
    dataDateEnd: date("data_date_end"),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("ad_account_organization_id_idx").on(table.organizationId)],
);
