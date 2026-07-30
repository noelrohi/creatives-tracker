import type { RouterInputs, RouterOutputs } from "@/lib/trpc/client";

export type ManagerLevel = "campaign" | "adSet" | "ad";

export type ManagerCampaignRow = RouterOutputs["manager"]["campaigns"][number];
export type ManagerAdSetRow = RouterOutputs["manager"]["adSets"][number];
export type ManagerAdRow = RouterOutputs["manager"]["ads"][number];

// Every level returns the same row shape (campaigns add accountName, campaigns
// and ad sets add hasMatches), so one presentational row component covers the
// whole tree. The ad row is the common denominator.
export type ManagerLedgerRow = ManagerAdRow;

// The from/to/status/search inputs shared by all three procedures — the child
// queries reuse the page's current values so rollups stay consistent (§4).
export type ManagerLedgerFilters = Omit<
  RouterInputs["manager"]["adSets"],
  "campaignId"
>;

// §4: client-side cache only, staleTime ~3 minutes.
export const MANAGER_STALE_TIME_MS = 3 * 60 * 1000;
