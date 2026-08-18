"use client";

import Link from "next/link";
import { useState } from "react";
import { angleLabels } from "@/components/blocks/insights/insights-copy";
import { ExternalLink, Flag } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { adLibraryAdUrl, adLibraryPageUrl } from "./ad-library";
import { AdThumbnail } from "./ad-thumbnail";
import { AdVideoDialog, type PlayableAd } from "./ad-video-dialog";
import { ComponentMeters } from "./component-meters";
import { NO_VERDICT_NOTE } from "./copy";
import { RESOLVED_FORMAT_LABELS } from "./display";
import { ScoreDial } from "./score-dial";
import { ScoreExplainer } from "./score-explainer";
import { TierBadge } from "./tier-badge";
import type { RankedSignal } from "./types";

const EM_DASH = "—";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <div className="truncate text-[13px]">{children}</div>
    </div>
  );
}

/** The strategic read, or the flag that says why there isn't one (§8/§10). */
function StrategicRead({ signal }: { signal: RankedSignal }) {
  if (!signal.verdict) {
    return (
      <div className="flex flex-col gap-1.5">
        <Badge
          variant="outline"
          className="w-fit gap-1"
          style={{ color: "var(--attr-warning)" }}
        >
          <Flag className="size-3" />
          Read unavailable
        </Badge>
        <p className="text-[13px] italic text-muted-foreground/70">
          {NO_VERDICT_NOTE}
        </p>
      </div>
    );
  }

  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      {signal.verdictRationale ?? EM_DASH}
    </p>
  );
}

/**
 * The mirrored creatives behind the signal. An image opens its own Ad Library
 * detail; a mirrored video plays right here, with the corner chip carrying the
 * Ad Library link instead.
 */
function SignalAds({ signal }: { signal: RankedSignal }) {
  const [playing, setPlaying] = useState<PlayableAd | null>(null);

  if (signal.previewAds.length === 0) return null;

  const hiddenCount = signal.adCount - signal.previewAds.length;
  // Lands on the competitor grid already narrowed to this signal's theme —
  // the grid's theme filter is URL state and themes are cluster labels.
  const allAdsHref = `/competitors/${signal.competitor.id}?theme=${encodeURIComponent(signal.label)}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
          The ads behind this signal
        </p>
        <Link
          href={allAdsHref}
          className="text-xs font-medium text-primary hover:underline"
        >
          See all {signal.adCount}
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {signal.previewAds.map((ad) => {
          const videoUrl = ad.videoUrl;
          const creative = (
            <AdThumbnail
              thumbnailUrl={ad.thumbnailUrl}
              isVideo={ad.isVideo}
              alt={`${signal.competitor.name} ad`}
              className="aspect-[4/5] w-full rounded-md"
            />
          );
          const cornerChip = (
            <span className="flex size-4 items-center justify-center rounded bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
              <ExternalLink className="size-2.5 text-white" />
            </span>
          );

          if (videoUrl) {
            return (
              <div key={ad.archiveId} className="group relative">
                <button
                  type="button"
                  aria-label="Play video"
                  className="block w-full cursor-pointer"
                  onClick={() =>
                    setPlaying({
                      videoUrl,
                      title: `${signal.competitor.name} video ad`,
                    })
                  }
                >
                  {creative}
                </button>
                <a
                  href={adLibraryAdUrl(ad.archiveId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View ad in Meta Ad Library"
                  className="absolute right-1.5 top-1.5"
                >
                  {cornerChip}
                </a>
              </div>
            );
          }

          return (
            <a
              key={ad.archiveId}
              href={adLibraryAdUrl(ad.archiveId)}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative block"
              aria-label="View ad in Meta Ad Library"
            >
              {creative}
              <span className="absolute right-1.5 top-1.5">{cornerChip}</span>
            </a>
          );
        })}
        {hiddenCount > 0 && (
          <Link
            href={allAdsHref}
            className="flex aspect-[4/5] items-center justify-center rounded-md border bg-muted/60 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            +{hiddenCount}
          </Link>
        )}
      </div>

      <AdVideoDialog ad={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}

/**
 * The detail half of the ledger: score first (dial), then the evidence that
 * produced it (meters), then the human read, then the ads themselves, then
 * the raw facts.
 */
export function EvidencePanel({ signal }: { signal: RankedSignal }) {
  const angle = signal.angle
    ? (angleLabels[signal.angle] ?? signal.angle)
    : null;

  return (
    <Card className="lg:sticky lg:top-4">
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-start gap-4">
          <ScoreDial score={signal.score} tier={signal.tier} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="text-sm font-semibold">{signal.label}</h2>
            <p className="text-[13px] text-muted-foreground">
              {signal.competitor.name}
              {angle ? ` · ${angle}` : null}
            </p>
            {signal.tier ? (
              <div>
                <TierBadge tier={signal.tier} />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground/60">
                Not scored yet
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
              Behind the score
            </p>
            <ScoreExplainer />
          </div>
          <ComponentMeters signal={signal} tier={signal.tier} />
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            What this means
          </p>
          <StrategicRead signal={signal} />
        </div>

        <SignalAds signal={signal} />

        <div className="flex flex-col gap-3 border-t pt-4">
          <div className="grid grid-cols-3 gap-3">
            <Fact label="Ads">
              <span className="tabular-nums">{signal.adCount}</span>
            </Fact>
            <Fact label="Formats">
              {signal.formatsObserved.length > 0
                ? signal.formatsObserved
                    .map((format) => RESOLVED_FORMAT_LABELS[format] ?? format)
                    .join(", ")
                : EM_DASH}
            </Fact>
            <Fact label="Top landing page">
              {signal.landingFocusUrl ? (
                <span title={signal.landingFocusUrl}>
                  {signal.landingFocusUrl} (
                  {Math.round(signal.landingFocusShare * 100)}%)
                </span>
              ) : (
                EM_DASH
              )}
            </Fact>
          </div>

          <a
            className="flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
            href={adLibraryPageUrl(signal.competitor.metaPageId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Ad Library <ExternalLink className="size-3.5" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
