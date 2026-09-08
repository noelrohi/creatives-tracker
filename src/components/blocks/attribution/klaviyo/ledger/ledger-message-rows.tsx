"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { ledger as copy } from "../copy";
import { LedgerChildSkeletonRow, LedgerRow, LedgerStateRow } from "./ledger-row";
import { sortLedgerRows, type LedgerSort } from "./ledger-sort";
import { LEDGER_STALE_TIME_MS, type LedgerRowData } from "./ledger-types";

export function LedgerMessageRows({
  parent,
  range,
  sort,
}: {
  parent: LedgerRowData;
  range: { dateFrom: string; dateTo: string };
  sort: LedgerSort;
}) {
  const trpc = useTRPC();
  const messages = useQuery(
    trpc.klaviyo.ledger.messages.queryOptions(
      {
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        objectId: parent.objectId,
      },
      { staleTime: LEDGER_STALE_TIME_MS },
    ),
  );
  if (messages.isPending) return <LedgerChildSkeletonRow />;
  if (messages.isError) {
    return (
      <LedgerStateRow>
        <span className="pl-6 text-muted-foreground">{copy.messagesError}</span>
      </LedgerStateRow>
    );
  }
  if (messages.data.length === 0) {
    return (
      <LedgerStateRow>
        <span className="pl-6 text-muted-foreground">{copy.noMessages}</span>
      </LedgerStateRow>
    );
  }
  return (
    <>
      {sortLedgerRows(messages.data, sort).map((message) => (
        <LedgerRow key={message.objectId} row={message} level="message" />
      ))}
    </>
  );
}
