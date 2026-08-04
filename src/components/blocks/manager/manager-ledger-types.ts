import type { RouterInputs, RouterOutputs } from "@/lib/trpc/client";

export type ManagerLevel = "campaign" | "adSet" | "ad";

export type ManagerCampaignRow = RouterOutputs["manager"]["campaigns"][number];
export type ManagerAdSetRow = RouterOutputs["manager"]["adSets"][number];
export type ManagerAdRow = RouterOutputs["manager"]["ads"][number];

// One presentational row covers the shared fields at every level. Campaigns
// and ad sets add expansion metadata; ads add the linked creative id.
export type ManagerRowData = ManagerCampaignRow | ManagerAdSetRow | ManagerAdRow;

// The from/to/status/search inputs shared by all three procedures — the child
// queries reuse the page's current values so rollups stay consistent (§4).
export type ManagerLedgerFilters = Omit<
  RouterInputs["manager"]["adSets"],
  "campaignId"
>;

// §4: client-side cache only, staleTime ~3 minutes.
export const MANAGER_STALE_TIME_MS = 3 * 60 * 1000;

// §8 ancestor provenance. A row always renders its OWN status; this only records
// which ancestor is switched off so the row can dim and annotate. Derived
// client-side from rows already in the tree — never fetched.
export type ManagerAncestorOff = "campaign" | "adSet" | null;

export const MANAGER_ANCESTOR_OFF_LABELS: Record<
  NonNullable<ManagerAncestorOff>,
  string
> = {
  campaign: "campaign off",
  adSet: "ad set off",
};

// §8 actions, ad rows only. Already bound to one ad by the time the row sees
// them; `null` means the row is read-only (campaign/ad set rows, unprivileged
// users, or an ad with no Meta id). `onPause` is undefined on an already-paused
// ad — `ad.pauseMetaAds` only pauses and there is no unpause procedure in v1.
export type ManagerRowActions = {
  onPause?: () => void;
  onRename: () => void;
  isPending: boolean;
};
