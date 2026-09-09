"use client";

import { useState } from "react";
import {
  endOfDay,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type DatePreset = { label: string; range: { from: Date; to: Date } };

/**
 * Presets anchored on a caller-supplied "today" (a local-time Date at any
 * hour of that calendar day). Pages whose days follow a store or account
 * timezone pass that zone's today; the default is the browser's.
 */
export function datePresets(today: Date): DatePreset[] {
  return [
    { label: "Today", range: { from: startOfDay(today), to: endOfDay(today) } },
    { label: "Yesterday", range: { from: startOfDay(subDays(today, 1)), to: endOfDay(subDays(today, 1)) } },
    { label: "Last 7 days", range: { from: startOfDay(subDays(today, 6)), to: endOfDay(today) } },
    { label: "Last 14 days", range: { from: startOfDay(subDays(today, 13)), to: endOfDay(today) } },
    { label: "Last 30 days", range: { from: startOfDay(subDays(today, 29)), to: endOfDay(today) } },
    { label: "This month", range: { from: startOfMonth(today), to: endOfDay(today) } },
    { label: "Last Month", range: { from: startOfMonth(subMonths(today, 1)), to: endOfMonth(subMonths(today, 1)) } },
    { label: "Last 3 Months", range: { from: startOfMonth(subMonths(today, 3)), to: endOfMonth(subMonths(today, 1)) } },
  ];
}

function getActivePreset(presets: DatePreset[], from: Date | undefined, to: Date | undefined): string | null {
  if (!from || !to) return null;
  const f = format(from, "yyyy-MM-dd");
  const t = format(to, "yyyy-MM-dd");
  for (const p of presets) {
    if (format(p.range.from, "yyyy-MM-dd") === f && format(p.range.to, "yyyy-MM-dd") === t) return p.label;
  }
  return null;
}

function formatLabel(presets: DatePreset[], from: Date | undefined, to: Date | undefined): string {
  const preset = getActivePreset(presets, from, to);
  if (preset) return preset;
  if (!from) return "Pick a date range";
  if (!to) return format(from, "MMM d, yyyy");
  if (format(from, "yyyy-MM-dd") === format(to, "yyyy-MM-dd")) return format(from, "MMM d, yyyy");
  return `${format(from, "MMM d")} - ${format(to, "MMM d, yyyy")}`;
}

export function DateRangePicker({
  from,
  to,
  onChange,
  today = new Date(),
}: {
  from: Date | undefined;
  to: Date | undefined;
  onChange: (range: { from: Date; to: Date } | undefined) => void;
  /**
   * The latest selectable day and the anchor for every preset, as a
   * local-time Date on that calendar day. Defaults to the browser's today;
   * pages that count days in a store or account timezone pass that today.
   */
  today?: Date;
}) {
  const [open, setOpen] = useState(false);
  const presets = datePresets(today);

  const handleSelect = (range: DateRange | undefined) => {
    if (range?.from && range?.to) {
      onChange({ from: range.from, to: range.to });
    } else if (range?.from) {
      // Single day click — wait for second click
      onChange({ from: range.from, to: range.from });
    }
  };

  const applyPreset = (preset: DatePreset) => {
    onChange({ from: preset.range.from, to: preset.range.to });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "h-7 w-auto gap-1.5 px-2.5 text-[13px]",
            !from && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="size-3.5" />
          <span>{formatLabel(presets, from, to)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex">
          <div className="flex flex-col gap-0.5 border-r p-2">
            {presets.map((p) => (
              <Button
                key={p.label}
                variant={getActivePreset(presets, from, to) === p.label ? "secondary" : "ghost"}
                size="sm"
                className="justify-start text-[13px]"
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="p-2">
            <Calendar
              mode="range"
              selected={from ? { from, to } : undefined}
              onSelect={handleSelect}
              numberOfMonths={2}
              defaultMonth={subDays(today, 30)}
              disabled={{ after: endOfDay(today) }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
