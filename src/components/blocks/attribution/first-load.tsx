"use client";

import { Progress } from "@/components/ui/progress";
import { firstLoad as copy } from "./copy";

/**
 * Before the first 90-day load finishes: a bar that fills as days of orders land,
 * with the waterfall below it filling in at the same time.
 */
export function FirstLoadProgress({
  daysLoaded,
  daysTotal,
}: {
  daysLoaded: number;
  daysTotal: number;
}) {
  const percent =
    daysTotal > 0 ? Math.min(100, Math.round((daysLoaded / daysTotal) * 100)) : 0;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
      <h2 className="text-[14px] font-semibold tracking-tight">{copy.title}</h2>
      <p className="text-[12px] text-muted-foreground">{copy.body}</p>
      <Progress value={percent} className="mt-1 h-2" />
      <span className="text-[11px] tabular-nums text-muted-foreground/70">
        {daysLoaded > 0 ? copy.progress(daysLoaded, daysTotal) : copy.waiting}
      </span>
    </section>
  );
}
