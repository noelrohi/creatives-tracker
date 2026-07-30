"use client";

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import {
  ManagerLedgerChildSkeletonRow,
  ManagerLedgerRow,
} from "./manager-ledger-row";
import { type ManagerSort, sortManagerRows } from "./manager-ledger-sort";
import {
  MANAGER_STALE_TIME_MS,
  type ManagerLedgerFilters,
} from "./manager-ledger-types";
import type { ManagerExpansion } from "./use-manager-expansion";

// Mounted only while its parent is expanded (§6 lazy load): mounting fires the
// query, collapsing unmounts without a refetch, re-expanding hits the React
// Query cache inside staleTime. Ad sets carry their own `hasMatches`, so an
// auto-expanded campaign cascades down to its matching ad sets from here.
//
// `sort` reorders within this parent only (§7) and stays out of the query input,
// so a header click re-ranks from cache without refetching.
export function ManagerAdSetRows({
  campaignId,
  filters,
  expansion,
  sort,
}: {
  campaignId: string;
  filters: ManagerLedgerFilters;
  expansion: ManagerExpansion;
  sort: ManagerSort;
}) {
  const trpc = useTRPC();
  const adSets = useQuery(
    trpc.manager.adSets.queryOptions(
      { campaignId, ...filters },
      { staleTime: MANAGER_STALE_TIME_MS },
    ),
  );

  if (adSets.isPending) return <ManagerLedgerChildSkeletonRow />;

  return (
    <>
      {sortManagerRows(adSets.data ?? [], sort).map((adSet) => {
        const isExpanded = expansion.isExpanded(adSet);
        return (
          <Fragment key={adSet.id}>
            <ManagerLedgerRow
              row={adSet}
              level="adSet"
              isExpanded={isExpanded}
              onToggle={() => expansion.toggle(adSet)}
            />
            {isExpanded && (
              <ManagerAdRows
                adSetId={adSet.id}
                filters={filters}
                sort={sort}
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
  filters,
  sort,
}: {
  adSetId: string;
  filters: ManagerLedgerFilters;
  sort: ManagerSort;
}) {
  const trpc = useTRPC();
  const ads = useQuery(
    trpc.manager.ads.queryOptions(
      { adSetId, ...filters },
      { staleTime: MANAGER_STALE_TIME_MS },
    ),
  );

  if (ads.isPending) return <ManagerLedgerChildSkeletonRow />;

  return (
    <>
      {sortManagerRows(ads.data ?? [], sort).map((ad) => (
        <ManagerLedgerRow
          key={ad.id}
          row={ad}
          level="ad"
          isExpanded={false}
          onToggle={noop}
        />
      ))}
    </>
  );
}

function noop() {}
