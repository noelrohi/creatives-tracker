import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { objectiveEnum, statusEnum } from "./enums";

export const campaigns = pgTable("campaign", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().default("Untitled Campaign"),
  objective: objectiveEnum("objective"),
  status: statusEnum("status").notNull().default("active"),
  metaId: text("meta_id").unique(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
