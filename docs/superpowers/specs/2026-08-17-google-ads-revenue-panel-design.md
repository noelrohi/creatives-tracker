# Google Ads Revenue Panel — Design

2026-08-17 · brainstormed and approved with owner. Phase 3 of the Google Ads
pilot (`2026-08-13-google-ads-aggregate-pilot-design.md`), building on the
completed pilot infrastructure on `feat/google-ads-pilot` (same branch, same
PR). Aggregate-only per the gclid probe decision: click IDs are unobservable
from stored Shopify data, so there is no order-level matching — this panel is
the second instance of the "external source vs our evidence" reading, after
the Klaviyo email revenue panel, adapted for a paid channel.

## Goal

Put the Google Ads comparison on the main attribution page so anyone reading
it can answer: of the Shopify revenue in this range, what does our google
bucket actually contain (free listings feed vs paid), what does Google Ads
claim (spend, conversions, conversion value), what return per ad dollar does
each side imply, and where might paid revenue be hiding. Ships now with our
side live; the Google side populates automatically when Basic access + real
credentials land (Phase 2).

## Decisions (made during brainstorming)

| Decision | Choice |
| --- | --- |
| Audience | Admin/owner only for v1 (same `isPrivilegedOrgRole` gate as the email panel); hidden for members. |
| Placement | Directly below the Email revenue panel on `/attribution`; obeys the page's date-range chips. |
| Our-side presentation | Split the google bucket into **free listings feed** (`lastClickUtmMedium` ∈ `GOOGLE_FEED_MEDIUMS`, i.e. `product_sync`) vs **paid** (everything else in the bucket). Data ground truth (2026-08, trailing 90d): the bucket is currently 100% feed (`sag_organic`/`product_sync`, 1,342 orders) with zero paid-UTM orders — the paid slice being $0 while Google reports conversions is itself the panel's key insight. |
| Headline reading | Both-ROAS: "Google claims" (their conversion value / spend) beside "we confirm" (our paid-slice revenue / spend). The divergence is the panel's thesis. |
| "Google says" windowing | Sliced exactly to the page date range (facts are daily — unlike Klaviyo's own-window reports). Only caveat: account-timezone vs store-timezone day boundaries, covered by one caption. |
| v1 content | Full four-piece panel: KPI row, share bar, by-campaign table, insight strip. |
| Architecture | One new read-only aggregate endpoint (`googleAds.revenuePanel`); no schema changes, no new pipeline stages. Mirrors the email panel's build exactly. |
| Campaign matching | Name-based and advisory: exact case-insensitive equality between Google campaign name and our paid `utmCampaign` values. No fuzzy matching. |

## Panel composition (top to bottom)

1. **Title row** — "Google Ads revenue · Google" + freshness caption (last
   facts sync age; "awaiting Google API access" before Phase 2), matching the
   page's caption style.
2. **KPI row** — google-bucket revenue with the feed/paid split beneath it ·
   Google-reported spend for the range · "Google says" conversion value with
   an "unconfirmed" delta vs our paid slice · two ROAS figures side by side:
   "Google claims" and "we confirm". ROAS cells render "—" when spend is
   zero or absent.
3. **Share bar** — full-width bar of Shopify net sales; google slice split
   into feed (light) and paid (dark) segments; legend with amounts. Same
   cents-ratio bar mechanics as the email panel.
4. **By-campaign table** — Google's campaigns (name, spend, conversions,
   conversion value) with a "we confirm" column: name-matched paid-UTM
   revenue, or "—" when unmatched. Our paid-UTM campaigns that match no
   Google campaign render as additional "ours only" rows. Feed traffic is
   excluded from the table (it belongs to no paid campaign) with a one-line
   footnote saying so.
5. **Insight strip** — one dashed line whose copy is chosen by data shape:
   - Paid slice $0 while Google reports conversions → "Google-attributed
     paid revenue is likely landing in other buckets — add UTM tracking
     templates to paid campaigns."
   - Paid > 0 → the plain delta reading (Google says X vs we confirm Y).
   - No Google data → "awaiting Google API access" (pre-Phase-2) or "no
     Google data for this range yet" (connection ready, empty range).

The panel obeys the page's date-range chips and skeleton conventions. Rows
are read-only. The panel never blocks the rest of the page; a query error
shows the email panel's error-state convention (retry; previously loaded
evidence unchanged).

## Data contract

New procedure `googleAds.revenuePanel` (`orgAdminProcedure`), input
`{ dateFrom, dateTo }` validated like `attribution.overview`. Backed by a new
server module `src/lib/google-ads/revenue-panel.ts`. Output:

```ts
{
  connection: { status, lastFactsSyncedAt, backfillCompletedAt } | null,
  ourSide: {
    bucketRevenueCents, bucketOrders,     // whole google bucket, gross − refunds
    feedRevenueCents, feedOrders,         // medium ∈ GOOGLE_FEED_MEDIUMS
    paidRevenueCents, paidOrders,         // bucket minus feed
    paidByCampaign: Array<{ utmCampaign: string | null, revenueCents, orders }>,
  },
  googleSays: {
    spendCents, conversions, conversionsValueCents,
    byCampaign: Array<{
      campaignId, campaignName,
      spendCents, conversions, conversionsValueCents,
      matchedUtmCampaign: string | null,
    }>,
  } | null,   // null when no facts exist for the range
}
```

### Definitions (load-bearing)

- **Split classification** reuses the bucket's own rules: an order in the
  google bucket is *feed* when `lastClickUtmMedium` matches
  `GOOGLE_FEED_MEDIUMS` (case-insensitively, exactly as
  `isGoogleFeedMedium` does), else *paid*. Feed + paid therefore sum
  exactly to the bucket row shown in the ledger above — the panel can never
  disagree with the page.
- **Revenue** is integer cents, gross − refunds, computed with the same
  semantics as `getBucketTotals` (refunds ranged by refund day and
  inheriting the order's bucket); the per-slice split applies the same
  refund treatment so slices sum to the bucket total by construction.
- **"Google says"** sums `google_ads_campaign_fact` rows over the inclusive
  page range: spend from `cost_micros` (→ cents), `conversions` (fractional),
  `conversions_value` (→ cents, account currency). Facts are account-timezone
  days; the page range is store-timezone days. One caption notes the
  boundary skew (for Reviv: Asia/Manila vs Asia/Bangkok, one hour).
- **Campaign matching**: `matchedUtmCampaign` is set when
  `lower(trim(campaignName)) === lower(trim(utmCampaign))`. Exact equality
  only; unmatched rows render unmatched. Matching is presentation-level
  advisory metadata — it is never persisted.
- **ROAS** figures are client-side divisions rendered by the panel, never
  persisted: Google claims = conversionsValueCents / spendCents; we confirm =
  paidRevenueCents / spendCents. Both "—" when spendCents is 0.
- **Currency**: Google figures are in the ad account's currency
  (`connection.currencyCode`), our figures in the store currency. For Reviv
  both are expected to match after Phase 2 discovery; if they differ the KPI
  row labels each figure with its own currency code and the ROAS cells
  render "—" with a "mixed currencies" caption instead of dividing across
  currencies.

## Files

- `src/lib/google-ads/revenue-panel.ts` — the aggregate computation (+ unit
  tests for matching/split logic; integration test via the existing
  `test-support/pg-harness.ts` asserting the split-sums-to-bucket invariant
  against seeded orders and refunds).
- `src/lib/trpc/routers/google-ads.ts` — add the `revenuePanel` procedure
  (+ router tests: day validation, unconfigured state, tenant scoping).
- `src/components/blocks/attribution/google-ads/revenue-panel.tsx`,
  `revenue-panel-table.tsx`, `copy.ts` — panel UI mirroring the
  email-revenue-* component structure (+ component test covering the
  privileged-role gate and the pending/awaiting states).
- `src/app/(protected)/attribution/page.tsx` — mount
  `<GoogleAdsRevenuePanel/>` directly below `<EmailRevenuePanel/>`.

No schema changes. No new Trigger.dev tasks. No changes to the lab page.

## Testing

- Unit: campaign-name matching (case/trim, no fuzzy), insight-strip copy
  selection by data shape, ROAS zero-spend and mixed-currency guards.
- Integration (pg harness): feed + paid revenue/orders sum exactly to the
  bucket totals for a seeded range including refunds; google-says range
  slicing sums only in-range fact days.
- Router: input validation, null-connection shape, scoping derived from the
  session organization.
- Component: member sees nothing; admin sees pending state without a
  connection; error state renders retry.

## Non-goals

- Order-level Google matching (closed by the probe: click IDs are
  unobservable in stored Shopify journeys; revisit only with new
  storefront/checkout capture).
- Fuzzy or persisted campaign matching; ad-group/keyword depth.
- Member visibility, CSV export, or write actions of any kind.
- Changes to bucket classification or any production attribution behavior.
