# Klaviyo Postgres snapshots implementation plan

Spec: `../specs/2026-09-07-klaviyo-postgres-snapshots-design.md` — **approved by the user** (data flow, snapshot history, latest-by-default, daily + manual refresh, `not_available` semantics, private profile associations and erasure extension). The superseded live-read plan is `2026-09-07-klaviyo-openapi-parity.md`. PR #264 stays draft until implementation and independent review pass; parent then runs CI before the authorized merge/deployment. No worker push/merge/deploy/live activation without parent direction.

Matrix: `docs/klaviyo-parity-matrix.md` is updated every round. Prior live-read test passes are baseline evidence only.

## Module boundaries (deep modules, small interfaces)

- `src/schema/klaviyo-snapshot.ts` — versioned snapshot storage: definitions, runs, content versions, records, private profile-suppression associations. Composite connection-scoped FKs; no FK to `klaviyo_sync_run`.
- `src/lib/klaviyo/snapshot-contracts.ts` — pure shared schemas: dataset/scope canonicalization + fingerprints, checkpoint shapes + exact assertions, response states, reviewed record revalidation, fixed error codes, bounds. Imports no db/transport.
- `src/lib/klaviyo/snapshot-store.ts` — Drizzle only: definition configuration, run preparation/reaping (leases), page commits (staging, associations, suppression checks under store→connection lock), atomic publication/current-pointer swap, failure finalization, pinned page reads, history/status, snapshot erasure helpers.
- `src/lib/klaviyo/snapshot-collector.ts` — provider adapters + durable checkpoint processing; worker-only; resolves credentials/transport; never imported by GET paths.
- `src/lib/klaviyo/snapshot-reads.ts` — authenticated DB-backed read service returning the discriminated response; no credential/transport imports at runtime.
- `src/lib/trpc/routers/klaviyo-reads.ts` — four org/read query procedures, same route names, snapshot-backed.
- `src/lib/trpc/routers/klaviyo-snapshot-controls.ts` — additive session-admin controls under `klaviyoSnapshots` (configure, refresh, retryDispatch, status, history). Not exposed through OpenAPI; ordinary API keys cannot mutate.
- `trigger/klaviyo-snapshots.ts` — durable checkpointed collection with fenced leases and idempotent dispatch; independent 20:30 UTC schedule so evidence eligibility/failure cannot gate snapshots. No incremental-supervisor changes.
- `src/lib/shopify-privacy.ts` — email erasure extended across snapshot associations, records (staging + history), shared content versions, profile tombstones.

## Rounds

### Round 1 — schema, contracts, store

- [x] Snapshot schema file + `bun run db:generate` migration (synthetic disposable `DATABASE_URL`; never hand-authored).
- [x] Contracts: canonical scope fingerprints (equivalent instants, metric-set order), checkpoint assertions, response discriminators, bounds.
- [x] Store: definitions, prepare/reap runs, page commits with retry-idempotency, atomic publication + one-current pointer, stale-worker/newer-publication rejection, pinned reads, failure codes.
- [x] Isolated-Postgres store tests: FK/scope, retries, lease expiry, races, publication atomicity, exact-window matching, empty snapshots, cross-org rejection, uninstall cascade.

### Round 2 — collector, scheduling, privacy

- [x] Events collection variant in `collection-reads.ts` reusing the reviewed parser: transient profile email include, identical public record projection.
- [x] Collector: page loop per dataset through reviewed adapters, durable checkpoints, privacy resolution (transient email → suppression HMAC associations), pre-ingestion suppression, fail-closed privacy blocker, campaign-values `more_available` refusal, bounds.
- [x] Trigger task + idempotent handoffs; independent daily schedule; manual refresh procedures.
- [x] Erasure extension: snapshot-only profile discovery, staging/history/shared-content deletion, profile tombstones, privacy-adjusted marking, consistent counts.
- [x] Tests: mocked provider fixtures (six chains, catalog, events, values), erasure before/during/after collection, replay/changed-email, unresolved-identity fail-closed, no plaintext leakage, daily/manual control auth.

### Round 3 — API cutover, docs, regression

- [x] Rewrite `klaviyo-reads` router on the snapshot read service; GETs never touch transport/credential resolution/enqueue.
- [x] Rewritten HTTP tests: seeded DB snapshots with provider/Trigger/credential calls set to throw; five record contracts round-trip (fields/null/numerics); pinned pagination across a new publication; not_available reasons; history via snapshotId; auth/scope.
- [x] OpenAPI guide + parity matrix + this plan updated; provider-parser/Lab/claims/flows/report/evidence regression, typecheck, lint, build and isolated DB suite. Final full run: 144 files / 2,276 tests, zero skips/failures; component suite: 156 tests. Two independent follow-up reviews found no remaining actionable findings.

## Verification and safety rules (every round)

- Migrations only via `bun run db:generate`; verify on disposable local clusters and run the migration guard.
- Implementation workers must not access production, make live calls, edit secrets, commit, push or deploy. The user subsequently authorized the parent to migrate/deploy or squash-merge after completion and checks. Release ordering: migration → Trigger → web. No automatic daily enrollment or live backfill.
- `bun run test` (Vitest), not `bun test`; no `package-lock.json`.
- New snapshot lifecycle tests must pass independently. The three recorded legacy lease failures pass under UTC without legacy edits; include them in regression verification.
- Update the parity matrix each round; do not claim prior live-read tests verify snapshots.
