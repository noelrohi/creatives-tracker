"use client";

import { ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CopyButton } from "./recommendation-ui";
import type { RecommendationVariant } from "./types";

export function VariantRowItem({
  variant,
  canReview,
  onReview,
  reviewPending,
}: {
  variant: RecommendationVariant;
  canReview: boolean;
  onReview: (input: { variantId: string; status: "good" | "bad" }) => void;
  reviewPending: boolean;
}) {
  const isGood = variant.status === "good";
  const isBad = variant.status === "bad";

  return (
    <div
      className={cn(
        "rounded-lg border bg-background/60 p-3.5 transition-colors",
        isGood
          ? "border-emerald-500/30 bg-emerald-500/[0.04]"
          : isBad
            ? "border-border/50 opacity-60"
            : "border-border/60",
      )}
    >
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-medium">{variant.copy.variantName}</h4>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/70">
            {variant.copy.changeSummary}
          </p>
        </div>
        {canReview ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={isGood ? "default" : "outline"}
              disabled={reviewPending}
              onClick={() => onReview({ variantId: variant.id, status: "good" })}
              className={cn(
                "h-7 gap-1 px-2.5 text-[12px]",
                isGood && "bg-emerald-600 text-white hover:bg-emerald-600/90",
              )}
            >
              <ThumbsUp className="size-3" /> Good
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={reviewPending}
              onClick={() => onReview({ variantId: variant.id, status: "bad" })}
              className={cn(
                "h-7 gap-1 px-2.5 text-[12px] text-muted-foreground hover:text-foreground",
                isBad && "bg-red-500/10 text-red-500 hover:bg-red-500/15 hover:text-red-500",
              )}
            >
              <ThumbsDown className="size-3" /> Bad
            </Button>
          </div>
        ) : isGood ? (
          <Badge className="bg-emerald-600 text-white">Approved</Badge>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="rounded-md bg-muted/30 px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/45">
              Primary text
            </span>
            <CopyButton text={variant.copy.primaryText} label="Primary text" />
          </div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
            {variant.copy.primaryText}
          </p>
        </div>
        <p className="text-[13px]">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/45">
            Headline{" "}
          </span>
          {variant.copy.headline}
        </p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          <span className="text-foreground/70">Hook:</span> {variant.copy.hook}
          {"  ·  "}
          <span className="text-foreground/70">CTA:</span> {variant.copy.cta}
          {"  ·  "}
          <span className="text-foreground/70">Visual:</span> {variant.copy.visualDirection}
        </p>
        {variant.copy.riskNotes ? (
          <p className="flex items-start gap-1.5 rounded-md bg-amber-500/[0.07] px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
            {variant.copy.riskNotes}
          </p>
        ) : null}
      </div>
    </div>
  );
}
