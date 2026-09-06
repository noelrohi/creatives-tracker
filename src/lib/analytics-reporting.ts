import { z } from "zod";

export const effectiveWindowSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  boundaries: z.literal("inclusive"),
  selection: z.enum(["explicit", "rolling"]),
  rollingDays: z.number().nullable(),
  ignoredOneSidedBound: z.boolean(),
  resolutionTimezone: z.string().nullable(),
  rowSelection: z.enum(["reporting_interval_overlap", "store_order_and_refund_day", "store_refund_day", "meta_date_start_and_store_order_refund_days"]),
}).describe("Queried inclusive calendar labels, not a guarantee of matching instants across sources. Rolling N days includes today and N preceding dates, resolved by PostgreSQL. Both explicit bounds override days; a lone bound is ignored. Overlap selection does not prorate multi-day rows.");
export type EffectiveWindow = z.infer<typeof effectiveWindowSchema>;

const coverageSchema = z.object({
  state: z.literal("unknown"),
  reason: z.literal("no_gap_free_window_coverage_evidence"),
});
const freshnessSchema = z.enum(["fresh", "stale", "never_synced", "no_accounts"]);
const evidenceSchema = z.object({
  lastSuccessAt: z.iso.datetime().nullable(),
  latestAttempt: z.object({
    requestedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    result: z.string().nullable(),
  }).nullable(),
  freshness: freshnessSchema,
  coverage: coverageSchema,
  revisability: z.enum(["provisional", "unknown"]),
});
const metaAccountSchema = evidenceSchema.extend({
  accountId: z.string(),
  timezone: z.string().nullable(),
  connection: z.enum(["connected", "disabled", "disconnected"]),
  observedImportedThrough: z.string().nullable().describe("Maximum imported date only; does not prove contiguous coverage or finality."),
});
export const reportingSchema = z.object({
  generatedAt: z.iso.datetime(),
  meta: z.object({
    evidenceScope: z.literal("organization_accounts_optionally_filtered_by_accountId"),
    calendarBasis: z.literal("meta_account_reporting_day"),
    timezoneState: z.enum(["uniform", "mixed", "unknown"]),
    timezones: z.array(z.string()),
    freshness: freshnessSchema,
    allAccountsConnected: z.boolean(),
    coverage: coverageSchema,
    revisability: z.literal("provisional"),
    accounts: z.array(metaAccountSchema),
  }).nullable(),
  shopify: evidenceSchema.extend({
    storeId: z.string(),
    timezone: z.string(),
    calendarBasis: z.literal("store_calendar_day"),
  }).nullable(),
}).describe("Freshness measures time since ingestion (partial Meta success counts). Coverage is independently unknown; neither successful sync nor dataDateEnd establishes completeness. Meta attribution remains provisional. Source calendars may cover different instants. Timezones are current connector metadata; historical timezone changes are not reconstructed. No finalized-through guarantee is made.");
export const analyticsMetadataShape = { effectiveWindow: effectiveWindowSchema, reporting: reportingSchema };
export type Reporting = z.infer<typeof reportingSchema>;

export type SyncEvidence = {
  lastSuccessMs: number | null;
  latestAttempt: { requestedMs: number; finishedMs: number | null; result: string | null } | null;
};
export type MetaAccountEvidence = SyncEvidence & {
  accountId: string;
  timezone: string | null;
  connection: "connected" | "disabled" | "disconnected";
  observedImportedThrough: string | null;
};
const unknownCoverage = { state: "unknown", reason: "no_gap_free_window_coverage_evidence" } as const;

function syncState(evidence: SyncEvidence, cycleHours: number, now: Date) {
  return {
    lastSuccessAt: evidence.lastSuccessMs == null ? null : new Date(evidence.lastSuccessMs).toISOString(),
    latestAttempt: evidence.latestAttempt ? {
      requestedAt: new Date(evidence.latestAttempt.requestedMs).toISOString(),
      finishedAt: evidence.latestAttempt.finishedMs == null ? null : new Date(evidence.latestAttempt.finishedMs).toISOString(),
      result: evidence.latestAttempt.result,
    } : null,
    freshness: evidence.lastSuccessMs == null ? "never_synced" as const
      : now.getTime() - evidence.lastSuccessMs > 2 * cycleHours * 3_600_000 ? "stale" as const : "fresh" as const,
    coverage: unknownCoverage,
  };
}

export function buildReporting(input: {
  now: Date;
  metaAccounts?: MetaAccountEvidence[];
  shopify?: SyncEvidence & { storeId: string; timezone: string };
}): Reporting {
  const accounts = input.metaAccounts?.map((account) => ({
    accountId: account.accountId,
    timezone: account.timezone,
    connection: account.connection,
    observedImportedThrough: account.observedImportedThrough,
    ...syncState(account, 24, input.now),
    revisability: "provisional" as const,
  }));
  const timezones = [...new Set(accounts?.flatMap((account) => account.timezone ? [account.timezone] : []) ?? [])].sort();
  return {
    generatedAt: input.now.toISOString(),
    meta: accounts ? {
      evidenceScope: "organization_accounts_optionally_filtered_by_accountId",
      calendarBasis: "meta_account_reporting_day",
      timezoneState: accounts.length === 0 || accounts.some((account) => !account.timezone) ? "unknown" : timezones.length === 1 ? "uniform" : "mixed",
      timezones,
      freshness: accounts.length === 0 ? "no_accounts" : accounts.some((account) => account.freshness === "never_synced") ? "never_synced" : accounts.some((account) => account.freshness === "stale") ? "stale" : "fresh",
      allAccountsConnected: accounts.length > 0 && accounts.every((account) => account.connection === "connected"),
      coverage: unknownCoverage,
      revisability: "provisional",
      accounts,
    } : null,
    shopify: input.shopify ? {
      storeId: input.shopify.storeId,
      timezone: input.shopify.timezone,
      calendarBasis: "store_calendar_day",
      ...syncState(input.shopify, 1, input.now),
      revisability: "unknown",
    } : null,
  };
}

export function explicitStoreWindow(input: { dateFrom: string; dateTo: string }, basis: "store" | "refund" | "mixed" = "store"): EffectiveWindow {
  return {
    ...input,
    boundaries: "inclusive",
    selection: "explicit",
    rollingDays: null,
    ignoredOneSidedBound: false,
    resolutionTimezone: null,
    rowSelection: basis === "refund" ? "store_refund_day" : basis === "mixed" ? "meta_date_start_and_store_order_refund_days" : "store_order_and_refund_day",
  };
}
