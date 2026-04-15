"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDateOnly, parseDateOnly } from "@/lib/date";

interface DailyLog {
  dateStart: string;
  spend: string | null;
  purchaseValue?: string | null;
}

const chartConfig: ChartConfig = {
  revenue: { label: "Revenue", color: "hsl(160, 84%, 39%)" },
  spend: { label: "Spend", color: "hsl(262, 83%, 58%)" },
  mer: { label: "MER", color: "hsl(38, 92%, 50%)" },
};

export function RevenueSpendChart({ logs, className = "aspect-[5/2]" }: { logs: DailyLog[]; className?: string }) {
  const data = useMemo(() => {
    const byDate = new Map<string, { date: string; revenue: number; spend: number; mer: number | null }>();
    for (const log of logs) {
      const bucket = byDate.get(log.dateStart) ?? { date: log.dateStart, revenue: 0, spend: 0, mer: null };
      bucket.spend += log.spend ? Number(log.spend) : 0;
      bucket.revenue += log.purchaseValue ? Number(log.purchaseValue) : 0;
      byDate.set(log.dateStart, bucket);
    }
    const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const row of sorted) {
      row.mer = row.spend > 0 ? row.revenue / row.spend : null;
    }
    return sorted;
  }, [logs]);

  if (data.length < 2) return null;

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => formatDateOnly(parseDateOnly(String(value))).slice(5).replace("-", "/")}
        />
        <YAxis
          yAxisId="dollars"
          tickLine={false}
          axisLine={false}
          width={60}
          tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
        />
        <YAxis
          yAxisId="mer"
          orientation="right"
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={(v) => `${Number(v).toFixed(1)}x`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              formatter={(value, name) => {
                const label = chartConfig[name as keyof typeof chartConfig]?.label ?? name;
                const num = typeof value === "number" ? value : Number(value);
                const formatted =
                  name === "mer"
                    ? `${num.toFixed(2)}x`
                    : `$${num.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
                return (
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono font-medium tabular-nums text-foreground">{formatted}</span>
                  </div>
                );
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Line yAxisId="dollars" type="monotone" dataKey="revenue" stroke="var(--color-revenue)" strokeWidth={2} dot={false} />
        <Line yAxisId="dollars" type="monotone" dataKey="spend" stroke="var(--color-spend)" strokeWidth={2} dot={false} />
        <Line
          yAxisId="mer"
          type="monotone"
          dataKey="mer"
          stroke="var(--color-mer)"
          strokeWidth={2}
          strokeDasharray="4 4"
          dot={false}
          connectNulls
        />
      </LineChart>
    </ChartContainer>
  );
}
