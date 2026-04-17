"use client";

import { useState } from "react";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtMoney, fmtNum, fmtRoas } from "@/lib/fmt";

type Dimension = "age" | "gender" | "country" | "device";
type Metric = "spend" | "conversions" | "roas" | "impressions";

interface DemographicRow {
  label: string;
  spend: string | null;
  conversions: string | null;
  roas: string | null;
  impressions: string | null;
}

interface DemographicBreakdownChartProps {
  data: DemographicRow[] | undefined;
  dimension: Dimension;
  onDimensionChange: (dim: Dimension) => void;
  isLoading: boolean;
}

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: "gender", label: "Gender" },
  { value: "age", label: "Age" },
  { value: "country", label: "Country" },
  { value: "device", label: "Device" },
];

const METRICS: { value: Metric; label: string; color: string }[] = [
  { value: "spend", label: "Spend", color: "hsl(262, 83%, 58%)" },
  { value: "conversions", label: "Conversions", color: "hsl(217, 91%, 60%)" },
  { value: "roas", label: "ROAS", color: "hsl(160, 84%, 39%)" },
  { value: "impressions", label: "Impressions", color: "hsl(239, 84%, 67%)" },
];

function formatMetric(value: unknown, metric: Metric) {
  if (metric === "spend") return fmtMoney(value);
  if (metric === "roas") return fmtRoas(value);
  return fmtNum(value);
}

export function DemographicBreakdownChart({
  data,
  dimension,
  onDimensionChange,
  isLoading,
}: DemographicBreakdownChartProps) {
  const [metric, setMetric] = useState<Metric>("spend");

  const chartData = (data ?? []).map((row) => ({
    label: row.label || "Unknown",
    value: parseFloat(row[metric] ?? "0") || 0,
  }));

  const activeMetric = METRICS.find((m) => m.value === metric)!;
  const chartConfig: ChartConfig = {
    value: { label: activeMetric.label, color: activeMetric.color },
  };

  const isEmpty = !isLoading && (!data || data.length === 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Select value={dimension} onValueChange={(v) => onDimensionChange(v as Dimension)}>
          <SelectTrigger className="h-7 w-auto gap-1 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIMENSIONS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-1">
          {METRICS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMetric(m.value)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                metric === m.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground/60 hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-[250px] w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      ) : isEmpty ? (
        <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground/50">No demographic data</p>
          <p className="mt-1 text-[11px] text-muted-foreground/30">
            Import breakdown-level data via CSV to see demographics
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border/50 bg-card p-4">
            <ChartContainer config={chartConfig} className="h-[250px] w-full">
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) =>
                    metric === "spend"
                      ? `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}`
                      : metric === "roas"
                        ? `${v.toFixed(1)}x`
                        : v >= 1000
                          ? `${(v / 1000).toFixed(0)}k`
                          : String(v)
                  }
                  fontSize={11}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  width={80}
                  fontSize={11}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => formatMetric(value, metric)}
                    />
                  }
                />
                <Bar dataKey="value" fill={activeMetric.color} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartContainer>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/30 bg-muted/30 text-muted-foreground/60">
                  <th className="px-3 py-2 text-left font-medium capitalize">{dimension}</th>
                  <th className="px-3 py-2 text-right font-medium">Spend</th>
                  <th className="px-3 py-2 text-right font-medium">Conv.</th>
                  <th className="px-3 py-2 text-right font-medium">ROAS</th>
                  <th className="px-3 py-2 text-right font-medium">Impressions</th>
                </tr>
              </thead>
              <tbody>
                {data!.map((row) => (
                  <tr key={row.label} className="border-b border-border/20 last:border-0">
                    <td className="px-3 py-2 font-medium">{row.label || "Unknown"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(row.spend)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.conversions)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtRoas(row.roas)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.impressions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
