"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

interface SparklineProps {
  data: Array<{ date: string; value: number | null }>;
  color?: string;
  width?: number | string;
  height?: number | string;
}

export function Sparkline({ data, color = "hsl(160, 84%, 39%)", width = 80, height = 24 }: SparklineProps) {
  const cleaned = data.filter((d) => d.value != null) as Array<{ date: string; value: number }>;
  if (cleaned.length < 2) {
    return <div style={{ width, height }} className="text-[10px] text-muted-foreground/40">—</div>;
  }
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={cleaned} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
