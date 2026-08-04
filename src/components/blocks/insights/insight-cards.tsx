"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import type { SliceDimension } from "@/lib/creative-insights-shared";
import { cn } from "@/lib/utils";
import { alarm, cards as copy, page, sliceValueLabel } from "./insights-copy";

export type InsightCardData = {
  dimension: SliceDimension;
  value: string;
  backPer1: number;
  spend: string;
  revenue: string;
  runnerUp: { value: string; backPer1: number } | null;
  bars: Array<{ value: string; backPer1: number }>;
};

export type CoverageAlarm = {
  untaggedShare: string;
  untaggedSpend: string;
  totalSpend: string;
  adCount: number;
  windowDays: number;
};

/**
 * The answers, on top. Each card carries the bars that back its own sentence,
 * so the claim never has to be taken on trust — and when the coverage gate is
 * tripped the alarm goes first, because a claim read off half the spend is the
 * thing the reader most needs warned about.
 */
export function InsightCards({
  cards,
  alarm: alarmData,
  currency,
  minSpend,
  veiled,
  loading = false,
  onSeeDimension,
}: {
  cards: readonly InsightCardData[];
  alarm: CoverageAlarm | null;
  currency: string;
  minSpend: string;
  veiled: boolean;
  loading?: boolean;
  onSeeDimension: (dimension: SliceDimension) => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
          >
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {alarmData ? <CoverageAlarmCard data={alarmData} /> : null}

      {cards.length === 0 ? (
        <p className="rounded-md border border-border bg-card px-4 py-5 text-[12.5px] text-muted-foreground">
          {copy.none}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((card) => (
            <ClaimCard
              key={`${card.dimension}:${card.value}`}
              card={card}
              currency={currency}
              minSpend={minSpend}
              veiled={veiled}
              onSee={() => onSeeDimension(card.dimension)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimCard({
  card,
  currency,
  minSpend,
  veiled,
  onSee,
}: {
  card: InsightCardData;
  currency: string;
  minSpend: string;
  veiled: boolean;
  onSee: () => void;
}) {
  const label = sliceValueLabel(card.dimension, card.value);
  const back = formatMoneyExact(card.backPer1, currency) ?? page.noDataYet;
  const spend = formatMoneyExact(card.spend, currency) ?? page.noDataYet;
  const runnerUpLabel = card.runnerUp
    ? sliceValueLabel(card.dimension, card.runnerUp.value)
    : null;
  const runnerUpBack = card.runnerUp
    ? formatMoneyExact(card.runnerUp.backPer1, currency)
    : null;
  const widest = card.bars.reduce(
    (largest, bar) => Math.max(largest, bar.backPer1),
    0,
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
      <p className="text-[14px] font-medium leading-snug">
        {copy.claim(card.dimension, label, back)}
      </p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {veiled
          ? copy.whyVeiled(minSpend)
          : copy.why(spend, runnerUpLabel, runnerUpBack)}
      </p>

      <div className="mt-0.5 flex flex-col gap-1">
        {card.bars.map((bar) => (
          <div
            key={bar.value}
            className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_3.5rem] items-center gap-2 text-[11px] text-muted-foreground"
          >
            <span className="truncate">
              {sliceValueLabel(card.dimension, bar.value)}
            </span>
            <span className="flex h-1.5 items-center">
              <span
                aria-hidden
                className={cn("h-1.5 rounded-full", veiled && "opacity-30")}
                style={{
                  width: `${widest > 0 ? Math.max(2, (bar.backPer1 / widest) * 100) : 2}%`,
                  backgroundColor: "var(--attr-known)",
                }}
              />
            </span>
            <span className="text-right tabular-nums text-foreground">
              {veiled
                ? page.veiled
                : (formatMoneyExact(bar.backPer1, currency) ?? page.noDataYet)}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onSee}
        className="self-start text-[12px] font-medium text-primary hover:underline"
      >
        {copy.see(card.dimension)}
      </button>
    </div>
  );
}

function CoverageAlarmCard({ data }: { data: CoverageAlarm }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-4"
      style={{
        borderColor: "color-mix(in oklab, var(--attr-warning) 40%, transparent)",
        backgroundColor: "var(--attr-warning-soft)",
      }}
    >
      <p className="text-[14px] font-medium leading-snug">
        {alarm.title(data.untaggedShare)}
      </p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {alarm.body({
          untaggedSpend: data.untaggedSpend,
          totalSpend: data.totalSpend,
          adCount: data.adCount,
          windowDays: data.windowDays,
        })}
      </p>
      <Link
        href="/insights/tagging-queue"
        className="self-start text-[12px] font-medium text-primary hover:underline"
      >
        {alarm.action}
      </Link>
    </div>
  );
}
