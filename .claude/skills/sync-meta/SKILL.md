---
name: sync-meta
description: Orchestrate a Meta (Facebook Ads) data sync across every Meta-enabled account in the active Adsolute workspace. Fetches base ad insights plus demographic breakdowns (age, gender, country, device) and imports them via the `metaSync` OpenAPI procedures. Use when the user asks to run the morning sync, refresh Meta data, sync ad performance, or pull demographics.
---

# Meta sync orchestration

You are the durable orchestrator for Meta data sync. The server exposes bounded OpenAPI procedures under `metaSync`; you are responsible for sequencing them, sleeping between polls, and surfacing failures. Never try to pull rows through this process — every procedure returns only IDs, counts, and phase markers.

## Preconditions

- The caller is authenticated to the target workspace (session cookie or API key).
- At least one ad account in the workspace has a Meta access token.
- All procedures live under the `metaSync` router and are exposed via OpenAPI at `/api/openapi/metaSync/<procedure>`.

## Environment

Read both from the caller's shell env. Do **not** hardcode either.

- **Base URL:** `$ADSOLUTE_API_URL`. Falls back to `http://localhost:3000` if unset. All requests use `${ADSOLUTE_API_URL}/api/openapi/metaSync/<procedure>`.
- **Auth:** `$ADSOLUTE_API_KEY`. Send as `Authorization: Bearer $ADSOLUTE_API_KEY`. API keys are org-scoped and environment-bound — a dev key will NOT authenticate against prod and vice versa. If the user wants to run against prod, both `ADSOLUTE_API_URL` and `ADSOLUTE_API_KEY` must point at prod.

If `$ADSOLUTE_API_KEY` is unset, stop and ask the user to set it before proceeding.

## Defaults

- **Breakdowns per account:** `[null, "age", "gender", "country", "device_platform"]` — in that order. `null` means the base sync.
- **Date window:** default to `suggestedDateFrom` / `suggestedDateTo` returned by `listSyncableAccounts`. If the user specifies a window ("sync last 3 days", "sync 2026-03-01 to 2026-04-01"), honor theirs instead — pass the user-specified dates to `startReport` verbatim.
- **Freshness skip window:** 4 hours. If a successful run of the same `(accountId, breakdown, dateFrom, dateTo)` finished within this window, skip it. Override if the user says "force resync" or similar.
- **Poll interval:** 10 seconds between `pollReport` calls.
- **Poll timeout:** 30 polls per report (≈5 minutes). Record failure, move on.
- **Concurrency:** serial across accounts and breakdowns. Meta rate-limits per app, not per account.

## Algorithm

1. Call `metaSync.listSyncableAccounts`. **Iterate every account returned** — do not pre-filter by `isStale`. The `isStale` flag is account-level only (based on `lastImportedAt`) and misses the case where base data is fresh but demographic breakdowns have never been synced. Use `isStale` and `gapDays` as display signals in the summary, not as gates. If `gapDays === 30` for an account, mention it in the summary so the user knows that account may need more than one day's backfill.
2. Call `metaSync.listRecentRuns({ limit: 100 })` **once**, up front. The response shape is `{ runs: [...], nextCursor: string | null }` — read `.runs`. Cache the array. If `nextCursor` is non-null and you think the freshness decision might depend on older runs (rare; 4-hour window × 4 accounts × 5 breakdowns = at most ~20 relevant runs), call again with `{ limit: 100, cursor: <nextCursor> }` and merge.
3. For each account, for each breakdown in the default order:
   1. **Freshness check.** In the cached `recentRuns`, look for a run where:
      - `accountId` matches
      - `dateFrom` and `dateTo` match the window you're about to sync
      - `breakdownsRequested` equals `[]` (for base) or `[breakdown]` (for a specific breakdown)
      - `status === "success"`
      - `finishedAt` is within the last 4 hours

      If found, **skip this breakdown** — record it as `skipped (fresh)` in the summary and move on.
   2. Call `metaSync.startReport({ accountId, dateFrom, dateTo, breakdown })`. Capture `syncRunId`.
   3. Poll loop: call `metaSync.pollReport({ syncRunId })`. Sleep 10s if `ready !== true`. Stop when `phase === "ready"`, `phase === "failed"`, or after 30 polls.
   4. If ready: import loop. Start with `cursor: null`. Call `metaSync.importReport({ syncRunId, cursor })`. Pass the returned `nextCursor` into the next call. Stop when `done === true`.
   5. On failure or timeout: record `{ account, breakdown, reason }`, continue to the next breakdown.
4. After all breakdowns for an account: enrichment loop. Call `metaSync.enrichPreviews({ accountId })`. Repeat while `remaining > 0`, capped at 5 iterations.
5. Emit a final summary.

## Rules

- **Never** poll faster than every 10s. You are not the rate-limit backstop; Meta is.
- **Never** call `importReport` before `pollReport` returns `ready: true`.
- **Always** pass the exact `nextCursor` from the previous `importReport` call. It is an opaque URL — do not modify, decode, or inspect it.
- If any procedure returns a non-2xx error, retry once after 5s. If it fails again, record the failure and move on. Do not let one account's failure halt the others.
- Do not parallelize accounts or breakdowns. Serial only.
- If `listSyncableAccounts` returns zero accounts, report that clearly and stop.

## Reporting

When finished, produce a markdown summary in this shape:

```
### Meta sync summary — YYYY-MM-DD

- **Acme Ads** (2026-04-10 → 2026-04-17): 4,213 rows, all breakdowns ✓
- **Brand Y** (2026-04-10 → 2026-04-17): 1,102 rows, age breakdown failed (timeout after 5 min); gender/country/device skipped (fresh, <4h old)
- **Client Z** (2026-03-18 → 2026-04-17, 30-day cap): 8,940 rows ✓ — recommend a follow-up run to backfill older dates.

**Total:** 14,255 rows across 3 accounts. 1 breakdown failure, 3 skipped as fresh.
```

Surface failures prominently so the user can decide whether to re-run a specific account or breakdown.

## Inspecting prior runs

If the user asks "what happened in the last sync?" or "is sync running?", call `metaSync.listRecentRuns` (optionally filtered by `accountId`). Response is `{ runs, nextCursor }`. Each run in `.runs` includes `status`, `currentPhase`, `rowsSynced`, `errorMessage`, and timing. Format a compact table. Use `nextCursor` + `{ cursor: <nextCursor> }` to page backwards if the user wants older history.
