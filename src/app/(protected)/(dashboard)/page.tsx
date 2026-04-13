"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTransition } from "react";
import { subDays } from "date-fns";
import { useQueryState, parseAsString } from "nuqs";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  ArrowRight,
  ImageIcon,
  Video,
  Shield,
} from "lucide-react";
import { PerformanceChart } from "@/components/blocks/insights/performance-chart";
import { computeHealth, type CreativeHealth } from "@/lib/creative-health";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

function fmtMoney(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `$${n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2)}`;
}

function fmtRoas(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `${n.toFixed(2)}x`;
}

function fmtPct(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function fmtNum(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseInt(val, 10) : Number(val);
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

type LeaderboardRow = {
  id: string;
  name: string;
  format: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
  totalSpend: string;
  roas: string;
  cpa: string | null;
  ctr: string | null;
  conversions: string;
  adStatus: string | null;
  runningDays?: number;
};

const HEALTH_STYLES: Record<CreativeHealth, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  warning: { label: "Warning", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  critical: { label: "Critical", className: "bg-red-500/15 text-red-500 dark:text-red-400" },
};

function HealthBadge({ row }: { row: LeaderboardRow }) {
  const health = computeHealth({
    roas: row.roas ? parseFloat(row.roas) : null,
    spend: row.totalSpend ? parseFloat(row.totalSpend) : null,
    conversions: row.conversions ? parseInt(row.conversions, 10) : null,
    status: row.adStatus,
  });
  if (!health) return null;
  const style = HEALTH_STYLES[health];
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}

function MediaPreview({ row }: { row: LeaderboardRow }) {
  const href = row.videoUrl || row.assetUrl;

  if (!href) {
    return (
      <div className="flex size-8 items-center justify-center rounded bg-muted">
        <ImageIcon className="size-3.5 text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="block"
    >
      {row.assetUrl ? (
        <div className="relative size-8 overflow-hidden rounded bg-muted">
          <img src={row.assetUrl} alt="" className="size-full object-cover" />
          {row.format === "video" && (
            <Video className="absolute inset-0 m-auto size-3.5 text-white drop-shadow" />
          )}
        </div>
      ) : (
        <div className="flex size-8 items-center justify-center rounded bg-muted">
          {row.format === "video" ? (
            <Video className="size-3.5 text-muted-foreground/60" />
          ) : (
            <ImageIcon className="size-3.5 text-muted-foreground/40" />
          )}
        </div>
      )}
    </a>
  );
}

function LeaderboardTable({
  title,
  icon,
  rows,
  isLoading,
  emptyMessage,
  viewAllHref,
  canManageData,
}: {
  title: string;
  icon: React.ReactNode;
  rows: LeaderboardRow[];
  isLoading: boolean;
  emptyMessage: string;
  viewAllHref: string;
  canManageData: boolean;
}) {
  if (isLoading) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            {title}
          </h2>
        </div>
        <div className="rounded-lg border divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <div className="flex-1" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            {title}
          </h2>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          {canManageData ? (
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link href="/import">
                <Upload className="size-3.5" /> Import Ads
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            {title}
          </h2>
        </div>
        <Button variant="ghost" size="sm" asChild className="text-[13px] text-muted-foreground">
          <Link href={viewAllHref}>
            View All <ArrowRight className="ml-1 size-3" />
          </Link>
        </Button>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Creative</TableHead>
              <TableHead className="text-right">Conv</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
              <TableHead className="text-right">CPA</TableHead>
              <TableHead className="text-right">Spend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const roas = row.roas ? parseFloat(row.roas) : null;
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <MediaPreview row={row} />
                      <Link href={`/creatives/${row.id}`} className="text-sm font-medium hover:underline truncate max-w-[200px]">
                        {row.name}
                      </Link>
                      {row.format && (
                        <Badge variant="secondary" className="text-[11px] capitalize shrink-0">{row.format}</Badge>
                      )}
                      {row.adStatus && (
                        <Badge variant="outline" className="text-[11px] capitalize shrink-0">{row.adStatus}</Badge>
                      )}
                      <HealthBadge row={row} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium">
                    {fmtNum(row.conversions)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    <span className={roas != null && roas >= 1 ? "text-emerald-500" : roas != null ? "text-red-400" : ""}>
                      {fmtRoas(row.roas)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {fmtMoney(row.cpa)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {fmtMoney(row.totalSpend)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const EXPORT_COLUMNS = [
  "date_start", "date_end",
  "campaign_name",
  "ad_set_name",
  "ad_name", "ad_status", "caption", "destination_url",
  "creative_name", "format", "angle", "persona", "awareness_level", "ownership",
  "asset_url", "video_url",
  "spend", "impressions", "reach", "frequency", "cpm", "cpc",
  "link_clicks", "ctr", "landing_page_views", "cost_per_lpv",
  "conversions", "purchase_value", "roas", "cpa",
  "add_to_cart", "initiate_checkout", "cost_per_add_to_cart",
  "video_views_3s", "video_thruplay", "video_avg_watch_time",
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

export default function DashboardPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [exporting, startExport] = useTransition();
  const { role } = useActiveOrganizationRole();
  const canManageData = role !== "member";

  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [ownership, setOwnership] = useQueryState("ownership", parseAsString.withDefault("ours"));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));

  const selectedAccountId = accountId || undefined;
  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);

  const accounts = useQuery(trpc.adAccount.list.queryOptions());

  const stats = useQuery(
    trpc.adCreative.dashboardStats.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: selectedAccountId,
      ownership: ownership === "all" ? undefined : (ownership as "ours" | "theirs"),
    }),
  );

  const dailyPerf = useQuery(
    trpc.adCreative.getDailyPortfolioPerformance.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: selectedAccountId,
      ownership: ownership === "all" ? undefined : (ownership as "ours" | "theirs"),
    }),
  );

  const portfolio = stats.data?.portfolio;
  const topPerformers = stats.data?.topPerformers ?? [];
  const bottomPerformers = stats.data?.bottomPerformers ?? [];
  const survivingCreatives = stats.data?.survivingCreatives ?? [];

  const baseCreativesParams = new URLSearchParams();
  if (accountId) baseCreativesParams.set("account", accountId);
  if (ownership && ownership !== "all") baseCreativesParams.set("ownership", ownership);
  const baseHref = `/creatives${baseCreativesParams.toString() ? `?${baseCreativesParams}` : ""}`;

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
        <h1 className="text-lg font-semibold">Dashboard</h1>
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
          <Select value={ownership || "all"} onValueChange={setOwnership}>
            <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="ours">Ours</SelectItem>
              <SelectItem value="theirs">Theirs</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-[13px]"
            disabled={exporting}
            onClick={() => {
              startExport(async () => {
                try {
                  const rows = await queryClient.fetchQuery(
                    trpc.adCreative.dashboardExport.queryOptions({
                      from: fromValue,
                      to: toValue,
                      accountId: selectedAccountId,
                      ownership: ownership === "all" ? undefined : (ownership as "ours" | "theirs"),
                    }),
                  );
                  if (!rows.length) {
                    toast.info("No data to export for this date range");
                    return;
                  }
                  downloadCsv(rows, `dashboard_${fromValue}_${toValue}.csv`);
                  toast.success(`Exported ${rows.length} rows`);
                } catch (err) {
                  console.error("Export failed:", err);
                  toast.error("Export failed — check the console for details");
                }
              });
            }}
          >
            <Download className="size-3.5" /> {exporting ? "Exporting…" : "Export"}
          </Button>
          {canManageData ? (
            <Button asChild size="sm" variant="outline" className="h-7 gap-1.5 text-[13px]">
              <Link href="/import">
                <Upload className="size-3.5" /> Import
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <StaleDataBanner
        account={accountId ? accounts.data?.find((a) => a.id === accountId) : accounts.data?.[0]}
      />

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

      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="charts">Charts</TabsTrigger>
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
              canManageData={canManageData}
            />
            <LeaderboardTable
              title="Needs Attention"
              icon={<AlertTriangle className="size-3.5 text-red-400" />}
              rows={bottomPerformers}
              isLoading={stats.isLoading}
              emptyMessage="No underperformers detected"
              viewAllHref={`${baseHref}${baseHref.includes("?") ? "&" : "?"}health=critical`}
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
            canManageData={canManageData}
          />
        </TabsContent>

        <TabsContent value="charts" className="pt-4">
          {dailyPerf.data && dailyPerf.data.length > 1 ? (
            <div className="rounded-lg border border-border px-4 py-3">
              <PerformanceChart logs={dailyPerf.data as Array<typeof dailyPerf.data[number] & Record<string, unknown>>} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground/50">No daily performance data for this period</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
