"use client";

import {
  CircleHelp,
  DollarSign,
  Eye,
  MousePointerClick,
  ShoppingCart,
  Target,
  TrendingDown,
  TrendingUp,
} from "@/components/icons";
import { DataFreshnessLabel } from "@/components/blocks/dashboard/data-freshness";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { PerformanceChart } from "@/components/blocks/insights/performance-chart";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function fmt(
  value: string | number | null | undefined,
  opts?: { prefix?: string; suffix?: string; decimals?: number },
) {
  if (value == null || value === "") return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  const decimals = opts?.decimals ?? 2;
  const formatted = num >= 1000 ? `${(num / 1000).toFixed(1)}k` : num.toFixed(decimals);
  return `${opts?.prefix ?? ""}${formatted}${opts?.suffix ?? ""}`;
}

function pctDiff(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return null;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb) || nb === 0) return null;
  return ((na - nb) / nb) * 100;
}

function MetricCard({
  label,
  value,
  icon: Icon,
  comparison,
  tooltip,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  comparison?: { value: number; label: string } | null;
  tooltip?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
        <Icon className="size-3" />
        {label}
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center text-muted-foreground/50 transition-colors hover:text-foreground/70"
                aria-label={`${label} calculation details`}
              >
                <CircleHelp className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p>{tooltip}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
      {comparison && comparison.value !== 0 && (
        <div className="flex items-center gap-1 text-[11px]">
          {comparison.value > 0 ? (
            <TrendingUp className="size-3 text-emerald-500" />
          ) : (
            <TrendingDown className="size-3 text-red-400" />
          )}
          <span className={comparison.value > 0 ? "text-emerald-600" : "text-red-500"}>
            {comparison.value > 0 ? "+" : ""}
            {comparison.value.toFixed(1)}%
          </span>
          <span className="text-muted-foreground/40">{comparison.label}</span>
        </div>
      )}
    </div>
  );
}

interface PerformanceData {
  logCount: number;
  minDate: string | null;
  maxDate: string | null;
  totalSpend: string | null;
  avgRoas: string | null;
  portfolioAvgRoas: string | null;
  avgCpa: string | null;
  portfolioAvgCpa: string | null;
  avgCtr: string | null;
  portfolioAvgCtr: string | null;
  totalConversions: number | null;
  totalImpressions: number | null;
  totalClicks: number | null;
}

interface DailyPerformanceRow {
  dateStart: string;
  dateEnd: string;
  spend: string | null;
  purchaseValue: string | null;
  roas: string | null;
  cpa: string | null;
  ctr: string | null;
  conversions: number | null;
  impressions: number | null;
  reach: number | null;
  cpm: string | null;
  linkClicks: number | null;
}

interface AccountData {
  id: string;
  name: string;
  lastImportedAt: Date | null;
  dataDateEnd: string | null;
}

export function CreativePerformanceTab({
  perf,
  dailyPerf,
  account,
  from,
  to,
  onDateRangeChange,
  showDateRange = true,
}: {
  perf: PerformanceData | undefined;
  dailyPerf: DailyPerformanceRow[] | undefined;
  account: AccountData | undefined;
  from: Date | undefined;
  to: Date | undefined;
  onDateRangeChange: (range: { from: Date; to: Date } | undefined) => void;
  showDateRange?: boolean;
}) {
  const hasPerf = perf && perf.logCount > 0;
  const roasDiff = pctDiff(perf?.avgRoas, perf?.portfolioAvgRoas);
  const cpaDiff = pctDiff(perf?.avgCpa, perf?.portfolioAvgCpa);
  const ctrDiff = pctDiff(perf?.avgCtr, perf?.portfolioAvgCtr);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {showDateRange ? <DateRangePicker from={from} to={to} onChange={onDateRangeChange} /> : <div />}
        <DataFreshnessLabel account={account} />
      </div>

      {!hasPerf || !perf ? (
        <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground/50">No performance data yet</p>
          <p className="mt-1 text-[11px] text-muted-foreground/30">
            Import CSV data or link this creative to ads to see metrics
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard
              label="Spend"
              value={fmt(perf.totalSpend, { prefix: "$" })}
              icon={DollarSign}
              tooltip="Spend is calculated from base delivery rows only. Demographic, device, country, and placement breakdown rows are excluded to avoid double counting."
            />
            <MetricCard
              label="ROAS"
              value={fmt(perf.avgRoas, { suffix: "x" })}
              icon={TrendingUp}
              comparison={roasDiff != null ? { value: roasDiff, label: "vs avg" } : null}
            />
            <MetricCard
              label="CPA"
              value={fmt(perf.avgCpa, { prefix: "$" })}
              icon={Target}
              comparison={cpaDiff != null ? { value: -cpaDiff, label: "vs avg" } : null}
            />
            <MetricCard
              label="CTR"
              value={fmt(perf.avgCtr, { suffix: "%", decimals: 2 })}
              icon={MousePointerClick}
              comparison={ctrDiff != null ? { value: ctrDiff, label: "vs avg" } : null}
            />
            <MetricCard
              label="Conversions"
              value={fmt(perf.totalConversions, { decimals: 0 })}
              icon={ShoppingCart}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <MetricCard
              label="Impressions"
              value={fmt(perf.totalImpressions, { decimals: 0 })}
              icon={Eye}
            />
            <MetricCard
              label="Link Clicks"
              value={fmt(perf.totalClicks, { decimals: 0 })}
              icon={MousePointerClick}
            />
          </div>

          {dailyPerf && dailyPerf.length > 1 && (
            <div className="rounded-lg border border-border/50 bg-card p-4">
              <PerformanceChart logs={dailyPerf as Array<typeof dailyPerf[number] & Record<string, unknown>>} compact />
            </div>
          )}
        </>
      )}
    </div>
  );
}
