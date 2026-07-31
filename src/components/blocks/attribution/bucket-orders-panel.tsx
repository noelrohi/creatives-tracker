"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useTransition } from "react";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import { bucketColor } from "./buckets";
import { bucketLabels, orders as copy, page } from "./copy";
import { formatClock, formatDay, formatMoney } from "./format";
import { orderAdminUrl } from "./shopify-links";

const PAGE_SIZE = 25;

type PanelProps = {
  bucket: AttributionBucket;
  dateFrom: string;
  dateTo: string;
  currency: string;
  timeZone: string;
  shopDomain: string | null;
  onClose: () => void;
};

/**
 * The bucket click-through: an inline list under the channel row, one child query
 * per cursor page so "show more" never has to merge pages by hand.
 */
export function BucketOrdersPanel({
  bucket,
  dateFrom,
  dateTo,
  currency,
  timeZone,
  shopDomain,
  onClose,
}: PanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [downloading, startDownload] = useTransition();

  const key = `${bucket}:${dateFrom}:${dateTo}`;

  const downloadCsv = () => {
    startDownload(async () => {
      const allRows: BucketOrder[] = [];
      let cursor: string | null = null;

      do {
        const pageData: BucketOrdersOutput = await queryClient.fetchQuery(
          trpc.attribution.bucketOrders.queryOptions({
            bucket,
            dateFrom,
            dateTo,
            cursor,
            limit: Math.min(100, 5_000 - allRows.length),
          }),
        );
        allRows.push(...pageData.orders);
        cursor = pageData.nextCursor;
      } while (cursor && allRows.length < 5_000);

      const csv = [
        copy.csvColumns,
        ...allRows.map((row) => csvRow(row, bucket, timeZone)),
      ]
        .map((row) => row.map(csvField).join(","))
        .join("\n");
      const url = URL.createObjectURL(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `orders-${bucket}-${dateFrom}-${dateTo}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    });
  };

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
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px]"
            onClick={downloadCsv}
            disabled={downloading}
          >
            {copy.download}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px]"
            onClick={onClose}
            aria-label={copy.close}
          >
            <X className="size-3.5" />
          </Button>
        </div>
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
          shopDomain={shopDomain}
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
  shopDomain,
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
  shopDomain: string | null;
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
        const tags = orderTags(row);

        return (
          <div
            key={row.id}
            className="grid grid-cols-[minmax(0,1fr)_92px_92px_minmax(0,1.1fr)_minmax(0,1.1fr)] items-center gap-3 border-b border-border/50 px-3 py-2 text-[12px] last:border-0"
          >
            <OrderLink
              orderName={row.orderName}
              shopifyOrderId={row.shopifyOrderId}
              shopDomain={shopDomain}
            />
            <span className="tabular-nums text-muted-foreground/80">
              {formatDay(row.orderDay)}
              {" · "}
              {formatClock(row.orderCreatedAt, timeZone) ?? ""}
            </span>
            <span className="text-right font-medium tabular-nums">
              {formatMoney(row.netSales, currency) ?? page.noDataYet}
            </span>
            <span className="truncate text-muted-foreground/80">
              {orderSource(row, bucket)}
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

type BucketOrdersOutput =
  RouterOutputs["attribution"]["bucketOrders"];
type BucketOrder = BucketOrdersOutput["orders"][number];

function orderNumber(
  orderName: string | null,
  shopifyOrderId: string,
): string {
  const tail = shopifyOrderId.split("/").pop() ?? shopifyOrderId;
  return orderName ?? `#${tail}`;
}

function orderSource(row: BucketOrder, bucket: AttributionBucket): string {
  if (row.verificationPending) return copy.tooNew;
  if (row.metaVerified) return copy.matchedMeta;
  return row.orderSourceName ?? bucketLabels[bucket];
}

function orderTags(row: BucketOrder): string {
  return [
    row.lastClickUtmSource,
    row.lastClickUtmMedium,
    row.lastClickUtmCampaign,
  ]
    .filter((part): part is string => !!part && part.length > 0)
    .join(" / ");
}

function csvRow(
  row: BucketOrder,
  bucket: AttributionBucket,
  timeZone: string,
): string[] {
  return [
    orderNumber(row.orderName, row.shopifyOrderId),
    row.orderDay,
    formatClock(row.orderCreatedAt, timeZone) ?? "",
    row.netSales,
    orderSource(row, bucket),
    orderTags(row),
  ];
}

function csvField(value: string): string {
  return /[,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function OrderLink({
  orderName,
  shopifyOrderId,
  shopDomain,
}: {
  orderName: string | null;
  shopifyOrderId: string;
  shopDomain: string | null;
}) {
  const label = orderNumber(orderName, shopifyOrderId);
  const href = orderAdminUrl({ shopDomain, shopifyOrderId });
  if (!href) return <span className="truncate tabular-nums">{label}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="truncate tabular-nums hover:underline"
    >
      {label}
    </a>
  );
}
