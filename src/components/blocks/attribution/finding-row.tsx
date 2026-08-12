"use client";

import Link from "next/link";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { severityColor } from "./colors";
import {
  actions as actionCopy,
  canRerun,
  findingBody,
  findingEvidence,
  findingHeadline,
  severityByType,
  type FindingItem,
  type VoiceContext,
} from "./copy";
import { FindingDetail } from "./finding-details";
import { formatAge, formatDateInZone } from "./format";

/** What the row needs to know about the page it sits in. */
export type FindingRowContext = {
  ctx: VoiceContext;
  frozen: boolean;
  canAct: boolean;
  busy: boolean;
  links: { metaVsShopify: string; connections: string };
};

/** The three actions from §8, plus the evidence jump. */
export type FindingRowHandlers = {
  onResolve: () => void;
  onSnooze: () => void;
  onRerun: () => void;
  onSeeOrders: (bucket: AttributionBucket) => void;
};

export function FindingRow({
  item,
  expanded,
  onToggle,
  context: { ctx, frozen, canAct, busy, links },
  handlers: { onResolve, onSnooze, onRerun, onSeeOrders },
}: {
  item: FindingItem;
  expanded: boolean;
  onToggle: () => void;
  context: FindingRowContext;
  handlers: FindingRowHandlers;
}) {
  const severity = severityByType[item.type];
  const isConnectionRow = item.type === "sync_failure";
  // While the numbers are frozen everything except the connection row is on
  // hold: the figures behind those rows cannot move until the connection is back.
  const onHold = frozen && !isConnectionRow;
  const actionsDisabled = onHold || !canAct || busy || item.id === null;
  const evidence = findingEvidence(item, links);
  const age = formatAge(item.firedAt);
  const snoozedUntil = item.mutedUntil
    ? formatDateInZone(item.mutedUntil, ctx.timeZone)
    : null;
  const closedBy =
    item.resolution === "handled"
      ? actionCopy.resolvedHandled
      : item.resolution === "retired"
        ? actionCopy.resolvedRetired
        : null;

  return (
    <div
      className={cn(
        "relative border-b border-border/60 transition-colors",
        expanded && "bg-muted/40",
        onHold && "opacity-60",
      )}
    >
      {expanded ? (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" />
      ) : null}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
      >
        <span
          className="mt-[5px] size-2 shrink-0 rounded-full"
          style={{ backgroundColor: severityColor(severity) }}
        />
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">
          {findingHeadline(item, ctx)}
        </span>
        {age ? (
          <span className="mt-px shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
            {age}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pl-7">
          {findingBody(item, ctx).map((sentence) => (
            <p
              key={sentence}
              className="text-[12px] leading-relaxed text-muted-foreground"
            >
              {sentence}
            </p>
          ))}

          {/* The three creative-insights rules carry a drawer of their own;
              the other five say everything in their sentences. */}
          <FindingDetail item={item} ctx={ctx} canAct={canAct} />

          {evidence.kind === "link" ? (
            <Link
              href={evidence.href}
              className="text-[12px] font-medium text-primary hover:underline"
            >
              {evidence.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => onSeeOrders(evidence.bucket)}
              className="self-start text-[12px] font-medium text-primary hover:underline"
            >
              {evidence.label}
            </button>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {canRerun(item) ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={!canAct || busy || item.id === null}
                onClick={onRerun}
              >
                {actionCopy.rerun}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[12px]"
              disabled={actionsDisabled}
              onClick={onResolve}
            >
              {actionCopy.resolve}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[12px]"
              disabled={onHold || !canAct || busy}
              onClick={onSnooze}
            >
              {actionCopy.snooze}
            </Button>
          </div>

          {onHold ? (
            <p className="text-[11px] text-muted-foreground/60">
              {actionCopy.frozenCaption}
            </p>
          ) : !canAct ? (
            <p className="text-[11px] text-muted-foreground/60">
              {actionCopy.readOnlyCaption}
            </p>
          ) : null}

          {snoozedUntil ? (
            <p className="text-[11px] text-muted-foreground/60">
              {actionCopy.snoozed(snoozedUntil)}
            </p>
          ) : null}

          {/* A row closed before the two were told apart says neither. */}
          {closedBy ? (
            <p className="text-[11px] text-muted-foreground/60">{closedBy}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
