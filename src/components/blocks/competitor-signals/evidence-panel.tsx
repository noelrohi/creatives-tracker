"use client";

import { angleLabels } from "@/components/blocks/insights/insights-copy";
import { ExternalLink, Flag } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ComponentMeters } from "./component-meters";
import { NO_VERDICT_NOTE } from "./copy";
import { ScoreDial } from "./score-dial";
import { TierBadge } from "./tier-badge";
import type { RankedSignal } from "./types";

const EM_DASH = "—";

const FORMAT_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  carousel: "Carousel",
};

function adLibraryUrl(metaPageId: string): string {
  return `https://www.facebook.com/ads/library/?view_all_page_id=${metaPageId}`;
}

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
          Strategic read unavailable
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
 * The detail half of the ledger: score first (dial), then the evidence that
 * produced it (meters), then the human read, then the raw facts.
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

        <ComponentMeters signal={signal} tier={signal.tier} />

        <div className="flex flex-col gap-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Strategic read
          </p>
          <StrategicRead signal={signal} />
        </div>

        <div className="flex flex-col gap-3 border-t pt-4">
          <div className="grid grid-cols-3 gap-3">
            <Fact label="Ads in cluster">
              <span className="tabular-nums">{signal.adCount}</span>
            </Fact>
            <Fact label="Formats">
              {signal.formatsObserved.length > 0
                ? signal.formatsObserved
                    .map((format) => FORMAT_LABELS[format] ?? format)
                    .join(", ")
                : EM_DASH}
            </Fact>
            <Fact label="Landing focus">
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
            href={adLibraryUrl(signal.competitor.metaPageId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ad Library <ExternalLink className="size-3.5" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
