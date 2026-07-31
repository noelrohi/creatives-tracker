"use client";

import { howWeCount as copy } from "./copy";

/**
 * The glossary, as the body of the "How we count" fold. The collapsible that
 * used to wrap it is gone: the fold row above is the disclosure now.
 */
export function HowWeCountList({ timeZone }: { timeZone: string }) {
  return (
    <dl className="flex flex-col gap-2.5 rounded-sm border border-border bg-muted/20 p-3">
      {copy.entries(timeZone).map((entry) => (
        <div key={entry.term} className="flex flex-col gap-0.5">
          <dt className="text-[12px] font-semibold">{entry.term}</dt>
          <dd className="text-[12px] leading-relaxed text-muted-foreground">
            {entry.body}
          </dd>
        </div>
      ))}
    </dl>
  );
}
