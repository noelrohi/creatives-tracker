"use client";

import { useCallback, useState } from "react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { subDays } from "date-fns";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { AWARENESS, FORMATS } from "./creative-list-filters";

export function useCreativeFilters() {
  const [format, setFormat] = useQueryState(
    "format",
    parseAsStringLiteral(FORMATS).withDefault(undefined as unknown as (typeof FORMATS)[number]),
  );
  const [awareness, setAwareness] = useQueryState(
    "awareness",
    parseAsStringLiteral(AWARENESS).withDefault(undefined as unknown as (typeof AWARENESS)[number]),
  );
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [adSetIds, setAdSetIds] = useQueryState("adSet", parseAsString.withDefault(""));
  const [healthFilter, setHealthFilter] = useQueryState("health", parseAsString.withDefault(""));
  const [teamId, setTeamId] = useQueryState("team", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 6))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));
  const [landingPageUrls, setLandingPageUrls] = useState<string[]>([]);
  const [minRoas, setMinRoas] = useState("");
  const [minConversions, setMinConversions] = useState("");
  const [minCtr, setMinCtr] = useState("");

  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 6));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());

  const clearFilters = useCallback(() => {
    setFormat(null);
    setAwareness(null);
    setSearch("");
    setAccountId("");
    setAdSetIds("");
    setLandingPageUrls([]);
    setMinRoas("");
    setMinConversions("");
    setMinCtr("");
    setTeamId("");
    setHealthFilter("");
  }, [setAccountId, setAdSetIds, setAwareness, setFormat, setHealthFilter, setSearch, setTeamId]);

  const hasFilters = Boolean(
    format || awareness || search || accountId || adSetIds || landingPageUrls.length ||
    minRoas || minConversions || minCtr || healthFilter || teamId,
  );

  return {
    format, setFormat, awareness, setAwareness, search, setSearch,
    accountId, setAccountId, adSetIds, setAdSetIds,
    landingPageUrls, setLandingPageUrls,
    minRoas, setMinRoas, minConversions, setMinConversions, minCtr, setMinCtr,
    healthFilter, setHealthFilter, teamId, setTeamId,
    fromValue, toValue,
    fromDate: parseDateOnly(fromValue),
    toDate: parseDateOnly(toValue),
    setFrom, setTo,
    clearFilters, hasFilters,
  };
}
