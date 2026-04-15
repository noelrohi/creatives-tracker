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
};

export function RevenueSpendChart({ logs, className = "aspect-[5/2]" }: { logs: DailyLog[]; className?: string }) {
  const data = useMemo(() => {
    const byDate = new Map<string, { date: string; revenue: number; spend: number }>();
    for (const log of logs) {
      const bucket = byDate.get(log.dateStart) ?? { date: log.dateStart, revenue: 0, spend: 0 };
      bucket.spend += log.spend ? Number(log.spend) : 0;
      bucket.revenue += log.purchaseValue ? Number(log.purchaseValue) : 0;
      byDate.set(log.dateStart, bucket);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
        <YAxis tickLine={false} axisLine={false} width={60} tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line type="monotone" dataKey="revenue" stroke="var(--color-revenue)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="spend" stroke="var(--color-spend)" strokeWidth={2} dot={false} />
      </LineChart>
    </ChartContainer>
  );
}
