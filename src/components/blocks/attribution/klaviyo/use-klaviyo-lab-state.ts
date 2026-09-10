"use client";

import {
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  useQueryStates,
} from "nuqs";
import { addDays, isDay } from "@/components/blocks/attribution/days";
import { BUCKET_ORDER } from "@/components/blocks/attribution/buckets";
import {
  CHANNEL_FILTERS,
  CLAIM_TYPE_FILTERS,
  DETAIL_TABS,
  JOURNEY_LOOKBACKS,
  LAB_VIEWS,
  ORDER_STATUS_FILTERS,
  PRODUCT_STATUS_FILTERS,
  type JourneyLookback,
  type LabRange,
  type LabView,
} from "./copy";
import {
  LEDGER_URL_PARSERS,
  ledgerStateHelpers,
} from "./ledger/ledger-url-state";

export type ResolvedDayRange = {
  dateFrom: string;
  dateTo: string;
  timezoneKind: "store" | "account";
};

/**
 * Pure inclusive-day range resolver. `today` is the applicable
 * timezone-local calendar day (store today for orders/unmatched/probe,
 * account today for the ledger); the UI never calls `new Date(day)` to build
 * the backend window — the router owns the one timezone conversion.
 */
export function resolveLabDayRange(input: {
  view: LabView;
  range: LabRange;
  from: string | null;
  to: string | null;
  storeToday: string;
  accountToday: string;
}): ResolvedDayRange {
  const timezoneKind = input.view === "ledger" ? "account" : "store";
  const today = timezoneKind === "account" ? input.accountToday : input.storeToday;
  if (input.range !== "custom") {
    const days = input.range === "last7" ? 7 : input.range === "last30" ? 30 : 90;
    return { dateFrom: addDays(today, -(days - 1)), dateTo: today, timezoneKind };
  }
  let dateFrom = input.from && isDay(input.from) ? input.from : addDays(today, -29);
  let dateTo = input.to && isDay(input.to) ? input.to : today;
  // Custom future days clamp to the active view's today.
  if (dateTo > today) dateTo = today;
  if (dateFrom > today) dateFrom = today;
  // Reversed input collapses to the earlier valid day.
  if (dateFrom > dateTo) dateTo = dateFrom;
  return { dateFrom, dateTo, timezoneKind };
}

export function resolveJourneyLookback(value: number | null): JourneyLookback {
  return (JOURNEY_LOOKBACKS as readonly number[]).includes(value ?? -1)
    ? (value as JourneyLookback)
    : 30;
}

export const LAB_URL_PARSERS = {
  ...LEDGER_URL_PARSERS,
  // The ledger is the lab's front page (spec §10); the evidence views sit
  // behind it.
  view: parseAsStringLiteral(LAB_VIEWS).withDefault("ledger"),
  orderStatus: parseAsStringLiteral(ORDER_STATUS_FILTERS).withDefault("all"),
  productStatus: parseAsStringLiteral(PRODUCT_STATUS_FILTERS).withDefault("all"),
  claimType: parseAsStringLiteral(CLAIM_TYPE_FILTERS).withDefault("all"),
  channel: parseAsStringLiteral(CHANNEL_FILTERS).withDefault("all"),
  bucket: parseAsStringLiteral([
    "all",
    ...BUCKET_ORDER,
  ] as readonly string[]).withDefault("all"),
  order: parseAsString,
  candidate: parseAsString,
  detail: parseAsStringLiteral(DETAIL_TABS).withDefault("explanation"),
  lookback: parseAsInteger,
};

/**
 * URL state owns view, range, filters, and detail selection. Arbitrary
 * URL values fall back locally instead of reaching tRPC, so a stale
 * bookmark can never turn into a validation error. Filter and view
 * changes clear cursors; leaving `orders` clears the order/candidate
 * detail so it cannot float over the other views.
 */
export function useKlaviyoLabState() {
  const [state, setState] = useQueryStates(LAB_URL_PARSERS, {
    history: "replace",
  });

  const setView = (view: LabView) => {
    void setState({
      view,
      ...(view === "orders" ? {} : { order: null, candidate: null }),
      // `source` means "open sheet" on the ledger and "filter" on orders; any
      // other view drops it so it cannot float.
      ...(view === "orders" || view === "ledger" ? {} : { source: null }),
    });
  };
  const closeDetail = () => {
    void setState({ order: null, candidate: null, detail: "explanation" });
  };
  const openOrder = (orderId: string, candidateId?: string | null) => {
    void setState({
      order: orderId,
      candidate: candidateId ?? null,
      detail: "explanation",
    });
  };
  const clearFilters = () => {
    void setState({
      orderStatus: "all",
      productStatus: "all",
      claimType: "all",
      channel: "all",
      bucket: "all",
      source: null,
      q: null,
      ledgerKind: "all",
      ledgerChannel: "all",
    });
  };
  const ledger = ledgerStateHelpers(state, setState);
  /**
   * A campaign's orders are unwindowed on the ledger but the orders view has
   * its own date range, so a send's later orders would fall outside the
   * current range. `sentDay` (campaigns only; flows pass null) reopens the
   * range as an open-ended custom range starting at the send day.
   */
  const viewOrdersForSource = (objectId: string, sentDay?: string | null) =>
    void setState({
      view: "orders",
      source: objectId,
      order: null,
      candidate: null,
      ...(sentDay ? { range: "custom" as const, from: sentDay, to: null } : {}),
    });
  return {
    state,
    setState,
    setView,
    openOrder,
    closeDetail,
    clearFilters,
    openSource: ledger.openSource,
    closeSource: ledger.closeSource,
    viewOrdersForSource,
    toggleSort: ledger.toggleSort,
    lookback: resolveJourneyLookback(state.lookback),
  };
}
