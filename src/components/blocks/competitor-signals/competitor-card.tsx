"use client";

import { format, formatDistanceToNow } from "date-fns";
import Link from "next/link";
import {
  Archive,
  ArrowRight,
  ExternalLink,
  MoreHorizontal,
  TriangleAlert,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { adLibraryPageUrl } from "./ad-library";
import { AdPreviewStrip } from "./ad-preview-strip";
import { NO_FILLS_NOTE } from "./copy";
import { daysSince, initials } from "./display";
import { TierBadge } from "./tier-badge";
import type { Competitor } from "./types";

const EM_DASH = "—";

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * The header meta line: when the data was last refreshed, in plain words. A
 * failed run points at the last successful one — that is the date the numbers
 * on the card actually describe.
 */
function updatedLine(competitor: Competitor): string | null {
  const { lastFill, lastSuccessfulFillAt, activeAdCount } = competitor;
  if (!lastFill) return null;

  if (lastFill.pipelineStatus === "failed") {
    if (lastSuccessfulFillAt) {
      return `Updated ${format(lastSuccessfulFillAt, "MMM d")} · ${activeAdCount} ads`;
    }
    // No complete fill yet, but a partial one may still have left ads behind.
    return activeAdCount > 0
      ? `Last update failed · ${activeAdCount} ${activeAdCount === 1 ? "ad" : "ads"}`
      : "Last update failed";
  }

  const when = formatDistanceToNow(lastFill.filledAt, { addSuffix: true });
  return `Updated ${when} · ${activeAdCount} ${activeAdCount === 1 ? "ad" : "ads"}`;
}

export function CompetitorCard({
  competitor,
  onArchive,
  archiveDisabled,
}: {
  competitor: Competitor;
  onArchive: (competitorId: string) => void;
  archiveDisabled: boolean;
}) {
  const oldestDays = daysSince(competitor.oldestStartDate);
  const failed = competitor.lastFill?.pipelineStatus === "failed";
  const hiddenAdCount = competitor.activeAdCount - competitor.recentAds.length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-bold text-muted-foreground">
            {initials(competitor.name)}
          </div>
          <div className="min-w-0">
            <CardTitle>{competitor.name}</CardTitle>
            <CardDescription>
              {updatedLine(competitor) ?? NO_FILLS_NOTE}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Card actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={archiveDisabled}
                onSelect={() => onArchive(competitor.id)}
              >
                <Archive className="size-4" /> Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {competitor.recentAds.length > 0 && (
          <AdPreviewStrip
            ads={competitor.recentAds}
            alt={`${competitor.name} ad`}
            hiddenCount={hiddenAdCount}
            thumbClassName="h-[95px] w-[76px] rounded-lg"
          />
        )}

        <div className="grid grid-cols-3 gap-2">
          <StatTile
            label="Active ads"
            value={
              competitor.activeAdCount > 0
                ? String(competitor.activeAdCount)
                : EM_DASH
            }
          />
          <StatTile
            label="Longest running"
            value={oldestDays === null ? EM_DASH : `${oldestDays} days`}
          />
          <StatTile
            label="Ad themes"
            value={
              competitor.clusterCount > 0
                ? String(competitor.clusterCount)
                : EM_DASH
            }
          />
        </div>

        {competitor.topClusters.length > 0 && (
          <ul className="flex flex-col gap-2.5">
            {competitor.topClusters.map((cluster) => {
              const clusterDays = daysSince(cluster.oldestStartDate);
              return (
                <li
                  key={cluster.id}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">
                      {cluster.label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {clusterDays !== null && `${clusterDays} days · `}
                      {cluster.adCount} {cluster.adCount === 1 ? "ad" : "ads"}
                    </p>
                  </div>
                  {cluster.tier && (
                    <div className="shrink-0">
                      <TierBadge tier={cluster.tier} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {failed && competitor.lastFill && (
          <div
            className="flex items-start gap-2 text-[13px]"
            style={{ color: "var(--attr-critical)" }}
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Update failed{" "}
              {formatDistanceToNow(competitor.lastFill.filledAt, {
                addSuffix: true,
              })}
              {competitor.lastFill.error && ` — ${competitor.lastFill.error}`}
              {competitor.lastSuccessfulFillAt
                ? ` — showing ${format(competitor.lastSuccessfulFillAt, "MMM d")} data.`
                : "."}
            </span>
          </div>
        )}
      </CardContent>

      <CardFooter className="justify-between gap-3">
        <Button variant="outline" size="sm" asChild>
          <Link href={`/competitors/${competitor.id}`}>
            {competitor.activeAdCount > 0
              ? `View all ${competitor.activeAdCount} ads`
              : "View ads"}{" "}
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a
            href={adLibraryPageUrl(competitor.metaPageId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Meta Ad Library <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}
