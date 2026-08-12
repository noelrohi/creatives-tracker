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
import type { ReportKind } from "./copy";
import { LabPanelState } from "./panel-state";

export type ReportsData = {
  generationId: string | null;
  publishedAt: string | Date | null;
  facts: Array<{
    id: string;
    grouping: Record<string, unknown>;
    conversions: string | null;
    conversionValue: string | null;
    recipients: string | null;
    uniqueClicks: string | null;
    uniqueOpens: string | null;
    campaignObjectId: string | null;
    flowObjectId: string | null;
    asOf: string | Date;
  }>;
};

/**
 * Aggregate Klaviyo claims — not order-level attribution. Dates carry the
 * Klaviyo account timezone's message-send-day semantics and are never
 * labelled as Shopify order-occurrence time.
 */
export function ReportsTable(props: {
  data: ReportsData | null;
  error: boolean;
  accountTimezone: string;
  kind: ReportKind;
  range: { dateFrom: string; dateTo: string };
  busy: boolean;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  if (props.data === null) {
    return props.error ? (
      <LabPanelState
        kind="error"
        title="Reports could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={props.onRetry}
      />
    ) : (
      <LabPanelState kind="loading" title="Loading reports" body="" />
    );
  }
  const asOf = props.data.facts[0]?.asOf ?? null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p>Aggregate Klaviyo claims — not order-level attribution.</p>
          <p>
            Report dates use {props.accountTimezone} message-send days ·{" "}
            {props.range.dateFrom} → {props.range.dateTo}
            {asOf
              ? ` · as of ${
                  typeof asOf === "string" ? asOf : asOf.toISOString()
                }`
              : ""}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onRefresh}
        >
          Refresh {props.kind} report
        </Button>
      </div>
      {props.data.facts.length === 0 ? (
        <LabPanelState
          kind="empty"
          title="No published report facts for this slot"
          body="Refresh to request the current range from Klaviyo."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Marketing object</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Send date</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Unique opens</TableHead>
                <TableHead>Unique clicks</TableHead>
                <TableHead>Conversions</TableHead>
                <TableHead>Klaviyo conversion value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.data.facts.map((fact) => (
                <TableRow key={fact.id}>
                  <TableCell className="font-mono text-xs">
                    {fact.campaignObjectId ?? fact.flowObjectId ?? "—"}
                  </TableCell>
                  <TableCell>{props.kind}</TableCell>
                  <TableCell className="text-xs">
                    {typeof fact.grouping.send_date === "string"
                      ? fact.grouping.send_date
                      : "—"}
                  </TableCell>
                  <TableCell>{fact.recipients ?? "—"}</TableCell>
                  <TableCell>{fact.uniqueOpens ?? "—"}</TableCell>
                  <TableCell>{fact.uniqueClicks ?? "—"}</TableCell>
                  <TableCell>{fact.conversions ?? "—"}</TableCell>
                  <TableCell>{fact.conversionValue ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
