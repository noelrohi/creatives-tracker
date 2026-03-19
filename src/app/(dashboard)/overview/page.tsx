"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Megaphone,
  Layers,
  Image as ImageIcon,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

export default function OverviewPage() {
  const trpc = useTRPC();

  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    null,
  );
  const [selectedAdSetId, setSelectedAdSetId] = useState<string | null>(null);

  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());
  const adSets = useQuery(trpc.adSet.list.queryOptions());
  const creatives = useQuery(trpc.adCreative.list.queryOptions());

  // Filter ad sets by selected campaign
  const filteredAdSets = selectedCampaignId
    ? adSets.data?.filter((a) => a.campaignConfigId === selectedCampaignId)
    : adSets.data;

  // Get creative for selected ad set
  const selectedAdSet = adSets.data?.find((a) => a.id === selectedAdSetId);
  const linkedCreative = selectedAdSet?.adCreativeId
    ? creatives.data?.find((c) => c.id === selectedAdSet.adCreativeId)
    : null;

  // All creatives linked to ad sets in this campaign
  const adSetCreativeIds = new Set(
    filteredAdSets?.map((a) => a.adCreativeId).filter(Boolean) ?? [],
  );
  const filteredCreatives = selectedAdSetId
    ? linkedCreative
      ? [linkedCreative]
      : []
    : creatives.data?.filter((c) => adSetCreativeIds.has(c.id)) ?? [];

  // Perf logs for selected ad set
  const perfLogs = useQuery({
    ...trpc.performanceLog.listByAdSet.queryOptions({
      adSetId: selectedAdSetId ?? "",
    }),
    enabled: !!selectedAdSetId,
  });

  // Count ad sets per campaign
  const adSetCountByCampaign = new Map<string, number>();
  adSets.data?.forEach((a) => {
    if (a.campaignConfigId) {
      adSetCountByCampaign.set(
        a.campaignConfigId,
        (adSetCountByCampaign.get(a.campaignConfigId) ?? 0) + 1,
      );
    }
  });

  // Unlinked ad sets count
  const unlinkedAdSets =
    adSets.data?.filter((a) => !a.campaignConfigId) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-medium tracking-tight">Overview</h1>

      <div className="grid grid-cols-3 gap-px rounded-lg border bg-border overflow-hidden min-h-[calc(100vh-10rem)]">
        {/* Column 1: Campaigns */}
        <div className="flex flex-col bg-background">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted/30 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Campaigns
            </span>
            <span className="text-xs tabular-nums text-muted-foreground/50">
              {campaigns.data?.length ?? 0}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {campaigns.isLoading ? (
              <div className="space-y-1 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-md" />
                ))}
              </div>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {/* All campaigns button */}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCampaignId(null);
                    setSelectedAdSetId(null);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    selectedCampaignId === null
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span className="text-sm font-medium">All</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground/50">
                    {adSets.data?.length ?? 0}
                  </span>
                </button>

                {campaigns.data?.map((campaign) => {
                  const count = adSetCountByCampaign.get(campaign.id) ?? 0;
                  const isSelected = selectedCampaignId === campaign.id;
                  return (
                    <button
                      key={campaign.id}
                      type="button"
                      onClick={() => {
                        setSelectedCampaignId(campaign.id);
                        setSelectedAdSetId(null);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors group",
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted/60",
                      )}
                    >
                      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-amber-500/10">
                        <Megaphone className="size-3 text-amber-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {campaign.name}
                        </p>
                        {campaign.dailyBudget && (
                          <p className="text-[11px] text-muted-foreground/60">
                            ${campaign.dailyBudget}/day
                          </p>
                        )}
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground/50">
                        {count}
                      </span>
                      {isSelected && (
                        <ChevronRight className="size-3.5 text-primary/60 shrink-0" />
                      )}
                    </button>
                  );
                })}

                {/* Unlinked */}
                {unlinkedAdSets.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCampaignId("__unlinked__");
                      setSelectedAdSetId(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      selectedCampaignId === "__unlinked__"
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <span className="text-sm text-muted-foreground">
                      No campaign
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground/50">
                      {unlinkedAdSets.length}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Ad Sets */}
        <div className="flex flex-col bg-background">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted/30 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Ad Sets
            </span>
            <span className="text-xs tabular-nums text-muted-foreground/50">
              {selectedCampaignId === "__unlinked__"
                ? unlinkedAdSets.length
                : (filteredAdSets?.length ?? 0)}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {adSets.isLoading ? (
              <div className="space-y-1 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-md" />
                ))}
              </div>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {(selectedCampaignId === "__unlinked__"
                  ? unlinkedAdSets
                  : filteredAdSets ?? []
                ).map((adSet) => {
                  const isSelected = selectedAdSetId === adSet.id;
                  return (
                    <button
                      key={adSet.id}
                      type="button"
                      onClick={() => setSelectedAdSetId(adSet.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors group",
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted/60",
                      )}
                    >
                      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-violet-500/10">
                        <Layers className="size-3 text-violet-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {adSet.name}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground/60">
                          {[adSet.adCreativeName, adSet.campaignConfigName]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </p>
                      </div>
                      {isSelected && (
                        <ChevronRight className="size-3.5 text-primary/60 shrink-0" />
                      )}
                    </button>
                  );
                })}
                {(selectedCampaignId === "__unlinked__"
                  ? unlinkedAdSets
                  : filteredAdSets ?? []
                ).length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground/50">
                    No ad sets
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Column 3: Detail / Creative + Performance */}
        <div className="flex flex-col bg-background">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted/30 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {selectedAdSetId ? "Detail" : "Creatives"}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {selectedAdSetId ? (
              <div className="flex flex-col gap-4 p-3">
                {/* Ad set info */}
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    {selectedAdSet?.name}
                  </h3>
                  <Link
                    href={`/ad-sets/${selectedAdSetId}`}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Open <ExternalLink className="size-3" />
                  </Link>
                </div>

                {/* Linked creative */}
                {linkedCreative ? (
                  <Link
                    href={`/creatives/${linkedCreative.id}`}
                    className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted/40 overflow-hidden">
                      {linkedCreative.assetUrl &&
                      !linkedCreative.assetUrl.match(
                        /\.(mp4|webm|mov)(\?|$)/i,
                      ) ? (
                        <img
                          src={linkedCreative.assetUrl}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="size-4 text-muted-foreground/30" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {linkedCreative.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground/60">
                        {[
                          linkedCreative.format,
                          linkedCreative.awarenessLevel?.replace(/_/g, " "),
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Creative"}
                      </p>
                    </div>
                    <ExternalLink className="size-3 text-muted-foreground/40 shrink-0" />
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground/50">
                    No creative linked
                  </p>
                )}

                {/* Performance summary */}
                {perfLogs.data && perfLogs.data.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Latest
                    </h4>
                    <div className="grid grid-cols-2 gap-2">
                      {(() => {
                        const latest = perfLogs.data[0];
                        const metrics = [
                          {
                            label: "Spend",
                            value: latest.spend ? `$${latest.spend}` : null,
                          },
                          { label: "ROAS", value: latest.roas },
                          {
                            label: "CPA",
                            value: latest.cpa ? `$${latest.cpa}` : null,
                          },
                          { label: "Conv", value: latest.conversions },
                          {
                            label: "Impr",
                            value: latest.impressions?.toLocaleString(),
                          },
                          {
                            label: "Reach",
                            value: latest.reach?.toLocaleString(),
                          },
                          {
                            label: "CPM",
                            value: latest.cpm ? `$${latest.cpm}` : null,
                          },
                          {
                            label: "CTR",
                            value: latest.ctr ? `${latest.ctr}%` : null,
                          },
                        ].filter((m) => m.value != null);
                        return metrics.map((m) => (
                          <div
                            key={m.label}
                            className="rounded-md border px-3 py-2"
                          >
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                              {m.label}
                            </p>
                            <p className="text-sm font-semibold tabular-nums">
                              {m.value}
                            </p>
                          </div>
                        ));
                      })()}
                    </div>
                    <p className="text-[10px] text-muted-foreground/40">
                      {perfLogs.data[0].dateStart} — {perfLogs.data[0].dateEnd}
                      {perfLogs.data.length > 1 &&
                        ` · ${perfLogs.data.length} logs total`}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {filteredCreatives.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground/50">
                    {selectedCampaignId
                      ? "Select an ad set to see details"
                      : "Select a campaign to filter"}
                  </p>
                ) : (
                  filteredCreatives.map((creative) => (
                    <Link
                      key={creative.id}
                      href={`/creatives/${creative.id}`}
                      className="flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-muted/60 transition-colors"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/40 overflow-hidden">
                        {creative.assetUrl &&
                        !creative.assetUrl.match(
                          /\.(mp4|webm|mov)(\?|$)/i,
                        ) ? (
                          <img
                            src={creative.assetUrl}
                            alt=""
                            className="size-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="size-3.5 text-muted-foreground/30" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {creative.name}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground/60">
                          {[
                            creative.format,
                            creative.awarenessLevel?.replace(/_/g, " "),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      {creative.format && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] capitalize shrink-0"
                        >
                          {creative.format}
                        </Badge>
                      )}
                    </Link>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
