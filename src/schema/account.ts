import { pgTable, text, timestamp, date } from "drizzle-orm/pg-core";

export const accounts = pgTable("account", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  metaAccountId: text("meta_account_id").notNull().unique(),
  metaAccessToken: text("meta_access_token"),
  notes: text("notes"),
  lastImportedAt: timestamp("last_imported_at"),
  dataDateEnd: date("data_date_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
