"use client";

import { useState, use } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { subDays } from "date-fns";
import { useQueryState, parseAsString } from "nuqs";
import { toast } from "sonner";
import { Database, DollarSign, ShieldCheck, Target, Trophy, TrendingUp, Wrench } from "@/components/icons";
import { useTRPC } from "@/lib/trpc/client";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { LeaderboardTable } from "@/components/blocks/dashboard/leaderboard-table";
import { PerformanceChart } from "@/components/blocks/insights/performance-chart";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { fmtMoney, fmtRoas } from "@/lib/fmt";

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { role } = useActiveOrganizationRole();
  const canManageData = role !== "member";
  const isAdmin = role === "admin" || role === "owner";
  const [showVerify, setShowVerify] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [showDataHealth, setShowDataHealth] = useState(false);

  const dataHealth = useQuery({
    ...trpc.metaInsights.orgDataHealth.queryOptions(),
    enabled: showDataHealth && isAdmin,
    staleTime: 60_000,
  });

  const purgePreview = useMutation({
    ...trpc.metaInsights.purgeMultiDayLogsInRange.mutationOptions(),
  });
  const purge = useMutation({
    ...trpc.metaInsights.purgeMultiDayLogsInRange.mutationOptions(),
    onSuccess: (data) => {
      toast.success(
        `Purged ${data.affected} multi-day rows in ${data.rangeStart}..${data.rangeEnd}. Re-import that range to repopulate with daily data.`,
      );
      queryClient.invalidateQueries();
      setShowPurgeConfirm(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function openPurgeDialog() {
    setShowPurgeConfirm(true);
    purgePreview.mutate({ accountId: id, from: fromValue, to: toValue, dryRun: true });
  }

  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));

  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);

  const accounts = useQuery(trpc.adAccount.list.queryOptions());
  const account = accounts.data?.find((a) => a.id === id);

  useBreadcrumbs([
    { label: "MER", href: `/mer?from=${fromValue}&to=${toValue}` },
    { label: account?.name ?? "Account" },
  ]);

  const stats = useQuery(
    trpc.adCreative.dashboardStats.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: id,
    }),
  );

  const dailyPerf = useQuery(
    trpc.adCreative.getDailyPortfolioPerformance.queryOptions({
      from: fromValue,
      to: toValue,
      accountId: id,
    }),
  );

  const portfolio = stats.data?.portfolio;
  const topPerformers = (stats.data?.topPerformers ?? []).slice(0, 5);

  const kpis = [
    { label: "ROAS", value: fmtRoas(portfolio?.roas), icon: Target, accent: "text-violet-500" },
    { label: "Revenue", value: fmtMoney(portfolio?.totalRevenue), icon: TrendingUp, accent: "text-emerald-500" },
    { label: "Spend", value: fmtMoney(portfolio?.totalSpend), icon: DollarSign, accent: "text-blue-500" },
  ];

  const hasDailyData = dailyPerf.data && dailyPerf.data.length > 1;

  const compare = useQuery({
    ...trpc.metaInsights.compareDailyMetaVsDb.queryOptions({
      accountId: id,
      from: fromValue,
      to: toValue,
    }),
    enabled: showVerify,
    staleTime: 60_000,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {accounts.isLoading ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <div className="flex items-baseline gap-3">
              <h1 className="text-lg font-semibold">{account?.name ?? "Account"}</h1>
              {account?.metaAccountId ? (
                <span className="text-xs text-muted-foreground/60 tabular-nums">
                  Meta ID: {account.metaAccountId}
                </span>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-[13px]"
                onClick={() => setShowDataHealth(true)}
              >
                <Database className="size-3.5" />
                Data health
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-[13px] text-amber-600 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                onClick={openPurgeDialog}
                disabled={purge.isPending}
              >
                <Wrench className="size-3.5" />
                {purge.isPending ? "Purging…" : "Fix daily data"}
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant={showVerify ? "default" : "outline"}
            className="h-7 gap-1.5 text-[13px]"
            onClick={() => setShowVerify((v) => !v)}
          >
            <ShieldCheck className="size-3.5" />
            {showVerify ? "Hide verify" : "Verify vs Meta"}
          </Button>
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
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
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

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border px-4 py-3">
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            ROAS
          </h2>
          {dailyPerf.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : hasDailyData ? (
            <PerformanceChart
              logs={dailyPerf.data as Array<typeof dailyPerf.data[number] & { [k: string]: unknown }>}
              defaultMetric="roas"
              lockMetric
              compact
            />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground/50">No data</p>
          )}
        </div>
        <div className="rounded-lg border border-border px-4 py-3">
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            Spend
          </h2>
          {dailyPerf.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : hasDailyData ? (
            <PerformanceChart
              logs={dailyPerf.data as Array<typeof dailyPerf.data[number] & { [k: string]: unknown }>}
              defaultMetric="spend"
              lockMetric
              compact
            />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground/50">No data</p>
          )}
        </div>
      </div>

      {showVerify ? (
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 text-violet-500" />
              <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/60">
                DB vs Meta (live)
              </h2>
              {compare.isLoading ? (
                <span className="text-[10px] text-muted-foreground/50">Fetching from Meta…</span>
              ) : compare.data ? (
                <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                  Total ROAS — DB: {fmtRoas(compare.data.totals.dbRoas)} · Meta: {fmtRoas(compare.data.totals.metaRoas)}
                </span>
              ) : null}
            </div>
            {compare.error ? (
              <span className="text-[11px] text-red-400">{compare.error.message}</span>
            ) : null}
          </div>
          {compare.data ? (
            <div className="grid grid-cols-[1fr_repeat(7,minmax(0,70px))] items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/50">
              <span>Date</span>
              <span className="text-right">DB Spend</span>
              <span className="text-right">Meta Spend</span>
              <span className="text-right">DB Rev</span>
              <span className="text-right">Meta Rev</span>
              <span className="text-right">DB ROAS</span>
              <span className="text-right">Meta ROAS</span>
              <span className="text-right">Δ ROAS</span>
            </div>
          ) : null}
          {compare.data?.rows.map((r) => {
            const roasDiffPct = r.metaRoas && r.metaRoas > 0 && r.roasDiff != null
              ? (r.roasDiff / r.metaRoas) * 100
              : null;
            const alarm = roasDiffPct != null && Math.abs(roasDiffPct) > 5;
            return (
              <div
                key={r.day}
                className="grid grid-cols-[1fr_repeat(7,minmax(0,70px))] items-center gap-2 border-t border-border/50 px-3 py-1.5 text-[12px] tabular-nums"
              >
                <span className="text-muted-foreground">{r.day}</span>
                <span className="text-right">${r.dbSpend.toFixed(2)}</span>
                <span className="text-right text-muted-foreground/70">${r.metaSpend.toFixed(2)}</span>
                <span className="text-right">${r.dbRevenue.toFixed(2)}</span>
                <span className="text-right text-muted-foreground/70">${r.metaRevenue.toFixed(2)}</span>
                <span className="text-right">{r.dbRoas != null ? `${r.dbRoas.toFixed(2)}x` : "—"}</span>
                <span className="text-right text-muted-foreground/70">{r.metaRoas != null ? `${r.metaRoas.toFixed(2)}x` : "—"}</span>
                <span className={`text-right ${alarm ? "text-red-400 font-medium" : "text-muted-foreground/60"}`}>
                  {roasDiffPct != null ? `${roasDiffPct > 0 ? "+" : ""}${roasDiffPct.toFixed(1)}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <LeaderboardTable
        title="Top Creatives"
        icon={<Trophy className="size-3.5 text-emerald-500" />}
        rows={topPerformers}
        isLoading={stats.isLoading}
        emptyMessage="No creatives with enough data yet"
        viewAllHref={`/creatives?account=${id}`}
        canManageData={canManageData}
      />

      <Dialog open={showDataHealth} onOpenChange={setShowDataHealth}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="size-4" /> Data health
            </DialogTitle>
            <DialogDescription>
              performance_log storage across this organization. Use this to decide if retention pruning is needed.
            </DialogDescription>
          </DialogHeader>
          {dataHealth.isLoading ? (
            <div className="flex justify-center py-6">
              <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : dataHealth.data ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60">Total rows</div>
                  <div className="text-base font-semibold tabular-nums">{dataHealth.data.totalRows.toLocaleString()}</div>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60">Table size (whole DB)</div>
                  <div className="text-base font-semibold tabular-nums">{dataHealth.data.tableSize.pretty}</div>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60">Daily rows (good)</div>
                  <div className="text-sm tabular-nums text-emerald-600 dark:text-emerald-400">
                    {dataHealth.data.dailyRows.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60">Multi-day (legacy)</div>
                  <div className="text-sm tabular-nums text-amber-600 dark:text-amber-400">
                    {dataHealth.data.multiDayRows.toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                Date coverage: {dataHealth.data.oldest ?? "—"} → {dataHealth.data.newest ?? "—"}
              </div>
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground/60">
                  Rows by month (last 24)
                </div>
                <div className="rounded-md border divide-y">
                  {dataHealth.data.monthly.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No data</div>
                  ) : (
                    dataHealth.data.monthly.map((m) => {
                      const max = Math.max(...dataHealth.data!.monthly.map((x) => x.rows), 1);
                      const pct = (m.rows / max) * 100;
                      return (
                        <div key={m.month} className="grid grid-cols-[80px_1fr_80px] items-center gap-3 px-3 py-1.5 text-[12px]">
                          <span className="tabular-nums text-muted-foreground">{m.month}</span>
                          <div className="h-1.5 rounded-full bg-muted">
                            <div className="h-full rounded-full bg-violet-500/70" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-right tabular-nums">{m.rows.toLocaleString()}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <strong className="text-foreground">Retention guidance:</strong> most Postgres providers start charging
                extra above ~10 GB. With ~{Math.round(dataHealth.data.totalRows / 1000)}k rows and size{" "}
                {dataHealth.data.tableSize.pretty}, pruning is only worth doing if storage is the bottleneck. Trends/year-over-year
                need 13+ months; keep at least that. A monthly job pruning beyond 24 months is safe for most analytics needs.
              </div>
            </div>
          ) : dataHealth.error ? (
            <p className="text-sm text-red-500">{dataHealth.error.message}</p>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showPurgeConfirm} onOpenChange={setShowPurgeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fix daily data for {fromValue} – {toValue}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  Deletes multi-day <code className="rounded bg-muted px-1 py-0.5 text-xs">performance_log</code> rows for{" "}
                  <strong>{account?.name ?? "this account"}</strong> whose <em>entire</em> range falls inside{" "}
                  <span className="tabular-nums font-medium">{fromValue} → {toValue}</span>.
                </p>
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                  <div className="font-medium mb-1">What will be affected:</div>
                  {purgePreview.isPending ? (
                    <span className="text-muted-foreground">Counting…</span>
                  ) : purgePreview.data ? (
                    purgePreview.data.affected === 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        Nothing to purge in this range. Historical data is safe.
                      </span>
                    ) : (
                      <div className="space-y-0.5 tabular-nums">
                        <div>
                          <strong>{purgePreview.data.affected}</strong> multi-day rows
                        </div>
                        <div className="text-muted-foreground">
                          Spanning {purgePreview.data.rangeStart} → {purgePreview.data.rangeEnd}
                        </div>
                      </div>
                    )
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
                <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
                  <li>Rows extending <em>outside</em> this window are preserved — your historical data is safe.</li>
                  <li>Already-daily rows (where date_start = date_end) are preserved.</li>
                  <li>After this, re-run your Meta import for <strong>{fromValue} → {toValue}</strong>; it now uses daily granularity.</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purge.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={purge.isPending || purgePreview.isPending || (purgePreview.data?.affected ?? 0) === 0}
              onClick={(e) => {
                e.preventDefault();
                purge.mutate({ accountId: id, from: fromValue, to: toValue, dryRun: false });
              }}
            >
              {purge.isPending ? "Purging…" : `Purge ${purgePreview.data?.affected ?? ""} rows`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
