# Durable Intelligence Batch Tasks

## Goal

Make the Intelligence v1 production backfills finish reliably beyond Trigger.dev's per-attempt runtime while keeping retries idempotent, progress visible, and paid model calls bounded.

## Current failures

- `shopify-rebucket` loaded and processed the full history in one attempt. It stamped 16,565 of 16,566 orders, then exceeded the 10-minute duration and left its sync-run row `running`.
- `classify-landing-pages` generates invalid PostgreSQL ordering (`NULLS FIRST ASC`) and fails before fetching a page.
- `enrich-creative-tags` performs up to 1,000 sequential creative model calls in one attempt, which cannot fit the default duration.
- Null model verdicts and fetch/model failures remain eligible. A new run can repeatedly select the same rows instead of advancing.

## Architecture

Keep the existing public task IDs as parent orchestrators:

- `shopify-rebucket`
- `enrich-creative-tags`
- `classify-landing-pages`

Add one private child task for each bounded operation. A parent invokes children sequentially with `triggerAndWait()`, checks `result.ok`, aggregates counters, and updates metadata after every child checkpoint. Child tasks remain exported under `trigger/` as required by Trigger.dev.

Parents and children use the existing per-domain concurrency queues so two organization-level rollouts cannot mutate the same candidate set concurrently. No `Promise.all` wraps Trigger waits.

## Rebucketing

Extract a bounded `stampBucketBatch` operation from `stampBuckets`.

- Select at most 500 eligible orders in stable `(id)` order after an optional cursor.
- Resolve and update only that page.
- Return `scanned`, `stamped`, and `nextCursor`.
- Advance the cursor even when a journey-not-ready row cannot be stamped, preventing one unresolved order from blocking the run.
- The parent owns exactly one `shopify_sync_run`, aggregates all pages, and marks it success or failure.
- A retry starts a new sync run and safely skips orders already stamped with bucket rule v5.

The unbounded `stampBuckets` wrapper remains available to incremental/backfill callers, but internally consumes bounded pages so behavior stays consistent.

## Creative and ad-set enrichment

The child processes one bounded unit:

- Up to 10 creatives, sequentially, because each may include an image and one paid model call.
- Up to 25 ad sets in one model call.

The parent advances through stable candidate cursors and aggregates processed, updated, failed, rejected, and ads-stamped counts.

Termination rules:

- For each non-human enforced creative field, a valid null response records AI provenance without writing a value. This means “model inspected and found no signal,” and prevents endless paid reprocessing.
- Failed model calls are not marked complete. The cursor advances for the current parent run, while a later explicit run can retry them.
- An accepted ad-set verdict with a null stage stamps `funnelStageSource = "ai"`; candidate selection excludes AI- or human-attempted ads. A failed ad-set model call remains retryable.
- Human-owned values remain sticky.

The existing `enrichmentAttemptedAt` column is not reused because Meta preview enrichment already owns its semantics.

## Landing-page classification

Fix ordering to valid `ASC NULLS FIRST`. The child processes at most 10 due pages after a stable ID cursor.

- Successful classifications and unchanged-content touches become ineligible through `classifiedAt`.
- Fetch/model failures remain due, but the cursor advances so they do not block later pages in the current run.
- A future run retries failed pages.
- Confirmed pages retain human values; changed content is marked stale as today.

The parent aggregates candidates, fetched, classified, stale, touched, and failed counts.

## Error handling and observability

- A child infrastructure failure makes the parent fail with task, cursor, and batch context.
- Per-record external failures are counted and logged, while the batch continues.
- Parent metadata includes phase, processed, updated/classified/stamped, failed, and cursor.
- Existing payload options remain compatible. Limits become child batch sizes; `maxIterations` remains a safety cap for manual partial runs.
- Validate required model configuration before selecting records. A missing key fails the child before any paid call. Per-record provider failures remain counted and retryable on a later explicit parent run; they do not silently turn the parent summary into an all-success result.

## Tests

Add focused tests for:

1. Cursor pagination terminates with an unresolved order and does not skip later actionable rows.
2. Parent aggregation and child `result.ok` failure propagation.
3. Null creative/ad-set verdicts become attempted without overwriting human values.
4. Landing-page ordering is valid and failed pages do not block later pages.
5. Re-running each parent skips completed records and retries failed records.

Run targeted Vitest files, the full suite, TypeScript, lint, and build before deployment.

## Rollout

1. Merge and deploy the new Trigger worker.
2. Re-run `shopify-rebucket`; verify a successful sync-run and v5 coverage.
3. Run creative/ad-set enrichment to completion.
4. Run landing-page classification to completion.
5. Run `attribution-checks` and verify Insights slice totals and match-rate targets.
