import Link from "next/link";
import { ArrowRight, Copy, ExternalLink, ImageIcon, MoreHorizontal, Sparkles, Upload, Video } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-500 dark:text-red-400">
          {row.bleederAdCount}/{total} · {fmtMoney(atRisk)} risk
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        <p>
          {row.bleederAdCount} of {total} active ad{total === 1 ? "" : "s"} on this creative
          spent ≥ $25 with 0 conversions or ROAS &lt; 0.5.
        </p>
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
      <TooltipContent side="left" className="max-w-xs">
        <p>
          A different ad on this creative is profitable (ROAS ≥ 1, spend ≥ $25). The
          creative concept works — likely an audience/placement issue on the bleeders.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function BleederRowMenu({ row }: { row: LeaderboardRow }) {
  const ids = row.bleederMetaIds ?? [];
  if (ids.length === 0) return null;
  const handleCopy = async () => {
    const payload = ids.join(", ");
    try {
      await navigator.clipboard.writeText(payload);
      toast.success(`Copied ${ids.length} Meta ID${ids.length === 1 ? "" : "s"}`, {
        description: "Paste into Meta Ads Manager search to pause.",
      });
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label="Bleeder ad actions"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          {ids.length} bleeding ad{ids.length === 1 ? "" : "s"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleCopy} className="gap-2">
          <Copy className="size-3.5" />
          Copy Meta IDs
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="gap-2">
          <Link href={`/creatives/${row.id}`}>
            <ExternalLink className="size-3.5" />
            Open creative
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
      <TooltipContent side="left" className="max-w-xs">
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
                      {row.bleederAdCount && row.bleederAdCount > 0 ? (
                        <>
                          <BleederBadge row={row} />
                          <WinnerSiblingBadge row={row} />
                          <BleederRowMenu row={row} />
                        </>
                      ) : (
                        <>
                          {row.format && (
                            <Badge variant="secondary" className="text-[11px] capitalize shrink-0">{row.format}</Badge>
                          )}
                          {row.adStatus && (
                            <Badge variant="outline" className="text-[11px] capitalize shrink-0">{row.adStatus}</Badge>
                          )}
                          <HealthBadge row={row} />
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
