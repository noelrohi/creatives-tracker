"use client";

import { useState, useMemo } from "react";
import { Copy, ExternalLink, MoreHorizontal, FileText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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

interface LinkedAd {
  id: string;
  metaId: string | null;
  name: string;
  caption: string | null;
  status: string | null;
  campaignName: string | null;
  destinationUrl: string | null;
  totalSpend: string | null;
  avgRoas: string | null;
  totalConversions: number | null;
  minDate: string | null;
  maxDate: string | null;
}

export function CreativeAdsTab({ ads }: { ads: LinkedAd[] | undefined }) {
  const [captionAd, setCaptionAd] = useState<LinkedAd | null>(null);

  const sharedCaption = useMemo(() => {
    if (!ads || ads.length === 0) return null;
    const captions = ads.map((a) => a.caption).filter(Boolean);
    if (captions.length === 0) return null;
    const allSame = captions.every((c) => c === captions[0]);
    return allSame ? captions[0] : null;
  }, [ads]);

  if (!ads || ads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground/50">Not used in any ads yet</p>
      </div>
    );
  }

  return (
    <>
    {sharedCaption && (
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground/50">Same caption across all ads</span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setCaptionAd(ads![0])}
        >
          <FileText className="size-3" /> View Caption
        </Button>
      </div>
    )}
    <div className="overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border/30 bg-muted/30 text-muted-foreground/60">
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
          {ads.map((ad) => (
            <tr key={ad.id} className="border-b border-border/20 last:border-0">
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
                </div>
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
                {ad.minDate ?? "—"}
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
          ))}
        </tbody>
      </table>
    </div>

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
