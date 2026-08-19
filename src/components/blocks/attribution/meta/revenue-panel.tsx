"use client";

import { useQuery } from "@tanstack/react-query";
import { CampaignTable } from "@/components/blocks/attribution/campaign-table";
import { bucketColor } from "@/components/blocks/attribution/colors";
import {
  campaigns as campaignCopy,
  metaCheck as copy,
} from "@/components/blocks/attribution/copy";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { MetaCheckDetail } from "@/components/blocks/attribution/meta-check-card";
import { Button } from "@/components/ui/button";
import { toCents } from "@/lib/money";
import { useTRPC } from "@/lib/trpc/client";

/** Width helper for the share bar; ratio of cents, display-only. */
function widthPercent(partCents: number, totalCents: number): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  return Math.min(100, Math.max(0, (partCents / totalCents) * 100));
}

/**
 * The Meta drawer's reading: the same `metaCheck` figures and campaign ledger
 * the two folds used to show, under one panel. Visible to every role — there
 * is no privileged data here, unlike the Google and Klaviyo panels. The
 * queries duplicate the page's own `metaCheck`/`campaignLedger` calls by
 * design: React Query dedupes on the key, so opening the drawer costs nothing.
 */
export function MetaRevenuePanel({
  dateFrom,
  dateTo,
  currency,
  metaDown,
  detailHref,
  shopifyTotal,
}: {
  dateFrom: string;
  dateTo: string;
  currency: string;
  metaDown: boolean;
  detailHref: string;
  shopifyTotal: string | null;
}) {
  const trpc = useTRPC();
  const metaCheck = useQuery(
    trpc.attribution.metaCheck.queryOptions({ dateFrom, dateTo }),
  );
  const campaigns = useQuery(
    trpc.attribution.campaignLedger.queryOptions({ dateFrom, dateTo }),
  );

  const confirmedCents = metaCheck.data
    ? toCents(metaCheck.data.verifiedRevenue)
    : 0;
  const totalCents = shopifyTotal !== null ? toCents(shopifyTotal) : 0;
  const confirmedWidth = widthPercent(confirmedCents, totalCents);
  const confirmedMoney = metaCheck.data
    ? formatMoneyExact(metaCheck.data.verifiedRevenue, currency)
    : null;

  const hasError = metaCheck.isError || campaigns.isError;
  const handleRetry = () => {
    if (metaCheck.isError) void metaCheck.refetch();
    if (campaigns.isError) void campaigns.refetch();
  };

  return (
    <section className="rounded-md border border-border bg-card px-3 py-3 sm:px-4">
      <h2 className="mb-2.5 text-[13px] font-semibold tracking-tight">
        {copy.title}
      </h2>
      {hasError ? (
        <p className="text-[11px] text-muted-foreground">
          {copy.error}{" "}
          <Button size="sm" variant="ghost" onClick={handleRetry}>
            {copy.retry}
          </Button>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <MetaCheckDetail
            data={metaCheck.data}
            loading={metaCheck.isPending}
            metaDown={metaDown}
            currency={currency}
            detailHref={detailHref}
          />
          {metaCheck.data && shopifyTotal !== null ? (
            <div>
              <div
                className="flex h-5 overflow-hidden rounded"
                data-testid="meta-confirmed-share"
              >
                <div
                  style={{
                    width: `${confirmedWidth}%`,
                    backgroundColor: bucketColor("meta"),
                  }}
                />
                <div className="flex-1 bg-muted" />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
                <span>
                  <span
                    className="mr-1 inline-block size-2 rounded-[2px]"
                    style={{ backgroundColor: bucketColor("meta") }}
                  />
                  {copy.weConfirmLabel} {confirmedMoney}
                </span>
              </div>
            </div>
          ) : null}
          <div>
            <h3 className="mb-1.5 text-[12px] font-semibold">
              {campaignCopy.title}
            </h3>
            <CampaignTable
              data={campaigns.data}
              loading={campaigns.isPending}
              metaDown={metaDown}
              currency={currency}
            />
          </div>
        </div>
      )}
    </section>
  );
}
