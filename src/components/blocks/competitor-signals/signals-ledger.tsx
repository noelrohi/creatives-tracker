"use client";

import { cn } from "@/lib/utils";
import { AdThumbnail } from "./ad-thumbnail";
import { angleLabel } from "./copy";
import { daysSince } from "./display";
import { TierBadge } from "./tier-badge";
import type { RankedSignal } from "./types";

const EM_DASH = "—";

function subLine(signal: RankedSignal): string {
  const parts = [signal.competitor.name];
  if (signal.angle) parts.push(angleLabel(signal.angle));
  const days = daysSince(signal.oldestStartDate);
  if (days !== null) parts.push(`${days} days`);
  parts.push(`${signal.adCount} ${signal.adCount === 1 ? "ad" : "ads"}`);
  return parts.join(" · ");
}

/**
 * The ranking half of the ledger (§10): rank, the message with its
 * competitor/angle meta and a glimpse of its ads, then the score and the tier
 * in words. Selection drives the evidence panel; the row itself carries no
 * other actions.
 */
export function SignalsLedger({
  signals,
  selectedId,
  onSelect,
}: {
  signals: RankedSignal[];
  selectedId: string | null;
  onSelect: (signalId: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <span className="w-5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          #
        </span>
        <span className="flex-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          Message
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
          Strength
        </span>
      </div>
      {signals.map((signal, index) => {
        const selected = signal.id === selectedId;
        const previews = signal.previewAds.slice(0, 2);

        return (
          <button
            key={signal.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(signal.id)}
            className={cn(
              "flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0",
              selected
                ? "bg-muted/60 shadow-[inset_2px_0_0_var(--primary)]"
                : "hover:bg-muted/30",
            )}
          >
            <span className="w-5 shrink-0 text-[13px] tabular-nums text-muted-foreground/70">
              {index + 1}
            </span>
            {previews.length > 0 && (
              <span className="flex shrink-0">
                {previews.map((ad, previewIndex) => (
                  <AdThumbnail
                    key={ad.archiveId}
                    thumbnailUrl={ad.thumbnailUrl}
                    isVideo={false}
                    alt=""
                    className={cn(
                      "h-12 w-[38px] rounded-md ring-2 ring-card",
                      previewIndex > 0 && "-ml-3.5",
                    )}
                  />
                ))}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">
                {signal.label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {subLine(signal)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {signal.score !== null && (
                <span className="text-[13px] tabular-nums text-muted-foreground">
                  {Math.round(signal.score)}
                </span>
              )}
              {signal.tier ? (
                <TierBadge tier={signal.tier} />
              ) : (
                <span className="text-[13px] text-muted-foreground/60">
                  {EM_DASH}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
