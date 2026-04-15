"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { subDays } from "date-fns";
import { useQueryState, parseAsString } from "nuqs";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useTRPC } from "@/lib/trpc/client";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { LeaderboardTable } from "@/components/blocks/dashboard/leaderboard-table";
import { RevenueSpendChart } from "@/components/blocks/mer/revenue-spend-chart";
import { Sparkline } from "@/components/blocks/mer/sparkline";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { fmtMoney, fmtRoas } from "@/lib/fmt";

function InlineDelta({
  value,
  format,
  invertColor = false,
}: {
  value: string | null;
  format: (v: string) => string;
  invertColor?: boolean;
}) {
  if (value == null) return <span className="text-muted-foreground/30 text-[10px]">—</span>;
  const n = parseFloat(value);
  if (isNaN(n) || Math.abs(n) < 0.0001)
    return <span className="text-muted-foreground/40 text-[10px] tabular-nums">±0</span>;
  const isPositive = n > 0;
  const isGood = invertColor ? !isPositive : isPositive;
  return (
    <span
      className={`text-[10px] tabular-nums leading-none ${
        isGood ? "text-emerald-500" : "text-red-400"
      }`}
    >
      {isPositive ? "▲" : "▼"} {format(Math.abs(n).toString())}
    </span>
  );
}

export default function MerPage() {
  const trpc = useTRPC();
  const { role } = useActiveOrganizationRole();
  const canManageData = role !== "member";

  const [teamId, setTeamId] = useQueryState("team", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));

  const selectedTeamId = teamId || undefined;
  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);

  const teamsQuery = useQuery(trpc.team.list.queryOptions());

  const stats = useQuery(
    trpc.adCreative.dashboardStats.queryOptions({
      from: fromValue,
      to: toValue,
      teamId: selectedTeamId,
    }),
  );

  const dailyPerf = useQuery(
    trpc.adCreative.getDailyPortfolioPerformance.queryOptions({
      from: fromValue,
      to: toValue,
      teamId: selectedTeamId,
    }),
  );

  const breakdown = useQuery(
    trpc.adCreative.getMerAccountBreakdown.queryOptions({
      from: fromValue,
      to: toValue,
      teamId: selectedTeamId,
    }),
  );

  const portfolio = stats.data?.portfolio;
  const bottomPerformers = stats.data?.bottomPerformers ?? [];

  const kpis = [
    { label: "MER", value: fmtRoas(portfolio?.roas), tone: "violet" },
    { label: "Revenue", value: fmtMoney(portfolio?.totalRevenue), tone: "emerald" },
    { label: "Spend", value: fmtMoney(portfolio?.totalSpend), tone: "blue" },
  ];

  const accountLinkParams = (accountId: string) => {
    const sp = new URLSearchParams();
    sp.set("from", fromValue);
    sp.set("to", toValue);
    if (teamId) sp.set("team", teamId);
    return `/mer/accounts/${accountId}?${sp.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Single-line header */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">Marketing Efficiency Ratio</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
        </div>
      </div>

      {/* KPI rail + chart, side-by-side */}
      <div className="grid gap-3 lg:grid-cols-[240px_1fr]">
        <div className="flex flex-col gap-1.5">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2"
            >
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground/50">
                {kpi.label}
              </span>
              {stats.isLoading ? (
                <Skeleton className="h-4 w-14" />
              ) : (
                <span className="text-sm font-semibold tabular-nums">{kpi.value}</span>
              )}
            </div>
          ))}
        </div>
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
              Revenue vs Spend
            </span>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Revenue
              </span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-violet-500" /> Spend
              </span>
            </div>
          </div>
          {dailyPerf.isLoading ? (
            <Skeleton className="h-[160px] w-full" />
          ) : dailyPerf.data && dailyPerf.data.length > 1 ? (
            <RevenueSpendChart
              logs={dailyPerf.data as Array<typeof dailyPerf.data[number] & { [k: string]: unknown }>}
              className="h-[160px] w-full"
            />
          ) : (
            <p className="py-12 text-center text-xs text-muted-foreground/40">No performance data</p>
          )}
        </div>
      </div>

      {/* Dense account table */}
      <div className="rounded-md border border-border">
        <div className="grid grid-cols-[1fr_96px_96px_90px_88px_36px] items-center gap-4 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/50">
          <span>Account</span>
          <span className="text-right">Spend</span>
          <span className="text-right">Revenue</span>
          <span className="text-right">ROAS</span>
          <span className="text-center">7d Trend</span>
          <span />
        </div>
        {breakdown.isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[1fr_96px_96px_90px_88px_36px] items-center gap-4 border-b border-border/50 px-3 py-2 last:border-0">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-14 justify-self-end" />
              <Skeleton className="h-4 w-14 justify-self-end" />
              <Skeleton className="h-4 w-10 justify-self-end" />
              <Skeleton className="h-6 w-16 justify-self-center" />
              <span />
            </div>
          ))
        ) : breakdown.data && breakdown.data.length > 0 ? (
          breakdown.data.map((row) => {
            const sparkData = row.sparkline.map((p) => ({ date: p.date, value: p.roas }));
            return (
              <Link
                key={row.accountId}
                href={accountLinkParams(row.accountId)}
                className="grid grid-cols-[1fr_96px_96px_90px_88px_36px] items-center gap-4 border-b border-border/50 px-3 py-2 transition-colors last:border-0 hover:bg-muted/40"
              >
                <span className="truncate text-sm font-medium">{row.accountName}</span>
                <div className="flex flex-col items-end leading-tight">
                  <span className="text-[13px] tabular-nums">{fmtMoney(row.spend)}</span>
                  <InlineDelta value={row.spendDelta} format={fmtMoney} />
                </div>
                <span className="text-right text-[13px] tabular-nums">{fmtMoney(row.revenue)}</span>
                <div className="flex flex-col items-end leading-tight">
                  <span className="text-[13px] tabular-nums">{fmtRoas(row.roas)}</span>
                  <InlineDelta value={row.roasDelta} format={fmtRoas} />
                </div>
                <div className="flex justify-center">
                  <Sparkline data={sparkData} width={72} height={22} />
                </div>
                <ChevronRight className="size-3.5 justify-self-end text-muted-foreground/30" />
              </Link>
            );
          })
        ) : (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground/50">
            No account activity in this period
          </div>
        )}
      </div>

      <LeaderboardTable
        title="Needs Attention"
        icon={<AlertTriangle className="size-3.5 text-red-400" />}
        rows={bottomPerformers}
        isLoading={stats.isLoading}
        emptyMessage="No underperformers detected"
        viewAllHref="/creatives?health=critical"
        canManageData={canManageData}
      />
    </div>
  );
}
