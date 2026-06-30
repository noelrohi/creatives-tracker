"use client";

import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  WINNER_MIN_CONVERSIONS,
  WINNER_MIN_ROAS,
  WINNER_MIN_SPEND,
} from "@/lib/creative-recommendation-policy";
import { fmtMoney, fmtRoas } from "@/lib/fmt";

const CRITERIA: { label: string; detail: string }[] = [
  { label: "Static format", detail: "Image creatives only — videos are excluded." },
  { label: "Active", detail: "The ad is currently live." },
  { label: `Spend ≥ ${fmtMoney(WINNER_MIN_SPEND)}`, detail: "Enough delivery to trust the result." },
  { label: `ROAS ≥ ${fmtRoas(WINNER_MIN_ROAS)}`, detail: "Profitable in the selected window." },
  {
    label: `Conversions ≥ ${WINNER_MIN_CONVERSIONS}`,
    detail: "At least one purchase, not just clicks.",
  },
  {
    label: "Has creative context",
    detail: "A caption, hook, angle, persona, or CTA exists for the generator to learn from.",
  },
];

export function WinnerCriteriaPopover() {
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        aria-label="How winners are chosen"
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3">
        <PopoverHeader>
          <PopoverTitle>How winners are chosen</PopoverTitle>
          <p className="text-[12px] text-muted-foreground">
            An ad must meet every rule below for the selected date range.
          </p>
        </PopoverHeader>
        <ul className="flex flex-col gap-2">
          {CRITERIA.map((rule) => (
            <li key={rule.label} className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-foreground">{rule.label}</span>
              <span className="text-[12px] leading-relaxed text-muted-foreground">
                {rule.detail}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
