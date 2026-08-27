"use client";

import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toCents } from "@/lib/money";
import { useTRPC } from "@/lib/trpc/client";
import { page, shopifySummary as copy } from "./copy";
import { formatMoneyExact } from "./format";

const chartConfig: ChartConfig = {
  net: { label: "Total sales", color: "var(--chart-1)" },
};

function Card({
  label,
  value,
  caption,
  tone,
  loading,
}: {
  label: string;
  value: string | null;
  caption?: string | null;
  tone?: "refund";
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card px-3 py-2.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/55">
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-[20px] w-16" />
      ) : value === null ? (
        <span className="inline-flex w-fit items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground/80">
          {page.noDataYet}
        </span>
      ) : (
        <span
          className="text-[20px] font-semibold tabular-nums leading-none tracking-tight"
          style={tone === "refund" ? { color: "var(--attr-warning)" } : undefined}
        >
          {value}
        </span>
      )}
      {caption ? (
        <span className="text-[10px] text-muted-foreground/60">{caption}</span>
      ) : null}
    </div>
  );
}

/**
 * The store's own reading of the range, Shopify-style, above the attribution
 * ledger: what came in, in how many orders, at what average, less what went
 * back — and the curve of it. Sales and order counts arrive from the page's
 * `overview` query so the cards can never disagree with the ledger below.
 */
export function ShopifySummary({
  dateFrom,
  dateTo,
  currency,
  total,
  orderCount,
  loading,
}: {
  dateFrom: string;
  dateTo: string;
  currency: string;
  total: string | null;
  orderCount: number;
  loading: boolean;
}) {
  const trpc = useTRPC();
  const singleDay = dateFrom === dateTo;

  const refunds = useQuery(
    trpc.attribution.refundsTotal.queryOptions({ dateFrom, dateTo }),
  );
  const dailySeries = useQuery({
    ...trpc.attribution.dailySeries.queryOptions({ dateFrom, dateTo }),
    enabled: !singleDay,
  });
  const hourlySeries = useQuery({
    ...trpc.attribution.hourlySeries.queryOptions({ day: dateFrom }),
    enabled: singleDay,
  });

  const totalCents = total !== null ? toCents(total) : null;
  const averageOrder =
    totalCents !== null && orderCount > 0
      ? formatMoneyExact((totalCents / orderCount / 100).toFixed(2), currency)
      : null;

  const series = singleDay ? hourlySeries : dailySeries;
  const chartData = singleDay
    ? (hourlySeries.data?.hours ?? []).map((row) => ({
        label: `${String(row.hour).padStart(2, "0")}:00`,
        net: toCents(row.net) / 100,
      }))
    : (dailySeries.data?.days ?? []).map((row) => ({
        label: row.day.slice(5).replace("-", "/"),
        net: toCents(row.totalNet) / 100,
      }));

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[74px] w-full rounded-md" />
          ))
        ) : (
          <>
            <Card
              label={copy.totalSales}
              value={total !== null ? formatMoneyExact(total, currency) : null}
            />
            <Card
              label={copy.orders}
              value={String(orderCount)}
            />
            <Card label={copy.averageOrder} value={averageOrder} />
            <Card
              label={copy.refunds}
              value={
                refunds.data ? formatMoneyExact(refunds.data.total, currency) : null
              }
              caption={refunds.data ? copy.refundCount(refunds.data.count) : null}
              tone={
                refunds.data && refunds.data.count > 0 ? "refund" : undefined
              }
              loading={refunds.isPending}
            />
          </>
        )}
      </div>

      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
          {copy.chartTitle}
        </span>
        {series.isPending || loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : series.isError ? (
          <p className="py-8 text-center text-[11px] text-muted-foreground">
            {copy.error}{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void series.refetch();
                void refunds.refetch();
              }}
            >
              {copy.retry}
            </Button>
          </p>
        ) : (
          <div data-testid="shopify-sales-chart" className="mt-1">
            <ChartContainer config={chartConfig} className="aspect-[5/1] w-full">
              <AreaChart
                data={chartData}
                margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="fill-shopify-net" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-net)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--color-net)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={60}
                  tickFormatter={(value) =>
                    formatMoneyExact(Number(value).toFixed(2), currency) ?? ""
                  }
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(value, name) => {
                        const label =
                          chartConfig[name as keyof typeof chartConfig]?.label ??
                          name;
                        const num = typeof value === "number" ? value : Number(value);
                        const formatted =
                          formatMoneyExact(num.toFixed(2), currency) ?? "";
                        return (
                          <div className="flex flex-1 items-center justify-between gap-2">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatted}
                            </span>
                          </div>
                        );
                      }}
                    />
                  }
                />
                <Area
                  type="monotone"
                  dataKey="net"
                  stroke="var(--color-net)"
                  strokeWidth={2}
                  fill="url(#fill-shopify-net)"
                />
              </AreaChart>
            </ChartContainer>
          </div>
        )}
      </div>
    </div>
  );
}
