"use client";

import { angleLabels } from "@/components/blocks/insights/insights-copy";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { TierBadge } from "./tier-badge";
import type { RankedSignal } from "./types";

const EM_DASH = "—";

/**
 * The ranking half of the ledger: rank, cluster, score, tier — nothing else.
 * Selection drives the evidence panel; the row itself carries no actions.
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">#</TableHead>
          <TableHead>Cluster</TableHead>
          <TableHead className="w-16 text-right">Score</TableHead>
          <TableHead className="w-24">Tier</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {signals.map((signal, index) => {
          const angle = signal.angle
            ? (angleLabels[signal.angle] ?? signal.angle)
            : null;

          return (
            <TableRow
              key={signal.id}
              aria-selected={signal.id === selectedId}
              className={cn(
                "cursor-pointer",
                signal.id === selectedId && "bg-muted/60",
              )}
              onClick={() => onSelect(signal.id)}
            >
              <TableCell className="text-[13px] tabular-nums text-muted-foreground/70">
                {index + 1}
              </TableCell>
              <TableCell>
                <p className="truncate text-[13px] font-medium">
                  {signal.label}
                </p>
                <p className="truncate text-[11px] text-muted-foreground/70">
                  {signal.competitor.name}
                  {angle ? ` · ${angle}` : null}
                </p>
              </TableCell>
              <TableCell className="text-right text-[13px] tabular-nums">
                {signal.score === null ? EM_DASH : Math.round(signal.score)}
              </TableCell>
              <TableCell>
                {signal.tier ? (
                  <TierBadge tier={signal.tier} />
                ) : (
                  <span className="text-[13px] text-muted-foreground/60">
                    {EM_DASH}
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
