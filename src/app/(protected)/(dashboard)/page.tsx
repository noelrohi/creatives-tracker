"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { subDays } from "date-fns";
import { useQueryState, parseAsString } from "nuqs";
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
  TrendingUp,
  Upload,
  Target,
  MousePointerClick,
  ShoppingCart,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Video,
} from "lucide-react";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";

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

function fmtDate(val: unknown) {
  if (val == null || val === "") return "—";
  const str = String(val);
  try {
    return new Date(str + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return str;
  }
}

type TrackerRow = {
  adId: string;
  adName: string;
  creativeId: string | null;
  creativeName: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
  format: string | null;
  ownership: string | null;
  destinationUrl: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  spend: string | null;
  roas: string | null;
  cpa: string | null;
  ctr: string | null;
  conversions: number | null;
  impressions: number | null;
  linkClicks: number | null;
  purchaseValue: string | null;
  landingPageViews: number | null;
};

function downloadTrackerCsv(rows: TrackerRow[], filename: string) {
  const headers = [
    "Date",
    "Ad Name",
    "Creative",
    "Format",
    "Ownership",
    "Asset URL",
    "Video URL",
    "Landing Page URL",
    "Spend",
    "ROAS",
    "CPA",
    "CTR",
    "Conversions",
    "Impressions",
    "Link Clicks",
    "Revenue",
    "LP Views",
  ];
  const csvRows = rows.map((r) => [
    r.dateStart ?? "",
    r.adName,
    r.creativeName ?? "",
    r.format ?? "",
    r.ownership ?? "",
    r.assetUrl ?? "",
    r.videoUrl ?? "",
    r.destinationUrl ?? "",
    r.spend ?? "",
    r.roas ?? "",
    r.cpa ?? "",
    r.ctr ?? "",
    r.conversions ?? "",
    r.impressions ?? "",
    r.linkClicks ?? "",
    r.purchaseValue ?? "",
    r.landingPageViews ?? "",
  ]);

  const csv = [headers, ...csvRows]
    .map((row) =>
      row.map((cell) => {
        const str = String(cell);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }).join(","),
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

  const tracker = useQuery(
    trpc.adCreative.trackerList.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: selectedAccountId,
      ownership: ownership === "all" ? undefined : (ownership as "ours" | "theirs"),
    }),
  );

  const rows = (tracker.data ?? []) as TrackerRow[];

  // Compute summary KPIs from tracker data
  const totalSpend = rows.reduce((sum, r) => sum + (r.spend ? parseFloat(r.spend) : 0), 0);
  const totalRevenue = rows.reduce((sum, r) => sum + (r.purchaseValue ? parseFloat(r.purchaseValue) : 0), 0);
  const totalConversions = rows.reduce((sum, r) => sum + (r.conversions ?? 0), 0);
  const avgRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const avgCpa = totalConversions > 0 ? totalSpend / totalConversions : 0;
  const totalImpressions = rows.reduce((sum, r) => sum + (r.impressions ?? 0), 0);
  const totalClicks = rows.reduce((sum, r) => sum + (r.linkClicks ?? 0), 0);
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  const kpis = [
    { label: "ROAS", value: avgRoas > 0 ? `${avgRoas.toFixed(2)}x` : "—", icon: TrendingUp, accent: "text-emerald-500" },
    { label: "CPA", value: avgCpa > 0 ? fmtMoney(avgCpa) : "—", icon: Target, accent: "text-blue-500" },
    { label: "CTR", value: avgCtr > 0 ? `${avgCtr.toFixed(2)}%` : "—", icon: MousePointerClick, accent: "text-violet-500" },
    { label: "Conversions", value: totalConversions > 0 ? fmtNum(totalConversions) : "—", icon: ShoppingCart, accent: "text-amber-500" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tracker</h1>
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
          <Select value={ownership || "ours"} onValueChange={setOwnership}>
            <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ours">Ours</SelectItem>
              <SelectItem value="theirs">Theirs</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[13px]"
            disabled={rows.length === 0}
            onClick={() => downloadTrackerCsv(rows, `tracker_${fromValue}_${toValue}.csv`)}
          >
            <Download className="size-3.5" /> Export
          </Button>
          <Button asChild size="sm" variant="outline" className="h-7 gap-1.5 text-[13px]">
            <Link href="/import">
              <Upload className="size-3.5" /> Import
            </Link>
          </Button>
        </div>
      </div>

      <StaleDataBanner
        account={accountId ? accounts.data?.find((a) => a.id === accountId) : accounts.data?.[0]}
      />

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-lg border border-border px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70">
              <kpi.icon className={`size-3.5 ${kpi.accent}`} />
              {kpi.label}
            </div>
            {tracker.isLoading ? (
              <Skeleton className="mt-1 h-6 w-20" />
            ) : (
              <span className="mt-0.5 block text-lg font-semibold tabular-nums leading-tight">
                {kpi.value}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Spend + Revenue bar */}
      <div className="rounded-lg border border-border px-4 py-3">
        <div className="flex items-center gap-8">
          <div>
            <p className="text-[13px] text-muted-foreground">Spend</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {tracker.isLoading ? "—" : fmtMoney(totalSpend)}
            </p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">Revenue</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {tracker.isLoading ? "—" : fmtMoney(totalRevenue)}
            </p>
          </div>
        </div>
      </div>

      {/* Tracker Table */}
      {tracker.isLoading ? (
        <div className="rounded-lg border divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="size-8 rounded" />
              <Skeleton className="h-4 w-40" />
              <div className="flex-1" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16">
          <p className="text-sm text-muted-foreground">No active ads found for this period</p>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link href="/import">
              <Upload className="size-3.5" /> Import Ads
            </Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px]">Media</TableHead>
                <TableHead>Ad</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Landing Page</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">ROAS</TableHead>
                <TableHead className="text-right">CPA</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">Conv</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => {
                const roas = row.roas ? parseFloat(row.roas) : null;
                return (
                  <TableRow key={`${row.adId}-${row.dateStart}-${i}`}>
                    <TableCell>
                      {row.assetUrl ? (
                        <a href={row.videoUrl || row.assetUrl} target="_blank" rel="noopener noreferrer">
                          {row.format === "video" ? (
                            <div className="relative size-9 rounded bg-muted flex items-center justify-center overflow-hidden">
                              <img
                                src={row.assetUrl}
                                alt=""
                                className="size-9 rounded object-cover"
                              />
                              <Video className="absolute size-3.5 text-white drop-shadow" />
                            </div>
                          ) : (
                            <img
                              src={row.assetUrl}
                              alt=""
                              className="size-9 rounded object-cover"
                            />
                          )}
                        </a>
                      ) : (
                        <div className="size-9 rounded bg-muted flex items-center justify-center">
                          <ImageIcon className="size-3.5 text-muted-foreground/40" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/creatives/${row.creativeId}`}
                          className="text-sm font-medium hover:underline truncate max-w-[220px]"
                        >
                          {row.adName}
                        </Link>
                        {row.ownership && (
                          <Badge variant="secondary" className="text-[10px] capitalize shrink-0">
                            {row.ownership}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                      {fmtDate(row.dateStart)}
                    </TableCell>
                    <TableCell>
                      {row.destinationUrl ? (
                        <a
                          href={row.destinationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground truncate max-w-[200px]"
                        >
                          {new URL(row.destinationUrl).hostname.replace("www.", "")}
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {fmtMoney(row.spend)}
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
                      {fmtPct(row.ctr)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {fmtNum(row.conversions)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
