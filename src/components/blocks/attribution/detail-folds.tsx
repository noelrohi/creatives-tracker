"use client";

import { useState } from "react";
import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  findingHeadline,
  folds as copy,
  howWeCount,
  page,
  rail as railCopy,
} from "./copy";
import {
  FindingsBody,
  FindingsStatusFooter,
  useFindingsState,
  type FindingsContext,
} from "./findings-content";
import { HowWeCountList } from "./how-we-count";
import { TodaysChecks } from "./todays-checks";

type FoldKey = "attention" | "how";

/**
 * Everything that used to shout from a right-hand rail and two cards, folded
 * into rows. The Meta check and campaign folds moved into the Meta drawer on
 * the ledger; what stays here is what concerns every channel.
 */
export function DetailFolds({
  findings,
  timeZone,
  frozenClock,
  lastCheckedClock,
}: {
  findings: FindingsContext;
  timeZone: string;
  frozenClock: string | null;
  lastCheckedClock: string | null;
}) {
  const [open, setOpen] = useState<FoldKey | null>(null);
  const state = useFindingsState();
  const { items, checks, checksLoading, hasCritical, isPending } = state;

  const attentionSummary = findings.firstLoad
    ? copy.attentionFirstLoad
    : findings.frozen
      ? copy.attentionFrozen
      : isPending
        ? null
        : items.length > 0
          ? copy.attentionOpen(
              items.length,
              findingHeadline(items[0], findings.ctx),
            )
          : copy.attentionAllClear(checks?.length ?? 5);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <Fold
        foldKey="attention"
        title={copy.attention}
        summary={attentionSummary}
        open={open === "attention"}
        onToggle={setOpen}
        badge={
          items.length > 0 ? (
            <Badge
              variant="outline"
              className="h-5 rounded-full px-2 text-[11px] tabular-nums"
              style={
                hasCritical
                  ? {
                      backgroundColor: "var(--attr-critical-soft)",
                      borderColor: "var(--attr-critical)",
                      color: "var(--attr-critical)",
                    }
                  : undefined
              }
            >
              {items.length}
            </Badge>
          ) : null
        }
      >
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">
          {findings.frozen
            ? frozenClock
              ? railCopy.frozen(frozenClock)
              : railCopy.frozenNoClock
            : lastCheckedClock
              ? railCopy.checked(lastCheckedClock)
              : railCopy.checkedNoStamp}
        </p>
        <div className="overflow-hidden rounded-sm border border-border">
          <FindingsBody state={state} context={findings} />
          <TodaysChecks items={checks} loading={checksLoading} />
          <FindingsStatusFooter
            state={state}
            className="border-t border-border px-3 py-2"
          />
        </div>
      </Fold>

      <Fold
        foldKey="how"
        title={howWeCount.trigger}
        summary={copy.howSummary}
        open={open === "how"}
        onToggle={setOpen}
        last
      >
        <HowWeCountList timeZone={timeZone} />
      </Fold>
    </div>
  );
}

function Fold({
  foldKey,
  title,
  summary,
  badge,
  open,
  onToggle,
  last = false,
  children,
}: {
  foldKey: FoldKey;
  title: string;
  summary: string | null;
  badge?: React.ReactNode;
  open: boolean;
  onToggle: (next: FoldKey | null) => void;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(!last && "border-b border-border")}>
      <button
        type="button"
        onClick={() => onToggle(open ? null : foldKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[12.5px] font-semibold">{title}</span>
        {badge}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {summary ?? page.noDataYet}
        </span>
      </button>

      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}
