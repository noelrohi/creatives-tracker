"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown, SlidersHorizontal, Sparkles, Upload } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const FORMATS = ["static", "video", "ugc", "carousel"] as const;
export const AWARENESS = ["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"] as const;

export function prettify(s: string | null | undefined) {
  return s ? s.replace(/_/g, " ") : null;
}

export function formatLandingPage(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${path}`;
  } catch {
    return url;
  }
}

export function FilterPill({
  value,
  onValueChange,
  placeholder,
  options,
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  options: { label: string; value: string }[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-8 w-auto gap-1 border-none bg-muted/40 px-3 text-[13px] capitalize shadow-none hover:bg-muted/60 [&>svg]:size-3">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="capitalize">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MoreFilters({
  format,
  awareness,
  health,
  onFormatChange,
  onAwarenessChange,
  onHealthChange,
  onClear,
}: {
  format: string | null | undefined;
  awareness: string | null | undefined;
  health: string;
  onFormatChange: (value: string) => void;
  onAwarenessChange: (value: string) => void;
  onHealthChange: (value: string) => void;
  onClear: () => void;
}) {
  const activeCount = [format, awareness, health].filter(Boolean).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn("h-8 gap-1.5 border-none bg-muted/40 px-3 text-[13px] shadow-none hover:bg-muted/60", activeCount > 0 && "bg-muted/70")}
        >
          <SlidersHorizontal className="size-3" />
          More filters{activeCount > 0 ? ` · ${activeCount}` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] space-y-3" align="start">
        <div>
          <p className="text-sm font-medium">More filters</p>
          <p className="text-xs text-muted-foreground">Narrow creatives by classification and health.</p>
        </div>
        <div className="grid gap-2">
          <FilterPill
            value={format ?? "all"}
            onValueChange={onFormatChange}
            placeholder="Format"
            options={[{ label: "All Formats", value: "all" }, ...FORMATS.map((item) => ({ label: item.charAt(0).toUpperCase() + item.slice(1), value: item }))]}
          />
          <FilterPill
            value={awareness ?? "all"}
            onValueChange={onAwarenessChange}
            placeholder="Awareness"
            options={[{ label: "All Levels", value: "all" }, ...AWARENESS.map((item) => ({ label: prettify(item)!, value: item }))]}
          />
          <FilterPill
            value={health || "all"}
            onValueChange={onHealthChange}
            placeholder="Health"
            options={[
              { label: "All Health", value: "all" },
              { label: "Healthy", value: "healthy" },
              { label: "Warning", value: "warning" },
              { label: "Critical", value: "critical" },
            ]}
          />
        </div>
        {activeCount > 0 ? (
          <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={onClear}>
            Clear more filters
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function PerformanceFilter({
  minRoas,
  minConversions,
  minCtr,
  onMinRoasChange,
  onMinConversionsChange,
  onMinCtrChange,
}: {
  minRoas: string;
  minConversions: string;
  minCtr: string;
  onMinRoasChange: (value: string) => void;
  onMinConversionsChange: (value: string) => void;
  onMinCtrChange: (value: string) => void;
}) {
  const activeCount = [minRoas, minConversions, minCtr].filter(Boolean).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn("h-8 gap-1.5 border-none bg-muted/40 px-3 text-[13px] shadow-none hover:bg-muted/60", activeCount > 0 && "bg-muted/70")}
        >
          <SlidersHorizontal className="size-3" />
          Performance{activeCount > 0 ? ` · ${activeCount}` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] space-y-3" align="start">
        <div>
          <p className="text-sm font-medium">Performance filters</p>
          <p className="text-xs text-muted-foreground">All conditions apply to the selected date range.</p>
        </div>
        {[
          { label: "ROAS greater than", value: minRoas, setValue: onMinRoasChange, placeholder: "1" },
          { label: "Conversions greater than", value: minConversions, setValue: onMinConversionsChange, placeholder: "10" },
          { label: "CTR greater than (%)", value: minCtr, setValue: onMinCtrChange, placeholder: "25" },
        ].map((field) => (
          <label key={field.label} className="grid grid-cols-[1fr_88px] items-center gap-3 text-xs">
            <span>{field.label}</span>
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={field.value}
              onChange={(event) => field.setValue(event.target.value)}
              placeholder={field.placeholder}
              className="h-8 rounded-md border bg-background px-2 text-right text-[13px] outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        ))}
        {activeCount > 0 ? (
          <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={() => { onMinRoasChange(""); onMinConversionsChange(""); onMinCtrChange(""); }}>
            Clear performance filters
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function LandingPageCombobox({
  value,
  onValueChange,
  landingPages,
}: {
  value: string[];
  onValueChange: (value: string[]) => void;
  landingPages: string[];
}) {
  const [open, setOpen] = useState(false);
  const label = value.length === 0
    ? "Landing Page"
    : value.length === 1
      ? formatLandingPage(value[0])
      : `${value.length} landing pages`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-label="Filter by landing page"
          className="h-8 w-auto gap-1 border-none bg-muted/40 px-3 text-[13px] shadow-none hover:bg-muted/60"
        >
          <span className="max-w-[220px] truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search landing pages..." className="h-8 text-[13px]" />
          <CommandList>
            <CommandEmpty>No landing pages found.</CommandEmpty>
            <CommandGroup>
              {value.length > 0 ? (
                <CommandItem value="__clear__" onSelect={() => onValueChange([])}>
                  Clear selection
                </CommandItem>
              ) : null}
              {landingPages.map((url) => {
                const selected = value.includes(url);
                return (
                  <CommandItem
                    key={url}
                    value={`${formatLandingPage(url)} ${url}`}
                    onSelect={() => onValueChange(selected ? value.filter((item) => item !== url) : [...value, url])}
                  >
                    <Check className={cn("mr-2 size-3.5", selected ? "opacity-100" : "opacity-0")} />
                    <span className="truncate" title={url}>{formatLandingPage(url)}</span>
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

export function AdSetCombobox({
  value,
  onValueChange,
  adSets,
}: {
  value: string[];
  onValueChange: (v: string[]) => void;
  adSets: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);

  const toggle = (id: string) => {
    onValueChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };

  const label =
    value.length === 0
      ? "Ad Set"
      : value.length === 1
        ? adSets.find((a) => a.id === value[0])?.name ?? "1 ad set"
        : `${value.length} ad sets`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-auto gap-1 border-none bg-muted/40 px-3 text-[13px] shadow-none hover:bg-muted/60"
        >
          <span className="max-w-[200px] truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search ad sets..." className="h-8 text-[13px]" />
          <CommandList>
            <CommandEmpty>No ad sets found.</CommandEmpty>
            <CommandGroup>
              {value.length > 0 && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => { onValueChange([]); setOpen(false); }}
                >
                  Clear selection
                </CommandItem>
              )}
              {adSets.map((a) => {
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

export function EmptyState({
  hasFilters,
  onClear,
  onImport,
  readOnly,
}: {
  hasFilters: boolean;
  onClear: () => void;
  onImport?: () => void;
  readOnly: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
        <Sparkles className="size-5 text-muted-foreground/40" />
      </div>
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          {hasFilters ? "No creatives match your filters" : "No creatives yet"}
        </p>
        <p className="text-[13px] text-muted-foreground/40">
          {hasFilters
            ? "Try adjusting your search or filters."
            : readOnly
              ? "No creatives are available to view yet."
              : "Import your Meta Ads Manager report to get started."}
        </p>
      </div>
      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>Clear filters</Button>
      ) : onImport ? (
        <Button size="sm" variant="outline" onClick={onImport} className="gap-1.5">
          <Upload className="size-3.5" /> Import Ads
        </Button>
      ) : null}
    </div>
  );
}

export function TableLoadingSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="divide-y">
        <div className="grid grid-cols-8 gap-4 px-4 py-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="grid grid-cols-8 gap-4 px-4 py-3">
            {Array.from({ length: 8 }).map((_, j) => (
              <Skeleton key={j} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
