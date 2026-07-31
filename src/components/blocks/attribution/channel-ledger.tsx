"use client";

import type { ReactNode } from "react";
import { Fragment, useState } from "react";
import { Check } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { cn } from "@/lib/utils";
import { BUCKET_ICON, bucketColor, inBucketOrder } from "./buckets";
import {
  bucketHelp,
  bucketLabels,
  ledger as copy,
  page,
} from "./copy";
import { formatMoneyExact, formatPercent } from "./format";
import { HelpMark } from "./help-mark";
import { ledgerLines } from "./ledger";

export type ChannelEntry = {
  bucket: AttributionBucket;
  revenue: string;
  orderCount: number;
};

export type Identity = {
  matches: boolean;
  sumOfBuckets: string;
  actual: string;
  difference: string | null;
};

/** Geometry only — the printed figure always comes from the raw string. */
function magnitude(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

/** Rows and totals share one grid, which is what makes the tie-out readable. */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_2rem_auto] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_2.5rem_6rem]";

export function ChannelLedger({
  entries,
  identity,
  pending,
  currency,
  selected,
  onSelect,
  loading = false,
  dimmed = false,
  shopifyReportUrl,
  renderDrawer,
}: {
  entries: readonly ChannelEntry[];
  identity: Identity | null;
  pending: { count: number; revenue: string } | null;
  currency: string;
  selected: AttributionBucket | null;
  onSelect: (bucket: AttributionBucket) => void;
  loading?: boolean;
  dimmed?: boolean;
  shopifyReportUrl?: string | null;
  renderDrawer: (bucket: AttributionBucket) => ReactNode;
}) {
  const [showEmpty, setShowEmpty] = useState(false);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 px-3 py-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className={cn(GRID, "px-2")}>
            <span className="flex items-center gap-2.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="h-3 w-32" />
            </span>
            <span />
            <Skeleton className="h-3 w-16 justify-self-end" />
          </div>
        ))}
      </div>
    );
  }

  const ordered = inBucketOrder(entries);
  const total = Math.max(magnitudeSum(ordered), 1);
  const widest = ordered.reduce(
    (largest, entry) => Math.max(largest, magnitude(entry.revenue)),
    0,
  );
  const empties = ordered.filter((entry) => magnitude(entry.revenue) <= 0);
  const visible = showEmpty
    ? ordered
    : ordered.filter((entry) => magnitude(entry.revenue) > 0);

  const pendingMoney = pending
    ? formatMoneyExact(pending.revenue, currency)
    : null;
  const lines = identity
    ? ledgerLines({
        sumOfBuckets:
          formatMoneyExact(identity.sumOfBuckets, currency) ?? page.noDataYet,
        actual: formatMoneyExact(identity.actual, currency) ?? page.noDataYet,
        difference: formatMoneyExact(identity.difference, currency),
        matches: identity.matches,
        pendingCount: pending?.count ?? 0,
        pendingMoney,
      })
    : [];

  return (
    <div className={cn("flex flex-col", dimmed && "opacity-60")}>
      <div className="flex flex-col gap-0.5">
        {visible.map((entry) => {
          const value = magnitude(entry.revenue);
          const isEmpty = value <= 0 && entry.orderCount === 0;
          const isSelected = selected === entry.bucket;
          const color = bucketColor(entry.bucket);
          const Icon = BUCKET_ICON[entry.bucket];
          const explanation = bucketHelp[entry.bucket];

          return (
            <Fragment key={entry.bucket}>
              <button
                type="button"
                onClick={() => onSelect(entry.bucket)}
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
                    {/* The bar is the row: a tint behind the label, not a chart column. */}
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 opacity-[0.18] transition-[width,opacity] duration-500 ease-out group-hover:opacity-[0.26]"
                      style={{
                        width: `${widest > 0 ? (value / widest) * 100 : 0}%`,
                        backgroundColor: color,
                      }}
                    />
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-[2px]"
                      style={{ backgroundColor: color }}
                    />
                  </>
                )}

                <span className="relative z-10 flex min-w-0 items-center gap-2.5 text-[12.5px]">
                  <Icon
                    className="size-3.5 shrink-0"
                    style={{ color: isEmpty ? "var(--border)" : color }}
                  />
                  <span className="truncate">{bucketLabels[entry.bucket]}</span>
                  {explanation ? (
                    <HelpMark
                      text={explanation}
                      focusable={false}
                      className="hidden sm:inline-flex"
                    />
                  ) : null}
                </span>

                <span className="relative z-10 text-right text-[11px] tabular-nums text-muted-foreground">
                  {isEmpty ? "" : (formatPercent(value / total) ?? "")}
                </span>

                <span
                  className={cn(
                    "relative z-10 text-right text-[12.5px] font-semibold tabular-nums",
                    isEmpty && "font-normal text-muted-foreground/60",
                  )}
                >
                  {isEmpty
                    ? page.nothingHere
                    : (formatMoneyExact(entry.revenue, currency) ??
                      page.noDataYet)}
                </span>
              </button>

              {isSelected && !isEmpty ? renderDrawer(entry.bucket) : null}
            </Fragment>
          );
        })}
      </div>

      {lines.length > 0 ? (
        <div className="flex flex-col">
          {lines.map((line) => (
            <div
              key={line.key}
              className={cn(
                GRID,
                "px-2.5 pt-2",
                line.rule === "strong"
                  ? "mt-1.5 border-t-[1.5px] border-foreground"
                  : "mt-0.5 border-t border-border/70",
              )}
              style={
                line.tone === "gap" ? { color: "var(--attr-warning)" } : undefined
              }
            >
              <span
                className={cn(
                  "flex min-w-0 items-center gap-2 text-[12.5px] font-semibold",
                  line.tone === "muted" && "font-medium text-muted-foreground",
                )}
              >
                <span className="truncate">{line.label}</span>
                {line.help ? <HelpMark text={line.help} /> : null}
              </span>
              <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                {line.share ?? ""}
              </span>
              <span
                className={cn(
                  "text-right text-[13.5px] font-semibold tabular-nums",
                  line.tone === "muted" &&
                    "text-[12px] font-medium text-muted-foreground",
                )}
              >
                {line.money}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {identity ? (
        <div className="flex flex-col gap-1 px-2.5 pt-2">
          <span
            className="flex items-start gap-2 text-[11.5px]"
            style={{
              color: identity.matches
                ? "var(--attr-good)"
                : "var(--attr-warning)",
            }}
          >
            <Check className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {copy.addsUp(
                formatMoneyExact(identity.sumOfBuckets, currency) ??
                  page.noDataYet,
                formatMoneyExact(identity.actual, currency) ?? page.noDataYet,
                identity.matches,
                pending && pending.count > 0 ? pendingMoney : null,
                formatMoneyExact(identity.difference, currency),
              )}{" "}
              {shopifyReportUrl ? (
                <a
                  href={shopifyReportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  {copy.checkInShopify}
                </a>
              ) : null}
            </span>
          </span>

          {pending && pending.count > 0 && pendingMoney ? (
            <span className="text-[11px] text-muted-foreground">
              {copy.pending(pending.count, pendingMoney)}
            </span>
          ) : null}

          {empties.length > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {showEmpty
                ? copy.emptyChannelsShown(empties.length)
                : `${copy.hiddenChannels(empties.length)}.`}{" "}
              <button
                type="button"
                onClick={() => setShowEmpty(!showEmpty)}
                className="font-medium text-primary hover:underline"
              >
                {showEmpty ? copy.hideEmpty : copy.showHidden}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function magnitudeSum(entries: readonly ChannelEntry[]): number {
  return entries.reduce((total, entry) => total + magnitude(entry.revenue), 0);
}
