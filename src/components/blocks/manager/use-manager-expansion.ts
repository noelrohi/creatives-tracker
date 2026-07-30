"use client";

import { useCallback, useMemo, useState } from "react";

// Anything the tree can expand: ids are globally unique across levels, and
// `hasMatches` is what marks a row as on the path to a search hit (§4).
export type ManagerExpandableRow = {
  id: string;
  hasMatches?: boolean | null;
};

export type ManagerExpansion = {
  isExpanded: (row: ManagerExpandableRow) => boolean;
  toggle: (row: ManagerExpandableRow) => void;
};

const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

// §6, "search auto-expands, then restores" — two layers that are never merged:
//
//   base      the user's own expand/collapse set. The only layer that survives
//             a search: while one is active it is frozen, which makes it the
//             snapshot taken when the search began.
//   overlay   search-mode state. A row is expanded because it has `hasMatches`,
//             unless `overrides` holds a manual toggle for it, which wins.
//
// Clearing the search throws the overlay away, so `base` is restored exactly.
export function useManagerExpansion(searchActive: boolean): ManagerExpansion {
  const [base, setBase] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [overrides, setOverrides] = useState(EMPTY_OVERRIDES);
  const [searching, setSearching] = useState(searchActive);

  // Crossing into or out of search mode starts a fresh overlay. Editing the
  // search string while already searching does not, so no re-snapshot and no
  // lost manual toggles.
  if (searching !== searchActive) {
    setSearching(searchActive);
    setOverrides(EMPTY_OVERRIDES);
  }

  const isExpanded = useCallback(
    (row: ManagerExpandableRow) =>
      searchActive
        ? (overrides.get(row.id) ?? Boolean(row.hasMatches))
        : base.has(row.id),
    [base, overrides, searchActive],
  );

  const toggle = useCallback(
    (row: ManagerExpandableRow) => {
      if (!searchActive) {
        setBase((current) => {
          const next = new Set(current);
          if (!next.delete(row.id)) next.add(row.id);
          return next;
        });
        return;
      }
      setOverrides((current) => {
        const next = new Map(current);
        next.set(row.id, !(current.get(row.id) ?? Boolean(row.hasMatches)));
        return next;
      });
    },
    [searchActive],
  );

  return useMemo(() => ({ isExpanded, toggle }), [isExpanded, toggle]);
}
