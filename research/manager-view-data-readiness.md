# Research: data readiness — can the DB serve raw per-Meta-ad rows?

Resolves #101 (parent map: #100). Read-only audit of the schema (`src/schema/campaign.ts`, `ad-set.ts`, `ad.ts`, `performance-log.ts`) and the Meta sync path (`trigger/meta-sync.ts`, `src/lib/trpc/routers/meta-sync.ts`, `src/lib/meta-import.ts`, `src/lib/meta-api-mapper.ts`, `src/lib/meta-insights-sync.ts`).

## TL;DR

- **(a)** The hierarchy columns exist and are unique at every level, but they are all nullable and only reliably populated for API-synced data. `ads.adSetId` is nullable, so orphan ads are possible.
- **(b)** API-synced rows for metaId-bearing ads are trustworthy going forward, but historical per-ad numbers are **not recoverable from the DB as-is**: `performance_log` stores no Meta ad id, so rows merged or misattributed by the name fallback cannot be re-split. Recovery requires a forced re-sync from Meta, not a DB migration.
- **(c)** Four small changes make raw per-ad rows + date-ranged rollups servable: store `meta_ad_id` on `performance_log`, remove the name fallback when a Meta ad id is present, fix the name-only re-query after ad upsert, and run a forced historical backfill. Rollups then need no new tables — they are SUMs over base (non-breakdown) rows joined up the FK chain.

---

## (a) Is the campaign → ad set → ad hierarchy fully stored with Meta IDs?

**Columns present and unique — yes, at every level:**

| Level | Column | Evidence | Constraint |
|---|---|---|---|
| campaign | `campaigns.metaId` | `src/schema/campaign.ts:19` | `.unique()`, nullable |
| ad set | `adSets.metaId` | `src/schema/ad-set.ts:28` | `.unique()`, nullable |
| ad | `ads.metaId` | `src/schema/ad.ts:27` | `.unique()`, nullable |

**FK chain present:**
- `adSets.campaignId` is `NOT NULL` → `campaigns.id` (`src/schema/ad-set.ts:14-16`).
- `ads.adSetId` is **nullable** → `adSets.id`, `onDelete: "set null"` (`src/schema/ad.ts:15-17`). Ads can exist with no ad set.
- `performanceLogs.adId` is `NOT NULL` → `ads.id` (`src/schema/performance-log.ts:20-22`). **No Meta id and no ad-set/campaign id is stored on the perf row** — attribution flows solely through the mutable `ads.adSetId` pointer.

**Populated — only for API-synced data:**
- The Meta insights request always includes `campaign_id`, `adset_id`, `ad_id` (`src/lib/meta-insights-sync.ts:14-20`), mapped through `src/lib/meta-api-mapper.ts:87-91`, so the API sync path (`src/lib/trpc/routers/meta-sync.ts:454-476` → `importMetaRows`/`importMetaBreakdownRows`) always carries all three IDs.
- The importer keys campaigns/ad sets/ads by metaId when present (`src/lib/meta-import.ts:835`, `:953`, `:1080`) and backfills `metaId` onto name-matched rows on update (`:913`, `:1034`, `:1267`).
- But rows created by CSV/manual import before IDs were available have `metaId = NULL`, and nothing guarantees `ads.adSetId` is set (it is only written when the batch row carried an ad set: `:1094`, `:1266`).

**Uniqueness caveats:**
- All three `metaId` uniques are **global**, not org-scoped, while every matching query is org-scoped (e.g. `src/lib/meta-import.ts:865-867`, `:980-982`, `:1108-1111`). Two orgs syncing the same shared Meta account would collide on insert.
- A legacy name-keyed row (NULL metaId) is *not* adopted when the API brings the same entity with its real id: at `:902-903` (campaign), `:1020-1021` (ad set), and `:1140-1145` (ad), the name lookup map is only populated for batch entries *without* a metaId (`:874-876`, `:989-991`, `:1118-1122`). So the first API sync **creates a duplicate row** next to the legacy one, splitting one logical entity's history across two DB rows.

**Verdict:** structurally yes (columns + uniques + FK chain all exist); operationally only API-synced entities are fully ID-keyed, and legacy/duplicate rows break the "one row per Meta id" invariant.

## (b) Are per-Meta-ad performance rows recoverable as-is?

**Going forward (API sync, metaId matched): trustworthy.** `buildPerformanceLogRows` prefers the metaId map (`src/lib/meta-import.ts:402`), the API always supplies `ad_id`, and the staging replace is idempotent per `(org, ad_id, date range, breakdown)` (`:282-295`; unique constraint `src/schema/performance-log.ts:79-91`).

**Historically: no — three corruption paths, none reversible from the DB:**

1. **Name-fallback misattribution** (`src/lib/meta-import.ts:401-404` and `resolveAdsForRows` `:481-524`): any row whose `ad_id` isn't already in the metaId map falls back to `adIdByName.get(row.name)`, and that name map is built **org-wide with no account/campaign scoping** (`:508-518`, `:1300-1310`) and is a `Map` keyed by name, so with duplicate names the *last row wins arbitrarily* (`:522`, `:1311`). A duplicated ad's metrics land on whichever same-named ad the map happened to keep — possibly in a different campaign or account.
2. **Name-keyed merge of distinct Meta ads**: `adInfoMap` keys by `row.adId || row.name` (`:1080`), so CSV rows for two different Meta ads with the same name collapse into one `ad` row. Their perf rows then share the same `(ad_id, date, breakdown)` key, and the delete-then-insert replace (`:282-295`) makes the later import **silently overwrite** the earlier ad's numbers for the same day.
3. **History split across duplicate rows**: per (a), the first ID-bearing sync creates a new ad row instead of adopting the legacy name-keyed one, so "one row per Meta ad ID" holds for the new row but its pre-sync history lives on the orphaned duplicate. Worse, the post-upsert re-query that rebuilds both lookup maps selects **by name only** (`:1300-1310`), so even `adIdByMetaId` (`:1312`) is derived from a name-scoped result set.
4. **Breakdown-import ordering hazard**: base runs before breakdowns in `trigger/meta-sync.ts:12-18`/`:425`, but if base is skipped as "fresh" (`:433-449`) while ads are missing, `importMetaBreakdownRows` (`src/lib/meta-import.ts:764`) never creates ads and resolves purely by org-wide name (`:481`).

**Why it's unrecoverable in place:** `performance_log` has no `meta_ad_id` column (`src/schema/performance-log.ts` — the source `ad_id` is discarded at `src/lib/meta-import.ts:409/:418`), so a merged or misattributed row carries no evidence of which Meta ad produced it. The only recovery path is re-fetching from Meta (insights are retained ~37 months) after the fallback is fixed — the idempotent replace key then heals overlapping windows, though rows previously written to a *wrong* ad id are not deleted by a re-sync (the delete keys on the *new* ad id) and would need a one-time cleanup of the affected window.

**Verdict:** per-Meta-ad rows are servable only for the ID-matched slice; historical numbers touched by name fallback are merged/overwritten and cannot be trusted or reconstructed from the DB alone.

## (c) Minimal schema/sync changes for raw per-ad rows + date-ranged rollups

**Schema (one migration):**
1. Add `meta_ad_id text` to `performance_log` (nullable; populated for all API-synced rows), index it, and include it in the staging insert (`src/lib/meta-import.ts:120-158`, `:297-388`) so every perf row is permanently keyed to its source Meta ad regardless of later `ads` merges/renames. Optionally add `meta_adset_id`/`meta_campaign_id` for rollup queries that bypass the mutable FK chain — but they are derivable via `ads.adSetId` once (2)–(4) land, so only `meta_ad_id` is strictly required.

**Sync (all in `src/lib/meta-import.ts`):**
2. **Kill the name fallback when an id is present.** In `buildPerformanceLogRows` (`:402-404`) and `resolveAdsForRows` (`:502-506`): if `row.adId` exists but no ad matches it, create the ad (or skip and count it) — never attribute by name. Keep name matching only for id-less CSV rows, and scope it by account.
3. **Adopt legacy rows instead of duplicating.** When matching existing campaigns/ad sets/ads (`:902`, `:1020`, `:1140-1145`), also consult the name map for id-bearing entries whose metaId is absent from the DB (adopting only rows with `metaId IS NULL`), so the first ID-bearing sync claims the legacy row and its history instead of forking it.
4. **Fix the post-upsert re-query** (`:1300-1312`) to select by `metaId IN (...)` in addition to name, so `adIdByMetaId` is complete even when names changed or collide.
5. **One forced historical backfill** (`metaSyncTask` with `force: true` and an explicit `dateFrom`/`dateTo`, `trigger/meta-sync.ts:38-45`, `:383-395`) after (1)–(4), plus a one-time cleanup of perf rows on ads whose metaId is NULL within the re-synced window (they are the merged/misattributed residue).

**Rollups need no new tables.** With `meta_ad_id` on the raw rows and `ads.adSetId → adSets.campaignId` reliable:
- Per-ad manager rows: `performance_log` filtered to base rows (all six breakdown columns NULL — the unique key `src/schema/performance-log.ts:79-91` already guarantees one base row per ad per date range) grouped by `ads.metaId` over the requested date range.
- Ad set and campaign rows: SUM the additive children (`spend`, `conversions`, `impressions`, `purchase_value`, clicks, funnel counts) and derive ratios (ROAS/CPA/CTR/CPM) at each level from the sums — never average the stored per-ad ratios. The existing `performance_log_org_ad_date_idx` (`:73-78`) covers the access path; add `(organization_id, date_start)` if range scans across all ads prove slow.
- Granularity is already solved for the API path: the insights report is requested with `time_increment: "1"` (`src/lib/meta-insights-sync.ts:223`), so API-synced rows are daily and arbitrary date-range rollups are exact. Only legacy CSV rows may carry multi-day spans; rollup queries should aggregate whole stored spans for those.
