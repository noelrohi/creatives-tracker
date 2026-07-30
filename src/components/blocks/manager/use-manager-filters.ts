"use client";

import { useCallback, useEffect, useState } from "react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { subDays } from "date-fns";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";

export const MANAGER_STATUSES = ["active", "paused", "archived"] as const;

export type ManagerStatus = (typeof MANAGER_STATUSES)[number];

const SEARCH_DEBOUNCE_MS = 300;

export function useManagerFilters() {
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [status, setStatus] = useQueryState(
    "status",
    parseAsStringLiteral(MANAGER_STATUSES).withDefault(undefined as unknown as ManagerStatus),
  );
  const [search, setSearch] = useQueryState("q", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));

  // The input stays instant while the query only sees the settled value.
  const [searchInput, setSearchInput] = useState(search);
  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => {
      setSearch(searchInput || null);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, searchInput, setSearch]);

  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());

  const clearFilters = useCallback(() => {
    setAccountId("");
    setStatus(null);
    setSearchInput("");
    setSearch(null);
  }, [setAccountId, setSearch, setStatus]);

  const hasFilters = Boolean(accountId || status || search);

  return {
    accountId, setAccountId,
    status, setStatus,
    search,
    searchInput, setSearchInput,
    fromValue, toValue,
    fromDate: parseDateOnly(fromValue),
    toDate: parseDateOnly(toValue),
    setFrom, setTo,
    clearFilters, hasFilters,
  };
}
