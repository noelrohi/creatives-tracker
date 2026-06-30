"use client";

import Link from "next/link";
import { ChevronDown, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtMoney, fmtNum, fmtRoas } from "@/lib/fmt";
import { cn } from "@/lib/utils";
import { MediaPreview, Metric } from "./recommendation-ui";
import type { RecommendationCandidate } from "./types";
import { VariantRowItem } from "./variant-row-item";

function getCandidateSubtitle(candidate: RecommendationCandidate) {
  const signals = [candidate.angle, candidate.persona, candidate.hook]
    .map((signal) => signal?.trim())
    .filter((signal): signal is string => Boolean(signal));

  if (signals.length > 0) {
    return signals.join(" · ");
  }

  return candidate.sourceAdName !== candidate.sourceCreativeName
    ? candidate.sourceAdName
    : null;
}

export function WinnerCard({
  candidate,
  fromValue,
  toValue,
  isOpen,
  canWrite,
  generating,
  reviewPending,
  onToggle,
  onGenerate,
  onReview,
  onOpenPlayable,
}: {
  candidate: RecommendationCandidate;
  fromValue: string;
  toValue: string;
  isOpen: boolean;
  canWrite: boolean;
  generating: boolean;
  reviewPending: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  onReview: (input: { variantId: string; status: "good" | "bad" }) => void;
  onOpenPlayable: () => void;
}) {
  const batch = candidate.latestBatch;
  const subtitle = getCandidateSubtitle(candidate);
  const goodCount = batch?.goodCount ?? 0;
  const totalCount = batch?.variants.length ?? 0;

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="grid gap-4 p-4 sm:grid-cols-[112px_1fr]">
        <MediaPreview
          assetUrl={candidate.assetUrl}
          videoUrl={candidate.videoUrl}
          format={candidate.format}
          name={candidate.sourceCreativeName}
          onOpenPlayable={onOpenPlayable}
        />
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/creatives/${candidate.sourceCreativeId}?from=${fromValue}&to=${toValue}`}
                  className="truncate text-sm font-semibold hover:underline"
                >
                  {candidate.sourceCreativeName}
                </Link>
                {candidate.format ? (
                  <Badge variant="secondary" className="text-[10px] capitalize">
                    {candidate.format}
                  </Badge>
                ) : null}
              </div>
              {subtitle ? (
                <p className="mt-0.5 truncate text-[12px] capitalize text-muted-foreground/60">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-x-7 gap-y-2">
            <Metric label="ROAS" value={fmtRoas(candidate.roas)} />
            <Metric label="Spend" value={fmtMoney(candidate.spend)} />
            <Metric label="Conv" value={fmtNum(candidate.conversions)} />
            <Metric label="CPA" value={fmtMoney(candidate.cpa)} />
          </div>

          {candidate.caption ? (
            <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
              {candidate.caption}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            {batch ? (
              <button
                type="button"
                onClick={onToggle}
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", isOpen && "rotate-180")} />
                {totalCount} variant{totalCount === 1 ? "" : "s"}
                {goodCount > 0 ? (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    · {goodCount} approved
                  </span>
                ) : null}
              </button>
            ) : (
              <span className="text-[12px] text-muted-foreground/50">
                No variants yet
              </span>
            )}
            {canWrite ? (
              <Button
                size="sm"
                variant={batch ? "outline" : "default"}
                className="h-8 gap-1.5 text-[12px]"
                disabled={generating}
                onClick={onGenerate}
              >
                <Sparkles className="size-3.5" />
                {generating ? "Generating…" : batch ? "Regenerate" : "Generate variants"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {batch && isOpen ? (
        <div className="space-y-2.5 border-t border-border/60 bg-muted/[0.15] p-4">
          {batch.variants.map((variant) => (
            <VariantRowItem
              key={variant.id}
              variant={variant}
              canReview={canWrite}
              reviewPending={reviewPending}
              onReview={onReview}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
