"use client";

import { Fragment, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ledger as copy } from "../copy";
import { LabPanelState } from "../panel-state";
import { LedgerRow, LedgerStateRow, METRIC_COLUMN } from "./ledger-row";
import {
  LEDGER_SORT_COLUMNS,
  sortLedgerRows,
  type LedgerSort,
  type LedgerSortColumn,
} from "./ledger-sort";
import type { LedgerListData, LedgerRowData } from "./ledger-types";

const HEAD = "h-8 px-2 text-[11px] font-medium text-muted-foreground/70";
const NUMERIC_HEAD = `${HEAD} text-right`;

const COLUMN_LABELS: Record<LedgerSortColumn, string> = {
  sent: copy.columns.sent,
  recipients: copy.columns.recipients,
  delivered: copy.columns.delivered,
  open: copy.columns.open,
  click: copy.columns.click,
  orders: copy.columns.orders,
  revenue: copy.columns.revenue,
  klaviyoSays: copy.columns.klaviyoSays,
  unsub: copy.columns.unsub,
};

export function isExpandable(row: LedgerRowData): boolean {
  // A campaign always has one message; only variants are worth a level.
  return row.objectType === "flow" ? row.messageCount > 0 : row.messageCount > 1;
}

function asOfLabel(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

/** The report window's UTC calendar day, `YYYY-MM-DD`. */
function reportDay(value: string | Date | null): string | null {
  const iso = asOfLabel(value);
  return iso === null ? null : iso.slice(0, 10);
}

export function LedgerTable(props: {
  data: LedgerListData | null;
  error: boolean;
  filtered: boolean;
  busy: boolean;
  accountTimezone: string;
  range: { dateFrom: string; dateTo: string };
  sort: LedgerSort;
  onToggleSort: (column: LedgerSortColumn) => void;
  expanded: ReadonlySet<string>;
  onToggleExpand: (objectId: string) => void;
  renderMessageRows: (row: LedgerRowData) => ReactNode;
  onOpenSource: (objectId: string) => void;
  onRefresh?: () => void;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  if (props.data === null && !props.error) {
    return <LabPanelState kind="loading" title="Loading campaigns" body="" />;
  }
  const rows = props.data ? sortLedgerRows(props.data.rows, props.sort) : [];
  const report = props.data?.report ?? null;
  const noReport =
    report !== null &&
    !report.hasCampaignGeneration &&
    !report.hasFlowGeneration;
  const asOf = asOfLabel(report?.asOf ?? null);
  const reportFrom = reportDay(report?.reportFrom ?? null);
  const reportTo = reportDay(report?.reportTo ?? null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {copy.caption(
            props.accountTimezone,
            props.range.dateFrom,
            props.range.dateTo,
          )}
          {asOf ? ` · ${copy.asOf(asOf)}` : ""}
          {reportFrom && reportTo
            ? ` · ${copy.reportWindow(reportFrom, reportTo)}`
            : ""}
        </p>
        {props.onRefresh ? (
          <Button
            size="sm"
            variant="outline"
            disabled={props.busy}
            onClick={props.onRefresh}
          >
            {copy.refresh}
          </Button>
        ) : null}
      </div>
      {noReport ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {copy.noReport}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "w-7")} />
              <TableHead className={HEAD}>{copy.columns.name}</TableHead>
              {LEDGER_SORT_COLUMNS.map((column) => (
                <TableHead
                  key={column}
                  className={cn(
                    column === "sent"
                      ? cn(HEAD, "w-16")
                      : cn(NUMERIC_HEAD, METRIC_COLUMN),
                  )}
                  aria-sort={
                    props.sort.column === column
                      ? props.sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    aria-label={`Sort by ${COLUMN_LABELS[column]}`}
                    onClick={() => props.onToggleSort(column)}
                    className={cn(
                      "inline-flex items-center gap-0.5 hover:text-foreground",
                      column !== "sent" && "ml-auto",
                    )}
                  >
                    {COLUMN_LABELS[column]}
                    {props.sort.column === column ? (
                      props.sort.direction === "asc" ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      )
                    ) : null}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.error ? (
              <LedgerStateRow>
                <span className="text-muted-foreground">{copy.error}</span>{" "}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[12px]"
                  onClick={props.onRetry}
                >
                  {copy.retry}
                </Button>
              </LedgerStateRow>
            ) : null}
            {!props.error && rows.length === 0 ? (
              <LedgerStateRow>
                <span className="text-muted-foreground">
                  {props.filtered ? copy.noResults : copy.noRows}
                </span>
                {props.filtered ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-1 h-5 px-1.5 text-[12px]"
                    onClick={props.onClearFilters}
                  >
                    {copy.clearFilters}
                  </Button>
                ) : null}
              </LedgerStateRow>
            ) : null}
            {rows.map((row) => {
              const expandable = isExpandable(row);
              const isExpanded = expandable && props.expanded.has(row.objectId);
              return (
                <Fragment key={row.objectId}>
                  <LedgerRow
                    row={row}
                    level={row.objectType}
                    expandable={expandable}
                    isExpanded={isExpanded}
                    onToggle={() => props.onToggleExpand(row.objectId)}
                    onOpen={() => props.onOpenSource(row.objectId)}
                  />
                  {isExpanded ? props.renderMessageRows(row) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
