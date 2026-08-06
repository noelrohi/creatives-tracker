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
import { LabPanelState } from "./panel-state";

export type UnmatchedRow = {
  eventId: string;
  occurredAt: string | Date;
  eventStatus: string;
  boundaryWarning: boolean;
};

/**
 * Event-side ledger. `not_evaluated` is `Outside evaluated boundary` — a
 * Shopify counterpart may exist outside the evaluated window; it is never
 * relabelled unmatched, and no Shopify order or Net sales label appears.
 */
export function UnmatchedEventsTable(props: {
  data: { items: UnmatchedRow[]; nextCursor: string | null } | null;
  error: boolean;
  onRetry: () => void;
  onNextPage: (cursor: string) => void;
}) {
  if (props.data === null) {
    return props.error ? (
      <LabPanelState
        kind="error"
        title="Unmatched events could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={props.onRetry}
      />
    ) : (
      <LabPanelState kind="loading" title="Loading events" body="" />
    );
  }
  if (props.data.items.length === 0) {
    return (
      <LabPanelState
        kind="empty"
        title="No non-confirmed Klaviyo events in this range"
        body=""
      />
    );
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event time</TableHead>
              <TableHead>Event status</TableHead>
              <TableHead>Klaviyo observation</TableHead>
              <TableHead>Warnings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.data.items.map((row) => (
              <TableRow key={row.eventId}>
                <TableCell className="text-xs">
                  {typeof row.occurredAt === "string"
                    ? row.occurredAt
                    : row.occurredAt.toISOString()}
                </TableCell>
                <TableCell>
                  {row.eventStatus === "not_evaluated"
                    ? "Outside evaluated boundary"
                    : row.eventStatus}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  Klaviyo observation — not Shopify Net sales
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.eventStatus === "not_evaluated"
                    ? "A Shopify counterpart may exist outside this evaluated window"
                    : row.boundaryWarning
                      ? "Boundary"
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
