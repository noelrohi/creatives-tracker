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
  LAB_RANGES,
  LAB_VIEWS,
  ORDER_STATUS_FILTERS,
  PRODUCT_STATUS_FILTERS,
  REPORT_KINDS,
  type JourneyLookback,
  type LabRange,
  type LabView,
} from "./copy";

export type ResolvedDayRange = {
  dateFrom: string;
  dateTo: string;
  timezoneKind: "store" | "account";
};

/**
 * Pure inclusive-day range resolver. `today` is the applicable
 * timezone-local calendar day (store today for orders/unmatched/probe,
 * account today for reports); the UI never calls `new Date(day)` to build
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
  const timezoneKind = input.view === "reports" ? "account" : "store";
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

const parsers = {
  view: parseAsStringLiteral(LAB_VIEWS).withDefault("orders"),
  range: parseAsStringLiteral(LAB_RANGES).withDefault("last30"),
  from: parseAsString,
  to: parseAsString,
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
  reportKind: parseAsStringLiteral(REPORT_KINDS).withDefault("campaign"),
};

/**
 * URL state owns view, range, filters, and detail selection. Arbitrary
 * URL values fall back locally instead of reaching tRPC, so a stale
 * bookmark can never turn into a validation error. Filter and view
 * changes clear cursors; leaving `orders` clears the order/candidate
 * detail so it cannot float over the other views.
 */
export function useKlaviyoLabState() {
  const [state, setState] = useQueryStates(parsers, { history: "replace" });

  const setView = (view: LabView) => {
    void setState({
      view,
      ...(view === "orders" ? {} : { order: null, candidate: null }),
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
    });
  };
  return {
    state,
    setState,
    setView,
    openOrder,
    closeDetail,
    clearFilters,
    lookback: resolveJourneyLookback(state.lookback),
  };
}
