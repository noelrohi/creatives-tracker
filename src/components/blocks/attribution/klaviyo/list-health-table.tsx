"use client";

import type { ListHealthSummary } from "@/lib/klaviyo/list-health";
import { Button } from "@/components/ui/button";
import { listHealth as copy } from "./copy";

const KPIS = [
  { key: "subscribed", label: copy.kpiSubscribed, tone: "text-emerald-600" },
  { key: "unsubscribed", label: copy.kpiUnsubscribed, tone: "text-red-600" },
  { key: "wonBack", label: copy.kpiWonBack, tone: "text-amber-600" },
  { key: "quickChurn", label: copy.kpiQuickChurn, tone: "" },
  { key: "net", label: copy.kpiNet, tone: "text-emerald-600" },
] as const;

export function ListHealthTable({
  summary,
  error,
  onRetry,
}: {
  summary: ListHealthSummary | null;
  error: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        {copy.error}{" "}
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </p>
    );
  }
  if (summary === null) return null;
  if (!summary.discovered) {
    return <p className="text-sm text-muted-foreground">{copy.undiscovered}</p>;
  }
  const maxAbsNet = Math.max(1, ...summary.daily.map((row) => Math.abs(row.net)));
  const format = (key: (typeof KPIS)[number]["key"]) => {
    const value = summary.totals[key];
    return key === "net" && value >= 0 ? `+${value}` : `${value}`;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-7 gap-y-2">
        {KPIS.map((kpi) => (
          <div key={kpi.key}>
            <p
              className={`text-[20px] font-semibold tabular-nums ${kpi.tone}`}
              data-testid={`list-health-kpi-${kpi.key}`}
            >
              {format(kpi.key)}
            </p>
            <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {kpi.label}
            </p>
          </div>
        ))}
      </div>
      <div>
        <div className="flex h-12 items-end gap-[2px]">
          {[...summary.daily].reverse().map((row) => (
            <div
              key={row.day}
              title={`${row.day}: ${row.net >= 0 ? "+" : ""}${row.net}`}
              className={row.net >= 0 ? "w-2.5 bg-emerald-600/70" : "w-2.5 bg-red-600/70"}
              style={{ height: `${Math.max(8, (Math.abs(row.net) / maxAbsNet) * 100)}%` }}
            />
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground/70">{copy.barsCaption}</p>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {["Day", copy.kpiSubscribed, copy.kpiUnsubscribed, copy.kpiWonBack, copy.kpiQuickChurn, copy.kpiNet].map(
              (heading, index) => (
                <th
                  key={heading}
                  className={`px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground ${index === 0 ? "text-left" : "text-right"}`}
                >
                  {heading}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {summary.daily.map((row) => (
            <tr key={row.day}>
              <td className="border-b border-border/40 px-2 py-1">{row.day}</td>
              {[row.subscribed, row.unsubscribed, row.wonBack, row.quickChurn].map(
                (value, index) => (
                  <td key={index} className="border-b border-border/40 px-2 py-1 text-right tabular-nums">
                    {value}
                  </td>
                ),
              )}
              <td className="border-b border-border/40 px-2 py-1 text-right tabular-nums">
                {row.net >= 0 ? `+${row.net}` : row.net}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground/70">{copy.aggregateNote}</p>
    </div>
  );
}
