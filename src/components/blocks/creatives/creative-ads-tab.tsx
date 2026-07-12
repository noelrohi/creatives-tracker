"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, FileText, MoreHorizontal, PauseCircle } from "@/components/icons";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc/client";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

function tierLabel(tier: LinkedAd["disableTier"]) {
  if (tier === "pause_now") return "Pause";
  if (tier === "watch") return "Watch";
  return null;
}

function BleederTierBadge({ tier }: { tier: LinkedAd["disableTier"] }) {
  const label = tierLabel(tier);
  if (!label) return null;
  const className = tier === "pause_now"
    ? "bg-red-500/15 text-red-500 dark:text-red-400"
    : "bg-amber-500/15 text-amber-600 dark:text-amber-400";

  return <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${className}`}>{label}</span>;
}

interface LinkedAd {
  id: string;
  metaId: string | null;
  name: string;
  caption: string | null;
  status: string | null;
  adSetName: string | null;
  campaignName: string | null;
  destinationUrl: string | null;
  totalSpend: string | null;
  avgRoas: string | null;
  totalConversions: number | null;
  runningDays?: number | null;
  disableTier?: "pause_now" | "watch" | null;
  minDate: string | null;
  maxDate: string | null;
}

type CreativeAdsTabProps = {
  ads: LinkedAd[] | undefined;
  creativeId: string;
  from: string;
  to: string;
  canPauseMetaAds?: boolean;
};

export function CreativeAdsTab({ ads, creativeId, from, to, canPauseMetaAds = false }: CreativeAdsTabProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [captionAd, setCaptionAd] = useState<LinkedAd | null>(null);
  const [manualSelectedAdIds, setManualSelectedAdIds] = useState<string[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const sharedCaption = useMemo(() => {
    if (!ads || ads.length === 0) return null;
    const captions = ads.map((a) => a.caption).filter(Boolean);
    if (captions.length === 0) return null;
    const allSame = captions.every((c) => c === captions[0]);
    return allSame ? captions[0] : null;
  }, [ads]);

  const defaultSelectedAdIds = useMemo(
    () => (ads ?? [])
      .filter((ad) => ad.disableTier === "pause_now" && ad.status === "active" && ad.metaId)
      .map((ad) => ad.id),
    [ads],
  );
  const selectedAdIds = manualSelectedAdIds ?? defaultSelectedAdIds;
  const selectedAds = useMemo(
    () => (ads ?? []).filter((ad) => selectedAdIds.includes(ad.id)),
    [ads, selectedAdIds],
  );

  const pauseMutation = useMutation(
    trpc.ad.pauseMetaAds.mutationOptions({
      onSuccess: (result) => {
        const pausedCount = result.paused.length;
        const failedCount = result.failed.length;

        if (pausedCount > 0 && failedCount === 0) {
          toast.success(`Paused ${pausedCount} ${pausedCount === 1 ? "ad" : "ads"} in Meta`);
        } else if (pausedCount > 0) {
          toast.warning(`Paused ${pausedCount} ${pausedCount === 1 ? "ad" : "ads"}; ${failedCount} failed`, {
            description: result.failed[0]?.error,
          });
        } else {
          toast.error("No ads were paused", { description: result.failed[0]?.error });
        }

        setConfirmOpen(false);
        setManualSelectedAdIds([]);
        queryClient.invalidateQueries({ queryKey: trpc.ad.listByCreative.queryKey({ adCreativeId: creativeId, from, to }) });
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.getPerformance.queryKey({ id: creativeId, from, to }) });
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.dashboardStats.queryKey() });
      },
      onError: (error) => toast.error(error.message || "Failed to pause ads"),
    }),
  );

  if (!ads || ads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground/50">Not used in any ads yet</p>
      </div>
    );
  }

  return (
    <>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {sharedCaption && (
          <>
            <span className="text-[12px] text-muted-foreground/50">Same caption across all ads</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setCaptionAd(ads![0])}
            >
              <FileText className="size-3" /> View Caption
            </Button>
          </>
        )}
      </div>
      {canPauseMetaAds && (
        <Button
          variant="destructive"
          size="sm"
          className="h-8 text-xs"
          disabled={selectedAdIds.length === 0 || pauseMutation.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          <PauseCircle className="size-3.5" /> Pause selected ({selectedAdIds.length})
        </Button>
      )}
    </div>
    <div className="overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border/30 bg-muted/30 text-muted-foreground/60">
            {canPauseMetaAds && <th className="w-9 px-3 py-2" />}
            <th className="px-3 py-2 text-left font-medium">Ad</th>
            <th className="px-3 py-2 text-left font-medium">Campaign</th>
            <th className="px-3 py-2 text-left font-medium">Landing Page</th>
            <th className="px-3 py-2 text-right font-medium">Spend</th>
            <th className="px-3 py-2 text-right font-medium">ROAS</th>
            <th className="px-3 py-2 text-right font-medium">Conv.</th>
            <th className="px-3 py-2 text-right font-medium">Published</th>
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {ads.map((ad) => {
            const canSelect = canPauseMetaAds && ad.status === "active" && Boolean(ad.metaId);
            const isSelected = selectedAdIds.includes(ad.id);
            return (
            <tr key={ad.id} className={`border-b border-border/20 last:border-0 ${ad.disableTier === "pause_now" ? "bg-red-500/[0.03]" : ad.disableTier === "watch" ? "bg-amber-500/[0.03]" : ""}`}>
              {canPauseMetaAds && (
                <td className="px-3 py-2 align-middle">
                  <Checkbox
                    checked={isSelected}
                    disabled={!canSelect || pauseMutation.isPending}
                    aria-label={`Select ${ad.name} to pause`}
                    onCheckedChange={(checked) => {
                      setManualSelectedAdIds((current) => {
                        const selected = current ?? defaultSelectedAdIds;
                        return checked
                          ? [...new Set([...selected, ad.id])]
                          : selected.filter((id) => id !== ad.id);
                      });
                    }}
                  />
                </td>
              )}
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="max-w-[200px] truncate font-medium">{ad.name}</span>
                  <Badge
                    variant={ad.status === "active" ? "outline" : "secondary"}
                    className={
                      ad.status === "active"
                        ? "border-emerald-200 text-[9px] text-emerald-600"
                        : "text-[9px]"
                    }
                  >
                    {ad.status === "active"
                      ? "Active"
                      : ad.status === "paused"
                        ? "Paused"
                        : "Archived"}
                  </Badge>
                  <BleederTierBadge tier={ad.disableTier} />
                </div>
                {ad.adSetName && (
                  <div className="mt-0.5 max-w-[240px] truncate text-[11px] text-muted-foreground/50">
                    {ad.adSetName}
                  </div>
                )}
              </td>
              <td className="max-w-[140px] px-3 py-2 text-muted-foreground/60">
                {ad.campaignName ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block truncate">{ad.campaignName}</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      {ad.campaignName}
                    </TooltipContent>
                  </Tooltip>
                ) : "—"}
              </td>
              <td className="max-w-[180px] px-3 py-2">
                {ad.destinationUrl ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={ad.destinationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-muted-foreground/60 hover:text-foreground transition-colors"
                      >
                        <span className="truncate">{new URL(ad.destinationUrl).pathname !== "/" ? new URL(ad.destinationUrl).pathname : "/"}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      {ad.destinationUrl}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="text-muted-foreground/30">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmt(ad.totalSpend, { prefix: "$" })}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmt(ad.avgRoas, { suffix: "x" })}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmt(ad.totalConversions, { decimals: 0 })}
              </td>
              <td className="px-3 py-2 text-right text-[11px] text-muted-foreground/50">
                <div>{ad.minDate ?? "—"}</div>
                {ad.runningDays != null && ad.runningDays > 0 && (
                  <div className="text-[10px]">{ad.runningDays}d running</div>
                )}
              </td>
              <td className="px-2 py-2">
                {(ad.metaId || (ad.caption && !sharedCaption)) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="size-7">
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {ad.metaId && (
                        <DropdownMenuItem
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(ad.metaId!);
                              toast.success("Copied Meta ID", {
                                description: "Paste into Meta Ads Manager search to find this ad.",
                              });
                            } catch {
                              toast.error("Couldn't copy to clipboard");
                            }
                          }}
                        >
                          <Copy className="size-3.5" /> Copy Meta ID
                        </DropdownMenuItem>
                      )}
                      {ad.caption && !sharedCaption && (
                        <DropdownMenuItem onClick={() => setCaptionAd(ad)}>
                          <FileText className="size-3.5" /> View Caption
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">Pause selected Meta ads?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              This will pause {selectedAds.length} {selectedAds.length === 1 ? "ad" : "ads"} in Meta and mark successful pauses as paused locally.
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/50 bg-muted/20 p-2">
              {selectedAds.map((ad) => (
                <div key={ad.id} className="flex items-center justify-between gap-3 rounded px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{ad.name}</div>
                    <div className="text-[11px]">{ad.metaId}</div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] tabular-nums">
                    <div>{fmt(ad.totalSpend, { prefix: "$" })}</div>
                    <div>{fmt(ad.avgRoas, { suffix: "x" })} · {fmt(ad.totalConversions, { decimals: 0 })} conv</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={pauseMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={selectedAds.length === 0 || pauseMutation.isPending}
              onClick={() => pauseMutation.mutate({ adIds: selectedAds.map((ad) => ad.id) })}
            >
              {pauseMutation.isPending ? "Pausing..." : "Pause in Meta"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!captionAd} onOpenChange={(open) => !open && setCaptionAd(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">{captionAd?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {captionAd?.caption}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
