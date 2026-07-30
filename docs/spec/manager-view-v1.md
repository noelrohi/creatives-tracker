# Manager view v1 — build-ready spec

A new sidebar page that opens on campaigns and expands in place: campaign → ad set → ad, one collapsible ledger with a filter bar. Raw Meta entities — one row per Meta ad ID under its real ad set — deliberately bypassing the name-based consolidation the creatives table uses. Assembled from wayfinder map [#100](https://github.com/noelrohi/creatives-tracker/issues/100); source tickets in §12.

## 1. Ground facts

- All three hierarchy tables carry a globally-unique, nullable `metaId`: `src/schema/campaign.ts:19`, `src/schema/ad-set.ts:28`, `src/schema/ad.ts:27`. The FK chain campaign ← ad set ← ad exists (`ads.adSetId` nullable).
- `performance_log` (`src/schema/performance-log.ts`) has **no Meta ad id** — only the `adId` FK. Rows are daily (`time_increment: "1"`, `src/lib/meta-insights-sync.ts:223`); the unique key `performance_log_ad_date_breakdown_uniq` on `(ad_id, date_start, date_end, country, platform, placement, device, age, gender)` `.nullsNotDistinct()` guarantees exactly one **base row** (all breakdown columns NULL) per ad per day. Index to lean on: `performance_log_org_ad_date_idx` on `(organization_id, ad_id, date_start, date_end)`.
- Data verified clean on 2026-07-30 (local Docker + prod Neon): 0 of 3,786 prod ads lack a `meta_id`, 0 lack an ad set, 0 campaigns/ad sets lack `meta_id`s, and all 2,497 same-name sibling ads carry their own performance rows. **No forced re-sync; history stands as-is** (decision on [#102](https://github.com/noelrohi/creatives-tracker/issues/102)).
- Rollups need **no new tables**: ad-set and campaign metrics are SUMs of daily base rows up the FK chain, ratios derived from the sums.

## 2. Data layer changes (prerequisite, ships first)

From [#101](https://github.com/noelrohi/creatives-tracker/issues/101)/[#102](https://github.com/noelrohi/creatives-tracker/issues/102) — both views read **one shared per-ad performance store**; the creatives table becomes a display-time grouping over the same rows, so the two views cannot diverge or double-count by construction.

1. **Migration**: add `meta_ad_id text` (nullable, indexed) to `performance_log`; populate it in the staging pipeline for every API-synced row. Generate with `bun run db:generate`, apply with `bun run db:migrate` (db:push is disabled).
2. **Kill the name fallback when an ID is present**: in `src/lib/meta-import.ts`, `buildPerformanceLogRows` (`:401-404`) and `resolveAdsForRows` (`:481-524`) must never fall back to `adIdByName` when `row.adId` exists — match by `metaId` or create the ad. Name matching survives only for id-less CSV rows, scoped by account.
3. **Adopt, don't duplicate**: the first ID-bearing sync must adopt an existing legacy NULL-`metaId` row (set its `metaId`) instead of creating a duplicate next to it (`src/lib/meta-import.ts:902`, `:1020`, `:1140-1145`); fix the post-upsert re-query to select by `metaId` as well as name (`:1300-1312`).
4. **No historical re-sync.** Accepted residual risk (small, verified): a name-first row later claimed by a same-named Meta ad via `meta-import.ts:1267` is invisible after the fact.

## 3. Route, navigation, naming

*Assembly-time decisions — flagged for sign-off, see §11.*

- **Route:** `src/app/(protected)/campaigns/page.tsx` → `/campaigns`.
- **Sidebar:** new entry in `navItems` (`src/components/app-sidebar.tsx:53-64`), group "Manage", after Creatives: `{ label: "Campaigns", href: "/campaigns", icon: "solar:layers-minimalistic-linear" }`. Not privileged — visible to all members, same as Creatives. ("Campaigns" over "Manager": the page lists campaigns, sibling labels are plural content nouns, and "Manager" under the group label "Manage" reads badly.)
- **tRPC router:** `manager` in `src/lib/trpc/routers/manager.ts`, composed in `_app.ts` (precedent for route ≠ router name: `/creatives` is served by `adCreative`).

## 4. API — one aggregate procedure per level

From [#107](https://github.com/noelrohi/creatives-tracker/issues/107). Three read procedures (`orgProcedure`), each one aggregate query. Dates are `yyyy-MM-dd` strings per the existing convention.

```
manager.campaigns({ from, to, accountId?, status?, search? })
manager.adSets({ campaignId, from, to, status?, search? })
manager.ads({ adSetId, from, to, status?, search? })
```

- **Aggregation:** LEFT JOIN the level's entities down to `performance_log` **base rows only** (all breakdown columns NULL), constrained to the date range and org, GROUP BY the level's id. Lean on `performance_log_org_ad_date_idx`. LEFT JOIN is load-bearing: the date range zeroes metrics but must never hide a row (§6).
- **Filter pushdown:** `status` and `search` prune server-side. A parent row is returned iff it matches `search` itself (then its whole subtree counts, unpruned) or has at least one matching descendant; its rollup sums **the filtered descendant set only**, so children always sum to their parent. `manager.campaigns` returns per-campaign `hasMatches` when `search` is active so the client knows which branches to auto-expand.
- **Returned row shape (all levels):** `{ id, metaId, name, status, spend, roas, cpa, ctr, conversions, hasChildren }` (+ `accountName` on campaign rows). No effective-status field — the client derives "ancestor paused" from parent rows it already holds (§8).
- **Budgets:** ≤1s p95 end-to-end initial load (≈300ms query budget), ≤500ms p95 per expand. Breaching (expected ~10× current volume) forces pre-aggregated daily rollup tables — explicitly out of v1.
- **Caching:** client-side only, tRPC/React Query, `staleTime` ~3 minutes. The cache key is the procedure input — (org, range, parent, status, search). **Sort is not in the key**: sorting is client-side (§7), so header clicks re-rank instantly without refetch. No server cache; safe because perf data changes only on the periodic Meta sync.

Metric formulas, identical at every level (parents over filtered descendants, ads over their own rows):

| Column | Formula | Format (reuse `creative-list-columns.tsx` conventions) |
|---|---|---|
| Spend | `SUM(spend)` | `$`, 0dp ≥100 else 2dp, tabular-nums |
| ROAS | `SUM(purchase_value) / NULLIF(SUM(spend), 0)` | 2dp + `x` |
| CPA | `SUM(spend) / NULLIF(SUM(conversions), 0)` | `$`, 100-threshold rule |
| CTR | `SUM(ctr × impressions) / NULLIF(SUM(impressions), 0)` | 2dp + `%` |
| Conv | `SUM(conversions)` | integer |

Null → em-dash. CTR is **impression-weighted** (the `ad-creative.ts:768` variant). The creatives table's plain `AVG(ctr)` (`ad-creative.ts:745`) is a known inconsistency — do not copy it; averaging ratios is wrong for rollups.

## 5. UI — the ledger

From [#103](https://github.com/noelrohi/creatives-tracker/issues/103): direction locked over three grilling rounds as **Ledger → Level Chips → Heat Cells**. Living prototype (winner is the default view): https://claude.ai/code/artifact/cb2a3252-5cf7-41f0-a95d-c955d62f98c9

- **Ledger:** one dense table, 28–30px rows, monospace tabular numbers, expanding in place. *(The R1 note "campaigns open by default" is superseded by [#107](https://github.com/noelrohi/creatives-tracker/issues/107)'s lazy-load decision: initial view is campaign rows, collapsed.)*
- **Hierarchy encoding:** CMP/SET/AD chips before the name plus a colored inset edge stripe per level (accent for campaigns, neutral for ad sets), **zero indentation** — names keep full width. Chevrons on expandable rows.
- **Metric cells:** no bars. ROAS gets a soft background tint — green ≥1.5x, red <1.0x, neutral between. ON/OFF status tags as a column.
- **Row columns, in order:** chevron · level chip + name · status tag (+ dimmed ancestor annotation, §8) · Spend · ROAS · CPA · CTR · Conv · hover actions (ads only).
- **Filter bar** above the table, bordered controls: `DateRangePicker` (`src/components/blocks/dashboard/date-range-picker.tsx`) · account select · status select · name search. URL state via nuqs `from`/`to` (+ `account`, `status`, `q`) following `use-creative-filters.ts`; default range **last 7 days** (`subDays(today, 6)` → today), matching the creatives table.

## 6. Tree behavior: lazy loading + filter semantics

Loading from [#107](https://github.com/noelrohi/creatives-tracker/issues/107), filter semantics from [#104](https://github.com/noelrohi/creatives-tracker/issues/104).

- **Lazy-load on expand.** Initial load fetches campaign rows only; expanding a row fires that parent's children query. No full-tree preload, no virtualization (both explicitly rejected).
- **Pruned tree, never a flat list.** Status filter and search hide non-matching branches; matched rows stay nested under their real ancestors.
- **Rollups sum filtered children only.** The table is always internally consistent — visible children sum to their parent. No "of X total" annotations in v1.
- **Date range zeroes, never hides.** Every synced entity stays in the tree across any range, metrics zeroed when it had no activity — even an ad created after the range ended. The date picker changes numbers only, never tree structure. Consequently a row can be hidden only by status/search, never by the date picker.
- **Search auto-expands, then restores.** Typing a search auto-expands every campaign/ad set on the path to a match (client expands campaigns with `hasMatches`, firing their children queries with the same `search` param). Clearing the search restores the pre-search expand/collapse state from a client-side snapshot of expanded ids taken when the search began.

## 7. Sorting

From [#108](https://github.com/noelrohi/creatives-tracker/issues/108).

- **Hierarchical, never flattens:** clicking a column header sorts campaigns by their rolled-up value; ad sets rank within their campaign; ads within their ad set. (Ranked flat ad lists remain the creatives table's job.)
- **Default: Spend descending**, applied hierarchically over the selected range.
- **One rule for the whole tree** — a single (column, direction) at every level; no per-level or per-parent sort state in v1.
- **Persists across everything:** expand/collapse never reorders; filter and range changes keep the chosen sort while re-ranking as values change. Only a header click changes it.
- Implementation: client-side comparator over each sibling group (rows are fully fetched per parent), keeping sort out of the query cache key.

## 8. Actions — pause + rename, ads only

From [#105](https://github.com/noelrohi/creatives-tracker/issues/105). Campaign and ad set rows are read-only rollups; no new Meta write calls in v1 (ad-set pause is a fast-follow candidate).

- **Pause/play:** direct hover icon at the right end of ad rows → confirm dialog → `ad.pauseMetaAds({ adIds: [id] })` (`src/lib/trpc/routers/ad.ts:524`). Reuse the confirm-dialog + result handling from `creative-ads-tab.tsx:131-156, :375-410`, including its privilege gating pattern (`canPauseMetaAds`).
- **Rename:** hover kebab on the ad row → "Rename" → dialog (full-width input, explicit confirm, pending/error states) → `ad.renameMetaAd({ adId, name })` (`ad.ts:634`). Reuse the flow at `creative-ads-tab.tsx:158-176`. No inline edit-in-place. Kebab separation keeps the rarer, riskier action out of mis-click range of pause.
- **After either mutation:** update `ads.status`/`ads.name` optimistically or invalidate the affected `manager.ads` query (and the parent rollup queries — a pause doesn't change metrics, but status filters may re-prune).
- **Own status + parent provenance:** child rows always show their *own* Active/Paused state and the toggle always operates on the child. When an ancestor is paused, the child row dims and shows a muted annotation — "ad set off" / "campaign off" — derived client-side from ancestor rows already in the tree, mirroring Meta's delivery column. An "Active" ad under a paused ad set must never read as delivering.

## 9. Loading, empty, and error states

*Assembly-time decisions — flagged for sign-off, see §11.*

- **Initial load:** ~8 skeleton rows at ledger row height under the (immediately interactive) filter bar.
- **Expand:** one inline skeleton child row under the parent while its children query runs (budget ≤500ms p95, so it stays brief).
- **No campaigns at all** (no Meta account connected or never synced): centered empty state; privileged users (owner/admin per `isPrivilegedOrgRole`) get a "Connect an account" link to `/accounts`, others see "Ask an admin to connect a Meta account."
- **Filters match nothing:** single full-width row — "No results match your filters" — with a clear-filters button. Only status/search can cause this; the date range never empties the tree (§6).
- **Query error:** inline error row with a Retry button (React Query refetch), per level.

## 10. Build order

1. **Data layer** (§2): migration + `meta-import.ts` fallback/adoption changes. Independent of the UI; ships first. Covered by Vitest tests around `resolveAdsForRows`/`buildPerformanceLogRows`.
2. **`manager` router** (§4): three procedures + rollup/filter-pushdown tests.
3. **Route shell** (§3, §5): page, sidebar entry, filter bar with nuqs wiring.
4. **Ledger table** (§5, §6): chips, heat cells, expansion with lazy children queries.
5. **Filter/search semantics** (§6): pruning, auto-expand, expand-state restore.
6. **Sorting** (§7).
7. **Actions** (§8): pause/rename reuse.
8. **States** (§9): skeletons, empty, error polish.

## 11. Assembly-time decisions (confirm at sign-off)

Resolved while assembling — everything else in this spec traces to a closed ticket. Veto here, not mid-build:

1. Route `/campaigns`, sidebar label **"Campaigns"**, icon `solar:layers-minimalistic-linear`; router key `manager` (§3).
2. Empty/loading/error states as specified in §9.
3. CTR rollup uses the **impression-weighted** formula, diverging from the creatives table's plain average (§4).
4. "Campaigns open by default" from prototype round 1 is superseded by lazy loading: initial view is collapsed campaign rows (§5).
5. Cache keys extend #107's (org, range, level, parent) with (status, search), since rollups depend on them; sort stays client-side and out of the key (§4, §7).

## 12. Out of scope for v1

- Budget editing, campaign/ad-set creation, any Meta write beyond existing pause + rename (ad-set pause: fast-follow candidate).
- Replacing or retiring the creatives table.
- Non-Meta channels.
- Full-tree preload, virtualization, server-side caching, pre-aggregated rollup tables (revisit at ~10× data volume or budget breach).
- Historical perf re-sync (decided against on #102).

## 13. Source tickets

- [#100 Manager view v1 — wayfinder map](https://github.com/noelrohi/creatives-tracker/issues/100)
- [#101 Research: data readiness](https://github.com/noelrohi/creatives-tracker/issues/101) — full write-up: [`research/manager-view-data-readiness.md`](https://github.com/noelrohi/creatives-tracker/blob/research/manager-view-data-readiness/research/manager-view-data-readiness.md)
- [#102 Decide: raw Meta rows alongside name-consolidated creatives](https://github.com/noelrohi/creatives-tracker/issues/102)
- [#103 Prototype: collapsible tree with filter bar](https://github.com/noelrohi/creatives-tracker/issues/103)
- [#104 Decide: filter semantics on a tree](https://github.com/noelrohi/creatives-tracker/issues/104)
- [#105 Decide: pause + rename placement](https://github.com/noelrohi/creatives-tracker/issues/105)
- [#107 Decide: tree loading strategy](https://github.com/noelrohi/creatives-tracker/issues/107)
- [#108 Decide: sorting semantics](https://github.com/noelrohi/creatives-tracker/issues/108)
