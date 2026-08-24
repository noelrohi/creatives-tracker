"use client";

import type { ReactNode } from "react";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { BucketOrdersPanel } from "./bucket-orders-panel";
import { GoogleAdsRevenuePanel } from "./google-ads/revenue-panel";
import { EmailRevenuePanel } from "./klaviyo/email-revenue-panel";
import { MetaRevenuePanel } from "./meta/revenue-panel";

export type SourceDrawerProps = {
  bucket: AttributionBucket;
  dateFrom: string;
  dateTo: string;
  currency: string;
  timeZone: string;
  role: string | null;
  shopDomain: string | null;
  shopifyTotal: string | null;
  metaDown: boolean;
  detailHref: string;
  onClose: () => void;
};

/**
 * Per-source drawer furniture: the source's revenue panel above the orders
 * table. The way into a source's own screen is not here — `SourceActionLink`
 * sits on the ledger row itself, beside the share figure. Buckets missing
 * from this map get the plain orders table and nothing else.
 */
const PANELS: Partial<
  Record<AttributionBucket, (props: SourceDrawerProps) => ReactNode>
> = {
  meta: (p) => (
    <MetaRevenuePanel
      dateFrom={p.dateFrom}
      dateTo={p.dateTo}
      currency={p.currency}
      metaDown={p.metaDown}
      detailHref={p.detailHref}
      shopifyTotal={p.shopifyTotal}
    />
  ),
  google: (p) => (
    <GoogleAdsRevenuePanel
      role={p.role}
      dateFrom={p.dateFrom}
      dateTo={p.dateTo}
      currency={p.currency}
      shopifyTotal={p.shopifyTotal}
    />
  ),
  klaviyo: (p) => (
    <EmailRevenuePanel
      role={p.role}
      dateFrom={p.dateFrom}
      dateTo={p.dateTo}
      currency={p.currency}
      shopifyTotal={p.shopifyTotal}
    />
  ),
};

export function SourceDrawer(props: SourceDrawerProps) {
  const panel = PANELS[props.bucket];
  return (
    <div className="flex flex-col gap-2 px-1 pb-2 pt-1">
      {panel ? panel(props) : null}
      <BucketOrdersPanel
        bucket={props.bucket}
        dateFrom={props.dateFrom}
        dateTo={props.dateTo}
        currency={props.currency}
        timeZone={props.timeZone}
        shopDomain={props.shopDomain}
        onClose={props.onClose}
      />
    </div>
  );
}
