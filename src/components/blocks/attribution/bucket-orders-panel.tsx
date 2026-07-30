"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { useTRPC } from "@/lib/trpc/client";
import { bucketColor } from "./buckets";
import { bucketLabels, orders as copy, page } from "./copy";
import { formatClock, formatDay, formatMoney } from "./format";

const PAGE_SIZE = 25;

type PanelProps = {
  bucket: AttributionBucket;
  dateFrom: string;
  dateTo: string;
  currency: string;
  timeZone: string;
  onClose: () => void;
};

/**
 * The bucket click-through: an inline list under the waterfall, one child query
 * per cursor page so "show more" never has to merge pages by hand.
 */
export function BucketOrdersPanel({
  bucket,
  dateFrom,
  dateTo,
  currency,
  timeZone,
  onClose,
}: PanelProps) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);

  const key = `${bucket}:${dateFrom}:${dateTo}`;

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: bucketColor(bucket) }}
          />
          <span className="truncate">{copy.titleFor(bucket)}</span>
          <span className="shrink-0 text-muted-foreground/60">
            {formatDay(dateFrom)}
            {dateFrom === dateTo ? "" : ` – ${formatDay(dateTo)}`}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[12px]"
          onClick={onClose}
          aria-label={copy.close}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_92px_92px_minmax(0,1.1fr)_minmax(0,1.1fr)] gap-3 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/50">
        <span>{copy.columns.order}</span>
        <span>{copy.columns.when}</span>
        <span className="text-right">{copy.columns.sales}</span>
        <span>{copy.columns.cameFrom}</span>
        <span>{copy.columns.tags}</span>
      </div>

      {cursors.map((cursor, index) => (
        <OrdersPage
          key={`${key}:${cursor ?? "first"}`}
          bucket={bucket}
          dateFrom={dateFrom}
          dateTo={dateTo}
          cursor={cursor}
          currency={currency}
          timeZone={timeZone}
          isFirst={index === 0}
          isLast={index === cursors.length - 1}
          onMore={(next) => setCursors((current) => [...current, next])}
        />
      ))}
    </div>
  );
}

function OrdersPage({
  bucket,
  dateFrom,
  dateTo,
  cursor,
  currency,
  timeZone,
  isFirst,
  isLast,
  onMore,
}: {
  bucket: AttributionBucket;
  dateFrom: string;
  dateTo: string;
  cursor: string | null;
  currency: string;
  timeZone: string;
  isFirst: boolean;
  isLast: boolean;
  onMore: (cursor: string) => void;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.attribution.bucketOrders.queryOptions({
      bucket,
      dateFrom,
      dateTo,
      cursor,
      limit: PAGE_SIZE,
    }),
  );

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2 px-3 py-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground/60">
        {copy.empty}
      </p>
    );
  }

  const rows = query.data?.orders ?? [];

  if (rows.length === 0 && isFirst) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground/60">
        {copy.empty}
      </p>
    );
  }

  const nextCursor = query.data?.nextCursor ?? null;

  return (
    <>
      {rows.map((row) => {
        const tags = [
          row.lastClickUtmSource,
          row.lastClickUtmMedium,
          row.lastClickUtmCampaign,
        ]
          .filter((part): part is string => !!part && part.length > 0)
          .join(" / ");

        return (
          <div
            key={row.id}
            className="grid grid-cols-[minmax(0,1fr)_92px_92px_minmax(0,1.1fr)_minmax(0,1.1fr)] items-center gap-3 border-b border-border/50 px-3 py-2 text-[12px] last:border-0"
          >
            <span className="truncate tabular-nums">
              {orderNumber(row.shopifyOrderId)}
            </span>
            <span className="tabular-nums text-muted-foreground/80">
              {formatDay(row.orderDay)}
              {" · "}
              {formatClock(row.orderCreatedAt, timeZone) ?? ""}
            </span>
            <span className="text-right font-medium tabular-nums">
              {formatMoney(row.netSales, currency) ?? page.noDataYet}
            </span>
            <span className="truncate text-muted-foreground/80">
              {row.verificationPending
                ? copy.tooNew
                : row.metaVerified
                  ? copy.matchedMeta
                  : (row.orderSourceName ?? bucketLabels[bucket])}
            </span>
            <span className="truncate text-muted-foreground/70">
              {tags.length > 0 ? tags : copy.noTags}
            </span>
          </div>
        );
      })}

      {isLast && nextCursor ? (
        <div className="px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-[12px]"
            onClick={() => onMore(nextCursor)}
          >
            {copy.more}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** `gid://shopify/Order/123` and bare ids both read as `#123`. */
function orderNumber(shopifyOrderId: string): string {
  const tail = shopifyOrderId.split("/").pop() ?? shopifyOrderId;
  return `#${tail}`;
}
