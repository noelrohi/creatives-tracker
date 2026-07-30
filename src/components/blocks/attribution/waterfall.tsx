"use client";

import type { AttributionBucket } from "@/lib/attribution-bucket";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { BUCKET_ORDER, bucketColor, inBucketOrder } from "./buckets";
import { bucketLabels, page, waterfall as copy } from "./copy";
import { formatCount, formatMoney } from "./format";

export type WaterfallEntry = {
  bucket: AttributionBucket;
  revenue: string;
  orderCount: number;
};

/** Geometry only — the printed figure always comes from the raw string. */
function magnitude(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

const CHART_HEIGHT = 176;
const MIN_SEGMENT_PERCENT = 0.8;

export function Waterfall({
  entries,
  total,
  currency,
  selected,
  onSelect,
  loading = false,
  dimmed = false,
}: {
  entries: readonly WaterfallEntry[];
  total: string;
  currency: string;
  selected: AttributionBucket | null;
  onSelect: (bucket: AttributionBucket) => void;
  loading?: boolean;
  dimmed?: boolean;
}) {
  if (loading) {
    return (
      <div className="overflow-x-auto">
        <div className="flex min-w-[720px] items-end gap-2">
          {["total", ...BUCKET_ORDER].map((key, index) => (
            <div key={key} className="flex flex-1 flex-col gap-2">
              <Skeleton
                className="w-full"
                style={{ height: CHART_HEIGHT - index * 16 }}
              />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const ordered = inBucketOrder(entries);
  const totalMagnitude = magnitude(total);
  const scale =
    totalMagnitude > 0
      ? totalMagnitude
      : ordered.reduce((sum, entry) => sum + magnitude(entry.revenue), 0);

  // Each segment starts where the one before it stopped, so the row of columns
  // reads as one staircase down from the total.
  const segments = ordered.map((entry, index) => {
    const value = magnitude(entry.revenue);
    const consumed = ordered
      .slice(0, index + 1)
      .reduce((sum, earlier) => sum + magnitude(earlier.revenue), 0);
    const heightPercent =
      scale > 0
        ? Math.max((value / scale) * 100, value > 0 ? MIN_SEGMENT_PERCENT : 0)
        : 0;
    const bottomPercent =
      scale > 0 ? Math.max(0, 100 - (consumed / scale) * 100) : 0;
    return { entry, value, heightPercent, bottomPercent };
  });

  return (
    <div className={cn("flex flex-col gap-2", dimmed && "opacity-60")}>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[720px] items-stretch gap-2">
          <div className="flex w-[92px] shrink-0 flex-col gap-2">
            <div className="relative" style={{ height: CHART_HEIGHT }}>
              <div
                className="absolute inset-x-0 bottom-0 rounded-sm border border-border bg-muted"
                style={{ height: "100%" }}
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium leading-tight">
                {copy.totalLabel}
              </span>
              <span className="text-[12px] font-semibold tabular-nums leading-tight">
                {formatMoney(total, currency) ?? page.noDataYet}
              </span>
            </div>
          </div>

          {segments.map(({ entry, value, heightPercent, bottomPercent }) => {
            const isSelected = selected === entry.bucket;
            const isEmpty = value <= 0 && entry.orderCount === 0;

            return (
              <div key={entry.bucket} className="flex min-w-0 flex-1 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => onSelect(entry.bucket)}
                  disabled={isEmpty}
                  aria-label={`${bucketLabels[entry.bucket]} — ${
                    formatMoney(entry.revenue, currency) ?? page.nothingHere
                  }`}
                  aria-pressed={isSelected}
                  className={cn(
                    "group relative w-full rounded-sm transition-colors",
                    !isEmpty && "cursor-pointer hover:bg-muted/60",
                    isEmpty && "cursor-default",
                  )}
                  style={{ height: CHART_HEIGHT }}
                >
                  {isEmpty ? (
                    <span className="absolute inset-x-0 bottom-0 h-px bg-border" />
                  ) : (
                    <span
                      className={cn(
                        "absolute inset-x-0 rounded-sm ring-offset-2 ring-offset-card transition-all",
                        isSelected && "ring-2 ring-ring",
                      )}
                      style={{
                        backgroundColor: bucketColor(entry.bucket),
                        height: `${heightPercent}%`,
                        bottom: `${bottomPercent}%`,
                        minHeight: 3,
                      }}
                    />
                  )}
                </button>

                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: bucketColor(entry.bucket) }}
                    />
                    <span className="truncate">{bucketLabels[entry.bucket]}</span>
                  </span>
                  <span
                    className={cn(
                      "text-[12px] font-semibold tabular-nums leading-tight",
                      isEmpty && "text-muted-foreground/60 font-normal",
                    )}
                  >
                    {isEmpty
                      ? page.nothingHere
                      : (formatMoney(entry.revenue, currency) ?? page.noDataYet)}
                  </span>
                  {!isEmpty && (
                    <span className="text-[11px] tabular-nums text-muted-foreground/70">
                      {formatCount(entry.orderCount)}{" "}
                      {entry.orderCount === 1 ? "order" : "orders"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/60">{copy.caption}</p>
    </div>
  );
}
