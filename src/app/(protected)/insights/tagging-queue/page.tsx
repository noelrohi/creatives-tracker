"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatMoneyExact,
  formatPercent,
} from "@/components/blocks/attribution/format";
import {
  page as copy,
  queue as queueCopy,
} from "@/components/blocks/insights/insights-copy";
import { TaggingQueueTable } from "@/components/blocks/insights/tagging-queue-table";
import { useTRPC } from "@/lib/trpc/client";

export default function TaggingQueuePage() {
  const trpc = useTRPC();

  useBreadcrumbs([
    { label: copy.navLabel, href: "/insights" },
    { label: queueCopy.navLabel },
  ]);

  const coverage = useQuery(trpc.creativeInsights.coverage.queryOptions());
  const queue = useQuery(trpc.creativeInsights.taggingQueue.queryOptions({}));

  const currency = coverage.data?.store.currency ?? "USD";
  const taggedShare = formatPercent(coverage.data?.share);
  const untaggedSpend = formatMoneyExact(
    coverage.data?.untaggedSpend,
    currency,
  );

  if (coverage.isError) {
    return (
      <p className="py-16 text-center text-[13px] text-muted-foreground">
        {copy.storeMissing}
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-[15px] font-semibold tracking-tight">
          {queueCopy.title}
        </h1>
        <Link
          href="/insights"
          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {queueCopy.back}
        </Link>
      </div>

      {coverage.isPending || !coverage.data ? (
        <Skeleton className="h-4 w-3/4 max-w-[42rem]" />
      ) : (
        <p className="max-w-[52rem] text-[12.5px] leading-relaxed text-muted-foreground">
          {queueCopy.subtitle({
            adCount: coverage.data.untaggedAdCount,
            spend: untaggedSpend ?? copy.noDataYet,
            windowDays: coverage.data.windowDays,
          })}
          {taggedShare ? ` ${queueCopy.covered(taggedShare)}` : ""}
        </p>
      )}

      <section className="overflow-hidden rounded-md border border-border bg-card">
        <TaggingQueueTable
          rows={queue.data?.ads ?? []}
          currency={currency}
          loading={queue.isPending}
        />
      </section>
    </div>
  );
}
