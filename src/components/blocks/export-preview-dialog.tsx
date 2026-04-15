"use client";

import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { fmtMoney, fmtNum, fmtRoas } from "@/lib/fmt";

export type ExportFilters = {
  from: string;
  to: string;
  accountId?: string;
  adSetIds?: string[];
  teamId?: string;
  format?: string;
  awarenessLevel?: string;
  ownership?: "ours" | "theirs";
  search?: string;
  untaggedOnly?: boolean;
};

type FilterLabel = { label: string; value: string };

type AgentExport = Awaited<ReturnType<typeof import("@/lib/ad-export").fetchAgentExportRows>>;

function downloadCsvFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(headers: readonly string[], rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");
}

const fmtN = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "" : String(v));
const fmtB = (v: boolean | null | undefined) => (v ? "true" : "false");
const fmtS = (v: string | null | undefined) => v ?? "";

function buildAdsCsv(ads: AgentExport["ads"]): string {
  const headers = [
    "ad_id", "meta_ad_id", "ad_name", "status",
    "creative_id", "creative_name",
    "ad_set_id", "meta_ad_set_id", "ad_set_name",
    "campaign_id", "meta_campaign_id", "campaign_name",
    "account_id", "account_name", "team_id", "team_name",
    "format", "angle", "persona", "awareness_level", "hook", "cta",
    "destination_url", "asset_url", "video_url",
    "window_from", "window_to", "running_days", "last_log_at", "active_in_window",
    "window_spend_usd", "window_revenue_usd", "window_conversions",
    "window_roas", "window_cpa_usd", "window_ctr_pct", "window_cpc_usd",
    "window_frequency", "window_impressions", "window_clicks",
    "window_hook_rate_pct", "window_thumbstop_pct",
    "lifetime_spend_usd", "lifetime_conversions", "lifetime_roas",
    "ctr_delta_pct", "cpc_delta_pct", "cpa_delta_pct", "hook_rate_delta_pct",
    "ad_health", "ad_health_reasons",
    "creative_rollup_health", "creative_rollup_reasons",
    "dollars_at_risk_usd",
    "flag_disable_candidate", "flag_scale_candidate", "flag_review_candidate",
  ] as const;
  const rows = ads.map((a) => [
    a.adId, fmtS(a.metaAdId), a.adName, fmtS(a.status),
    a.creativeId, a.creativeName,
    fmtS(a.adSetId), fmtS(a.metaAdSetId), fmtS(a.adSetName),
    fmtS(a.campaignId), fmtS(a.metaCampaignId), fmtS(a.campaignName),
    fmtS(a.accountId), fmtS(a.accountName), fmtS(a.teamId), fmtS(a.teamName),
    fmtS(a.format), fmtS(a.angle), fmtS(a.persona), fmtS(a.awarenessLevel), fmtS(a.hook), fmtS(a.cta),
    fmtS(a.destinationUrl), fmtS(a.assetUrl), fmtS(a.videoUrl),
    fmtS(a.windowFrom), fmtS(a.windowTo), fmtN(a.runningDays), fmtS(a.lastLogAt), fmtB(a.activeInWindow),
    fmtN(a.windowSpend), fmtN(a.windowRevenue), fmtN(a.windowConversions),
    fmtN(a.windowRoas), fmtN(a.windowCpa), fmtN(a.windowCtr), fmtN(a.windowCpc),
    fmtN(a.windowFrequency), fmtN(a.windowImpressions), fmtN(a.windowClicks),
    fmtN(a.windowHookRate), fmtN(a.windowThumbstop),
    fmtN(a.lifetimeSpend), fmtN(a.lifetimeConversions), fmtN(a.lifetimeRoas),
    fmtN(a.ctrDeltaPct), fmtN(a.cpcDeltaPct), fmtN(a.cpaDeltaPct), fmtN(a.hookRateDeltaPct),
    fmtS(a.adHealth), a.adHealthReasons.join(" | "),
    fmtS(a.creativeRollupHealth), a.creativeRollupReasons.join(" | "),
    fmtN(a.dollarsAtRisk),
    fmtB(a.flagDisableCandidate), fmtB(a.flagScaleCandidate), fmtB(a.flagReviewCandidate),
  ]);
  return toCsv(headers, rows);
}

function buildCreativesCsv(creatives: AgentExport["creatives"]): string {
  const headers = [
    "creative_id", "creative_name",
    "account_id", "account_name", "team_id", "team_name",
    "format", "angle", "persona", "awareness_level", "hook", "cta",
    "destination_url", "asset_url", "video_url",
    "window_from", "window_to",
    "ad_count", "active_ad_count", "active_in_window",
    "window_spend_usd", "window_revenue_usd", "window_conversions",
    "window_roas", "window_cpa_usd", "window_ctr_pct",
    "lifetime_spend_usd", "lifetime_conversions", "lifetime_roas",
    "running_days", "last_log_at",
    "rollup_health", "rollup_reasons",
    "dollars_at_risk_usd",
    "flag_disable_candidate", "flag_scale_candidate", "flag_review_candidate",
  ] as const;
  const rows = creatives.map((c) => [
    c.creativeId, c.creativeName,
    fmtS(c.accountId), fmtS(c.accountName), fmtS(c.teamId), fmtS(c.teamName),
    fmtS(c.format), fmtS(c.angle), fmtS(c.persona), fmtS(c.awarenessLevel), fmtS(c.hook), fmtS(c.cta),
    fmtS(c.destinationUrl), fmtS(c.assetUrl), fmtS(c.videoUrl),
    fmtS(c.windowFrom), fmtS(c.windowTo),
    fmtN(c.adCount), fmtN(c.activeAdCount), fmtB(c.activeInWindow),
    fmtN(c.windowSpend), fmtN(c.windowRevenue), fmtN(c.windowConversions),
    fmtN(c.windowRoas), fmtN(c.windowCpa), fmtN(c.windowCtr),
    fmtN(c.lifetimeSpend), fmtN(c.lifetimeConversions), fmtN(c.lifetimeRoas),
    fmtN(c.runningDays), fmtS(c.lastLogAt),
    fmtS(c.rollupHealth), c.rollupReasons.join(" | "),
    fmtN(c.dollarsAtRisk),
    fmtB(c.flagDisableCandidate), fmtB(c.flagScaleCandidate), fmtB(c.flagReviewCandidate),
  ]);
  return toCsv(headers, rows);
}

export function ExportPreviewDialog({
  open,
  onOpenChange,
  filters,
  filterLabels,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  filters: ExportFilters;
  filterLabels: FilterLabel[];
}) {
  const trpc = useTRPC();
  const preview = useQuery({
    ...trpc.adCreative.exportAgentRows.queryOptions({
      from: filters.from,
      to: filters.to,
      accountId: filters.accountId,
      adSetIds: filters.adSetIds,
      teamId: filters.teamId,
      format: filters.format,
      awarenessLevel: filters.awarenessLevel,
      ownership: filters.ownership,
      search: filters.search,
      untaggedOnly: filters.untaggedOnly,
    }),
    enabled: open,
  });

  const data = preview.data;
  const summary = data
    ? {
        ads: data.ads.length,
        creatives: data.creatives.length,
        activeAds: data.ads.filter((a) => a.activeInWindow).length,
        spend: data.ads.reduce((acc, a) => acc + (a.windowSpend ?? 0), 0),
        revenue: data.ads.reduce((acc, a) => acc + (a.windowRevenue ?? 0), 0),
        dollarsAtRisk: data.ads.reduce((acc, a) => acc + a.dollarsAtRisk, 0),
        disable: data.ads.filter((a) => a.flagDisableCandidate).length,
        scale: data.ads.filter((a) => a.flagScaleCandidate).length,
        review: data.ads.filter((a) => a.flagReviewCandidate).length,
      }
    : null;
  const roas = summary && summary.spend > 0 ? summary.revenue / summary.spend : null;

  const handleDownloadAds = () => {
    if (!data) return;
    downloadCsvFile(buildAdsCsv(data.ads), `ads_${filters.from}_to_${filters.to}.csv`);
  };
  const handleDownloadCreatives = () => {
    if (!data) return;
    downloadCsvFile(buildCreativesCsv(data.creatives), `creatives_${filters.from}_to_${filters.to}.csv`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Preview export</DialogTitle>
          <DialogDescription>
            Review what will be included before downloading. Filters + window
            match what you have on screen.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60 mb-1.5">
              Window
            </h3>
            <div className="text-sm tabular-nums">
              {filters.from} → {filters.to}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60 mb-1.5">
              Filters
            </h3>
            {filterLabels.length === 0 ? (
              <div className="text-sm text-muted-foreground/60">No filters applied</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {filterLabels.map((f) => (
                  <span
                    key={`${f.label}:${f.value}`}
                    className="inline-flex items-center gap-1 rounded bg-muted/60 px-2 py-0.5 text-[12px]"
                  >
                    <span className="text-muted-foreground/60">{f.label}:</span>
                    <span>{f.value}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60 mb-1.5">
              Summary
            </h3>
            {preview.isLoading || !summary ? (
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <Cell label="Ads" value={fmtNum(summary.ads)} />
                <Cell label="Creatives" value={fmtNum(summary.creatives)} />
                <Cell label="Active in window" value={fmtNum(summary.activeAds)} />
                <Cell label="Window spend" value={fmtMoney(summary.spend)} />
                <Cell label="Window ROAS" value={fmtRoas(roas)} />
                <Cell label="$ at risk" value={fmtMoney(summary.dollarsAtRisk)} accent="red" />
                <Cell label="Disable candidates" value={fmtNum(summary.disable)} accent="red" />
                <Cell label="Scale candidates" value={fmtNum(summary.scale)} accent="emerald" />
                <Cell label="Review candidates" value={fmtNum(summary.review)} accent="amber" />
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleDownloadCreatives}
            disabled={!data || data.creatives.length === 0}
            className="gap-1.5"
          >
            <Download className="size-3.5" /> Creatives CSV
          </Button>
          <Button
            onClick={handleDownloadAds}
            disabled={!data || data.ads.length === 0}
            className="gap-1.5"
          >
            <Download className="size-3.5" /> Ads CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "red" | "emerald" | "amber";
}) {
  const color =
    accent === "red"
      ? "text-red-500 dark:text-red-400"
      : accent === "emerald"
        ? "text-emerald-600 dark:text-emerald-400"
        : accent === "amber"
          ? "text-amber-600 dark:text-amber-400"
          : "text-foreground";
  return (
    <div className="rounded-md border border-border px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
