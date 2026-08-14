"use client";

import { differenceInCalendarDays, formatDistanceToNow } from "date-fns";
import { Archive, MoreHorizontal, TriangleAlert } from "@/components/icons";
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
import { NO_FILLS_NOTE, sourceLabel } from "./copy";
import { ScoreBadge, TierBadge } from "./tier-badge";
import type { Competitor } from "./types";

const EM_DASH = "—";

/** "105d" — the age of the longest-running ad still live on the page. */
function oldestAdAge(oldestStartDate: Date | null): string {
  if (!oldestStartDate) return EM_DASH;
  const days = differenceInCalendarDays(new Date(), oldestStartDate);
  return days >= 0 ? `${days}d` : EM_DASH;
}

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
 * The last fill run is the card's only freshness signal — collection happens on
 * the operator's device, so there is nothing here to press.
 */
function LastFillLine({ lastFill }: { lastFill: Competitor["lastFill"] }) {
  if (!lastFill) {
    return (
      <p className="text-[13px] text-muted-foreground/60">{NO_FILLS_NOTE}</p>
    );
  }

  const when = formatDistanceToNow(lastFill.filledAt, { addSuffix: true });

  if (lastFill.pipelineStatus === "failed") {
    return (
      <div
        className="flex items-start gap-2 text-[13px]"
        style={{ color: "var(--attr-critical)" }}
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Last fill {when} failed
          {lastFill.error ? ` — ${lastFill.error}` : null}
        </span>
      </div>
    );
  }

  return (
    <p className="text-[13px] text-muted-foreground">
      Last filled {when} · {lastFill.adCount}{" "}
      {lastFill.adCount === 1 ? "ad" : "ads"} · {sourceLabel(lastFill.source)}
    </p>
  );
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{competitor.name}</CardTitle>
        <CardDescription>Meta page {competitor.metaPageId}</CardDescription>
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
            label="Clusters"
            value={
              competitor.clusterCount > 0
                ? String(competitor.clusterCount)
                : EM_DASH
            }
          />
          <StatTile
            label="Oldest ad"
            value={oldestAdAge(competitor.oldestStartDate)}
          />
        </div>

        {competitor.topClusters.length > 0 && (
          <ul className="flex flex-col gap-2">
            {competitor.topClusters.map((cluster) => (
              <li
                key={cluster.id}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">
                    {cluster.label}
                  </p>
                  {cluster.angle && (
                    <p className="truncate text-[11px] text-muted-foreground/70">
                      {cluster.angle}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {cluster.score !== null && <ScoreBadge score={cluster.score} />}
                  {cluster.tier && <TierBadge tier={cluster.tier} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CardFooter>
        <LastFillLine lastFill={competitor.lastFill} />
      </CardFooter>
    </Card>
  );
}
