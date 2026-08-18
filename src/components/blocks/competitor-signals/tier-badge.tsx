"use client";

import { Info } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { tierColor, tierLabels, tierSoftColor } from "./colors";
import { EVIDENCE_NOTE } from "./copy";
import type { ClusterTier } from "./types";

/**
 * Tier and score never appear without the ⓘ that says what they are —
 * observable evidence, not measured performance.
 */
function EvidenceTooltip({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">
          {EVIDENCE_NOTE}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function TierBadge({ tier }: { tier: ClusterTier }) {
  return (
    <EvidenceTooltip>
      <Badge
        variant="outline"
        className="cursor-help gap-1 border-transparent"
        style={{
          color: tierColor(tier),
          backgroundColor: tierSoftColor(tier),
        }}
      >
        {tierLabels[tier]}
        <Info className="size-3 opacity-60" />
      </Badge>
    </EvidenceTooltip>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  return (
    <EvidenceTooltip>
      <span className="inline-flex cursor-help items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
        {score}
        <Info className="size-3 opacity-60" />
      </span>
    </EvidenceTooltip>
  );
}
