"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { HelpMark } from "@/components/blocks/attribution/help-mark";
import {
  formatMoneyExact,
  formatPercent,
} from "@/components/blocks/attribution/format";
import {
  NO_TAGS_KEY,
  UNMATCHED_KEY,
  type SliceDimension,
} from "@/lib/creative-insights-shared";
import { cn } from "@/lib/utils";
import {
  ledger as copy,
  page,
  sliceValueHelp,
  sliceValueLabel,
} from "./insights-copy";

export type SliceRowData = {
  key: string;
  revenue: string;
  orderCount: number;
  spend: string | null;
  backPer1: number | null;
};

export type VeilNote = {
  share: string;
  minShare: string;
  ads: Array<{
    adId: string;
    adName: string;
    creativeId: string | null;
    spend: string;
  }>;
};

/** Geometry only — the printed figure always comes from the raw string. */
function magnitude(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

/**
 * One hue, stepped down the list, so the eye reads rank without the palette
 * pretending each value is its own category. The two explicit rows step out of
 * the ramp entirely — they are the caveat, not a result.
 */
function rowColor(key: string, index: number, total: number): string {
  if (key === NO_TAGS_KEY || key === UNMATCHED_KEY) {
    return "var(--attr-neutral)";
  }
  const mix = 100 - (index / Math.max(1, total)) * 45;
  return `color-mix(in oklab, var(--attr-known) ${mix}%, var(--card))`;
}

const GRID =
  "grid grid-cols-[minmax(0,1fr)_2rem_auto] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_2.5rem_7rem]";

export function SliceLedger({
  rows,
  dimension,
  currency,
  selected,
  onSelect,
  loading = false,
  veil = null,
  renderDrawer,
}: {
  rows: readonly SliceRowData[];
  dimension: SliceDimension;
  currency: string;
  selected: string | null;
  onSelect: (key: string) => void;
  loading?: boolean;
  /** Set below the 80% line: bars dim, money veils, the note names the ads. */
  veil?: VeilNote | null;
  /** Optional inline drawer; the insights screen opens its drill-in below instead. */
  renderDrawer?: (key: string) => ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 px-3 py-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className={cn(GRID, "px-2")}>
            <span className="flex items-center gap-2.5">
              <Skeleton className="size-2.5 rounded-full" />
              <Skeleton className="h-3 w-32" />
            </span>
            <span />
            <Skeleton className="h-3 w-16 justify-self-end" />
          </div>
        ))}
      </div>
    );
  }

  const veiled = veil !== null;
  const total = rows.reduce((sum, row) => sum + magnitude(row.revenue), 0);
  const widest = rows.reduce(
    (largest, row) => Math.max(largest, magnitude(row.revenue)),
    0,
  );
  const taggedCount = rows.filter(
    (row) => row.key !== NO_TAGS_KEY && row.key !== UNMATCHED_KEY,
  ).length;
  const anything = rows.some(
    (row) => magnitude(row.revenue) > 0 || magnitude(row.spend) > 0,
  );

  if (!anything) {
    return (
      <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
        {copy.empty}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-0.5">
        {rows.map((row, index) => {
          const value = magnitude(row.revenue);
          const isSelected = selected === row.key;
          const color = rowColor(row.key, index, taggedCount);
          const help = sliceValueHelp(dimension, row.key);
          const money = formatMoneyExact(row.revenue, currency);
          const back =
            row.backPer1 === null
              ? null
              : formatMoneyExact(row.backPer1, currency);
          const isEmpty = value <= 0 && magnitude(row.spend) <= 0;

          return (
            <Fragment key={row.key}>
              <button
                type="button"
                onClick={() => onSelect(row.key)}
                disabled={isEmpty}
                aria-pressed={isSelected}
                className={cn(
                  GRID,
                  "group relative overflow-hidden rounded-sm px-2.5 py-2 text-left transition-colors",
                  isEmpty ? "cursor-default" : "cursor-pointer",
                  isSelected && "ring-2 ring-ring ring-offset-1 ring-offset-card",
                )}
              >
                {isEmpty ? null : (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-0 left-0 transition-[width,opacity] duration-500 ease-out",
                        veiled
                          ? "opacity-[0.07]"
                          : "opacity-[0.18] group-hover:opacity-[0.26]",
                      )}
                      style={{
                        width: `${widest > 0 ? (value / widest) * 100 : 0}%`,
                        backgroundColor: color,
                      }}
                    />
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-[2px]"
                      style={{ backgroundColor: color, opacity: veiled ? 0.5 : 1 }}
                    />
                  </>
                )}

                <span className="relative z-10 flex min-w-0 items-center gap-2.5 text-[12.5px]">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="truncate">
                    {sliceValueLabel(dimension, row.key)}
                  </span>
                  {help ? (
                    <HelpMark
                      text={help}
                      focusable={false}
                      className="hidden sm:inline-flex"
                    />
                  ) : null}
                </span>

                <span className="relative z-10 text-right text-[11px] tabular-nums text-muted-foreground">
                  {veiled || total <= 0
                    ? ""
                    : (formatPercent(value / total) ?? "")}
                </span>

                <span className="relative z-10 flex flex-col items-end">
                  <span className="text-[12.5px] font-semibold tabular-nums">
                    {veiled ? page.veiled : (money ?? page.noDataYet)}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {veiled
                      ? ""
                      : back
                        ? copy.backPerDollar(back)
                        : copy.orders(row.orderCount)}
                  </span>
                </span>
              </button>

              {isSelected && !isEmpty ? renderDrawer?.(row.key) : null}
            </Fragment>
          );
        })}
      </div>

      {veil ? (
        <div
          className="mx-2.5 mt-2 flex flex-col gap-1.5 rounded-sm px-3 py-2.5 text-[12px]"
          style={{ backgroundColor: "var(--attr-warning-soft)" }}
        >
          <span className="font-semibold">{copy.veilTitle(veil.share)}</span>
          <span className="text-muted-foreground">
            {copy.veilBody(veil.minShare)}
          </span>
          <ul className="flex flex-col gap-0.5">
            {veil.ads.map((ad) => (
              <li key={ad.adId} className="flex items-baseline gap-2">
                {ad.creativeId ? (
                  <Link
                    href={`/creatives/${ad.creativeId}`}
                    className="truncate font-medium text-primary hover:underline"
                  >
                    {ad.adName}
                  </Link>
                ) : (
                  <span className="truncate font-medium">{ad.adName}</span>
                )}
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {copy.veilAdSpend(
                    formatMoneyExact(ad.spend, currency) ?? page.noDataYet,
                  )}
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/insights/tagging-queue"
            className="font-medium text-primary hover:underline"
          >
            {copy.queueLink}
          </Link>
        </div>
      ) : null}

      <p className="px-2.5 pt-2 text-[11px] text-muted-foreground/70">
        {copy.footnote}
      </p>
    </div>
  );
}
