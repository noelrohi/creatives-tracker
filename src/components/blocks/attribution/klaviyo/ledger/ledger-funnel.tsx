"use client";

import { cn } from "@/lib/utils";
import { ledger as copy } from "../copy";
import { formatCount, formatPercent } from "./ledger-format";
import type { LedgerDetailData } from "./ledger-types";

/** Five equal cells: recipients → delivered → opened → clicked → ordered (ours). */
export function LedgerFunnel({ detail }: { detail: LedgerDetailData }) {
  const cells: Array<{ id: string; value: string; label: string; last?: boolean }> = [
    { id: "recipients", value: formatCount(detail.klaviyo?.recipients ?? null), label: copy.sheet.recipients },
    { id: "delivered", value: formatPercent(detail.rates.delivered), label: copy.sheet.delivered },
    { id: "opened", value: formatPercent(detail.rates.open), label: copy.sheet.opened },
    { id: "clicked", value: formatPercent(detail.rates.click), label: copy.sheet.clicked },
    { id: "ordered", value: formatCount(detail.ours.orderCount), label: copy.sheet.ordered, last: true },
  ];
  return (
    <div className="grid grid-cols-5 gap-1">
      {cells.map((cell) => (
        <div
          key={cell.id}
          data-testid={`funnel-${cell.id}`}
          className={cn("rounded px-1.5 py-1.5", cell.last ? "bg-emerald-600/15" : "bg-muted")}
        >
          <p className="font-mono text-[12px] font-semibold tabular-nums">{cell.value}</p>
          <p className="text-[10px] text-muted-foreground">{cell.label}</p>
        </div>
      ))}
    </div>
  );
}
