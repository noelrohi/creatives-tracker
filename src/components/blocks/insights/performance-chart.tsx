"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDateOnly, parseDateOnly } from "@/lib/date";

type MetricKey = "spend" | "roas" | "cpa" | "ctr" | "conversions" | "impressions" | "reach" | "cpm";

const METRICS: { key: MetricKey; label: string; color: string }[] = [
  { key: "spend", label: "Spend", color: "hsl(262, 83%, 58%)" },
  { key: "roas", label: "ROAS", color: "hsl(160, 84%, 39%)" },
  { key: "cpa", label: "CPA", color: "hsl(38, 92%, 50%)" },
  { key: "conversions", label: "Conversions", color: "hsl(217, 91%, 60%)" },
  { key: "ctr", label: "CTR", color: "hsl(330, 81%, 60%)" },
  { key: "impressions", label: "Impressions", color: "hsl(239, 84%, 67%)" },
  { key: "reach", label: "Reach", color: "hsl(172, 66%, 50%)" },
  { key: "cpm", label: "CPM", color: "hsl(24, 95%, 53%)" },
];

interface PerformanceLog {
  dateStart: string;
  dateEnd: string;
  spend: string | null;
  roas: string | null;
  cpa: string | null;
  ctr: string | null;
  purchaseValue?: string | null;
  conversions: number | null;
  impressions: number | null;
  reach: number | null;
  cpm: string | null;
  [key: string]: unknown;
}

interface PerformanceChartProps {
  logs: PerformanceLog[];
  compact?: boolean;
}

export function PerformanceChart({ logs, compact }: PerformanceChartProps) {
  const [activeMetric, setActiveMetric] = useState<MetricKey>("spend");

  const chartData = useMemo(() => {
    const byDate = new Map<string, {
      date: string;
      spend: number;
      purchaseValue: number;
      conversions: number;
      impressions: number;
      reach: number;
      weightedCtrNumerator: number;
    }>();

    for (const log of logs) {
      const key = log.dateStart;
      const bucket = byDate.get(key) ?? {
        date: key,
        spend: 0,
        purchaseValue: 0,
        conversions: 0,
        impressions: 0,
        reach: 0,
        weightedCtrNumerator: 0,
      };
      const spend = log.spend ? Number(log.spend) : 0;
      const purchaseValue = log.purchaseValue ? Number(log.purchaseValue) : 0;
      const conversions = log.conversions ?? 0;
      const impressions = log.impressions ?? 0;
      const reach = log.reach ?? 0;
      const ctr = log.ctr ? Number(log.ctr) : 0;

      bucket.spend += spend;
      bucket.purchaseValue += purchaseValue;
      bucket.conversions += conversions;
      bucket.impressions += impressions;
      bucket.reach += reach;
      bucket.weightedCtrNumerator += ctr * impressions;
      byDate.set(key, bucket);
    }

    return [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((bucket) => ({
        date: bucket.date,
        spend: bucket.spend,
        roas: bucket.spend > 0 ? bucket.purchaseValue / bucket.spend : 0,
        cpa: bucket.conversions > 0 ? bucket.spend / bucket.conversions : 0,
        ctr: bucket.impressions > 0 ? bucket.weightedCtrNumerator / bucket.impressions : 0,
        conversions: bucket.conversions,
        impressions: bucket.impressions,
        reach: bucket.reach,
        cpm: bucket.impressions > 0 ? (bucket.spend / bucket.impressions) * 1000 : 0,
      }));
  }, [logs]);

  const availableMetrics = METRICS.filter((m) =>
    chartData.some((d) => (d[m.key] as number) > 0),
  );

  if (chartData.length === 0 || availableMetrics.length === 0) return null;

  const metric = METRICS.find((m) => m.key === activeMetric) ?? availableMetrics[0];

  const chartConfig: ChartConfig = {
    [metric.key]: { label: metric.label, color: metric.color },
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        {availableMetrics.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setActiveMetric(m.key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              activeMetric === m.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted/60 text-muted-foreground hover:bg-muted"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <ChartContainer
        config={chartConfig}
        className={compact ? "aspect-[3/1]" : "aspect-[5/2]"}
      >
        {chartData.length <= 3 ? (
          <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => formatDateOnly(parseDateOnly(String(value))).slice(5).replace("-", "/")}
            />
            <YAxis tickLine={false} axisLine={false} width={50} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey={metric.key}
              fill={`var(--color-${metric.key})`}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        ) : (
          <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`fill-${metric.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${metric.key})`} stopOpacity={0.3} />
                <stop offset="100%" stopColor={`var(--color-${metric.key})`} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => formatDateOnly(parseDateOnly(String(value))).slice(5).replace("-", "/")}
            />
            <YAxis tickLine={false} axisLine={false} width={50} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Area
              type="monotone"
              dataKey={metric.key}
              stroke={`var(--color-${metric.key})`}
              strokeWidth={2}
              fill={`url(#fill-${metric.key})`}
            />
          </AreaChart>
        )}
      </ChartContainer>
    </div>
  );
}
