"use client";

import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTRPC } from "@/lib/trpc/client";
import { ledger as copy } from "../copy";
import { LabPanelState } from "../panel-state";
import { LedgerDetailContent } from "./ledger-detail-content";
import { LEDGER_STALE_TIME_MS } from "./ledger-types";

/**
 * The detail sheet for one campaign or flow. Callers own the `source` URL
 * param and pass the selected id; `onViewOrders` is optional because only
 * privileged viewers can reach the orders view it links to.
 */
export function LedgerDetailSheet({
  objectId,
  range,
  onClose,
  onViewOrders,
}: {
  objectId: string | null;
  range: { dateFrom: string; dateTo: string } | null;
  onClose: () => void;
  onViewOrders?: (objectId: string, sentDay: string | null) => void;
}) {
  const trpc = useTRPC();
  const detail = useQuery({
    ...trpc.klaviyo.ledger.detail.queryOptions(
      { dateFrom: range?.dateFrom ?? "", dateTo: range?.dateTo ?? "", objectId: objectId ?? "" },
      { staleTime: LEDGER_STALE_TIME_MS },
    ),
    enabled: objectId !== null && range !== null,
    retry: false,
  });
  if (objectId === null) return null;
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* The Sheet primitive caps a right sheet with
          `data-[side=right]:sm:max-w-sm`; a plain `sm:max-w-none` loses to
          that attribute selector, so the override carries the same variant. */}
      <SheetContent
        side="right"
        className="w-full overflow-y-auto data-[side=right]:sm:w-[50vw] data-[side=right]:sm:max-w-none sm:min-w-[380px]"
      >
        <SheetHeader>
          <SheetTitle>{copy.sheet.title}</SheetTitle>
          <p className="text-xs text-muted-foreground">{copy.sheet.advisory}</p>
        </SheetHeader>
        <div className="px-4 pb-6">
          {detail.isError ? (
            <LabPanelState kind="error" title={copy.sheet.error} body="" onRetry={() => void detail.refetch()} />
          ) : !detail.data ? (
            <LabPanelState kind="loading" title={copy.sheet.loading} body="" />
          ) : (
            <LedgerDetailContent
              detail={detail.data}
              onViewOrders={
                onViewOrders
                  ? () =>
                      onViewOrders(
                        detail.data.object.objectId,
                        // A campaign's orders run past the ledger window; the send
                        // day is only a range START, so the UTC day is enough.
                        detail.data.object.objectType === "campaign" && detail.data.object.sentAt
                          ? new Date(detail.data.object.sentAt).toISOString().slice(0, 10)
                          : null,
                      )
                  : undefined
              }
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
