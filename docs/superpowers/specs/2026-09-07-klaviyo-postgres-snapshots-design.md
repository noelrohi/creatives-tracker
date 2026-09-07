# Klaviyo Postgres snapshots

## Direction and approval

This supersedes the live-read architecture in PR #264 and `2026-09-07-klaviyo-openapi-parity-design.md`.

The user selected:

- Keep snapshot history; serve the latest published snapshot by default.
- Refresh daily in background jobs and allow explicit manual refresh.
- Missing data returns `not_available`; GET requests neither fetch Klaviyo nor enqueue work.

The user approved the revised data-flow design. This document records its implementation contract for written review.

## Data flow

```text
Daily schedule / explicit administrator refresh
  → prepare a durable, org-scoped collection run
  → Trigger worker reads Klaviyo through the reviewed provider adapters
  → stage versioned rows and persist paging checkpoints in Postgres
  → atomically publish a successfully collected snapshot
  → retain prior published snapshots

OpenAPI GET
  → authenticate + check org/read scope
  → resolve the org's stored connection (no provider credential resolution)
  → select latest published snapshot for the requested scope, or explicit snapshotId
  → read a bounded Postgres page pinned to that snapshot
  → return records + snapshot/freshness/coverage metadata
```

A snapshot records what Adsolute observed during a collection run. It is not proof of Klaviyo's exact state at a single instant, and backfilling old events/reports does not reconstruct old campaign settings.

## Architecture choice

Use a versioned snapshot store under the existing Klaviyo connection, with the existing durable-job and transactional-publication patterns. Reuse the reviewed campaign, metric, event and campaign-values adapters from PR #264 inside workers. The adapters remain responsible for provider shape, minimization and API semantics, not persistence or API authorization.

Do not overwrite or reinterpret the current evidence tables:

- `klaviyo_marketing_object` is a latest-state metadata table with IDs referenced by attribution facts; it cannot supply historical subject/preview snapshots.
- Existing `klaviyo_event` rows have recognized event-family and identity/matching contracts. Arbitrary selected-metric source records must not enter that model accidentally.
- Existing report generations serve attribution-facing readers with their own publication scopes. New source snapshots must not become duplicate contributions to Shopify revenue or current report totals.

These existing stores and jobs continue operating. New snapshot tables hold the reviewed source-data versions needed by the four OpenAPI endpoints, not a second general connector platform. Pure shared field definitions may be extracted so the worker and DB reader use the same schemas.

Rejected alternatives: latest-row upserts lose observed history; request-time caching still makes GETs fetch provider data and hides missing coverage. Retrofitting every evidence table into a versioned source warehouse creates unnecessary risk to existing consumers.

## Postgres model

Add schema/migrations for four responsibilities:

1. **Sync definitions:** org/connection, dataset, selected metric IDs or conversion metric, fixed/rolling window policy, daily enabled flag, configuration version. Scope and configured account are server-owned. Manual one-off backfills do not silently become recurring work.
2. **Snapshots/runs:** org/connection, dataset, resolved request scope/fingerprint, schema/API revision, requested/provider windows and timezone, configuration version, collection start/end, publish time, state, durable checkpoint/lease, counts, fixed error codes and provider-coverage warnings.
3. **Snapshot records:** reviewed typed payloads associated with the snapshot, resource kind, stable provider/composite identity, stable page-order key and content digest. Index on snapshot plus ordering key; add event metric/time/profile lookup indexes needed for filtering and privacy erasure. Never persist the raw provider body.
4. **Private identity associations:** org/store/connection-scoped profile IDs associated with versioned email-suppression HMACs, independent of canonical event FKs. These are privacy-maintenance metadata, never part of OpenAPI record output. Retain previously observed associations while their referenced history survives so a profile email change cannot make old snapshots uneraseable.

Use composite foreign keys to enforce org/connection ownership, unique record identities within a snapshot and a transactional one-current-snapshot constraint per exact publication scope. Published records are immutable except for privacy deletion. Identical rows can share immutable content versions where practical; do not duplicate the same event payload merely to represent unchanged observations. Any shared versions must remain connection-scoped and support erasure across all referencing snapshots.

Do not attach new historical snapshots to existing short-lived sync-run rows through a cascading FK that would let unrelated run retention delete history. Their durable collection state has an explicit lifecycle owned by the snapshot module.

## Collection and publication

- Each dataset/request scope is an independently publishable unit. A campaign snapshot includes its campaign-message records and all six channel/archive traversals. One failed dataset does not erase successfully published snapshots of other datasets.
- Events snapshot the configured metric set/window, completing all metric cursor chains. Metric selection is persisted for recurring work; an ad-hoc read cannot expand the sync definition.
- Campaign values snapshot one conversion metric and exact requested window. Preserve requested UTC instants, provider wall-clock window, timezone and all 17 statistics.
- Persist every page and its checkpoint in one transaction. Retries upsert the same snapshot-record identity; they cannot double-count rows or skip an uncommitted page.
- Hold a scoped lease and use idempotent task handoffs. Expired workers cannot write/publish after a successor owns the lease. A stale configuration or older concurrent collection cannot replace a newer current snapshot.
- Publish only after every known page/chain has been collected and validated. Publishing records, marking the snapshot published and superseding the previous current pointer happen atomically.
- A failed/partial collection is not queryable as a published snapshot and does not replace the previous good one. An empty successful collection is distinguishable from failure or absence.
- Bound per-run pages, records, bytes and runtime; split durable work into resumable batches rather than extending an HTTP request indefinitely. Retain provider retry guidance and the separate low-quota report queue behavior.
- Provider continuation state is worker-only. Client continuations are DB pagination tokens and never contain or accept a Klaviyo cursor/URL.

**Publication is not provider-completeness certification.** For campaign reports, the documented lack of a next-cursor response contract remains a warning. A successful one-response collection can be published as `providerCompleteness: unverified`. If the provider explicitly indicates additional data that cannot be collected, fail that refresh as incomplete and keep the previous published snapshot; do not silently replace it with a known partial result.

## Refresh policy and controls

Daily work uses the existing daily Klaviyo cadence, with independent snapshot-stage failure handling so it cannot block consent, evidence, claims or existing report jobs. Eligible definitions belong to configured, ready connections. Full campaigns and metric catalogs can be refreshed without metric configuration; event and report work require explicit validated metric/window definitions rather than arbitrary hard-coded metric IDs.

Recurring windows are configured as bounded rolling-day windows; their exact instants are resolved once at run creation in the relevant timezone and persisted. Fixed historical windows can be requested for a one-off refresh or explicitly enrolled for repeated observation. Snapshot writes cannot reuse a moving `now` to change a run's scope mid-pagination. No automatic enrollment or inference from a GET request.

Add small administrator-only controls alongside existing sync operations:

- Configure/disable a daily sync definition.
- Request an explicit dataset/window refresh or backfill and return its durable snapshot/run ID immediately.
- Inspect collection status and list published snapshot history.

Reuse session-owner/admin authorization for changes and job triggers; ordinary read API keys cannot queue work or change sync scope. If exposed through OpenAPI, these control operations must document their session-only authentication accurately. No new credential onboarding UI, CLI, or marketing write capability is required. User-facing sync controls can reuse existing administrative surfaces; a new dashboard is not required for this slice.

## Four DB-backed reads

Keep the route names under `/api/openapi/klaviyoReads/`. This is a deliberate response-contract revision of the unmerged PR, not a claim of wire compatibility with its live implementation.

| Endpoint | Stored source and selection |
|---|---|
| `campaigns` | Latest published campaign/message snapshot for the connection; optional snapshotId |
| `metrics` | Latest published metric catalog snapshot; optional snapshotId |
| `events` | Published event snapshot matching the selected metric set and exact requested window; optional snapshotId |
| `campaignValues` | Published campaign-value snapshot matching conversion metric and exact requested window; optional snapshotId |

For this slice, do not compose overlapping event snapshots or aggregate report snapshots to satisfy a different range. A missing exact scope returns `not_available` and identifies the explicit sync request needed. Canonicalize equivalent input instants and metric-set identity consistently; preserve a deterministic event ordering regardless of the caller's metric parameter order.

All endpoints return a discriminated response:

- `state: available`: reviewed records, snapshot ID, collection interval/published time, requested/provider window where applicable, freshness state, provider-completeness status/warnings, privacy adjustment metadata and next DB continuation.
- `state: not_available`: fixed reason (`not_configured`, `not_synced`, `snapshot_not_found`, or `scope_not_synced`) and no fabricated empty result/zero. Do not reveal the existence of another org's snapshot.

The first page resolves the latest snapshot once. Its continuation includes the snapshot identity and ordering position; every later page remains pinned to it even if a new snapshot publishes. Validate org, dataset, request fingerprint and optional explicit snapshotId on each page. A missing/erased snapshot cannot fall through to an unrelated latest generation. Use stable DB ordering, not mutable offset pagination across generations.

Expose a 24-hour freshness target for daily definitions, but serve older successful data as stale rather than claiming it is fresh or fetching a replacement. Return the latest failed/running refresh status separately from the published snapshot's state. GETs require org/read access but neither a working provider key nor Trigger availability. Stored data remains readable during transient provider/configuration failures; an explicitly disabled or uninstalled connection remains inaccessible.

## History, retention and privacy

Published history remains stored; this change does not add age-based pruning of that new history. Storage growth and retention must be explicit in the documentation, not silently treated as an expiring cache. Existing 90-day attribution-evidence retention is unchanged and is not applied implicitly to these new source snapshots. This is a new durable storage purpose: the reviewed event envelope and its pseudonymous identifiers now persist, unlike the live PR. A later retention policy can prune historical versions without changing the latest-by-default read contract.

Privacy erasure is an exception to immutability and overrides history retention:

- Store the five reviewed public record contracts plus the explicitly private identity associations described above. No plaintext profile email/address/phone, full message bodies, arbitrary provider properties, raw response/error bodies or credentials.
- Existing email erasure discovers profile IDs through HMACs attached to canonical events. That is insufficient for profiles seen only in new arbitrary-metric snapshots. Workers must resolve profile email transiently and derive an email-suppression HMAC using the existing validated crypto policy, following the existing in-memory email/HMAC ingestion pattern. Neither email nor private identity metadata enters public projections, checkpoints or task logs.
- Extend email erasure to query the new profile associations as well as canonical evidence, establish profile tombstones and remove affected records from every historical and staging snapshot, including shared content versions. Check email tombstones during collection too, so an erasure that happened before the first snapshot still prevents persistence.
- If identity/suppression resolution for an identifiable event cannot be established, fail the refresh with an explicit privacy-resolution blocker instead of publishing inadequately erasable records or silently dropping rows. Keep the prior good snapshot. Never infer a Shopify customer identity from arbitrary profile `external_id` values. Customer-ID-only erasure requires an authoritative identity link; unresolved cases must not report successful erasure.
- Check suppressions before accepting event rows and again under the publication/erasure concurrency boundary. Use the existing store→connection lock order and crypto-policy checks for mapping acceptance, writes, publication and erasure. An old in-flight worker must not resurrect erased records after erasure commits.
- Mark affected published snapshots as privacy-adjusted, update visible counts consistently and keep ordering keys stable for remaining records. Historical responses must not claim untouched coverage after erasure.
- Connection uninstall cascades through definitions, snapshots, records and content versions. Preserve existing erasure tombstones and Shopify commerce evidence.

Live provider credentials are resolved only by background workers after checking the persisted connection/account binding. Logs, Trigger metadata and payloads carry safe IDs/counts, not record content or credentials.

## Module and test boundaries

The application-facing snapshot module exposes a small surface: configure daily work, request refresh, inspect history/status, and read a published page. It owns scope normalization, lifecycle, publication and privacy rules. Routers should not rebuild those rules independently.

Internal responsibilities:

- Snapshot contracts: reviewed schemas, scope/window normalization, response states.
- Snapshot store: Drizzle queries, staging/page commits, leases/current-pointer swaps and bounded reads.
- Collector: provider adapters plus durable batch/checkpoint processing; invoked by Trigger tasks, never GET handlers.
- Snapshot queries/service: authenticated DB-backed selection and safe responses, without importing the credential resolver or provider transport at runtime.
- Trigger adapters and existing daily orchestration: enqueue/poll durable work with safe scope/idempotency.

Use actual isolated PostgreSQL for transaction/FK/concurrency tests and injected provider responses for Klaviyo behavior. Preserve provider-parser tests; replace the HTTP tests' live-transport success assumptions with snapshot-backed fixtures.

Required proofs:

1. GETs return seeded snapshots when provider fetch and Trigger calls are set to throw; no credential resolution occurs.
2. All five reviewed record contracts round-trip through Postgres and the four APIs without losing fields or numeric/null semantics.
3. Latest/history selection, pinned pagination across a new publication, exact-window matching, valid empty snapshots and missing data states.
4. Page retry/idempotency, lease expiry, stale-worker rejection, mid-run failure, atomic publication and stale-data fallback.
5. Daily definition resolution/manual one-off refresh, scope changes, auth boundaries and safe job handoff recovery.
6. Uninstall cascades, cross-org snapshot/cursor rejection, and snapshot-only-profile email erasure before ingestion, during staging and after publication. Cover concurrent replay, changed email associations, unresolved identity fail-closed behavior, and no plaintext identity leakage.
7. Independent recompare against ecomconn field contracts plus existing Lab/flow/claim/report/evidence regression tests.

## Delivery and verification

Revise PR #264 rather than retain a live fallback. The existing single-PR size exception does not excuse missing migration or privacy review. Implement in verified rounds: schema/store and DB tests; collection/scheduling/erasure; API cutover and documentation; final compare/regression loop. Update the matrix each round; previous live-read passes are baseline evidence, not proof the new persisted design works.

Generate migrations with `bun run db:generate` and run the migration guard. Apply only to disposable local verification databases unless deployment is separately authorized. No automatic production migration, scheduled sync activation, backfill, live provider call or deployment is authorized by this design review.

Previously confirmed pre-existing lease-expiry failures in three Klaviyo DB tests remain recorded in the matrix. New snapshot lifecycle tests must pass independently; do not rely on those failing assertions as proof of correct lease behavior.
