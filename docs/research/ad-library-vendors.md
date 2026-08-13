# Third-party Meta Ad Library providers

Research for [#147](https://github.com/noelrohi/creatives-tracker/issues/147) (part of wayfinder map [#146](https://github.com/noelrohi/creatives-tracker/issues/146)).

**Question:** which third-party provider can reliably return up to ~100 **active** ads for a given Facebook page, **US commercial (non-political)**, and what does each actually deliver?

**Researched:** 2026-08-13. All facts below come from vendor docs/pricing pages, cited inline. Prices and actor stats move — re-check before committing spend. Anything we could not confirm is called out in §7 rather than guessed at.

---

## 0. Why we need a vendor at all

Meta's official `ads_archive` Graph API cannot serve this use case. From Meta's own reference:

> "Ads that did not reach any location in the EU will only return if they are about social issues, elections or politics."

— <https://developers.facebook.com/docs/graph-api/reference/ads_archive/>

The official API therefore gives us EU-targeted commercial ads plus political/issue ads worldwide. A US DTC brand's product ads are neither. `ad_reached_countries` is a required parameter, and setting it to `US` for a non-political category returns nothing useful.

Every option below is consequently an **unofficial** source reading the public Ad Library web/GraphQL surface. This is a ToS-posture question, not a compliance-clean one, and the vendor choice should be made with that understood.

---

## 1. Comparison table

Only the credible contenders are in this table. Ruled-out and non-applicable vendors are in §4.

| | **ScrapeCreators** | **SearchAPI.io** | **Metapi.io** | **Apify `apify/facebook-ads-scraper`** | **Apify community actors** |
|---|---|---|---|---|---|
| What it is | Dedicated scraping-API vendor (solo founder) | Established multi-engine SERP/data API company | Dedicated Ad Library API, small independent team | First-party actor by Apify itself | Third-party actors on Apify's store |
| Delivery model | **Synchronous REST** (GET/POST → JSON) | **Synchronous REST** (GET/POST → JSON) | **Synchronous REST** (JSON/CSV) | Async actor run + dataset poll (sync wrapper capped at 300s) | Same |
| Billing unit | **Per request** (1 credit) | **Per search** | **Per record (ad)** | **Per ad** | **Per ad** |
| Input | `pageId` **or** `companyName` — page URL not accepted directly | `page_id` **or** `q` keyword | keyword / advertiser name / pasted Ad Library URL | Facebook page URL, Ad Library brand URL, or Ad Library search URL | Ad Library / page URLs |
| Active-only | `status=ACTIVE` (the **default**) | `active_status=active` | active/inactive filter | `activeStatus: "active"` | yes |
| US filter | `country=US` | `country` (defaults ALL) + `location_id` | country filter | via Ad Library URL / country field | country ISO codes |
| Pagination to ~100 | `cursor`; POST variant when the cursor grows | `next_page_token`; POST when token exceeds ~8KB | documented as paginated (page size unstated) | `resultsLimit`, actor paginates internally | `resultsLimit` |
| Observed page size | **not documented** (search endpoint example shows 50) | ~25 ads in the docs example | not documented | n/a (actor handles it) | n/a |
| Unit price | $0.99–$1.88 / 1,000 requests | $1.00–$4.00 / 1,000 searches | records bundled into monthly tiers | $3.40–$5.80 / 1,000 ads | $0.59–$4.00 / 1,000 ads |
| Subscription floor | **None** — credit packs, credits never expire | **$40/mo** (Developer) | **$29/mo** (Lite); free tier 3K records/mo | Apify plan: Free ($5/mo credit) / $29 / $199 / $999 | same |
| Free trial | 100 credits, no card | 100 requests, no card | 3,000 records/mo free tier | $5/mo platform credit | same |
| Published SLA | **No** (self-reported 98.2% success, 3.12s avg) | **Yes — 99.9% uptime on every plan** | Claims 99.9% uptime + 24/7 monitoring (no contract seen) | No SLA; 99.9% run success, 1.4-day issue response | No |
| Rate limits | "No rate limits"; stay under ~500 concurrent | Max 20% of plan credits per hour | "No rate limiting" claimed | Apify account concurrency by plan | same |
| ToS posture | Solo commercial vendor, "only public data extraction", unaffiliated with Meta | Established company, paid SLA, mainstream SERP-API business | Small independent team, compliance-framed marketing | Established company, first-party actor, public issue tracker | Individual devs on an established platform |

---

## 2. ScrapeCreators

Docs: <https://docs.scrapecreators.com/v1/facebook/adLibrary/company/ads> · <https://docs.scrapecreators.com/introduction> · Landing/pricing: <https://scrapecreators.com/> · <https://scrapecreators.com/facebookAdLibrary-api>

### Input

`GET /v1/facebook/adLibrary/company/ads`, header `x-api-key`. One of:

- `pageId` — the Ad Library page ID, e.g. `367152833370567`
- `companyName` — e.g. `Lululemon`

Optional: `country` (2-letter, default `ALL`), `status` (`ACTIVE` | `INACTIVE` | `ALL`, **default `ACTIVE`**), `media_type`, `language`, `sort_by`, `start_date`/`end_date`, `cursor`, `trim`.

**Mapping our competitor page-URL lists to requests:** the endpoint does *not* take a `facebook.com/<slug>` URL. The companion endpoint `GET /v1/facebook/adLibrary/search/companies?query=<name>` (also 1 credit) returns `page_id`, `name`, `page_alias`, `category`, `likes`, `ig_username`, `verification`, `page_is_deleted` — and `page_alias` is the URL slug, so we can resolve a page URL to a numeric ID once and cache it. The right sync shape is: resolve `page_id` once at competitor-add time, then poll by ID forever.

### Output

The payload mirrors Meta's own Ad Library snapshot object almost verbatim, which is a good sign — low interpretation risk, and we can persist the raw JSON and derive fields later:

- `ad_archive_id`, `page_id`, `page_name`, `collation_id`, `collation_count`
- `is_active`, `start_date`, `end_date` (Unix timestamps), `publisher_platform`
- `snapshot.body.text` (body copy), `snapshot.title` (headline — **null in the docs' own example**), `snapshot.link_description`, `snapshot.caption`, `snapshot.byline`
- `snapshot.display_format` (`VIDEO` / `IMAGE` / …), `snapshot.cards[]` (carousel), `snapshot.images[]`, `snapshot.videos[]` with `video_hd_url`, `video_sd_url`, `video_preview_image_url`, `watermarked_video_hd_url`/`_sd_url`
- `snapshot.link_url` — destination/landing URL
- `snapshot.cta_text` / `snapshot.cta_type`
- page context: `page_categories`, `page_like_count`, `page_profile_picture_url`, `page_profile_uri`, `page_is_deleted`
- top level: `searchResultsCount`, `cursor`

Every field the ticket asks for is present. `trim=true` gives a condensed payload; we probably want `trim=false` to keep the full snapshot.

### Pagination

Cursor-based, with `searchResultsCount` giving the total. If the cursor grows too large during deep pagination, switch to the POST variant with the same params in the JSON body (<https://docs.scrapecreators.com/v1/facebook/adLibrary/company/ads/post>). Their guidance notes the *search* endpoint taps out near ~1,500 results on GET for this reason — irrelevant at ≤100 ads/page.

**Page size for `company/ads` is not documented.** The docs example shows one ad (illustrative); the sibling search endpoint's example shows 50. Assume 30–50 per call pending measurement.

### Pricing

Pay-as-you-go credit packs, no subscription (<https://scrapecreators.com/>):

| Plan | Price | Credits | $/1,000 |
|---|---|---|---|
| Free | $0 | 100 | — |
| Freelance | $47 | 25,000 | $1.88 |
| Business | $497 | 500,000 | $0.99 |
| Enterprise | custom | 1M+ | custom |

Credits never expire. **Cached results cost zero credits** (only cache misses bill). **1 credit per request** on the ad-library endpoints — the credit unit is the *request*, not the ad, which is the single most consequential pricing fact in this document.

### Limits & reliability

- Docs state "Scrape Creators does not enforce API rate limits", suggesting you stay under 500 concurrent requests. `402` on credit exhaustion.
- Landing page claims 98.2% success rate and 3.12s average response over the trailing 30 days. **No formal SLA, no status page.**
- Support is the founder directly (`support@scrapecreators.com`, advertised as 1-on-1 with no ticket queue).
- Meta breaking changes: no published policy or incident history. **Bus factor of one.**

### ToS posture

A small, real commercial vendor. States it extracts only public data and is explicitly unaffiliated with Meta. Not an enterprise-compliance story, but not an anonymous scraper either.

---

## 3. Apify

Platform pricing (<https://apify.com/pricing>): Free ($0, $5/mo platform credit), Starter ($29), Scale ($199), Business ($999). Actor charges draw down platform credits; overage bills to the next invoice.

### `apify/facebook-ads-scraper` — first-party

<https://apify.com/apify/facebook-ads-scraper> · <https://apify.com/apify/facebook-ads-scraper/api>

- **Input:** `startUrls` takes a Facebook page URL, an Ad Library brand URL, or an Ad Library search URL — so a competitor page-URL list maps 1:1 with **no ID-resolution step**. Plus `resultsLimit`, `activeStatus`, `sorting`, `onlyAdsNewerThan`/`onlyAdsOlderThan`, `onlyTotal`, `isDetailsPerAd`, `includeAboutPage`, `enrichWithEcommerceData`.
- **Output:** ad text, creative formats (image/video/carousel), CTA text and destination links, platform distribution (Facebook/Instagram/WhatsApp/Threads), start/end dates, active status, spend and reach estimates where available, page/advertiser transparency data.
- **Delivery model — the important caveat:** this is an *actor run*, not an API call. POST a run, then poll the dataset. `run-sync-get-dataset-items` exists but hard-caps at **300 seconds**, returning HTTP 408 past that, and Apify's own docs push you to the async endpoint for anything longer (<https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post>). A 10-page × 100-ad refresh is a job-and-webhook integration, not a request/response one.
- **Pricing:** pay-per-result, 1 result = 1 ad. $5.80/1k (Free), $5.00/1k (Starter), $4.20/1k (Scale), $3.40/1k (Business). E-commerce enrichment bills separately from $5.70/1k.
- **Reliability:** 31,654 users, 4.19★, 99.9% run success, public Issues tab with a stated **1.4-day issue response time**. Apify maintaining its own actor is the strongest maintenance signal in the whole comparison — they have a commercial reason to fix Meta breakage fast.

### Community actors — cheaper, less accountable

- **`curious_coder/facebook-ads-library-scraper`** — <https://apify.com/curious_coder/facebook-ads-library-scraper> — $0.75/1,000 ads; 30+ fields (ad ID, reach/spend/impressions where present, dates, creative snapshots, advertiser info, political flags); 37,041 users, 4.75★, 100% run success, last updated 2026-01-30; built-in proxy rotation and retries. Best price/credibility ratio of the community set.
- **`constructive_calm/facebook-ad-library-pro`** — <https://apify.com/constructive_calm/facebook-ad-library-pro> — $0.59/1,000 ads, plus $0.25/1k for ad details and $1/1k for advertiser resolution; accepts Ad Library URLs, raw page URLs, or keyword search; 240+ country codes; but only 206 users.
- **`scraperhive/meta-ads-library-scraper`** — <https://apify.com/scraperhive/meta-ads-library-scraper> — $4.00/1k (Free) down to $1.99/1k (Business) plus a $0.0005 start fee; 70 users. Not compelling versus the above.
- **`thirdwatch/fb-ad-library-scraper`** — <https://apify.com/thirdwatch/fb-ad-library-scraper> — **avoid.** $22.00/1,000 results, keyword-only input, and its own listing admits "text snippets can be truncated to what is visible in the Library card view." That truncation alone disqualifies it for creative-copy analysis.

### ToS posture

Apify is an established company with a public store, ratings, issue trackers and real billing — the best posture in this comparison. But community actor quality belongs to the individual developer, and an unmaintained actor is a normal outcome. Only the first-party actor puts the platform itself on the hook.

---

## 4. Alternatives outside those two

### SearchAPI.io — credible, and the strongest reliability posture

Docs: <https://www.searchapi.io/docs/meta-ad-library-api> · <https://www.searchapi.io/docs/meta-ad-library-page-search-api> · Pricing: <https://www.searchapi.io/pricing>

An established multi-engine data API (30+ engines: Google, Bing, YouTube, Maps…) that exposes Meta Ad Library as two engines:

- `engine=meta_ad_library` — search by `q` keyword **or** `page_id`, with `country` (defaults ALL), `location_id`, `ad_type`, `active_status` (active/inactive/all), `media_type`, `platforms`, `start_date`/`end_date`, `sort_by`.
- `engine=meta_ad_library_page_search` — page discovery, i.e. the name → `page_id` resolution step, same as ScrapeCreators' `search/companies`.

**Output:** `ad_archive_id`, `is_active`, `page_id`, start/end dates, snapshot data (body, title, `link_url`, CTA text), `images`, `videos`, `cards`, publisher platforms, impressions. Essentially the same Meta-native shape as ScrapeCreators.

**Pagination:** `next_page_token` cursor. Their docs warn the token grows (2KB → 5KB → 8KB+ per page) and to switch to POST past 413/414 errors — the same pattern as ScrapeCreators, which strongly suggests both are reading the same underlying Meta GraphQL surface. The docs example shows ~25 ads per response and `request_time_taken` of ~2.5s.

**Pricing:** per *search*, tiered subscriptions — Developer $40/mo (10K searches, $4/1k), Production $100/mo (35K, $3/1k), BigData $250/mo (100K, $2.50/1k), up to Octo 5M $5,000/mo ($1/1k). Free trial 100 requests, no card. **Failed requests are not billed** — only 200s. Overage at the plan's per-1k rate.

**Limits & reliability:** **99.9% uptime SLA on every plan** — the only contractual availability commitment in this comparison. Rate limit is stated as "you can utilise only up to 20% of your plan's credits each hour," which at 10K/mo is ~2,000/hour: far above our needs.

**Verdict:** a genuine contender. Same API ergonomics and same per-request billing shape as ScrapeCreators, from a larger company with a published SLA. Its only real disadvantage is the $40/mo floor versus ScrapeCreators' pay-once credit pack.

### Metapi.io — plausible but per-record billing

<https://metapi.io/>

A dedicated Meta Ad Library API. Input by keyword/advertiser name or a pasted Ad Library URL, with country, status and media-type filters. Output covers creatives, ad copy, headlines, CTAs, landing URLs, advertiser/page info, delivery dates, placements, and 2+ years of history; JSON or CSV.

Pricing is **per record** on monthly tiers: Free 3K records/mo, Lite $29 (25K), Pro $79 (100K), Business $149 (500K), Scale $299 (2M). Claims 99.9% uptime with 24/7 monitoring and no rate limiting; in-app chat and email support from a small independent team.

**Verdict:** the free tier (3K records/mo) would actually cover three full 10-page refreshes per month at zero cost, which makes it interesting for a pilot. But per-record billing has the same scaling problem as Apify, we could not confirm whether `page_id` is a first-class input (the docs surface keyword/URL input), and the team is as thin as ScrapeCreators without the pay-once pricing. Keep as a backup, not a shortlist entry.

### Ruled out

- **Bright Data** — checked <https://brightdata.com/products/web-scraper/facebook>. They list 14 Facebook scrapers (posts, profiles, pages, marketplace, comments, reels, events, company reviews) and **no Ad Library product at all**. Their $1.5/1K-record pricing and $499/mo Scale plan are therefore irrelevant to us. Not a candidate.
- **Forager.ai** — their product is a B2B contact/company dataset (825M+ person and company profiles for sales/recruiting), per <https://datarade.ai/data-providers/forager-ai/profile>. No Meta Ad Library offering found. Not a candidate.
- **SocialCrawl** — <https://www.socialcrawl.dev/> markets 381 endpoints across 48 platforms with credit-based, no-subscription pricing (100 free credits; £15/2.5K, £49/20K, £299/150K; credits never expire) and 23 Facebook endpoints. Their own blog claims full Ad Library coverage, but **we could not confirm a documented Ad Library endpoint from the site itself** — treat as unverified. Pricing shape is attractive if it turns out to be real; worth a five-minute check before the trial, not a shortlist entry on current evidence.
- **UI-only ad-spy SaaS** (Foreplay, AdSpy, Magic Brief, PowerAdSpy and similar) — these are dashboards for humans, not data APIs we can drive from a Trigger.dev job. Out of scope for a programmatic refresh.

---

## 5. Costed estimate: one full refresh of 10 pages × ≤100 active US ads

Assume 10 competitor pages, ≤100 active ads each, so ≤1,000 ads per refresh. For per-request vendors, assume ~3 paginated calls per page (30–50 ads/call) = ~30 calls, plus one-off page-ID resolution.

| Vendor | Billing unit | **Per refresh** | Per month, daily refresh | Notes |
|---|---|---|---|---|
| **ScrapeCreators** (Freelance, $1.88/1k credits) | per request | **~$0.06** (~30 credits) | ~$1.90 | One $47 pack ≈ **2 years** of daily refreshes. |
| **ScrapeCreators** (Business, $0.99/1k) | per request | ~$0.03 | ~$1.00 | Only worth it at far higher volume. |
| **SearchAPI.io** (Developer $40/mo, $4/1k) | per search | **~$0.12** (~30 searches) | ~$3.60 — well inside the 10K/mo allowance | Real cost is the **$40/mo floor**, not the usage. |
| **Metapi.io** (Free tier, 3K records/mo) | per record | **$0** for up to 3 refreshes/mo | $29/mo Lite = 25K records ≈ 25 refreshes | Daily refresh needs Pro $79/mo (100K records). |
| **Apify `apify/facebook-ads-scraper`** (Starter $29/mo) | per ad | **$5.00** (1,000 ads) | **~$150/mo** + $29 floor | Daily refresh blows past the Starter allowance into overage. |
| Apify first-party, Free plan | per ad | $5.80 | $5/mo credit covers **less than one** refresh | Free tier not viable. |
| Apify `curious_coder` | per ad | $0.75 | ~$22.50/mo + plan floor | |
| Apify `constructive_calm` | per ad | $0.59 (+ add-ons) | ~$17.70/mo + plan floor | |
| Apify `thirdwatch` | per result | ~$22.00 | ~$660/mo | Disqualified on truncated copy anyway. |

**The structural point:** ScrapeCreators and SearchAPI bill per *request*; Apify and Metapi bill per *ad*. At ~100 ads per page that is a 40–80× unit-cost difference in the per-request vendors' favour, and the gap widens with every extra client and every increase in refresh cadence. At 50 clients × 10 competitors daily, Apify Starter rates come to roughly **$750/mo** while ScrapeCreators stays under **$10**.

---

## 6. Recommendation — shortlist for a real-key trial

**Trial both of these in parallel. Both have a free tier, so the trial costs $0.**

### 1. ScrapeCreators — primary candidate

- **Per-request billing with no subscription floor.** A full 10-page refresh costs ~6 cents and does not scale with ads-per-page. A single $47 credit pack plausibly covers years.
- **Synchronous REST.** Drops straight into a Trigger.dev task or a tRPC-triggered sync — no run/poll/webhook dance, no 300-second ceiling.
- **Raw Meta-shaped payload.** We can persist the snapshot JSON verbatim and derive fields later without a second vendor round-trip.
- **`status=ACTIVE` is the default** and `country=US` is first-class — precisely the query the feature needs.
- Free tier is 100 credits with no card, and credits never expire.

**Risks to test:** undocumented page size; `snapshot.title` is often null, so "headline" may need deriving from `link_description`/`caption`; solo maintainer, no SLA, no status page.

### 2. SearchAPI.io — co-primary, and the de-risking pick

- **Near-identical API ergonomics** (`page_id` + `active_status` + `country` + cursor) and the same per-request economics — ~$0.12 per refresh.
- **The only vendor here with a contractual 99.9% uptime SLA**, on every plan including the $40 entry tier, from an established multi-engine data company rather than a one-person shop. Failed requests aren't billed.
- Has its own page-search engine for the page-URL → `page_id` resolution step, so it is a **drop-in substitute** for ScrapeCreators: if we build the integration against a small vendor-agnostic interface, swapping is cheap insurance against the bus-factor-of-one risk.
- Trades ScrapeCreators' zero floor for a $40/mo minimum — the whole decision between the two comes down to whether the SLA and company size are worth $40/mo.

### Considered, not shortlisted

- **Apify `apify/facebook-ads-scraper`** has the best ToS and maintenance posture of anything here and takes page URLs directly, but per-ad billing and the async actor model are structurally wrong for a frequent multi-page refresh. Still worth **one throwaway free-tier run as a completeness cross-check** during the trial (see step 5 below) — that comparison is its real value to us.
- **Metapi.io** as a backup if both shortlist vendors disappoint; its free tier covers ~3 refreshes/month.
- **`thirdwatch`** (truncated ad copy at $22/1k) and the very-low-user community actors are price references, not foundations for a client-facing feature.

### Trial protocol

1. Sign up for ScrapeCreators (100 free credits) and SearchAPI.io (100 free requests) — neither needs a card. Grab an Apify free account for the cross-check.
2. Pick 3 real US DTC competitor pages from an existing client's list.
3. On each vendor: resolve `page_id` from the page URL via the page/company search endpoint, then paginate ads with `country=US` + active-only to 100 ads. **Record the actual ads-per-response** on both.
4. Run the same 3 pages through `apify/facebook-ads-scraper` with `activeStatus: active`, `resultsLimit: 100`.
5. **Diff on `ad_archive_id`** across all three. This is the decisive test — measure coverage gaps, null-headline rate, carousel handling, and whether `link_url` is the real destination or an `l.facebook.com` redirect.
6. Fetch one media URL from each and confirm expiry behaviour. Ad Library media sits on Meta's signed CDN and the signature lapses, so **we must download and re-host assets at ingest, never store the URL** (see <https://mackgrenfell.medium.com/fixing-the-facebook-ad-library-part-2-recreating-the-ad-library-de10b7829ac0>). This is a hard requirement regardless of vendor.
7. Build behind a thin vendor-agnostic interface so vendor #1 and vendor #2 stay interchangeable.

---

## 7. Facts we could not verify

- **ScrapeCreators ads-per-response** for `company/ads` — not documented anywhere we could find. The 30–50 range in the cost model is inferred from the sibling search endpoint's 50-ad example. The cost conclusion is robust to this (a 2× swing on a number measured in cents); the pagination code is not. Measure it first.
- **ScrapeCreators uptime** — the 98.2% / 3.12s figures are self-reported marketing, with no status page or contractual SLA.
- **Metapi.io `page_id` input** — their site advertises keyword/advertiser-name and pasted-URL input; we could not confirm a first-class numeric page ID parameter.
- **SocialCrawl Ad Library coverage** — claimed in their own blog content, not confirmed against a documented endpoint on their site.
- **How any vendor handles Meta breaking changes** — no published incident history, status page, or postmortems for ScrapeCreators or Metapi. Apify actors have public Issues tabs, but we could not retrieve `apify/facebook-ads-scraper`'s changelog to date its last Meta-breakage fix. SearchAPI's 99.9% SLA is the only contractual commitment we found, and even that speaks to uptime rather than data completeness.
- **Whether any source is *complete*** versus what the Ad Library UI shows for a page. No vendor publishes a coverage guarantee. Step 5 of the trial protocol exists precisely to answer this, and it should gate the final vendor decision.
