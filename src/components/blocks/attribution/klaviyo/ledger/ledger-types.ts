import type { RouterOutputs } from "@/lib/trpc/client";

export type LedgerListData = RouterOutputs["klaviyo"]["ledger"]["list"];
export type LedgerRowData = LedgerListData["rows"][number];
export type LedgerMessageData =
  RouterOutputs["klaviyo"]["ledger"]["messages"][number];
export type LedgerDetailData = RouterOutputs["klaviyo"]["ledger"]["detail"];
export type LedgerLevel = "campaign" | "flow" | "message";

/** Client cache only; matches the Meta ledger's stale time. */
export const LEDGER_STALE_TIME_MS = 3 * 60 * 1000;
