"use client";

import { formatDistanceToNow } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import {
  formatDayRange,
  formatMoneyExact,
} from "@/components/blocks/attribution/format";
import { dayCount } from "@/components/blocks/attribution/days";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { useTRPC } from "@/lib/trpc/client";
import { emailRevenue as copy } from "./copy";
import { EmailRevenueGaps } from "./email-revenue-gaps";
import { centsOf } from "./email-revenue-math";
import { EmailRevenueTables } from "./email-revenue-tables";

function percentOf(part: string, total: string): string {
  const totalCents = centsOf(total);
  if (!Number.isFinite(totalCents) || totalCents <= 0) return "0%";
  return `${Math.round((centsOf(part) / totalCents) * 100)}%`;
}

/** Width helper for the share bar; ratio of cents, display-only. */
function widthPercent(part: string, total: string): number {
  const totalCents = centsOf(total);
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  return Math.min(100, Math.max(0, (centsOf(part) / totalCents) * 100));
}

export function EmailRevenueHeadline({
  summary,
  shopifyTotal,
  currency,
  dateFrom,
  dateTo,
}: {
  summary: EmailAttributionSummary;
  shopifyTotal: string;
  currency: string;
  dateFrom: string;
  dateTo: string;
}) {
  const { email, klaviyoSays } = summary;
  const deltaCents =
    klaviyoSays === null
      ? null
      : centsOf(klaviyoSays.conversionValue) - centsOf(email.revenue);
  // Report timestamps typed as Date arrive as ISO strings over the tRPC
  // wire (same reality lab-header defends against) — coerce before use.
  const saysFrom = klaviyoSays ? new Date(klaviyoSays.requestedFrom) : null;
  const saysTo = klaviyoSays ? new Date(klaviyoSays.requestedTo) : null;
  // "Klaviyo says" is their report over its own window, never re-sliced to
  // the page range. Comparing it against a shorter page range manufactures
  // a phantom "unconfirmed" gap, so the delta only renders when the page
  // range spans at least the report window.
  const saysWindowDays =
    saysFrom !== null && saysTo !== null
      ? Math.max(
          1,
          Math.round((saysTo.getTime() - saysFrom.getTime()) / 86_400_000),
        )
      : null;
  const saysWindowLabel =
    saysFrom !== null && saysTo !== null
      ? formatDayRange(
          saysFrom.toISOString().slice(0, 10),
          saysTo.toISOString().slice(0, 10),
        )
      : null;
  const showDelta =
    deltaCents !== null &&
    deltaCents > 0 &&
    saysWindowDays !== null &&
    dayCount(dateFrom, dateTo) >= saysWindowDays;
  const campaignsWidth = widthPercent(email.campaignsRevenue, shopifyTotal);
  const flowsWidth = widthPercent(email.flowsRevenue, shopifyTotal);
  const restRevenueCents = Math.max(
    0,
    centsOf(shopifyTotal) - centsOf(email.revenue),
  );
  return (
    <div>
      <div className="flex flex-wrap gap-x-7 gap-y-2">
        <div>
          <p className="text-[20px] font-semibold tabular-nums">
            {formatMoneyExact(shopifyTotal, currency)}
          </p>
          <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {copy.netSales}
          </p>
        </div>
        <div>
          <p
            className="text-[20px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-500"
            data-testid="email-linked-revenue"
          >
            {formatMoneyExact(email.revenue, currency)}
          </p>
          <p
            className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="email-linked-label"
          >
            {copy.linked(
              percentOf(email.revenue, shopifyTotal),
              email.orderCount,
            )}
          </p>
        </div>
        {klaviyoSays !== null ? (
          <div>
            <p
              className="text-[20px] font-semibold tabular-nums"
              data-testid="klaviyo-says"
            >
              {formatMoneyExact(klaviyoSays.conversionValue, currency)}
            </p>
            <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {copy.says}
              {saysWindowLabel !== null ? (
                <span className="ml-1" data-testid="klaviyo-says-window">
                  · {copy.saysWindow(saysWindowLabel)}
                </span>
              ) : null}
              {showDelta ? (
                <span
                  className="ml-1 text-amber-600"
                  data-testid="klaviyo-says-delta"
                >
                  ·{" "}
                  {copy.saysUnconfirmed(
                    formatMoneyExact((deltaCents / 100).toFixed(2), currency) ??
                      "0.00",
                  )}
                </span>
              ) : null}
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 flex h-5 overflow-hidden rounded">
        <div
          className="bg-emerald-600"
          style={{ width: `${campaignsWidth}%` }}
        />
        <div
          className="bg-emerald-600/50"
          style={{ width: `${flowsWidth}%` }}
        />
        <div className="flex-1 bg-muted" />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-2 rounded-[2px] bg-emerald-600" />
          {copy.segCampaigns(
            formatMoneyExact(email.campaignsRevenue, currency) ?? "0.00",
          )}
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-[2px] bg-emerald-600/50" />
          {copy.segFlows(
            formatMoneyExact(email.flowsRevenue, currency) ?? "0.00",
          )}
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-[2px] bg-muted" />
          {copy.segRest(
            formatMoneyExact((restRevenueCents / 100).toFixed(2), currency) ??
              "0.00",
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Privileged-only panel: hiding it is UX; `orgAdminProcedure` on the
 * queries remains the security boundary (same stance as KlaviyoLabLink).
 * NOT_FOUND means no pilot connection — the section renders nothing.
 */
export function EmailRevenuePanel({
  role,
  dateFrom,
  dateTo,
  currency,
  shopifyTotal,
}: {
  role: string | null;
  dateFrom: string;
  dateTo: string;
  currency: string;
  shopifyTotal: string | null;
}) {
  const trpc = useTRPC();
  const privileged = isPrivilegedOrgRole(
    role as Parameters<typeof isPrivilegedOrgRole>[0],
  );
  const attribution = useQuery({
    ...trpc.klaviyo.emailAttribution.queryOptions({ dateFrom, dateTo }),
    enabled: privileged,
    retry: false,
  });
  const health = useQuery({
    ...trpc.klaviyo.health.queryOptions(),
    enabled: privileged,
    retry: false,
  });

  if (!privileged) return null;
  if (attribution.error?.data?.code === "NOT_FOUND") return null;

  const connectionReady =
    health.data?.connection?.status === "ready" || health.data == null;
  const publishedAt = health.data?.connection?.lastMatchPublishedAt ?? null;

  return (
    <section className="rounded-md border border-border bg-card px-3 py-3 sm:px-4">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold tracking-tight">
          {copy.title}
        </h2>
        {publishedAt !== null ? (
          <span className="text-[10px] text-muted-foreground/70">
            {copy.freshness(
              formatDistanceToNow(new Date(publishedAt), { addSuffix: true }),
            )}
          </span>
        ) : null}
      </div>
      {attribution.isPending || shopifyTotal === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : attribution.isError ? (
        <p className="text-[11px] text-muted-foreground">
          {copy.error}{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void attribution.refetch()}
          >
            {copy.retry}
          </Button>
        </p>
      ) : !connectionReady ? (
        <p className="text-[11px] text-muted-foreground">{copy.noDataYet}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <EmailRevenueHeadline
            summary={attribution.data}
            shopifyTotal={shopifyTotal}
            currency={currency}
            dateFrom={dateFrom}
            dateTo={dateTo}
          />
          <EmailRevenueTables summary={attribution.data} currency={currency} />
          <EmailRevenueGaps
            summary={attribution.data}
            currency={currency}
            dateFrom={dateFrom}
            dateTo={dateTo}
          />
        </div>
      )}
    </section>
  );
}
