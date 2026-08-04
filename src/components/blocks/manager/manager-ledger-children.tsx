"use client";

import { Fragment } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import type { ManagerAdActions } from "./manager-ad-actions";
import {
  ManagerLedgerChildSkeletonRow,
  ManagerLedgerRow,
} from "./manager-ledger-row";
import { type ManagerSort, sortManagerRows } from "./manager-ledger-sort";
import {
  ManagerLedgerEmptyChildRow,
  ManagerLedgerErrorRow,
} from "./manager-ledger-states";
import {
  MANAGER_STALE_TIME_MS,
  type ManagerAncestorOff,
  type ManagerLedgerFilters,
  type ManagerRowData,
} from "./manager-ledger-types";
import type { ManagerExpansion } from "./use-manager-expansion";

// §8 provenance is derived here, not fetched: the campaign and ad set rows are
// already in memory, so their statuses ride down as props. The outermost
// switched-off ancestor wins — under a paused campaign, that is the root cause
// and the ad set's own state is moot.
function ancestorOffFor(
  campaignStatus: ManagerRowData["status"],
  adSetStatus?: ManagerRowData["status"],
): ManagerAncestorOff {
  if (campaignStatus !== "active") return "campaign";
  if (adSetStatus && adSetStatus !== "active") return "adSet";
  return null;
}

// §9: an expanded parent with no children to show. Under an active status or
// search that is the pruned tree working as designed (§6) and the copy says so;
// the account filter can't prune below a campaign, and the date range never
// hides a row, so neither counts here. Without filters this shouldn't happen —
// only a `hasChildren` parent is expandable — so the copy stays neutral.
function emptyChildLabel(
  filters: ManagerLedgerFilters,
  level: "adSets" | "ads",
) {
  const pruned = Boolean(filters.status || filters.search);
  if (level === "adSets") return pruned ? "No matching ad sets" : "No ad sets";
  return pruned ? "No matching ads" : "No ads";
}

// Mounted only while its parent is expanded (§6 lazy load): mounting fires the
// query, collapsing unmounts without a refetch, re-expanding hits the React
// Query cache inside staleTime. Ad sets carry their own `hasMatches`, so an
// auto-expanded campaign cascades down to its matching ad sets from here.
//
// `sort` reorders within this parent only (§7) and stays out of the query input,
// so a header click re-ranks from cache without refetching.
export function ManagerAdSetRows({
  campaignId,
  campaignStatus,
  filters,
  expansion,
  sort,
  adActions,
}: {
  campaignId: string;
  campaignStatus: ManagerRowData["status"];
  filters: ManagerLedgerFilters;
  expansion: ManagerExpansion;
  sort: ManagerSort;
  adActions: ManagerAdActions;
}) {
  const trpc = useTRPC();
  const adSets = useQuery(
    trpc.manager.adSets.queryOptions(
      { campaignId, ...filters },
      { staleTime: MANAGER_STALE_TIME_MS },
    ),
  );

  if (adSets.isPending) return <ManagerLedgerChildSkeletonRow />;

  if (adSets.isError) {
    return (
      <ManagerLedgerErrorRow
        message="Couldn't load ad sets."
        onRetry={() => adSets.refetch()}
      />
    );
  }

  const adSetRows = adSets.data ?? [];
  if (adSetRows.length === 0) {
    return <ManagerLedgerEmptyChildRow label={emptyChildLabel(filters, "adSets")} />;
  }

  return (
    <>
      {sortManagerRows(adSetRows, sort).map((adSet) => {
        const isExpanded = expansion.isExpanded(adSet);
        return (
          <Fragment key={adSet.id}>
            {/* Ad set rows are read-only rollups in v1 (§8): no actions. */}
            <ManagerLedgerRow
              row={adSet}
              level="adSet"
              isExpanded={isExpanded}
              onToggle={() => expansion.toggle(adSet)}
              ancestorOff={ancestorOffFor(campaignStatus)}
            />
            {isExpanded && (
              <ManagerAdRows
                adSetId={adSet.id}
                adSetStatus={adSet.status}
                campaignId={campaignId}
                campaignStatus={campaignStatus}
                filters={filters}
                sort={sort}
                adActions={adActions}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function ManagerAdRows({
  adSetId,
  adSetStatus,
  campaignId,
  campaignStatus,
  filters,
  sort,
  adActions,
}: {
  adSetId: string;
  adSetStatus: ManagerRowData["status"];
  campaignId: string;
  campaignStatus: ManagerRowData["status"];
  filters: ManagerLedgerFilters;
  sort: ManagerSort;
  adActions: ManagerAdActions;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const ads = useQuery(
    trpc.manager.ads.queryOptions(
      { adSetId, ...filters },
      { staleTime: MANAGER_STALE_TIME_MS },
    ),
  );

  if (ads.isPending) return <ManagerLedgerChildSkeletonRow />;

  if (ads.isError) {
    return (
      <ManagerLedgerErrorRow
        message="Couldn't load ads."
        onRetry={() => ads.refetch()}
      />
    );
  }

  const adRows = ads.data ?? [];
  if (adRows.length === 0) {
    return <ManagerLedgerEmptyChildRow label={emptyChildLabel(filters, "ads")} />;
  }

  const ancestorOff = ancestorOffFor(campaignStatus, adSetStatus);

  return (
    <>
      {sortManagerRows(adRows, sort).map((ad) => (
        <ManagerLedgerRow
          key={ad.id}
          row={ad}
          level="ad"
          ancestorOff={ancestorOff}
          onNavigate={ad.creativeId ? () => {
            const params = new URLSearchParams({ from: filters.from, to: filters.to });
            router.push(`/creatives/${ad.creativeId}?${params.toString()}`);
          } : undefined}
          // Ads are the only actionable level (§8); the branch ids come along so
          // a mutation can invalidate exactly this ad set and campaign.
          actions={adActions.forAd({ ad, adSetId, campaignId })}
        />
      ))}
    </>
  );
}
