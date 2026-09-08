"use client";

import type { LedgerDetailData } from "./ledger-types";

export function LedgerDayBars({ ordersByDay }: { ordersByDay: LedgerDetailData["ordersByDay"] }) {
  const max = Math.max(1, ...ordersByDay.points.map((point) => point.orders));
  return (
    <div className="flex h-10 items-end gap-[2px]" role="img" aria-label="Confirmed orders per day">
      {ordersByDay.points.map((point) => (
        <div
          key={point.label}
          data-testid="day-bar"
          title={`${ordersByDay.mode === "offset" ? `Day ${point.label}` : point.label}: ${point.orders} orders`}
          className="min-w-[3px] flex-1 rounded-t-[2px] bg-emerald-600"
          style={{ height: `${Math.max(point.orders === 0 ? 2 : 6, (point.orders / max) * 100)}%`, opacity: point.orders === 0 ? 0.25 : 1 }}
        />
      ))}
    </div>
  );
}
