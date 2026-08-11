"use client";

import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { emailRevenue as copy } from "./copy";

function percentOf(part: string, total: string): string {
  const totalNumber = Number(total);
  if (!Number.isFinite(totalNumber) || totalNumber <= 0) return "0%";
  return `${Math.round((Number(part) / totalNumber) * 100)}%`;
}

/** Width helper for the share bar; display-only, never money math. */
function widthPercent(part: string, total: string): number {
  const totalNumber = Number(total);
  if (!Number.isFinite(totalNumber) || totalNumber <= 0) return 0;
  return Math.min(100, Math.max(0, (Number(part) / totalNumber) * 100));
}

export function EmailRevenueHeadline({
  summary,
  shopifyTotal,
  currency,
}: {
  summary: EmailAttributionSummary;
  shopifyTotal: string;
  currency: string;
}) {
  const { email, klaviyoSays } = summary;
  const delta =
    klaviyoSays === null
      ? null
      : Number(klaviyoSays.conversionValue) - Number(email.revenue);
  const campaignsWidth = widthPercent(email.campaignsRevenue, shopifyTotal);
  const flowsWidth = widthPercent(email.flowsRevenue, shopifyTotal);
  const restRevenue = Math.max(0, Number(shopifyTotal) - Number(email.revenue));
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
              {delta !== null && delta > 0 ? (
                <span
                  className="ml-1 text-amber-600"
                  data-testid="klaviyo-says-delta"
                >
                  ·{" "}
                  {copy.saysUnconfirmed(
                    formatMoneyExact(delta, currency) ?? "0.00",
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
          {copy.segRest(formatMoneyExact(restRevenue, currency) ?? "0.00")}
        </span>
      </div>
    </div>
  );
}
