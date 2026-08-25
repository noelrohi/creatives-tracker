"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTransition } from "react";
import { subDays } from "date-fns";
import { useQueryState, parseAsString } from "nuqs";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DollarSign,
  TrendingUp,
  Download,
  Upload,
  Target,
  MousePointerClick,
  ShoppingCart,
  Trophy,
  AlertTriangle,
  Shield,
} from "@/components/icons";
import { CombinedPerformanceChart } from "@/components/blocks/insights/combined-performance-chart";
import {
  MerAccountBreakdown,
  MerSummary,
} from "@/components/blocks/mer/mer-panel";
import { DemographicBreakdownChart } from "@/components/blocks/dashboard/demographic-chart";
import { LeaderboardTable } from "@/components/blocks/dashboard/leaderboard-table";
import { fmtMoney, fmtNum, fmtPct, fmtRoas } from "@/lib/fmt";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { BREAKDOWN_RETENTION_DAYS, clampBreakdownRange } from "@/lib/retention/policy";
import { BreakdownWindowCaption } from "@/components/blocks/dashboard/breakdown-window-caption";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { ExportPreviewDialog } from "@/components/blocks/export-preview-dialog";
import { FORMATS } from "@/components/blocks/creatives/creative-list-filters";
import { useState } from "react";

const EXPORT_COLUMNS = [
  "date_start", "date_end",
  "campaign_name",
  "ad_set_name",
  "ad_name", "ad_status", "caption", "destination_url",
  "creative_name", "format", "angle", "persona", "awareness_level",
  "asset_url", "video_url",
  "spend", "impressions", "reach", "frequency", "cpm", "cpc",
  "link_clicks", "ctr", "landing_page_views", "cost_per_lpv",
  "conversions", "purchase_value", "roas", "cpa",
  "add_to_cart", "initiate_checkout", "cost_per_add_to_cart",
  "video_views_3s", "video_thruplay", "video_avg_watch_time",
  "country", "platform", "placement", "device", "age", "gender",
  "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
] as const;

function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  const csv = [EXPORT_COLUMNS.join(",")]
    .concat(
      rows.map((row) =>
        EXPORT_COLUMNS.map((col) => {
          const val = row[col];
          if (val == null) return "";
          const str = Array.isArray(val) ? val.join("; ") : String(val);
          return str.includes(",") || str.includes('"') || str.includes("\n")
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        }).join(","),
      ),
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


export default function MetaDashboardPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [exporting, startExport] = useTransition();
  const { role } = useActiveOrganizationRole();
  const isReadOnly = role === "member";
  const canManageData = !isReadOnly;

  const [exportOpen, setExportOpen] = useState(false);
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [teamId, setTeamId] = useQueryState("team", parseAsString.withDefault(""));
  const [format, setFormat] = useQueryState("format", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));
  const [tab, setTab] = useQueryState("tab", parseAsString.withDefault("overview"));
  const [dimension, setDimension] = useQueryState("dim", parseAsString.withDefault("gender"));

  const selectedAccountId = accountId ? accountId : undefined;
  const selectedTeamId = teamId || undefined;
  const selectedFormat = FORMATS.find((value) => value === format);
  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);

  const accounts = useQuery(trpc.adAccount.list.queryOptions());
  const teamsQuery = useQuery(trpc.team.list.queryOptions());

  const stats = useQuery(
    trpc.adCreative.dashboardStats.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: selectedAccountId,
      teamId: selectedTeamId,
      format: selectedFormat,
    }),
  );

  const dailyPerf = useQuery({
    ...trpc.adCreative.getDailyPortfolioPerformance.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: selectedAccountId,
      teamId: selectedTeamId,
      format: selectedFormat,
    }),
    enabled: tab === "charts",
  });

  // Breakdown rows are only retained for 14 days, so the demographics query is
  // clamped to that window and the tab says so when the range is wider.
  const demoWindow = clampBreakdownRange({
    from: fromValue,
    to: toValue,
    today: formatDateOnly(new Date()),
  });

  const demographic = useQuery({
    ...trpc.performanceLog.demographicBreakdown.queryOptions({
      dimension: dimension as "age" | "gender" | "country" | "device",
      from: demoWindow.from,
      to: toValue,
      accountId: selectedAccountId,
      teamId: selectedTeamId,
      format: selectedFormat,
    }),
    enabled: tab === "demographics" && demoWindow.hasWindow,
  });

  const portfolio = stats.data?.portfolio;
  const topPerformers = stats.data?.topPerformers ?? [];
  const bottomPerformers = stats.data?.bottomPerformers ?? [];
  const survivingCreatives = stats.data?.survivingCreatives ?? [];
  const dailyPerfLogs = dailyPerf.data ?? [];
  const hasDailyPerfData = dailyPerfLogs.length > 1;
  const isDailyPerfLoading =
    !hasDailyPerfData && (dailyPerf.isLoading || dailyPerf.isFetching || !dailyPerf.isFetched);

  const baseCreativesParams = new URLSearchParams();
  baseCreativesParams.set("from", fromValue);
  baseCreativesParams.set("to", toValue);
  if (accountId) baseCreativesParams.set("account", accountId);
  if (teamId) baseCreativesParams.set("team", teamId);
  if (selectedFormat) baseCreativesParams.set("format", selectedFormat);
  const baseHref = `/creatives${baseCreativesParams.toString() ? `?${baseCreativesParams}` : ""}`;
  const creativeDetailParams = new URLSearchParams();
  creativeDetailParams.set("from", fromValue);
  creativeDetailParams.set("to", toValue);

  const kpis = [
    { label: "Spend", value: fmtMoney(portfolio?.totalSpend), icon: DollarSign, accent: "text-emerald-500" },
    { label: "Revenue", value: fmtMoney(portfolio?.totalRevenue), icon: TrendingUp, accent: "text-blue-500" },
    { label: "ROAS", value: fmtRoas(portfolio?.roas), icon: Target, accent: "text-violet-500" },
    { label: "CPA", value: fmtMoney(portfolio?.cpa), icon: Target, accent: "text-amber-500" },
    { label: "CTR", value: fmtPct(portfolio?.ctr), icon: MousePointerClick, accent: "text-rose-500" },
    { label: "Conversions", value: fmtNum(portfolio?.conversions), icon: ShoppingCart, accent: "text-orange-500" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Meta</h1>
        <div className="flex items-center gap-2">
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
          <Select value={selectedFormat ?? "all"} onValueChange={(value) => setFormat(value === "all" ? "" : value)}>
            <SelectTrigger className="h-7 w-auto gap-1 text-[13px] capitalize">
              <SelectValue placeholder="All formats" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All formats</SelectItem>
              {FORMATS.map((value) => (
                <SelectItem key={value} value={value} className="capitalize">{value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {accounts.data && accounts.data.length > 0 && (
            <Select value={accountId || "all"} onValueChange={(v) => setAccountId(v === "all" ? "" : v)}>
              <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.data.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {teamsQuery.data && teamsQuery.data.length > 0 && (
            <Select value={teamId || "all"} onValueChange={(v) => setTeamId(v === "all" ? "" : v)}>
              <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All teams</SelectItem>
                {teamsQuery.data.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-[13px]"
                disabled={exporting}
              >
                <Download className="size-3.5" /> {exporting ? "Exporting..." : "Export"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setExportOpen(true)}>
                Export…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  startExport(async () => {
                    try {
                      const rows = await queryClient.fetchQuery(
                        trpc.adCreative.dashboardExport.queryOptions({
                          from: fromValue,
                          to: toValue,
                          accountId: selectedAccountId,
                          teamId: selectedTeamId,
                          format: selectedFormat,
                          // Breakdown rows only exist for the last 14 days;
                          // wider ranges export base rows instead of failing.
                          scope: demoWindow.isClamped ? "base" : "all",
                        }),
                      );
                      if (!rows.length) {
                        toast.info("No data to export for this date range");
                        return;
                      }
                      downloadCsv(rows, `dashboard_${fromValue}_${toValue}.csv`);
                      toast.success(
                        demoWindow.isClamped
                          ? `Exported ${rows.length} base rows — breakdowns only go back ${BREAKDOWN_RETENTION_DAYS} days`
                          : `Exported ${rows.length} rows`,
                      );
                    } catch (err) {
                      console.error("Export failed:", err);
                      toast.error(getUserFacingErrorMessage(err, "Export failed — check the console for details"));
                    }
                  });
                }}
              >
                Raw perf logs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canManageData ? (
            <Button asChild size="sm" variant="outline" className="h-7 gap-1.5 text-[13px]">
              <Link href="/import">
                <Upload className="size-3.5" /> Import
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <section id="connections">
        {!isReadOnly ? (
          <StaleDataBanner
            account={accountId ? accounts.data?.find((a) => a.id === accountId) : accounts.data?.[0]}
          />
        ) : null}
      </section>

      {/* KPI cards — always visible */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-lg border border-border px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <kpi.icon className={`size-3 ${kpi.accent}`} />
              {kpi.label}
            </div>
            {stats.isLoading ? (
              <Skeleton className="mt-1 h-5 w-16" />
            ) : (
              <span className="mt-0.5 block text-base font-semibold tabular-nums leading-tight">
                {kpi.value}
              </span>
            )}
          </div>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="demographics">Demographics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-6 pt-4">
          <div className="grid gap-6 lg:grid-cols-2">
            <LeaderboardTable
              title="Top Performers"
              icon={<Trophy className="size-3.5 text-emerald-500" />}
              rows={topPerformers}
              isLoading={stats.isLoading}
              emptyMessage="No creatives with enough spend data yet"
              viewAllHref={`${baseHref}${baseHref.includes("?") ? "&" : "?"}health=healthy`}
              detailQueryString={creativeDetailParams.toString()}
              canManageData={canManageData}
            />
            <LeaderboardTable
              title="Needs Attention"
              icon={<AlertTriangle className="size-3.5 text-red-400" />}
              rows={bottomPerformers}
              isLoading={stats.isLoading}
              emptyMessage="Nothing urgent in this window"
              viewAllHref={`${baseHref}${baseHref.includes("?") ? "&" : "?"}health=critical`}
              detailQueryString={creativeDetailParams.toString()}
              canManageData={canManageData}
            />
          </div>
          <LeaderboardTable
            title="Surviving Creatives"
            icon={<Shield className="size-3.5 text-blue-500" />}
            rows={survivingCreatives}
            isLoading={stats.isLoading}
            emptyMessage="No long-running creatives with profitable ROAS yet"
            viewAllHref={`${baseHref}${baseHref.includes("?") ? "&" : "?"}health=healthy`}
            detailQueryString={creativeDetailParams.toString()}
            canManageData={canManageData}
          />
        </TabsContent>

        <TabsContent value="charts" className="flex flex-col gap-4 pt-4">
          <MerSummary
            from={fromValue}
            to={toValue}
            teamId={selectedTeamId}
            accountId={selectedAccountId}
            format={selectedFormat}
          />
          {isDailyPerfLoading ? (
            <div className="rounded-lg border border-border px-4 py-3">
              <Skeleton className="h-[300px] w-full rounded-lg" />
            </div>
          ) : hasDailyPerfData ? (
            <div className="rounded-lg border border-border px-4 py-3">
              <CombinedPerformanceChart
                logs={dailyPerfLogs as Array<typeof dailyPerfLogs[number] & Record<string, unknown>>}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground/50">No daily performance data for this period</p>
            </div>
          )}
          <MerAccountBreakdown
            from={fromValue}
            to={toValue}
            teamId={selectedTeamId}
            accountId={selectedAccountId}
          />
        </TabsContent>

        <TabsContent value="demographics" className="space-y-2 pt-4">
          {demoWindow.isClamped || !demoWindow.hasWindow ? (
            <BreakdownWindowCaption
              from={demoWindow.from}
              to={toValue}
              hasWindow={demoWindow.hasWindow}
            />
          ) : null}
          {demoWindow.hasWindow ? (
            <DemographicBreakdownChart
              data={demographic.data}
              dimension={dimension as "age" | "gender" | "country" | "device"}
              onDimensionChange={setDimension}
              isLoading={demographic.isLoading}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      <ExportPreviewDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        filters={{
          from: fromValue,
          to: toValue,
          accountId: selectedAccountId,
          teamId: selectedTeamId,
          format: selectedFormat,
        }}
        filterLabels={[
          ...(accountId
            ? [{
                label: "Account",
                value: accounts.data?.find((a) => a.id === accountId)?.name ?? accountId,
              }]
            : []),
          ...(selectedFormat
            ? [{ label: "Format", value: selectedFormat }]
            : []),
          ...(teamId
            ? [{
                label: "Team",
                value: teamsQuery.data?.find((t) => t.id === teamId)?.name ?? teamId,
              }]
            : []),
        ]}
      />
    </div>
  );
}
