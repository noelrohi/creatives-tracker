import { pgTable, text, timestamp, date, integer, index, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adAccounts } from "./account";

export const orgSyncRuns = pgTable(
  "org_sync_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    triggerType: text("trigger_type").notNull(),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    result: text("result"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index("org_sync_run_organization_id_idx").on(table.organizationId),
    index("org_sync_run_requested_at_idx").on(table.requestedAt),
  ],
);

export const accountSyncRuns = pgTable(
  "account_sync_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgSyncRunId: text("org_sync_run_id").references(() => orgSyncRuns.id, {
      onDelete: "set null",
    }),
    organizationId: text("organization_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to").notNull(),
    breakdownsRequested: jsonb("breakdowns_requested")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    breakdownsCompleted: jsonb("breakdowns_completed")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    currentPhase: text("current_phase"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    result: text("result"),
    rowsSynced: integer("rows_synced").default(0).notNull(),
    errorMessage: text("error_message"),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index("account_sync_run_org_sync_run_id_idx").on(table.orgSyncRunId),
    index("account_sync_run_organization_id_idx").on(table.organizationId),
    index("account_sync_run_account_id_idx").on(table.accountId),
    index("account_sync_run_requested_at_idx").on(table.requestedAt),
  ],
);
