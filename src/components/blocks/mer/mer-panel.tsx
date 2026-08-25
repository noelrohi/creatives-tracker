"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Info } from "@/components/icons";
import { useTRPC } from "@/lib/trpc/client";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { FORMATS } from "@/components/blocks/creatives/creative-list-filters";
import { RevenueSpendChart } from "@/components/blocks/mer/revenue-spend-chart";
import { Sparkline } from "@/components/blocks/mer/sparkline";
import { fmtMoney, fmtRoas } from "@/lib/fmt";

/**
 * The MER view's filters, provided by whichever screen hosts the panels —
 * today the Meta page's Charts tab, whose header already carries the date
 * range and account/team pickers this page used to own.
 */
export type MerFilters = {
  from: string;
  to: string;
  teamId?: string;
  accountId?: string;
};

function InlineDelta({
  value,
  format,
}: {
  value: string | null;
  format: (v: string) => string;
}) {
  if (value == null)
    return <span className="text-muted-foreground/30 text-[10px]">—</span>;
  const n = parseFloat(value);
  if (isNaN(n) || Math.abs(n) < 0.0001)
    return (
      <span className="text-muted-foreground/40 text-[10px] tabular-nums">
        ±0
      </span>
    );
  const isPositive = n > 0;
  return (
    <span
      className={`text-[10px] tabular-nums leading-none ${
        isPositive ? "text-emerald-500" : "text-red-400"
      }`}
    >
      {isPositive ? "▲" : "▼"} {format(Math.abs(n).toString())}
    </span>
  );
}

/**
 * The MER headline: KPI rail (MER, revenue, spend — each with sparkline and
 * half-over-half delta) beside the revenue-vs-spend chart. `format` narrows
 * to one creative format where the host offers that filter.
 */
export function MerSummary({
  from,
  to,
  teamId,
  accountId,
  format,
}: MerFilters & { format?: (typeof FORMATS)[number] }) {
  const trpc = useTRPC();

  const portfolioSummary = useQuery(
    trpc.adCreative.portfolioSummary.queryOptions({
      from,
      to,
      teamId,
      accountId,
      format,
    }),
  );

  const dailyPerf = useQuery(
    trpc.adCreative.getDailyPortfolioPerformance.queryOptions({
      from,
      to,
      teamId,
      accountId,
      format,
    }),
  );

  const portfolio = portfolioSummary.data;

  const sparks = (() => {
    const rows = dailyPerf.data ?? [];
    const revenue: Array<{ date: string; value: number | null }> = [];
    const spend: Array<{ date: string; value: number | null }> = [];
    const mer: Array<{ date: string; value: number | null }> = [];
    for (const r of rows) {
      const rev = r.purchaseValue != null ? parseFloat(r.purchaseValue) : null;
      const sp = r.spend != null ? parseFloat(r.spend) : null;
      revenue.push({ date: r.dateStart, value: rev });
      spend.push({ date: r.dateStart, value: sp });
      mer.push({
        date: r.dateStart,
        value: sp && sp > 0 && rev != null ? rev / sp : null,
      });
    }
    return { revenue, spend, mer };
  })();

  const deltaPct = (
    series: Array<{ value: number | null }>,
  ): number | null => {
    const vals = series
      .map((s) => s.value)
      .filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    const mid = Math.floor(vals.length / 2);
    const a = vals.slice(0, mid);
    const b = vals.slice(mid);
    const avgA = a.reduce((s, v) => s + v, 0) / a.length;
    const avgB = b.reduce((s, v) => s + v, 0) / b.length;
    if (avgA === 0) return null;
    return ((avgB - avgA) / avgA) * 100;
  };

  const kpis = [
    {
      label: "MER",
      value: fmtRoas(portfolio?.roas),
      color: "hsl(38, 92%, 50%)",
      data: sparks.mer,
      delta: deltaPct(sparks.mer),
    },
    {
      label: "Revenue",
      value: fmtMoney(portfolio?.totalRevenue),
      color: "hsl(160, 84%, 39%)",
      data: sparks.revenue,
      delta: deltaPct(sparks.revenue),
    },
    {
      label: "Spend",
      value: fmtMoney(portfolio?.totalSpend),
      color: "hsl(262, 83%, 58%)",
      data: sparks.spend,
      delta: deltaPct(sparks.spend),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className="text-sm font-semibold tracking-tight">
          Marketing Efficiency Ratio
        </h2>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="About Marketing Efficiency Ratio"
            >
              <Info className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <PopoverHeader>
              <PopoverTitle>What is MER?</PopoverTitle>
              <PopoverDescription>
                Marketing Efficiency Ratio measures how efficiently your total
                marketing spend generates revenue.
              </PopoverDescription>
            </PopoverHeader>
            <div className="rounded-md bg-muted px-3 py-2 text-xs font-medium tabular-nums">
              MER = total revenue ÷ total ad spend
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              This view tracks MER over time and compares performance across
              teams and ad accounts. A higher ratio means more revenue for
              every dollar spent.
            </p>
          </PopoverContent>
        </Popover>
      </div>

      <div className="grid gap-3 lg:grid-cols-[240px_1fr]">
        <div className="flex flex-col gap-1.5">
          {kpis.map((kpi) => {
            const isGood =
              kpi.delta != null &&
              (kpi.label === "Spend" ? kpi.delta < 0 : kpi.delta > 0);
            return (
              <div
                key={kpi.label}
                className="group relative flex flex-1 flex-col overflow-hidden rounded-md border border-border bg-card"
              >
                <div className="flex flex-1 flex-col justify-between px-3 pt-2.5 pb-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/55">
                    {kpi.label}
                  </span>
                  <div className="flex items-baseline gap-2">
                    {portfolioSummary.isLoading ? (
                      <Skeleton className="h-6 w-20" />
                    ) : (
                      <span className="text-[22px] font-semibold tabular-nums leading-none tracking-tight">
                        {kpi.value}
                      </span>
                    )}
                    {kpi.delta != null && !portfolioSummary.isLoading && (
                      <span
                        className={`text-[11px] tabular-nums leading-none ${
                          isGood ? "text-emerald-500" : "text-red-400"
                        }`}
                      >
                        {kpi.delta > 0 ? "+" : "−"}
                        {Math.abs(kpi.delta).toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="h-7 w-full opacity-70 transition-opacity group-hover:opacity-100">
                  {!dailyPerf.isLoading && (
                    <Sparkline
                      data={kpi.data}
                      color={kpi.color}
                      width="100%"
                      height="100%"
                    />
                  )}
                </div>
              </div>
            );
          })}
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
            <Skeleton className="h-[320px] w-full" />
          ) : dailyPerf.data && dailyPerf.data.length > 1 ? (
            <RevenueSpendChart
              logs={
                dailyPerf.data as Array<
                  (typeof dailyPerf.data)[number] & { [k: string]: unknown }
                >
              }
              className="h-[320px] w-full"
            />
          ) : (
            <p className="py-12 text-center text-xs text-muted-foreground/40">
              No performance data
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-account cut of the same range: spend, revenue, ROAS with deltas and a
 * 7-day trend, each row linking into the account's own MER detail page.
 * (`getMerAccountBreakdown` has no creative-format filter, so this table
 * always shows all formats.)
 */
export function MerAccountBreakdown({ from, to, teamId, accountId }: MerFilters) {
  const trpc = useTRPC();

  const breakdown = useQuery(
    trpc.adCreative.getMerAccountBreakdown.queryOptions({
      from,
      to,
      teamId,
      accountId,
    }),
  );

  const accountLinkParams = (linkedAccountId: string) => {
    const sp = new URLSearchParams();
    sp.set("from", from);
    sp.set("to", to);
    if (teamId) sp.set("team", teamId);
    return `/mer/accounts/${linkedAccountId}?${sp.toString()}`;
  };

  return (
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
          <div
            key={i}
            className="grid grid-cols-[1fr_96px_96px_90px_88px_36px] items-center gap-4 border-b border-border/50 px-3 py-2 last:border-0"
          >
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
          const sparkData = row.sparkline.map((p) => ({
            date: p.date,
            value: p.roas,
          }));
          return (
            <Link
              key={row.accountId}
              href={accountLinkParams(row.accountId)}
              className="grid grid-cols-[1fr_96px_96px_90px_88px_36px] items-center gap-4 border-b border-border/50 px-3 py-2 transition-colors last:border-0 hover:bg-muted/40"
            >
              <span className="truncate text-sm font-medium">
                {row.accountName}
              </span>
              <div className="flex flex-col items-end leading-tight">
                <span className="text-[13px] tabular-nums">
                  {fmtMoney(row.spend)}
                </span>
                <InlineDelta value={row.spendDelta} format={fmtMoney} />
              </div>
              <span className="text-right text-[13px] tabular-nums">
                {fmtMoney(row.revenue)}
              </span>
              <div className="flex flex-col items-end leading-tight">
                <span className="text-[13px] tabular-nums">
                  {fmtRoas(row.roas)}
                </span>
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
  );
}
