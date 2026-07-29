# Research: Meta claim data — current sync vs what the checker needs

Issue: #90 (parent #88). Date: 2026-07-29.

## 1. Current state (what today's sync captures)

Code path: `trigger/meta-sync.ts` (orchestration only) → tRPC `metaSync` router
(`src/lib/trpc/routers/meta-sync.ts`) → `src/lib/meta-insights-sync.ts` (Graph API calls)
→ `src/lib/meta-api-mapper.ts` (row mapping) → `src/lib/meta-import.ts` →
`src/schema/performance-log.ts`.

- **API version:** `v22.0`, hardcoded in `src/lib/meta-insights-sync.ts`
  (`GRAPH_API_VERSION = "v22.0"`). **This version expired**: Meta sunset everything
  below v24.0 on June 9, 2026; latest is v25.0 (released Feb 18, 2026). Calls to an
  expired version are served by the oldest live version, so the sync still works only
  by grace of Meta's auto-upgrade behavior.
- **Granularity:** ad level only (`level: "ad"` hardcoded in `startReport`,
  `src/lib/trpc/routers/meta-sync.ts:241`). Campaign/adset names+ids ride along on each
  ad row; there is no campaign- or account-level insights pull. Rollups must be
  aggregated from ad rows.
- **Time grain:** daily (`time_increment: "1"`), async report jobs per account, base run
  plus 4 breakdown runs (`age`, `gender`, `country`, `device_platform`). Rows upsert into
  `performance_log` keyed on (ad, date_start, date_end, breakdown columns).
- **Claimed revenue: already synced.** `INSIGHT_FIELDS` requests `actions`,
  `action_values`, `cost_per_action_type`; the mapper takes
  `action_values → omni_purchase` (fallback `purchase`) into
  `performance_log.purchase_value` (numeric), and `actions → omni_purchase` into
  `conversions`, per ad per day. ROAS is precomputed at import (`purchaseValue/spend`).
- **Attribution windows: implicit, unlabeled, not split.** No
  `action_attribution_windows`, no `use_unified_attribution_setting`, no
  `action_report_time` are sent. The mapper reads only the aggregate `value` key of each
  action entry. Per Meta's docs the parameter default is `default`, which expands to
  `["7d_click","1d_view"]` — so stored `purchase_value` is *effectively* the
  7d-click + 1d-view combined claim, but the window is not recorded, cannot be split,
  and (because `use_unified_attribution_setting` is off) can diverge from Ads Manager
  when an ad set uses a non-default attribution setting.
- **Spend: yes, at the granularity needed.** `spend` per ad per day in the base rows
  (also on breakdown rows — checkers must use base rows only, or breakdown rows only,
  never both, to avoid double counting). Campaign/day and account/day spend for
  verified-ROAS lines are a `SUM(spend) GROUP BY` away.

## 2. Meta Marketing API side (v25.0, July 2026)

- **Per-window claimed revenue** comes from the same `/act_<id>/insights` call: pass
  `action_attribution_windows=["7d_click","1d_view"]` (optionally `1d_click`, `1d_ev`).
  Each `AdsActionStats` entry in `actions` / `action_values` then carries one key per
  requested window (e.g. `"7d_click": "812.44", "1d_view": "95.10"`) alongside `value`.
  One query returns all windows — no separate calls needed, and windows are additive
  for the standard claim: **claim = 7d_click + 1d_view** (note `7d_click` already
  includes `1d_click`, so never add `1d_click` to `7d_click`). This directly supports
  the prototype's "7d click / 1d view" caption, per window.
- **Allowed values (v25.0):** `1d_view, 1d_click, 7d_click, 28d_click, 1d_ev, dda,
  default`, plus SKAN variants. Default = `default` = `["7d_click","1d_view"]`.
- **Deprecations:** `7d_view` and `28d_view` were removed across all API versions on
  **January 12, 2026** (requests return empty data). The local code never used them, so
  no breakage — but any plan assuming view windows beyond 1 day is off the table. Same
  date introduced retention limits: 13 months for unique-count fields and hourly
  breakdowns, 6 months for frequency breakdowns; aggregate totals stay at 37 months
  (backfills for the checker are fine).
- **Ads Manager parity:** `use_unified_attribution_setting=true` makes results follow
  each ad set's attribution setting (and ignores `use_account_attribution_setting`).
  For the checker, explicit `action_attribution_windows` is the better choice: the
  claim is stable and labelable regardless of per-adset settings.
- **Timing alignment (matters for daily claim-vs-verified):** `action_report_time`
  (values `impression, conversion, mixed, lifetime`) controls which day a purchase is
  reported on. Left unset, a purchase converts on Jan 2 from a Jan 1 impression and is
  booked on Jan 1 — while the matching Shopify order is dated Jan 2. Pin
  `action_report_time=conversion` so claimed revenue lands on order date, or compare
  over multi-day windows rather than single days.

Docs:
- https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/
  (parameters: `action_attribution_windows` enum + default, `use_unified_attribution_setting`,
  `action_report_time`, `time_increment`, `level`)
- https://developers.facebook.com/docs/marketing-api/insights/ (overview)
- https://developers.facebook.com/docs/graph-api/changelog/ (version lifetimes)
- https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/
  (Jan 12, 2026 window removals + retention limits)
- https://www.kitchn.io/blog/meta-marketing-api-q2-2026-update (v23 EOL June 9, 2026;
  v24 oldest supported; v25.0 latest)

## 3. Gap list (what the checker needs added)

1. **Version bump (urgent, independent of the checker):** `GRAPH_API_VERSION`
   `"v22.0"` → `"v25.0"` in `src/lib/meta-insights-sync.ts`. v22 has been past
   end-of-life since June 9, 2026.
2. **Request params** in `requestMetaInsightsReport`:
   - `action_attribution_windows: JSON.stringify(["7d_click","1d_view"])`
   - `action_report_time: "conversion"` (decide once; document the choice — it changes
     which day claims land on and affects comparability with already-synced rows)
3. **Mapper** (`src/lib/meta-api-mapper.ts`): extend `MetaAction` with optional
   `"7d_click"` / `"1d_view"` string keys; extract per-window purchase value and count
   for `omni_purchase` in addition to the aggregate `value`.
4. **Schema migration** (`src/schema/performance-log.ts` + `bun run db:generate` /
   `db:migrate`): add `purchase_value_7d_click`, `purchase_value_1d_view` (numeric) and
   optionally `conversions_7d_click`, `conversions_1d_view` (integer). Existing
   `purchase_value` stays as the combined claim. A small `attribution_windows` text
   marker (e.g. `"7d_click,1d_view"`) on the row makes historical rows (unlabeled) vs
   new rows distinguishable.
5. **Import** (`src/lib/meta-import.ts`): carry the new columns through the upsert.
6. **Backfill:** historical `performance_log` rows have only the combined value; after
   the params ship, re-run the sync with `force` over the comparison range to populate
   per-window columns (aggregate data is retrievable 37 months back).
7. **Nothing needed for spend:** ad × day spend is already synced; verified-ROAS lines
   are `verified_shopify_revenue / SUM(spend)` grouped at whatever grain the checker
   plots. Use base (non-breakdown) rows only.
8. **No new query shape needed:** same async ad-level daily report; windows arrive as
   extra keys, so report size and job count are unchanged.

## 4. Bottom line

The claim number itself is already in the database (`performance_log.purchase_value`,
per ad per day, effectively 7d-click+1d-view), and spend is already at the right
granularity. What's missing is the *labeling and decomposition* of the claim: two
request params, two mapper lines, two numeric columns (one migration), plus an overdue
API version bump. Windows come back in the same query as separate keys, so the checker
can render "Meta claims $X (7d click / 1d view)" with an exact per-window split.
