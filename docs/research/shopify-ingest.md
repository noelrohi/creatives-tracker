# Research: Shopify order ingest — auth, backfill, attribution data

Resolves issue #89. Verified against shopify.dev docs as of 2026-07-29. Current stable Admin GraphQL API version: **2026-07** (endpoint `https://{store}.myshopify.com/admin/api/2026-07/graphql.json`). REST Admin API is legacy; everything below is GraphQL.

## 1. Auth: client id/secret → Admin API access for one store

`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` identify an app, not a store. Every path ends in a store-scoped Admin access token; the paths differ by who owns the store.

**Path A — client credentials grant (only if Reviv's store is in the same Shopify organization as our app).**
`POST https://{shop}.myshopify.com/admin/oauth/access_token` with `client_id`, `client_secret`, `grant_type=client_credentials`. No user interaction, no install UI. Tokens last 24h (`expires_in: 86399`) — request programmatically and refresh; scopes come from the app config (TOML / Dev Dashboard app version). Restriction (hard): "apps developed by your own organization and installed in stores that you own" — app and store must belong to the same Shopify organization in the Dev Dashboard. Since Reviv is a client's store, this almost certainly does **not** apply unless the store gets moved into (or the app created under) Reviv's own organization.
Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant

**Path B — custom distribution + OAuth authorization code grant (the expected path).**
1. In the app's dashboard, set distribution to **Custom** and target Reviv's `*.myshopify.com` domain; generate an install link.
2. Reviv's store owner clicks the link (one-time merchant action). Shopify redirects to our redirect URI with `code`, `shop`, `hmac` (verify HMAC).
3. Exchange at `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `client_id`, `client_secret`, `code` → an **offline access token that does not expire** (persists until uninstall/reinstall). Store it server-side; that's the long-lived credential the sync jobs use.
Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
(Token exchange is only for embedded apps running inside the admin with session tokens — not applicable to a headless ingest worker.)

**Path C — fallback: Reviv creates an admin custom app** (Settings → Apps → Develop apps) and hands us its Admin token directly. Fastest, zero OAuth code, and admin-created custom apps are exempt from Shopify's protected-customer-data review — but it abandons our client id/secret pair and puts credential lifecycle in the client's hands.

### Scopes and protected customer data

- `read_orders` — required for orders and `customerJourneySummary`. By default it only reaches **orders created in the last 60 days**.
- `read_all_orders` — required for the 90-day backfill. This scope is approval-gated: request it from the app dashboard ("API access requests" / access-requests section), describe why, wait for Shopify approval before it can be granted at install. Docs: https://shopify.dev/docs/api/usage/access-scopes and changelog https://shopify.dev/changelog/apps-now-need-shopify-approval-to-read-orders-older-than-60-days
- Protected customer data: orders are a protected resource. Distributed (public) apps need review for Level 2 (name/email/address/phone); **custom apps have Level 1 and Level 2 "always available"** (declare data use in the dashboard, no review). We only need attribution + money fields, so avoid selecting Level 2 fields at all — don't query `customer`, `email`, `shippingAddress`. Docs: https://shopify.dev/docs/apps/launch/protected-customer-data

**Action item that blocks us:** the `read_all_orders` access request (and the one-time install click in Path B) — start both early; approval latency is Shopify-controlled.

## 2. Backfill + hourly sync

Volume check: ~1.2k orders/month → 90-day backfill ≈ **3.6k orders**, hourly delta ≈ 2–10 changed orders. This is tiny; rate limits are a non-issue, so choose for correctness/simplicity.

**Backfill (90 days): one Bulk Operation.**
`bulkOperationRunQuery` with `orders(query: "created_at:>=2026-04-30")` selecting the fields in sections 3–4. Runs async on Shopify's side with **no query-cost or rate limits**; result is a JSONL file (one node per line, nested connections flattened with `__parentId` — good for `lineItems`, `refunds`, `moments`). Poll `bulkOperation(id:)` (2026-01+; `currentBulkOperation` is deprecated) or subscribe to the `bulk_operations/finish` webhook. Since 2026-01 a shop can run up to five concurrent bulk queries. Restrictions: max 5 connections, max 2 nesting levels.
Docs: https://shopify.dev/docs/api/usage/bulk-operations/queries

**Hourly incremental: paginated query on `updated_at`, not webhooks.**
```graphql
orders(first: 250, query: "updated_at:>='<last_cursor_ts>'", sortKey: UPDATED_AT) { ... }
```
`updated_at` (not `created_at`) is what catches refunds, order edits, and cancellations mutating old orders — the restatement mechanism in section 4 depends on it. Upsert by order id. At this volume that's 1 page/hour. A Trigger.dev hourly job mirrors the existing `meta-sync.ts` shape.
Webhooks (`orders/create`, `refunds/create`, `orders/edited`, `orders/cancelled`) are optional latency sugar; even Shopify recommends reconciliation polling since webhook delivery is at-least-once/at-most-lossy. Hourly polling alone is sufficient here; skip webhooks in v1.

**Rate limits (GraphQL cost-based leaky bucket):** Standard plan restores 100 points/s (Advanced 200, Plus 1000, Enterprise 2000); a single query may not exceed 1,000 points. A 250-order page with line items costs a few hundred points — we'll never throttle at 3.6k orders. Docs: https://shopify.dev/docs/api/usage/limits

## 3. Attribution data on orders

`Order.customerJourneySummary` (scope: `read_orders`) — docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/customerjourneysummary

```graphql
customerJourneySummary {
  ready                 # attribution processed yet?
  momentsCount { count }
  customerOrderIndex    # nth order for this customer (test orders excluded)
  daysToConversion      # first session → order, within attribution window
  firstVisit { ...visit }
  lastVisit  { ...visit }   # last session before the order — use this for last-click bucketing
  moments(first: 10) { edges { node { ... on CustomerVisit { ...visit } } } }
}
fragment visit on CustomerVisit {
  source            # "Facebook", "Google", "direct", a domain, "unknown"
  sourceType        # MarketingTactic enum (AD, EMAIL, SOCIAL_POST, SEARCH, DIRECT, ...)
  sourceDescription
  referrerUrl
  landingPage       # full landing URL incl. query string (fbclid/gclid live here)
  utmParameters { source medium campaign content term }
  referralCode
  occurredAt
}
```

**Caveats that matter for bucketing:**
- **Latency:** attribution is computed asynchronously. Shortly after an order, `customerJourneySummary` can be null or `ready: false` and `momentsCount` null. The hourly job must re-poll recent orders until `ready: true` before locking in a bucket (community reports exist of moments still shifting slightly after `ready` flips — treat attribution as eventually consistent for ~a day).
- **Coverage gaps:** only online-storefront sessions are tracked. POS, draft orders, subscription rebills, and headless checkouts that don't propagate tracking produce orders with **no visits** — bucket those as "untracked", don't let them default to "direct".
- **Attribution window:** sessions within a 30-day window (or since the previous order) count; `daysToConversion` is computed inside it.
- **Plan gating: none on the API field.** `customerJourneySummary` requires only `read_orders`; it is not gated by the merchant's Shopify plan (Shopify's built-in marketing *reports* vary by plan, but the GraphQL data does not).

## 4. Money fields: reproducing admin "net sales"

Shopify admin analytics **net sales = gross sales − discounts − returns, excluding shipping and tax**. The Order API has two families: plain fields are as-placed; `current*` fields are **after returns, refunds, order edits, and cancellations**. Docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/Order

Per order, fetch (all `MoneyBag`s — read `shopMoney.amount`):

```graphql
createdAt updatedAt cancelledAt cancelReason test taxesIncluded
displayFinancialStatus
subtotalPriceSet          # line items after discounts, before returns; excludes shipping
currentSubtotalPriceSet   # same, after returns/refunds/edits/cancellations
totalDiscountsSet currentTotalDiscountsSet
totalTaxSet currentTotalTaxSet
totalShippingPriceSet currentShippingPriceSet
totalPriceSet currentTotalPriceSet     # grand totals incl. shipping+tax
totalRefundedSet totalRefundedShippingSet
netPaymentSet             # cash view: received − refunded (incl. shipping+tax) — NOT net sales
refunds {
  id createdAt totalRefundedSet        # incl. tax+shipping — don't subtract this from net sales
  refundLineItems(first: 50) { nodes { quantity restockType
    subtotalSet   # post-discount, pre-tax product value — the "returns" number
    totalTaxSet } }
  refundShippingLines(first: 10) { nodes { subtotalAmountSet } }
  orderAdjustments(first: 10) { nodes { amountSet taxAmountSet reason } }
}
```

**The reproduction formula (current-state, per order):**
`net_revenue = currentSubtotalPriceSet.shopMoney` — already net of discounts and returns, excludes shipping; subtract `currentTotalTaxSet` **only when `taxesIncluded: true`** (tax-inclusive pricing stores), otherwise subtotal is already pre-tax. Exclude `test: true` orders.

**Day-level restatement (matching how admin analytics books things):**
- Sales are booked on `createdAt` day: `subtotalPriceSet` (minus included tax if applicable).
- Returns are booked on the **refund's** `createdAt` day: `−Σ refundLineItems.subtotalSet` (pre-tax, post-discount product value). `Refund.totalRefundedSet` includes tax + shipping, so it overstates the net-sales impact — use the line-item subtotals; `refundShippingLines` and `refundLineItem.totalTaxSet` carry the excluded components; `orderAdjustments` capture over/under-refund corrections.
- **Order edits** (add/remove items) change `currentSubtotalPriceSet` and bump `updatedAt` — the hourly `updated_at` sync picks the order up; recompute its stored value (simplest: restate the delta on the original order day; note Shopify's own reports may book edit deltas on the edit date, so expect small day-level drift vs admin if edits are common — totals still reconcile).
- **Cancellations:** `cancelledAt` non-null (`cancelReason` set); refund objects appear if money was returned and `current*` totals fall accordingly — no special-casing needed beyond the refund handling above, but filter/flag cancelled-unpaid orders (`displayFinancialStatus: VOIDED`) which never had revenue.
- A `Refund` row existing doesn't prove money moved — for cash reconciliation check the refund's `OrderTransaction` status; for net-sales purposes the refund line items are what Shopify's reports use.

**Practical rule:** store raw order + refund rows keyed by id, upsert on `updated_at`, and derive daily net revenue from the raw rows each time — restatement then falls out for free instead of being an event-sourcing problem.

## Sources

- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
- https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- https://shopify.dev/docs/apps/launch/protected-customer-data
- https://shopify.dev/docs/api/usage/access-scopes
- https://shopify.dev/changelog/apps-now-need-shopify-approval-to-read-orders-older-than-60-days
- https://shopify.dev/docs/api/usage/limits
- https://shopify.dev/docs/api/usage/bulk-operations/queries
- https://shopify.dev/docs/api/admin-graphql/latest/objects/customerjourneysummary
- https://shopify.dev/docs/api/admin-graphql/latest/objects/customervisit
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- https://shopify.dev/docs/api/admin-graphql/latest/objects/refund
