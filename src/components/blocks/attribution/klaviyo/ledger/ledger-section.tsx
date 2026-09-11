"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import { LedgerMessageRows } from "./ledger-message-rows";
import type { LedgerSortColumn } from "./ledger-sort";
import { LedgerTable } from "./ledger-table";
import type { LedgerUrlState } from "./ledger-url-state";

/**
 * The ledger list query, expansion state, table, and lazily mounted message
 * rows — everything between the filters and the sheet. The lab's Campaigns
 * tab and the campaigns page both render this; only the URL state and the
 * admin affordances differ, and those arrive as props.
 */
export function LedgerSection(props: {
  range: { dateFrom: string; dateTo: string };
  accountTimezone: string;
  state: Pick<
    LedgerUrlState,
    "ledgerKind" | "ledgerChannel" | "q" | "sort" | "dir"
  >;
  onToggleSort: (column: LedgerSortColumn) => void;
  onOpenSource: (objectId: string) => void;
  onClearFilters: () => void;
  busy: boolean;
  onRefresh?: () => void;
}) {
  const trpc = useTRPC();
  const { state } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const search = state.q?.trim() ?? "";
  const list = useQuery({
    ...trpc.klaviyo.ledger.list.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
      kind: state.ledgerKind === "all" ? undefined : state.ledgerKind,
      channel: state.ledgerChannel === "all" ? undefined : state.ledgerChannel,
      search: search === "" ? undefined : search,
    }),
    // Typing in the search box or flipping a filter re-keys the query; without
    // this the table blanks to its empty state between keystrokes.
    placeholderData: keepPreviousData,
  });
  const filtered =
    state.ledgerKind !== "all" ||
    state.ledgerChannel !== "all" ||
    search !== "";
  const sort = { column: state.sort, direction: state.dir };
  return (
    <LedgerTable
      data={list.data ?? null}
      error={list.isError}
      filtered={filtered}
      busy={props.busy}
      accountTimezone={props.accountTimezone}
      range={props.range}
      sort={sort}
      onToggleSort={props.onToggleSort}
      expanded={expanded}
      onToggleExpand={(objectId) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(objectId)) next.add(objectId);
          return next;
        })
      }
      renderMessageRows={(row) => (
        <LedgerMessageRows parent={row} range={props.range} sort={sort} />
      )}
      onOpenSource={props.onOpenSource}
      onRefresh={props.onRefresh}
      onRetry={() => void list.refetch()}
      onClearFilters={props.onClearFilters}
    />
  );
}
