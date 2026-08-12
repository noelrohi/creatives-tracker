"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LabPanelState } from "./panel-state";

export type SyncRunRow = {
  id: string;
  operation: string;
  status: string;
  requestedFrom: string | Date | null;
  requestedTo: string | Date | null;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsIgnored: number;
  warningCount: number;
  failureCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  checkpointSummary: {
    sourceMode?: string | null;
    metricIndex?: number | null;
    page?: number | null;
  } | null;
  startedAt: string | Date;
  finishedAt: string | Date | null;
};

function short(value: string | Date | null): string {
  if (value === null) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Recent sync runs with explicit field rendering only. The server projects
 * a safe checkpoint summary (`sourceMode`, `metricIndex`, `page`); the
 * stored opaque provider cursor and raw request/checkpoint JSON are never
 * rendered or inferred, and hostile extra fields never reach the DOM
 * because each cell names its exact field.
 */
export function SyncRunsPanel(props: {
  runs: SyncRunRow[] | null;
  error: boolean;
  stale: boolean;
  onRetry: () => void;
}) {
  if (props.runs === null) {
    return props.error ? (
      <LabPanelState
        kind="error"
        title="Sync runs could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={props.onRetry}
      />
    ) : (
      <LabPanelState kind="loading" title="Loading runs" body="" />
    );
  }
  return (
    <div className="space-y-2">
      {props.stale ? (
        <p className="rounded-md border border-amber-300 p-2 text-xs">
          Refresh failed — showing previously loaded runs.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Operation</TableHead>
              <TableHead>Range</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Read</TableHead>
              <TableHead>Inserted</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>Ignored</TableHead>
              <TableHead>Warnings</TableHead>
              <TableHead>Failures</TableHead>
              <TableHead>Checkpoint</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{run.operation}</TableCell>
                <TableCell className="text-xs">
                  {short(run.requestedFrom)} → {short(run.requestedTo)}
                </TableCell>
                <TableCell>{run.status}</TableCell>
                <TableCell>{run.rowsRead}</TableCell>
                <TableCell>{run.rowsInserted}</TableCell>
                <TableCell>{run.rowsUpdated}</TableCell>
                <TableCell>{run.rowsIgnored}</TableCell>
                <TableCell>{run.warningCount}</TableCell>
                <TableCell>{run.failureCount}</TableCell>
                <TableCell className="text-xs">
                  {run.checkpointSummary
                    ? [
                        run.checkpointSummary.sourceMode ?? null,
                        run.checkpointSummary.metricIndex === null ||
                        run.checkpointSummary.metricIndex === undefined
                          ? null
                          : `metric ${run.checkpointSummary.metricIndex}`,
                        run.checkpointSummary.page === null ||
                        run.checkpointSummary.page === undefined
                          ? null
                          : `page ${run.checkpointSummary.page}`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"
                    : "—"}
                </TableCell>
                <TableCell className="text-xs">
                  {run.errorCode ? `${run.errorCode}` : "—"}
                </TableCell>
                <TableCell className="text-xs">{short(run.startedAt)}</TableCell>
                <TableCell className="text-xs">{short(run.finishedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
