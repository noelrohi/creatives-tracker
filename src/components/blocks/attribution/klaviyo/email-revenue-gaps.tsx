"use client";

import Link from "next/link";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { emailRevenue as copy } from "./copy";

function labUrl(
  params: Record<string, string>,
  range: { dateFrom: string; dateTo: string },
): string {
  const search = new URLSearchParams({
    range: "custom",
    from: range.dateFrom,
    to: range.dateTo,
    ...params,
  });
  return `/attribution/klaviyo?${search.toString()}`;
}

export function EmailRevenueGaps({
  summary,
  currency,
  dateFrom,
  dateTo,
}: {
  summary: EmailAttributionSummary;
  currency: string;
  dateFrom: string;
  dateTo: string;
}) {
  const range = { dateFrom, dateTo };
  const { gaps } = summary;
  const entries: Array<{
    key: string;
    text: string;
    revenue: string | null;
    href: string;
  }> = [
    {
      key: "no-email-link",
      text: copy.gapNoEmailLink(gaps.noEmailLink.orders),
      revenue: gaps.noEmailLink.revenue,
      href: labUrl(
        { view: "orders", orderStatus: "confirmed", claimType: "none" },
        range,
      ),
    },
    {
      key: "not-evaluated",
      text: copy.gapNotEvaluated(gaps.notEvaluated.orders),
      revenue: gaps.notEvaluated.revenue,
      href: labUrl({ view: "orders", orderStatus: "not_evaluated" }, range),
    },
    {
      key: "no-event",
      text: copy.gapNoEvent(gaps.noKlaviyoEvent.orders),
      revenue: gaps.noKlaviyoEvent.revenue,
      href: labUrl({ view: "orders", orderStatus: "no_klaviyo_event" }, range),
    },
    {
      key: "duplicates",
      text: copy.gapDuplicates(gaps.duplicateFlagged.orders),
      revenue: gaps.duplicateFlagged.revenue,
      href: labUrl(
        { view: "orders", orderStatus: "duplicate_conversion_events" },
        range,
      ),
    },
    {
      key: "unmatched",
      text: copy.gapUnmatched(gaps.unmatchedEvents),
      revenue: null,
      href: labUrl({ view: "unmatched" }, range),
    },
  ];
  return (
    <div className="mt-3 rounded-md border border-dashed border-amber-600/40 bg-amber-600/5 px-3 py-2 text-[11px]">
      <span className="font-medium">{copy.gapsLead}</span>{" "}
      {entries.map((entry, index) => (
        <span key={entry.key} data-testid={`gap-${entry.key}`}>
          {index > 0 ? " · " : " "}
          {entry.revenue !== null
            ? `${formatMoneyExact(entry.revenue, currency)} · `
            : ""}
          {entry.text}{" "}
          <Link
            className="text-muted-foreground underline-offset-2 hover:underline"
            data-testid={`gap-${entry.key}-href`}
            href={entry.href}
          >
            ▸
          </Link>
        </span>
      ))}
    </div>
  );
}
