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
import type { ManagerExpansion } from "./use-manager-expansion";

// Mounted only while its parent is expanded (§6 lazy load): mounting fires the
// query, collapsing unmounts without a refetch, re-expanding hits the React
// Query cache inside staleTime. Ad sets carry their own `hasMatches`, so an
// auto-expanded campaign cascades down to its matching ad sets from here.
export function ManagerAdSetRows({
  campaignId,
  filters,
  expansion,
}: {
  campaignId: string;
  filters: ManagerLedgerFilters;
  expansion: ManagerExpansion;
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
