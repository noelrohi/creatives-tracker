import { z } from "zod";

export const FULFILLMENT_STATUSES = [
  "UNFULFILLED", "OPEN", "RESTOCKED", "PARTIALLY_FULFILLED", "FULFILLED",
  "ON_HOLD", "IN_PROGRESS", "PENDING_FULFILLMENT", "REQUEST_DECLINED", "SCHEDULED",
] as const;
export const UNFULFILLED_STATUSES = ["UNFULFILLED", "OPEN", "RESTOCKED"] as const;

export const fulfillmentSummarySchema = z.object({
  answer: z.object({
    unfulfilledCount: z.number().int().nullable(),
    availability: z.enum(["available_for_observed_orders", "partial", "unknown"]),
    sourceCoverage: z.literal("unknown"),
  }),
  statusBasis: z.literal("latest_observed_current_status"),
  population: z.literal("locally_ingested_non_test_orders_by_creation_day"),
  cancellationsExcluded: z.literal(true),
  countedStatuses: z.array(z.enum(UNFULFILLED_STATUSES)),
  observedUnfulfilledCount: z.number().int(),
  observedNonCancelledCount: z.number().int(),
  excludedCancelledCount: z.number().int(),
  unknownStatusCount: z.number().int(),
  statusCounts: z.array(z.object({ status: z.enum(FULFILLMENT_STATUSES), count: z.number().int() })),
  statusCoverage: z.object({
    state: z.enum(["complete_for_observed_orders", "partial", "unknown"]),
    knownCount: z.number().int(),
    unknownCount: z.number().int(),
    oldestObservedAt: z.iso.datetime().nullable(),
    newestObservedAt: z.iso.datetime().nullable(),
  }),
}).describe("Strict unfulfilled status count among locally ingested non-test orders, excluding cancellations independently of payment status. Partial, fulfilled and other workflow states are separate, not unfulfilled. Missing/unrecognized/unobserved statuses are unknown. Complete classification of observed rows does not establish complete source ingestion; zero is not a guaranteed source zero. Status is current as last observed, not historical status at window end.");

export type FulfillmentGroup = {
  status: string;
  count: number;
  oldestMs: number | null;
  newestMs: number | null;
};

export function summarizeFulfillment(groups: FulfillmentGroup[]): z.infer<typeof fulfillmentSummarySchema> {
  const counts = new Map(groups.map((row) => [row.status, row.count]));
  const statusCounts = FULFILLMENT_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 }));
  const knownCount = statusCounts.reduce((sum, row) => sum + row.count, 0);
  const unknownCount = groups.filter((row) => row.status !== "CANCELLED" && !FULFILLMENT_STATUSES.some((status) => status === row.status)).reduce((sum, row) => sum + row.count, 0);
  const observedGroups = groups.filter((row) => row.status !== "CANCELLED");
  const oldest = observedGroups.flatMap((row) => row.oldestMs === null ? [] : [row.oldestMs]);
  const newest = observedGroups.flatMap((row) => row.newestMs === null ? [] : [row.newestMs]);
  const observedUnfulfilledCount = UNFULFILLED_STATUSES.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
  return {
    answer: {
      unfulfilledCount: knownCount > 0 && unknownCount === 0 ? observedUnfulfilledCount : null,
      availability: knownCount === 0 ? "unknown" : unknownCount > 0 ? "partial" : "available_for_observed_orders",
      sourceCoverage: "unknown",
    },
    statusBasis: "latest_observed_current_status",
    population: "locally_ingested_non_test_orders_by_creation_day",
    cancellationsExcluded: true,
    countedStatuses: [...UNFULFILLED_STATUSES],
    observedUnfulfilledCount,
    observedNonCancelledCount: knownCount + unknownCount,
    excludedCancelledCount: counts.get("CANCELLED") ?? 0,
    unknownStatusCount: unknownCount,
    statusCounts,
    statusCoverage: {
      state: knownCount === 0 ? "unknown" : unknownCount > 0 ? "partial" : "complete_for_observed_orders",
      knownCount, unknownCount,
      oldestObservedAt: oldest.length ? new Date(Math.min(...oldest)).toISOString() : null,
      newestObservedAt: newest.length ? new Date(Math.max(...newest)).toISOString() : null,
    },
  };
}
