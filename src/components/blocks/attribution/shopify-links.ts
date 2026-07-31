/**
 * Deep links out of the page. The Shopify admin *Finances summary* report is
 * the official reference for the net-sales total — unlike the sales-over-time
 * reports it shows the Net sales line without any metric configuration — so
 * the link carries the same day range the page is showing.
 *
 * Path and `since`/`until` params verified against a live admin: selecting a
 * range in the report's own date picker produces exactly this URL. The
 * `/store/<handle>` prefix keeps multi-store merchants in the right admin.
 *
 * The report's sales-channel filter is deliberately absent, because it cannot
 * be carried: switching to "All channels" in the admin produces this exact URL
 * with no extra parameter — the filter is remembered per user, not encoded. A
 * merchant who last viewed one channel therefore lands on a smaller Net sales
 * figure than ours, which counts every channel, so the copy beside the link
 * says which basis to compare on.
 */

const FINANCE_SUMMARY_PATH = "/analytics/reports/finance_summary";

/** `acme-store.myshopify.com` → `acme-store`. */
export function storeHandle(shopDomain: string | null | undefined): string | null {
  if (!shopDomain) return null;
  const host = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "");
  const handle = host.split("/")[0]?.split(".")[0];
  return handle && handle.length > 0 ? handle : null;
}

export function orderAdminUrl(params: {
  shopDomain: string | null | undefined;
  shopifyOrderId: string;
}): string | null {
  const handle = storeHandle(params.shopDomain);
  if (!handle) return null;
  const orderId =
    params.shopifyOrderId.split("/").pop() ?? params.shopifyOrderId;
  return `https://admin.shopify.com/store/${handle}/orders/${orderId}`;
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
  return "/#connections";
}
