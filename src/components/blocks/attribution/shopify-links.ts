/**
 * Deep links out of the page. The Shopify admin *Total sales over time* report
 * is the official reference for the net-sales total, so the link carries the
 * same day range the page is showing.
 *
 * The path and report id come from Shopify's own Help Center links
 * (admin.shopify.com/analytics/reports/total_sales_over_time), paste-tested
 * against a live admin with the `since`/`until` window applied — the
 * `/store/<handle>` prefix keeps multi-store merchants in the right admin.
 */

const SALES_OVER_TIME_PATH = "/analytics/reports/total_sales_over_time";

/** `acme-store.myshopify.com` → `acme-store`. */
export function storeHandle(shopDomain: string | null | undefined): string | null {
  if (!shopDomain) return null;
  const host = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "");
  const handle = host.split("/")[0]?.split(".")[0];
  return handle && handle.length > 0 ? handle : null;
}

export function salesOverTimeUrl(params: {
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

  return `https://admin.shopify.com/store/${handle}${SALES_OVER_TIME_PATH}?${query.toString()}`;
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
