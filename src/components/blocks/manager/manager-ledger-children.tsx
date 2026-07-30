"use client";

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import {
  ManagerLedgerChildSkeletonRow,
  ManagerLedgerRow,
} from "./manager-ledger-row";
import {
  MANAGER_STALE_TIME_MS,
  type ManagerLedgerFilters,
} from "./manager-ledger-types";

// Mounted only while its parent is expanded (§6 lazy load): mounting fires the
// query, collapsing unmounts without a refetch, re-expanding hits the React
// Query cache inside staleTime.
export function ManagerAdSetRows({
  campaignId,
  filters,
  expanded,
  onToggle,
}: {
  campaignId: string;
  filters: ManagerLedgerFilters;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
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
      {(adSets.data ?? []).map((adSet) => {
        const isExpanded = expanded.has(adSet.id);
        return (
          <Fragment key={adSet.id}>
            <ManagerLedgerRow
              row={adSet}
              level="adSet"
              isExpanded={isExpanded}
              onToggle={onToggle}
            />
            {isExpanded && (
              <ManagerAdRows adSetId={adSet.id} filters={filters} />
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
}: {
  adSetId: string;
  filters: ManagerLedgerFilters;
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
      {(ads.data ?? []).map((ad) => (
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
