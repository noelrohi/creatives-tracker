"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableColumnToggle } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Upload,
  Download,
} from "@/components/icons";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";
import { ExportPreviewDialog } from "@/components/blocks/export-preview-dialog";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { formatDateOnly } from "@/lib/date";
import type { CreativeHealth } from "@/lib/creative-health";
import { useCreativeFilters } from "@/components/blocks/creatives/use-creative-filters";
import { CreativeBulkActions } from "@/components/blocks/creatives/creative-bulk-actions";
import { creativeColumns } from "@/components/blocks/creatives/creative-list-columns";
import type { Creative } from "@/components/blocks/creatives/creative-list-types";
import {
  AWARENESS,
  FORMATS,
  AdSetCombobox,
  CampaignCombobox,
  EmptyState,
  FilterPill,
  LandingPageCombobox,
  MoreFilters,
  PerformanceFilter,
  TableLoadingSkeleton,
  formatLandingPage,
} from "@/components/blocks/creatives/creative-list-filters";

export default function CreativesPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const { role } = useActiveOrganizationRole();
  const isReadOnly = role === "member";
  const tableColumns = isReadOnly
    ? creativeColumns.filter((column) => column.id !== "select")
    : creativeColumns;

  const {
    format, setFormat, awareness, setAwareness, search, setSearch,
    accountId, setAccountId, adSetIds, setAdSetIds, campaignIds, setCampaignIds,
    landingPageUrls, setLandingPageUrls,
    minRoas, setMinRoas, minConversions, setMinConversions, minCtr, setMinCtr,
    healthFilter, setHealthFilter, teamId, setTeamId,
    fromValue, toValue, fromDate, toDate, setFrom, setTo,
    clearFilters, hasFilters,
  } = useCreativeFilters();
  const getCreativeHref = useCallback((creativeId: string) => {
    const params = new URLSearchParams();
    params.set("from", fromValue);
    params.set("to", toValue);
    return `/creatives/${creativeId}?${params.toString()}`;
  }, [fromValue, toValue]);

  const accountsQuery = useQuery(trpc.adAccount.list.queryOptions());
  const adSetsQuery = useQuery(trpc.adSet.list.queryOptions());
  const campaignsQuery = useQuery(trpc.campaign.list.queryOptions());
  const landingPagesQuery = useQuery(trpc.adCreative.landingPages.queryOptions());
  const teamsQuery = useQuery(trpc.team.list.queryOptions());
  const metaAccountId = accountsQuery.data?.find((a) => a.id === accountId)?.metaAccountId
    ?? accountsQuery.data?.[0]?.metaAccountId ?? "";
  const [exportOpen, setExportOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({
    angle: false,
    awarenessLevel: false,
    format: false,
    health: false,
    avgCpa: false,
  });

  const creatives = useQuery(
    trpc.adCreative.list.queryOptions({
      format: format || undefined,
      awarenessLevel: awareness || undefined,
      search: search || undefined,
      accountId: accountId ? accountId : undefined,
      adSetIds: adSetIds ? adSetIds.split(",") : undefined,
      campaignIds: campaignIds ? campaignIds.split(",") : undefined,
      landingPageUrls: landingPageUrls.length ? landingPageUrls : undefined,
      teamId: teamId || undefined,
      from: fromValue,
      to: toValue,
      includeHealth: Boolean(healthFilter) || columnVisibility.health === true,
      minRoas: minRoas === "" ? undefined : Number(minRoas),
      minConversions: minConversions === "" ? undefined : Number(minConversions),
      minCtr: minCtr === "" ? undefined : Number(minCtr),
    }),
  );

  const healthValues = healthFilter ? healthFilter.split(",").filter(Boolean) as CreativeHealth[] : [];

  const creativeRows = [...(creatives.data ?? [])]
    .filter((c) => {
      if (healthValues.length === 0) return true;
      return c.health != null && healthValues.includes(c.health);
    })
;

  const selectedCreativeIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);

  const exportFilterLabels = (() => {
    const labels: { label: string; value: string }[] = [];
    if (format) labels.push({ label: "Format", value: format });
    if (awareness) labels.push({ label: "Awareness", value: awareness });
    if (search) labels.push({ label: "Search", value: search });
    if (accountId) {
      const name = accountsQuery.data?.find((a) => a.id === accountId)?.name ?? accountId;
      labels.push({ label: "Account", value: name });
    }
    if (teamId) {
      const name = teamsQuery.data?.find((t) => t.id === teamId)?.name ?? teamId;
      labels.push({ label: "Team", value: name });
    }
    const selectedCount = (csv: string) => `${csv.split(",").filter(Boolean).length} selected`;
    if (adSetIds) {
      labels.push({ label: "Ad sets", value: selectedCount(adSetIds) });
    }
    if (campaignIds) {
      labels.push({ label: "Campaigns", value: selectedCount(campaignIds) });
    }
    if (landingPageUrls.length) {
      labels.push({ label: "Landing pages", value: landingPageUrls.length === 1 ? formatLandingPage(landingPageUrls[0]) : `${landingPageUrls.length} selected` });
    }
    if (healthFilter) labels.push({ label: "Health", value: healthFilter });
    return labels;
  })();



  const total = creativeRows.length;
  const totalAds = creativeRows.reduce((sum, c) => sum + c.adCount, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Creatives</h1>
        {total > 0 && (
          <span className="text-[13px] tabular-nums text-muted-foreground/50">
            {total} creatives · {totalAds} ads
          </span>
        )}
      </div>

      {/* Filters + Actions */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md bg-muted/40 pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/30 focus:bg-muted/60 focus:ring-1 focus:ring-border transition-colors"
          />
        </div>
        <DateRangePicker
          from={fromDate}
          to={toDate}
          onChange={(range) => {
            if (range) {
              setFrom(formatDateOnly(range.from));
              setTo(formatDateOnly(range.to));
            }
          }}
        />
        {accountsQuery.data && accountsQuery.data.length > 0 && (
          <FilterPill
            value={accountId || "all"}
            onValueChange={(v) => setAccountId(v === "all" ? "" : v)}
            placeholder="Account"
            options={[
              { label: "All Accounts", value: "all" },
              ...accountsQuery.data.map((a) => ({ label: a.name, value: a.id })),
            ]}
          />
        )}
        {teamsQuery.data && teamsQuery.data.length > 0 && (
          <FilterPill
            value={teamId || "all"}
            onValueChange={(v) => setTeamId(v === "all" ? "" : v)}
            placeholder="Team"
            options={[
              { label: "All Teams", value: "all" },
              { label: "No Team", value: "none" },
              ...teamsQuery.data.map((t) => ({ label: t.name, value: t.id })),
            ]}
          />
        )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
        {adSetsQuery.data && adSetsQuery.data.length > 0 && (
          <AdSetCombobox
            value={adSetIds ? adSetIds.split(",").filter(Boolean) : []}
            onValueChange={(ids) => setAdSetIds(ids.length ? ids.join(",") : "")}
            adSets={adSetsQuery.data}
          />
        )}
        {campaignsQuery.data && campaignsQuery.data.length > 0 && (
          <CampaignCombobox
            value={campaignIds ? campaignIds.split(",").filter(Boolean) : []}
            onValueChange={(ids) => setCampaignIds(ids.length ? ids.join(",") : "")}
            campaigns={campaignsQuery.data}
          />
        )}
        {landingPagesQuery.data && landingPagesQuery.data.length > 0 && (
          <LandingPageCombobox
            value={landingPageUrls}
            onValueChange={setLandingPageUrls}
            landingPages={landingPagesQuery.data}
          />
        )}
        <PerformanceFilter
          minRoas={minRoas}
          minConversions={minConversions}
          minCtr={minCtr}
          onMinRoasChange={setMinRoas}
          onMinConversionsChange={setMinConversions}
          onMinCtrChange={setMinCtr}
        />
        <MoreFilters
          format={format}
          awareness={awareness}
          health={healthFilter}
          onFormatChange={(value) => setFormat(value === "all" ? null : (value as (typeof FORMATS)[number]))}
          onAwarenessChange={(value) => setAwareness(value === "all" ? null : (value as (typeof AWARENESS)[number]))}
          onHealthChange={(value) => setHealthFilter(value === "all" ? "" : value)}
          onClear={() => { setFormat(null); setAwareness(null); setHealthFilter(""); }}
        />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
        <DataTableColumnToggle
          columns={tableColumns}
          visibility={columnVisibility}
          onVisibilityChange={setColumnVisibility}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Download className="size-3.5" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setExportOpen(true)}>
              Export…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!isReadOnly ? (
          <Button size="sm" variant="outline" asChild className="gap-1.5">
            <Link href="/import"><Upload className="size-3.5" /> Import</Link>
          </Button>
        ) : null}
        </div>
      </div>

      {!isReadOnly ? (
        <StaleDataBanner
          account={accountsQuery.data?.find((a) => a.id === accountId) ?? accountsQuery.data?.[0]}
        />
      ) : null}

      {/* Data Table */}
      {creatives.isLoading ? (
        <TableLoadingSkeleton />
      ) : total === 0 ? (
        <EmptyState
          hasFilters={hasFilters}
          onClear={clearFilters}
          onImport={!isReadOnly ? () => router.push("/import") : undefined}
          readOnly={isReadOnly}
        />
      ) : (
        <DataTable
          columns={tableColumns}
          data={creativeRows as Creative[]}
          getRowId={(row) => row.id}
          onRowClick={(row) => router.push(getCreativeHref(row.id))}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          meta={{ metaAccountId, teams: Object.fromEntries((teamsQuery.data ?? []).map((t) => [t.id, t.name])) }}
        />
      )}

      <CreativeBulkActions
        selectedIds={selectedCreativeIds}
        teams={teamsQuery.data ?? []}
        onComplete={() => setRowSelection({})}
      />

      <ExportPreviewDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        filters={{
          from: fromValue,
          to: toValue,
          format: format || undefined,
          awarenessLevel: awareness || undefined,
          search: search || undefined,
          accountId: accountId || undefined,
          adSetIds: adSetIds ? adSetIds.split(",") : undefined,
          campaignIds: campaignIds ? campaignIds.split(",") : undefined,
          landingPageUrls: landingPageUrls.length ? landingPageUrls : undefined,
          teamId: teamId || undefined,
        }}
        filterLabels={exportFilterLabels}
      />
    </div>
  );
}
