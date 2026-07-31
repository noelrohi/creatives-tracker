"use client";

import { Info } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * The long plain-English sentences moved off the page and behind this mark: the
 * explanation is always one hover (or one focus) away, but it never has to be
 * printed beside every figure. The sentence itself still lives in `copy.ts`.
 */
export function HelpMark({
  text,
  className,
  focusable = true,
}: {
  text: string;
  className?: string;
  /** False inside a button: a focusable mark nested in one traps the tab stop. */
  focusable?: boolean;
}) {
  return (
    <span
      title={text}
      aria-label={text}
      role="note"
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        "inline-flex shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
        className,
      )}
    >
      <Info className="size-3.5" />
    </span>
  );
}
