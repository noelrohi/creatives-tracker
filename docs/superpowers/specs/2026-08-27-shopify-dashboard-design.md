# Shopify Summary on the Root Dashboard

**Date:** 2026-08-27
**Status:** Approved
**Branch:** `feat/shopify-dashboard` (based on `main`)

## Summary

The root dashboard (`/`, the attribution view) gains a Shopify-style summary
block at the top: four KPI cards (Total Sales, Orders, Average Order, Refunds)
and a Total Sales chart, above the existing ledger card. The sidebar entry is
renamed "Shopify Dashboard". Timezone alignment between data sources becomes
visible and guarded — no stored data changes.

## Goals

- Shopify-feel reading of the store at the top of `/`: cards + sales curve.
- Rename the Dashboard nav entry (and breadcrumb) to "Shopify Dashboard".
- Surface each screen's governing timezone and warn when the store and Meta
  ad-account timezones diverge — the one case where daily figures misalign.

## Non-goals

- No discount data (not synced; Refunds stands in — adding `totalDiscounts`
  to the ingest is a possible follow-up, out of scope here).
- No changes to how days are stamped or bucketed anywhere (no migrations).
- The existing header rail on `/` stays as-is, accepting a Net-sales overlap
  with the new Total Sales card (slimming the rail is a possible follow-up).
- No dedicated "shopify" router/module — additions fold into `attribution`.

## 1. Data (tRPC, `attribution` router)

| Procedure | Kind | Returns |
| --- | --- | --- |
| `refundsTotal` | new, `orgProcedure`, input `dateRangeSchema` | `{ total: string, count: number }` — Σ `shopify_refund.amount` and row count for rows with `refund_day` in range (all kinds, matching how the ledger nets refunds). |
| `hourlySeries` | new, `orgProcedure`, input `{ day: string }` | `{ hours: Array<{ hour: number, net: string, orders: number }> }` — that store-day's orders bucketed by hour of `created_at` evaluated in the store's IANA timezone (SQL `AT TIME ZONE`), 24 rows, zero-filled. |
| `overview`, `dailySeries` | existing | unchanged — cards and the multi-day chart read from them. |

Both new procedures resolve the store via the existing `requireStore` helper
and follow the router's existing money-string conventions.

## 2. UI — `ShopifySummary` block

New `src/components/blocks/attribution/shopify-summary.tsx`, rendered on `/`
between the page banners and the ledger `<section>`. Receives the page's
existing state as props (`range`, `currency`, plus the already-fetched
`overview` data for sales/orders); owns its own `refundsTotal`,
`hourlySeries`, and `dailySeries` queries (React Query dedupes `dailySeries`
if the page ever also reads it).

- **Cards** (Shopify-style, 4-up grid, stacking on mobile):
  - *Total Sales* — `overview.total`, formatted with `formatMoneyExact`.
  - *Orders* — bucket order counts + pending count (same arithmetic the page
    header uses today).
  - *Average Order* — sales ÷ orders; renders the "no data yet" chip when the
    range has zero orders (never `$NaN`/`$0.00`).
  - *Refunds* — `refundsTotal.total`, warning-toned; count in the caption.
- **Total Sales chart** below the cards, in a bordered card matching the
  ledger chrome:
  - Range of 2+ days → area chart of `dailySeries.totalNet` per day.
  - Range of exactly 1 day → area chart of `hourlySeries` (24 points, store
    clock, hour labels).
  - Loading → skeleton; error → the panel error/retry idiom used by
    `MetaRevenuePanel`; every state keeps the cards visible (chart failure
    never blanks the block).
- Copy lives in the attribution `copy.ts` following the plain-voice contract.

## 3. Naming

- Sidebar collapsible label + tooltip: "Dashboard" → **"Shopify Dashboard"**.
- `page.navLabel` in attribution copy: "Dashboard" → "Shopify Dashboard"
  (breadcrumb follows). Children (Meta / Klaviyo / Google) unchanged.

## 4. Timezone visibility + guard

- Stored data untouched: order days stay stamped in the store timezone; Meta
  daily rows stay in the ad-account timezone (all Asia/Bangkok in prod today).
- The `/` kicker already prints the store timezone; the Meta page prints the
  account timezone. New: `TimezoneAlignment` (small client component on `/`,
  under the freshness caption) compares `store.ianaTimezone` with the
  `timezone` of every enabled ad account from `adAccount.list`:
  - All aligned, or no synced account timezones → renders nothing.
  - Any mismatch → one warning line naming the account and both zones:
    "<account> counts days in <meta tz> — Shopify days are <store tz>, so
    daily figures won't line up at the edges." Visible to all roles
    (read-only information; `adAccount.list` is org-wide readable).

## 5. Testing

- Integration-style unit tests for the two new procedures' SQL (refund sum in
  range; hourly bucketing across a timezone boundary — an order at 23:30
  store-time lands in hour 23, one at 00:10 the next day is excluded).
- Component tests (`*.component.test.tsx`, mocked tRPC): `ShopifySummary`
  cards + chart for single-day vs multi-day ranges, zero-orders AOV chip,
  chart error keeps cards; `TimezoneAlignment` aligned (renders nothing) vs
  diverged (names the account).
- `bun run lint`, `bun run test`, `bun run test:components`, `bun run build`
  all green. No migrations, so no migration-guard concerns.

## Decisions log

- KPI set: Sales / Orders / AOV / Refunds (discounts not synced).
- 1-day ranges chart hourly via a new query; multi-day uses `dailySeries`.
- Timezone item resolved as visibility + divergence guard; no re-stamping,
  no display-clock switch.
- Additions fold into the attribution module (no new router/dir).
