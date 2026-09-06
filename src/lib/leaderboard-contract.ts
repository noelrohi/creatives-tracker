import { z } from "zod";

export const leaderboardSortSchema = z.enum(["conversions", "roas"]);
export type LeaderboardSort = z.infer<typeof leaderboardSortSchema>;

const orderingSchema = z.object({
  metric: z.string(),
  direction: z.enum(["asc", "desc"]),
  nulls: z.enum(["last", "not_applicable"]),
});
const listSchema = z.object({
  included: z.boolean(),
  ordering: z.array(orderingSchema),
  eligibility: z.array(z.string()),
  metricScope: z.enum(["window", "lifetime"]),
  lifetimeMeasures: z.array(z.string()),
  appliedFilters: z.array(z.string()),
  ignoredFilters: z.array(z.string()),
  limit: z.number().int(),
  returnedCount: z.number().int(),
  truncation: z.enum(["not_requested", "below_limit", "possibly_truncated"]),
  excludedTopIds: z.array(z.string()),
  exclusionBasis: z.literal("returned_top_list_after_sort_and_limit"),
  displayScope: z.string(),
  healthScope: z.string(),
  fairShotSpend: z.number().nullable(),
  fairShotBasis: z.string().nullable(),
});
export const leaderboardMetadataSchema = z.object({
  sortBy: leaderboardSortSchema,
  sortAppliesTo: z.literal("topPerformers"),
  topPerformers: listSchema,
  survivingCreatives: listSchema,
  bottomPerformers: listSchema,
});

const scopedFilters = ["organization", "accountId", "campaignIds", "adSetIds", "ownership", "teamId", "format"];
const desc = (metric: string) => ({ metric, direction: "desc" as const, nulls: "last" as const });
const uniqueTie = { metric: "creativeId", direction: "asc" as const, nulls: "not_applicable" as const };

export function leaderboardMetadata(input: {
  sortBy: LeaderboardSort;
  limit: number;
  includeSurviving: boolean;
  includePortfolio: boolean;
  fairShotSpend: number | null;
  topIds: string[];
  survivingCount: number;
  bottomCount: number;
}): z.infer<typeof leaderboardMetadataSchema> {
  const base = (count: number, included = true) => ({
    included,
    limit: input.limit,
    returnedCount: count,
    truncation: !included ? "not_requested" as const : count < input.limit ? "below_limit" as const : "possibly_truncated" as const,
    exclusionBasis: "returned_top_list_after_sort_and_limit" as const,
    fairShotSpend: null,
    fairShotBasis: null,
    healthScope: "Creative-wide ads scoped by organization, not the requested account/team/campaign/ad-set/status/format filters. Base health totals use the requested window; recent comparisons use the latest lifetime reporting day and can extend outside that window.",
  });
  return {
    sortBy: input.sortBy,
    sortAppliesTo: "topPerformers",
    topPerformers: {
      ...base(input.topIds.length),
      ordering: [...(input.sortBy === "roas" ? [desc("roas"), desc("conversions")] : [desc("conversions"), desc("roas")]), uniqueTie],
      eligibility: ["aggregate spend >= 50", "aggregate ROAS >= 1", "at least one effectively active scoped ad with positive window spend"],
      metricScope: "window",
      lifetimeMeasures: [],
      appliedFilters: [...scopedFilters, "date", "statuses"],
      ignoredFilters: [],
      excludedTopIds: [],
      displayScope: "All ads admitted by the requested filters, not just the active qualifying ads. runningDays is the window row span; isEvergreen uses that span. See healthScope for separate health rules.",
    },
    survivingCreatives: {
      ...base(input.survivingCount, input.includeSurviving),
      ordering: [{ metric: "runningDays", direction: "desc", nulls: "not_applicable" }, desc("roas"), uniqueTie],
      eligibility: ["lifetime aggregate spend >= 50", "lifetime aggregate ROAS >= 1", "lifetime max(date_end) - min(date_start) >= 14", "at least one effectively active scoped ad with positive lifetime spend"],
      metricScope: "lifetime",
      lifetimeMeasures: ["totalSpend", "roas", "cpa", "ctr", "conversions", "runningDays"],
      appliedFilters: scopedFilters,
      ignoredFilters: ["date", "statuses", "sortBy"],
      excludedTopIds: input.includeSurviving ? input.topIds : [],
      displayScope: "Lifetime metrics over all scoped ads. See healthScope for separate health rules.",
    },
    bottomPerformers: {
      ...base(input.bottomCount),
      ordering: [{ metric: "tier:pause_now_before_watch", direction: "asc", nulls: "not_applicable" }, desc("bleederDollarsAtRisk"), uniqueTie],
      eligibility: ["per-ad: effectively active, window spend >= 25, and (zero conversions with null treated as zero OR ROAS < 1)", "pause_now: spend >= fair-shot threshold AND lifetime span >= 5", "watch (unless pause_now): spend >= fair-shot threshold OR lifetime span >= 7", "cooking ads omitted; creative inherits most urgent actionable ad tier"],
      metricScope: "window",
      lifetimeMeasures: ["qualification:adRunningDays"],
      appliedFilters: [...scopedFilters, "date"],
      ignoredFilters: ["statuses", "sortBy"],
      excludedTopIds: input.topIds,
      displayScope: "Displayed totals include all scoped ads, not just actionable ads. At-risk dollars sum spend * (1 - coalesce(ROAS, 0)) over actionable ads. CTR is unavailable. See healthScope for separate health rules.",
      fairShotSpend: input.fairShotSpend,
      fairShotBasis: input.includePortfolio
        ? "max(50, portfolio CPA), fallback 50; portfolio applies requested status filters"
        : "greatest(50, coalesce(window spend / nullif(window conversions, 0), 50)); scoped ad window ignores requested status filters",
    },
  };
}
