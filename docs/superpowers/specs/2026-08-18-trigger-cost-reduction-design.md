# Trigger.dev Cost Reduction

## Goal

Cut prod Trigger.dev compute spend roughly in half without changing any persistence semantics, by removing serial per-row DB round-trips from the Klaviyo event commit, stopping retry/timeout waste in the Shopify incremental sync, and parallelizing paid creative model calls that today run serially.

## Baseline (prod, Aug 11–17, $4.02/week total)

| Task | Cost | Share | Diagnosis |
|---|---|---|---|
| `klaviyo-order-core-batch` | $2.09 (~17 compute-hours, 97 runs) | 52% | `commitKlaviyoEventPage` (`src/lib/klaviyo/source-store.ts`) issues up to ~8 serial queries per event × 200 events/page; wall-clock is DB round-trip latency |
| `shopify-evidence-batch` | $0.78 | 19% | Serial per-order fetch + commit; deferred (see Non-goals) |
| `enrich-creative-tags-batch` | $0.53 | 13% | One serial paid model call per creative; wall-clock is OpenAI latency |
| `shopify-incremental` | $0.39 | 10% | 27 TIMED_OUT + 18 FAILED of 193 runs; widening-window failure cascade and full-fleet parent retries |
| Other | ~$0.23 | 6% | Not in scope |

## Success targets

Total weekly spend reduction versus the $4.02 baseline, with evidence untouched:

- Conservative ~45% (Klaviyo −70%, incremental −30%, enrich −50%)
- Base ~58% (Klaviyo −85%, incremental −50%, enrich −65%)
- Optimistic ~65% (Klaviyo −93% including Stage 1b, incremental −70%, enrich −75%)

Any Stage 0 region fix is upside on top of these numbers, not assumed by them. The incremental −50%/−70% scenarios assume Stage 2b (evidence-gated) lands; Stage 2a alone supports the −30% case.

## Stage 0 — measure worker↔Postgres RTT before coding

The Klaviyo diagnosis assumes cross-region latency (~hundreds of ms per round-trip) between the Trigger.dev worker and Postgres. Verify it first:

- Read per-query timing off existing prod run logs, or run one throwaway task timing ten trivial `select 1` round-trips against `DATABASE_URL`. Record the median RTT in the PR description of Stage 1.
- If the worker and database regions are misaligned and Trigger.dev offers a matching region, align them. This is configuration, not code, and it multiplies every later stage.
- Stage 1 proceeds regardless of the result: ~800 round-trips per page is wrong at any latency.

## Stage 1 — set-based `commitKlaviyoEventPage`

Rewrite the per-event loop in `commitKlaviyoEventPage` into batched statements. Target: ~10–15 queries per 200-event page instead of ~800.

### Unchanged (load-bearing, do not touch)

- The outer `withKlaviyoStoreConnectionLock` transaction and store→connection→run lock order.
- The checkpoint compare-and-swap: `sameCheckpoint` mismatch still returns `{ committed: false }`; the single checkpoint-advance `UPDATE … RETURNING` still throws `"Klaviyo event checkpoint raced"` unless exactly one row advanced.
- Metric-binding validation (order-core and journey branches), the identity write-gate / crypto-policy agreement check, and all existing error messages — tests assert on them.
- Suppressed events still write nothing but a counter.

### Batched replacements, with guardrails

1. **In-page dedupe (required first).** A multi-row `INSERT … ON CONFLICT DO UPDATE` errors if two rows hit the same conflict target. Dedupe the page by `externalEventId`, **last occurrence wins**, matching what the serial loop converged to. Do this before any statement.
2. **Suppression lookup.** One tuple-membership select for all `erasureSuppressionCandidates` across the page (`or(and(kind, keyVersion, digest))…`), matched per event in memory. The erase path for an already-stored suppressed event (`eraseSuppressedKlaviyoEventEvidence`) stays serial per hit — it is rare and compliance-owned.
3. **Existing-row counters.** One `inArray` select of `(id, externalEventId, sourceChecksum)` for the page's event IDs, used only to compute `inserted`/`updated` counters exactly as today. The upsert still writes every row: today's code has no checksum skip, and this spec must not introduce one (that would change `fetchedAt`/`updatedAt` and replay behavior).
4. **Event upsert.** One multi-row insert with the existing `onConflictDoUpdate` set, `RETURNING (id, externalEventId)`. Build the event-ID map **by `externalEventId` key, never by row order**.
5. **Products.** One batched delete (`inArray(eventId, …)`) for events with `productEvidenceCompleteness === "complete"`, then one multi-row insert of all their products.
6. **Run observations.** One multi-row `onConflictDoNothing … RETURNING eventId`. Diff returned IDs against expected; for the conflicted remainder, one batched select of prior checksums; throw the existing `"Klaviyo run observation changed during replay"` on any mismatch.
7. **Identity HMACs.** One batched select of existing rows for all `(eventId, keyVersion)` pairs. In memory, classify each pair: identical digest **reuses the immutable existing row ID**; changed digest is queued for delete + fresh insert. Execute one batched delete, then one multi-row insert — delete strictly before insert so dependent identity observations cascade before fresh links, exactly as the serial loop guarantees. Then batch the run-identity observations with the same insert/diff/verify pattern as observations, keeping the `"Klaviyo run identity observation changed during replay"` throw.
8. **Chunking.** Cap every multi-row statement at 1,000 rows (well under node-postgres's 65,535-parameter limit even for the widest table); loop chunks inside the same transaction.

### Tests

`src/lib/klaviyo/source-store.test.ts` and `source-store.integration.test.ts` are the safety net and must pass unmodified except where they assert query *counts*. Add cases for: duplicate `externalEventId` in one page (last-wins), replay of a committed page (idempotent, observation verification passes), changed-digest HMAC replacement preserving observation cascade, and a >1,000-row synthetic page exercising chunking.

## Stage 1b — re-evaluate `MAX_PAGES_PER_BATCH` (separate PR, after Stage 1 ships)

The current value of 2 in `trigger/klaviyo-source-sync.ts` was derived from a worst case dominated by commit latency. After Stage 1, the binding constraint is Klaviyo API time: page fetch plus in-process 429 sleeps (the client retries up to 4 attempts with retry-after ≤ 60s each, billed wall-clock; longer retry-afters already throw to Trigger's unbilled retry backoff — keep that). Redo the worst-case arithmetic in the constant's comment against `maxDuration: 1800` and raise the value accordingly (expected landing zone 8–10). One-line diff plus comment; measured, not guessed.

## Stage 2a — Shopify incremental hygiene

Three changes to `trigger/shopify-sync.ts`, one PR, no schema or watermark changes:

1. **Per-store/hour child idempotency.** `shopifyIncrementalScheduled` triggers each store's `shopify-incremental` with a global-scope idempotency key `shopify-incremental:{storeId}:{UTC hour bucket}` (TTL ≥ 2h), so a parent retry is free for stores that already ran that hour.
2. **Don't fail the fleet.** The scheduled parent stops throwing on the first store failure. It collects per-store results, reports failures in its return value and logs, and only fails itself if *every* store failed. One bad store must not cause parent retries that re-trigger healthy stores.
3. **No-op downstream skip.** When a run finishes with `ordersSynced === 0` and `journeyRepolled === 0`, skip `stampAndLog` (three full Meta-index loads plus bucket stamping) and the landing-page harvest. Record `skippedDownstream: true` in the sync-run meta and run metadata.

## Stage 2b — break the widening-window cascade (evidence-gated)

`since` derives from `getLastSuccessfulRunStartedAt` (`src/lib/shopify-ingest.ts` — actually the last successful run's `requestedAt`), so each failure lengthens the next run until it times out. A naive fixed cap is **not safe**: `fetchAllOrders` runs a lower-bound-only `updated_at:>=` query, and marking a capped run successful would advance the watermark to now, silently skipping everything between the cap and the failure backlog.

**Gate.** Before implementing, pull prod run logs for the TIMED_OUT/FAILED runs and confirm which phase exceeds the 600s default `maxDuration` and that window growth is the driver; record the findings in the PR. If the evidence points elsewhere (e.g. journey repoll or stamping), stop and redesign against that evidence instead.

**Design (no data loss), if the gate passes:**

- **Bounded window.** Query `updated_at:>=since` **and** `updated_at:<until` (Shopify search syntax supports the range), where `until = min(now, watermark + 48h)` and `since = watermark − INCREMENTAL_OVERLAP_MS` as today.
- **Durable high-watermark.** On success, write `syncedThrough: until` (ISO string) into the run's `shopify_sync_run.meta` jsonb — no migration needed. The watermark reader prefers the last successful incremental run's `meta.syncedThrough` and falls back to `requestedAt` for legacy rows. A capped run therefore advances the watermark only to `until`, never to now; the next hourly run drains the remainder.
- **Correctness note.** An order updated inside `[since, until)` *after* the query ran gets a new `updated_at` beyond `until` and is caught by a later window; the existing 15-minute overlap covers clock skew as today.
- Do **not** add a per-order durable backoff schema or new journey-repoll machinery — the existing repoll (≤1,000 IDs, 50/GraphQL call, 3-day `pendingSince` cutoff) is already bounded.

Tests: watermark reader prefers `meta.syncedThrough`, falls back to `requestedAt` on legacy rows; a capped run persists `syncedThrough = until` (not now) and the follow-up run's window starts from it; backlog larger than 48h drains across successive runs with no gap between windows.

## Stage 3 — creative enrichment concurrency and failure stamping

Changes to `trigger/enrich-creative-tags.ts`, one PR:

1. **Bounded-concurrency single-creative calls.** Inside `processCreativeBatch`, run the per-creative model calls with a concurrency limit of 4 via `Promise.allSettled`-style pooling. **One creative per `generateObject` call stays** — per-item error isolation, per-item confidence, and image attribution are unchanged; only wall-clock shrinks. Per-creative try/catch, counters, and logging keep their current shape (the `currentItem` progress metadata may report the batch rather than one creative). The ad-set phase already batches 25 per call and is untouched. No `Promise.all` around Trigger waits — this pool wraps plain model/DB calls only.
2. **Bounded permanent-failure policy.** Today a creative whose model call always fails (e.g. dead image URL) is re-selected by `CREATIVE_PENDING_SQL` and re-billed on every meta-sync forever. `attributesMeta` is typed `Record<string, { source: "ai" | "human"; confidence?: number }>` and stays purely provenance — failure state does **not** go there. Instead add two typed columns to `ad_creative` via a generated migration (`bun run db:generate` + `db:migrate`):
   - `aiTagFailureCount: integer("ai_tag_failure_count").notNull().default(0)`
   - `aiTagLastFailedAt: timestamp("ai_tag_last_failed_at")` (nullable)

   Exact behavior:
   - On a per-creative model-call failure: increment `aiTagFailureCount`, set `aiTagLastFailedAt = now()`. On success: reset to `0` / `null`.
   - Candidate selection (all runs by default, scheduled or manual) adds: exclude when `aiTagFailureCount >= 3 AND aiTagLastFailedAt > now() - interval '7 days'`. The 7-day cooldown means suppression is never permanent; after it lapses the creative gets 3 fresh attempts.
   - A new optional payload flag `retryFailed?: boolean` on `EnrichCreativeTagsPayload` (threaded to the child) bypasses the exclusion entirely for explicit manual retries.
   - `enrichmentAttemptedAt` is **not** reused — the 2026-08-12 durable-intelligence-batches spec assigns its semantics to Meta preview enrichment.

   This mirrors that spec's termination philosophy: failed items stay retryable, they just stop being retried implicitly on every run.

Tests: concurrency pool preserves per-creative failure isolation and counters; a third consecutive failure excludes the creative from the next default run; the exclusion lapses after the cooldown and is bypassed by `retryFailed: true`; success resets both columns; human-owned fields remain untouched under concurrency.

## Deferred — `shopify-evidence-batch` prefetch

Not built now. Re-measure its share after Stages 0–2a; the same RTT pathology likely dominates its per-order `commitOrder` transaction, and the fix may be free. If it still matters, the design must honor these guardrails, recorded here so they survive:

- **Capability first.** `identityCapability` is an order-dependent state machine: after one "unavailable" result, later orders skip `fetchIdentity` entirely. Prefetching must not fire identity fetches (a protected-customer-data surface) that the serial code avoids — resolve capability before opening the prefetch window, or hold prefetch depth at 1 until capability is `available`.
- **Ordered commits only.** Fetches may overlap (concurrency 3–4); `commitOrder` calls stay strictly serial in cursor order with the existing `expectedCursor` CAS.
- **Counts at commit time.** `progress` counters are persisted inside each commit and replayed on retry; compute per-order deltas in commit order, never at fetch-completion time.
- **Stop at partial.** A `preserved_partial` order commits and terminates the run; prefetched results beyond it are discarded uncommitted so the cursor never passes the partial order.

## Observability

- Klaviyo: keep `pagesProcessed`/`eventsRead` run metadata; Stage 1's PR compares per-page commit duration before/after from run logs.
- Incremental: sync-run meta gains `skippedDownstream` (Stage 2a) and `syncedThrough` (Stage 2b); the scheduled parent returns per-store outcomes.
- Enrich: existing processed/updated/failed counters unchanged; suppressed creatives are queryable via `ai_tag_failure_count` / `ai_tag_last_failed_at`.
- After each stage deploys, pull a 7-day cost breakdown via the Trigger.dev runs API (the handoff documents the Bearer + cursor-pagination recipe) and record it in the PR or a follow-up note. Success is judged against the table above.

## Delivery

Isolated PRs, in order, each independently revertable:

1. Stage 0 findings + region fix if applicable (may be config-only, no PR needed beyond a note in Stage 1's PR).
2. Stage 1: set-based commit + tests.
3. Stage 1b: `MAX_PAGES_PER_BATCH` one-liner with redone math.
4. Stage 2a: incremental hygiene.
5. Stage 2b: bounded window + durable watermark, only if its evidence gate passes (diagnosis recorded in the PR either way).
6. Stage 3: enrich concurrency + failure columns (includes the migration).

Each PR runs targeted Vitest files, the full suite, TypeScript, lint, and build. `/code-review` after Stage 1 at minimum.

## Non-goals

- No checksum-based skip-unchanged in the Klaviyo commit (semantic change; out of scope).
- No `wait.for()` conversion of the Klaviyo client's in-process 429 sleeps (long delays already escalate to unbilled task retries).
- No Shopify evidence prefetch until post-remeasurement (guardrails above).
- No durable per-order journey-repoll backoff schema.
- No batching of multiple creatives into one model call, and no batched creative DB writes.
- No machine-preset changes; every task in scope is I/O-bound on the default preset already.
