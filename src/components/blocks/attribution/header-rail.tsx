"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ledger as ledgerCopy } from "./copy";
import { HelpMark } from "./help-mark";

export type RailFigure = {
  key: string;
  /** Already formatted; null means we genuinely don't know yet. */
  value: string | null;
  label: string;
  /** The comparison line — kept from the previous build. */
  sub?: string | null;
  help?: string;
  color?: string;
  /** Width of the loading skeleton, so the rail doesn't jump on arrival. */
  skeleton?: string;
};

/**
 * Four figures read left to right as the story: what came in, what went out on
 * Meta, what we could match, what came back. "Meta says" is deliberately not
 * here — it appears once, inside the Meta check fold, beside its own footnote.
 *
 * On a phone the same four figures become a 2×2 grid; nothing else changes.
 */
export function HeaderRail({
  figures,
  loading,
  emptyLabel,
}: {
  figures: readonly RailFigure[];
  loading: boolean;
  /** What a missing figure wears instead of a fake $0. */
  emptyLabel: string;
}) {
  return (
    <div className="border-b border-border">
      <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4 md:gap-0 md:bg-transparent md:px-3 md:py-2.5">
        {figures.map((figure) => (
          <div
            key={figure.key}
            className={cn(
              "flex min-w-0 flex-col gap-0.5 bg-card px-3 py-2.5",
              "md:flex-row md:flex-wrap md:items-baseline md:gap-x-2 md:gap-y-0.5 md:border-l md:border-border md:py-0 md:pl-3.5 md:pr-3.5",
              "md:first:border-l-0 md:first:pl-0",
            )}
          >
            <span className="text-[10px] font-medium uppercase tracking-[0.11em] text-muted-foreground/85 md:hidden">
              {figure.label}
            </span>

            {loading ? (
              <Skeleton className="h-5 w-20 md:h-4" />
            ) : (
              <span
                className="whitespace-nowrap text-[19px] font-semibold leading-tight tracking-[-0.025em] tabular-nums md:order-1 md:text-[16px] md:tracking-[-0.02em]"
                style={figure.color ? { color: figure.color } : undefined}
              >
                {figure.value ?? emptyLabel}
              </span>
            )}

            <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground md:order-2 md:inline">
              {figure.label}
              {figure.help ? (
                <HelpMark text={figure.help} className="ml-1 align-[-2px]" />
              ) : null}
            </span>

            {figure.sub ? (
              <span className="text-[10.5px] tabular-nums text-muted-foreground md:order-3 md:basis-full md:text-[11px]">
                {figure.sub}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <p className="hidden px-3 pb-2 text-[11px] text-muted-foreground/70 md:block">
        {ledgerCopy.caption}
      </p>
    </div>
  );
}
