"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useQueryState, parseAsString } from "nuqs";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  DollarSign,
  Target,
  ShoppingCart,
  Tag,
  ArrowRight,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StaleDataBanner } from "@/components/data-freshness";

function fmt(val: unknown, prefix = "", suffix = "") {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `${prefix}${n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n >= 100 ? n.toFixed(0) : n.toFixed(2)}${suffix}`;
}

export default function DashboardPage() {
  const trpc = useTRPC();

  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));

  const accounts = useQuery(trpc.account.list.queryOptions());
  const selectedAccountId = accountId || undefined;

  // Current period (7d) and prior period (7d before that)
  const current = useQuery(trpc.insights.summary.queryOptions({ days: 7, accountId: selectedAccountId }));
  const prior = useQuery(trpc.insights.summary.queryOptions({ days: 14, accountId: selectedAccountId }));
  const topCreatives = useQuery(trpc.insights.topCreatives.queryOptions({ metric: "roas", limit: 5, days: 7, accountId: selectedAccountId }));
  const untagged = useQuery(trpc.insights.untaggedCount.queryOptions({ accountId: selectedAccountId }));

  const isLoading = current.isLoading || accounts.isLoading;

  // Compute deltas (current 7d vs prior 7d approximation)
  // prior.data is 14d total, so prior period ≈ prior - current
  function delta(currentVal: unknown, priorVal: unknown): { value: number; direction: "up" | "down" | "flat" } | null {
    if (currentVal == null || priorVal == null) return null;
    const c = typeof currentVal === "string" ? parseFloat(currentVal) : Number(currentVal);
    const p = typeof priorVal === "string" ? parseFloat(priorVal) : Number(priorVal);
    if (isNaN(c) || isNaN(p) || p === 0) return null;
    // prior 14d includes current 7d, so prior-only ≈ p*2 - c (rough estimate)
    const priorOnly = p * 2 - c;
    if (priorOnly === 0) return { value: 0, direction: "flat" };
    const pct = ((c - priorOnly) / Math.abs(priorOnly)) * 100;
    return { value: Math.abs(pct), direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
  }

  const metrics = [
    {
      label: "Spend (7d)",
      value: fmt(current.data?.totalSpend, "$"),
      delta: delta(current.data?.totalSpend, prior.data?.totalSpend),
      icon: DollarSign,
      color: "text-amber-500",
      invertDelta: true, // spend up = bad
    },
    {
      label: "Avg ROAS",
      value: fmt(current.data?.avgRoas, "", "x"),
      delta: delta(current.data?.avgRoas, prior.data?.avgRoas),
      icon: TrendingUp,
      color: "text-emerald-500",
    },
    {
      label: "Avg CPA",
      value: fmt(current.data?.avgCpa, "$"),
      delta: delta(current.data?.avgCpa, prior.data?.avgCpa),
      icon: Target,
      color: "text-blue-500",
      invertDelta: true, // CPA up = bad
    },
    {
      label: "Conversions",
      value: current.data?.totalConversions != null ? Number(current.data.totalConversions) : "—",
      delta: delta(current.data?.totalConversions, prior.data?.totalConversions),
      icon: ShoppingCart,
      color: "text-violet-500",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header with account selector */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <div className="flex items-center gap-2">
          {accounts.data && accounts.data.length > 0 && (
            <Select value={accountId || "all"} onValueChange={(v) => setAccountId(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 w-auto gap-1 text-[13px]">
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
        </div>
      </div>

      <StaleDataBanner
        account={accountId ? accounts.data?.find((a) => a.id === accountId) : accounts.data?.[0]}
      />

      {/* Key metrics */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-border px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70">
              <m.icon className={cn("size-3.5", m.color)} />
              {m.label}
            </div>
            {isLoading ? (
              <Skeleton className="mt-1 h-6 w-16" />
            ) : (
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-lg font-semibold tabular-nums leading-tight">
                  {m.value}
                </span>
                {m.delta && m.delta.value > 0.5 && (
                  <span
                    className={cn(
                      "text-[11px] tabular-nums",
                      m.invertDelta
                        ? m.delta.direction === "up" ? "text-red-500" : "text-emerald-500"
                        : m.delta.direction === "up" ? "text-emerald-500" : "text-red-500",
                    )}
                  >
                    {m.delta.direction === "up" ? "+" : "-"}{m.delta.value.toFixed(0)}%
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Untagged CTA */}
      {!untagged.isLoading && untagged.data != null && untagged.data > 0 && (
        <Link
          href={`/creatives?untagged=true${accountId ? `&account=${accountId}` : ""}`}
          className="flex items-center gap-3 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 px-4 py-3 transition-colors hover:bg-amber-500/10"
        >
          <Tag className="size-4 text-amber-500" />
          <p className="flex-1 text-sm">
            <span className="font-medium">{untagged.data} creative{untagged.data > 1 ? "s" : ""}</span>{" "}
            <span className="text-muted-foreground">need tagging to unlock insights</span>
          </p>
          <ArrowRight className="size-3.5 text-muted-foreground" />
        </Link>
      )}

      {/* Top performers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            Top Performers (7d)
          </h2>
          <Button variant="ghost" size="sm" asChild className="text-[13px] text-muted-foreground">
            <Link href={`/insights${accountId ? `?account=${accountId}` : ""}`}>
              View Insights <ArrowRight className="ml-1 size-3" />
            </Link>
          </Button>
        </div>

        {topCreatives.isLoading ? (
          <div className="rounded-lg border">
            <div className="divide-y">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-14" />
                  <div className="flex-1" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-12" />
                </div>
              ))}
            </div>
          </div>
        ) : topCreatives.data && topCreatives.data.length > 0 ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Creative</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Angle</TableHead>
                  <TableHead className="text-right">ROAS</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topCreatives.data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link href={`/creatives/${row.id}`} className="text-sm font-medium hover:underline">
                        {row.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {row.format ? (
                        <Badge variant="secondary" className="text-[11px] capitalize">{row.format}</Badge>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{row.angle || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-medium">
                      {fmt(row.avgRoas, "", "x")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {fmt(row.totalSpend, "$")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12">
            <p className="text-sm text-muted-foreground">No performance data yet</p>
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link href="/import">
                <Upload className="size-3.5" /> Import Ads
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
