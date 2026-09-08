import { toNumber } from "@/components/blocks/manager/manager-ledger-format";

export const LEDGER_SORT_COLUMNS = [
  "sent",
  "recipients",
  "delivered",
  "open",
  "click",
  "orders",
  "revenue",
  "klaviyoSays",
  "unsub",
] as const;
export type LedgerSortColumn = (typeof LEDGER_SORT_COLUMNS)[number];
export const LEDGER_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type LedgerSortDirection = (typeof LEDGER_SORT_DIRECTIONS)[number];
export type LedgerSort = {
  column: LedgerSortColumn;
  direction: LedgerSortDirection;
};
/** Ranking is the job (spec §6.3): confirmed revenue descending. */
export const DEFAULT_LEDGER_SORT: LedgerSort = {
  column: "revenue",
  direction: "desc",
};

/** The fields every ledger level carries; parent and message rows both fit. */
export type LedgerSortableRow = {
  name: string;
  sentAt?: string | Date | null;
  klaviyo: {
    recipients: number | null;
    unsubscribes: number | null;
    conversionValue: string | null;
  } | null;
  rates: { delivered: number | null; open: number | null; click: number | null };
  orderCount: number;
  revenue: string;
};

function sortValue(
  row: LedgerSortableRow,
  column: LedgerSortColumn,
): number | null {
  switch (column) {
    case "sent":
      return row.sentAt ? new Date(row.sentAt).getTime() : null;
    case "recipients":
      return row.klaviyo?.recipients ?? null;
    case "delivered":
      return row.rates.delivered;
    case "open":
      return row.rates.open;
    case "click":
      return row.rates.click;
    case "orders":
      return row.orderCount;
    case "revenue":
      return toNumber(row.revenue);
    case "klaviyoSays":
      return toNumber(row.klaviyo?.conversionValue ?? null);
    case "unsub":
      return row.klaviyo?.unsubscribes ?? null;
  }
}

/** Nulls last in both directions; ties fall back to name ascending. */
export function compareLedgerRows(
  a: LedgerSortableRow,
  b: LedgerSortableRow,
  sort: LedgerSort,
): number {
  const left = sortValue(a, sort.column);
  const right = sortValue(b, sort.column);
  if (left == null || right == null) {
    if (left != null) return -1;
    if (right != null) return 1;
  } else if (left !== right) {
    return sort.direction === "asc" ? left - right : right - left;
  }
  return a.name.localeCompare(b.name);
}

/** One sibling group at a time, so ordering never crosses parent boundaries. */
export function sortLedgerRows<T extends LedgerSortableRow>(
  rows: readonly T[],
  sort: LedgerSort,
): T[] {
  return [...rows].sort((a, b) => compareLedgerRows(a, b, sort));
}

/** A click on a new column starts descending; on the active column it toggles. */
export function nextLedgerSort(
  current: LedgerSort,
  column: LedgerSortColumn,
): LedgerSort {
  if (current.column !== column) return { column, direction: "desc" };
  return { column, direction: current.direction === "desc" ? "asc" : "desc" };
}
