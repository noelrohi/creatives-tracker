"use client";

import { useState } from "react";
import { format, subDays, startOfDay, endOfDay, startOfMonth } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const PRESETS = [
  { label: "Today", range: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  { label: "Yesterday", range: () => { const d = subDays(new Date(), 1); return { from: startOfDay(d), to: endOfDay(d) }; } },
  { label: "Last 7 days", range: () => ({ from: startOfDay(subDays(new Date(), 6)), to: endOfDay(new Date()) }) },
  { label: "Last 14 days", range: () => ({ from: startOfDay(subDays(new Date(), 13)), to: endOfDay(new Date()) }) },
  { label: "Last 30 days", range: () => ({ from: startOfDay(subDays(new Date(), 29)), to: endOfDay(new Date()) }) },
  { label: "This month", range: () => ({ from: startOfMonth(new Date()), to: endOfDay(new Date()) }) },
] as const;

function getActivePreset(from: Date | undefined, to: Date | undefined): string | null {
  if (!from || !to) return null;
  const f = format(from, "yyyy-MM-dd");
  const t = format(to, "yyyy-MM-dd");
  for (const p of PRESETS) {
    const r = p.range();
    if (format(r.from, "yyyy-MM-dd") === f && format(r.to, "yyyy-MM-dd") === t) return p.label;
  }
  return null;
}

function formatLabel(from: Date | undefined, to: Date | undefined): string {
  const preset = getActivePreset(from, to);
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
}: {
  from: Date | undefined;
  to: Date | undefined;
  onChange: (range: { from: Date; to: Date } | undefined) => void;
}) {
  const [open, setOpen] = useState(false);

  const handleSelect = (range: DateRange | undefined) => {
    if (range?.from && range?.to) {
      onChange({ from: range.from, to: range.to });
    } else if (range?.from) {
      // Single day click — wait for second click
      onChange({ from: range.from, to: range.from });
    }
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    const r = preset.range();
    onChange({ from: r.from, to: r.to });
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
          <span>{formatLabel(from, to)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex">
          <div className="flex flex-col gap-0.5 border-r p-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant={getActivePreset(from, to) === p.label ? "secondary" : "ghost"}
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
              defaultMonth={subDays(new Date(), 30)}
              disabled={{ after: new Date() }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
