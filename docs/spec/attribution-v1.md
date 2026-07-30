# Attribution tool v1 — build-ready spec

The destination of the [Attribution tool v1 wayfinder map (#88)](https://github.com/noelrohi/creatives-tracker/issues/88): Shopify ingest → the checker → the screens, for the **Reviv** store, with **Shopify + Meta as the only claim sources**. Every decision below was locked in tickets [#89](https://github.com/noelrohi/creatives-tracker/issues/89)–[#97](https://github.com/noelrohi/creatives-tracker/issues/97); this document compiles them. Where an earlier ticket was superseded by a later one, the supersession is noted inline — nothing here re-litigates.

**The one invariant everything serves:** Shopify is the source of truth; **one order = one bucket; bucket totals must sum exactly to the Shopify actual; "no data", never "$0", when a sync breaks.**

---

## 1. Ground facts

| Fact | Value | Source |
|---|---|---|
| Store | Reviv, Shopify Plus, currency USD | [Access validation (#91)](https://github.com/noelrohi/creatives-tracker/issues/91) |
| Shop domain | `c598f3-79.myshopify.com` (`SHOPIFY_SHOP_DOMAIN` in `.env`) | #91 |
| Credential | Non-expiring Admin API token from a custom app created in the Reviv store admin (`SHOPIFY_ACCESS_TOKEN` in `.env`) | #91 |
| Store timezone | **`Asia/Bangkok`** (`ianaTimezone`, read from Shopify — never hardcoded). ⚠️ Supersedes the UX prototype's America/New_York assumption. | #91, [#93](https://github.com/noelrohi/creatives-tracker/issues/93) |
| Shopify API | Admin GraphQL **`2026-07`**, GraphQL only | [#89](https://github.com/noelrohi/creatives-tracker/issues/89), #91 |
| Scopes | `read_orders` + `read_all_orders` (granted automatically for admin custom apps — no approval wait); broad read set present but **customer PII is never queried** | #91 |
| Order history | Reachable back to at least 2024-09-05 (far beyond the 90-day backfill) | #91 |
| Rate limits | Plus tier: 20,000-point bucket, 1,000/s restore — a non-issue at ~1.2k orders/mo | #89, #91 |
| Meta Graph API | Bump `GRAPH_API_VERSION` **v22.0 → v25.0** in `src/lib/meta-insights-sync.ts` (v22 passed end-of-life 2026-06-09) | [#90](https://github.com/noelrohi/creatives-tracker/issues/90) |
| Real UTMs on orders | e.g. `facebook / paid / 120249250110870675` — `utm_campaign` carries the **numeric Meta campaign ID** | #91 |
| ROAS target | Per-org DB setting, default **1.5** | [#94](https://github.com/noelrohi/creatives-tracker/issues/94) |

**Auth supersession note:** the ingest research (#89) planned a custom-distribution app + OAuth authorization-code grant using `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`. The access validation (#91, later — wins) found the Dev Dashboard app is same-org-locked for client stores; Reviv runs on a **store-admin custom app token in `.env`** instead. The OAuth routes already in the repo (`src/app/api/shopify/install`, `src/app/api/shopify/callback`, `src/lib/shopify-oauth.ts`) stay as the productized path for future stores (e.g. Baby Planet), which need their own credential. Operational risk to note: the token is store-owned — the client can revoke it.

---

## 2. Shopify ingest

Pattern: mirror `trigger/meta-sync.ts` (Trigger.dev) — a backfill task plus an hourly incremental task, per [ingest research (#89)](https://github.com/noelrohi/creatives-tracker/issues/89) (full GraphQL queries and doc links: [docs/research/shopify-ingest.md on `research/shopify-ingest`](https://github.com/noelrohi/creatives-tracker/blob/research/shopify-ingest/docs/research/shopify-ingest.md)).

### 2.1 Backfill (90 days)

- **One Bulk Operation**: `bulkOperationRunQuery` over `orders(query: "created_at:>=<90d ago>")`, selecting the fields in §2.3. Runs async with no rate/cost limits; result is JSONL (nested connections flattened via `__parentId`). Poll `bulkOperation(id:)` (`currentBulkOperation` is deprecated) or use the `bulk_operations/finish` webhook.
- ~3.6k orders at Reviv volume. Write progress to `shopify_sync_run` — the first-sync screen (§8, state 5) reads it live.

### 2.2 Hourly incremental sync

- Paginated query on **`updated_at`** (not `created_at`), `sortKey: UPDATED_AT`, upsert by order id. `updated_at` is what surfaces refunds, edits, and cancellations on old orders — restatement falls out of re-upserting raw rows.
- **No webhooks in v1** — hourly polling is sufficient at this volume.
- **Journey re-poll:** `customerJourneySummary` is computed async — null/`ready: false` right after order creation, and eventually consistent for ~a day. The hourly job re-polls recent orders until `ready: true` before locking a bucket. Until then the order is **Pending** (§4).

### 2.3 Fields per order

- Identity/state: `id`, `createdAt`, `updatedAt`, `cancelledAt`, `cancelReason`, `test`, `taxesIncluded`, `displayFinancialStatus`, source markers to detect POS/draft/subscription orders.
- Money (read `shopMoney.amount` on all MoneyBags): `subtotalPriceSet`, `currentSubtotalPriceSet`, `currentTotalTaxSet`, and `refunds { id createdAt refundLineItems { subtotalSet totalTaxSet quantity restockType } }`.
- Attribution: `customerJourneySummary { ready, firstVisit, lastVisit, moments }` with each visit's `source`, `sourceType`, `referrerUrl`, `landingPage`, `utmParameters { source medium campaign content term }`, `occurredAt`. **Last-click = `lastVisit`.**
- **Never query** `customer`, `email`, `shippingAddress` (keeps us out of protected-customer-data Level 2 entirely).
- POS/draft/subscription-rebill orders have no visits → **Untracked** bucket, never "direct" (§4).
- `test: true` orders are **skipped at ingest**.

---

## 3. Meta sync changes

Everything the checker needs from Meta, per the [claim-data research (#90)](https://github.com/noelrohi/creatives-tracker/issues/90) ([docs/research/meta-claims.md on `research/meta-claims`](https://github.com/noelrohi/creatives-tracker/blob/research/meta-claims/docs/research/meta-claims.md)). Claimed purchase revenue and spend are **already synced** per ad per day in `performance_log`; the gap is labeling and decomposition:

1. **Version bump** (urgent, independent): `GRAPH_API_VERSION` `"v22.0"` → `"v25.0"` in `src/lib/meta-insights-sync.ts`.
2. **Request params** in `requestMetaInsightsReport`:
   - `action_attribution_windows: ["7d_click","1d_view"]` — each `actions`/`action_values` entry then carries a per-window key alongside `value`. The standard claim = `7d_click + 1d_view` (never add `1d_click` to `7d_click`; it's a subset). Explicit windows chosen over `use_unified_attribution_setting` so the claim is stable and labelable.
   - `action_report_time: "conversion"` — claims book on the **purchase day**, aligning with Shopify order dates for same-day claim-vs-verified comparison (decided in [#93](https://github.com/noelrohi/creatives-tracker/issues/93)). Documented trade-off: our numbers will not match Ads Manager's default impression-day view — **UI copy must say so** (§8).
3. **Mapper** (`src/lib/meta-api-mapper.ts`): read the per-window keys for `omni_purchase`.
4. **Migration**: add `purchase_value_7d_click`, `purchase_value_1d_view` (numeric; optionally per-window conversion counts) to `performance_log`; existing `purchase_value` stays as the combined claim. An `attribution_windows` text marker distinguishes labeled new rows from unlabeled historical ones.
5. **Import** (`src/lib/meta-import.ts`): carry the new columns through the upsert.
6. **Force re-sync** the comparison range to backfill per-window, conversion-time rows (aggregate data available 37 months back).
7. **Spend: nothing to add** — verified-ROAS lines are `SUM(spend)` over **base (non-breakdown) rows only** at the chosen grain.

---

## 4. The bucket rule — one order, one bucket

Locked in [the bucket rule (#92)](https://github.com/noelrohi/creatives-tracker/issues/92).

**Buckets (7):** Meta, Google, Klaviyo, TikTok, Organic/direct, Unattributed, Untracked — plus a transient **Pending** state that is not a bucket.

**Precedence: last-click.** The last visit before checkout decides. Rules evaluate in a fixed order so every order lands exactly once:

1. **Untracked** — order types that can never carry journey data: POS, draft, subscription-renewal.
2. **Pending** — `customerJourneySummary.ready: false` (or summary null): not bucketed yet; revenue excluded from bars; shown as a small "pending attribution" count. Never $0.
3. **Paid-UTM buckets** (on the last click's UTMs, case-insensitive):
   - **Meta**: `utm_source` ∈ {facebook, instagram, fb, ig, meta} AND paid-style `utm_medium` ∈ {paid, cpc, ppc, paid_social}. Within Meta, `utm_campaign` matching a **synced Meta campaign ID** → **Meta-verified** — only verified orders count toward verified ROAS. A campaign ID we haven't synced yet still lands in Meta, flagged **verification pending**, re-checked after the next successful Meta sync.
   - **Google / TikTok**: mirror the Meta gate — source variant (google/adwords; tiktok) + paid-style medium.
   - **Klaviyo**: `utm_source = klaviyo`, any medium (email has no paid gate).
4. **Organic/direct** — journey exists and the last click is direct, an organic referrer, or organic-medium traffic from a recognized source (including organic-medium Meta/Google/TikTok). *"We know it wasn't paid."*
5. **Unattributed** — journey missing where it should exist, or UTMs matching no rule. *"We can't tell."* Mistagged links deliberately surface here so they get noticed and fixed.

**Identity by construction:** Σ buckets + pending = Shopify actual; the exact-match check runs over resolved orders with the pending count shown alongside.

**Rule tables live as versioned constants in code** (`bucket_rule_version` bumps on deploy and triggers the re-bucket job — §6). *Supersession note: #92 suggested config-not-code; the data model decision ([#94](https://github.com/noelrohi/creatives-tracker/issues/94), later — wins) fixed them as versioned code constants.*

---

## 5. Revenue basis and the exact-match check

Locked in [revenue basis (#93)](https://github.com/noelrohi/creatives-tracker/issues/93).

1. **Revenue = Net sales**: item prices after discounts, minus refunds, excluding shipping and tax — Shopify Analytics' own metric. Arithmetic (per #89): sale = `subtotalPriceSet.shopMoney` booked on the order's day, minus `currentTotalTaxSet`-style adjustment **only when `taxesIncluded: true`**; refund = `Σ refundLineItems.subtotalSet` with the same tax adjustment (**not** `Refund.totalRefundedSet`, which includes tax + shipping).
2. **Day boundaries: the store's own timezone, read from Shopify** (Reviv = Asia/Bangkok). Never hardcoded; correct for future stores automatically.
3. **Messy orders — copy Shopify Analytics exactly:** test orders excluded; cancelled = sale on order day + refund on cancel day; partial refunds subtract only the refunded amount; exchanges = return + new sale.
4. **Refunds book on the refund day, in the original order's bucket.** Past days are immutable — a July 1 Meta order refunded July 20 shows as negative Meta revenue on July 20. *The prototype's "as recalculated at … net change" display is dropped;* days may show a refund marker instead.
5. **Official reference = the admin "Sales over time" report, Net sales column.** The "Check in Shopify" button deep-links there with the same date range pre-filled. Overview tiles and the Orders list are explicitly not the reference.
6. **Meta claims book on purchase day** (`action_report_time=conversion`, §3) so claimed-vs-actual is a same-day comparison.

**Net effect:** per store-timezone day, Σ bucket revenue (+ pending count) = admin Net sales, refunds included, by construction.

---

## 6. Data model and recompute strategy

Locked in [data model (#94)](https://github.com/noelrohi/creatives-tracker/issues/94). All under `src/schema/`, mirroring Meta conventions: org-keyed text ids, indexed `organization_id`. Migrations via `bun run db:generate` + `bun run db:migrate` (db:push is disabled by design).

| Table | Shape |
|---|---|
| `shopify_store` | The `ad_account` analogue: org-keyed; `shop_domain` (unique), access token, `iana_timezone` (synced from Shopify), currency, last-synced marker. A new store = one new row + credential. |
| `shopify_order` | org + `store_id` FK; Shopify order id (unique per store); UTC timestamps **plus stored `order_day`** (date, derived at ingest in store tz); net-sales amount per §5; raw `customer_journey` jsonb + parsed last-click `utm_source/medium/campaign`; `bucket` enum (`meta, google, klaviyo, tiktok, organic_direct, unattributed, untracked`; **null = pending**); `bucket_rule_version`; `meta_verified` + matched campaign id; journey-ready/pending-since fields; cancellation + POS/draft/subscription markers. |
| `shopify_refund` | org + store + `order_id` FK; Shopify refund id (unique); `refund_day` (store tz); amount = Σ `refundLineItems.subtotalSet`, tax-adjusted. **No bucket column** — joins through the order, so a re-bucket automatically moves past refunds too. |
| `shopify_sync_run` | Mirrors `account_sync_run`: org + store, date range, phase, result, rows synced, error. Sync-health (§7) and first-sync progress (§8) read it. |
| `performance_log` | Extended, not replaced: per-window purchase-value columns per §3. Claims stay **per-source** — no generic claims table; future sources add their own, read through a per-source adapter. |
| `org_settings` | App-owned per-org row (Better Auth owns `organization`): `roas_target` numeric, default 1.5. Mute state may extend here or live in a small table (§7.5). |
| `finding` | org + store keyed; `type`, `fired_at`, period, `payload` jsonb (cited numbers **frozen at fire time**), `resolved_at`. Plus `muted_until` per (org, finding type). |

**Recompute strategy in one line:** stamp on sync (bucket, `order_day`, rule version) → re-stamp by job when inputs change (rule bump, timezone change, journey arrival, campaign-ID match on Meta recovery) → **aggregate live on read** (daily totals are a live `GROUP BY` over raw rows — no rollups or materialized views, so the identity can't drift; milliseconds at Reviv volume).

**No restatement machinery** — refunds book on refund day (§5), past days immutable, nothing to snapshot.

**Must not preclude (later, not now):** more stores (every row hangs off `shopify_store` — multi-store is "insert a row"); more claim sources (bucket enum extensible, per-source claim tables).

---

## 7. Sync health — "no data", never "$0"

Locked in [sync-health semantics (#95)](https://github.com/noelrohi/creatives-tracker/issues/95).

1. **Stale rule: 2 missed cycles.** A connector is stale when time since its last *successful* run exceeds 2× its normal cycle — Shopify (hourly) warns after ~2h, Meta (daily) after ~2 days. Same rule for any future connector; one blip never warns. Detection reads `shopify_sync_run` / Meta sync-run last-success timestamps.
2. **Meta outage: buckets live, claims "no data".** Buckets are Shopify-derived, so bars keep updating. Meta's claimed column shows "no data" chips for missing days — never $0; verified ROAS reads "can't compute". Unmatched campaign IDs flag **verification pending** and re-check after recovery; missing claim days backfill themselves.
3. **Shopify outage: screen-wide banner + freeze.** "We lost the connection to Shopify at 8:00" — existing numbers stay visible ("correct up to HH:MM"), uncovered window shows "no data". Recovery backfills via the hourly `updated_at` sync.
4. **Freshness caption: one small line per screen** — "Shopify updated 12 min ago · Meta updated 3 hrs ago" — quiet when healthy, escalating into the warning state when the stale rule trips. No per-number timestamps.
5. **Outages never re-bucket orders.** *The prototype's fold-to-Unattributed rule is dissolved* — v1 UTM buckets don't depend on platform syncs.

---

## 8. Findings feed v1

Locked in [findings feed (#96)](https://github.com/noelrohi/creatives-tracker/issues/96). A **daily check job** (after syncs land) evaluates five fixed rules over data already in the model and writes `finding` rows. Healthy days get an explicit "all clear", never an empty list.

| # | Finding | Fires when | Drawer cites / links to |
|---|---|---|---|
| 1 | Meta over-claim | Meta claims > 2× Meta-verified revenue, 3 days in a row | Both numbers + gap per day → claimed-vs-verified view |
| 2 | Unattributed spike | Unattributed > 10% of the day's revenue AND > 2× its 28-day median share, 2 days in a row | Share vs baseline → Unattributed orders list |
| 3 | Broken UTM template | 5+ orders in one day with paid-looking UTMs matching no rule | Sample offending UTM strings + counts → unmatched-orders list |
| 4 | Sync failure | Exactly when §7's stale rule trips | Last success time, connector, error → sync-health surface |
| 5 | ROAS below target | Verified ROAS < org target (default 1.5), 7 days in a row | 7-day ROAS series vs target → Meta performance view |

- Every finding: **one-line row + expandable drawer**, citing exact frozen-at-fire-time numbers, deep-linking to evidence surfaces — **never to people**.
- **Three actions only:** Mute (7-day snooze per type) · Mark resolved (this firing; may re-fire) · Rerun sync (sync findings only). "Adjust threshold" was considered and **rejected** — thresholds stay fixed in code.
- **Out of v1:** ad-to-page mismatch (waits on the five-tag creative workflow, out of scope on the map).

---

## 9. Screens

Locked in [screens v1 (#97)](https://github.com/noelrohi/creatives-tracker/issues/97); the full screen spec with anatomy detail is [docs/research/screens-v1.md on `research/screens-v1`](https://github.com/noelrohi/creatives-tracker/blob/research/screens-v1/docs/research/screens-v1.md) — build to that document; this section is the summary contract.

- **Where:** `src/app/(protected)/attribution/page.tsx`; "Attribution" in the sidebar's **Analyze** group; icons from `@/components/icons` (Solar set — `lucide-react` is blocked by lint).
- **Desktop (≥1100px):** three columns — existing app sidebar · main content (max ~700px) · **findings rail** (360px, sticky, independently scrollable), scoped to the attribution route in v1.
- **Main content:** date-range kicker with store timezone → net-sales hero → date chips (Today · **Yesterday (default)** · Last 7 days · Last 28 days · Custom) → **the waterfall as navigation** (seven buckets, plain labels, click-through to bucket order lists) → adds-up line with "Check in Shopify →" deep link → pending line → the Meta check (claims vs confirmed, "back per $1" vs goal, plus the required "Meta's own reports count differently" footnote) → collapsed **"How we count"** glossary.
- **Findings rail ("Needs your attention"):** sync-stamped header sentence; **tap-to-open rows** (severity dot + plain headline + age; open = 2–4 sentence body with frozen numbers, evidence link, actions **Snooze 7 days / Mark handled / Try again now**); **all-clear receipt** when empty; the five **"Today's checks"** plain-named and pinned at the bottom (OK / Needs a look / Waiting for data); footer "Handled (n) · Snoozed (n)".
- **Plain-English voice everywhere — a hard copy rule.** No screen string may say ROAS, attribution, UTM, sync, verified, claims, unattributed, untracked, or stale. The translation table in the screens doc is the contract (e.g. "back per $1", "Source unknown", "No tracking info", "Came on their own", "link tags", "we lost the connection to Shopify at 8:00", "no data yet" — never $0).
- **Mobile (<760px):** rail hidden; sticky **status bar** under the header → **bottom sheet** (~78% height) with identical rail content; waterfall scrolls horizontally inside its container.
- **States that ship:** healthy · all-clear · Meta down · Shopify down (banner + freeze) · **first sync** ("Loading your last 90 days…" with waterfall segments filling from `shopify_sync_run` progress; no findings fire during backfill) — each working across every date-range chip.
- **Components:** shadcn/ui + Tailwind v4 + existing app tokens; none of the prototype's bespoke CSS. Chart/status palette ships as CSS custom properties in `globals.css` (values validated for contrast/CVD, listed in the screens doc). Main content = server component on the live GROUP BY; rail = client component on a tRPC findings router.

---

## 10. Build order (the week, per the team deck)

Dependencies, not dates — each step unblocks the next:

1. **Meta sync patch** (§3): version bump, window/report-time params, mapper, migration, force re-sync kicked off early (it runs in the background).
2. **Schema** (§6): all tables + migration.
3. **Shopify ingest** (§2): Trigger.dev backfill + hourly tasks, journey re-poll, bucket stamping (§4), refund rows.
4. **Checker queries** (§5, §6): live GROUP BY daily totals, identity check, claimed-vs-verified join.
5. **Findings job** (§8): daily evaluation + `finding` rows + mute state.
6. **Screens** (§9): attribution page + findings rail + mobile sheet, wired to the above.
7. **Verify the identity** against the admin "Sales over time" report for several store-timezone days, including one with a refund.

## 11. Out of scope for v1

Per the map: five-tag creative workflow + two-ad-set testing methodology; Klaviyo/Google/TikTok claim ingestion (buckets yes, claims no); alerts/exports/multi-store (September); prediction/modeling; auto-editing ads; the Baby Planet rollout (needs its own store credential when it comes).

## 12. Source tickets

- [Research: Shopify order ingest (#89)](https://github.com/noelrohi/creatives-tracker/issues/89) · [research doc](https://github.com/noelrohi/creatives-tracker/blob/research/shopify-ingest/docs/research/shopify-ingest.md)
- [Research: Meta claim data (#90)](https://github.com/noelrohi/creatives-tracker/issues/90) · [research doc](https://github.com/noelrohi/creatives-tracker/blob/research/meta-claims/docs/research/meta-claims.md)
- [Task: validate Reviv Shopify access (#91)](https://github.com/noelrohi/creatives-tracker/issues/91)
- [Decide: the bucket rule (#92)](https://github.com/noelrohi/creatives-tracker/issues/92)
- [Decide: revenue basis and the exact-match check (#93)](https://github.com/noelrohi/creatives-tracker/issues/93)
- [Decide: data model and recompute strategy (#94)](https://github.com/noelrohi/creatives-tracker/issues/94)
- [Decide: sync-health semantics (#95)](https://github.com/noelrohi/creatives-tracker/issues/95)
- [Decide: findings feed v1 (#96)](https://github.com/noelrohi/creatives-tracker/issues/96)
- [Prototype: screens v1 (#97)](https://github.com/noelrohi/creatives-tracker/issues/97) · [screen spec](https://github.com/noelrohi/creatives-tracker/blob/research/screens-v1/docs/research/screens-v1.md)
