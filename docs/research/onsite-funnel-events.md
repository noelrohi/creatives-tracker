# On-site funnel events: Shopify web pixel vs GA4 vs Meta-modeled

**Ticket:** [#114](https://github.com/noelrohi/creatives-tracker/issues/114) · **Parent map:** [#113](https://github.com/noelrohi/creatives-tracker/issues/113) · **Date:** 2026-07-31

**Question.** Which source can give per-ad landing-page-visit and add-to-cart data for the Reviv Shopify store, and at what cost/fidelity?

---

## TL;DR

**Ship Meta-modeled actions as v1 — the data is already in the database.** `performance_log` already
has `landing_page_views`, `add_to_cart`, and `initiate_checkout` columns, the Meta mapper already
extracts those action types, and the daily Trigger.dev sync already writes them per ad per day. The
per-ad funnel view is a *query and a screen*, not an ingest project. Ingest effort for v1 is
effectively zero; the only code change worth making is a two-line fix so `cost_per_lpv` and
`cost_per_add_to_cart` get populated from the `cost_per_action_type` payload we already fetch.

**Build the Shopify web pixel as the real source, second.** It is the only option that yields
true first-party, per-visitor, per-ad on-site events — UTM parameters demonstrably survive into the
event payload at `event.context.document.location.search`, so `utm_content` → ad id joins cleanly.
It is strictly forward-only (no backfill, ever), which is the reason to start it early even though
v1 does not depend on it. It rides on the custom-distribution OAuth app that [#112](https://github.com/noelrohi/creatives-tracker/issues/112)
already decided to build.

**Reject GA4.** It buys nothing Meta doesn't already give us and adds two failure modes we cannot
control: high-cardinality `(other)`-row bucketing that silently collapses exactly the `utm_content`
granularity we need, and 2–14 month event-level retention. It is a third-party dependency with
first-party-quality expectations, and it would be the only source in the stack we cannot debug.

**Sequencing: Meta now → pixel next → GA4 never (unless a client already lives in it).**

---

## Why this question exists

The per-ad funnel view (impressions → clicks → LP visits → add-to-cart → checkout → purchase) is
fog on map [#113](https://github.com/noelrohi/creatives-tracker/issues/113) precisely because nobody
had checked what data we can actually get. Attribution v1 gives us *order-level* truth (a purchase,
attributed to an ad). The funnel middle — did people land, did they add to cart — is what turns
"this ad has bad ROAS" into "this ad has bad ROAS *because* the landing page loses them," which is
the mismatch diagnostic the map is chartered to deliver.

---

## What already exists in this repo

This turned out to be the decisive finding, so it goes first.

**`performance_log` already has the funnel columns** — [`src/schema/performance-log.ts`](../../src/schema/performance-log.ts):

```
landingPageViews    integer("landing_page_views")
costPerLpv          numeric("cost_per_lpv")
addToCart           integer("add_to_cart")
initiateCheckout    integer("initiate_checkout")
costPerAddToCart    numeric("cost_per_add_to_cart")
```

**The Meta mapper already extracts them** — [`src/lib/meta-api-mapper.ts:63-67`](../../src/lib/meta-api-mapper.ts):

```ts
const landingPageViews = findAction(row.actions, "landing_page_view");
const addToCart = findAction(row.actions, "omni_add_to_cart") ??
  findAction(row.actions, "add_to_cart");
const initiateCheckout = findAction(row.actions, "omni_initiated_checkout") ??
  findAction(row.actions, "initiate_checkout");
```

**The sync already requests the right fields at the right grain** — [`src/lib/meta-insights-sync.ts`](../../src/lib/meta-insights-sync.ts):
`INSIGHT_FIELDS` includes `actions`, `action_values`, and `cost_per_action_type`; the insights
request uses `level: "ad"` and `time_increment: "1"`, i.e. one row per ad per day, via Meta's async
report API. [`trigger/meta-sync.ts`](../../trigger/meta-sync.ts) runs it on cron `0 18 * * *`
(2am PHT daily).

**Joins are already wired.** `performance_log.ad_id → ads.id`, plus a denormalized
`performance_log.meta_ad_id`; `ads.meta_id` is unique. The `ads.meta_id → ad_creative` chain
(persona / angle / awarenessLevel / hook) is the same chain the five-tag work depends on, so funnel
metrics slice by tag for free once the tags are populated.

### Two gaps found

1. **`cost_per_lpv` and `cost_per_add_to_cart` are never populated by the API path.** Grepping for
   writers shows them set only from the CSV import path ([`src/lib/csv-parser.ts`](../../src/lib/csv-parser.ts),
   [`src/lib/import-utils.ts`](../../src/lib/import-utils.ts)). `meta-api-mapper.ts` returns `cpa`
   but never `costPerLpv` / `costPerAddToCart`, even though `cost_per_action_type` is already in the
   fetched fields. This is a genuine two-line fix, not a project.

2. **No attribution window is pinned.** Neither `action_attribution_windows` nor
   `use_unified_attribution_setting` appears anywhere in `src/` or `trigger/`. Meta therefore returns
   actions under the **ad account's default attribution setting**, which is currently 7-day click /
   1-day view. That is a silent dependency: if someone changes the setting in Ads Manager, our
   historical numbers shift meaning without any code change and without any record of it. See
   [Caveats](#caveats-that-make-meta-a-proxy-not-ground-truth).

**Backfill reach.** `SUGGESTED_WINDOW_MAX_DAYS = 30` in
[`src/lib/trpc/routers/meta-sync.ts:82`](../../src/lib/trpc/routers/meta-sync.ts) caps the
*suggested* window, and the sync resumes incrementally from `dataDateEnd - 1 day`. But the tRPC
mutation accepts explicit `dateFrom`/`dateTo`, so a deliberate deeper backfill is available without
code changes — bounded only by Meta's own retention (below).

---

## Option A — Meta-reported per-ad actions

### Per-ad joinability
**Native and exact.** These come back on the ad row itself keyed by `ad_id`. There is no UTM
round-trip, no cookie, no consent gate, no identity resolution. This is the single strongest
property of this option and the reason it wins v1: joinability is not a *risk* here, it is a
guarantee.

### Granularity
Per ad, per day (`level=ad`, `time_increment=1`). Breakdowns by age / gender / country /
device_platform are already synced as separate rows. Action types confirmed valid in Meta's
[Ads Action Stats reference](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/):
`landing_page_view`, `add_to_cart` (`offsite_conversion.fb_pixel_add_to_cart`),
`initiate_checkout`, and the grouped `omni_add_to_cart` / `omni_initiated_checkout` / `omni_purchase`
variants the mapper already prefers.

### Latency
Daily at 2am PHT. Meta's own conversion data continues to settle for ~72h after the fact, and the
sync's 1-day overlap on resume partially compensates, but a longer restatement window would be more
correct — noted as an open question.

### Retention / backfill
**37 months for aggregate metrics** — which is the class `actions` falls into. Meta tightened the
Insights API in January 2026: unique-count fields (`unique_actions`, `cost_per_unique_action_type`)
and hourly breakdowns are capped at 13 months, frequency breakdowns at 6 months, but aggregate
metrics stayed at 37. The restrictions apply to *all API versions simultaneously*, with no legacy
exemption ([ppc.land summary](https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/)).
So a deep historical funnel backfill for Reviv is available today. **This is the only one of the
three options that can tell us anything about the past.**

### Consent / privacy
Nothing for us to implement — Meta handles the collection side. The cost is paid in fidelity, not
in engineering (see caveats).

### Ingest effort
**Effectively zero.** Columns exist, mapper exists, sync exists, join exists. What remains is
query + UI, plus the two-line `cost_per_*` fix.

### Caveats that make Meta a proxy, not ground truth

These are real and should be surfaced in the UI, not buried:

- **`landing_page_view` requires the Meta Pixel on the site and depends on the pixel firing before
  the visitor bounces.** Meta defines it as a click followed by a successfully loaded page. It is
  systematically *lower* than link clicks, and the gap is partly bounce and partly measurement loss.
  Treat LPV/clicks as a signal-quality ratio, not a truth.
- **AEM caps and suppresses mid-funnel events.** Under [Aggregated Event Measurement](https://www.facebook.com/business/help/721422165168355),
  for iOS users who opted out of tracking, only the **highest-priority event per conversion window
  is reported**. On a Shopify store with Purchase prioritized (the normal, correct configuration),
  `add_to_cart` and `initiate_checkout` are structurally under-reported for that cohort. Meta says
  as much: these events "may still be happening, but they might not reflect in reporting."
  **This is the most important caveat in this document** — the add-to-cart number is not merely
  noisy, it is biased downward by an amount that varies with iOS share and opt-out rate.
- **Claim-side attribution.** Counts are attributed on Meta's default 7d-click/1d-view window, which
  overlaps with other channels' claims. Funnel counts are not additive with our own order-level
  attribution and must never be presented as if they were.
- **View-through windows shrank.** Meta discontinued `7d_view` and `28d_view` on 2026-01-12; those
  now return empty. Not currently requested by our code, but it constrains future window choices.

**Verdict: adopt for v1.** Directionally right, per-ad exact, historically available, zero ingest
cost. Good enough to answer "which ad loses people between click and cart" — which is the question
the diagnostics need. Not good enough to state absolute conversion rates.

---

## Option B — Shopify Web Pixels API

### Per-ad joinability
**Achievable, and confirmed.** The event payload exposes the full page URL:
`event.context.document.location.href` ("the entire URL") and `.search` ("a `?` followed by the
parameters"), alongside `.pathname`, `.hostname`, `.referrer`, and `event.clientId` (Shopify's
visitor id) — see the [`page_viewed` payload reference](https://shopify.dev/docs/api/web-pixels-api/standard-events/page_viewed).
So `utm_content`, `utm_campaign`, and `fbclid` all survive to the pixel and we parse them ourselves.
There is no UTM helper. `URLSearchParams` is **not** in the guaranteed globals list, so parse
defensively.

This depends on the ad-side UTM discipline the map already flags as missing (no `utm_content`
extraction on orders yet). The pixel does not fix tagging hygiene — it *consumes* it. Joinability is
therefore only as good as the UTM template on the ads, which is a genuine operational risk that
Meta-native action types simply do not have.

`event.clientId` plus `browser.cookie.set` gives a first-party visitor id that can stitch a session
across pageview → add-to-cart → checkout, which is what makes true per-ad funnel *rates* possible
rather than per-ad funnel *counts*.

### Granularity
Per event, per visitor, in real time — by far the finest of the three. Standard events
([reference](https://shopify.dev/docs/api/web-pixels-api/standard-events)): `page_viewed`,
`product_viewed`, `product_added_to_cart`, `product_removed_from_cart`, `cart_viewed`,
`collection_viewed`, `search_submitted`, `checkout_started`, `checkout_contact_info_submitted`,
`checkout_address_info_submitted`, `checkout_shipping_info_submitted`, `payment_info_submitted`,
`checkout_completed`, `alert_displayed`, `ui_extension_errored`. DOM events (`clicked`,
`form_submitted`, `input_*`) are available on Storefront/Checkout/Thank-you only.

Subscribe via `analytics.subscribe('all_events', cb)` or per event name.

> **Documented gap:** Shopify's docs state **no plan requirement** for any standard event, including
> the checkout ones — and the Web Pixels API is explicitly the replacement for Plus-only
> `checkout.liquid`, so "works on all plans" is strongly implied. But it is *not stated outright*.
> Verify on Reviv's actual plan before committing.

One real behavioural wrinkle: `checkout_completed` fires on the Thank-you page **or** on the first
post-purchase upsell page when one exists (and then not again on Thank-you). If that page fails to
load, the event never fires at all.

### Latency
Real-time, fire-and-forget. No documented latency SLA, no documented payload-size or event-volume
limit. Events sent on unload are lossy — use `fetch(..., { keepalive: true })` on
`checkout_completed` or expect to lose a few percent.

### Retention / backfill
**Forward-only. No replay, no backfill, no historical query.** This is categorical and is the
single strongest argument for starting it early: every day we don't ship it is a day of on-site
data that does not exist and never will.

Two partial historical consolations, neither a substitute:

- **`CustomerJourneySummary` on the Order object** gives *retroactive per-order* attribution:
  `firstVisit` / `lastVisit` / `moments` → `CustomerVisit.utmParameters` (source, medium, campaign,
  content, term) plus `landingPage`, `referrerUrl`, `occurredAt`. Scope `read_orders`, 30-day
  attribution window, and it exposes a `ready` boolean that must be checked. This is genuinely
  valuable for *attribution* backfill — the map already notes full journey jsonb is retained per
  order — but it only covers visitors **who ordered**, so it can never produce a funnel denominator.
- **`abandonedCheckouts`** is a poor add-to-cart proxy: no UTM, undocumented retention.
- **`shopifyqlQuery`** is aggregate-only, needs `read_reports` plus Level 2 protected-customer-data
  approval. (Commonly assumed Plus-only; that is *not* documented either way.)

### Consent / privacy
The most operationally dangerous part, and the easiest to get subtly wrong.

App pixels declare purposes in a `[customer_privacy]` block (analytics / marketing / preferences /
sale_of_data) and Shopify **auto-gates loading: the pixel does not load at all unless the visitor
granted every declared purpose** ([pixel privacy docs](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy)).
Over-declaring purposes silently costs coverage with no error anywhere. Declare the minimum.
Read `init.customerPrivacy` and subscribe to `visitorConsentCollected`. In consent regions,
callbacks run only after consent, with previously-registered events replayed.

### Ingest effort
Meaningfully more than Meta, but bounded, and mostly *new surface* rather than new complexity.

**Sandbox.** App pixels run as a **Web Worker in a `strict` sandbox**. Guaranteed globals are only:
`self`, `console`, `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`, and `fetch` +
`Headers`/`Request`/`Response`. The docs are blunt: "You must not rely on any other globals being
available." No DOM, no `window`, no `document`, no `window.top`, no `navigator.sendBeacon`.

Storage *is* available and is **async (Promise-based, proxied to the top frame)**:
`browser.cookie.get/set`, `browser.localStorage`, `browser.sessionStorage`
([browser API](https://shopify.dev/docs/api/web-pixels-api/standard-api/browser)).
`browser.cookie.set` is the first-party cookie mechanism.

**Where events go.** `fetch()` to an app-hosted HTTPS endpoint is allowed, with two conditions:

1. Our endpoint must send CORS headers.
2. **Fetch to the shop's own origin is blocked with `RestrictedUrlError`, so Shopify App Proxy
   (`/apps/...`) endpoints do NOT work.** We must POST to our own domain
   ([Shopify staff confirmation](https://community.shopify.dev/t/web-pixel-can-t-fetch-to-app-proxy-same-origin-how-do-you-handle-env-urls-dev-staging-prod/31727)).
   No Shopify-side domain allowlist is required. Handle dev/staging/prod by putting `endpoint_url`
   in the extension's `settings` block and passing it per-shop at `webPixelCreate` time.

**Installation.** Scopes `write_pixels` + `read_customer_events`; a `shopify.extension.toml` with
`type = "web_pixel_extension"`, `runtime_context = "strict"`, a `settings` object and a
`[customer_privacy]` block; `shopify app deploy`; then the app calls
[`webPixelCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webPixelCreate)
after install (settings JSON is validated against the TOML schema; mismatch returns
`INVALID_SETTINGS`).

**Custom-distribution fit is good — better than expected.** Extension-only apps in fact *require*
custom distribution ([app extensions docs](https://shopify.dev/docs/apps/build/app-extensions)),
which is exactly the model [#112](https://github.com/noelrohi/creatives-tracker/issues/112) already
chose. The pixel is not a detour from that decision; it is a passenger on it. It is **not** purely
API-driven, though: it needs a Partners app plus a CLI deploy to host the bundle, which is new
release machinery this repo does not have today.

**New backend surface:** a public ingest endpoint (CORS, bot filtering, rate limiting, idempotency
on `event.id`), an events table, and a rollup into per-ad/per-day counts. That last step is what
makes pixel data comparable to `performance_log` — and it is where the real work is.

**The admin-UI alternative.** Shopify's "Custom pixels" (Settings → Customer events) need no app at
all: `lax` sandbox (iframe with `sandbox="allow-scripts allow-forms"`), *can* fetch/sendBeacon to an
external endpoint, cannot access DOM or top frame, and cannot use app `settings` (endpoint URL is
hardcoded per store). Manual per-store paste, unversioned, and Shopify states plainly that
"Adding and using custom pixels is unsupported by Shopify"
([custom pixels docs](https://help.shopify.com/en/manual/promoting-marketing/pixels/custom-pixels)).
**Useful as a one-store spike to de-risk the payload shape before building the extension; not a
product path.**

**Verdict: the correct long-term source; build it second, and start it sooner than v1 needs it,
because forward-only data cannot be recovered.**

---

## Option C — GA4

### Per-ad joinability
Technically possible, practically fragile. The dimension is **`sessionManualAdContent`**, described
in the [Data API schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
as "The ad content attributed to the key event. Populated by the `utm_content` parameter." Companion
dimensions: `sessionCampaignName`, `sessionManualTerm`, `sessionSource`, `sessionMedium`,
`landingPage`, `landingPagePlusQueryString`. **There is no native Meta ad-id dimension** — per-ad
joinability exists only insofar as we put the ad id in `utm_content`, exactly as with the pixel.

**And then GA4 may throw it away.** Two independent mechanisms attack precisely the high-cardinality
dimension we depend on:

- **Cardinality / the `(other)` row — and it explicitly hits the API, not just the UI.** Google:
  "The (other) row is a row that appears in a report, exploration, **or Data API response** when the
  number of rows in a table exceeds the table's row limit"
  ([(other) row](https://support.google.com/analytics/answer/13331684?hl=en)). Google's own bar is
  that "any dimension with more than **500 values** should be considered a high-cardinality
  dimension," framed as 500 unique values *per day* in
  [reporting data expectations](https://developers.google.com/analytics/devguides/reporting/data/v1/reporting-data-expectations).
  A per-ad `utm_content` scheme on a few hundred live ads crosses this routinely. Google publishes
  **no concrete row-limit number** for standard vs 360 — the 50k/2M figures circulating online are
  third-party and should not be relied on. Detectable via `ResponseMetaData.dataLossFromOtherRow`,
  but detection only tells you that you lost data, not how much.
- **Data thresholding — worse than sampling, because it withholds whole rows.** Sampling estimates
  from a subset; thresholding *deletes rows entirely*. It applies "when viewing a report or
  exploration **or making an API call**" involving demographic data or audiences derived from it,
  and "data thresholds are system defined. You can't adjust them"
  ([data thresholds](https://support.google.com/analytics/answer/9383630?hl=en)). It is tied to the
  property's reporting identity: Blended and Observed require enough signed-in activity "which means
  your reports are subject to data thresholds" ([reporting identity](https://support.google.com/analytics/answer/10976610)).
  Detectable via `ResponseMetaData.subjectToThresholding` — but that flag only says the report *is
  subject to* thresholding; **you cannot tell how many rows were dropped**. Per-ad totals can
  silently under-sum against the campaign total, and the long-tail ads — exactly the ones a client
  most wants a verdict on — are the likeliest to vanish. Properties get 120 "potentially thresholded"
  requests per hour, and notably that cap is **120 for standard *and* 360** — it does not scale with
  the paid tier, so it caps any per-ad backfill loop
  ([quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)).
- **Sampling** (the least scary of the three): triggers above 10M events per query for standard
  properties, up to 1B for 360 ([sampling](https://support.google.com/analytics/answer/13331292?hl=en)).
  Most Shopify stores never hit it. Detect via `samplingMetadatas`.

One further gotcha: "If you use manual tagging and auto tagging together, then the source, medium,
and other traffic-classification dimensions use the auto-tagged values"
([traffic-source dimensions](https://support.google.com/analytics/answer/11242870)) — Google Ads
`gclid` overrides manual UTMs. Only relevant if a store runs Google Ads alongside Meta.

### Granularity
Session-scoped, not ad-event-scoped. Metrics available: `sessions`, `screenPageViews`, `addToCarts`,
`checkouts`, `ecommercePurchases`, `itemsAddedToCart`, `purchaseRevenue`, `transactions`. Note
`addToCarts` counts **events** while `itemsAddedToCart` counts **units** (item-scoped, sums
quantity) — a funnel rate wants `addToCarts / sessions`.

> **Documented gap — and the weakest-verified claim in this whole comparison.** Shopify's
> [GA4 setup page](https://help.shopify.com/en/manual/reports-and-analytics/google-analytics/google-analytics-setup)
> confirms the Google & YouTube channel is required and says "certain ecommerce events are tracked
> automatically" — but **does not enumerate them**, and Shopify never first-party commits to sending
> `add_to_cart`. Third-party sources consistently claim the native channel sends the full set
> (`page_view`, `view_item`, `add_to_cart`, `begin_checkout`, `add_payment_info`, `purchase`); this
> could not be confirmed from either Shopify or Google. Compounding it, `add_to_cart` is the most
> commonly broken Shopify event in practice — themes with multiple add-to-cart surfaces (quick-add,
> drawer cart, PDP) often fire on only one selector. **The entire GA4 option rests on an
> unconfirmed premise.**

### Latency
Worse than Meta. The Realtime API is **useless for this** — its dimension list has no campaign,
source, medium, ad-content or landing-page dimension at all (only appVersion, audience, city,
country, deviceCategory, eventName, minutesAgo, platform, stream, unifiedScreenName, and user-scoped
customs). Standard processing:
intraday 2–6 hours, daily 12–24h+, and Google explicitly warns "data processing can take 24–48 hours.
During that time, data in your reports may change," with the caveat that this is
"not a guarantee, nor an SLA or an SLO" ([data freshness](https://support.google.com/analytics/answer/11198161?hl=en)).

### Retention / backfill
**The hard stop.** Event-level retention for standard properties is **2 or 14 months only**, and the
**default is 2** — which merchants routinely never change (360 goes to 26/38/50)
([data retention](https://support.google.com/analytics/answer/7667196?hl=en)). Retention does not
affect standard *aggregated* reports, but it *does* affect explorations and funnel reports.

> **Documented gap:** no Google page states whether Data API `runReport` counts as an "aggregated
> report" for retention purposes. The inference — that session-scoped traffic-source dimensions plus
> standard ecommerce metrics live in pre-aggregated tables and therefore survive past 2 months — is
> *inference only*. Getting it wrong is expensive in both directions: assume 14 months and the
> backfill silently returns empty rows; assume 2 and you discard usable history.

And more fundamentally: **GA4 cannot be backfilled at all.** No import mechanism exists; there is no
data before tag install, ever.

**The sharper point, which is what actually kills it:** even where GA4 *was* installed, `utm_content`
only carries an ad identifier for periods when the ads were tagged that way — and most Meta
advertisers do not do this by default. Historical `utm_content` is typically blank, a campaign-level
string, or a hand-written label. **Realistic per-ad backfill is therefore usually zero regardless of
retention**, and only starts accruing once the client changes their Meta URL tagging, forward-only.
That is the same forward-only property the pixel has — but without the pixel's first-party fidelity,
and worse than Meta's 37 months of queryable history.

### Consent / privacy
Consent Mode v2 (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`) creates
real gaps ([consent doc](https://developers.google.com/tag-platform/security/guides/consent)).
[Behavioral modeling](https://support.google.com/analytics/answer/11161109?hl=en) patches them, but
requires ≥1,000 events/day with `analytics_storage='denied'` for 7 days *and* ≥1,000 daily granted
users for 7 of the previous 28 — thresholds many stores never meet. Whether modeling reaches Data
API responses is **not documented either way** (the exclusions listed are UI surfaces plus BigQuery;
the Data API is named neither way).

**The EU consequence bites regardless of that ambiguity:** modeling explicitly does not model event
counts in funnel/path contexts, so `addToCarts` for EU traffic is undercounted with no correction
while `sessions` may be modeled *upward*. That deflates the per-ad ATC rate for EU-heavy stores **in
a way that looks exactly like a real creative-performance signal** — a diagnostics product built on
that would confidently give wrong advice.

Layering *Google's* modeling on top of Meta's modeling and calling the result ground truth is worse
than either alone, because the error stops being characterizable.

### Quotas
Not a blocker, for the record. Standard properties: 200,000 tokens/property/day, 40,000/hour,
14,000/project/property/hour, 10 concurrent requests, 10 server errors/hour (360 is 10× on each)
([quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)).
A daily per-ad pull is nowhere near these limits.

### Ingest effort
Moderate and entirely new: GCP project, enable the Analytics Data API, service account, grant it
Viewer on the GA4 property (scope `analytics.readonly`), add `@google-analytics/data` (no Google
deps in `package.json` today), new Trigger.dev task, new table. The *engineering* is genuinely small
— a day or two per client with pagination and quota accounting.

**The real cost is per-merchant onboarding friction, and it is unavoidable:** GA4 must already be
collecting; the merchant must grant service-account access (a manual admin step they often lack
rights for); they must supply the numeric property ID; and they must change their Meta URL tagging
to put an ad identifier in `utm_content` — forward-only. For anything self-serve the service-account
route is close to a non-starter; an OAuth flow is more engineering but far less support burden.

Note also a design tension with no good resolution: every extra dimension multiplies row count toward
the `(other)` limit, pushing you to request the narrowest dimension set — but splitting into separate
requests burns the 14,000 tokens/project/property/hour quota, which is shared across our whole GCP
project *per property* and is precisely what bites a multi-tenant app.

Comparable to the pixel's effort — for strictly worse data.

**Verdict: reject.** GA4 is the only option here that is simultaneously *not* first-party, *not*
per-ad-native, *not* backfillable, *and* subject to silent server-side data destruction we cannot
detect or appeal. The one scenario that would revive it: a future client who already has a
well-tagged, long-retention GA4 property and won't install our app.

---

## Comparison

| | **Meta actions** | **Shopify web pixel** | **GA4** |
|---|---|---|---|
| Per-ad joinability | Native (`ad_id`) — exact | Via `utm_content` — good, needs UTM discipline | Via `utm_content` — degraded by `(other)` |
| Granularity | Ad × day | Event × visitor, real time | Session × day |
| Latency | Daily (2am PHT) | Real time | 24–48h to settle |
| Backfill | **37 months, available now** | **None — forward-only** | None; 2–14mo retention |
| Consent exposure | Handled by Meta | We own it; over-declaring silently kills coverage | Consent Mode v2 gaps + Google modeling |
| Fidelity | Modeled/claim-side; AEM suppresses mid-funnel | Ground truth (consented traffic) | Modeled + thresholded + bucketed |
| Ingest effort | **~zero (already built)** | Extension + CLI deploy + ingest endpoint + rollup | GCP + service account + new sync |
| Verdict | **v1** | **v2 — start early** | **Reject** |

---

## Recommendation

**v1: Meta-modeled actions.** Build the per-ad funnel view directly on `performance_log`. No ingest
work, no new dependency, no new failure mode, and — uniquely — real history to show on day one.
Required work is small:

1. Populate `cost_per_lpv` / `cost_per_add_to_cart` in `meta-api-mapper.ts` from the
   `cost_per_action_type` payload already being fetched (two lines).
2. Pin the attribution window explicitly (`use_unified_attribution_setting` or an explicit
   `action_attribution_windows`) and **persist the window used on the row**, so historical numbers
   keep their meaning when someone changes the Ads Manager setting.
3. Label the funnel UI as *Meta-reported*, distinct from our order-level attributed revenue. These
   two numbers will disagree and users must know why before they notice.

**v2: Shopify web pixel**, on the custom-distribution OAuth app from #112. Its forward-only nature
is the argument for starting it *before* v1 needs it — a pixel shipped in month 1 and queried in
month 3 has three months of history; one shipped in month 3 has none.

**Rejected: GA4**, unless inherited from a client.

**Guiding principle for the funnel view's design:** Meta's numbers are *claim-side and downward-biased
mid-funnel*. The screen should therefore be built to compare ads **against each other**, not against
absolute truth. Ratios (LPV/click, ATC/LPV) are robust to a bias that applies roughly evenly across
ads in the same account; absolute conversion rates are not. Designing v1 around ratios also means
swapping in pixel data later *refines* the numbers rather than contradicting them — which is exactly
the migration property we want.

---

## Open questions / documented gaps

Flagged rather than resolved:

- **Not verified:** whether standard events fire on Reviv's specific (non-Plus?) plan. Docs state no
  plan requirement, but never say "all plans" outright. Check before committing to the pixel.
- **Not verified:** whether GA4 is currently installed and correctly UTM-tagged on the Reviv store.
  Moot given the rejection, but it would decide any inherited-property case.
- **Not confirmed by Shopify or Google:** whether Shopify's native Google & YouTube channel actually
  emits `add_to_cart` to GA4. Third-party sources say yes; no first-party source enumerates the
  events. This is the cheapest unknown to close and it invalidates the GA4 option outright if false.
- **Not documented by Google:** whether Data API `runReport` is exempt from the 2-month default
  event-level retention. One test against a real 2-month property settles it.
- **Not documented by Google:** whether consent-mode behavioral modeling is applied to Data API
  responses.
- **Not documented by Shopify:** web-pixel latency SLA, payload-size limits, event-volume limits.
- **Not documented by Shopify:** whether `shopifyqlQuery` is Plus-only (commonly assumed; unconfirmed
  either way).
- **Not documented by Google:** the concrete `(other)`-row limit for standard vs 360 properties.
- **Unresolved:** the right restatement window for the Meta sync. Meta's conversion data settles for
  ~72h; the current 1-day overlap on resume may under-correct.
- **Unverified verbatim:** the `addToCarts` metric description (the schema page truncated before the
  metrics section). The dimension quote for `sessionManualAdContent` *is* verbatim.

---

## Sources

**Meta**
- [Ads Action Stats reference](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/) — action types, attribution-window fields
- [Insights API](https://developers.facebook.com/docs/marketing-api/insights/)
- [Aggregated Event Measurement](https://www.facebook.com/business/help/721422165168355) and [key concepts](https://www.facebook.com/business/help/387440828988900) — 8-event cap, highest-priority-only reporting
- [Website landing page views](https://www.facebook.com/business/help/361750134220832)
- [Meta restricts attribution windows and data retention in Ads Insights API](https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/) — Jan 2026 changes (secondary source; primary changelog not retrievable)

**Shopify**
- [Web Pixels API](https://shopify.dev/docs/api/web-pixels-api) · [standard events](https://shopify.dev/docs/api/web-pixels-api/standard-events) · [`page_viewed` payload](https://shopify.dev/docs/api/web-pixels-api/standard-events/page_viewed) · [`checkout_completed`](https://shopify.dev/docs/api/web-pixels-api/standard-events/checkout_completed) · [DOM events](https://shopify.dev/docs/api/web-pixels-api/dom-events)
- [About web pixels (sandbox model)](https://shopify.dev/docs/apps/build/marketing-analytics/pixels) · [Build web pixels](https://shopify.dev/docs/apps/build/marketing-analytics/build-web-pixels)
- [browser API](https://shopify.dev/docs/api/web-pixels-api/standard-api/browser) · [pixel privacy](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy)
- [`webPixelCreate` mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webPixelCreate) · [App extensions](https://shopify.dev/docs/apps/build/app-extensions) · [App distribution](https://shopify.dev/docs/apps/launch/distribution)
- [`CustomerJourneySummary`](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary) · [`CustomerVisit`](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerVisit)
- [Custom pixels (admin UI)](https://help.shopify.com/en/manual/promoting-marketing/pixels/custom-pixels) · [App pixels](https://help.shopify.com/en/manual/promoting-marketing/pixels/app-pixels)
- [App Proxy / same-origin fetch is blocked (`RestrictedUrlError`)](https://community.shopify.dev/t/web-pixel-can-t-fetch-to-app-proxy-same-origin-how-do-you-handle-env-urls-dev-staging-prod/31727)
- [Setting up Google Analytics 4 on Shopify](https://help.shopify.com/en/manual/reports-and-analytics/google-analytics/google-analytics-setup)

**GA4**
- [Data API schema (dimensions & metrics)](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
- [Data API quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)
- [About the (other) row](https://support.google.com/analytics/answer/13331684?hl=en) · [Cardinality](https://support.google.com/analytics/answer/12226705?hl=en) · [Reporting data expectations](https://developers.google.com/analytics/devguides/reporting/data/v1/reporting-data-expectations)
- [About data thresholds](https://support.google.com/analytics/answer/9383630?hl=en) · [Reporting identity](https://support.google.com/analytics/answer/10976610) · [Sampling](https://support.google.com/analytics/answer/13331292?hl=en)
- [Data retention](https://support.google.com/analytics/answer/7667196?hl=en) · [Data freshness](https://support.google.com/analytics/answer/11198161?hl=en)
- [Traffic-source dimensions, manual tagging, and auto-tagging](https://support.google.com/analytics/answer/11242870)
- [Consent mode](https://developers.google.com/tag-platform/security/guides/consent) · [Behavioral modeling](https://support.google.com/analytics/answer/11161109?hl=en)
- [Node quickstart / client libraries](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries) · [Changelog](https://developers.google.com/analytics/devguides/reporting/data/v1/changelog)

**Repo**
- [`src/schema/performance-log.ts`](../../src/schema/performance-log.ts) · [`src/lib/meta-api-mapper.ts`](../../src/lib/meta-api-mapper.ts) · [`src/lib/meta-insights-sync.ts`](../../src/lib/meta-insights-sync.ts) · [`trigger/meta-sync.ts`](../../trigger/meta-sync.ts) · [`src/lib/trpc/routers/meta-sync.ts`](../../src/lib/trpc/routers/meta-sync.ts)
- Related: [#112 Shopify connection model](https://github.com/noelrohi/creatives-tracker/issues/112) (custom-distribution OAuth decision)
