# Free/open-source Meta Ad Library scrapers on GitHub

**Research date:** 2026-08-13  
**Scope:** Read-only GitHub/API review; no repository was cloned, installed, or run. Stars and maintenance dates are snapshots as of the research date.

## Executive summary

Only two projects found are credible candidates for the requested US commercial-ad workflow:

1. **[`promisingcoder/MetaAdsCollector`](https://github.com/promisingcoder/MetaAdsCollector)** — the clear technical top pick. It calls Meta's logged-out internal GraphQL surface directly with `curl_cffi` TLS/browser impersonation, supports page ID and page-name resolution, `US`, `ACTIVE`, and a result cap, and exposes nearly every required field. It is MIT licensed and avoids Chromium. Its latest fix (2026-07-22) explicitly responds to Meta's new 403/JS gate and says the core flows were live-verified. The missing piece is an explicit display-format field, which must be derived from cards/images/videos.
2. **[`athm793/meta-ads-scraper`](https://github.com/athm793/meta-ads-scraper)** — the runner-up and strongest browser-based implementation. It is a current TypeScript/Next.js application with Playwright stealth, exact page-ID search, country/status filters, robust field parsing (including inferred media type), adaptive backoff, optional proxies, and Apache-2.0 licensing. It is much heavier than needed and designed as a single-process local application rather than an embeddable package.

Despite those options, **neither is economically better than ScrapeCreators for the stated usage**. At roughly **$0.02 per refresh**, two manually refreshed competitor pages are likely to cost pennies per month. One Meta breakage investigation, Chromium deployment issue, expired-media workaround, or proxy purchase would exceed years of vendor request cost. Self-hosting is reasonable only for strategic control, vendor independence, learning, or much higher future volume—not to save money today.

## Comparison table

“Fields” uses the requested set: archive ID, body, headline/title, display format, image/video URLs, landing URL, start date, active state.

| Repository | Stars | Last commit | Approach | Inputs / filters | Requested-field coverage | License / commercial use | Assessment |
|---|---:|---:|---|---|---|---|---|
| [`promisingcoder/MetaAdsCollector`](https://github.com/promisingcoder/MetaAdsCollector) | 51 | 2026-07-22 | **Direct HTTP** to internal GraphQL; `curl_cffi` Chrome TLS impersonation | Page ID, page URL, page name/typeahead; `US`; `ACTIVE`; max results | **7/8 explicit**: all except display format; format derivable from cards/images/videos | MIT; yes | **Top pick**; focused, package/CLI/async APIs, but one maintainer and inherently fragile private GraphQL contract |
| [`athm793/meta-ads-scraper`](https://github.com/athm793/meta-ads-scraper) | 33 | 2026-08-01 | **Playwright/Chromium**, intercepts SSR and GraphQL; replays detail GraphQL in-page | Exact page ID and advertiser typeahead; country; active/inactive/all; limit | **8/8** after its `media_type` inference | Apache-2.0; yes, with notice obligations | **Runner-up**; freshest and robust, but heavyweight application rather than small library |
| [`NiksHacks/meta-ads-library-scraper`](https://github.com/NiksHacks/meta-ads-library-scraper) | 23 | 2025-12-24 | Playwright/Crawlee GraphQL interception plus brittle DOM selectors; packaged as an Apify Actor | Keyword/page ID/country/max; code hard-codes `active_status=all` | ID/body/media/link/start/isActive claimed; no reliable headline/format; parsing paths look incomplete | `package.json` says MIT, but no LICENSE file; grant is legally unclear | Reject: Apify-focused (out of scope), no tests, stale “2025” selectors, active-only input not honored |
| [`domini-67/facebook-ads-library-scraper`](https://github.com/domini-67/facebook-ads-library-scraper) | 22 | 2025-11-10 | **Not actually a scraper**; normalizes offline JSON or calls a user-supplied backend URL | Keyword/country/limit only, delegated to backend | README claims many fields, but repository does not fetch Meta itself | MIT; yes | Reject: requires the very scraping backend it purports to replace; source even begins with malformed `thonimport` |
| [`Ashish-Github193/Facebook-Ads-Library`](https://github.com/Ashish-Github193/Facebook-Ads-Library) | 31 | 2023-07-05 | Selenium plus hard-coded XPath/DOM extraction | Keyword and country; URL sets `active_status=all`; date slicing | Partial card text/date/platform data; no dependable structured creative/link/format contract | No license; **no commercial reuse permission** | Reject: stale, brittle XPaths, browser-heavy, explicitly has an IP-block path, no usable license |
| [`saksham21-code/Fibr-facebook-ads-library-scraper`](https://github.com/saksham21-code/Fibr-facebook-ads-library-scraper) | 5 | 2024-09-21 | Selenium Java/Spring Boot backend plus React frontend | Search phrase and country | README shows generic API screenshots but no documented full field contract | No license; **no commercial reuse permission** | Reject: large Java/browser stack, stale, undocumented fields, no license |
| [`unixpickle/ad-index`](https://github.com/unixpickle/ad-index) | 1 | 2023-09-21 | Selenium DOM scraping and screenshots | Keyword only; UI-click setup | ID, account, start date, flattened text/screenshot only | No license; **no commercial reuse permission** | Reject: lacks country/page targeting and most required fields; stale DOM traversal |
| [`bufferbandit/facebook-ads-library-scraper`](https://github.com/bufferbandit/facebook-ads-library-scraper) | 1 | 2023-05-29 | Selenium DOM scraping | Minimal/undocumented | Minimal/undocumented | No license; **no commercial reuse permission** | Reject: one-file proof of concept, stale, no field/filter guarantees |
| [`riquedev/FacebookADLibrary`](https://github.com/riquedev/FacebookADLibrary) | 3 | 2026-06-29 (dependency automation) | **Official** `graph.facebook.com/.../ads_archive` API | Official API filters including page IDs/country/status | Official fields only; no public-site creative media workflow | GitHub reports `NOASSERTION`; license file exists but metadata is unclear | Out of scope/non-solution: official API cannot return the needed US commercial ads |
| [`minimaxir/facebook-ad-library-scraper`](https://github.com/minimaxir/facebook-ad-library-scraper) | 141 | 2019-11-11 | Official Ad Library Graph API | Official API query inputs | Official API limitations; no website/GraphQL scrape | MIT; yes | Out of scope/non-solution despite highest stars; abandoned and uses the API known not to cover this use case |

### Discovery notes

The searches also surfaced paid/API wrappers, ScrapeCreators clients, Apify actors, political-ad-only official API clients, and unrelated Google/TikTok ad-library tools. Those were excluded by the stated non-goals. Star count proved particularly misleading: the most-starred result uses the official API, while one apparently polished “scraper” merely delegates to an unspecified backend.

## Serious candidate 1: promisingcoder/MetaAdsCollector

### Why it is the top pick

This is the only credible, focused **direct-HTTP** implementation found. Its [README](https://github.com/promisingcoder/MetaAdsCollector/blob/main/README.md) describes all-country/all-ad-type access through Meta's private GraphQL endpoint, with no API key. The [client](https://github.com/promisingcoder/MetaAdsCollector/blob/main/meta_ads_collector/client.py) posts to `https://www.facebook.com/api/graphql/` using `curl_cffi` with Chrome TLS impersonation rather than launching a browser. Both synchronous and asynchronous interfaces are available, so it can run as a Python subprocess or separate worker from a Trigger.dev task.

### Inputs and filters

The high-level [collector implementation](https://github.com/promisingcoder/MetaAdsCollector/blob/main/meta_ads_collector/collector.py) supports:

- `collect_by_page_id(page_id)`;
- `collect_by_page_name(name, country)` using the internal typeahead query and selecting the first result;
- `search_pages()` if the caller wants to disambiguate names itself;
- `country="US"` (also the default);
- `status="ACTIVE"` (also the default);
- `max_results=100`;
- cursor pagination and a default page size of 10 (documented maximum around 30).

For production, use the numeric page ID whenever available. “First typeahead result” is unsafe for same-named brands unless the caller first presents or validates the candidates.

### Output-field fit

The [models/parser](https://github.com/promisingcoder/MetaAdsCollector/blob/main/meta_ads_collector/models.py) exposes:

- `Ad.id` as the Ad Archive ID;
- `creatives[].body`, `.title`, `.description`, and `.link_url`;
- image, video HD/SD, generic video, and thumbnail URLs;
- `delivery_start_time` / `delivery_stop_time`;
- `is_active` and `ad_status`;
- page identity and additional metadata.

It parses current flat payloads, card/carousel payloads, and legacy shapes. **Display format is not modeled explicitly.** A small normalization layer should derive `IMAGE`, `VIDEO`, `CAROUSEL`, or `UNKNOWN` from the number/presence of cards, images, and videos (or retain `raw_data` while doing this). That is the only meaningful schema gap for the requested feature.

### Blocking and operational risk

No login or supplied cookies are required by default. The current bootstrap mines logged-out cookies and a real LSD token from the Facebook homepage. User cookies and proxies are optional.

The strongest evidence is also the clearest warning: the [2026-07-22 maintenance commit](https://github.com/promisingcoder/MetaAdsCollector/commit/0ffb2fb1af94eae6542b328ab3ae31fc1c9a5897) says Meta had begun returning a 403/JS challenge for direct requests to `/ads/library/`, completely breaking the old bootstrap. The maintainer changed bootstrap to the Facebook homepage and reports live verification of search, cursor pagination, page enumeration, typeahead, and field parsing. The [changelog](https://github.com/promisingcoder/MetaAdsCollector/blob/main/CHANGELOG.md) also records earlier 403 failures with ordinary `requests`/`httpx`, motivating mandatory TLS impersonation.

This means it currently has the lowest runtime footprint, but not the lowest protocol risk. Meta can rotate GraphQL `doc_id`s, tokens, variable shapes, or gate the homepage next. Its proxy pool and session-refresh machinery help with throttling, but do not remove datacenter-IP risk. The repository does not promise that every cloud/datacenter IP works. A residential proxy would make “free” no longer free.

### Maintenance reality

- 51 stars; MIT license.
- Latest substantive commit: 2026-07-22, specifically fixing a live Meta break.
- 788 tests claimed after that fix; CI and Python 3.9–3.13 matrix are present.
- No open issue reports containing “broken,” “blocked,” or “not working” were found at research time.
- **Bus factor: one**: GitHub lists one code contributor. The history is young (initial production package in February 2026) and shows repeated adaptation to Meta changes. That is encouraging responsiveness, but also proof that maintenance is ongoing, not solved.

### Integration recommendation

If self-hosting is pursued, pin an exact version/commit and wrap it behind a tiny internal adapter that emits the app's desired schema. Run a scheduled canary against one known page and validate both a nonzero count and required-field completeness. Alert on auth/GraphQL errors and sudden empty results. Do not silently treat failure as “no active ads.” Persist media immediately if long-lived previews matter; Meta CDN URLs can expire.

## Serious candidate 2: athm793/meta-ads-scraper

### Why it is runner-up

This repository is a complete, actively maintained TypeScript/Next.js competitive-research app. Its [README](https://github.com/athm793/meta-ads-scraper/blob/master/README.md) accurately describes a real headless Chromium approach: load the public Ad Library, capture SSR JSON and pagination GraphQL responses, and replay the “See ad details” GraphQL query from inside the page context.

The [scraper](https://github.com/athm793/meta-ads-scraper/blob/master/src/lib/scraper.ts) builds exact advertiser URLs with `view_all_page_id`, `country`, and active status, intercepts the initial HTML and GraphQL pagination, scrolls until the cap, and paces detail calls. The [parser](https://github.com/athm793/meta-ads-scraper/blob/master/src/lib/parser.ts) explicitly infers `image`, `video`, `carousel`, and `multi_video`, and extracts all requested fields.

### Inputs, filters, and fields

It supports page ID, advertiser/page typeahead, keyword, country, active/inactive/all, and a result limit. Its model covers archive ID, multiple body variants, headline, media type, image/video URLs, carousel card URLs, landing URL, dates, and status. For the exact requested schema it is more complete out of the box than MetaAdsCollector.

One parsing caveat: `status` is produced from truthiness (`node.is_active ? 'ACTIVE' : 'INACTIVE'`), so an absent `is_active` field can be mislabeled inactive. With an active-only server-side search this is less likely to affect the requested path, but the adapter should distinguish `false` from `undefined`.

### Blocking and operational risk

It uses Playwright plus stealth plugins. The [browser helper](https://github.com/athm793/meta-ads-scraper/blob/master/src/lib/browser.ts) launches Chromium with anti-automation flags and randomized viewport. No login is required. Optional proxies are read from an environment variable or file and rotated per browser context.

The README documents adaptive cooldown on 403/429, optional proactive throttling, proxy rotation for heavier use, and a health endpoint that identifies renamed Meta queries. This is mature operational thinking. It also candidly says Playwright is unsuitable for serverless functions and the app needs one long-lived process because rate-limit/backoff state is in memory. That conflicts with simply dropping it into a normal Next.js/Trigger.dev deployment: it needs a dedicated worker/container or significant extraction.

Browser execution is more resilient to JS challenges than direct HTTP, but consumes hundreds of MB for Chromium, starts more slowly, has more deployment failure modes, and is still detectable/rate-limited. Proxy cost may still appear on a datacenter host.

### Maintenance reality

- 33 stars; Apache-2.0.
- Latest commit 2026-08-01; scraper-related fixes continued through June/July 2026.
- No open issues at research time, so there is little independent user evidence either way.
- The commit history includes rate-limit handling, media/carousel fixes, country stamping, and warnings for expired Meta CDN URLs. Those are strong signs of real-world usage.
- **Bus factor: one**: GitHub lists one contributor.
- It is a full product (Next.js UI, SQLite, saved ads, analytics, webhooks), not a reusable scraper package. Adopting it wholesale creates a large maintenance surface unrelated to this feature.

### Integration recommendation

If chosen, extract only `browser.ts`, `scraper.ts`, `parser.ts`, rate limiter, proxy, and health modules into a dedicated long-lived Node worker. Do not deploy the unauthenticated full app publicly. Preserve the health probe and explicit partial-result warnings. Expect to download Chromium in the worker image and persist/download creative media before signed CDN links expire.

## Other notable candidates and rejection evidence

### NiksHacks/meta-ads-library-scraper

The [source](https://github.com/NiksHacks/meta-ads-library-scraper/blob/main/src/main.js) is an Apify/Crawlee Actor using Playwright, stealth snippets, GraphQL interception, and fallback DOM selectors. Although it can theoretically use the Apify SDK locally, this is exactly the Apify-oriented class excluded by the brief. More importantly, `buildSearchUrl()` hard-codes `active_status=all`, while the `includeInactive` input is never applied there. The GraphQL parser looks only under a short list of guessed top-level paths and omits a dependable title/display-format contract. `package.json` says MIT, but the repository has no LICENSE file. It has no tests and no issues/user reports. Not suitable for a commercial integration.

### domini-67/facebook-ads-library-scraper

This repository's [README](https://github.com/domini-67/facebook-ads-library-scraper/blob/main/README.md) advertises direct extraction and benchmarks, but the [main source](https://github.com/domini-67/facebook-ads-library-scraper/blob/main/src/main.py) only loads fixture JSON or calls an arbitrary user-configured `api_url`; its own comment calls that “your own proxy or scraping backend.” It therefore provides no free Ad Library transport. The checked-in main file also starts with `thonimport argparse`, which is not valid Python. The MIT license is usable, but there is nothing here that replaces a vendor.

### Ashish-Github193/Facebook-Ads-Library

The [main script](https://github.com/Ashish-Github193/Facebook-Ads-Library/blob/main/main.py) drives Selenium and relies on absolute XPath paths and visible English strings. It searches by keyword/country with `active_status=all`, slices results by dates, and contains an explicit “IP block” error path. Last code activity was in 2023, and there is no license. Even if repaired, it would be a heavier and less structured version of the runner-up.

### unixpickle/ad-index

The [client](https://github.com/unixpickle/ad-index/blob/main/ad_index/client.py) uses Selenium to click “All ads,” fill the search box, traverse ancestors from visible “Library ID” text, and screenshot card content. It returns ID, account, start date, and flattened text—not structured creative assets or landing links—and has no page-ID/country API. It was last updated in 2023 and has no license.

### Official-API repositories

[`minimaxir/facebook-ad-library-scraper`](https://github.com/minimaxir/facebook-ad-library-scraper) and [`riquedev/FacebookADLibrary`](https://github.com/riquedev/FacebookADLibrary) call `graph.facebook.com/.../ads_archive`. They may be useful for political/EU research, but cannot satisfy the stated US commercial-ad use case. High stars or recent dependency-bot commits do not change that functional mismatch.

## Final verdict

### Top pick for self-hosting

**`promisingcoder/MetaAdsCollector`**, pinned to the current fixed release/commit, with a thin internal schema adapter and a live canary. It best fits a background job because it is direct HTTP, async-capable, Python-script friendly, and does not require Chromium. Derive display format locally and prefer exact page IDs.

### Runner-up

**`athm793/meta-ads-scraper`** if direct HTTP fails from the deployment network or if browser-based collection proves materially more resilient. It has the strongest complete field extraction and is already TypeScript, but should be reduced to a dedicated long-lived worker rather than adopted as another Next.js app.

### Does either beat ~$0.02 per refresh?

**No—not at the current scale.** “Free” here means zero software license fee, not zero total cost. Both implementations depend on undocumented Meta behavior. The direct client was completely broken by a Meta gate in July 2026; the browser project's own history documents throttling, query-name changes, and expiring CDN media. Either can require:

- engineering time to diagnose sudden empty/partial results;
- updates when tokens, document IDs, variable shapes, markup, or query names change;
- canary monitoring and field-completeness checks;
- browser packaging and dedicated-worker resources for Playwright;
- potentially paid residential proxies if cloud/datacenter IPs are blocked;
- media persistence if previews must survive signed-URL expiry.

At $0.02 per refresh, even **100 refreshes/month cost about $2**. A single 30-minute repair at any realistic engineering rate dwarfs years of the stated two-page manual usage. ScrapeCreators also externalizes the arms race and offers a stable contract, although vendor outages and API changes remain possible.

**Recommendation:** keep the paid vendor for production now. If vendor independence is strategically important, build a small proof-of-concept adapter around MetaAdsCollector and run it as a monitored shadow/canary—not as the primary path. Revisit self-hosting if refresh volume rises by orders of magnitude, the vendor becomes unreliable, or owning the collection layer becomes a product requirement.

## Terms note

All website/GraphQL options scrape an undocumented public web surface and may conflict with Meta's terms; this report does not provide legal advice or a broader ToS assessment.
