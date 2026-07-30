"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";
import {
  DEFAULT_MANAGER_SORT,
  MANAGER_SORT_COLUMNS,
  MANAGER_SORT_DIRECTIONS,
  type ManagerSort,
  type ManagerSortColumn,
  nextManagerSort,
} from "./manager-ledger-sort";

// §7: sort lives in the URL next to the filter params (same nuqs pattern as
// use-manager-filters), so it survives filter, range and expand/collapse
// changes and only a header click can move it. Deliberately not part of any
// query input — re-ranking is client-side (§4).
export function useManagerSort() {
  const [column, setColumn] = useQueryState(
    "sort",
    parseAsStringLiteral(MANAGER_SORT_COLUMNS).withDefault(
      DEFAULT_MANAGER_SORT.column,
    ),
  );
  const [direction, setDirection] = useQueryState(
    "dir",
    parseAsStringLiteral(MANAGER_SORT_DIRECTIONS).withDefault(
      DEFAULT_MANAGER_SORT.direction,
    ),
  );

  const sort = useMemo<ManagerSort>(
    () => ({ column, direction }),
    [column, direction],
  );

  // The default (spend, desc) is written as absent params to keep URLs clean.
  const toggleSort = useCallback(
    (clicked: ManagerSortColumn) => {
      const next = nextManagerSort({ column, direction }, clicked);
      setColumn(
        next.column === DEFAULT_MANAGER_SORT.column ? null : next.column,
      );
      setDirection(
        next.direction === DEFAULT_MANAGER_SORT.direction
          ? null
          : next.direction,
      );
    },
    [column, direction, setColumn, setDirection],
  );

  return { sort, toggleSort };
}
