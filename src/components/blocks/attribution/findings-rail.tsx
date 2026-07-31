"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { rail as copy } from "./copy";
import {
  FindingsBody,
  FindingsStatusFooter,
  useFindingsState,
  type FindingsContext,
} from "./findings-content";
import { TodaysChecks } from "./todays-checks";

export { useOpenFindingsCount } from "./findings-content";

export type FindingsRailProps = FindingsContext & {
  frozenClock: string | null;
  lastCheckedClock: string | null;
  /** "panel" is the sticky desktop column; "sheet" fills the mobile sheet. */
  variant?: "panel" | "sheet";
};

/**
 * The findings, with their header stamp and the five daily checks pinned under
 * them. Since the redesign the desktop page reaches for the same content through
 * the "Needs your attention" fold; this component is what the mobile sheet shows.
 */
export function FindingsRail({
  frozenClock,
  lastCheckedClock,
  variant = "panel",
  ...context
}: FindingsRailProps) {
  const state = useFindingsState();
  const { frozen } = context;
  const { items, status, isPending, hasCritical, checks, checksLoading } = state;

  const headerSentence = frozen
    ? frozenClock
      ? copy.frozen(frozenClock)
      : copy.frozenNoClock
    : lastCheckedClock
      ? items.length === 0 && status === "open"
        ? copy.checkedAllClear(lastCheckedClock)
        : copy.checked(lastCheckedClock)
      : items.length === 0 && status === "open"
        ? copy.checkedNoStampAllClear
        : copy.checkedNoStamp;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-card",
        variant === "panel" &&
          "sticky top-0 max-h-[calc(100svh-4.5rem)] rounded-md border border-border",
        variant === "sheet" && "h-full",
      )}
    >
      <div className="flex flex-col gap-1 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">
            {copy.title}
          </h2>
          {isPending ? (
            <Skeleton className="h-5 w-6 rounded-full" />
          ) : items.length > 0 ? (
            <Badge
              variant="outline"
              className="h-5 rounded-full px-2 text-[11px] tabular-nums"
              style={
                hasCritical
                  ? {
                      backgroundColor: "var(--attr-critical-soft)",
                      borderColor: "var(--attr-critical)",
                      color: "var(--attr-critical)",
                    }
                  : undefined
              }
            >
              {items.length}
            </Badge>
          ) : null}
        </div>
        <p
          className="text-[11px]"
          style={{
            color: frozen ? "var(--attr-warning)" : "var(--muted-foreground)",
          }}
        >
          {headerSentence}
        </p>
      </div>

      <FindingsBody
        state={state}
        context={context}
        className="min-h-0 flex-1 overflow-y-auto"
      />

      <TodaysChecks items={checks} loading={checksLoading} />

      <FindingsStatusFooter
        state={state}
        className="border-t border-border px-3 py-2"
      />
    </div>
  );
}
