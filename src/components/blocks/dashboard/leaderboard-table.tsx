import Link from "next/link";
import { ArrowRight, ImageIcon, Leaf, Sparkles, Upload, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CreativeHealth } from "@/lib/creative-health";
import { fmtMoney, fmtNum, fmtRoas } from "@/lib/fmt";

export type LeaderboardRow = {
  id: string;
  name: string;
  format: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
  totalSpend: string;
  roas: string;
  cpa: string | null;
  ctr: string | null;
  conversions: string;
  adStatus: string | null;
  runningDays?: number;
  health?: CreativeHealth | null;
  healthReasons?: string[];
  bleederAdCount?: number;
  activeAdCount?: number;
  bleederSpend?: string | null;
  bleederDollarsAtRisk?: string | null;
  hasWinnerAd?: boolean;
  bleederMetaIds?: string[];
  tier?: "pause_now" | "watch" | null;
  isEvergreen?: boolean;
};

const HEALTH_STYLES: Record<CreativeHealth, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  warning: { label: "Warning", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  critical: { label: "Critical", className: "bg-red-500/15 text-red-500 dark:text-red-400" },
};

function BleederBadge({ row }: { row: LeaderboardRow }) {
  if (!row.bleederAdCount || row.bleederAdCount <= 0) return null;
  const total = row.activeAdCount ?? row.bleederAdCount;
  const atRisk = row.bleederDollarsAtRisk ? parseFloat(row.bleederDollarsAtRisk) : 0;
  const isPauseNow = row.tier === "pause_now";
  const className = isPauseNow
    ? "bg-red-500/15 text-red-500 dark:text-red-400"
    : "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  const label = isPauseNow ? "Pause" : "Watch";
  const tooltipBody = isPauseNow
    ? `${row.bleederAdCount} of ${total} active ad${total === 1 ? "" : "s"} have spent ≥ 1× portfolio CPA over 5+ days with no conversions (or ROAS < 0.5). Confident dead — pause.`
    : `${row.bleederAdCount} of ${total} active ad${total === 1 ? "" : "s"} are bleeding but haven't had a fair shot on both spend and time. Watch — confirm before pausing.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex cursor-help items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium ${className}`}>
          {label} · {row.bleederAdCount}/{total} · {fmtMoney(atRisk)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>{tooltipBody}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function WinnerSiblingBadge({ row }: { row: LeaderboardRow }) {
  if (!row.hasWinnerAd) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
          <Sparkles className="size-2.5" /> winner sibling
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>
          A different ad on this creative is profitable (ROAS ≥ 1, spend ≥ $25). The
          creative concept works — likely an audience/placement issue on the bleeders.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function EvergreenBadge({ row }: { row: LeaderboardRow }) {
  if (!row.isEvergreen) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label="Evergreen"
          className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        >
          <Leaf className="size-2.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>
          <strong>Evergreen.</strong> Top performer that&apos;s also been running 14+ days — long-term workhorse, protect this one.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function HealthBadge({ row }: { row: LeaderboardRow }) {
  if (!row.health) return null;
  const style = HEALTH_STYLES[row.health];
  const reasons = row.healthReasons ?? [];
  const badge = (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-medium ${style.className}`}>
      {style.label}
    </span>
  );
  if (reasons.length === 0) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <ul className="list-disc pl-4 space-y-0.5">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function MediaPreview({ row }: { row: LeaderboardRow }) {
  const href = row.videoUrl || row.assetUrl;

  if (!href) {
    return (
      <div className="flex size-8 items-center justify-center rounded bg-muted">
        <ImageIcon className="size-3.5 text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="block"
    >
      {row.assetUrl ? (
        <div className="relative size-8 overflow-hidden rounded bg-muted">
          <img src={row.assetUrl} alt="" className="size-full object-cover" />
          {row.format === "video" && (
            <Video className="absolute inset-0 m-auto size-3.5 text-white drop-shadow" />
          )}
        </div>
      ) : (
        <div className="flex size-8 items-center justify-center rounded bg-muted">
          {row.format === "video" ? (
            <Video className="size-3.5 text-muted-foreground/60" />
          ) : (
            <ImageIcon className="size-3.5 text-muted-foreground/40" />
          )}
        </div>
      )}
    </a>
  );
}

export function LeaderboardTable({
  title,
  icon,
  rows,
  isLoading,
  emptyMessage,
  viewAllHref,
  canManageData,
}: {
  title: string;
  icon: React.ReactNode;
  rows: LeaderboardRow[];
  isLoading: boolean;
  emptyMessage: string;
  viewAllHref: string;
  canManageData: boolean;
}) {
  if (isLoading) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            {title}
          </h2>
        </div>
        <div className="rounded-lg border divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <div className="flex-1" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            {title}
          </h2>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          {canManageData ? (
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link href="/import">
                <Upload className="size-3.5" /> Import Ads
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
            {title}
          </h2>
        </div>
        <Button variant="ghost" size="sm" asChild className="text-[13px] text-muted-foreground">
          <Link href={viewAllHref}>
            View All <ArrowRight className="ml-1 size-3" />
          </Link>
        </Button>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Creative</TableHead>
              <TableHead className="text-right">Conv</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
              <TableHead className="text-right">CPA</TableHead>
              <TableHead className="text-right">Spend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const roas = row.roas ? parseFloat(row.roas) : null;
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <MediaPreview row={row} />
                      <Link href={`/creatives/${row.id}`} className="text-sm font-medium hover:underline truncate max-w-[200px]">
                        {row.name}
                      </Link>
                      {row.format && (
                        <Badge variant="secondary" className="text-[11px] capitalize shrink-0">{row.format}</Badge>
                      )}
                      {row.adStatus && (
                        <Badge variant="outline" className="text-[11px] capitalize shrink-0">{row.adStatus}</Badge>
                      )}
                      {row.bleederAdCount && row.bleederAdCount > 0 ? (
                        <>
                          <BleederBadge row={row} />
                          <WinnerSiblingBadge row={row} />
                        </>
                      ) : (
                        <>
                          <HealthBadge row={row} />
                          <EvergreenBadge row={row} />
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium">
                    {fmtNum(row.conversions)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    <span className={roas != null && roas >= 1 ? "text-emerald-500" : roas != null ? "text-red-400" : ""}>
                      {fmtRoas(row.roas)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {fmtMoney(row.cpa)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {fmtMoney(row.totalSpend)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
