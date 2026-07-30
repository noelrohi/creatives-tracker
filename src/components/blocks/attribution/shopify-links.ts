/**
 * Deep links out of the page. The Shopify admin *Finances summary* report is
 * the official reference for the net-sales total — unlike the sales-over-time
 * reports it shows the Net sales line without any metric configuration — so
 * the link carries the same day range the page is showing.
 *
 * Path and `since`/`until` params verified against a live admin: selecting a
 * range in the report's own date picker produces exactly this URL. The
 * `/store/<handle>` prefix keeps multi-store merchants in the right admin.
 */

const FINANCE_SUMMARY_PATH = "/analytics/reports/finance_summary";

/** `acme-store.myshopify.com` → `acme-store`. */
export function storeHandle(shopDomain: string | null | undefined): string | null {
  if (!shopDomain) return null;
  const host = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "");
  const handle = host.split("/")[0]?.split(".")[0];
  return handle && handle.length > 0 ? handle : null;
}

export function financeSummaryUrl(params: {
  shopDomain: string | null | undefined;
  dateFrom: string;
  dateTo: string;
}): string | null {
  const handle = storeHandle(params.shopDomain);
  if (!handle) return null;

  const query = new URLSearchParams({
    since: params.dateFrom,
    until: params.dateTo,
  });

  return `https://admin.shopify.com/store/${handle}${FINANCE_SUMMARY_PATH}?${query.toString()}`;
}

/** Meta evidence lands on the existing MER page — no new route in v1. */
export function merRangeUrl(params: { dateFrom: string; dateTo: string }): string {
  const query = new URLSearchParams({
    from: params.dateFrom,
    to: params.dateTo,
  });
  return `/mer?${query.toString()}`;
}

/** Connector state lives on the dashboard's freshness panel. */
export function connectionsUrl(): string {
  return "/";
}
