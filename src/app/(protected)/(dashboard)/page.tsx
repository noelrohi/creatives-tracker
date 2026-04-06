"use client";

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
  Trophy,
  AlertTriangle,
  ArrowRight,
  ImageIcon,
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
};

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
  accountId,
}: {
  title: string;
  icon: React.ReactNode;
  rows: LeaderboardRow[];
  isLoading: boolean;
  emptyMessage: string;
  accountId: string;
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
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link href="/import">
              <Upload className="size-3.5" /> Import Ads
            </Link>
          </Button>
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
          <Link href={`/creatives${accountId ? `?account=${accountId}` : ""}`}>
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

export default function DashboardPage() {
  const trpc = useTRPC();

  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [ownership, setOwnership] = useQueryState("ownership", parseAsString.withDefault("all"));
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

  const portfolio = stats.data?.portfolio;
  const topPerformers = stats.data?.topPerformers ?? [];
  const bottomPerformers = stats.data?.bottomPerformers ?? [];

  const kpis = [
    { label: "ROAS", value: fmtRoas(portfolio?.roas), icon: TrendingUp, accent: "text-emerald-500" },
    { label: "CPA", value: fmtMoney(portfolio?.cpa), icon: Target, accent: "text-blue-500" },
    { label: "CTR", value: fmtPct(portfolio?.ctr), icon: MousePointerClick, accent: "text-violet-500" },
    { label: "Conversions", value: fmtNum(portfolio?.conversions), icon: ShoppingCart, accent: "text-amber-500" },
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
            {stats.isLoading ? (
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
              {stats.isLoading ? "—" : fmtMoney(portfolio?.totalSpend)}
            </p>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">Revenue</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {stats.isLoading ? "—" : fmtMoney(portfolio?.totalRevenue)}
            </p>
          </div>
        </div>
      </div>

      {/* Creative Leaderboard */}
      <div className="grid gap-6 lg:grid-cols-2">
        <LeaderboardTable
          title="Top Performers"
          icon={<Trophy className="size-3.5 text-emerald-500" />}
          rows={topPerformers}
          isLoading={stats.isLoading}
          emptyMessage="No creatives with enough spend data yet"
          accountId={accountId}
        />
        <LeaderboardTable
          title="Needs Attention"
          icon={<AlertTriangle className="size-3.5 text-red-400" />}
          rows={bottomPerformers}
          isLoading={stats.isLoading}
          emptyMessage="No underperformers detected"
          accountId={accountId}
        />
      </div>
    </div>
  );
}
