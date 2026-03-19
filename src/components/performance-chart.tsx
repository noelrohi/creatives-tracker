"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

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
    const sorted = [...logs].sort(
      (a, b) => new Date(a.dateStart).getTime() - new Date(b.dateStart).getTime(),
    );
    return sorted.map((log) => ({
      date: log.dateStart,
      spend: log.spend ? Number(log.spend) : 0,
      roas: log.roas ? Number(log.roas) : 0,
      cpa: log.cpa ? Number(log.cpa) : 0,
      ctr: log.ctr ? Number(log.ctr) : 0,
      conversions: log.conversions ?? 0,
      impressions: log.impressions ?? 0,
      reach: log.reach ?? 0,
      cpm: log.cpm ? Number(log.cpm) : 0,
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
              tickFormatter={(v) => {
                const d = new Date(v);
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
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
              tickFormatter={(v) => {
                const d = new Date(v);
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
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
