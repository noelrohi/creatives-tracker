// §7 sorting: one (column, direction) applied to every sibling group in the
// tree — campaigns among campaigns, ad sets within their campaign, ads within
// their ad set. Pure and level-agnostic, so it never flattens the hierarchy and
// never touches the query cache key (§4).

import { toNumber } from "./manager-ledger-format";

export const MANAGER_SORT_COLUMNS = [
  "spend",
  "roas",
  "cpa",
  "ctr",
  "conversions",
] as const;

export type ManagerSortColumn = (typeof MANAGER_SORT_COLUMNS)[number];

export const MANAGER_SORT_DIRECTIONS = ["asc", "desc"] as const;

export type ManagerSortDirection = (typeof MANAGER_SORT_DIRECTIONS)[number];

export type ManagerSort = {
  column: ManagerSortColumn;
  direction: ManagerSortDirection;
};

// Default: Spend descending, matching the server's ORDER BY.
export const DEFAULT_MANAGER_SORT: ManagerSort = {
  column: "spend",
  direction: "desc",
};

export const MANAGER_SORT_COLUMN_LABELS: Record<ManagerSortColumn, string> = {
  spend: "Spend",
  roas: "ROAS",
  cpa: "CPA",
  ctr: "CTR",
  conversions: "Conv",
};

// The metric fields every level returns; the live row types (spend always a
// string, conversions always a number) are assignable to this.
export type ManagerSortableRow = {
  name: string;
  spend: string | null;
  roas: string | null;
  cpa: string | null;
  ctr: string | null;
  conversions: number | null;
};

function metricValue(
  row: ManagerSortableRow,
  column: ManagerSortColumn,
): number | null {
  if (column === "conversions") return row.conversions;
  return toNumber(row[column]);
}

// Nulls sort last in both directions — "no data" is never the top of the table.
// Ties fall back to name ascending, matching the server's ORDER BY.
export function compareManagerRows(
  a: ManagerSortableRow,
  b: ManagerSortableRow,
  sort: ManagerSort,
): number {
  const left = metricValue(a, sort.column);
  const right = metricValue(b, sort.column);

  if (left == null || right == null) {
    if (left != null) return -1;
    if (right != null) return 1;
  } else if (left !== right) {
    return sort.direction === "asc" ? left - right : right - left;
  }

  return a.name.localeCompare(b.name);
}

// One sibling group at a time: callers pass the rows of a single parent, so
// ordering can only ever move a row among its own siblings.
export function sortManagerRows<T extends ManagerSortableRow>(
  rows: readonly T[],
  sort: ManagerSort,
): T[] {
  return [...rows].sort((a, b) => compareManagerRows(a, b, sort));
}

// A header click on a new column starts descending; clicking the active column
// toggles its direction.
export function nextManagerSort(
  current: ManagerSort,
  column: ManagerSortColumn,
): ManagerSort {
  if (current.column !== column) return { column, direction: "desc" };
  return {
    column,
    direction: current.direction === "desc" ? "asc" : "desc",
  };
}
