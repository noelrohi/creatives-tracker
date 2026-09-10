"use client";

import { X } from "@/components/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BUCKET_ORDER } from "@/components/blocks/attribution/buckets";
import {
  CHANNEL_FILTERS,
  CLAIM_TYPE_FILTERS,
  ORDER_STATUS_FILTERS,
  ORDER_STATUS_LABELS,
  PRODUCT_STATUS_FILTERS,
  ledger as ledgerCopy,
  type LabView,
} from "./copy";
import { LabRangeControls, LedgerFilters } from "./ledger/ledger-filters";
import type { useKlaviyoLabState } from "./use-klaviyo-lab-state";

/**
 * View-scoped filters: orders show the full evidence filter set, unmatched
 * shows date and channel only, the ledger shows account-day date, kind,
 * channel, and search, probe shows none. Hidden filters never enter query
 * input. The visible timezone label follows the active view's semantics.
 */
export function LabFilterBar(props: {
  view: LabView;
  range: { dateFrom: string; dateTo: string };
  /** Today in the active view's timezone (store or account), "YYYY-MM-DD". */
  today: string;
  storeTimezone: string;
  accountTimezone: string;
  lab: ReturnType<typeof useKlaviyoLabState>;
}) {
  const { state, setState } = props.lab;
  const timezoneLabel =
    props.view === "ledger"
      ? `Send dates use ${props.accountTimezone} account days`
      : `Order dates use ${props.storeTimezone} store days`;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <LabRangeControls
        state={state}
        setState={setState}
        range={props.range}
        today={props.today}
        timezoneLabel={timezoneLabel}
      />

      {props.view === "orders" ? (
        <>
          <Select
            value={state.orderStatus}
            onValueChange={(value) =>
              void setState({
                orderStatus: value as (typeof ORDER_STATUS_FILTERS)[number],
              })
            }
          >
            <SelectTrigger className="h-8 w-44" aria-label="Order status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDER_STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {ORDER_STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={state.productStatus}
            onValueChange={(value) =>
              void setState({
                productStatus: value as (typeof PRODUCT_STATUS_FILTERS)[number],
              })
            }
          >
            <SelectTrigger className="h-8 w-36" aria-label="Product status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRODUCT_STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "all" ? "All products" : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={state.claimType}
            onValueChange={(value) =>
              void setState({
                claimType: value as (typeof CLAIM_TYPE_FILTERS)[number],
              })
            }
          >
            <SelectTrigger className="h-8 w-36" aria-label="Claim type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLAIM_TYPE_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "all" ? "All claims" : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={state.bucket}
            onValueChange={(value) => void setState({ bucket: value })}
          >
            <SelectTrigger className="h-8 w-40" aria-label="Current bucket">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All buckets</SelectItem>
              {BUCKET_ORDER.map((bucket) => (
                <SelectItem key={bucket} value={bucket}>
                  {bucket.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : null}

      {props.view === "orders" || props.view === "unmatched" ? (
        <Select
          value={state.channel}
          onValueChange={(value) =>
            void setState({ channel: value as (typeof CHANNEL_FILTERS)[number] })
          }
        >
          <SelectTrigger className="h-8 w-32" aria-label="Channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all" ? "All channels" : value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {props.view === "ledger" ? (
        <LedgerFilters state={state} setState={setState} />
      ) : null}

      {props.view === "orders" && state.source !== null ? (
        <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
          {ledgerCopy.sourceFilter}
          <button
            type="button"
            aria-label={ledgerCopy.clearSource}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void setState({ source: null })}
          >
            <X className="size-3" />
          </button>
        </span>
      ) : null}
    </div>
  );
}
