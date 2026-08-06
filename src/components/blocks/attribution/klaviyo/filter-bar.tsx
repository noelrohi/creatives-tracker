"use client";

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
  LAB_RANGES,
  ORDER_STATUS_FILTERS,
  ORDER_STATUS_LABELS,
  PRODUCT_STATUS_FILTERS,
  REPORT_KINDS,
  type LabView,
} from "./copy";
import type { useKlaviyoLabState } from "./use-klaviyo-lab-state";

/**
 * View-scoped filters: orders show the full evidence filter set, unmatched
 * shows date and channel only, reports show account-day date, channel, and
 * report kind, probe shows none. Hidden filters never enter query input.
 * The visible timezone label follows the active view's semantics.
 */
export function LabFilterBar(props: {
  view: LabView;
  range: { dateFrom: string; dateTo: string };
  storeTimezone: string;
  accountTimezone: string;
  lab: ReturnType<typeof useKlaviyoLabState>;
}) {
  const { state, setState } = props.lab;
  const timezoneLabel =
    props.view === "reports"
      ? `Report dates use ${props.accountTimezone} message-send days`
      : `Order dates use ${props.storeTimezone} store days`;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select
        value={state.range}
        onValueChange={(value) =>
          void setState({ range: value as (typeof LAB_RANGES)[number] })
        }
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
      <span className="text-xs text-muted-foreground">
        {props.range.dateFrom} → {props.range.dateTo} · {timezoneLabel}
      </span>

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

      {props.view === "orders" || props.view === "unmatched" || props.view === "reports" ? (
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

      {props.view === "reports" ? (
        <Select
          value={state.reportKind}
          onValueChange={(value) =>
            void setState({ reportKind: value as (typeof REPORT_KINDS)[number] })
          }
        >
          <SelectTrigger className="h-8 w-32" aria-label="Report kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPORT_KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
