"use client";

import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateOnly } from "@/lib/date";
import { isDay } from "@/lib/day";
import {
  LAB_RANGES,
  type LedgerChannelFilter,
  type LedgerKindFilter,
} from "../copy";
import { LedgerSearch } from "./ledger-search";
import type { LedgerUrlPatch, LedgerUrlState } from "./ledger-url-state";

/**
 * The picker works in local-time Dates that stand for CALENDAR DAYS, never
 * instants: a lab day (already validated by the resolver) becomes local
 * midnight, and `formatDateOnly` reads it back as the same day whatever the
 * browser's zone. A malformed day falls back to the given day.
 */
function dayToLocalDate(day: string, fallback: string): Date {
  const safe = isDay(day) ? day : fallback;
  const [year, month, date] = safe.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/**
 * Range preset + calendar + caption. Shared by every lab view and the
 * campaigns page; `today` is the active timezone's calendar day.
 */
export function LabRangeControls(props: {
  state: Pick<LedgerUrlState, "range">;
  setState: (patch: LedgerUrlPatch) => unknown;
  range: { dateFrom: string; dateTo: string };
  today: string;
  timezoneLabel: string;
}) {
  const { state, setState } = props;
  return (
    <>
      <Select
        value={state.range}
        onValueChange={(value) => {
          const range = value as (typeof LAB_RANGES)[number];
          // Switching to Custom seeds the picker with the range currently
          // shown, so nothing jumps until the user picks new dates.
          void setState(
            range === "custom"
              ? { range, from: props.range.dateFrom, to: props.range.dateTo }
              : { range },
          );
        }}
      >
        <SelectTrigger className="h-8 w-32" aria-label="Date range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="last7">Last 7 days</SelectItem>
          <SelectItem value="last30">Last 30 days</SelectItem>
          <SelectItem value="last90">Last 90 days</SelectItem>
          <SelectItem value="custom">Custom</SelectItem>
        </SelectContent>
      </Select>
      {state.range === "custom" ? (
        // Presets and the selectable ceiling follow the active timezone's
        // today, not the browser's: a Melbourne store's current day must be
        // pickable from Los Angeles, and "Yesterday" means the store's.
        <DateRangePicker
          from={dayToLocalDate(props.range.dateFrom, props.today)}
          to={dayToLocalDate(props.range.dateTo, props.today)}
          today={dayToLocalDate(props.today, props.today)}
          onChange={(range) => {
            if (!range) return;
            void setState({
              from: formatDateOnly(range.from),
              to: formatDateOnly(range.to),
            });
          }}
        />
      ) : null}
      <span className="text-xs text-muted-foreground">
        {props.range.dateFrom} → {props.range.dateTo} · {props.timezoneLabel}
      </span>
    </>
  );
}

/** Kind, channel, and search — the ledger's own filters. */
export function LedgerFilters(props: {
  state: Pick<LedgerUrlState, "ledgerKind" | "ledgerChannel" | "q">;
  setState: (patch: LedgerUrlPatch) => unknown;
}) {
  const { state, setState } = props;
  return (
    <>
      <Select
        value={state.ledgerKind}
        onValueChange={(value) =>
          void setState({ ledgerKind: value as LedgerKindFilter })
        }
      >
        <SelectTrigger className="h-8 w-36" aria-label="Kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Campaigns &amp; flows</SelectItem>
          <SelectItem value="campaign">Campaigns</SelectItem>
          <SelectItem value="flow">Flows</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={state.ledgerChannel}
        onValueChange={(value) =>
          void setState({ ledgerChannel: value as LedgerChannelFilter })
        }
      >
        <SelectTrigger className="h-8 w-32" aria-label="Channel">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All channels</SelectItem>
          <SelectItem value="email">Email</SelectItem>
          <SelectItem value="sms">SMS</SelectItem>
        </SelectContent>
      </Select>
      <LedgerSearch
        value={state.q ?? ""}
        onChange={(q) => void setState({ q: q === "" ? null : q })}
      />
    </>
  );
}
