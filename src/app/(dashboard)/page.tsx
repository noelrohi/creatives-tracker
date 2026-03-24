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
  Image,
  LayoutTemplate,
  Megaphone,
  Tag,
  Upload,
  ArrowRight,
} from "lucide-react";
import { StaleDataBanner } from "@/components/blocks/dashboard/data-freshness";

function fmtMoney(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `$${n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2)}`;
}

export default function DashboardPage() {
  const trpc = useTRPC();

  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const selectedAccountId = accountId || undefined;

  const accounts = useQuery(trpc.account.list.queryOptions());
  const creatives = useQuery(
    trpc.adCreative.list.queryOptions(
      selectedAccountId ? { accountId: selectedAccountId } : undefined,
    ),
  );
  const untaggedCreatives = useQuery(
    trpc.adCreative.list.queryOptions({
      ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
      untaggedOnly: true,
    }),
  );
  const ads = useQuery(trpc.ad.list.queryOptions());
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const isLoading =
    accounts.isLoading ||
    creatives.isLoading ||
    ads.isLoading ||
    landingPages.isLoading;

  const creativeRows = creatives.data ?? [];
  const recentCreatives = creativeRows.slice(0, 5);
  const liveCreatives = creativeRows.filter(
    (creative) => creative.adStatus === "active",
  ).length;
  const totalSpend = creativeRows.reduce((sum, creative) => {
    const spend =
      creative.totalSpend == null ? 0 : Number.parseFloat(creative.totalSpend);
    return sum + (Number.isNaN(spend) ? 0 : spend);
  }, 0);

  const metrics = [
    { label: "Creatives", value: creativeRows.length, icon: Image },
    { label: "Live Creatives", value: liveCreatives, icon: Megaphone },
    { label: "Landing Pages", value: landingPages.data?.length ?? 0, icon: LayoutTemplate },
    { label: "Linked Ads", value: ads.data?.length ?? 0, icon: Tag },
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
              <m.icon className="size-3.5" />
              {m.label}
            </div>
            {isLoading ? (
              <Skeleton className="mt-1 h-6 w-16" />
            ) : (
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-lg font-semibold tabular-nums leading-tight">
                  {m.value}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[13px] text-muted-foreground">Portfolio spend in visible creatives</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {isLoading ? "—" : fmtMoney(totalSpend)}
            </p>
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

      {/* Recent creatives */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            Recent Creatives
          </h2>
          <Button variant="ghost" size="sm" asChild className="text-[13px] text-muted-foreground">
            <Link href={`/creatives${accountId ? `?account=${accountId}` : ""}`}>
              View Creatives <ArrowRight className="ml-1 size-3" />
            </Link>
          </Button>
        </div>

        {creatives.isLoading ? (
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
        ) : recentCreatives.length > 0 ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Creative</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Meta Ad ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentCreatives.map((row) => (
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
                    <TableCell className="text-sm">
                      {row.adStatus ? (
                        <Badge variant="outline" className="text-[11px] capitalize">
                          {row.adStatus}
                        </Badge>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {fmtMoney(row.totalSpend)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {row.metaAdId || "—"}
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
