"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, ImageIcon, PlayIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { adLibraryAdUrl, adLibraryPageUrl } from "./ad-library";
import { AdVideoDialog, type PlayableAd } from "./ad-video-dialog";
import { DISPLAY_FORMAT_LABELS, daysSince, initials } from "./display";
import {
  AD_WORKFLOW_STATUSES,
  type AdWorkflowStatus,
  type CompetitorAd,
  type CompetitorAdsData,
} from "./types";

function formatLabel(displayFormat: string): string {
  return DISPLAY_FORMAT_LABELS[displayFormat] ?? displayFormat;
}

function isContainerFormat(displayFormat: string): boolean {
  return displayFormat === "DCO" || displayFormat === "DPA";
}

/**
 * DCO/DPA are containers — they resolve to whatever media the ad carries
 * (`resolveFormat` in src/lib/competitor-signals/score.ts), possibly both.
 * Rows filled before `mediaKinds` existed carry nothing to resolve, so they
 * stay ["Dynamic"]. The format filter matches on membership, so a mixed
 * dynamic ad shows under both "Image" and "Video".
 */
function resolveMediums(
  ad: Pick<CompetitorAd, "displayFormat" | "mediaKinds">,
): string[] {
  if (!isContainerFormat(ad.displayFormat)) {
    return [formatLabel(ad.displayFormat)];
  }
  const kinds = ad.mediaKinds ?? [];
  const mediums = [
    ...(kinds.includes("image") ? ["Image"] : []),
    ...(kinds.includes("video") ? ["Video"] : []),
  ];
  return mediums.length > 0 ? mediums : [formatLabel(ad.displayFormat)];
}

/** The container itself is worth surfacing once its medium is known. */
function badgeLabel(ad: CompetitorAd): string {
  const mediums = resolveMediums(ad);
  const medium = mediums
    .map((entry, index) => (index > 0 ? entry.toLowerCase() : entry))
    .join(" + ");
  return isContainerFormat(ad.displayFormat) &&
    medium !== formatLabel(ad.displayFormat)
    ? `${medium} · dynamic`
    : medium;
}

function AdCard({
  ad,
  competitorName,
  onPlay,
  selectable,
  selected,
  onSelectedChange,
}: {
  ad: CompetitorAd;
  competitorName: string;
  onPlay: (playable: PlayableAd) => void;
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (next: boolean) => void;
}) {
  const videoUrl = ad.videoUrl;
  // Natural image height — the masonry columns need each tile's own aspect.
  // `auto 4/5` reserves a 4:5 box until the image loads (dimensions aren't
  // stored at ingest), then yields to the natural ratio — without it, lazy
  // images mount at zero height and every load rebalances the columns.
  const creative = ad.thumbnailUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- mirrored blob URLs; images are unoptimized anyway
    <img
      src={ad.thumbnailUrl}
      alt={`${competitorName} ad`}
      className="w-full [aspect-ratio:auto_4/5]"
      loading="lazy"
    />
  ) : (
    <div className="flex aspect-[4/5] w-full items-center justify-center bg-muted">
      <ImageIcon className="size-6 text-muted-foreground/40" />
    </div>
  );

  return (
    <div
      className={cn(
        "group relative mb-4 break-inside-avoid overflow-hidden rounded-xl bg-muted",
        selected && "ring-2 ring-primary",
      )}
    >
      {videoUrl ? (
        <button
          type="button"
          aria-label="Play video"
          className="block w-full cursor-pointer"
          onClick={() =>
            onPlay({ videoUrl, title: `${competitorName} video ad` })
          }
        >
          {creative}
        </button>
      ) : (
        creative
      )}
      {ad.isVideo && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-black/50">
            <PlayIcon className="size-4 text-white" />
          </span>
        </div>
      )}
      {/* The tick sits above the creative, so its clicks must never reach the
          play button underneath it. Always visible: triage is the job here,
          and a hover-only control hides the whole workflow on touch. */}
      {selectable && (
        <div
          className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-lg bg-white/92 shadow"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(next) => onSelectedChange(next === true)}
            aria-label={`Select ad ${ad.archiveId}`}
          />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-12 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex items-center justify-between text-[11px] text-white/80">
          <span className="font-semibold text-white tabular-nums">
            {daysSince(ad.startDate) ?? 0} days
          </span>
          <span>Since {format(ad.startDate, "MMM d")}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-full border border-white/30 px-2 py-0.5 text-[11px] text-white">
            {badgeLabel(ad)}
          </span>
          <a
            href={adLibraryAdUrl(ad.archiveId)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View in Ad Library"
            className="pointer-events-auto flex items-center gap-1 text-xs font-medium text-white hover:underline"
          >
            Ad Library <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

// Select item values for real options carry this prefix so the "all" sentinel
// can never collide with an option that is literally named "all" — the URL
// itself uses absence for "all" and the raw label otherwise.
const ALL = "all";
const OPTION_PREFIX = "option:";

function toItemValue(entry: string | null): string {
  return entry === null ? ALL : `${OPTION_PREFIX}${entry}`;
}

function fromItemValue(value: string): string | null {
  return value === ALL ? null : value.slice(OPTION_PREFIX.length);
}

/**
 * The triage tabs, in the order an ad walks them. "All ads" means all: it
 * shows every ad whatever its stage, so moving one files it under its stage
 * tab without ever shrinking the full pile.
 */
const TAB_LABELS: Record<AdWorkflowStatus, string> = {
  inbox: "All ads",
  shortlist: "Shortlist",
  deprioritised: "Deprioritised",
  made: "Made ad",
};

/** What a genuinely empty tab says; a tab merely filtered to nothing blames the filters instead. */
const EMPTY_COPY: Record<AdWorkflowStatus, string> = {
  inbox: "No active ads for this competitor",
  shortlist:
    "Nothing shortlisted yet — tick ads under All ads and add them here",
  deprioritised: "No deprioritised ads",
  made: "No ads made yet — move shortlisted ads here with Make ad",
};

/** Only the two working tabs are triaged from; the other two are archives. */
function isSelectableTab(status: AdWorkflowStatus): boolean {
  return status === "inbox" || status === "shortlist";
}

/**
 * Every ad still active as of the last fill, longest-running first. The data
 * ships complete (a fill caps at 200 ads), so the workflow tab, format/theme
 * filters and the sort all run entirely on the client. Filters live in the URL
 * (nuqs) so a signal's "See all N" can land here already narrowed to that
 * theme, and a filtered view survives reload and sharing.
 */
export function CompetitorAdsGrid({ data }: { data: CompetitorAdsData }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useQueryState(
    "status",
    parseAsStringLiteral(AD_WORKFLOW_STATUSES).withDefault("inbox"),
  );
  const [formatFilter, setFormatFilter] = useQueryState(
    "format",
    parseAsString,
  );
  const [themeFilter, setThemeFilter] = useQueryState("theme", parseAsString);
  const [sort, setSort] = useQueryState(
    "sort",
    parseAsStringLiteral(["longest", "newest"] as const).withDefault("longest"),
  );
  const [playing, setPlaying] = useState<PlayableAd | null>(null);
  // A tick means "this ad, on this tab" — carrying it across tabs would let a
  // bar action fire against ads no longer on screen, so the selection records
  // the tab it was made on and reads as empty anywhere else.
  const [selection, setSelection] = useState<{
    status: AdWorkflowStatus;
    ids: string[];
  }>({ status, ids: [] });
  const selectedIds = selection.status === status ? selection.ids : [];
  const setSelectedIds = (ids: string[]) => setSelection({ status, ids });

  const setWorkflowStatus = useMutation(
    trpc.signals.setAdWorkflowStatus.mutationOptions({
      onSuccess: () => {
        setSelectedIds([]);
        queryClient.invalidateQueries({
          queryKey: trpc.signals.listCompetitorAds.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  // "All ads" counts and shows the whole pile; the stage tabs are subsets.
  const counts = useMemo(() => {
    const tally: Record<AdWorkflowStatus, number> = {
      inbox: data.ads.length,
      shortlist: 0,
      deprioritised: 0,
      made: 0,
    };
    for (const ad of data.ads) {
      if (ad.workflowStatus !== "inbox") {
        tally[ad.workflowStatus] += 1;
      }
    }
    return tally;
  }, [data.ads]);

  const inTab = useMemo(
    () =>
      status === "inbox"
        ? data.ads
        : data.ads.filter((ad) => ad.workflowStatus === status),
    [data.ads, status],
  );

  const formats = useMemo(
    () => [...new Set(data.ads.flatMap(resolveMediums))],
    [data.ads],
  );
  const themes = useMemo(() => {
    const known = [
      ...new Set(data.ads.flatMap((ad) => (ad.theme ? [ad.theme] : []))),
    ];
    // A linked-in theme that no active ad carries any more (clusters are wiped
    // and rebuilt on every fill) still needs to render in the select, so the
    // empty result reads as "0 ads for this theme", not as a blank control.
    if (themeFilter !== null && !known.includes(themeFilter)) {
      known.push(themeFilter);
    }
    return known;
  }, [data.ads, themeFilter]);

  const visible = useMemo(() => {
    const filtered = inTab.filter(
      (ad) =>
        (formatFilter === null || resolveMediums(ad).includes(formatFilter)) &&
        (themeFilter === null || ad.theme === themeFilter),
    );
    // The server returns startDate ascending — longest running first.
    return sort === "longest" ? filtered : [...filtered].reverse();
  }, [inTab, formatFilter, themeFilter, sort]);

  const selectable = isSelectableTab(status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground">
            {initials(data.competitor.name)}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {data.competitor.name} — all ads
            </h1>
            <p className="text-sm text-muted-foreground">
              Active ads in the Meta Ad Library
              {data.updatedAt &&
                ` · updated ${formatDistanceToNow(data.updatedAt, { addSuffix: true })}`}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a
            href={adLibraryPageUrl(data.competitor.metaPageId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open page in Ad Library <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>

      <nav className="flex w-fit items-center gap-1 rounded-full border bg-muted/40 p-1">
        {AD_WORKFLOW_STATUSES.map((entry) => {
          const isActive = entry === status;
          return (
            <button
              key={entry}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => setStatus(entry)}
              className={cn(
                "rounded-full px-3 py-1 text-sm font-medium transition-colors",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABELS[entry]}{" "}
              <span className="tabular-nums">{counts[entry]}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select
            value={toItemValue(formatFilter)}
            onValueChange={(value) => setFormatFilter(fromItemValue(value))}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Format filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All formats</SelectItem>
              {formats.map((entry) => (
                <SelectItem key={entry} value={toItemValue(entry)}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {themes.length > 0 && (
            <Select
              value={toItemValue(themeFilter)}
              onValueChange={(value) => setThemeFilter(fromItemValue(value))}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Theme filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All themes</SelectItem>
                {themes.map((entry) => (
                  <SelectItem key={entry} value={toItemValue(entry)}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={sort}
            onValueChange={(value) => setSort(value as typeof sort)}
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="longest">Sort: longest running</SelectItem>
              <SelectItem value="newest">Sort: newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="text-[13px] text-muted-foreground tabular-nums">
          {visible.length} {visible.length === 1 ? "ad" : "ads"}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed py-16 text-sm text-muted-foreground">
          {inTab.length > 0 ? "No ads match these filters" : EMPTY_COPY[status]}
        </div>
      ) : (
        <div className="columns-2 gap-4 sm:columns-3 lg:columns-4">
          {visible.map((ad) => (
            <AdCard
              key={ad.id}
              ad={ad}
              competitorName={data.competitor.name}
              onPlay={setPlaying}
              selectable={selectable}
              selected={selectedIds.includes(ad.id)}
              onSelectedChange={(next) =>
                setSelectedIds(
                  next
                    ? [...selectedIds, ad.id]
                    : selectedIds.filter((id) => id !== ad.id),
                )
              }
            />
          ))}
        </div>
      )}

      {selectable && selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-background px-3 py-2 shadow-lg ring-1 ring-foreground/10">
          <span className="px-1 text-sm font-medium tabular-nums">
            {selectedIds.length} selected
          </span>
          <Separator orientation="vertical" className="h-5" />
          {status === "inbox" ? (
            <Button
              size="sm"
              className="rounded-full"
              disabled={setWorkflowStatus.isPending}
              onClick={() =>
                setWorkflowStatus.mutate({
                  adIds: selectedIds,
                  status: "shortlist",
                })
              }
            >
              Add to Shortlist
            </Button>
          ) : (
            <Button
              size="sm"
              className="rounded-full"
              disabled={setWorkflowStatus.isPending}
              onClick={() =>
                setWorkflowStatus.mutate({ adIds: selectedIds, status: "made" })
              }
            >
              Make ad
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={setWorkflowStatus.isPending}
            onClick={() =>
              setWorkflowStatus.mutate({
                adIds: selectedIds,
                status: "deprioritised",
              })
            }
          >
            Deprioritise
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            onClick={() => setSelectedIds([])}
          >
            Clear
          </Button>
        </div>
      )}

      <AdVideoDialog ad={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}
