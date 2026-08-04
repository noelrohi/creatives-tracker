"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import type { EnforcedTag } from "@/lib/creative-insights-shared";
import { page, queue as copy, tagLabels } from "./insights-copy";

export type TaggingQueueRowData = {
  adId: string;
  adName: string;
  creativeId: string | null;
  adSetName: string | null;
  campaignName: string | null;
  spend: string;
  missing: EnforcedTag[];
};

const ALL_TAGS: EnforcedTag[] = ["funnelStage", "persona", "angle", "awareness"];

/**
 * Money-first ordering, straight from the query — the biggest untagged spender
 * is the next piece of work, and nothing else on this screen ranks it.
 */
export function TaggingQueueTable({
  rows,
  currency,
  loading = false,
}: {
  rows: readonly TaggingQueueRowData[];
  currency: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-7 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="px-3 py-10 text-center text-[12.5px] text-muted-foreground">
        {copy.empty}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-border text-[11px] text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">
              {copy.columns.ad}
            </th>
            <th className="px-3 py-2 text-left font-medium">
              {copy.columns.where}
            </th>
            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
              {copy.columns.spend}
            </th>
            <th className="px-3 py-2 text-left font-medium">
              {copy.columns.missing}
            </th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.adId}
              className="border-b border-border/60 last:border-b-0"
            >
              <td className="max-w-[20rem] truncate px-3 py-2 font-medium">
                {row.adName}
              </td>
              <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground">
                {[row.campaignName, row.adSetName]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ") || page.noDataYet}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                {formatMoneyExact(row.spend, currency) ?? page.noDataYet}
              </td>
              <td className="px-3 py-2">
                <span className="flex flex-wrap gap-1">
                  {ALL_TAGS.map((tag) => {
                    const missing = row.missing.includes(tag);
                    return (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium"
                        style={
                          missing
                            ? {
                                color: "var(--attr-warning)",
                                borderColor:
                                  "color-mix(in oklab, var(--attr-warning) 40%, transparent)",
                                backgroundColor: "var(--attr-warning-soft)",
                              }
                            : {
                                color: "var(--muted-foreground)",
                                borderColor: "var(--border)",
                                opacity: 0.6,
                              }
                        }
                      >
                        {tagLabels[tag]}
                      </span>
                    );
                  })}
                </span>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {row.creativeId ? (
                  <Link
                    href={`/creatives/${row.creativeId}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {copy.tagAction}
                  </Link>
                ) : (
                  <Link
                    href={`/campaigns?ad=${row.adId}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {copy.adAction}
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
