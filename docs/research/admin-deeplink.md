# Research: Shopify admin Sales-over-time deep link

## TL;DR

The link is broken because **both the path and the report name are wrong**. Analytics reports live under
`/analytics/reports/<report_id>`, and the report is called `total_sales_over_time`, not `sales_over_time`.
Shopify's own Help Center hyperlinks prove the route. Recommended template:

```
https://admin.shopify.com/store/<handle>/analytics/reports/total_sales_over_time?since=YYYY-MM-DD&until=YYYY-MM-DD
```

`/store/<handle>` is correct. `since`/`until` are still **unproven** for the `/analytics/` route — the path fix is the
load-bearing change; the date params are a best-effort add-on that degrade to the report's default range.

---

## Findings

### 1. The current route is `/analytics/reports/<report_id>` — documented by Shopify

Shopify's Help Center pages don't just *describe* reports, they **hyperlink** to them. Every such link on the
Sales reports page uses the `/analytics/reports/` prefix:

- "Total sales over time" → `https://admin.shopify.com/analytics/reports/total_sales_over_time`
- "Total sales by product" → `https://admin.shopify.com/analytics/reports/total_sales_by_product`
- "Net sales by channel" → `https://admin.shopify.com/analytics/reports/net_sales_by_sales_channel`
- "Average order value over time" → `https://admin.shopify.com/analytics/reports/average_order_value_over_time`

Source: <https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/sales-report>

The same shape is confirmed independently on two other Help Center pages, so it's the systematic route and not a
one-off:

- Behavior reports: `.../analytics/reports/conversion_rate_over_time`, `.../analytics/reports/sessions_by_device`,
  `.../analytics/reports/searches_by_search_query`
  (<https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/behaviour-reports>)
- Marketing reports: `.../analytics/reports/sales_attributed_to_marketing`,
  `.../analytics/reports/sessions_attributed_to_marketing`
  (<https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/marketing-reports>)

**Status: documented by Shopify** (as live hyperlinks in official docs, not as prose about URL structure — Shopify
publishes no page that documents admin URL construction).

### 2. The report identifier is `total_sales_over_time`, not `sales_over_time`

The report's display name in the current admin is "**Total sales over time**", and its identifier carries the
`total_` prefix (finding 1). `shopify-links.ts` uses the bare `sales_over_time`, which is the **legacy** identifier.

This matters more than the path: even if `/reports/*` still redirects into the new analytics section, an unknown
report id lands nowhere useful. That's the most likely single cause of the reported breakage.

Corroborating: a merchant posted the exact legacy URL
`https://admin.shopify.com/store/store-name/reports/sales_over_time?since=-1m&until=-1m&over=day` on the Shopify
developer forums (27 May 2025), complaining it no longer behaved as before. Shopify staff (KyleG-Shopify) replied to
check whether the report still exists and that "if it's a legacy report, you may need to migrate it to the new
analytics."
Source: <https://community.shopify.dev/t/shopify-sales-report-issue/16186>

**Status: `total_sales_over_time` documented by Shopify; the legacy-id diagnosis is community-reported + staff-confirmed.**

### 3. `since` / `until` / `over` are real param names — but only proven on the *legacy* path

The forum URL above is the only concrete evidence of query params on a Shopify admin report URL, and it shows:

- `since` and `until` — with **relative tokens** (`-1m`), not ISO dates, in that example
- `over=day` — the grouping unit

That URL is legacy-path. I found **no** source, official or community, showing a query string on an
`/analytics/reports/<id>` URL. Shopify's own Help Center links to these reports with **no query string at all**.

Circumstantial support that the new analytics *does* encode the window in the URL: a widely-quoted complaint about
Shopify analytics states that "any query on the analytics page can be bookmarked or shared via the URL and you'll get
back to the same view", but "the URL contains a static date range", so a bookmark taken while viewing "last 30 days"
on Dec 2 still shows Nov 3 – Dec 2 in January. If accurate, the URL carries **absolute** dates for a bookmarked view —
which is exactly the `YYYY-MM-DD` shape the app already emits. I could not trace this quote to a primary Shopify
source, so treat it as community-reported only.

Shopify's official date-range docs cover **only the UI date picker and ShopifyQL keywords** (`SINCE`, `UNTIL`,
`DURING`, `COMPARE TO`), and explicitly contain no URL or parameter documentation:
<https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/custom-reports/time-ranges>
and <https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/shopifyql-editor/shopifyql-syntax>

There is no evidence of a `ql=` URL parameter. ShopifyQL is entered in the in-admin editor ("Analytics → New
exploration") or sent through the GraphQL Admin API — not passed via URL.
Source: <https://shopify.dev/docs/apps/build/shopifyql/shopify-admin>

**Status: `since`/`until`/`over` observed on the legacy path only. Unverified on `/analytics/reports/`.**

### 4. `admin.shopify.com/store/<handle>/…` is the correct store-scoped form

The current admin supports the unified login at `https://admin.shopify.com`, the store-scoped
`https://admin.shopify.com/store/<store-handle>/…`, and the legacy `<shop>.myshopify.com/admin`, which **redirects**
to the new admin. The handle is the myshopify subdomain — for `cheetos.myshopify.com` the identifier is `cheetos`.

Sources: <https://shopthemedetector.com/blog/how-to-login-to-the-shopify-admin/> (community),
<https://community.shopify.com/t/about-rest-admin-api-authentication-s-shop-parameter/234191> (community; documents the
subdomain-as-identifier convention for the `shop` param).

Note the asymmetry: Shopify's Help Center links omit `/store/<handle>` entirely, relying on the session's currently
selected store. For a multi-tenant app that's not safe — a merchant with several stores would land in the wrong one.
Keep `/store/<handle>`. The two forms are the same router, so `/store/<handle>/analytics/reports/<id>` is the expected
composition, though I could not verify it unauthenticated (see Open questions).

**Status: `/store/<handle>` form is well-established (community-documented, universally used); the composition with
`/analytics/reports/` is inferred, not directly cited.**

### 5. Unauthenticated probing gave no signal

`curl` against `admin.shopify.com` returns **HTTP 403** for every path — valid routes, invalid routes, and a
deliberately bogus report id alike. Shopify's bot protection answers before routing, so route existence cannot be
distinguished this way. Empirical confirmation requires a logged-in paste-test.

### 6. Aside: net sales is a metric, not its own over-time report

The app treats this report as the reference for **net sales**, but the documented report is "Total sales over time".
There is no `net_sales_over_time` report id in Shopify's docs; the only net-sales report in the sales list is
`net_sales_by_sales_channel`. Net sales is available as a metric *inside* the sales dataset — a merchant adds it via
the report's Metrics menu, or queries `FROM sales SHOW net_sales …` in an exploration.
Source: <https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/sales-report>

So `total_sales_over_time` is the right screen to land on (it's where net sales is reachable), but it won't *default*
to showing net sales. Worth a wording check wherever the UI calls this the net-sales reference.

---

## Recommended change to `shopify-links.ts`

Change the path constant and keep the date params as a graceful-degradation extra. Drop the comment's claim that
`since`/`until` are "the param names the admin analytics reports have used" — that was only ever true of the legacy
path.

```ts
/**
 * Deep links out of the page. The Shopify admin *Total sales over time* report is
 * the official reference for the net-sales total, so the link carries the same day
 * range the page is showing.
 *
 * The path and report id come from Shopify's own Help Center links, e.g.
 * https://admin.shopify.com/analytics/reports/total_sales_over_time — we add
 * /store/<handle> so multi-store merchants land in the right admin.
 *
 * `since` / `until` are undocumented and unverified on this route. If the admin
 * ignores them the report still opens on the right screen, on its own default range.
 */

const TOTAL_SALES_OVER_TIME_PATH = "/analytics/reports/total_sales_over_time";

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

  return `https://admin.shopify.com/store/${handle}${TOTAL_SALES_OVER_TIME_PATH}?${query.toString()}`;
}
```

Two smaller robustness notes on the existing code, unrelated to the broken path:

- `storeHandle()` splits on the first `.` of whatever it's given. If `shopDomain` ever holds a **custom** domain
  (`shop.acme.com`), it silently yields `shop` and produces a dead link. Consider requiring the host to end in
  `.myshopify.com` and returning `null` otherwise, so a bad input hides the link instead of linking somewhere wrong.
- The `over` param (`over=day`) from the legacy example is worth omitting: it's unverified on the new route and the
  page's own grouping choice isn't something we know.

### Paste-test ladder for the user

Run these in order in a logged-in browser; the first that opens the right report with the right dates wins.

1. `https://admin.shopify.com/store/<handle>/analytics/reports/total_sales_over_time?since=2026-07-01&until=2026-07-29`
2. `https://admin.shopify.com/store/<handle>/analytics/reports/total_sales_over_time` — isolates whether the params
   are the problem or the path is
3. `https://admin.shopify.com/analytics/reports/total_sales_over_time` — Shopify's exact documented link; if this
   works but (2) doesn't, the `/store/<handle>` composition is wrong for this route
4. `https://admin.shopify.com/store/<handle>/analytics/reports/total_sales_over_time?startDate=2026-07-01&endDate=2026-07-29`
   — fallback param naming to try if (2) works and (1) lands on a default range

If none of 1–3 work, the fallback is the reports index, `https://admin.shopify.com/store/<handle>/analytics/reports`,
or the Analytics overview, `https://admin.shopify.com/store/<handle>/analytics` (the latter form is what Shopify's
Analytics help page links to as `https://admin.shopify.com/analytics`).

---

## Open questions

Only a logged-in paste-test can settle these:

1. **Does `/analytics/reports/total_sales_over_time` accept a date window via URL at all?** No source shows a query
   string on this route. If step 2 of the ladder works but step 1 lands on the default range, the answer is no.
2. **If it does, are the param names `since`/`until` (carried over from the legacy path) or something else?** Worth
   checking the live URL bar after picking a custom range in the date picker — that's the definitive answer and takes
   one click.
3. **Whether the dates must be ISO (`2026-07-01`) or relative tokens (`-30d`).** The one real-world example used
   relative tokens; the bookmarking complaint implies absolute dates. Both may be accepted.
4. **Whether `/store/<handle>/analytics/reports/<id>` is a valid composition**, or whether the analytics section is
   only reachable store-lessly. Inferred, never seen written down.
5. **Does the legacy `/reports/sales_over_time` still redirect?** If it 404s, that confirms the diagnosis; if it
   redirects to a working report, the current bug may be narrower than the path (e.g. only the params).
6. **Whether the store handle always equals the myshopify subdomain** for this app's connected stores. True as a
   convention, but if the app has the admin URL from OAuth, deriving from that is safer than string-splitting the
   shop domain.
