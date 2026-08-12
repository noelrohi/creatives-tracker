"use client";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EVENT_STATUS_LABELS } from "./copy";
import { LabPanelState } from "./panel-state";

export type LedgerRow = {
  orderId: string;
  orderName: string | null;
  orderDay: string;
  netSales: string;
  bucket: string | null;
  orderStatus: string;
  productStatus: string | null;
  claimCount: number;
  boundaryWarning: boolean;
};

/**
 * Shopify-order-first ledger: Shopify truth columns precede Klaviyo
 * evidence, order is the fixed newest-first server cursor order, and a
 * duplicate-conversion order never surfaces one chosen claim chain.
 * Candidate evidence is always labelled advisory, never confirmed.
 */
export function OrdersTable(props: {
  data: { items: LedgerRow[]; nextCursor: string | null } | null;
  error: boolean;
  filtered: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onOpenOrder: (orderId: string) => void;
  onNextPage: (cursor: string) => void;
}) {
  if (props.data === null) {
    return props.error ? (
      <LabPanelState
        kind="error"
        title="Orders could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={props.onRetry}
      />
    ) : (
      <LabPanelState kind="loading" title="Loading orders" body="" />
    );
  }
  if (props.data.items.length === 0) {
    return props.filtered ? (
      <LabPanelState
        kind="filtered-empty"
        title="No orders match these evidence filters"
        body="Loosen the evidence filters to see more orders."
        onClearFilters={props.onClearFilters}
      />
    ) : (
      <LabPanelState
        kind="empty"
        title="No Shopify orders in this range"
        body=""
      />
    );
  }
  return (
    <div className="space-y-2">
      {props.error ? (
        <p className="rounded-md border border-amber-300 p-2 text-xs">
          Refresh failed — showing previously loaded orders.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead colSpan={4} className="text-xs uppercase">
                Shopify truth
              </TableHead>
              <TableHead colSpan={4} className="text-xs uppercase">
                Klaviyo evidence (advisory)
              </TableHead>
            </TableRow>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Net sales</TableHead>
              <TableHead>Current bucket</TableHead>
              <TableHead>Order status</TableHead>
              <TableHead>Product status</TableHead>
              <TableHead>Claims</TableHead>
              <TableHead>Warnings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.data.items.map((row) => (
              <TableRow
                key={row.orderId}
                className="cursor-pointer"
                onClick={() => props.onOpenOrder(row.orderId)}
              >
                <TableCell>{row.orderName ?? row.orderId}</TableCell>
                <TableCell>{row.orderDay}</TableCell>
                <TableCell>{row.netSales}</TableCell>
                <TableCell>{row.bucket ?? "—"}</TableCell>
                <TableCell>
                  {row.orderStatus === "duplicate_conversion_events" ? (
                    <span>Multiple conversion events</span>
                  ) : row.orderStatus === "candidate" ? (
                    <span>Candidate (advisory)</span>
                  ) : (
                    (EVENT_STATUS_LABELS[row.orderStatus] ??
                      row.orderStatus.replaceAll("_", " "))
                  )}
                </TableCell>
                <TableCell>{row.productStatus ?? "—"}</TableCell>
                <TableCell>
                  {row.orderStatus === "duplicate_conversion_events"
                    ? "—"
                    : row.claimCount}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.boundaryWarning ? "Boundary" : ""}
                  {row.orderStatus === "duplicate_conversion_events"
                    ? " Duplicate conversions"
                    : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {props.data.nextCursor !== null ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => props.onNextPage(props.data!.nextCursor!)}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
