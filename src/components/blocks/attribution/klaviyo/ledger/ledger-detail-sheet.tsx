"use client";

import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTRPC } from "@/lib/trpc/client";
import { ledger as copy } from "../copy";
import { LabPanelState } from "../panel-state";
import type { useKlaviyoLabState } from "../use-klaviyo-lab-state";
import { LedgerDetailContent } from "./ledger-detail-content";
import { LEDGER_STALE_TIME_MS } from "./ledger-types";

/**
 * URL-addressable (`source=<objectId>`) one-third-width sheet. Only the
 * ledger view opens it; on the orders view the same param is a filter.
 */
export function LedgerDetailSheet({
  lab,
  range,
}: {
  lab: ReturnType<typeof useKlaviyoLabState>;
  range: { dateFrom: string; dateTo: string } | null;
}) {
  const trpc = useTRPC();
  const objectId = lab.state.view === "ledger" ? lab.state.source : null;
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
    <Sheet open onOpenChange={(open) => { if (!open) lab.closeSource(); }}>
      <SheetContent side="right" // The Sheet primitive caps a right sheet with `data-[side=right]:sm:max-w-sm`;
        // a plain `sm:max-w-none` loses to that attribute selector, so the
        // override must carry the same variant.
        className="w-full overflow-y-auto data-[side=right]:sm:w-[66vw] data-[side=right]:sm:max-w-none sm:min-w-[380px]">
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
              onViewOrders={() =>
                lab.viewOrdersForSource(
                  detail.data.object.objectId,
                  // A campaign's orders run past the ledger window; the send
                  // day is only a range START, so the UTC day is enough.
                  detail.data.object.objectType === "campaign" && detail.data.object.sentAt
                    ? new Date(detail.data.object.sentAt).toISOString().slice(0, 10)
                    : null,
                )
              }
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
