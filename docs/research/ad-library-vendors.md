# Third-party Meta Ad Library providers

Research for [#147](https://github.com/noelrohi/creatives-tracker/issues/147) (part of wayfinder map [#146](https://github.com/noelrohi/creatives-tracker/issues/146)).

**Question:** which third-party provider can reliably return up to ~100 **active** ads for a given Facebook page, **US commercial (non-political)**, and what does each actually deliver?

**Researched:** 2026-08-13. All facts come from vendor docs/pricing/terms pages, cited inline. Prices and actor stats move — re-check before committing spend. Anything unconfirmed is called out in §8 rather than guessed at.

---

## 0. Why we need a vendor at all

Meta's official `ads_archive` Graph API cannot serve this use case. From Meta's own reference:

> "Ads that did not reach any location in the EU will only return if they are about social issues, elections or politics."

— <https://developers.facebook.com/docs/graph-api/reference/ads_archive/>

The official API gives us EU-targeted commercial ads plus political/issue ads worldwide. A US DTC brand's product ads are neither. `ad_reached_countries` is required, and setting it to `US` for a non-political category returns nothing useful.

Every option below is therefore an **unofficial** source reading the public Ad Library web/GraphQL surface. This is a ToS-posture question, not a compliance-clean one.

### Two things that are true of every vendor

1. **Media URLs are expiring Meta CDN links.** Every vendor passes through Meta's signed `scontent.*` URLs; the signature lapses. **We must download and re-host assets at ingest, never persist the URL.** (<https://mackgrenfell.medium.com/fixing-the-facebook-ad-library-part-2-recreating-the-ad-library-de10b7829ac0>) No vendor documents the expiry window.
2. **Data lags Meta's own indexing by ~24–48h.** Only SocialAPIs.io states this plainly (<https://socialapis.io/api-sources/meta-ads-search>), but it is a property of the Ad Library, not of any vendor. Nobody has fresher data than Meta publishes.

---

## 1. Comparison table

Credible contenders only. Ruled-out vendors are in §5.

| | **ScrapeCreators** | **SearchAPI.io** | **Social Fetch** | **Adyntel** | **SocialAPIs.io** | **Metapi.io** | **Apify `apify/facebook-ads-scraper`** |
|---|---|---|---|---|---|---|---|
| What it is | Scraping-API vendor, solo founder | Established multi-engine SERP/data API co. | Specialist API, **Social Freak Ltd (UK)** | Specialist ad-library API | Specialist social API | Dedicated Ad Library API, small team | First-party actor by Apify |
| Delivery | **Sync REST** | **Sync REST** (~2.5s) | **Sync REST** | **Sync POST** | **Sync REST** | ❌ **Async task + poll** | ❌ Async actor run (sync wrapper caps at 300s) |
| Billing unit | **Per request** | **Per search** | **Per request** | **Per request (credit)** | **Per call** | **Per record (ad)** | **Per ad** |
| Page ID input | ✅ `pageId` or `companyName` | ✅ `page_id` or `q` | ✅ `pageId` or `companyName` | ❌ domain or page URL | ✅ `ad_page_id` | ✅ `advertiser_id` | ❌ page URL |
| Active-only | ✅ `status=ACTIVE` (**default**) | ✅ `active_status=active` | ✅ `status=active` | ✅ **active is the default** | ✅ `activeStatus` | ✅ `active_status` | ✅ `activeStatus` |
| US filter | ✅ `country=US` | ✅ `country` + `location_id` | ✅ `country=US` | ✅ `country_code` | ✅ country ISO | ✅ `country` | ✅ via URL/field |
| Pagination | `cursor` (POST when large) | `next_page_token` (POST >8KB) | `nextCursor`/`hasMore` | `continuation_token` | `end_cursor` (stable, persistable) | `offset`/`limit`, up to 50k/task | `resultsLimit` |
| Page size | not documented | ~25/page | not documented | ~30/call | not published | up to 500 | n/a |
| Unit price | $0.99–$1.88 /1k | $1.00–$4.00 /1k | $1.64–$14.00 /1k | ~$8.80 /1k credits | $1.00–$3.00 /1k | per-record tiers | $3.40–$5.80 /1k **ads** |
| Monthly floor | **None** (packs, never expire) | **$40** (Developer) | **None** (packs, never expire) | **$44** | **$4.99** (free 200/mo) | **$29** (free 3K rec/mo) | Apify plan $0–$999 |
| Free trial | 100 credits | 100 requests | 100 credits | 50 credits | 200 calls/mo | 3K records/mo | $5/mo credit |
| Rate limits | none enforced; ~500 concurrent | 20% of plan credits/hour | none on metered routes | not published | **documented per plan** (1–20 req/s) | **documented per plan** | Apify concurrency |
| SLA | ❌ self-reported 98.2% | ✅ **99.9% all plans** | ❌ | ❌ claims 99.99% | ❌ | claims 99.9% (ToS hedges) | ❌ 99.9% run success |

---

## 2. ScrapeCreators

Docs: <https://docs.scrapecreators.com/v1/facebook/adLibrary/company/ads> · <https://docs.scrapecreators.com/introduction> · Pricing: <https://scrapecreators.com/>

**Input.** `GET /v1/facebook/adLibrary/company/ads`, header `x-api-key`, with `pageId` (e.g. `367152833370567`) or `companyName`. Optional `country` (default `ALL`), `status` (**default `ACTIVE`**), `media_type`, `language`, `sort_by`, `start_date`/`end_date`, `cursor`, `trim`.

Page URLs are not accepted directly. The companion `GET /v1/facebook/adLibrary/search/companies?query=<name>` (1 credit) returns `page_id`, `name`, `page_alias` (the URL slug), `category`, `likes`, `ig_username`, `verification`, `page_is_deleted`. So: resolve `page_id` once at competitor-add time, cache it, poll by ID thereafter.

**Output.** Mirrors Meta's own snapshot object nearly verbatim — low interpretation risk, and we can persist raw JSON and derive fields later:

- `ad_archive_id`, `page_id`, `page_name`, `collation_id`, `collation_count`
- `is_active`, `start_date`, `end_date` (Unix), `publisher_platform`
- `snapshot.body.text`, `snapshot.title` (headline — **null in the docs' own example**), `snapshot.link_description`, `snapshot.caption`, `snapshot.byline`
- `snapshot.display_format`, `snapshot.cards[]` (carousel), `snapshot.images[]`, `snapshot.videos[]` (`video_hd_url`, `video_sd_url`, `video_preview_image_url`, watermarked variants)
- `snapshot.link_url` (destination), `snapshot.cta_text`/`cta_type`
- page context (`page_categories`, `page_like_count`, `page_profile_uri`, …); top level `searchResultsCount`, `cursor`

Use `trim=false` to keep the full snapshot.

**Pagination.** Cursor-based; switch to the POST variant when the cursor grows (<https://docs.scrapecreators.com/v1/facebook/adLibrary/company/ads/post>). Page size for `company/ads` is **not documented** — the sibling search endpoint's example shows 50. Assume 30–50 pending measurement.

**Pricing.** Pay-as-you-go packs, no subscription: Free 100 credits · **Freelance $47 / 25,000 ($1.88/1k)** · Business $497 / 500,000 ($0.99/1k) · Enterprise custom. Credits never expire. **Cached results cost zero credits.** **1 credit per request** — the unit is the *request*, not the ad.

**Limits & reliability.** No enforced rate limits (stay under ~500 concurrent); `402` on exhaustion. Self-reported 98.2% success / 3.12s avg over trailing 30 days — **no SLA, no status page**. Support is the founder directly. No published incident history. **Bus factor of one.**

**ToS posture.** Small but real commercial vendor; states it extracts only public data and is unaffiliated with Meta.

---

## 3. SearchAPI.io

Docs: <https://www.searchapi.io/docs/meta-ad-library-api> · Pricing: <https://www.searchapi.io/pricing> · Terms: <https://www.searchapi.io/legal/terms>

An established multi-engine data API (30+ engines) exposing Meta Ad Library as several engines: `meta_ad_library` (search), `meta_ad_library_page_search` (name → `page_id`), `meta_ad_library_page_info`, `meta_ad_library_ad_details`.

**Input.** `page_id` **or** keyword `q`, plus `country` (default ALL), `location_id`, `ad_type` (default `all` = commercial), `active_status=active`, `media_type`, `platforms`, `start_date`/`end_date`, `sort_by`.

**Output.** `ad_archive_id`, `page_id`, `is_active`, `start_date`/`end_date`, `publisher_platform[]`, `snapshot.body.text`, `snapshot.title`, `snapshot.display_format` (CAROUSEL/DPA/DCO), `snapshot.cards[]` with `original_image_url`/`resized_image_url`, `link_url`, `cta_text`/`cta_type`, `page_name`. Complete for our needs, and the same Meta-native shape as ScrapeCreators.

**Pagination.** `next_page_token`, ~25 ads/page → ~4 calls per competitor. Docs warn tokens grow to 8KB+; use POST past 413/414 — the same failure mode ScrapeCreators documents, which strongly suggests both read the same upstream Meta GraphQL surface.

**Pricing.** Developer $40/mo (10,000 searches, $4/1k) · Production $100/mo (35K, $3/1k) · BigData $250/mo (100K, $2.50/1k) · Scale $500/mo (250K) · up to Octo 5M $5,000/mo ($1/1k). Free trial 100 requests, no card. **Only successful 200 responses are billed.**

**Limits & reliability.** "Up to 20% of your plan's credits each hour" (≈2,000/hr on Developer — far above our needs). **99.9% uptime SLA on all plans** — the only contractual availability commitment found anywhere in this comparison.

**ToS posture — the strongest here, but read the fine print.** Their terms carry a **Legal Protection Guarantee** covering "third-party claims under U.S. law and jurisdiction that arise solely from SearchApi's own collection and parsing of publicly available search results," capped at **USD $2,000,000 aggregate per 12-month period**. Two caveats materially shrink its value to us, both verified against the terms page:

- ⚠️ **It does not apply to the $40 Developer plan.** It covers "active, paid subscriptions starting from the **Production plan** and above. It does not apply to free trials, Developer plans, or any period after your subscription ends." **Buying the guarantee means $100/mo, not $40.**
- ⚠️ **It excludes "any claim arising from your use, storage, redistribution, or commercialization of data"** — which describes our product almost exactly. It indemnifies *their* act of scraping, not our act of storing competitor ads and showing them to paying clients.

Also note: "You are prohibited from… reselling, redistributing or offering our Services to a third-party without prior written consent." Surfacing this data inside a client-facing feature is arguably fine (we're not reselling API access) but it is worth an email to confirm before launch — **and the same question applies to every vendor here**, none of whom we should assume are indifferent to it.

---

## 4. Other credible vendors

### Adyntel — best ergonomics, thinnest disclosure

<https://docs.adyntel.com/ad-libraries/meta> · <https://www.adyntel.com/>

`POST api.adyntel.com/facebook` with `company_domain` or `facebook_url` — **no numeric page ID input**, which is the one real drawback. **`active_status` defaults to active-only**, `country_code` covers 190+ markets. `continuation_token` pagination at ~30 ads/call, 1 credit per page, `null` token on the last page. Optional `webhook_url` + `all_ads:true` for bulk. Output: `ad_archive_id`, `page_id`/`page_name`, `is_active`, `start_date`/`end_date`, `snapshot` (body, images, videos, CTA), `publisher_platform[]`, plus format and destination URLs per their marketing page.

Pricing: **$44/mo → 5,000 credits** ($0.0088 each), $179/25K, $321/50K. Free 50 credits. Credits roll over up to 2× the limit; empty lookups (204) aren't charged. Claims 99.99% uptime but publishes **no rate limits and no contractual SLA**.

**Verdict:** genuinely good ergonomics (sync POST, active-by-default, `all_ads` flag) at ~40 credits per refresh = 125 refreshes/mo on the entry plan. Held back by domain/URL-only input and thin operational disclosure.

### Social Fetch — same shape and price as ScrapeCreators

<https://www.socialfetch.dev/platforms/facebook/ad-library-companies-ads> · <https://www.socialfetch.dev/pricing>

Purpose-built `GET /v1/facebook/ad-library/companies/ads` taking **`pageId`** or `companyName`, with `status=active`, `country=US`, `mediaType`, `language`, `sortBy`, date range. Cursor pagination via `data.page.nextCursor`/`hasMore`, 1 credit per page. Response envelope includes `meta.creditsCharged` and `data.lookupStatus`. A separate single-ad lookup supports `includeTranscript=true` for video speech-to-text. Docs are generated from a public OpenAPI spec — a good stability signal. Operated by **Social Freak Ltd (UK)**, a registered company, which is marginally better disclosure than ScrapeCreators offers.

Pricing: Free 100 credits · Starter $14/1,000 · **Growth $47/25,000 ($1.88/1k)** · Scale $379/230,000 ($1.64/1k). PAYG credits never expire. "You are never charged for our mistakes." No enforced request quotas on metered routes; ~500 concurrent recommended. No SLA.

⚠️ **Observation worth acting on:** Social Fetch's pricing is *identical* to ScrapeCreators' — 100 free credits, $47 for 25,000, $1.88/1k, credits never expire — with near-identical endpoint shapes (`/v1/facebook/ad-library/companies/ads` vs `/v1/facebook/adLibrary/company/ads`, both with a companion company-search route, both 1 credit/request, both `x-api-key`, both recommending ~500 concurrent). The registered operators differ (Social Freak Ltd vs ScrapeCreators' solo founder) and **we have no evidence either way about a shared backend** — but the coincidence is strong enough that *these two should not be treated as independent redundancy*. If the goal is a genuine failover, pair either one with SearchAPI or Adyntel, not with each other.

⚠️ Body-copy and headline field names are summarized but not enumerated on their public pages — verify against the OpenAPI spec with a free key.

### SocialAPIs.io — cheapest with documented rate limits

<https://socialapis.io/api-sources/meta-ads-search> · <https://socialapis.io/pricing>

`ad_page_id` or keyword `query`; `activeStatus` (ALL/Active/Inactive), country ISO, `after_time`/`before_time`. `end_cursor` + `has_next`, and notably **"cursors are stable across calls — safe to persist"**. Free 200 calls/mo · Pro $4.99/1,500 · Ultra $49/30,000 · Mega $179/120,000. Failed 4xx don't consume credits. **Rate limits documented per plan** (Free 1,000/hr; Pro 1 req/s; Ultra 5/s; Mega 10/s). Honestly discloses the 24–48h Meta indexing lag.

⚠️ **Headline, landing/destination URL, and media URLs are not enumerated** in their public docs — the gating question before this could be used.

### Metapi.io — richest fields, wrong delivery and billing shape

<https://metapi.io/api-docs> · <https://metapi.io/>

**Correction to an earlier read of this vendor:** their marketing homepage reads like a synchronous API, but the actual API reference documents an **asynchronous task model** — `POST /v1/tasks` returns 202 + `task_id`, poll `GET /v1/tasks/:uuid/status`, then `GET /v1/tasks/:uuid/results`. Webhooks (`run.completed`/`failed`/`progress`, HMAC-SHA256 signed) are available. A nice touch: `POST /v1/tasks/from_url` takes a pasted Ad Library URL and extracts the filters itself.

Input `advertiser_id` (page ID) or `q` + `country`; `active_status`, `ad_type`, `media_type`, `publisher_platforms[]`, date ranges. One task can return all 100 ads (`count` up to 50,000; results paged by `offset`/`limit`, default 100).

**Richest field set of any vendor here:** `provider_id`, `provider_page_id`/`_name`, `bodies[]` (copy variants), `captions[]`, `cta_text`, `original_image_url`, `video_hd_url`/`video_sd_url`, `link_url`, `snapshot_url`, `creation_time`, `delivery_start_time`/`delivery_stop_time`, `creative_link_titles`, `creative_link_descriptions`, `page_categories`, `page_like_count`; optional `eu_data:true` for EU reach/demographics. ⚠️ No explicit `is_active` boolean documented — you filter on input instead.

Pricing is **per record**: Free 3K records/mo · Lite $29/25K · Pro $79/100K · Business $149/500K · Scale $299/2M. Rate limits documented per plan. ToS explicitly disclaims Meta affiliation and frames the data as publicly available; team not publicly identifiable. (Their `/pricing` path 404s; figures are from the homepage.)

**Verdict:** best data model, worst fit. Per-record billing means 1,000 records per refresh — Lite buys only 25 refreshes/mo — and the async task/poll cycle is the thing we're trying to avoid. Keep as a backup; its free tier covers ~3 refreshes/mo.

---

## 5. Apify

Platform pricing (<https://apify.com/pricing>): Free ($0, $5/mo credit), Starter $29, Scale $199, Business $999. Actor charges draw down platform credits.

### `apify/facebook-ads-scraper` — first-party

<https://apify.com/apify/facebook-ads-scraper> · <https://apify.com/apify/facebook-ads-scraper/api>

`startUrls` takes a Facebook page URL, Ad Library brand URL, or Ad Library search URL — **no ID-resolution step needed**. Plus `resultsLimit`, `activeStatus`, `sorting`, `onlyAdsNewerThan`/`onlyAdsOlderThan`, `onlyTotal`, `isDetailsPerAd`, `includeAboutPage`, `enrichWithEcommerceData`. Output covers ad text, formats, CTA and destination links, platform distribution, dates, active status, and spend/reach estimates where available.

**The blocking caveat:** it's an *actor run*, not an API call — POST a run, poll the dataset. `run-sync-get-dataset-items` hard-caps at **300 seconds** with a 408 past that, and Apify's docs push you to the async endpoint beyond that (<https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post>).

Pricing is per-result (1 result = 1 ad): $5.80/1k (Free), $5.00 (Starter), $4.20 (Scale), $3.40 (Business); e-commerce enrichment bills separately from $5.70/1k.

Reliability: 31,654 users, 4.19★, 99.9% run success, public Issues tab, **1.4-day issue response**. Apify maintaining its own actor is the strongest maintenance signal in this document — they have a commercial reason to fix Meta breakage fast.

### Community actors

- **`curious_coder/facebook-ads-library-scraper`** — $0.75/1k ads; 30+ fields; 37,041 users, 4.75★, 100% success, updated 2026-01-30; proxy rotation and retries. Best price/credibility ratio of the community set. <https://apify.com/curious_coder/facebook-ads-library-scraper>
- **`constructive_calm/facebook-ad-library-pro`** — $0.59/1k (+$0.25/1k details, +$1/1k advertiser resolution); accepts page URLs and keywords; 240+ countries; only 206 users. <https://apify.com/constructive_calm/facebook-ad-library-pro>
- **`scraperhive/meta-ads-library-scraper`** — $4.00/1k down to $1.99/1k; 70 users. <https://apify.com/scraperhive/meta-ads-library-scraper>
- **`thirdwatch/fb-ad-library-scraper`** — **avoid.** $22.00/1k, keyword-only input, and its own listing admits "text snippets can be truncated to what is visible in the Library card view." Disqualifying for creative-copy analysis. <https://apify.com/thirdwatch/fb-ad-library-scraper>

**ToS posture.** Apify is an established company with a public store, ratings, issue trackers and real billing — the best institutional posture here. But community actor quality is the individual developer's, and only the first-party actor puts the platform itself on the hook.

---

## 6. Ruled out

- **Bright Data — no Ad Library product.** Verified four ways: the scraper docs list 8 Facebook data types with no ads (<https://docs.brightdata.com/datasets/scrapers/facebook/introduction>); the product page lists 14 templates with no ads (<https://brightdata.com/products/web-scraper/facebook>); their full docs index has zero Ad Library entries (<https://docs.brightdata.com/llms.txt>); the dataset marketplace lists no Facebook Ads dataset (<https://brightdata.com/products/datasets>). ⚠️ An SEO landing page at `/products/datasets/facebook/ads` claims "2.4M records" with a Buy button, but Google's index of that same page renders the title as "**0+ Records Available**" — consistent with a dynamic counter returning zero. Even taken at face value it is a batch dataset with a **$250 minimum order** and daily/weekly refresh, not a per-page API. **Not a candidate.**
- **Forager.ai — wrong company entirely.** Their 16 data products are B2B contact/company/jobs data (LinkedIn profiles, emails, phone numbers). Zero advertising datasets. <https://datarade.ai/data-providers/forager-ai/data-products> **Not a candidate.**
- **Oxylabs, ZenRows, Piloterr, Nimble, SOAX, ScraperAPI — generic infrastructure, no Ad Library endpoint.** Oxylabs' Web Scraper API source list is Google-dominated with no Facebook/Meta source (<https://oxylabs.io/products/scraper-api>). With these you'd build and own the Ad Library parser yourself — i.e. you'd own the Meta-breaking-changes problem, which is the entire reason to buy a vendor. (Oxylabs verified directly; the others ruled out via search rather than exhaustive doc review — high-confidence but not exhaustive.)
- **AdSpy / PowerAdSpy / BigSpy — no public API.** AdSpy is a flat $149/mo dashboard product. These are UI tools for humans, not data infrastructure. <https://adlibrary.com/posts/bigspy-vs-poweradspy-vs-adspy>
- **AdLibrary.com — API gated behind €329/mo.** 1 credit per *record*, so a single 1,000-ad refresh would exhaust the Business plan's monthly allowance. No page_id input, no documented active-only or country filter, and no landing/destination URL field. **Not a candidate.**
- **Foreplay — real API, contradictory access status.** Their help centre says the API is "available across all plan types," while their marketing page says it is "currently in private beta." Pricing, credit costs, rate limits, page_id support, and filters are all unpublished. Enriched data (transcripts, emotional tone) is a genuine differentiator if we ever want it, but there is nothing to design against today. <https://help.foreplay.co/en/articles/0374062-getting-started-with-the-foreplay-api> vs <https://www.foreplay.co/api-access>
- **SociaVault** — has Ad Library endpoints, but **no documented server-side active-only or country filter** (their page suggests filtering by country "in your analysis", i.e. client-side). Disqualifying until verified. <https://sociavault.com/pricing>

---

## 7. Costed estimate: one refresh of 10 pages × ≤100 active US ads

10 competitor pages, ≤100 active ads each = ≤1,000 ads. For per-request vendors, assume ~4 paginated calls per page (25–30 ads/call) ≈ **40 calls per refresh**, plus one-off page-ID resolution.

| Vendor | Unit | **Per refresh** | Refreshes at the entry plan | Notes |
|---|---|---|---|---|
| **ScrapeCreators** ($1.88/1k) | request | **~$0.08** | $47 pack ≈ **625 refreshes**, never expires | No monthly floor at all. |
| **Social Fetch** ($1.88/1k) | request | **~$0.08** | $47 pack ≈ **625 refreshes**, never expires | Identical economics to ScrapeCreators. |
| **SocialAPIs.io** (Pro $4.99) | call | **~$0.12** | ~37/mo on $4.99; 750 on $49 | Cheapest floor of any vendor. |
| **SearchAPI.io** (Developer $40/mo) | search | **~$0.16** | ~250/mo, well inside 10K allowance | Real cost is the **$40 floor**; $100 Production if we want the legal guarantee. |
| **Adyntel** ($44/mo) | credit | **~$0.35** (40 credits) | **125/mo** | Credits roll over to 2×. |
| **Metapi.io** (Lite $29/mo) | **record** | **1,000 records** | **25/mo** — free tier covers 3 | Per-record billing bites immediately. |
| **Apify first-party** (Starter $29/mo) | **ad** | **$5.00** | Daily refresh ≈ **$150/mo** + floor | Blows past the Starter allowance into overage. |
| Apify `curious_coder` | ad | $0.75 | ~$22.50/mo daily + floor | |
| Apify `thirdwatch` | result | ~$22.00 | ~$660/mo daily | Disqualified on truncated copy. |

**The structural point:** the top five bill per *request*; Metapi and Apify bill per *ad* or *record*. At ~100 ads per page that is a 30–60× unit-cost gap, and it widens with every client and every increase in cadence. At 50 clients × 10 competitors daily, Apify Starter rates run ≈ **$750/mo** while ScrapeCreators or Social Fetch stay **under $10**.

---

## 8. Recommendation — shortlist for a real-key trial

**Trial these two in parallel. Both have free tiers with no card, so the trial costs $0.** Build behind a thin vendor-agnostic interface — the field shapes are near-identical across the top five, so swapping should stay cheap, and that optionality is the real hedge against a small vendor folding or Meta breaking everyone at once.

### 1. ScrapeCreators — primary

- **Per-request billing with no subscription floor.** ~8 cents per refresh, and cost does not scale with ads-per-page. A $47 pack plausibly covers years.
- **Synchronous REST** — drops straight into a Trigger.dev task; no run/poll/webhook dance, no 300s ceiling.
- **Raw Meta-shaped payload** we can persist verbatim and re-parse later.
- `status=ACTIVE` is the default and `country=US` is first-class — exactly our query.
- **Risks:** undocumented page size; `snapshot.title` often null so "headline" may need deriving from `link_description`/`caption`; solo maintainer, no SLA, no status page.

### 2. SearchAPI.io — co-primary, the institutional hedge

- Native `page_id`, server-side active + country filters, sync REST at ~2.5s, documented rate limits, and its own page-search engine for URL→ID resolution: a **drop-in substitute** for ScrapeCreators.
- **The only contractual 99.9% uptime SLA in this comparison**, on every plan including the $40 tier.
- ⚠️ **Do not buy it for the $2M legal guarantee without reading §3.** That guarantee starts at the **$100/mo Production plan** (not the $40 Developer tier), and it explicitly excludes claims arising from *our* use, storage, redistribution, or commercialization of the data — which is most of what we'd be doing. It indemnifies their scraping, not our product.

### Swap-ins if the trial disappoints

- **Adyntel** — best ergonomics of the group (sync POST, active-by-default, `all_ads` flag), $44/mo, but domain/URL input only and no published rate limits or SLA.
- **Social Fetch** — native `pageId`, purpose-built company-ads route, OpenAPI-generated docs, registered UK operator, and no monthly floor. ⚠️ But see §4: its pricing and endpoint shape are so close to ScrapeCreators' that **the two should not be treated as independent redundancy**.
- **SocialAPIs.io** — cheapest floor ($4.99) with the best-documented rate limits, pending verification that it actually returns headline and landing URL.
- **Metapi.io** — richest fields, but async task/poll and per-record billing; free tier covers ~3 refreshes/mo.

### Considered, not shortlisted

**Apify `apify/facebook-ads-scraper`** has the best ToS and maintenance posture of anything here and takes page URLs directly — but per-ad billing and the async actor model are structurally wrong for a frequent multi-page refresh. Still worth **one free-tier run as a completeness cross-check** (step 5 below); that comparison is its real value to us.

### Trial protocol

1. Free keys: ScrapeCreators (100 credits), SearchAPI.io (100 requests), Apify (free tier). No cards needed.
2. Pick 3 real US DTC competitor pages from an existing client's list.
3. On each vendor: resolve `page_id` from the page URL, then paginate with `country=US` + active-only to 100 ads. **Record the actual ads-per-response** — it drives both the pagination code and the cost model.
4. Run the same 3 pages through `apify/facebook-ads-scraper` (`activeStatus: active`, `resultsLimit: 100`).
5. **Diff the `ad_archive_id` sets across all three.** This is the decisive test: coverage gaps, null-headline rate, carousel handling, and whether `link_url` is the true destination or an `l.facebook.com` redirect. **No vendor publishes a coverage guarantee, so this diff — not any marketing claim — should gate the final decision.**
6. Fetch one media URL from each and confirm expiry, then wire the ingest-time re-host (see §0).
7. Before launch, email the chosen vendor about surfacing their data inside a client-facing product — SearchAPI's terms explicitly restrict redistribution without written consent, and the others are silent rather than permissive.

---

## 9. Facts we could not verify

- **ScrapeCreators ads-per-response** for `company/ads` — undocumented. The 25–50 range used in the cost model is inferred from the sibling search endpoint and from SearchAPI's ~25/page. Cost conclusions are robust to this (a 2× swing on a number measured in cents); the pagination code is not.
- **Whether each pagination call bills as a separate search on SearchAPI** — their "only successful 200 responses incur charges" implies yes, but it is not stated explicitly. Answerable in ten minutes with a free key.
- **Whether Social Fetch and ScrapeCreators share an upstream backend** — the pricing and endpoint similarity is striking, the registered operators differ, and we found no evidence either way. Material only because it determines whether pairing them counts as redundancy.
- **Social Fetch and SocialAPIs.io output completeness** — body copy, headline and landing-URL field names are summarized but not enumerated on their public pages.
- **Metapi `is_active` in the response** — you filter on input; no output boolean is documented.
- **ScrapeCreators and Adyntel uptime** — 98.2% and 99.99% respectively are self-reported marketing with no status page or contract behind them.
- **How any vendor handles Meta breaking changes** — no published incident history or postmortems for ScrapeCreators, Adyntel, Social Fetch, SocialAPIs or Metapi. Apify actors have public Issues tabs, but we could not retrieve `apify/facebook-ads-scraper`'s changelog to date its last Meta-breakage fix. SearchAPI's SLA is the only contractual commitment found, and it covers uptime rather than data completeness.
- **Whether any source is *complete*** versus the Ad Library UI. Nobody guarantees coverage. Step 5 of the trial exists to answer this.
- **Not researched:** MagicBrief, Datamam, and the specifics of third-party RapidAPI Ad Library listings. Low probability of beating the shortlist, but genuinely unchecked rather than ruled out.
