# Storage retention design

Date: 2026-08-12
Status: Approved retention contract (handoff); implementation must not touch production data.

## Goal

Hold steady-state Neon storage near 130–150 MB per organization while keeping the
reporting the product actually uses:

| Data | Retention |
|---|---|
| Daily base/overall Meta metrics (`performance_log`, all six breakdown columns null) | 180 days |
| Country/device/age/gender breakdown rows | 14 days |
| Monthly overall summaries (new table) | Indefinite |
| Shopify/Klaviyo attribution **evidence** | 90 days |

Production execution (deletes, vacuum, repack) is out of scope and needs separate
approval. Everything here ships as code + tests + a read-only dry-run report.

## Why this shape

At audit time `performance_log` was ~374 MB of a ~425 MB database, and 582,883 of
625,174 rows were breakdown rows. Trimming breakdowns to 14 days and base rows to
180 days lands the database at roughly the 131 MB scenario from the audit. Physical
bytes only fall after a rewrite (vacuum full / export-reload), which is part of the
separately-approved production plan, not this milestone.

## Components

### 1. Monthly summary table (`performance_monthly_summary`)

One row per `(organization_id, month)`; `month` is the first day of the month.
Additive sums only — ratios (ROAS, CPA, CTR, CPM) are derived at read time so the
table never goes stale against formula changes:

- `spend`, `purchase_value`, `purchase_value_7d_click`, `purchase_value_1d_view`
- `conversions`, `impressions`, `link_clicks`, `clicks_all`,
  `landing_page_views`, `add_to_cart`, `initiate_checkout`,
  `video_views_3s`, `video_thruplay`
- `days_with_data`, `source_row_count`, `rolled_up_at`

Rolled up from **daily base rows only** (`date_start = date_end`, all six dimension
columns null — the same contract as `basePerformanceLogFilter`). Legacy multi-day
rows are excluded; they are already handled by the existing admin purge tool.

Reach is deliberately absent: daily reach is not additive across days and a summed
value would be wrong.

The rollup is an idempotent upsert that recomputes every month present in the
retained base rows, including the current partial month. Because the retention sweep
always rolls up **before** it deletes, a month's summary is locked in from live data
before any of its base rows can expire.

Read path: a new `performanceSummary.monthlyOverview` tRPC procedure (org-scoped)
returns the stored sums plus derived ROAS/CPA/CTR per month. No UI consumes monthly
trends today; this procedure is what preserves the "long-term monthly overall
trends" capability once base rows expire. Month-over-month comparisons keep reading
live base rows — 180 days always covers this month and last month.

### 2. Retention engine (`src/lib/retention/`)

Pure library, no Trigger.dev imports, so it is unit/integration testable and shared
by the scheduled task and the CLI:

- `policy.ts` — the retention windows as exported constants
  (`BASE_RETENTION_DAYS = 180`, `BREAKDOWN_RETENTION_DAYS = 14`,
  `EVIDENCE_RETENTION_DAYS = 90`) and cutoff helpers that turn "today" into
  YMD cutoff dates. Everything takes an explicit `today` argument — no hidden
  clock reads — so tests are deterministic.
- `rollup.ts` — `rollupMonthlySummaries({ organizationId, today })`, the upsert
  described above.
- `plan.ts` — `planRetention({ organizationId, today })`, read-only. Returns
  candidate counts and date extents per category:
  1. breakdown rows with `date_end <` breakdown cutoff (this includes the legacy
     combined-breakdown rows — they are all far older than 14 days),
  2. daily base rows with `date_end <` base cutoff,
  3. legacy multi-day base rows past the base cutoff, as their own category:
     the rollup never sums them (they duplicate daily rows where both exist),
     so their spend leaves without entering a summary and the approver must
     see that count separately,
  4. evidence rows per table (see §4), including `cascadeOnly` categories that
     count the claim/match/product rows PostgreSQL removes together with a
     doomed `klaviyo_event` — counted for the approval report, never deleted
     directly.
- `execute.ts` — `executeRetention({ organizationId, today, dryRun })`. With
  `dryRun: true` (the default) it returns the plan untouched. With `dryRun: false`
  it deletes in id-batches of 5,000 (`DELETE … WHERE id IN (SELECT … LIMIT n)`)
  looping until a batch comes back empty, so no long-held locks and safe resume
  after a crash or retry.

Deletion uses `date_end < cutoff` so a row is only removed when its entire date
range has expired.

### 3. Scheduled task + CLI

- `trigger/retention-sweep.ts` — `schedules.task` at `0 21 * * *` (after the 18:00
  UTC meta-sync), `queue: { concurrencyLimit: 1 }`. Per organization: rollup →
  plan → log the plan. It only executes deletes for organizations listed in
  `ADSOLUTE_RETENTION_ENFORCE_ORGANIZATION_IDS` (comma-separated, same shape as
  `ADSOLUTE_META_SYNC_ORGANIZATION_IDS`). Unset or empty means every run is a
  dry-run everywhere — which is exactly the state production stays in until the
  cleanup plan is separately approved.
- `scripts/retention-report.ts` (`bun run retention:report`) — read-only CLI that
  runs rollup-free `planRetention` against `DATABASE_URL` and prints candidate
  counts, cutoffs, and estimated reclaimable bytes. It deliberately has no
  `--prod` flag: the production report is produced from a local copy restored
  with `scripts/pull-prod-data.sh`, so the CLI can never hold a production
  connection. It redacts organization ids to a short prefix and has no delete
  path at all; execution stays behind the Trigger task's env gate.
- `retention-run` (manual Trigger task) — payload `{ organizationId, execute? }`
  for a supervised single-org run. It deletes only when `execute: true` **and**
  the org is in the env allowlist; anything else is a dry run.

### 4. Evidence retention (90 days)

Scope is the **evidence** graph only. Core `shopify_order` / `shopify_refund` rows
are synced for MER/attribution reporting and are not evidence; they are untouched.
Also permanently excluded: `identity_matching_key_binding` (documented append-only),
`identity_erasure_suppression` (privacy tombstones), `identity_crypto_policy`,
uninstall receipts/retired keys, `klaviyo_report_fact` (aggregates), and all
connection/metric/alias/join-rule/marketing-object configuration.

Delete order (children first, each step guarded so nothing referenced by retained
rows is removed):

1. `klaviyo_attribution_claim`, claim replay state/runs older than cutoff
2. match graph: product evidence links, event/order match results, candidates,
   then match runs whose windows end before cutoff
3. Klaviyo event lineage: `klaviyo_event` with `occurred_at <` cutoff — cascades
   event products, run observations, identity observations, and event-side HMACs
4. Shopify evidence artifacts: run identity observations, run observations,
   `shopify_order_line` and order-side `source_identity_hmac` with
   `created_at <` cutoff
5. terminal sync runs (`klaviyo_sync_run`, `shopify_evidence_sync_run`) whose
   requested windows end before cutoff **and** have no surviving observations

The ~267/267/267/339 partial rows from the canceled production bootstrap are
recent; the 90-day policy leaves them alone until they age out. Nothing in this
milestone deletes them.

Known follow-up: `klaviyo_match_run`, `klaviyo_claim_replay_run`, and
`klaviyo_claim_replay_state` have no age rule yet. They are run-audit records
that grow slowly (zero rows today) and are protected from accidental cascade by
the sync-run guards above; an explicit retention rule for them is a separate,
small change once the pilot produces real volume.

### 5. Breakdown window guard (14 days)

Shared helper in `policy.ts`: `breakdownWindowStart(today)` and an
`assertBreakdownRange` that throws a `BAD_REQUEST` TRPCError naming the retained
window. Applied server-side, with the UI clamping first so users normally never
see the error:

- `performanceLog.demographicBreakdown` — reject `from` before the window.
  Dashboard demographics tab clamps its query to the window and shows an explicit
  caption when the selected range is wider ("Demographic detail covers
  <clamped range> — breakdown data is retained for 14 days").
- `performanceLog.creativeDemographicBreakdown` — `from`/`to` become required;
  same clamp + caption on the creative page (page default is 30 days, so the
  demographics section will routinely show the caption).
- `performanceLog.exportByAccount` — new `scope: "all" | "base"` input
  (default `"all"` preserves current behavior). `"all"` is rejected when the range
  reaches past the breakdown window with a message that says to re-export with
  `scope: "base"`; `"base"` filters to base rows and works for any range. The
  import-page export UI picks the scope explicitly and explains the difference.
- `adCreative.dashboardExport` — same `scope` treatment (its CSV includes all six
  dimension columns).
- Agent export (`fetchDemographicSummaries`) — demographic summary section is
  computed over the intersection of the export range and the breakdown window;
  when clamped, the CSV section header carries the actual window so nothing is
  silently partial.
- Generic writers get ingestion guards instead (§6); raw list endpoints
  (`listAll`, `listByAd`, `trackerList`) have no UI callers and simply reflect
  retained rows.
- The MER account data-health dialog copy (13+ months guidance) is updated to
  describe the new policy.

### 6. Ingestion enforcement

Retention is enforced at ingestion so historical syncs can't resurrect expired
rows, with one universal guard at the single write choke point plus earlier clamps
for good UX/economy:

- **Universal guard:** `replacePerformanceLogRowsViaStaging` drops rows whose
  `date_end` is older than that row's grain cutoff (base 180d, breakdown 14d) and
  reports how many it dropped. Every Meta and CSV path funnels through here.
- `metaSync.startReport` clamps `dateFrom` to the grain cutoff before asking Meta
  for the report (no point paying for data we refuse to store). A fully expired
  window throws `PRECONDITION_FAILED` with the `RETENTION_WINDOW_EXPIRED` token;
  the sync task recognizes that error and records the grain as skipped, so the
  run continues. (A throw keeps the procedure's output contract stable for
  every other caller — chosen over the earlier "no-op result" sketch.)
- `trigger.triggerMetaSync` (manual backfill) validates/clamps the custom range
  server-side and tells the caller what was clamped.
- `performanceLog.create` / `bulkCreate` / `update` reject dates older than the
  base cutoff (they can only produce base rows today).
- `ad.bulkImport` skips performance rows older than the base cutoff and reports
  the skipped count (its result gained a `skippedExpiredPerformanceRows` field).
- CSV import inherits the universal staging guard; `adCreative.bulkImport`
  additionally reports dropped-row counts so the UI can surface them.

### 7. Accepted consequences (documented, not code changes)

- Queries that are "lifetime" today (surviving creatives, running-days CTEs,
  agent-export lifetime baselines, Studio winner rankings) silently become
  "over retained data" (≤180 days) once old base rows are deleted. The monthly
  summary table preserves overall trends; per-ad lifetime baselines older than
  180 days are deliberately given up.
- Detailed breakdown history older than 14 days is gone and cannot be re-imported.
- Meta remains the source of truth for anything older; a fresh backfill within the
  windows always works.

## Testing

- `retention/policy` unit tests: cutoff math, grain classification.
- Disposable-PostgreSQL integration test (manager.test.ts fixture pattern) for
  rollup + plan + execute: seed base/breakdown/legacy rows around the cutoffs,
  assert plan counts, execute, assert survivors and monthly sums exactly.
- Evidence retention integration test on the existing Klaviyo/Shopify migration
  harness: seed old + new evidence, assert FK-safe deletion and exclusion list.
- `meta-import.test.ts`-style guard tests: staging drop counts per grain.
- Router tests: demographic rejection, export scope behavior, create/bulkCreate
  date guards.
- Trigger task stays thin (org loop + env gate) so logic is covered at the lib
  layer; the env-gate predicate is unit tested.

## Explicitly out of scope (separate approval)

Production `DELETE`/`TRUNCATE`/`VACUUM FULL`/repack/migration runs, enabling
`ADSOLUTE_RETENTION_ENFORCE_ORGANIZATION_IDS` in production, deleting the partial
bootstrap evidence artifacts, and any index changes (the unused `meta_ad_id` index
is a candidate for a later, separately-reviewed migration).
