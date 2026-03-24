"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
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
  TrendingDown,
  Tag,
  Upload,
  ArrowRight,
  DollarSign,
  Target,
  MousePointerClick,
  ShoppingCart,
  Trophy,
  AlertTriangle,
  ChevronsUpDown,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
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

const DATE_RANGES = [
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
] as const;

export default function DashboardPage() {
  const trpc = useTRPC();

  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [campaignIds, setCampaignIds] = useQueryState("campaign", parseAsString.withDefault(""));
  const [adSetIds, setAdSetIds] = useQueryState("adSet", parseAsString.withDefault(""));
  const [statuses, setStatuses] = useQueryState("status", parseAsString.withDefault("active"));
  const [days, setDays] = useQueryState("days", parseAsInteger.withDefault(7));
  const selectedAccountId = accountId || undefined;

  const accounts = useQuery(trpc.account.list.queryOptions());
  const campaignsQuery = useQuery(trpc.campaign.list.queryOptions());
  const adSetsQuery = useQuery(trpc.adSet.list.queryOptions());

  const stats = useQuery(
    trpc.adCreative.dashboardStats.queryOptions({
      days,
      accountId: selectedAccountId,
      campaignIds: campaignIds ? campaignIds.split(",") : undefined,
      adSetIds: adSetIds ? adSetIds.split(",") : undefined,
      statuses: statuses ? statuses.split(",") as ("active" | "paused" | "archived")[] : undefined,
    }),
  );

  const untaggedCreatives = useQuery(
    trpc.adCreative.list.queryOptions({
      ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
      untaggedOnly: true,
    }),
  );

  const portfolio = stats.data?.portfolio;
  const topPerformers = stats.data?.topPerformers ?? [];
  const bottomPerformers = stats.data?.bottomPerformers ?? [];

  const kpis = [
    {
      label: "Portfolio ROAS",
      value: fmtRoas(portfolio?.roas),
      icon: TrendingUp,
      accent: "text-emerald-500",
    },
    {
      label: "Avg CPA",
      value: fmtMoney(portfolio?.cpa),
      icon: Target,
      accent: "text-blue-500",
    },
    {
      label: "Avg CTR",
      value: fmtPct(portfolio?.ctr),
      icon: MousePointerClick,
      accent: "text-violet-500",
    },
    {
      label: "Conversions",
      value: fmtNum(portfolio?.conversions),
      icon: ShoppingCart,
      accent: "text-amber-500",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header with date range + account selector */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <ButtonGroup>
            {DATE_RANGES.map((range) => (
              <Button
                key={range.value}
                size="sm"
                variant={days === range.value ? "secondary" : "outline"}
                onClick={() => setDays(range.value)}
              >
                {range.label}
              </Button>
            ))}
          </ButtonGroup>
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
          {campaignsQuery.data && campaignsQuery.data.length > 0 && (
            <MultiCombobox
              value={campaignIds ? campaignIds.split(",").filter(Boolean) : []}
              onValueChange={(ids) => setCampaignIds(ids.length ? ids.join(",") : "")}
              items={campaignsQuery.data}
              placeholder="All campaigns"
              searchPlaceholder="Search campaigns..."
              emptyMessage="No campaigns found."
            />
          )}
          {adSetsQuery.data && adSetsQuery.data.length > 0 && (
            <MultiCombobox
              value={adSetIds ? adSetIds.split(",").filter(Boolean) : []}
              onValueChange={(ids) => setAdSetIds(ids.length ? ids.join(",") : "")}
              items={adSetsQuery.data}
              placeholder="All ad sets"
              searchPlaceholder="Search ad sets..."
              emptyMessage="No ad sets found."
            />
          )}
          <StatusFilter
            value={statuses ? statuses.split(",").filter(Boolean) : []}
            onValueChange={(vals) => setStatuses(vals.length ? vals.join(",") : "")}
          />
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
        <div className="flex items-center justify-between gap-3">
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
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link href="/import">
              <Upload className="size-3.5" /> Import Ads
            </Link>
          </Button>
        </div>
      </div>

      {/* Untagged CTA */}
      {!untaggedCreatives.isLoading &&
        (untaggedCreatives.data?.length ?? 0) > 0 && (
        <Link
          href={`/creatives?untagged=true${accountId ? `&account=${accountId}` : ""}`}
          className="flex items-center gap-3 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 px-4 py-3 transition-colors hover:bg-amber-500/10"
        >
          <Tag className="size-4 text-amber-500" />
          <p className="flex-1 text-sm">
            <span className="font-medium">
              {untaggedCreatives.data?.length} creative
              {(untaggedCreatives.data?.length ?? 0) > 1 ? "s" : ""}
            </span>{" "}
            <span className="text-muted-foreground">still need tagging</span>
          </p>
          <ArrowRight className="size-3.5 text-muted-foreground" />
        </Link>
      )}

      {/* Creative Leaderboard */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top Performers */}
        <LeaderboardTable
          title="Top Performers"
          icon={<Trophy className="size-3.5 text-emerald-500" />}
          rows={topPerformers}
          isLoading={stats.isLoading}
          emptyMessage="No creatives with enough spend data yet"
          accountId={accountId}
        />

        {/* Bottom Performers */}
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

type LeaderboardRow = {
  id: string;
  name: string;
  format: string | null;
  totalSpend: string;
  roas: string;
  cpa: string | null;
  ctr: string | null;
  conversions: string;
  adStatus: string | null;
};

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

function MultiCombobox({
  value,
  onValueChange,
  items,
  placeholder,
  searchPlaceholder,
  emptyMessage,
}: {
  value: string[];
  onValueChange: (v: string[]) => void;
  items: { id: string; name: string }[];
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (id: string) => {
    onValueChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };

  const label =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? items.find((a) => a.id === value[0])?.name ?? "1 selected"
        : `${value.length} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-7 w-auto gap-1 px-2.5 text-[13px]"
        >
          <span className="max-w-[160px] truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-8 text-[13px]" />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {value.length > 0 && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => { onValueChange([]); setOpen(false); }}
                >
                  Clear selection
                </CommandItem>
              )}
              {items.map((a) => {
                const isSelected = value.includes(a.id);
                return (
                  <CommandItem
                    key={a.id}
                    value={a.name}
                    onSelect={() => toggle(a.id)}
                  >
                    <Check className={cn("mr-2 size-3.5", isSelected ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{a.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const STATUSES = [
  { id: "active", name: "Active" },
  { id: "paused", name: "Paused" },
  { id: "archived", name: "Archived" },
];

function StatusFilter({
  value,
  onValueChange,
}: {
  value: string[];
  onValueChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (id: string) => {
    onValueChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };

  const label =
    value.length === 0 || value.length === STATUSES.length
      ? "All statuses"
      : value.length === 1
        ? STATUSES.find((s) => s.id === value[0])?.name ?? value[0]
        : `${value.length} statuses`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-7 w-auto gap-1 px-2.5 text-[13px]"
        >
          <span>{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[180px] p-0" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {value.length > 0 && value.length < STATUSES.length && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => { onValueChange([]); setOpen(false); }}
                >
                  All statuses
                </CommandItem>
              )}
              {STATUSES.map((s) => {
                const isSelected = value.includes(s.id);
                return (
                  <CommandItem
                    key={s.id}
                    value={s.name}
                    onSelect={() => toggle(s.id)}
                  >
                    <Check className={cn("mr-2 size-3.5", isSelected ? "opacity-100" : "opacity-0")} />
                    {s.name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
