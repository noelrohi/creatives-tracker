# Adsolute Intelligence v1 — build-ready spec

The destination of the [Adsolute Intelligence v1 wayfinder map (#113)](https://github.com/noelrohi/creatives-tracker/issues/113): creative-tag attribution — revenue sliced by funnel stage, persona, angle and awareness — plus the ad↔landing-page mismatch diagnostics that findings v1 deferred, for the **Reviv** store, on top of [attribution v1 (PR #110)](https://github.com/noelrohi/creatives-tracker/pull/110). Every decision below was locked in tickets [#114](https://github.com/noelrohi/creatives-tracker/issues/114)–[#123](https://github.com/noelrohi/creatives-tracker/issues/123); this document compiles them. Where an earlier assumption was superseded by a later finding, the supersession is noted inline — nothing here re-litigates.

**The invariant carried over from attribution v1, extended to slices:** nothing is ever silently dropped. "No tags yet", "unmatched ad", and unconfirmed AI classifications are explicit, visible states — never $0, never a missing row, never a guess dressed as a fact.

---

## 1. Ground facts

All measured against the production DB (Reviv, `c598f3-79.myshopify.com`, `Asia/Bangkok`), 2026-08-03.

| Fact | Value | Source |
|---|---|---|
| Tagging coverage today | **0 of 3,925 ads fully tagged.** Persona 0%; angle/awareness ~15% of 2,111 creatives; 77 of 777 active ads have even an angle. Funnel stage has no column yet, so 0%. | [Tag enforcement (#119)](https://github.com/noelrohi/creatives-tracker/issues/119) |
| UTM template in the wild | Meta dynamic parameters: `utm_campaign={{campaign.id}}`, `utm_term={{adset.id}}`, `utm_content={{ad.id}}` on newer ads / `{{ad.name}}` on older. The id-form switch shows mid-July 2026. | [UTM audit (#116)](https://github.com/noelrohi/creatives-tracker/issues/116) |
| Sole UTM source in journeys | `lastVisit.utmParameters` — `landingPage` never retains query strings | #116 |
| Ad-set-grain coverage | `utm_term` = ad-set id on **97–99.7%** of Meta orders, every month held — backfillable across the whole window | #116 |
| Ad-grain coverage | By id alone: 43% → 79% (May → Aug) as the new template takes over; exact-name fallback scoped by ad set lifts the historical ceiling to **~90–96%** | #116 |
| Ad names are not unique | 3,925 ads, 2,107 distinct names — a bare name join is ambiguous; scoping by the order's `utm_term` ad set makes it near-deterministic | #116 |
| Unmatched residue | ~57 orders carry numeric ad ids matching no synced ad (deleted / out-of-scope) | #116 |
| Landing pages in the wild | 3,543 ads point at **110 distinct normalized URLs**; Meta-order journeys land on 115, 82 overlapping (~33 journey-only). Two species dominate: `/products/…` and `/pages/reviv-for-<concern>-vN` advertorials. | [Landing pages (#118)](https://github.com/noelrohi/creatives-tracker/issues/118) |
| Funnel actions already synced | `performance_log` already has `landing_page_views`, `add_to_cart`, `initiate_checkout` (+ `cost_per_lpv`/`cost_per_add_to_cart`); the mapper extracts them; the daily sync writes them per ad per day | [On-site events research (#114)](https://github.com/noelrohi/creatives-tracker/issues/114) |
| Meta retention | Aggregate metrics: **37 months** (the Jan 2026 API tightening capped only unique-counts and hourly breakdowns at 13) — deep historical funnel backfill available today | #114 |
| Bucket rule today | `BUCKET_RULE_VERSION = 4` in `src/lib/attribution-bucket.ts`; campaign grain + ad-set-term assist is the verification anchor | [Ad-grain join (#117)](https://github.com/noelrohi/creatives-tracker/issues/117) |

---

## 2. The creative tag taxonomy — enforce 4, capture 12

Locked in [the taxonomy decision (#115)](https://github.com/noelrohi/creatives-tracker/issues/115). *Supersession: the transcripts' "five tags" framing is dead — two sources yielded twelve candidate fields, resolved as enforce 4, capture 12.*

- **Enforced and sliced (4):** funnel stage, persona, angle, awareness. Required at ad creation in-app; AI-filled on synced ads (§6).
- **Captured, never enforced (8):** visual elements, visual style, light/dark/neutral/coloured mode, hook, supporting texts, CTA, promos, disclaimer. Recorded when known, not sliced in v1 — they feed Studio and the future resolution library. Storage in §3.
- **Angle = abstract types, one level. Closed list of 7:** problem-solution, social proof, comparison, transformation, skepticism, offer/promo, education (facts & stats). Studio's Reviv-specific messages ("creams don't work", "week-by-week timeline") are **re-kinded to `message`** — a captured dimension — so Studio keeps generating from the Reviv voice and no data is lost. All 7 existing Studio seed values map cleanly onto the abstract types.
- **Funnel stage = TOF / MOF / BOF.** *Supersession: the dead `funnelPositionEnum` (`cold_traffic_entry` / `retarget` / `upsell`) is attached to no table and is dropped/replaced.*
- **Placement:** funnel stage lives **on the ad** (new column — the same creative legitimately runs cold and retarget); persona, angle and awareness stay **on `ad_creative`**, where the columns already exist. Payoff: "authored for problem-aware, ran as BOF" is a detectable mismatch — exactly the diagnostic asked for.
- **Versioning:** the enforced vocabularies (7 angle types, 3 funnel stages, 5 awareness levels) are **versioned in code**, per the attribution-map precedent (#94). The org-specific `message` vocabulary stays in `studio_taxonomy_value` (org-scoped, archivable).

---

## 3. Storage for the eight captured attributes

Locked in [attributes storage (#123)](https://github.com/noelrohi/creatives-tracker/issues/123).

- **One `attributes` jsonb column on `ad_creative`** holds all eight. *Supersession: the existing `hook` and `cta` typed columns data-migrate into the blob and drop* (`UPDATE … SET attributes = jsonb_strip_nulls(attributes || jsonb_build_object('hook', hook, 'cta', cta))`, then rewrite reads to `attributes->>'hook'` etc.). One home per attribute; new attributes later are a code change, not a migration. GIN index deferred until something queries the blob.
- **Vocabularies:** `visualStyle` (realistic | cartoon | ugc-photo | 3d-render | …) and `mode` (light | dark | neutral | coloured) are closed and code-versioned, validated at the app layer on write. `visualElements` is an open tag array. `hook`, `supportingTexts`, `cta`, `promos`, `disclaimer` are free text.
- **The `visual_style` collision:** Studio's taxonomy kind is **renamed `visual_style` → `concept`** (its seeds — before/after, us vs them, testimonial — are ad concepts, not rendering styles). The captured attribute keeps the plain name `visualStyle`.
- **Provenance, light:** a parallel `attributesMeta` map marks each field `ai` | `human`; re-enrichment skips `human`-marked fields. No confidence scores — these fields are never sliced.
- **One Studio taxonomy migration** renames both kinds: `angle` → `message` (§2) and `visual_style` → `concept`, plus composer/picker label updates.

---

## 4. The ad-grain join

Locked in [the ad-grain join (#117)](https://github.com/noelrohi/creatives-tracker/issues/117), grounded in [the UTM audit (#116)](https://github.com/noelrohi/creatives-tracker/issues/116). *Supersession: the ticket's original assumption that the join is forward-only was wrong — the audit proved it backfillable from stored journey jsonb.*

### 4.1 Composition — same pass, new columns

The bucketing pass stamps two new columns on `shopify_order`: **`meta_ad_set_id`** and **`meta_ad_id`**, plus a **match-method** marker. `bucket`, `meta_verified`, `meta_campaign_id` semantics are **unchanged** — campaign grain (with the ad-set-term assist) remains the verification anchor; ad grain is a dimension, not a new anchor. **`BUCKET_RULE_VERSION` bumps 4 → 5**; the existing rebucket machinery re-stamps all history — that *is* the backfill, no separate job.

### 4.2 Parse rule — id first, then exact name scoped to the ad set

From `lastVisit.utmParameters`:

1. `utm_content` numeric (`^[0-9]{10,20}$` after the same trailing-junk normalization `normalizeMetaAdSetTerm` applies) → match `ads.metaId`. Method **`id`**.
2. Else `utm_content` as exact `ad.name` match **scoped to the ads of the `utm_term` ad set**. Method **`name`**.
3. `utm_term` → `meta_ad_set_id`, as already extracted for verification.

Expected historical coverage: ~90–96% of Meta orders at ad grain, ~97–99% at ad-set grain.

### 4.3 Unmatched — store raw, never drop

The extracted value is **always stamped** into `meta_ad_id`; the method column records `id` / `name` / **`unmatched`** (extracted but matching no synced ad — ~57 orders today). No ad-identifying UTM at all → nulls. Slices surface an explicit "unmatched ad" bucket. Because stamping rides the version bump, a later sync of a missing ad upgrades `unmatched` → `id` on the next re-stamp.

### 4.4 Template — lock the id form, enforce by detection

Canonical template: `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`. Old ads are **not** re-edited (URL edits can reset ad learning; the name-form share is already shrinking). Enforcement is **detection** — the template-drift finding in §8.

**Spec constant:** `UTM_TEMPLATE_LOCK_DATE = 2026-08-03` (this spec's assembly date; adjust to the merge date if materially later). Ads created after it are held to the id-form template; ads before it are legacy and silent by construction.

---

## 5. The landing-page entity

Locked in [landing pages (#118)](https://github.com/noelrohi/creatives-tracker/issues/118).

1. **Source — harvest both, no manual registry.** `landing_page` rows auto-create from `ads.destinationUrl` at Meta sync and from journey `lastVisit.landingPage` at bucketing (~110–150 rows). Provenance (ad-linked / journey-only / both) is queryable. No curation workflow.
2. **Identity — normalized URL, variants separate, derived family.** Identity = lowercased host + path, query/fragment/trailing-slash stripped, applied identically to both sources. Each `-vN` advertorial variant is **its own page** (v4 and v5 have different copy) with a derived **`family`** slug (base path sans `-vN`) for rollups. Ad→page and order→page links are deterministic FKs stamped from the normalized URL.
3. **Classification — AI suggests, human confirms.** A job fetches the page and classifies **pageType** (revived `pageTypeEnum`: product_page / advertorial / listicle / quiz / other), **funnel stage** (TOF/MOF/BOF — the same vocabulary §2 puts on ads), and **awareness fit** (`awarenessLevelEnum`) from page copy, stored `suggested` with confidence. Humans confirm or override; confirmed values are sticky. Diagnostics may fire on suggested values but must say so (§8). **The v1 confirmation surface is the mismatch-finding drawer itself (§9) — no separate admin screen.**
4. **Re-classification — content hash on a cadence.** Hash stored at classification; a periodic job re-fetches and compares. On change: re-suggest, and mark human-confirmed values **`stale`** for re-confirmation — a confirmation is never silently overwritten. New `-vN` slugs arrive as new pages, so most iteration is additive.

---

## 6. Tag enforcement and AI enrichment

Locked in [tag enforcement (#119)](https://github.com/noelrohi/creatives-tracker/issues/119). Framing fact: manual-first tagging is arithmetically dead at 0/3,925 — the workflow is built around that.

1. **Findings-led, plus one hard gate.** Synced ads are never blocked — they arrive untagged and are flagged. The pressure is a standing finding ("N active ads untagged, $X/wk spend" — §8) plus a **tagging queue** view. The only hard gate is where creation happens in-app: **Studio and manual creatives require the four enforced tags at save**.
2. **AI auto-fills with sticky overrides.** At Meta sync time, AI fills persona/angle/awareness from creative copy + imagery, and **funnel stage from ad-set targeting**, stored with **`ai` provenance and confidence**. Human edits are sticky, marked `human`. Low-confidence values render with a visible marker, never block. (*Deliberately different from the landing-page suggest-then-confirm: ~150 pages can be hand-confirmed, 2,111 creatives cannot.*) The **same enrichment pass** extracts the eight captured attributes (§3) — one model call, one job, the existing `enrichmentAttemptedAt` machinery. Studio pre-fills what it knows at creation (cta, promos, visualStyle from generation params).
3. **History: AI-backfill everything**, including paused/archived creatives. Whatever still lacks a tag is an explicit **"untagged" bucket in every slice** — never silently dropped. No manual retro-tag drive.
4. **Coverage thresholds:** the per-ad ad↔LP mismatch alert has **no gate** (fires when both sides of that ad are classified). **Aggregate** diagnostics require **≥80% of active Meta spend tagged**. The untagged-spend finding has no gate — it *is* the coverage alarm.

---

## 7. Per-ad funnel data — Meta-modeled now, pixel next

Locked in [on-site events research (#114)](https://github.com/noelrohi/creatives-tracker/issues/114). Full findings: [docs/research/onsite-funnel-events.md on `research/onsite-events`](https://github.com/noelrohi/creatives-tracker/blob/research/onsite-events/docs/research/onsite-funnel-events.md).

- **v1 source: Meta-modeled per-ad actions, already in `performance_log`.** Per-ad joinability is native and exact (`ad_id`, no UTM round-trip, no consent gate); aggregate retention is 37 months, so history is queryable today. The per-ad funnel view is **a query and a screen, not an ingest project**.
- **Caveat, surfaced in UI copy, not buried:** under Aggregated Event Measurement, iOS opt-outs report only the highest-priority event per window — with Purchase prioritized, `add_to_cart`/`initiate_checkout` are structurally under-reported. Therefore the funnel view compares ads **against each other via ratios** (LPV/click, ATC/LPV), never absolute conversion rates. Ratios are robust to an evenly-applied bias, and swapping in pixel data later *refines* rather than contradicts.
- **Two small fixes carried into the build:** (a) the `cost_per_*` columns are only populated by the CSV import path — populate them from the API path too (the payload is already fetched); (b) no attribution window is pinned anywhere in `src/`/`trigger/` — we silently inherit the ad account's Ads Manager setting; pin per the attribution-v1 spec's window params.
- **Shopify Web Pixel: the real first-party source, built second, started early.** Strictly forward-only (no backfill, ever — the argument for starting sooner than v1 needs it). Rides the custom-distribution app (#112); POSTs to our own domain with CORS (App Proxy endpoints are blocked in the pixel sandbox); consent-gated loading means over-declaring purposes silently costs coverage. **Its ingestion design is deliberately not specified here** — it stays on the map as fog; the v1 screens have no dependency on it.
- **GA4: rejected.** `(other)`-row bucketing (Data API, ~500 unique daily values) and silent row-thresholding destroy exactly the per-ad `utm_content` granularity needed — and realistic per-ad backfill is zero anyway.

---

## 8. Mismatch diagnostics v1

Locked in [diagnostics (#120)](https://github.com/noelrohi/creatives-tracker/issues/120). **Three new findings join the five from findings v1 — eight rules total**, all evaluated in the existing daily `attribution-checks` job (cron 19:30 UTC, after syncs; one pass, one all-clear). *Deferred out of v1: spend concentration by funnel stage — aggregate-gated anyway; returns as a v2 candidate.*

| # | Finding | Fires when | Drawer cites / links to |
|---|---|---|---|
| 6 | **Ad→LP funnel mismatch** (headline; per-ad, no coverage gate) | **Directional only** — a *colder* ad sends to a *hotter* page (TOF→MOF, TOF→BOF, MOF→BOF); warmer→colder is legitimate retargeting and stays silent. Ad spent **≥$100 trailing 7 days** (rolling — paused ads age out). Fires on AI-suggested page stages. | Ad name + stage (ai/human provenance), page URL + stage ("AI-classified, unconfirmed" marker where applicable), 7-day spend, deep-links to ad and page. Row: "You spent $X this week sending top-of-funnel traffic to a bottom-of-funnel page." |
| 7 | **Untagged spend** (the coverage alarm, ungated) | Untagged active ads carry **>20% of active Meta spend**, trailing 7 days — the exact complement of the ≥80% gate, so it clears the moment slices unlock. One number to remember. | Untagged share vs the 80% line, note that slice-level alerts are paused while firing, deep-link to the tagging queue. Row: "N active ads are untagged — $X/wk of spend is invisible." |
| 8 | **UTM template drift** (enforcement by detection, per §4.4) | An ad created **after `UTM_TEMPLATE_LOCK_DATE`** produces **3+ orders in one day** resolving via method `name` or `unmatched`. Legacy name-form ads silent by construction — no lock-date bookkeeping beyond the one constant. | Offending ad name(s), sample `utm_content` values with counts, match methods, deep-link to those orders. Row: "A new ad is sending non-standard UTMs — N orders yesterday." |

**Chassis — inherited from findings v1 unchanged:** three new `findingTypeEnum` values; frozen `payload` jsonb citing exact numbers at fire time; Mute (7 days, per type) / Mark resolved; thresholds fixed in code, tuned after real data; plain-English rows; explicit all-clear on a healthy day.

---

## 9. Screens — Creative insights

Locked in [the screens prototype (#121)](https://github.com/noelrohi/creatives-tracker/issues/121), settled over five grilling rounds against a live prototype. Direction, not spec-final pixels: build with shadcn/ui + existing attribution components and app tokens per the #97 conventions; the prototype's HTML is throwaway. Assets: [live prototype](https://claude.ai/code/artifact/cbcc4849-8e6b-4000-947b-fda2890ab832) · [source on `prototype/121-creative-insights-screens`](https://github.com/noelrohi/creatives-tracker/blob/prototype/121-creative-insights-screens/docs/prototypes/creative-insights-screens.html).

- **Where:** a new screen, **Creative insights**, beside Attribution under a new **Analyze** sidebar group (Dashboard and MER stay ungrouped above it). *"Intelligence" was rejected as a label.* Page title: *"What your ads said, and what it earned."*
- **Spine — answers on top, three bands:**
  1. **Insight cards** ("proof inside"): a plain-English claim + the mini-bars backing it, in the card — e.g. "Ads that name the problem brought back $4.90 per $1 — double anything else." Two to start; the warning-tinted coverage-alarm card prepends when the untagged gate trips.
  2. **The full picture:** one ledger card with slice chips — Angle / Persona / Awareness / Funnel stage — switching a single channel-ledger-style bar list (single-hue `--attr-known` ramp, exact figures at row end, back-per-$1 as sub-figure). **"No tags yet" is always a row** (`--attr-neutral`), never dropped. **Below 80% tagged spend, aggregate figures veil in place** — bars dimmed, money as "—", an inline note naming the exact ads that unlock them; the screen stays visible (§6 gate semantics). Selecting a slice row opens the drill-in card beneath ("Inside problem–solution").
  3. **Needs your attention:** the findings fold, standard chassis.
- **Mismatch drawer — side-by-side + settle:** two small cards face to face (ad: name, tags, spend/back/land · page: URL, suggested stage wearing an "our guess" pill), then an inline confirm block — *"Is /pages/bundle-offer written for people ready to buy?"* Yes / No — it's colder / Show me the page — whose answer **sticks as the page's confirmed stage** (§5's human-confirm loop). Untagged-spend and template-drift findings use the standard sentence chassis.
- **Per-ad funnel in v1 — ratio bars in the drill-in rows:** Ad · Spend · Back/$1 · a three-segment mini funnel (click → land → cart) from Meta-modelled ratios (§7), with a standing caption that these are modelled counts for comparing ads against each other. *"Revenue-only with a seam" was explicitly rejected — the ratios are already in `performance_log` for free.* No dependency on the Shopify pixel.

---

## 10. Build order

Dependencies, not dates — each step unblocks the next:

1. **Migrations** (§2, §3, §4, §5, §8): funnel-stage column on `ad`; `attributes` jsonb on `ad_creative` + hook/cta data-migration and drop; `landing_page` (+ ad/order FKs); `meta_ad_set_id` / `meta_ad_id` / match-method on `shopify_order`; three new `findingTypeEnum` values; the Studio taxonomy re-kind migration (`angle`→`message`, `visual_style`→`concept`). Drop the dead `funnelPositionEnum`; revive `pageTypeEnum`.
2. **Bucket rule v5** (§4): UTM ad extraction in the bucketing pass; version bump triggers the historical re-stamp — the backfill.
3. **Landing-page harvest + classification** (§5): auto-create from both sources; AI classification job with content hash.
4. **Enrichment pass extension** (§6, §3): four enforced tags + eight captured attributes in one call; funnel stage from ad-set targeting; backfill across all creatives. The `cost_per_*` API-path fix and window pinning (§7) ride along in the Meta sync.
5. **Diagnostics** (§8): three new rules in `attribution-checks`; set `UTM_TEMPLATE_LOCK_DATE`.
6. **Screens** (§9): Creative insights page + tagging queue + the three new drawers, wired to the above.
7. **Verify:** slice totals (including "No tags yet") sum to the Meta bucket's totals per day; ad-grain match rates land near the audit's 90–96%/97–99% figures; one mismatch finding fires end-to-end and its drawer confirm sticks on the page.

## 11. Out of scope for v1

Per the map: productization breadth (multi-store onboarding, Baby Planet, free-audit gating, self-serve connect — the Sept 1 track, its own map next); LP router + experiment loop (only LP *classification* is in scope); the resolution library (emergent, can't be ticketed); Klaviyo/Google/TikTok claim ingestion; the spend-concentration-by-stage alert (deferred to v2 by #120). **Deliberately left as fog on the map, not blocking this build:** the Shopify web-pixel ingestion design (§7).

## 12. Source tickets

- [Research: on-site funnel events — Shopify web pixel vs GA4 vs Meta-modeled (#114)](https://github.com/noelrohi/creatives-tracker/issues/114) · [research doc](https://github.com/noelrohi/creatives-tracker/blob/research/onsite-events/docs/research/onsite-funnel-events.md)
- [Decide: the creative tag taxonomy (#115)](https://github.com/noelrohi/creatives-tracker/issues/115)
- [Task: audit Reviv journey data for ad-grain UTM coverage (#116)](https://github.com/noelrohi/creatives-tracker/issues/116)
- [Decide: the ad-grain join — UTM convention, parse rule, and backfill (#117)](https://github.com/noelrohi/creatives-tracker/issues/117)
- [Decide: landing-page entity and funnel classification (#118)](https://github.com/noelrohi/creatives-tracker/issues/118)
- [Decide: tag enforcement workflow (#119)](https://github.com/noelrohi/creatives-tracker/issues/119)
- [Decide: mismatch diagnostics v1 — rules and thresholds (#120)](https://github.com/noelrohi/creatives-tracker/issues/120)
- [Prototype: Intelligence screens (#121)](https://github.com/noelrohi/creatives-tracker/issues/121) · [prototype source](https://github.com/noelrohi/creatives-tracker/blob/prototype/121-creative-insights-screens/docs/prototypes/creative-insights-screens.html)
- [Decide: storage for the eight captured creative attributes (#123)](https://github.com/noelrohi/creatives-tracker/issues/123)
