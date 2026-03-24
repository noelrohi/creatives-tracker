"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import Link from "next/link";

interface Ad {
  id: string;
  adCreativeId: string | null;
  [key: string]: unknown;
}

interface Creative {
  id: string;
  name: string;
  format: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  angle: string | null;
  persona: string | null;
  [key: string]: unknown;
}

interface PerfLog {
  adId: string;
  roas: string | null;
  cpa: string | null;
  spend: string | null;
  conversions: number | null;
  ctr: string | null;
  impressions: number | null;
  [key: string]: unknown;
}

interface CreativeInsightsProps {
  creatives: Creative[];
  ads: Ad[];
  performanceLogs: PerfLog[];
}

interface DimensionResult {
  label: string;
  roas: number;
  count: number;
}

function prettify(s: string) {
  return s.replace(/_/g, " ");
}

const COLORS = [
  "hsl(262, 83%, 58%)",
  "hsl(217, 91%, 60%)",
  "hsl(160, 84%, 39%)",
  "hsl(38, 92%, 50%)",
  "hsl(330, 81%, 60%)",
  "hsl(239, 84%, 67%)",
  "hsl(172, 66%, 50%)",
  "hsl(24, 95%, 53%)",
];

function analyzeByDimension(
  dimension: string,
  creatives: Creative[],
  creativePerf: Map<string, PerfLog[]>,
): DimensionResult[] {
  const groups = new Map<string, { roas: number[]; count: number }>();

  for (const creative of creatives) {
    const value = creative[dimension] as string | null;
    if (!value) continue;
    const logs = creativePerf.get(creative.id) ?? [];
    if (logs.length === 0) continue;
    if (!groups.has(value)) groups.set(value, { roas: [], count: 0 });
    const group = groups.get(value)!;
    group.count++;
    for (const log of logs) {
      if (log.roas) group.roas.push(Number(log.roas));
    }
  }

  return Array.from(groups.entries())
    .map(([label, data]) => ({
      label: prettify(label),
      roas: data.roas.length > 0 ? data.roas.reduce((a, b) => a + b, 0) / data.roas.length : 0,
      count: data.count,
    }))
    .filter((r) => r.roas > 0)
    .sort((a, b) => b.roas - a.roas);
}

function InsightChart({ title, data }: { title: string; data: DimensionResult[] }) {
  if (data.length === 0) return null;

  const chartConfig: ChartConfig = {
    roas: { label: "Avg ROAS", color: "hsl(160, 84%, 39%)" },
  };

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <ChartContainer
        config={chartConfig}
        className="w-full"
        style={{ height: Math.max(100, data.length * 36 + 20) }}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="label"
            tickLine={false}
            axisLine={false}
            width={90}
            className="capitalize"
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="roas" radius={[0, 4, 4, 0]} maxBarSize={24}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}

export function CreativeInsights({ creatives, ads, performanceLogs }: CreativeInsightsProps) {
  const { creativePerf, dimensions } = useMemo(() => {
    const adToCreative = new Map<string, string>();
    for (const ad of ads) {
      if (ad.adCreativeId) adToCreative.set(ad.id, ad.adCreativeId);
    }

    const creativePerf = new Map<string, PerfLog[]>();
    for (const log of performanceLogs) {
      const creativeId = adToCreative.get(log.adId);
      if (!creativeId) continue;
      if (!creativePerf.has(creativeId)) creativePerf.set(creativeId, []);
      creativePerf.get(creativeId)!.push(log);
    }

    const dims: { key: string; label: string; data: DimensionResult[] }[] = [];
    const formatDim = analyzeByDimension("format", creatives, creativePerf);
    if (formatDim.length > 1) dims.push({ key: "format", label: "ROAS by Format", data: formatDim });
    const awarenessDim = analyzeByDimension("awarenessLevel", creatives, creativePerf);
    if (awarenessDim.length > 1) dims.push({ key: "awareness", label: "ROAS by Awareness Level", data: awarenessDim });
    const hookDim = analyzeByDimension("hook", creatives, creativePerf);
    if (hookDim.length > 1) dims.push({ key: "hook", label: "ROAS by Hook", data: hookDim.slice(0, 8) });
    const angleDim = analyzeByDimension("angle", creatives, creativePerf);
    if (angleDim.length > 1) dims.push({ key: "angle", label: "ROAS by Angle", data: angleDim.slice(0, 8) });
    const personaDim = analyzeByDimension("persona", creatives, creativePerf);
    if (personaDim.length > 1) dims.push({ key: "persona", label: "ROAS by Persona", data: personaDim.slice(0, 8) });

    return { creativePerf, dimensions: dims };
  }, [creatives, ads, performanceLogs]);

  const topCreatives = useMemo(() => {
    return creatives
      .map((c) => {
        const logs = creativePerf.get(c.id) ?? [];
        if (logs.length === 0) return null;
        const roasValues = logs.map((l) => Number(l.roas)).filter((v) => v > 0);
        const totalSpend = logs.reduce((sum, l) => sum + (l.spend ? Number(l.spend) : 0), 0);
        const totalConv = logs.reduce((sum, l) => sum + (l.conversions ?? 0), 0);
        if (roasValues.length === 0 && totalSpend === 0) return null;
        return {
          id: c.id,
          name: c.name,
          format: c.format,
          avgRoas: roasValues.length > 0 ? roasValues.reduce((a, b) => a + b, 0) / roasValues.length : 0,
          totalSpend,
          totalConv,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.avgRoas - a.avgRoas)
      .slice(0, 10);
  }, [creatives, creativePerf]);

  if (performanceLogs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground/50 py-4">
        Import performance data to see creative insights.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {topCreatives.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Top Creatives by ROAS</h4>
          <div className="space-y-0.5">
            {topCreatives.map((c, i) => (
              <Link
                key={c.id}
                href={`/creatives/${c.id}`}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
              >
                <span className="w-5 text-xs tabular-nums text-muted-foreground/40 text-right">
                  {i + 1}
                </span>
                <span className="flex-1 truncate font-medium">{c.name}</span>
                {c.format && (
                  <span className="text-xs text-muted-foreground/60 capitalize">
                    {c.format}
                  </span>
                )}
                <span className="text-xs tabular-nums font-semibold text-emerald-600">
                  {c.avgRoas.toFixed(2)}x
                </span>
                <span className="text-xs tabular-nums text-muted-foreground/50 w-16 text-right">
                  ${c.totalSpend.toFixed(0)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {dimensions.map((dim) => (
        <InsightChart key={dim.key} title={dim.label} data={dim.data} />
      ))}
    </div>
  );
}
