"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDateOnly, parseDateOnly } from "@/lib/date";
import { fmtMoney, fmtNum, fmtPct, fmtRoas } from "@/lib/fmt";
import {
  aggregateDailyLogs,
  METRICS,
  type MetricKey,
  type PerformanceLog,
} from "./performance-chart";

/** How each metric prints in the tooltip — the axis itself is unitless. */
const METRIC_FORMAT: Record<MetricKey, (value: number) => string> = {
  spend: (v) => fmtMoney(v),
  roas: (v) => fmtRoas(v),
  cpa: (v) => fmtMoney(v),
  ctr: (v) => fmtPct(v),
  conversions: (v) => fmtNum(v),
  impressions: (v) => fmtNum(v),
  reach: (v) => fmtNum(v),
  cpm: (v) => fmtMoney(v),
};

/**
 * Every metric on one canvas. Dollars, ratios, and raw counts live on wildly
 * different scales, so each series is min–max normalized to 0–100 for drawing
 * — the shape and timing of each line is the information — while the tooltip
 * reads back the real values. Chips toggle series in and out.
 */
export function CombinedPerformanceChart({ logs }: { logs: PerformanceLog[] }) {
  const [hidden, setHidden] = useState<ReadonlySet<MetricKey>>(new Set());

  const { data, available } = useMemo(() => {
    const rows = aggregateDailyLogs(logs);
    const available = METRICS.filter((m) =>
      rows.some((row) => row[m.key] > 0),
    );
    const ranges = new Map(
      available.map((m) => {
        const values = rows.map((row) => row[m.key]);
        return [m.key, { min: Math.min(...values), max: Math.max(...values) }];
      }),
    );
    const data = rows.map((row) => {
      const normalized: Record<string, number | string> = { ...row };
      for (const m of available) {
        const range = ranges.get(m.key);
        const span = range ? range.max - range.min : 0;
        normalized[`${m.key}Norm`] =
          range && span > 0 ? ((row[m.key] - range.min) / span) * 100 : 50;
      }
      return normalized;
    });
    return { data, available };
  }, [logs]);

  if (data.length === 0 || available.length === 0) return null;

  const shown = available.filter((m) => !hidden.has(m.key));
  const chartConfig: ChartConfig = Object.fromEntries(
    available.map((m) => [m.key, { label: m.label, color: m.color }]),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        {available.map((m) => {
          const isShown = !hidden.has(m.key);
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={isShown}
              onClick={() =>
                setHidden((previous) => {
                  const next = new Set(previous);
                  if (next.has(m.key)) next.delete(m.key);
                  else next.add(m.key);
                  return next;
                })
              }
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                isShown
                  ? "bg-muted/60 text-foreground hover:bg-muted"
                  : "bg-transparent text-muted-foreground/50 hover:bg-muted/40"
              }`}
            >
              <span
                className="size-2 rounded-[2px]"
                style={{
                  backgroundColor: isShown ? m.color : "var(--border)",
                }}
              />
              {m.label}
            </button>
          );
        })}
      </div>

      <ChartContainer config={chartConfig} className="aspect-[5/2]">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) =>
              formatDateOnly(parseDateOnly(String(value))).slice(5).replace("-", "/")
            }
          />
          <YAxis hide domain={[0, 100]} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                formatter={(value, name, item) => {
                  const key = String(name) as MetricKey;
                  const metric = METRICS.find((m) => m.key === key);
                  const raw = (item?.payload as Record<string, number>)?.[key];
                  return (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span
                          className="size-2 rounded-[2px]"
                          style={{ backgroundColor: metric?.color }}
                        />
                        {metric?.label ?? String(name)}
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {metric && typeof raw === "number"
                          ? METRIC_FORMAT[key](raw)
                          : String(value)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {shown.map((m) => (
            <Line
              key={m.key}
              type="monotone"
              dataKey={`${m.key}Norm`}
              name={m.key}
              stroke={m.color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
