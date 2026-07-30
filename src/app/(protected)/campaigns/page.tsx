"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { ManagerFilterBar } from "@/components/blocks/manager/manager-filter-bar";
import { ManagerLedger } from "@/components/blocks/manager/manager-ledger";
import { ManagerLedgerSkeleton } from "@/components/blocks/manager/manager-ledger-skeleton";
import { ManagerLedgerEmptyState } from "@/components/blocks/manager/manager-ledger-states";
import {
  MANAGER_STALE_TIME_MS,
  type ManagerLedgerFilters,
} from "@/components/blocks/manager/manager-ledger-types";
import { useManagerFilters } from "@/components/blocks/manager/use-manager-filters";

export default function CampaignsPage() {
  const trpc = useTRPC();
  const {
    accountId, setAccountId,
    status, setStatus,
    search,
    searchInput, setSearchInput,
    fromValue, toValue, fromDate, toDate, setFrom, setTo,
    clearFilters, hasFilters,
  } = useManagerFilters();

  const accountsQuery = useQuery(trpc.adAccount.list.queryOptions());

  // The children queries reuse these exact inputs, so every level of the tree
  // is dated and filtered the same way and rollups stay consistent.
  const filters: ManagerLedgerFilters = {
    from: fromValue,
    to: toValue,
    status: status || undefined,
    search: search || undefined,
  };

  const campaigns = useQuery(
    trpc.manager.campaigns.queryOptions(
      { ...filters, accountId: accountId || undefined },
      { staleTime: MANAGER_STALE_TIME_MS },
    ),
  );

  const rows = campaigns.data ?? [];

  // §9 case 1 vs case 2: with no filters active an empty result means there is
  // nothing to manage at all (no Meta account connected, or never synced) — the
  // date range can only zero metrics, never hide a row (§6). With filters active
  // it's a pruned tree, which the ledger reports inline so the filter bar and
  // headers stay in place. An error outranks both: we don't know either way.
  const showEmptyState =
    !campaigns.isError && !campaigns.isLoading && rows.length === 0 && !hasFilters;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Campaigns</h1>
        {rows.length > 0 && (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {rows.length} campaigns
          </span>
        )}
      </div>

      {/* Filters */}
      <ManagerFilterBar
        accounts={accountsQuery.data ?? []}
        accountId={accountId}
        onAccountIdChange={setAccountId}
        status={status ?? null}
        onStatusChange={setStatus}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        fromDate={fromDate}
        toDate={toDate}
        onFromChange={setFrom}
        onToChange={setTo}
      />

      {campaigns.isLoading ? (
        <ManagerLedgerSkeleton />
      ) : showEmptyState ? (
        <ManagerLedgerEmptyState />
      ) : (
        <ManagerLedger
          campaigns={rows}
          filters={filters}
          isError={campaigns.isError}
          onRetry={() => campaigns.refetch()}
          onClearFilters={clearFilters}
        />
      )}
    </div>
  );
}
