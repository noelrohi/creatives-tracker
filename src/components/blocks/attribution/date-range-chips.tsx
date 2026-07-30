"use client";

import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "@/components/icons";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { RANGE_PRESETS, rangeLabels, type RangePreset } from "./copy";
import { addDays, dateToDay, dayToDate, isDay } from "./days";
import { formatDayRange } from "./format";

export type ResolvedRange = { dateFrom: string; dateTo: string };

/**
 * Ranges are measured from the store's own today, never from the browser clock —
 * the store runs on its own timezone and a browser-derived "yesterday" would
 * silently show the wrong day.
 */
export function resolveRange(
  preset: RangePreset,
  today: string,
  custom: { from: string; to: string },
): ResolvedRange {
  switch (preset) {
    case "today":
      return { dateFrom: today, dateTo: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { dateFrom: day, dateTo: day };
    }
    case "last7":
      return { dateFrom: addDays(today, -6), dateTo: today };
    case "last28":
      return { dateFrom: addDays(today, -27), dateTo: today };
    case "custom": {
      const from = isDay(custom.from) ? custom.from : addDays(today, -1);
      const to = isDay(custom.to) ? custom.to : from;
      const clampedTo = to > today ? today : to;
      const clampedFrom = from > clampedTo ? clampedTo : from;
      return { dateFrom: clampedFrom, dateTo: clampedTo };
    }
  }
}

export function DateRangeChips({
  preset,
  range,
  today,
  onPreset,
  onCustom,
}: {
  preset: RangePreset;
  range: ResolvedRange | null;
  today: string | null;
  onPreset: (preset: RangePreset) => void;
  onCustom: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!today || !range) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {RANGE_PRESETS.map((key) => (
          <Skeleton key={key} className="h-7 w-20 rounded-full" />
        ))}
      </div>
    );
  }

  const handleSelect = (selected: DateRange | undefined) => {
    if (!selected?.from) return;
    const from = dateToDay(selected.from);
    const to = selected.to ? dateToDay(selected.to) : from;
    onCustom(from, to);
    if (selected.to) setOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {RANGE_PRESETS.filter((key) => key !== "custom").map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onPreset(key)}
          aria-pressed={preset === key}
          className={cn(
            "h-7 rounded-full border px-3 text-[12px] font-medium transition-colors",
            preset === key
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {rangeLabels[key]}
        </button>
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-pressed={preset === "custom"}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors",
              preset === "custom"
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <CalendarIcon className="size-3.5" />
            {preset === "custom"
              ? formatDayRange(range.dateFrom, range.dateTo)
              : rangeLabels.custom}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-2">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={{
              from: dayToDate(range.dateFrom),
              to: dayToDate(range.dateTo),
            }}
            defaultMonth={dayToDate(range.dateFrom)}
            onSelect={handleSelect}
            disabled={{ after: dayToDate(today) }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
