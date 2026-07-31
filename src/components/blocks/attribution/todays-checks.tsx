"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { CheckStatus, FindingType } from "@/lib/findings";
import { checkStatusColor } from "./colors";
import { checks as copy } from "./copy";

export type TodaysCheckItem = { type: FindingType; status: CheckStatus };

/** Pinned above the rail footer — all five rules, always visible. */
export function TodaysChecks({
  items,
  loading,
}: {
  items: readonly TodaysCheckItem[] | undefined;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-3 py-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/55">
        {copy.title}
      </span>

      {loading || !items ? (
        <div className="flex flex-col gap-1.5 pt-1">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-3.5 w-full" />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li
              key={item.type}
              className="flex items-center justify-between gap-2 text-[12px]"
            >
              <span className="min-w-0 truncate text-muted-foreground">
                {copy.names[item.type]}
              </span>
              <span
                className="shrink-0 font-medium"
                style={{ color: checkStatusColor(item.status, item.type) }}
              >
                {copy.status[item.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
