import { parseAsString, parseAsStringLiteral } from "nuqs";
import {
  LAB_RANGES,
  LEDGER_CHANNEL_FILTERS,
  LEDGER_KIND_FILTERS,
  type LabRange,
  type LedgerChannelFilter,
  type LedgerKindFilter,
} from "../copy";
import {
  DEFAULT_LEDGER_SORT,
  LEDGER_SORT_COLUMNS,
  LEDGER_SORT_DIRECTIONS,
  nextLedgerSort,
  type LedgerSortColumn,
  type LedgerSortDirection,
} from "./ledger-sort";

/**
 * The ledger's URL params, shared by the lab (which adds its own) and the
 * standalone campaigns page, so a ledger URL means the same thing on both.
 * `source` selects the detail sheet on the ledger; the lab's orders view
 * reuses it as a filter.
 */
export const LEDGER_URL_PARSERS = {
  range: parseAsStringLiteral(LAB_RANGES).withDefault("last30"),
  from: parseAsString,
  to: parseAsString,
  ledgerKind: parseAsStringLiteral(LEDGER_KIND_FILTERS).withDefault("all"),
  ledgerChannel: parseAsStringLiteral(LEDGER_CHANNEL_FILTERS).withDefault("all"),
  q: parseAsString,
  source: parseAsString,
  sort: parseAsStringLiteral(LEDGER_SORT_COLUMNS).withDefault(DEFAULT_LEDGER_SORT.column),
  dir: parseAsStringLiteral(LEDGER_SORT_DIRECTIONS).withDefault(DEFAULT_LEDGER_SORT.direction),
};

export type LedgerUrlState = {
  range: LabRange;
  from: string | null;
  to: string | null;
  ledgerKind: LedgerKindFilter;
  ledgerChannel: LedgerChannelFilter;
  q: string | null;
  source: string | null;
  sort: LedgerSortColumn;
  dir: LedgerSortDirection;
};

export type LedgerUrlPatch = Partial<{
  [K in keyof LedgerUrlState]: LedgerUrlState[K] | null;
}>;

/** The ledger's state transitions, identical on the lab and the page. */
export function ledgerStateHelpers(
  state: LedgerUrlState,
  setState: (patch: LedgerUrlPatch) => unknown,
) {
  return {
    openSource: (objectId: string) => void setState({ source: objectId }),
    closeSource: () => void setState({ source: null }),
    toggleSort: (column: LedgerSortColumn) => {
      const next = nextLedgerSort({ column: state.sort, direction: state.dir }, column);
      void setState({ sort: next.column, dir: next.direction });
    },
    clearLedgerFilters: () =>
      void setState({ source: null, q: null, ledgerKind: "all", ledgerChannel: "all" }),
  };
}
