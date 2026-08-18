"use client";

import { format, formatDistanceToNow } from "date-fns";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo, useState } from "react";
import { ExternalLink } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adLibraryAdUrl, adLibraryPageUrl } from "./ad-library";
import { AdThumbnail } from "./ad-thumbnail";
import { AdVideoDialog, type PlayableAd } from "./ad-video-dialog";
import { DISPLAY_FORMAT_LABELS, daysSince, initials } from "./display";
import type { CompetitorAd, CompetitorAdsData } from "./types";

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
}: {
  ad: CompetitorAd;
  competitorName: string;
  onPlay: (playable: PlayableAd) => void;
}) {
  const videoUrl = ad.videoUrl;
  const creative = (
    <AdThumbnail
      thumbnailUrl={ad.thumbnailUrl}
      isVideo={ad.isVideo}
      alt={`${competitorName} ad`}
      className="aspect-[4/5] w-full"
    />
  );

  return (
    <Card size="sm" className="gap-0 py-0">
      <div className="relative">
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
        <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums">
          {daysSince(ad.startDate) ?? 0} days
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <Badge variant="outline" className="font-normal">
          {badgeLabel(ad)}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Since {format(ad.startDate, "MMM d")}
        </span>
      </div>
      <a
        href={adLibraryAdUrl(ad.archiveId)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 border-t px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
      >
        View in Ad Library <ExternalLink className="size-3" />
      </a>
    </Card>
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
 * Every ad still active as of the last fill, longest-running first. The data
 * ships complete (a fill caps at 200 ads), so format/theme filters and the
 * sort run entirely on the client. Filters live in the URL (nuqs) so a
 * signal's "See all N" can land here already narrowed to that theme, and a
 * filtered view survives reload and sharing.
 */
export function CompetitorAdsGrid({ data }: { data: CompetitorAdsData }) {
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
    const filtered = data.ads.filter(
      (ad) =>
        (formatFilter === null || resolveMediums(ad).includes(formatFilter)) &&
        (themeFilter === null || ad.theme === themeFilter),
    );
    // The server returns startDate ascending — longest running first.
    return sort === "longest" ? filtered : [...filtered].reverse();
  }, [data.ads, formatFilter, themeFilter, sort]);

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
          No ads match these filters
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {visible.map((ad) => (
            <AdCard
              key={ad.id}
              ad={ad}
              competitorName={data.competitor.name}
              onPlay={setPlaying}
            />
          ))}
        </div>
      )}

      <AdVideoDialog ad={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}
