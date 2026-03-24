"use client";

import { useQuery } from "@tanstack/react-query";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";
import { useTRPC } from "@/lib/trpc/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import { Sparkles, TrendingUp, DollarSign, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

function fmt(val: string | number | null | undefined, prefix = "", suffix = "") {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return `${prefix}${n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n >= 100 ? n.toFixed(0) : n.toFixed(2)}${suffix}`;
}

const DATE_RANGES = [
  { label: "Last 7 days", value: 7 },
  { label: "Last 14 days", value: 14 },
  { label: "Last 30 days", value: 30 },
  { label: "Last 90 days", value: 90 },
];

export default function InsightsPage() {
  const trpc = useTRPC();

  const [days, setDays] = useQueryState("days", parseAsInteger.withDefault(30));
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));

  const accounts = useQuery(trpc.account.list.queryOptions());
  const selectedAccountId = accountId || undefined;

  const summary = useQuery(trpc.insights.summary.queryOptions({ days, accountId: selectedAccountId }));
  const byFormat = useQuery(trpc.insights.byField.queryOptions({ field: "format", days, accountId: selectedAccountId }));
  const byAwareness = useQuery(trpc.insights.byField.queryOptions({ field: "awareness_level", days, accountId: selectedAccountId }));
  const byAngle = useQuery(trpc.insights.byAngle.queryOptions({ limit: 10, days, accountId: selectedAccountId }));
  const topCreatives = useQuery(trpc.insights.topCreatives.queryOptions({ metric: "roas", limit: 10, days, accountId: selectedAccountId }));

  const isLoading = summary.isLoading;
  const hasData = summary.data && summary.data.logCount > 0;

  return (
    <div className="flex flex-col gap-8">
      {/* Header with filters */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Insights</h1>
          <p className="text-sm text-muted-foreground">
            Performance patterns across your creatives.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 w-auto gap-1 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_RANGES.map((r) => (
                <SelectItem key={r.value} value={String(r.value)}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Avg ROAS", value: fmt(summary.data?.avgRoas, "", "x"), icon: TrendingUp, color: "text-emerald-500" },
          { label: "Avg CPA", value: fmt(summary.data?.avgCpa, "$"), icon: DollarSign, color: "text-blue-500" },
          { label: "Total Spend", value: fmt(summary.data?.totalSpend, "$"), icon: DollarSign, color: "text-amber-500" },
          { label: "Creatives", value: summary.data?.creativeCount ?? "—", icon: Target, color: "text-violet-500" },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-border px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70">
              <card.icon className={cn("size-3.5", card.color)} />
              {card.label}
            </div>
            {isLoading ? (
              <Skeleton className="mt-1 h-6 w-16" />
            ) : (
              <p className="text-lg font-semibold tabular-nums leading-tight mt-0.5">
                {card.value}
              </p>
            )}
          </div>
        ))}
      </div>

      {!isLoading && !hasData ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-16">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
            <Sparkles className="size-5 text-muted-foreground/40" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No performance data yet</p>
            <p className="text-[13px] text-muted-foreground/40">
              Import ads with performance metrics to see insights.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Top Creatives */}
          <Section title="Top Creatives by ROAS" loading={topCreatives.isLoading}>
            {topCreatives.data && topCreatives.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Creative</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Angle</TableHead>
                    <TableHead className="text-right">ROAS</TableHead>
                    <TableHead className="text-right">CPA</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topCreatives.data.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link href={`/creatives/${row.id}`} className="text-sm hover:underline">
                          {row.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {row.format ? (
                          <Badge variant="secondary" className="capitalize text-[11px]">{row.format}</Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">{row.angle || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgRoas, "", "x")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgCpa, "$")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.totalSpend, "$")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          {/* By Format */}
          <Section title="Performance by Format" loading={byFormat.isLoading}>
            {byFormat.data && byFormat.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Format</TableHead>
                    <TableHead className="text-right">Creatives</TableHead>
                    <TableHead className="text-right">Avg ROAS</TableHead>
                    <TableHead className="text-right">Avg CPA</TableHead>
                    <TableHead className="text-right">Total Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byFormat.data.map((row) => (
                    <TableRow key={row.value ?? "null"}>
                      <TableCell>
                        {row.value ? (
                          <Badge variant="secondary" className="capitalize text-[11px]">{row.value}</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">Untagged</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{row.creativeCount}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgRoas, "", "x")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgCpa, "$")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.totalSpend, "$")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          {/* By Awareness Level */}
          <Section title="Performance by Awareness Level" loading={byAwareness.isLoading}>
            {byAwareness.data && byAwareness.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Awareness</TableHead>
                    <TableHead className="text-right">Creatives</TableHead>
                    <TableHead className="text-right">Avg ROAS</TableHead>
                    <TableHead className="text-right">Avg CPA</TableHead>
                    <TableHead className="text-right">Total Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byAwareness.data.map((row) => (
                    <TableRow key={row.value ?? "null"}>
                      <TableCell className="text-sm capitalize">
                        {row.value?.replace(/_/g, " ") || <span className="text-muted-foreground">Untagged</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{row.creativeCount}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgRoas, "", "x")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgCpa, "$")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.totalSpend, "$")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          {/* By Angle */}
          <Section title="Performance by Angle" loading={byAngle.isLoading}>
            {byAngle.data && byAngle.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Angle</TableHead>
                    <TableHead className="text-right">Creatives</TableHead>
                    <TableHead className="text-right">Avg ROAS</TableHead>
                    <TableHead className="text-right">Avg CPA</TableHead>
                    <TableHead className="text-right">Total Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byAngle.data.map((row) => (
                    <TableRow key={row.angle ?? "null"}>
                      <TableCell className="text-sm">
                        {row.angle || <span className="text-muted-foreground">Untagged</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{row.creativeCount}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgRoas, "", "x")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.avgCpa, "$")}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(row.totalSpend, "$")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, loading, children }: { title: string; loading: boolean; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">{title}</h2>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      ) : children}
    </div>
  );
}
