"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { ManagerFilterBar } from "@/components/blocks/manager/manager-filter-bar";
import { ManagerLedgerSkeleton } from "@/components/blocks/manager/manager-ledger-skeleton";
import { useManagerFilters } from "@/components/blocks/manager/use-manager-filters";

function formatSpend(value: string) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return "—";
  return `$${amount >= 100 ? amount.toFixed(0) : amount.toFixed(2)}`;
}

export default function CampaignsPage() {
  const trpc = useTRPC();
  const {
    accountId, setAccountId,
    status, setStatus,
    search,
    searchInput, setSearchInput,
    fromValue, toValue, fromDate, toDate, setFrom, setTo,
  } = useManagerFilters();

  const accountsQuery = useQuery(trpc.adAccount.list.queryOptions());
  const campaigns = useQuery(
    trpc.manager.campaigns.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: accountId || undefined,
      status: status || undefined,
      search: search || undefined,
    }),
  );

  const rows = campaigns.data ?? [];

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

      {/* Ledger placeholder — the table itself lands in build step 4. */}
      {campaigns.isLoading ? (
        <ManagerLedgerSkeleton />
      ) : (
        <div className="rounded-lg border">
          <div className="divide-y">
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex h-[29px] items-center justify-between gap-4 px-3 text-[13px]"
              >
                <span className="truncate">{row.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatSpend(row.spend)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
