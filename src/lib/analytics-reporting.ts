import { z } from "zod";

export const effectiveWindowSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  boundaries: z.literal("inclusive"),
  selection: z.enum(["explicit", "rolling"]),
  rollingDays: z.number().nullable(),
  ignoredOneSidedBound: z.boolean(),
  resolutionTimezone: z.string().nullable(),
  rowSelection: z.enum(["reporting_interval_overlap", "store_order_day", "store_order_and_refund_day", "store_refund_day", "meta_date_start_and_store_order_refund_days"]),
}).describe("Queried inclusive calendar labels, not a guarantee of matching instants across sources. Rolling N days includes today and N preceding dates, resolved by PostgreSQL. Both explicit bounds override days; a lone bound is ignored. Overlap selection does not prorate multi-day rows.");
export type EffectiveWindow = z.infer<typeof effectiveWindowSchema>;

const coverageSchema = z.object({
  state: z.literal("unknown"),
  reason: z.literal("no_gap_free_window_coverage_evidence"),
});
export const REQUESTED_WINDOW_ATTEMPT_LIMIT = 10;
const requestedWindowAttemptSchema = z.object({
  runId: z.string(),
  requestedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  dateFrom: z.string().nullable(),
  dateTo: z.string().nullable(),
  basis: z.enum(["meta_insight_request_dates", "shopify_incremental_updated_at", "shopify_backfill_created_at"]),
  windowPrecision: z.enum(["inclusive_account_calendar_dates", "utc_day_labels_not_exact_query_bounds"]),
  result: z.string().nullable(),
  outcome: z.enum(["success", "partial_success", "failed", "unfinished", "unknown"]),
  breakdownsRequested: z.array(z.string()).nullable(),
  breakdownsCompleted: z.array(z.string()).nullable(),
});
const requestedWindowAttemptsSchema = z.object({
  limit: z.literal(10),
  selection: z.literal("latest_requested_at_desc_run_id_asc"),
  attempts: z.array(requestedWindowAttemptSchema).max(10),
}).describe("Bounded recent recorded ingestion attempts, independent of the report window; not exhaustive history or gap-free coverage. Success is the recorded run result, not proof of source completeness or attribution finality. Empty history means no available evidence. Shopify dates are UTC day labels only: incremental queries use updated_at >= a timestamp, backfills use created_at >= a timestamp; stored dateTo is not an enforced upper bound. Local rebucketing is excluded. No error text or arbitrary run metadata is exposed.");

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
  requestedWindowAttempts: requestedWindowAttemptsSchema,
  revisability: z.enum(["provisional", "unknown"]),
});
export const metaCurrencyEvidenceSchema = z.object({
  state: z.enum(["uniform", "mixed", "unknown"]),
  currency: z.string().nullable(),
  currencies: z.array(z.string()),
  unknownAccountIds: z.array(z.string()),
  aggregateAmountsUsable: z.boolean(),
  source: z.literal("meta_account_currency"),
  conversion: z.literal("none"),
}).describe("Current authoritative Meta account currency, not historical currency reconstruction. Only uniform known currencies permit aggregate monetary amounts and money-derived ratios to be used. Legacy amounts are retained without FX conversion. Inventory scope may conservatively include accounts without observed rows.");

/** Reject malformed metadata rather than inferring a currency from another source. */
export function normalizeMetaCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

export function buildMetaCurrencyEvidence(accounts: { accountId: string; currency?: string | null }[]): z.infer<typeof metaCurrencyEvidenceSchema> {
  const currencies = [...new Set(accounts.flatMap((account) => {
    const currency = normalizeMetaCurrency(account.currency);
    return currency ? [currency] : [];
  }))].sort();
  const unknownAccountIds = accounts.filter((account) => !normalizeMetaCurrency(account.currency)).map((account) => account.accountId).sort();
  // Known disagreement remains mixed even when other accounts are unknown.
  const state = currencies.length > 1 ? "mixed" : accounts.length === 0 || unknownAccountIds.length > 0 ? "unknown" : "uniform";
  return {
    state,
    currency: state === "uniform" ? currencies[0] : null,
    currencies,
    unknownAccountIds,
    aggregateAmountsUsable: state === "uniform",
    source: "meta_account_currency",
    conversion: "none",
  };
}

const metaAccountSchema = evidenceSchema.extend({
  accountId: z.string(),
  timezone: z.string().nullable(),
  currency: z.string().nullable(),
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
    currencyEvidence: metaCurrencyEvidenceSchema,
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

export type RequestedWindowAttemptEvidence = Omit<z.infer<typeof requestedWindowAttemptSchema>, "requestedAt" | "finishedAt" | "outcome"> & {
  requestedMs: number;
  finishedMs: number | null;
};

export type SyncEvidence = {
  requestedWindowAttempts?: RequestedWindowAttemptEvidence[];
  lastSuccessMs: number | null;
  latestAttempt: { requestedMs: number; finishedMs: number | null; result: string | null } | null;
};
export type MetaAccountEvidence = SyncEvidence & {
  accountId: string;
  timezone: string | null;
  currency?: string | null;
  connection: "connected" | "disabled" | "disconnected";
  observedImportedThrough: string | null;
};
const unknownCoverage = { state: "unknown", reason: "no_gap_free_window_coverage_evidence" } as const;

function buildRequestedWindowAttempts(attempts: RequestedWindowAttemptEvidence[] = []): z.infer<typeof requestedWindowAttemptsSchema> {
  return {
    limit: REQUESTED_WINDOW_ATTEMPT_LIMIT,
    selection: "latest_requested_at_desc_run_id_asc",
    attempts: [...attempts]
      .sort((a, b) => b.requestedMs - a.requestedMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
      .slice(0, REQUESTED_WINDOW_ATTEMPT_LIMIT)
      .map((attempt) => ({
        runId: attempt.runId,
        requestedAt: new Date(attempt.requestedMs).toISOString(),
        finishedAt: attempt.finishedMs == null ? null : new Date(attempt.finishedMs).toISOString(),
        dateFrom: attempt.dateFrom,
        dateTo: attempt.dateTo,
        basis: attempt.basis,
        windowPrecision: attempt.windowPrecision,
        result: attempt.result,
        outcome: attempt.finishedMs == null ? "unfinished"
          : attempt.result === "success" || attempt.result === "partial_success" || attempt.result === "failed" ? attempt.result : "unknown",
        breakdownsRequested: attempt.breakdownsRequested,
        breakdownsCompleted: attempt.breakdownsCompleted,
      })),
  };
}

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
    requestedWindowAttempts: buildRequestedWindowAttempts(evidence.requestedWindowAttempts),
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
    currency: normalizeMetaCurrency(account.currency),
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
      currencyEvidence: buildMetaCurrencyEvidence(accounts),
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
