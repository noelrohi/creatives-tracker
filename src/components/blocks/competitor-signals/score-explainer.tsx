"use client";

import { InfoIcon } from "@/components/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  HIGH_TIER_MIN,
  MODERATE_TIER_MIN,
} from "@/lib/competitor-signals/score";
import { tierLabels } from "./colors";
import { SCORE_COMPONENTS } from "./component-meters";
import { EVIDENCE_NOTE } from "./copy";

/**
 * "How it's scored" — the plain-language contract behind the dial, one entry
 * per meter (shared with ComponentMeters via SCORE_COMPONENTS) plus the tier
 * cutoffs and the honesty note. A popover, not a tooltip: it's several lines,
 * and people read it, so it should stay open on a click/tap.
 */
export function ScoreExplainer() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
        >
          <InfoIcon className="size-3" />
          How it&apos;s scored
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4">
        <p className="text-xs text-muted-foreground">
          The score adds up five things anyone can observe in the public Ad
          Library, out of 100 points.
        </p>
        <dl className="flex flex-col gap-2.5">
          {SCORE_COMPONENTS.map((component) => (
            <div key={component.key}>
              <dt className="flex items-baseline justify-between gap-2 text-xs font-medium">
                {component.label}
                <span className="font-normal text-muted-foreground">
                  up to {component.max} pts
                </span>
              </dt>
              <dd className="text-xs leading-relaxed text-muted-foreground">
                {component.description}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-1.5 border-t pt-2.5">
          <p className="text-xs text-muted-foreground">
            {HIGH_TIER_MIN}+ reads as “{tierLabels.high}”, {MODERATE_TIER_MIN}–
            {HIGH_TIER_MIN - 1} as “{tierLabels.moderate}”, and anything below
            as “{tierLabels.watch}”.
          </p>
          <p className="text-xs italic text-muted-foreground/80">{EVIDENCE_NOTE}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
