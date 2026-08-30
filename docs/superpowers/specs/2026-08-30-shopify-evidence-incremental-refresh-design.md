# Shopify evidence incremental refresh

## Problem

The nightly Klaviyo supervisor starts one Shopify evidence pass over the trailing seven-day window. The evidence task currently fetches every in-window order from Shopify on every pass. It processes 25 orders per Trigger.dev run and chains another run until the window is exhausted.

August usage shows 661 `shopify-evidence-batch` runs, 1 day 57 minutes of compute, and $3.05 of the $5.00 Trigger.dev allowance. Most of that work observes orders that the previous pass already observed.

The matcher treats one evidence run as a complete, immutable snapshot. A changed-only run cannot omit unchanged orders because the matcher would treat those orders as absent.

## Goal

Keep nightly Shopify evidence fresh while avoiding remote fetches for unchanged orders. Run a full trailing-window reconciliation once a week. Preserve the matcher's complete-snapshot contract and the evidence runner's retry and privacy guarantees.

Expected result, based on 10 to 30 percent of the window changing each day:

- 60 to 77 percent less `shopify-evidence-batch` compute
- about 150 to 265 batch runs instead of 661 for the workload shown in August
- about $0.70 to $1.22 of evidence cost instead of $3.05
- about $2.65 to $3.17 total Trigger.dev usage instead of $5.00 if other tasks stay unchanged

## Refresh policy

`initial_90d` always performs a full scan.

`incremental_7d` uses one of two persisted strategies:

- `changed`: nightly on Monday through Saturday in the store timezone
- `full`: every Sunday in the store timezone

A changed refresh falls back to `full` when no successful complete baseline exists or when the active identity crypto policy differs from the baseline. The start task derives and persists the strategy once. Retries reuse it.

The weekly day is deliberately fixed rather than configured. A setting would add another production branch without changing the cost model.

## Snapshot model

Add these fields to `shopify_evidence_sync_run`:

- `refresh_strategy`: `full` or `changed`
- `baseline_evidence_run_id`: nullable ID of the successful complete run used for carry-forward
- `matching_key_version`: active matching HMAC key version
- `suppression_key_version`: active erasure-suppression key version
- `orders_carried_forward`: non-negative integer, default zero

Add `source_order_updated_at` to `shopify_evidence_run_observation`. It records the Shopify `orderUpdatedAt` value used when that evidence was fetched. Existing observations remain null and therefore cannot prove that an order is unchanged.

The baseline is the newest successful, complete evidence run for the same store. A changed refresh may use it only when:

- its requested window overlaps the new trailing window
- its matching and suppression key versions equal the active versions
- its observations have source update timestamps for every overlapping order

If any baseline condition fails, the run uses `full`.

## Candidate selection

Full refreshes retain the current in-window query and cursor order.

Changed refreshes select an in-window order when any condition is true:

- the baseline has no observation for the order
- the baseline observation has no `source_order_updated_at`
- the order's `order_updated_at` is null
- the order's `order_updated_at` differs from the baseline observation's source value
- the baseline observation or its required identity link was removed by privacy cleanup

Use inequality rather than a global high-water mark. Per-order comparison survives failed runs, late ingestion, timestamp ties, and updates to older orders.

The query keeps the existing `(orderCreatedAt, id)` cursor and batch limit. A changed run with no candidates still executes one cheap terminal batch. Removing that final Trigger run is not worth adding a second orchestration path.

## Commit and carry-forward

Remote fetches and `commitShopifyEvidenceOrder` keep their current serial cursor and compare-and-swap behavior. Each committed observation stores the order's current `orderUpdatedAt` as `source_order_updated_at`.

Before a changed run becomes terminal, one database transaction materializes its complete snapshot:

1. Copy baseline content observations for orders inside the new window that the current run did not observe.
2. Copy the corresponding baseline identity observation links.
3. Exclude orders that left the trailing window.
4. Verify that every current in-window order now has one content observation.
5. Derive aggregate completeness from the materialized observations.
6. Store `orders_carried_forward` and finish the run.

Changed observations win because carry-forward inserts only missing `(run, order)` rows. The transaction copies immutable checksums and identity links. It does not rewrite current order lines or identity HMAC rows.

If a changed order ends with `preserved_partial`, materialize the remaining baseline rows and finish the run as partial under the existing policy. Prefetched or uncommitted work never advances the cursor.

## Matching and freshness

No matcher query changes. Every successful or accepted partial evidence run still contains a complete observation set for its requested window.

The current freshness check continues to rederive the snapshot checksum from the selected run. Carry-forward rows use the checksum and identity links from the baseline, while changed rows use fresh values.

A privacy deletion that removes an identity link makes the order a candidate on the next nightly pass. A crypto key version change forces a full refresh instead of carrying links created under the old policy.

## Failure handling

The existing one-running-run constraint, heartbeat, retry policy, idempotency keys, and cursor compare-and-swap remain in place.

Carry-forward and terminal status update happen in one transaction. A crash before commit leaves the run running and retryable. A crash after commit sees a terminal run and cannot duplicate observations because the run-order constraints remain authoritative.

If snapshot materialization finds a missing observation, it fails the task instead of publishing an incomplete successful run.

## Observability

Add Trigger metadata and persisted counters for:

- refresh strategy
- baseline evidence run ID
- orders fetched
- orders carried forward
- final snapshot order count

After deployment, compare seven days of `shopify-evidence-batch` runs and cost with the August baseline. The change succeeds when batch compute falls by at least 50 percent without an increase in failed or partial evidence runs.

## Test plan

Unit and integration tests cover:

- Sunday and initial runs select `full`
- weekday runs select `changed` only with a compatible complete baseline
- missing source timestamps and crypto-policy changes force a full refresh
- new, changed, null-timestamp, and privacy-cleared orders become candidates
- unchanged orders do not trigger Shopify calls
- carry-forward creates a complete current-window snapshot and excludes expired orders
- changed observations replace carried state for the same order
- identity links carry forward only under the same crypto policy
- zero-change runs finish complete with one terminal batch
- partial, retry, cursor replay, and stale-run recovery behavior remains intact
- matcher projection and freshness tests pass without matcher changes

Run the focused Shopify evidence tests during development. Finish with the full Vitest suite, typecheck, lint, build, and migration-chain check.

## Scope

This change does not add parallel Shopify requests or increase the batch size. Those optimizations can be measured separately after changed-only refreshes are deployed. It does not change the hourly Shopify ingest schedule or the Klaviyo matching model.
