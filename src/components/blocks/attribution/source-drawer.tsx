"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { MousePointerClick } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { BucketOrdersPanel } from "./bucket-orders-panel";
import { GoogleAdsLabLink } from "./google-ads/lab-link";
import { GoogleAdsRevenuePanel } from "./google-ads/revenue-panel";
import { EmailRevenuePanel } from "./klaviyo/email-revenue-panel";
import { KlaviyoLabLink } from "./klaviyo/lab-link";
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

/** Visible to every role — /meta is not privileged, unlike the labs. */
function MetaDashboardLink() {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/meta">
        <MousePointerClick className="size-4" />
        Meta dashboard
      </Link>
    </Button>
  );
}

/**
 * Per-source drawer furniture. The action button lives in the drawer chrome
 * rather than inside the panels because the panels are privileged-only while
 * the Meta dashboard is for every role. Buckets missing from this map get the
 * plain orders table and nothing else.
 */
const SOURCES: Partial<
  Record<
    AttributionBucket,
    {
      action: (props: SourceDrawerProps) => ReactNode;
      panel: (props: SourceDrawerProps) => ReactNode;
    }
  >
> = {
  meta: {
    action: () => <MetaDashboardLink />,
    panel: (p) => (
      <MetaRevenuePanel
        dateFrom={p.dateFrom}
        dateTo={p.dateTo}
        currency={p.currency}
        metaDown={p.metaDown}
        detailHref={p.detailHref}
        shopifyTotal={p.shopifyTotal}
      />
    ),
  },
  google: {
    action: (p) => <GoogleAdsLabLink role={p.role} />,
    panel: (p) => (
      <GoogleAdsRevenuePanel
        role={p.role}
        dateFrom={p.dateFrom}
        dateTo={p.dateTo}
        currency={p.currency}
        shopifyTotal={p.shopifyTotal}
      />
    ),
  },
  klaviyo: {
    action: (p) => <KlaviyoLabLink role={p.role} />,
    panel: (p) => (
      <EmailRevenuePanel
        role={p.role}
        dateFrom={p.dateFrom}
        dateTo={p.dateTo}
        currency={p.currency}
        shopifyTotal={p.shopifyTotal}
      />
    ),
  },
};

export function SourceDrawer(props: SourceDrawerProps) {
  const source = SOURCES[props.bucket];
  return (
    <div className="flex flex-col gap-2 px-1 pb-2 pt-1">
      {source ? (
        <div className="flex justify-end empty:hidden">
          {source.action(props)}
        </div>
      ) : null}
      {source ? source.panel(props) : null}
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
