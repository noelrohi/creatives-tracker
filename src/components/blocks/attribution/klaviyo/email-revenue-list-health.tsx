"use client";

import Link from "next/link";
import type { ListHealthSummary } from "@/lib/klaviyo/list-health";
import { listHealth as copy } from "./copy";

function labUrl(range: { dateFrom: string; dateTo: string }): string {
  const search = new URLSearchParams({
    range: "custom",
    from: range.dateFrom,
    to: range.dateTo,
    view: "list-health",
  });
  return `/attribution/klaviyo?${search.toString()}`;
}

/** Hidden entirely when undiscovered or fully quiet — never an empty strip. */
export function EmailRevenueListHealth({
  summary,
  dateFrom,
  dateTo,
}: {
  summary: ListHealthSummary;
  dateFrom: string;
  dateTo: string;
}) {
  const { totals } = summary;
  const hasAny =
    totals.subscribed !== 0 ||
    totals.unsubscribed !== 0 ||
    totals.wonBack !== 0 ||
    totals.quickChurn !== 0;
  if (!summary.discovered || !hasAny) return null;
  const label = `${copy.subscribed(totals.subscribed)} · ${copy.unsubscribed(totals.unsubscribed)} · ${copy.wonBack(totals.wonBack)} · ${copy.quickChurn(totals.quickChurn)} · ${copy.net(totals.net)}`;
  return (
    <div
      className="mt-3 rounded-md border border-dashed border-emerald-600/40 bg-emerald-600/5 px-3 py-2 text-[11px]"
      data-testid="list-health-strip"
    >
      <span className="font-medium">{copy.stripLead}</span> {label}{" "}
      <Link
        aria-label={`${copy.stripLead} ${label}`}
        className="text-muted-foreground underline-offset-2 hover:underline"
        data-testid="list-health-strip-href"
        href={labUrl({ dateFrom, dateTo })}
      >
        ▸
      </Link>
    </div>
  );
}
