# Klaviyo Claims, Journeys, and Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich stored Klaviyo conversion evidence with nullable campaign/flow claims, confirmed-event exact-profile journeys, and separately labelled aggregate reports without inventing missing relationships or affecting order matching.

**Architecture:** Traverse and persist marketing dimensions independently from conversion events, normalize only relationships proven by the pinned Klaviyo API revision and Reviv probe, and treat unavailable interaction detail as unknown. Journey reads reuse allowlisted event storage but anchor strictly to one conversion event and exact Klaviyo profile ID. Reporting uses a separate throttled queue and fact table whose records cannot enter the matcher.

**Tech Stack:** TypeScript, Drizzle ORM/PostgreSQL, Trigger.dev 4, tRPC 11, Zod, Vitest, Bun.

---

## Preconditions and data-separation rules

Start only after Plan 3 is committed, the full order-core source backfill has completed, and the Plan 3 stop/go gate says deterministic linkage is useful enough to enrich. If linkage is insufficient, defer this plan rather than building a claims-first dashboard.

Import `KlaviyoConnectionScope`, `HalfOpenWindow`, and allowed metric kinds from `src/lib/klaviyo/types.ts`, and match statuses/version from `src/lib/klaviyo/match-types.ts`. Reuse Plan 2's `src/schema/klaviyo.ts`, `source-store.ts`, `source-runner.ts`, `trigger/klaviyo-source-sync.ts`, and mounted router, plus Plan 3's match schema/services; do not create parallel event ingestion or router artifacts.

These terms are fixed:

- A **claim** is Klaviyo's nullable attribution chain attached to one stored conversion event. It is not Adsolute or Shopify attribution.
- A **journey event** shares the conversion event's exact Klaviyo profile relationship ID and occurs at or before conversion. HMAC never joins or expands a journey.
- A **report fact** is an aggregate with Klaviyo account-timezone and send-date semantics. It cannot be reconciled to individual Shopify orders.
- `unknown` is represented by null relationship/detail fields plus reason codes; do not manufacture an `unknown` marketing object or substitute names/aggregate reports.
- Event/marketing IDs may be returned to an owner/admin for debugging. Profile IDs, identity digests, secrets, full URLs, and unrestricted property data may not.

### Task 1: Add nullable marketing, claim, tracking, and report schema

**Files:**

- Modify: `src/schema/klaviyo.ts`
- Create: `src/schema/klaviyo-claim.ts`
- Modify: `src/lib/klaviyo/persistence.integration.test.ts`
- Create: `drizzle/0056_klaviyo_claims_reporting.sql`
- Create: `drizzle/meta/0056_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Write failing database-invariant tests.**

Extend the Plan 2/3 integration suite with these cases:

```ts
it("rejects a marketing object whose parent belongs to another connection");
it("deduplicates marketing objects by connection, type, and external id");
it("allows every unproven claim relationship to remain null");
it("rejects a claim whose conversion event belongs to another connection");
it("rejects an attributed interaction event outside the claim connection");
it("keeps one scoped replay state per source run match run and conversion event");
it("keeps one live claim replay graph per connection with a durable checkpoint and lease");
it("preserves replay-state history and claims on incomplete refresh");
it("keeps tracking settings scoped to their connection and marketing object");
it("deduplicates report facts by request fingerprint and fact dimensions");
it("exposes report facts only from the current successful generation");
it("keeps one current report generation per logical kind scope across asOf refreshes");
it("allows one staging generation per requested kind in a report sync run");
it("stores the connection's nullable last successful report-sync timestamp");
it("allows one running dimension or report sync per connection and operation");
it("cascades dimensions, claims, tracking, and reports on organization, store, or connection deletion");
```

- [ ] **Run the suite and confirm the tables are missing.**

```sh
bun run test -- src/lib/klaviyo/persistence.integration.test.ts
```

Expected: FAIL on missing `klaviyoMarketingObjects`, `klaviyoAttributionClaims`, `klaviyoClaimReplayRuns`, `klaviyoClaimReplayStates`, `klaviyoTrackingSettings`, `klaviyoReportGenerations`, and `klaviyoReportFacts` exports. A skipped database suite does not satisfy this step.

- [ ] **Define connection-scoped marketing objects and tracking settings.**

`src/schema/klaviyo-claim.ts` owns these object types and scopes:

```ts
export const marketingObjectTypes = [
  "campaign",
  "flow",
  "campaign_message",
  "flow_message",
  "flow_message_variation",
] as const;

export const trackingSettingScopes = [
  "account",
  "campaign_message",
  "flow_message",
] as const;

export const trackingValueModes = ["static", "dynamic"] as const;
```

`klaviyo_marketing_object` stores connection, type, external ID, nullable same-connection parent, name, nullable channel/status, provider timestamps, allowlisted tracking projection, source checksum, API revision, fetch timestamp, and timestamps. Uniqueness is `(connection_id, object_type, external_id)`.

`klaviyo_tracking_setting` stores connection, optional same-connection marketing object, scope, allowlisted parameter name, value mode, sanitized/redacted template/value, enabled state, API revision, and fetch timestamp. Checks require a null object only for account scope and the matching message-object type for message scopes. Configuration evidence never proves a visited URL.

- [ ] **Define attribution claims with deliberately nullable relationships.**

`klaviyo_attribution_claim` stores connection, the internal `klaviyo_event.id` conversion-event row ID, Klaviyo attribution ID, nullable attributed-interaction event row ID/external ID, nullable campaign/flow/message/variation object IDs, nullable external variation reference, nullable coarse interaction type, timestamp, channel, sanitized host/path, nullable bot-click flag, unknown-reason codes, fetch timestamp, API revision, and source checksum. The provider's conversion event ID is used transiently for API validation but is not substituted into this foreign-key column.

Require uniqueness on `(connection_id, conversion_event_id, klaviyo_attribution_id)`. Scoped conversion-event and resolved interaction-event foreign keys cascade their dependent claim on privacy deletion; an unavailable relationship is represented from ingestion time by the retained external ID plus an unknown reason, not by a guessed foreign key. Do not add `NOT NULL` to interaction, campaign, flow, message, variation, URL, channel, timestamp, or bot fields. Do not add a foreign key from a nullable external relationship ID to a guessed object.

Add `klaviyo_claim_replay_state` with organization/store/connection, successful order-core source-run ID, published match-run ID, internal conversion-event row ID, source checksum, status (`complete`, `incomplete`, or `failed`), expected/resolved claim counts, referenced-event fetch count, bounded safe reason codes, nullable `last_attempt_claim_replay_id`, attempt count, attempted/completed timestamps, and timestamps. Uniqueness is `(connection_id, source_run_id, match_run_id, conversion_event_id)`. Composite foreign keys require the source run, match run, conversion event, and exact `(match_run_id, conversion_event_id)` event-result anchor to share the full scope and cascade on deletion; before each write the service calls Plan 3's shared full dual-source publication verifier plus its exact current-claim-anchor verifier, not merely `matchRun.sourceRunId === sourceRunId`. Supersession is still a service-time currentness check because retained historical result rows remain referentially valid. The last-attempt graph ID is an internal UUID marker without provider meaning; it prevents one fresh graph's bounded failed-state retry phase from selecting the same state repeatedly. This table contains no provider values, URLs, HMACs, profile IDs, or raw errors; it is the durable per-conversion freshness/incompleteness record surfaced by coverage and inspector queries.

Add a separate `klaviyo_claim_replay_run` graph table. It stores opaque `id`/`claim_replay_id`, full organization/store/connection scope, exact source-run and match-run IDs, the internal-only typed checkpoint, status (`running | success | partial | failed | stale`), safe counts/reason code, `current_trigger_run_id`, `heartbeat_at`, `started_at`, and nullable `finished_at`. Its checkpoint has closed phase (`missing | incomplete_retry | failed_retry`), cursor tuple, separate bounded remaining incomplete/failed retry budgets, nullable exact `attempting_conversion_event_id`/occurred-at tuple, and stage (`idle | fetching | handoff`). Composite foreign keys require the source and match runs to share scope, and service validation requires Plan 3's full match-freshness proof at start plus its exact current event-result proof at selection and before every conversion commit/recovery. A partial unique index permits one `running` claim graph per connection; cross-source freshness mutations lock Shopify store, then Klaviyo connection, then graph row, and a 20-minute lease is the lifecycle guard. The checkpoint contains only internal row ID/time plus source/match IDs—never provider cursor/event ID, profile, raw response, or secret. Graph deletion does not cascade the durable per-conversion claim state; source/match/connection deletion still cascades both through their existing scoped parents.

- [ ] **Define aggregate report facts in a matcher-inaccessible table.**

Add `klaviyo_report_generation` under one scoped `reports` sync run, with exactly one generation row per requested report kind. Each row stores singular kind, requested range/account timezone, a logical `publication_scope_fingerprint`, an exact `refresh_fingerprint`, status (`staging | current | failed | superseded`), safe counts, created/published/superseded timestamps, and a composite scope/run foreign key. Uniqueness on `(sync_run_id, kind)` prevents duplicate staging rows. The publication-scope fingerprint covers kind, range, provider conversion metric, statistics, grouping, API revision, and account timezone but deliberately excludes refresh `asOf` and internal row IDs. The refresh fingerprint covers the same semantics plus `asOf`. A partial unique index permits one `current` generation per `(connection_id, publication_scope_fingerprint)`. A failed/partial sync leaves every staging generation non-current; reads never union one with a prior current generation in the same logical slot.

`klaviyo_report_fact` stores required generation ID, connection, the internal discovered conversion-metric row ID, report kind (`campaign` or `flow`), nullable same-connection marketing objects, requested `[from, to)` range, account timezone, grouping JSON, request fingerprint, fact fingerprint, nullable typed statistics (`conversions`, `conversionValue`, `recipients`, `uniqueClicks`, `uniqueOpens`), bounded allowlisted additional-statistics JSON, API revision, `asOf`, and fetch timestamp. Fact uniqueness is generation-qualified, and every fact kind/fingerprint must agree with its generation. The provider metric ID participates in the request/fingerprint and is available through the scoped metric relation; it is never written into the internal foreign-key column.

Require generation, conversion metric, and every nullable marketing-object reference to belong to the same connection. Add indexes for current-generation reads, `(connection_id, report_kind, requested_from, requested_to)`, request freshness, and marketing-object lookup. No event/order/match candidate table may reference `klaviyo_report_fact`.

Add nullable `lastReportSyncedAt` / `last_report_synced_at` to Plan 2's existing `klaviyo_connection`; it records only a fully published successful report refresh, not an attempt or partial page.

Add a partial unique index on `(connection_id, operation)` for `klaviyo_sync_run` rows whose status is `running` and operation is `dimensions` or `reports`. Plan 2's existing event-run index continues to serialize order-core and journey modes. Dimension/report start services lock the connection, reconcile an expired same-operation heartbeat through Plan 2's shared fixed-code finalizer, and use this new index only as the race-safe backstop.

- [ ] **Generate, inspect, apply, and verify migration 0056.**

```sh
bun run db:generate --name klaviyo_claims_reporting
git diff -- drizzle/0056_klaviyo_claims_reporting.sql drizzle/meta/_journal.json src/schema/klaviyo.ts src/schema/klaviyo-claim.ts
bun run db:migrate
bun run test -- src/lib/klaviyo/persistence.integration.test.ts
```

Expected: generated migration is `0056`; all tenant/connection FKs, nullability, cascades, unique keys, the running claim-graph and dimension/report partial unique indexes, claim heartbeat/checkpoint/status checks, and other indexes above are visible in SQL; migration and tests pass.

- [ ] **Commit the claims/report schema.**

```sh
git add src/schema/klaviyo.ts src/schema/klaviyo-claim.ts src/lib/klaviyo/persistence.integration.test.ts drizzle/0056_klaviyo_claims_reporting.sql drizzle/meta/0056_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(klaviyo): add claim and report schema"
```

### Task 2: Traverse campaigns, flows, messages, and tracking settings

**Files:**

- Modify: `src/lib/klaviyo/client.ts`
- Modify: `src/lib/klaviyo/client.test.ts`
- Create: `src/lib/klaviyo/dimensions.ts`
- Create: `src/lib/klaviyo/dimensions.test.ts`
- Create: `src/lib/klaviyo/dimension-repository.ts`
- Create: `src/lib/klaviyo/dimension-repository.integration.test.ts`
- Modify: `src/lib/klaviyo/source-store.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`
- Create: `trigger/klaviyo-dimensions.ts`

- [ ] **Write failing client contract tests from redacted fixtures.**

Cover both campaign channels explicitly, cursor pagination, campaign-message relationships, flow → action → message traversal, tracking-settings pagination, missing parents, disabled objects, rate-limit retry, and source responses containing unapproved fields. Each endpoint family uses a named pinned revision constant established by the current supported API and records it in the returned page; no call uses `revision: latest` or a shared mutable global revision.

Extend Plan 2's immutable revision map with exact family keys; for the approved 2026-07 implementation baseline they all pin independently even though they currently share a value:

```ts
export const KLAVIYO_API_REVISIONS = {
  accounts: "2026-07-15",
  metrics: "2026-07-15",
  events: "2026-07-15",
  campaigns: "2026-07-15",
  flows: "2026-07-15",
  trackingSettings: "2026-07-15",
  reports: "2026-07-15",
} as const;
```

Modify Plan 2's existing exported object in place. A later family upgrade changes one key and its fixtures independently.

The client additions are:

```ts
listCampaigns({ connectionId, channel: "email" | "sms", cursor })
listCampaignMessages({ connectionId, campaignId, cursor })
listFlows({ connectionId, cursor })
listFlowActions({ connectionId, flowId, cursor })
listFlowMessages({ connectionId, actionId, cursor })
getTrackingSettings({ connectionId, scope, externalId })
```

- [ ] **Write failing pure-normalization tests.**

Prove campaigns, flows, messages, and parent links normalize from documented/probed relationship IDs; absent relationships stay null; same external ID in different object types remains distinct; tracking templates go through bounded scalar/URL redaction; arbitrary response values do not survive; and flow-message variations are emitted only when the pinned live relationship exposes a stable external ID.

Use this result shape:

```ts
export type DimensionSnapshot = {
  objects: NormalizedMarketingObject[];
  trackingSettings: NormalizedTrackingSetting[];
  warnings: string[];
  sourceChecksum: string;
  apiRevisions: Record<string, string>;
};
```

- [ ] **Run contract and normalization tests to establish red.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimensions.test.ts
```

Expected: FAIL on missing dimension client methods/normalizer.

- [ ] **Implement client traversal and fail-closed normalization.**

Reuse Plan 2 pagination host validation, retry, redaction, and sanitized errors. Never derive parents from names. When a stable variation ID is absent, keep only a nullable redacted external-variation reference in later claim normalization; do not create a variation object.

- [ ] **Write failing repository/task tests.**

Prove page replay upserts by scoped external ID, complete traversal safely updates observed objects, partial/failed traversal preserves previous dimensions, checkpoints and heartbeat advance atomically after committed pages, foreign-parent connections are rejected, and the Trigger wrapper logs only safe IDs/counts. Add a multi-batch fixture proving every nonterminal committed checkpoint schedules exactly one syncRunId-only continuation with the checkpoint fingerprint key/TTL, replay schedules no duplicate, and an empty terminal page finishes success. Add lifecycle cases for a still-live run reuse, expired-run reconciliation before replacement, an ambiguous initial handoff, ordinary retry exhaustion, a skipped failure hook followed by lease expiry, and replay against an already-terminal run.

- [ ] **Implement repository and bounded Trigger.dev tasks.**

First widen Plan 2's concrete `finishKlaviyoSyncRun` operation union to include `dimensions | reports` and make its transaction executor injectable using the same pattern as the heartbeat/finalizer helpers. Add compile/integration tests for all five operations; a wrong operation/scope or second finish still fails. Report callers may use it only inside Task 5's atomic report-publication transaction.

Use the existing Klaviyo source queue or a dedicated `klaviyo-dimensions` queue with concurrency one. `startOrResumeDimensionSync(scope, now)` locks the connection, reaps an expired running `dimensions` row through Plan 2's executor-aware `failExpiredKlaviyoSyncRun`, reuses a still-live identical run, or inserts one protected by Plan 4's partial unique index. The exported task accepts exactly `{ syncRunId }`, resolves full scope/operation from that row, validates the account binding before calls, sets `maxDuration: 600`, processes bounded pages, renews the heartbeat before remote work, and checkpoints data/cursor/heartbeat together. Its result is discriminated `{ done: false, checkpoint } | { done: true, checkpoint: null }`. After a nonterminal commit, hash the validated persisted checkpoint and trigger exactly one `{ syncRunId }` continuation with key `klaviyo:dimensions:${syncRunId}:${checkpointHash}` created with explicit global scope and seven-day TTL. An empty/terminal traversal calls the widened scoped generic success finalizer exactly once and never enqueues. Its terminal `onFailure` calls Plan 2's `failKlaviyoSyncRunAfterRetryExhaustion` with operation `dimensions`, fixed safe text only, and no Trigger/provider error. Initial handoff uses `klaviyo:dimensions:first:${syncRunId}` with explicit global scope and seven-day TTL; ambiguous trigger failure finalizes that exact row. Because lifecycle hooks do not cover every terminal status, every start and bounded supervisor poll also applies expired-lease reconciliation. Previous dimensions remain queryable on all failures.

- [ ] **Run focused tests and lint.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimensions.test.ts src/lib/klaviyo/dimension-repository.integration.test.ts src/lib/klaviyo/source-store.integration.test.ts
bun run lint -- src/lib/klaviyo/dimensions.ts src/lib/klaviyo/dimension-repository.ts trigger/klaviyo-dimensions.ts
```

Expected: all commands exit 0.

- [ ] **Commit dimension ingestion.**

```sh
git add src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimensions.ts src/lib/klaviyo/dimensions.test.ts src/lib/klaviyo/dimension-repository.ts src/lib/klaviyo/dimension-repository.integration.test.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.integration.test.ts trigger/klaviyo-dimensions.ts
git commit -m "feat(klaviyo): ingest marketing dimensions"
```

### Task 3: Normalize and persist only proven attribution relationships

**Files:**

- Modify: `src/lib/klaviyo/client.ts`
- Modify: `src/lib/klaviyo/client.test.ts`
- Create: `src/lib/klaviyo/claims.ts`
- Create: `src/lib/klaviyo/claims.test.ts`
- Create: `src/lib/klaviyo/claim-repository.ts`
- Create: `src/lib/klaviyo/claim-repository.integration.test.ts`
- Create: `trigger/klaviyo-claims.ts`
- Read only: `src/lib/klaviyo/match-freshness.ts`

- [ ] **Write failing attribution and referenced-event fixture tests.**

Test `include=attributions` relationships on stored `Placed Order` events, one/many/missing attribution resources, missing campaign/flow/message/variation relationships, a referenced allowed interaction event, an unavailable referenced event, a referenced disallowed metric, open/delivery/SMS coarse types, missing interaction URL, unsafe URL, and nullable bot-click data. Use deliberately different internal/external conversion IDs; prove the client receives only the external ID, rejects a primary response with any other external ID, and the repository rejects swapped IDs or a row ID from another connection.

Reuse Plan 3's single closed `KlaviyoSingleEventRequest` union and `getEventById` client method; do not redeclare or narrow away its `identity_rotation` branch. This task implements/uses the union's two claim purposes with the same Events API revision, exact host validation, allowlist, sparse fields, redactor, and safe error handling as event-page ingestion. It fetches the stored conversion event by its provider ID with the exact relationship expansion needed to resolve the Plan 2 `attributionRelationshipIds`:

```ts
getEventById({
  connectionId,
  externalEventId,
  request: { purpose: "attribution_claim", include: ["metric", "attributions"] },
});
getEventById({
  connectionId,
  externalEventId,
  request: { purpose: "referenced_interaction", include: ["metric"] },
});
```

These are the union's only claim include tuples: conversion replay uses `metric + attributions`; referenced-interaction resolution uses `metric` only. The third and only other union member is Plan 3's sparse-profile `identity_rotation` request. No caller can pass an arbitrary include array or profile field. The purpose-discriminated response adapter returns the primary event, only the requested safe resources, the pinned revision, and a completeness result. Conversion completeness is true only when the primary event's fetched attribution-relationship ID set exactly equals the stored Plan 2 `attributionRelationshipIds`, every expected included attribution appears exactly once, no unrelated resource is accepted, and the source event lacks `attribution_relationship_truncated`. The bound is the Plan 2 maximum of 100 relationship IDs per conversion. There is no generic included-resource map in the normalized or repository input.

Do not add `getProfile`, `listProfiles`, or a generic unrestricted-resource fetcher.

- [ ] **Write failing claim labelling tests.**

The pure normalizer must satisfy:

| Source evidence | Stored/rendered meaning |
| --- | --- |
| Proven click event with safe link | click plus sanitized host/path |
| Open or delivery relationship | open/delivery; never relabelled click |
| Relationship ID but unavailable event | relationship retained, detail unknown |
| Referenced metric outside allowlist | relationship retained, detail unknown |
| Missing campaign/flow/message | null/unknown; never inferred from a report or name |
| Bot field absent | `null`; no bot warning |
| Bot field explicitly true | `true`; bot warning eligible |

Use this contract:

```ts
export type NormalizedAttributionClaim = {
  conversionEventRowId: string;
  conversionExternalEventId: string;
  attributionId: string;
  attributedInteractionEventId: string | null;
  marketingRelationships: {
    campaignId: string | null;
    flowId: string | null;
    messageId: string | null;
    variationId: string | null;
    externalVariationReference: string | null;
  };
  interaction: RedactedInteractionDetail | null;
  unknownReasonCodes: string[];
  sourceChecksum: string;
  apiRevision: string;
};
```

- [ ] **Run unit tests and confirm missing behavior.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/claims.test.ts
```

Expected: FAIL before referenced-event fetching and claim normalization exist.

- [ ] **Implement nullable normalization and allowlisted referenced-event resolution.**

Relationships are normalized only when their shape was recorded by the passed Reviv probe for the same pinned revision. The task selects each source as `{ conversionEventRowId: klaviyo_event.id, conversionExternalEventId: klaviyo_event.external_event_id }`; `getEventById` receives the external value, and its primary response must equal that external value exactly before normalization. Carry both values through the pure normalizer/repository input so the repository can re-resolve their full-scope pairing, but persist only `conversionEventRowId` in claim/replay foreign keys. Treat the source event's stored, de-duplicated `attributionRelationshipIds` as the expected set: reject unrelated included resources and cross-event attribution resources, and do not publish a complete replacement if the fetched relationship set differs, an expected included resource is missing, or the source event has `attribution_relationship_truncated`. `NormalizedAttributionClaim.attributedInteractionEventId` is the provider relationship ID. A referenced interaction event is fetched only by that supplied ID and normalized into the claim's bounded `RedactedInteractionDetail` only if its discovered metric maps to an approved family. The repository resolves the optional same-connection `klaviyo_event` foreign key only when that source event already exists; claim ingestion never inserts or updates `klaviyo_event` and therefore does not create a parallel event-ingestion path. If the event is absent or disallowed, preserve only the external relationship ID and an unknown reason; do not broaden API scopes.

- [ ] **Write failing repository and replay tests.**

Prove scoped upsert/replacement by `(connection, conversion event, attribution ID)`, no deletion after partial response, unknown-to-known update after a later refresh, known-to-unknown preservation on a failed refresh, cross-connection relationship rejection, source-checksum idempotency, and absence of disallowed source data. Add replay cases for a database page boundary, a failure after some conversion commits but before continuation, replay from the prior checkpoint, a terminal empty page, a source run with the wrong `sourceMode`, an attribution response that omits one expected relationship ID, a permanently truncated conversion followed by a valid conversion, per-conversion referenced-fetch overflow, total task-call budget exhaustion, and the injected soft deadline expiring between conversions and immediately before a referenced-event request. Replayed conversions remain idempotent. Incomplete/truncated conversion refreshes preserve the previous complete claim set, upsert an `incomplete` replay state with safe reason codes, and advance so later conversions are not starved. Excess referenced interactions remain claims with unknown detail and explicit cap reason codes; they do not make the relationship disappear. Add exhausted-retry tests proving a fixed-code failed replay state is written only for the exact persisted attempting conversion, its previous claims remain, another conversion is not mislabeled, and hook replay is idempotent. A skipped hook leaves the graph running only until its heartbeat expires; reconciliation then terminally fails it, preserves its checkpoint/claims, and releases the partial unique guard. In the critical partial-progress case, seed two conversions committed complete, persist the third as `attempting`, and fail it; recovery must mark only the third. Fail after those commits during continuation handoff and prove no fourth conversion is falsely failed; a deduped live continuation is recovered, otherwise only the graph fails. Supersede the exact bound event result between selection/provider fetch and fallback or commit and assert typed `superseded_skip` with no claim/state/count write while the partially overlapped 90-day match run remains active. Keep an untouched old event current and prove the same graph processes it; only zero remaining event anchors or full publication failure makes the graph `stale`. For a conversion with multiple referenced events, prove preflight selects and persists the conversion exactly once, every referenced-call preflight revalidates that same `attempting` anchor without cursor advancement, and an erasure/supersession between referenced calls stops the next request and discards partial response state. Change the gate, key check, or same-label environment secret during the final provider fetch and prove the commit writes no claim/replay/count state.

Also prove that a complete claim replacement updates `claimCount` only when `verifyCurrentClaimAnchor` returns the same run's unsuperseded confirmed selected order result through its exact selected edge. It must not change match status, method, confidence, candidate edges, product status, Shopify bucket, or any Shopify monetary field. Claims for current candidate, ambiguous, or unmatched event results—and confirmed events whose order result is `duplicate_conversion_events`—may be stored for unmatched-event/diagnostic views, but they do not receive a canonical order attachment or claim count; no-event orders have no conversion anchor.

- [ ] **Implement repository and a bounded claims task.**

The task reads only conversion events from one completed source run whose immutable parameters say `sourceMode: "order_core"` and whose canonical metric kinds are exactly `placed_order` and `ordered_product`. Use this durable continuation contract in the Trigger task graph:

```ts
export type ClaimReplayCheckpoint = {
  claimReplayId: string;
  sourceRunId: string;
  matchRunId: string;
  phase: "missing" | "incomplete_retry" | "failed_retry";
  afterOccurredAt: string | null;
  afterEventRowId: string | null;
  remainingIncompleteRetries: number;
  remainingFailedRetries: number;
  attemptingConversionEventId: string | null;
  attemptingOccurredAt: string | null;
  stage: "idle" | "fetching" | "handoff";
};

export const MAX_CLAIM_CONVERSIONS_PER_BATCH = 5;
export const MAX_CLAIM_REMOTE_CALLS_PER_BATCH = 25;
export const MAX_REFERENCED_EVENT_FETCHES_PER_CONVERSION = 10;
export const CLAIM_BATCH_SOFT_DEADLINE_MS = 480_000;
export const MAX_INCOMPLETE_CLAIM_RETRIES_PER_GRAPH = 5;
export const MAX_FAILED_CLAIM_RETRIES_PER_GRAPH = 5;
```

Run every claim batch on a dedicated `klaviyo-claims` queue with `concurrencyLimit: 1` for this one-connection pilot. `startOrResumeClaimReplay` locks the scoped Shopify store first and Klaviyo connection second, then inspects the one-running graph **before** any no-work return: it fixed-code reconciles an expired graph, reuses/returns pending for a live identical graph, and returns pending/conflict for a live different graph rather than bypassing the partial guard. With no live graph, call Plan 3's shared full publication-freshness verifier. If the fresh match was validly published with `expectedEventCount = eventResultCount = 0`, return typed `{ kind: "no_work"; matchRunId }` without creating a graph or calling the provider. Otherwise require at least one unsuperseded event-result anchor before inserting a new database-owned `claimReplayId`. A stale, fully entity-superseded nonempty match creates no graph. The queue limits provider load, while the database graph row is the correctness and terminal-status authority. Tests distinguish fresh empty `no_work` from stale/fully replaced, cover expired/live predecessors before no-work, and prove replay launches no child.

The exported task payload is exactly `{ claimReplayId }`. It loads the graph row/checkpoint and re-resolves the full scope and bound IDs. Before the **primary conversion fetch only**, one short transaction locks Shopify store then Klaviyo connection then the exact graph row, calls Plan 3's `verifyPublishedMatchFreshness`, and—only while stage is `idle`—selects the next conversion from that run's scoped event results where `klaviyo_event_match_result.superseded_at IS NULL`, joined to its exact source-run content observation. That proof covers the active publication, exact Shopify evidence run, exact order-core source run, both content/identity observation projections, both aggregate checksums, and the full fingerprint; `matchRun.sourceRunId === sourceRunId` alone is insufficient. For the selected row, the same transaction calls `verifyCurrentClaimAnchor`, validates the Plan 3 lifetime-registry+gate+store-policy+environment key checks, then atomically sets the exact `attemptingConversionEventId`/occurred-at tuple, stage `fetching`, and heartbeat before releasing locks. A retry already in `fetching` reloads that same tuple and never selects another. A full-publication failure terminalizes the graph `stale` without a provider call or claim write. An entity-only `event_result_superseded` race atomically advances that tuple as `superseded_skip`, increments a safe graph count, writes no per-conversion replay state/claim/count, and selects the next still-current event; only zero remaining current event anchors terminalizes the graph `stale`. Select at most five distinct values per task, ordered by `(occurredAt, conversionEventRowId)`. A partially overlapping publication can therefore replace one event without invalidating or stranding untouched anchors in the old run.

Immediately before **each referenced-interaction fetch**, open the same short store→connection→graph transaction and revalidate full publication freshness, the same persisted `fetching` attempting tuple through `verifyCurrentClaimAnchor`, and the lifetime-registry+gate+policy+environment binding; do not select, clear, or advance a conversion in this preflight. Release all locks before the provider call. Erasure, uninstall, result supersession, key drift, or gate change therefore prevents the next referenced request. The final per-conversion commit retains the independent recheck below. Same-label/different-secret fails before the primary or referenced client call and writes no claim state.

Remote fetches occur without database locks. Immediately before each per-conversion commit, acquire the scoped Shopify store lock, then Klaviyo connection lock, then exact graph row, call both `verifyPublishedMatchFreshness` and `verifyCurrentClaimAnchor` for the exact attempting conversion with that transaction executor, and revalidate the exact lifetime-registry+gate+store-policy+environment key-check binding used by preflight. Write claims/replay state/checkpoint/heartbeat only when all three remain valid. Use the returned nullable canonical order-result ID as the sole `claimCount` target. A full-publication failure makes the graph `stale`. If only the exact event result was superseded during the fetch, discard the response and atomically clear/advance the attempt as `superseded_skip` with no replay-state/claim/count write; continue to untouched anchors, or finish `stale` only when none remains. Gate/key drift discards the response with no claim/state/count write and leaves a safe recoverable attempt outcome. Add races for source projection changes, gate/key drift, and overlapping publication, including one where an untouched older event still completes after its neighbor is skipped.

Inject a monotonic `nowMs()` clock into the orchestration service, capture `startedAtMs` once, and stop before starting another conversion or issuing any provider request when `nowMs() - startedAtMs >= CLAIM_BATCH_SOFT_DEADLINE_MS`. Count every provider request. Before starting another conversion, reserve one call for its exact `getEventById({ externalEventId: conversionExternalEventId, request: { purpose: "attribution_claim", include: ["metric", "attributions"] } })`; stop the page and continue from the last attempted durable tuple when the 25-call task budget or soft deadline is reached. For one conversion, fetch at most ten referenced interaction events through the exact `referenced_interaction` request variant and never exceed the remaining task budget or deadline. Relationships beyond the per-conversion cap remain in the complete normalized claim set with null interaction detail plus `referenced_event_fetch_cap`; a call-budget or deadline stop before a conversion leaves that conversion unattempted for the next continuation. If the call budget or deadline is reached after the primary conversion fetch, retain unfetched relationships with null detail plus `task_remote_call_cap` or `task_soft_deadline`; do not silently drop them. The 480-second soft stop leaves cleanup and continuation scheduling headroom inside Trigger.dev's 600-second task limit.

Phase `missing` selects only absent or changed-checksum states and skips current complete/incomplete/failed states. On reaching its end, atomically transition once to `incomplete_retry` and reset the cursor. That phase selects current-checksum incomplete states whose `lastAttemptClaimReplayId` differs from this graph, marks each exact chosen state with this graph ID, and decrements its budget atomically. It then transitions once to `failed_retry`, which applies the same rules to current-checksum failed states and its separate budget. Exhausting either bounded phase advances to the next/terminal phase; unresolved states make the graph `partial`, and no phase rewinds itself. Tests cover crash/replay at both phase transitions and budget decrements, one prior incomplete/failed state among new missing rows, more retryable rows than each budget, unchanged-checksum incomplete evidence becoming complete later, and proof that a state is attempted at most once by one graph.

The pre-provider selection transaction above is the only path from `idle` to `fetching`; selection, full freshness, exact-anchor currentness, and the `attempting*` write are one atomic boundary. Task retry resumes that same source rather than selecting another. A successful/incomplete conversion commit clears `attempting*`, advances the cursor, and returns stage to `idle`. After a page commit and before child handoff, set stage `handoff` with no attempting conversion. This distinction prevents handoff failure from fabricating a conversion failure.

Commit claim rows, the source-run/match-run-bound `klaviyo_claim_replay_state`, and the graph's checkpoint/counts/heartbeat together per conversion. A complete conversion transaction replaces claims and writes `complete`. A source event already marked `attribution_relationship_truncated`, a fetched relationship-set mismatch, or another permanent completeness failure preserves the previous claim rows, writes `incomplete` with bounded reason/count metadata, and is still considered attempted for cursor advancement. A retryable transport failure aborts without advancing that conversion or graph checkpoint.

`claimReplayId` is the opaque server-generated primary key of one durable manual or incremental claim graph. It is unchanged across every continuation, task retry, and supervisor retry/replay. An independent scheduled/manual start must first observe or reconcile the one-running graph; only after that graph is terminal may it create a fresh ID. It is not provider authority.

Export `recoverExhaustedClaimBatch(claimReplayId, now)` with the closed result union `{ kind: "recovered"; checkpoint: ClaimReplayCheckpoint } | { kind: "superseded_skip"; checkpoint: ClaimReplayCheckpoint } | { kind: "handoff_recovered" } | { kind: "stale" } | { kind: "no_attempt" }`. It locks store then connection then the exact scoped running graph, loads its durable checkpoint, and calls the shared full match-freshness verifier. A full-publication failure atomically finalizes the graph `stale`. When stage is `fetching`, it additionally calls `verifyCurrentClaimAnchor` for the exact persisted `attemptingConversionEventId`; `event_result_superseded` clears/advances only that attempt, increments `supersededSkipped`, writes no claim/state/count, and returns `superseded_skip` while another current anchor exists (otherwise the graph becomes `stale`). A fresh anchor may mark only that exact attempted conversion failed; it validates the row/tuple against scope and phase, preserves prior claims/`claimCount`, advances/clears the attempt, and finalizes the graph `failed` with fixed `CLAIM_RETRIES_EXHAUSTED` metadata in one transaction. It never scans forward and labels an unattempted conversion. When stage is `handoff`, it first resolves the canonical persisted continuation key: a live/valid child is CAS-recorded and returns `handoff_recovered` while the graph stays running; otherwise it terminally fails only the graph with `CLAIM_HANDOFF_FAILED` and returns `no_attempt`, leaving the next conversion missing. An idle graph with no attempt similarly gets only a fixed graph failure. Configure the exported claim task with the repository retry policy, `maxDuration: 600`, and terminal `onFailure({ payload })` that validates exact `{ claimReplayId }` and calls this helper without passing `error`; all typed outcomes are successful hook completion. The hook is best-effort: `failExpiredClaimReplayRun` is the idempotent fallback for crash/cancellation/system failure and preserves all committed claims/state/checkpoint while releasing the running-graph guard after its 20-minute heartbeat lease.

The supervisor's initial handoff uses exactly `klaviyo-claims:first:${claimReplayId}` after validating the scoped graph's null cursor/`missing` phase. After a page commit, schedule one continuation carrying only `{ claimReplayId }` with `klaviyo-claims:${claimReplayId}:${sourceRunId}:${matchRunId}:${phase}:${sha256(persistedValidatedTuple)}`. Create both through `idempotencyKeys.create(key, { scope: "global" })` with an explicit seven-day TTL; never expose the external event ID or cursor material. Route the initial handoff and every self-continuation through `triggerOrRepairClaimBatch`. Like Plan 3's match helper, it reads the graph's `currentTriggerRunId` and checkpoint, returns a live/valid successful handle, retries an automatically cleared failed key, and follows a bounded deterministic `:recover:${sha256(previousTriggerRunId)}` global-key chain only for canceled or non-live terminal-without-valid-output handles. It never resets/versions an in-flight or valid successful run, uses at most three recovery hops, and revalidates that the graph is still running at the same checkpoint before each recovery. CAS-store the returned handle ID on the graph; crash after trigger-before-store reuses the same handle. Concurrent callers traverse the same chain. Add exact initial/continuation key, canceled-before-write, canceled-after-partial-progress, completed-with-invalid-output, failed-key, concurrency, recovery-bound, trigger-before-CAS crash, and skipped-hook lease tests.

Replay before scheduling is idempotent because claims/state, graph checkpoint, superseded-skip count, and child handoff are stable within that replay graph. A shared full-publication failure atomically finishes the graph `stale` without rewriting claims or another match run's `claimCount`. Exact entity supersession advances/skips only that tuple and continues untouched current anchors; it makes the graph stale only when no current event anchor remains. An empty terminal phase atomically finishes the graph `success` or `partial` according to its durable incomplete/failed counts and never enqueues. A fresh manual/incremental graph processes missing or changed-checksum conversions first, then bounded unchanged-checksum `incomplete` retries, then bounded `failed` retries; its phase/graph markers prevent starvation or repeat loops, and its global keys cannot return a prior graph's successful child. A successful retry may move incomplete/failed to `complete`, while repeated incompleteness/failure remains visible.

Persist this checkpoint only on the dedicated `klaviyo_claim_replay_run`; the Trigger payload carries only its internal ID. The committed design's `klaviyo_sync_run` operation check still has no `claims` value, so do not invent one or overload an event-source coverage run. Export scoped `renewClaimReplayHeartbeat`, `finishClaimReplayRun`, and `failExpiredClaimReplayRun` helpers with fixed safe terminal codes, optional transaction executor, and idempotent terminal handling. A standalone heartbeat/lease operation that does not inspect match freshness may use connection-then-graph order. Any freshness-sensitive finish/fail/recovery path first locks store then connection then graph, passes that existing transaction into these helpers, `verifyPublishedMatchFreshness`, and the exact-anchor helper when a conversion is selected/attempting, and never reacquires or reorders locks. Claim-row fetch timestamps/checksums plus the graph status provide freshness. Record only safe counts/revision/run IDs. The task must not update match methods/statuses or Shopify orders.

- [ ] **Run focused tests and lint.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/claims.test.ts src/lib/klaviyo/claim-repository.integration.test.ts
bun run lint -- src/lib/klaviyo/claims.ts src/lib/klaviyo/claim-repository.ts trigger/klaviyo-claims.ts
```

Expected: exit 0.

- [ ] **Commit claim ingestion.**

```sh
git add src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/claims.ts src/lib/klaviyo/claims.test.ts src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claim-repository.integration.test.ts trigger/klaviyo-claims.ts
git commit -m "feat(klaviyo): ingest nullable attribution claims"
```

### Task 4: Ingest allowlisted journey events and build exact-profile timelines

**Files:**

- Modify: `src/lib/klaviyo/types.ts`
- Modify: `src/lib/klaviyo/source-store.ts`
- Modify: `src/lib/klaviyo/source-store.test.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`
- Modify: `src/lib/klaviyo/source-runner.ts`
- Modify: `src/lib/klaviyo/source-runner.test.ts`
- Modify: `trigger/klaviyo-source-sync.ts`
- Create: `src/lib/klaviyo/journey.ts`
- Create: `src/lib/klaviyo/journey.test.ts`

- [ ] **Write failing journey-ingestion tests.**

Generalize Plan 2's existing source runner/batch task rather than adding a second runner or task loop. Order-core and journey supervisor entry points must delegate to that one mode-aware engine. Journey mode uses only discovered allowlisted metrics: `clicked_email`, `clicked_sms`, `active_on_site`, `viewed_product`, `added_to_cart`, and `checkout_started`. Reuse the source store, page machinery, `klaviyo-events` queue, 600-second task duration, heartbeat lease, initial-handoff idempotency helper, terminal `onFailure` hook, retry-exhaustion finalizer, and expired-run reconciler. The generalized event task passes operation `events` to the same finalizer regardless of source mode; do not accidentally retain the hook only on the order-core branch. Prove the 90-day requested window, trailing-seven-day refresh, sparse profile-email include, in-memory HMAC conversion, page checkpoints, heartbeat renewal, exhaustion/lease recovery, and source/digest upsert behavior are identical to order-core ingestion. Before every journey provider request, reuse Plan 3's lifetime-registry+gate+store-policy+environment preflight; revalidate it at commit, and prove same-label/different-secret or erasure/uninstall races cause no further call/write. Journey queries still anchor solely on exact `profileId`; neither current nor previous HMAC may add a timeline event. The generic Plan 3 erasure/rotation source selectors cover every retained digest-bearing Klaviyo event regardless of order-core/journey mode, while matching selects only order core. A missing/ambiguous metric is reported as unavailable; it is never selected by display name alone.

Plan 2's checkpoint currently gives `metricIndex` no source-set identity. Replace its order-core-only persistence boundary with one closed discriminated union owned by `types.ts`, so resume cannot reinterpret a journey index as order core (or vice versa):

```ts
export const KLAVIYO_JOURNEY_KINDS = [
  "clicked_email",
  "clicked_sms",
  "active_on_site",
  "viewed_product",
  "added_to_cart",
  "checkout_started",
] as const;

export type KlaviyoEventSourceContract =
  | { sourceMode: "order_core"; metricKinds: ["placed_order", "ordered_product"] }
  | { sourceMode: "journey"; metricKinds: typeof KLAVIYO_JOURNEY_KINDS };

export type KlaviyoEventRunParameters = KlaviyoEventSourceContract;

export type KlaviyoEventCheckpoint = KlaviyoEventSourceContract & {
  metricIndex: number;
  cursor: string | null;
  page: number;
};
```

`KlaviyoEventRunParameters` and `KlaviyoEventCheckpoint` are closed over this union rather than accepting arbitrary arrays. Add one `assertExactEventSourceContract` dispatcher; retain Plan 2's order-core assertion as a narrowing helper. `commitKlaviyoEventPage` accepts `sourceContract: KlaviyoEventSourceContract`, validates the run request parameters plus expected/next checkpoints through the dispatcher, and keeps the existing full-scope transaction/checkpoint compare-and-set. Missing journey metrics are recorded unavailable at their canonical index; the tuple is never shortened or reordered.

Create the immutable, canonical metric-kind list when the run starts and persist the exact `KlaviyoEventRunParameters` in `klaviyo_sync_run.request_parameters`; copy the same values into the live checkpoint for compare-and-set safety. Validate both copies against each other, `sourceMode`, and the discovered approved metrics on every resume and inside `commitKlaviyoEventPage`; reject any mismatch before a remote call or write. Update order-core checkpoint construction and source-store unit/integration tests to the same final union—do not infer mode from an old index or mutable discovery order. Prove both modes commit/replay, renew the same lease, use source-mode-plus-syncRunId first/continuation keys created with explicit global scope and seven-day TTL, become terminal failed through the same hook after exhausted retries, reconcile an expired crashed/canceled attempt before a replacement, reject cross-mode checkpoint reuse and altered/reordered lists without writes, and leave another tenant's run/event rows unchanged.

Plan 2 clears a successful run's terminal checkpoint to `null`; it must not clear or rewrite these immutable request parameters. Add tests proving a terminal order-core run and a terminal journey run with the same window remain distinguishable, completed-run selectors and claim/backfill gates read `requestParameters.sourceMode` plus `metricKinds`, and `syncRuns` projects a safe source-mode label even after the checkpoint is null. Running-run idempotency compares scope, window, source mode, and canonical metric list; the one-running-events index may serialize the modes, but one mode can never resume the other's run.

When adding the journey start entry point, use Plan 2's same connection-locked start/resume primitive. It first reaps an expired `events` row with the shared executor-aware lease finalizer; it resumes only a still-live journey row with the identical canonical source contract/window, and rejects a still-live order-core or different-window row. Its initial Trigger handoff uses the shared helper with a journey-qualified `syncRunId` key and seven-day TTL; an ambiguous handoff failure finalizes that exact row. The one generalized batch task retains Plan 2's `onFailure`, re-resolves the run's source mode from immutable parameters, and never trusts source mode in a task payload.

- [ ] **Write failing pure journey tests.**

Cover 7/30/90-day lookbacks, range clipping to successful canonical journey coverage, exact profile-ID equality, exclusion of later events, inclusion at the exact conversion timestamp, attributed interaction inclusion when canonically ingested, deterministic chronological ordering, duplicate source-event elimination, profile merge caveat, and rejection of HMAC-only or cross-profile expansion. Seed overlapping successful 90-day and trailing-seven-day journey runs and prove the latest successful observation is selected per event. Then seed a later partial/failed journey run that mutates/adds event rows and prove neither an observation owned only by that run nor a current checksum that disagrees with the latest successful observation reaches the timeline.

Use this API:

```ts
export type JourneyLookbackDays = 7 | 30 | 90;

export function buildOrderJourney(input: {
  conversion: JourneyConversionEvent;
  attributedInteraction: JourneyEvent | null;
  profileEvents: JourneyEvent[];
  lookbackDays: JourneyLookbackDays;
  ingestedFrom: Date;
}): {
  label: "same_klaviyo_profile";
  events: JourneyEvent[];
  clipped: boolean;
  caveats: string[];
};
```

- [ ] **Run focused tests and establish red.**

```sh
bun run test -- src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/journey.test.ts
```

Expected: FAIL on missing journey mode/builder.

- [ ] **Implement allowlisted ingestion and exact-profile timeline construction.**

Query candidate journey events by the confirmed current order result's selected conversion event and that event's stored Klaviyo profile relationship ID inside one connection and bounded time range. Candidate, ambiguous, duplicate-conversion, no-event, and not-evaluated orders have no canonical journey. Never query by HMAC and never join profiles. Label the result exactly `same_klaviyo_profile`; a profile ID is pseudonymous source evidence, not proof of a Shopify person.

An event is eligible for the timeline only through an immutable `klaviyo_event_run_observation` owned by a terminal `success` run with `checkpoint IS NULL`, `requestParameters.sourceMode === "journey"`, and the exact canonical journey metric list. Across the successful run windows intersecting the requested lookback, select the latest successful observation per event by `(finishedAt, syncRunId)` and require its immutable observed checksum to equal the current event checksum. This per-event overlay lets a successful trailing-seven-day refresh replace observations in that slice while an earlier successful 90-day run continues to cover older events. Never use partial/failed/running observations, never fall back to an older successful observation after a newer successful checksum mismatch, and never expose a row introduced or mutated only by a failed refresh. Derive `ingestedFrom`, clipping, gaps, and stale warnings from the union of these successful canonical run intervals and validated observations, not from a generic latest `events` run.

The directly attributed interaction remains available as separately labelled claim detail. It enters the journey's chronological `events` array only if it independently passes the same successful-journey-observation and checksum rule; a claim-time single-event fetch is not journey publication. Add source-store/query tests for overlapping runs, latest-per-event selection, checksum mismatch, failed partial mutation, coverage gaps, and cross-connection observations.

- [ ] **Run focused tests and lint.**

```sh
bun run test -- src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/journey.test.ts
bun run lint -- src/lib/klaviyo/source-store.ts src/lib/klaviyo/journey.ts src/lib/klaviyo/source-runner.ts trigger/klaviyo-source-sync.ts
```

Expected: exit 0.

- [ ] **Commit journey enrichment.**

```sh
git add src/lib/klaviyo/types.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/source-runner.ts src/lib/klaviyo/source-runner.test.ts trigger/klaviyo-source-sync.ts src/lib/klaviyo/journey.ts src/lib/klaviyo/journey.test.ts
git commit -m "feat(klaviyo): add profile-scoped journeys"
```

### Task 5: Fetch aggregate reports through a separate low-quota path

**Files:**

- Modify: `src/lib/klaviyo/client.ts`
- Modify: `src/lib/klaviyo/client.test.ts`
- Create: `src/lib/klaviyo/reports.ts`
- Create: `src/lib/klaviyo/reports.test.ts`
- Create: `src/lib/klaviyo/report-repository.ts`
- Create: `src/lib/klaviyo/report-repository.integration.test.ts`
- Create: `trigger/klaviyo-reports.ts`

- [ ] **Write failing report-request and normalization tests.**

Test campaign and flow report kinds, explicit discovered native `Placed Order` conversion metric IDs, account-timezone range, send-date grouping, typed core statistics, allowed extra statistics, unknown statistic dropping/fingerprinting, pagination, asynchronous/partial response states if returned by the pinned endpoint, and malformed numeric values. Seed deliberately different internal metric-row and provider metric IDs; prove the API filter/fingerprint uses only the provider ID, persistence uses only the scoped internal row ID, and swapping either value or using a row from another connection fails closed.

Define a deterministic request type:

```ts
export type KlaviyoReportRequest = {
  connectionId: string;
  kind: "campaign" | "flow";
  conversionMetricRowId: string;
  conversionExternalMetricId: string;
  timeframe: { from: string; to: string };
  statistics: Array<
    "conversions" | "conversion_value" | "recipients" | "unique_clicks" | "unique_opens"
  >;
  grouping: KlaviyoReportGrouping[];
  apiRevision: string;
  asOf: string;
};

export const KLAVIYO_REPORT_FRESHNESS_MS = 24 * 60 * 60 * 1000;
export const KLAVIYO_REPORT_MIN_INTERVAL_MS = 1_100;
```

`KlaviyoReportGrouping` is a closed union of the grouping keys supported by the pinned campaign/flow endpoint and approved probe (including send date and the relevant marketing-object key); arbitrary browser/provider strings are rejected.

Load both conversion metric identifiers from the same full-scope discovered canonical `placed_order` row. `conversionMetricRowId` is used only for scoped foreign-key validation/persistence; `conversionExternalMetricId` is sent in the provider API filter and included in both canonical fingerprints. `publicationScopeFingerprint` covers every provider-semantic field above except pagination cursor and `asOf` (and does not substitute the internal row ID for the external ID); it identifies the one logical current slot for that singular report kind. `refreshFingerprint` covers the same fields plus `asOf`, so an explicit full-window refresh after attribution-setting changes is never suppressed by an older cached request while still replacing the prior generation in the same logical slot.

- [ ] **Run unit tests and confirm report support is missing.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/reports.test.ts
```

Expected: FAIL before report client/normalizer exports.

- [ ] **Implement report client and pure normalization.**

Use a report-family revision constant and Plan 2 retry/error sanitation. Before the request, re-resolve the full-scope metric row and require both IDs to match it; send only `conversionExternalMetricId` to Klaviyo and persist only `conversionMetricRowId` as the report fact's conversion-metric foreign key. Preserve Klaviyo's account timezone and send-date semantics in every normalized fact. Never look up a Shopify order or event from report code.

- [ ] **Write failing cache, throttle, and stale-data tests.**

Prove generation-scoped fact upserts, request/fact fingerprint replay within one generation, freshness expiry, explicit refresh with new `asOf`, and separate campaign/flow publication slots. A changed `asOf` must produce a new refresh fingerprint but the same publication-scope fingerprint and supersede the prior current generation. Publish a combined `[campaign, flow]` refresh, then a campaign-only refresh: only the campaign slot is replaced and exactly one older flow generation remains current, with no overlapping campaign current. Test the server-derived reason contract: an all-fresh `scheduled` request creates no sync run/generation/task; a mixed campaign-fresh/flow-stale scheduled request stages only flow; a `manual` request stages every requested kind even when fresh and uses the new `asOf`; replay returns the same preflight outcome/run. No task-side cache hit may publish an empty staging generation or leave it running. During a multi-page refresh, every new fact remains in its staging generation and reads continue returning only the previous current generation for each affected slot. Partial/failure marks every staging generation for that sync failed/non-current while preserving previous facts and `lastReportSyncedAt`; no path writes event/match/order tables. Test that at most one low-quota request is in flight and the injected spacer is awaited between calls. Add a multi-batch fixture proving each nonterminal committed checkpoint schedules exactly one syncRunId-only checkpoint-keyed continuation, replay deduplicates it, and the terminal empty/complete page atomically swaps all affected per-kind generations, publishes sync success/freshness, and launches no child. Add the same live-reuse, expired-replacement, ambiguous-handoff, exhausted-retry, skipped-hook/lease, and terminal-replay cases as dimensions, plus rollback at each swap step.

Add a dedicated retry/concurrency case in which the clock advances between two compatible manual calls: both must return the same live `syncRunId`, persisted `asOf`, refresh fingerprints, and staging generations. Only a call after that graph is terminal may derive a new `asOf`.

- [ ] **Implement repository and dedicated report queue.**

Use this queue independently of discovery/events/dimensions:

```ts
const KLAVIYO_REPORTS_QUEUE = {
  name: "klaviyo-reports-low-quota",
  concurrencyLimit: 1,
};
```

`startOrResumeReportSync` accepts a server-derived `reason: "manual" | "scheduled"` and uses the same connection lock, Plan 4 partial unique indexes, and Plan 2 heartbeat/expired-run primitives as dimensions. Under that lock it canonicalizes the requested kind/range/config scope **without deriving a new `asOf` first**, reconciles an expired report run, and looks for a compatible live run with the same scope, requested kinds, and reason. A compatible live run is returned with its persisted `asOf`, per-kind fingerprints, and staging set; a different live run is rejected. This makes retries and concurrent manual calls reuse one graph rather than generating a different fingerprint on each clock tick.

Only when no live run exists does preflight inspect current slots. A scheduled request filters out fresh kinds and returns `{ kind: "fresh" }` without creating database/Trigger work when none remain; a manual request retains all requested kinds. The service then captures one server-derived `asOf`, computes per-kind publication-scope/refresh fingerprints and a sorted refresh-set fingerprint, and creates the `reports` sync row plus exactly one scoped `staging` generation per stale/forced kind in the same transaction. The partial unique index resolves concurrent no-live races; the loser reloads and validates the winner rather than deriving another `asOf`. The exported task accepts exactly `{ syncRunId }`, resolves the full stored scope, operation `reports`, and nonempty staging generations, sets `maxDuration: 600`, renews before remote work, uses an injected request spacer for testability, and commits each normalized page only into its matching kind generation with checkpoint/heartbeat/counts. Freshness is decided before run creation, never inside the task. Return the same discriminated `{ done, checkpoint }` contract as dimensions. After every nonterminal commit, hash the validated persisted checkpoint and trigger exactly one `{ syncRunId }` continuation with key `klaviyo:reports:${syncRunId}:${checkpointHash}` created with explicit global scope and seven-day TTL.

A terminal empty/complete page never enqueues. `publishTerminalReportSync` owns one transaction that locks the connection and all staging generations in canonical kind order, revalidates the exact refresh set and completeness, and for each affected publication-scope fingerprint marks its prior current generation `superseded` before marking the corresponding staging generation `current`. It then calls the executor-aware `finishKlaviyoSyncRun({ operation: "reports", status: "success" }, tx)` and advances `klaviyo_connection.lastReportSyncedAt`; any failure rolls back the entire multi-kind swap. A campaign-only refresh never touches the flow slot. Reads join only the one `current` generation for each requested publication slot. A report-specific fixed-code failure/expired-run wrapper marks every staging generation for that sync `failed` and calls the Plan 2 sync finalizer in one transaction; the task's `onFailure`, ambiguous initial handoff, and supervisor lease reconciliation use that wrapper rather than the generic finalizer alone. Previous current facts remain visible on every partial/failure path. Replay may retain the existing successful generations/timestamp, while partial/failure never advances freshness. Add rollback tests at each write and prove no other code directly finishes a successful report run or marks a generation current.

- [ ] **Run focused tests and lint.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/reports.test.ts src/lib/klaviyo/report-repository.integration.test.ts
bun run lint -- src/lib/klaviyo/reports.ts src/lib/klaviyo/report-repository.ts trigger/klaviyo-reports.ts
```

Expected: exit 0.

- [ ] **Commit aggregate reporting.**

```sh
git add src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/reports.ts src/lib/klaviyo/reports.test.ts src/lib/klaviyo/report-repository.ts src/lib/klaviyo/report-repository.integration.test.ts trigger/klaviyo-reports.ts
git commit -m "feat(klaviyo): ingest aggregate campaign and flow reports"
```

### Task 6: Extend the scoped tRPC surface for claims, journeys, inspector, and reports

**Files:**

- Modify: `src/lib/klaviyo/queries.ts`
- Modify: `src/lib/klaviyo/queries.test.ts`
- Modify: `src/lib/trpc/routers/klaviyo.ts`
- Modify: `src/lib/trpc/routers/klaviyo.test.ts`

- [ ] **Write failing safe-projection tests.**

Add query-service cases for claim chains with nullable nodes, interaction detail unknown reasons, per-conversion claim replay status/reason counts, exact-profile journey lookbacks, coverage clipping, a normalized/redacted inspector projection, masked profile/identity IDs, aggregate report pagination/freshness, and report/order separation. Coverage and health distinguish complete/incomplete/failed claim conversions without returning raw errors or external interaction IDs. A uniquely confirmed order returns its selected event's canonical claim chain plus replay freshness; an incomplete refresh continues to show the preserved prior chain with an explicit stale/incomplete caveat. `orderClaims` and `orderInspector` also accept an optional `candidateId`; the server proves that edge belongs to the requested current scoped result before returning its event evidence. Candidate, ambiguous, and duplicate-conversion selections are explicitly labelled per-edge/non-canonical and never change the stored result or merge chains. No-event and not-evaluated orders have no candidate chain. Assert the inspector never returns the raw Klaviyo payload, full email HMAC, profile ID, full URL/query, arbitrary property name/value, or existing raw Shopify `customerJourney` JSON.

The only Shopify journey projection permitted here is a newly sanitized object containing allowlisted bounded UTM values and safe path/host fields produced by Plan 2 redaction utilities.

- [ ] **Write failing tRPC tests for the added procedures.**

Extend the existing `klaviyoRouter` with:

```ts
orderJourney
orderClaims
orderInspector
reports
refreshReports
```

For `refreshReports`, prove the router supplies server-derived `reason: "manual"`, prepares/reuses one scoped report sync run, sends only its internal `syncRunId`, creates the report-qualified idempotency key with explicit global scope and seven-day TTL, finalizes that exact row on an ambiguous handoff error, and never exposes connection/run authority supplied by the browser. The incremental supervisor is the only caller that supplies `reason: "scheduled"` and must not trigger when preflight returns all-fresh.

`orderJourney` accepts `lookbackDays: 7 | 30 | 90` and remains confirmed-selected-event only; `candidateId` never expands a journey. Plan 3's `orderProducts` accepts optional `candidateId`: its canonical product conclusion remains confirmed-only, while a valid scoped candidate returns a separately labelled per-edge diagnostic comparison with no published product status. `orderClaims` and `orderInspector` accept the optional opaque `candidateId` described above. `reports` uses bounded server pagination and explicit `campaign | flow` kind; it resolves the requested logical publication slot and reads facts only from that slot's single `current` generation, never staging/failed/superseded rows or a union of overlapping generations. Browser-facing report ranges use inclusive `{ dateFrom, dateTo }` calendar dates; the router resolves the connection's account timezone and converts them to a half-open internal window, including DST cases. `refreshReports` accepts that date contract plus explicit report kinds, calls `startOrResumeReportSync`, and hands off its exact `{ syncRunId }` through the report-qualified key created with explicit global scope and seven-day TTL; ambiguous trigger failure calls the scoped fixed-code report finalizer before returning a safe error. Every procedure uses `orgAdminProcedure`, derives organization scope from `ctx`, and returns `NOT_FOUND` for cross-tenant IDs.

- [ ] **Run focused tests and establish red.**

```sh
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: FAIL on missing query projections/procedures.

- [ ] **Implement safe read models and router wiring.**

Keep report facts in their own query/result type. Order claims may reference dimensions through nullable IDs, but must not copy aggregate report values into the chain. Return source freshness and caveats with every journey, claim, inspector, and report payload.

- [ ] **Run focused tests.**

```sh
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS.

- [ ] **Commit the enrichment API.**

```sh
git add src/lib/klaviyo/queries.ts src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(klaviyo): expose claims journeys and reports"
```

### Task 7: Add gated incremental orchestration and prove isolation

**Files:**

- Create: `src/lib/klaviyo/incremental-sync.ts`
- Create: `src/lib/klaviyo/incremental-sync.test.ts`
- Create: `trigger/klaviyo-incremental.ts`
- Create: `src/lib/klaviyo/claims-reporting-isolation.integration.test.ts`
- Read only: `src/lib/klaviyo/match-invocation.ts`
- Read only: `src/lib/klaviyo/match-freshness.ts`

- [ ] **Write failing incremental-gate tests.**

Prove the daily and manual workflows skip pending/degraded/disabled connections, passed-probe-but-incomplete-backfill connections, and connections lacking a fully fresh current published match. The gate imports Plan 3's shared verifier; an unsuperseded match whose Shopify or Klaviyo content/identity observation changed is stale and launches no claim work. Backfill completeness and matching must select successful terminal event runs by immutable `requestParameters.sourceMode === "order_core"` and exact `metricKinds === ["placed_order", "ordered_product"]`, never by a now-null checkpoint or the generic/latest `events` operation alone; seed a later same-window journey run and prove matching still selects order core. Use an injected clock/status reader to prove every database-terminal poll is bounded, renewals prevent live-run reaping, an expired Shopify/source/dimension/report/claim-graph run is fixed-code finalized once, and a still-live run at the supervisor deadline returns `pending`/stale without launching a dependent or overwriting it.

For a ready connection, prove this strict core graph and call order:

1. Trigger Plan 1's `shopify-evidence-start` exactly once with `{ mode: "incremental_7d" }`; retain the child result's Trigger run ID before branching on `ok`, then store its distinct successful `{ evidenceRunId, triggerRunId }` and poll the database by `evidenceRunId`, never by the Trigger ID. On a non-ok child, use only the result run ID to resolve any row by `startTriggerRunId` and invoke the idempotent fixed-code start finalizer; no output access or dependent launch occurs.
2. Wait for terminal acceptable Shopify coverage. `success + complete` is acceptable; a policy-labelled `partial + partial` is acceptable but stays visibly partial. `running`, `failed`, or `lineCompleteness: "unavailable"` is not acceptable and launches no dependent task.
3. Call Plan 2's connection-locked `startOrResumeOrderCoreSync`, which first reaps only an expired event lease, then hand off exactly one canonical order-core child for the same trailing-seven-day range using its syncRunId key. Poll that exact row with the bounded lease-aware reader; require terminal `success`, a null checkpoint, and exact immutable order-core parameters, then retain that exact `sourceRunId`. Partial/failed/live-at-deadline order core launches neither matching nor claims.
4. Trigger matching with that exact acceptable `shopifyEvidenceRunId` from step 2 and exact `sourceRunId` from step 3; wait for atomic dual-source publication and retain the distinct returned `matchRunId`. A running/unpublished/failed/stale match launches no claims.
5. Call `startOrResumeClaimReplay({ sourceRunId, matchRunId })`, which first proves full dual-source match freshness. A valid zero-event publication returns `no_work` and the supervisor records a completed skipped stage without a Trigger child. Otherwise it requires at least one current event-result anchor, reaps only an expired graph, and reuses the exact live graph or creates a new database-owned `claimReplayId`. Flush that ID plus the canonical initial key/stage, then call `triggerOrRepairClaimBatch` in durable wait mode with only `{ claimReplayId }`. When the initial child wait resumes, capture `result.id` as `claimTriggerRunId`, flush it before inspecting `result.ok` or output, and apply the fixed fallback on non-ok. A successful initial batch is not graph completion: poll the exact `klaviyo_claim_replay_run` to terminal with the bounded lease-aware reader, using its `currentTriggerRunId` to repair a canceled continuation when safe. Accept terminal `success` or visibly incomplete `partial`; `failed`, `stale`, or live-at-deadline completes no downstream stage. Every start and supervisor poll reuses Plan 3's full freshness verifier; every selected/attempting conversion also reuses `verifyCurrentClaimAnchor`. A stale source projection writes no claims; an entity-only supersession skips that anchor and continues; only a returned current confirmed order result can receive `claimCount`.

Journey events, dimensions, and reports are independent enrichment branches, not prerequisites or substitutes for the core evidence chain. Launch each only after the core chain above has reached its own prerequisite gate; they may run independently of one another, but never in parallel with an unmet upstream dependency. Add fake-child call-order tests proving no dependent trigger happens before its await, no stage is duplicated on supervisor replay, a later journey run cannot replace the retained order-core source run, and unavailable/partial evidence remains visible. On a non-ok claim child, invoke the idempotent `recoverExhaustedClaimBatch(claimReplayId)` fallback before recording the stage failed; after any ok nonterminal batch, the durable graph—not child output—is authoritative. On a non-ok/expired dimension, journey, or order-core child, invoke its applicable Plan 1/2 fixed-code finalizer/reconciler. On every non-ok/expired report child, invoke the report-specific wrapper so all staging generations are failed atomically with the sync-run finalization; never call the generic Plan 2 finalizer alone. At every upstream failure, prior published source/results/claims remain queryable with stale/failure coverage rather than being deleted or silently relabelled.

At the Trigger boundary, assert every task in `trigger/klaviyo-incremental.ts` is exported and every handoff has an explicit seven-day `idempotencyKeyTTL`. Every key that must survive a parent retry/replay or be reused by another supervisor around a persisted database run is created through `idempotencyKeys.create(key, { scope: "global" })`; never rely on Trigger's default parent-run scope. Reuse the owning child graph's canonical key whenever a database run/checkpoint already exists: Plan 1 batch uses evidenceRunId/cursor; Plan 2 order-core and Plan 4 journey use sourceMode+syncRunId/checkpoint hash; dimensions/reports use syncRunId/checkpoint hashes; and claims use claimReplayId+sourceRunId+matchRunId+the graph's durable tuple hash. Initial handoffs after `startOrResume*` use that graph's exact `*:first:${internalRunId}` global key. Matching delegates to Plan 3's `triggerOrRepairMatchInvocation`; claims delegate to `triggerOrRepairClaimBatch`; both include explicit global scope and bounded canceled-terminal recovery chains. The mode-only Plan 1 start before an evidence row exists may use a supervisor-qualified key containing supervisor Trigger run ID, connection, canonical window fingerprint, and stage, but that key is still explicitly global. Any supervisor first reuses a live claim graph; only a terminal predecessor permits a fresh graph ID, so the queue is a load guard rather than terminal authority. Call durable child waits sequentially, retain `result.id`, test `result.ok` before reading `result.output`, and convert a non-ok child into the stage's safe failed/stale state without launching dependents. Database terminal-state waits—including the claim graph after its initial child—use durable `wait.for` intervals rather than `sleep`, stop at a persisted supervisor deadline, reconcile only an expired heartbeat, and return pending if the lease is still live. Do not use `Promise.all` for child waits; even independent enrichment branches are launched/observed through durable named stages so replay cannot duplicate them. Add source-boundary tests for every exact key component, explicit global scope, fresh-versus-resumed claim graph IDs, one-running graph enforcement, claims-queue serialization, canceled-terminal recovery, result-ID capture, imports/options, non-ok output guard, bounded durable waits, and absence of parallel wait calls.

- [ ] **Implement a gated orchestrator without broad credentials or payloads.**

The Trigger schedule enumerates only connections that the repository marks eligible, then sends child tasks `connectionId` and safe ranges. The durable supervisor checkpoint stores its current stage, per-stage deadline, canonical child key, and distinct Trigger/database IDs as they become available: `shopifyTriggerRunId`, `shopifyEvidenceRunId`, `orderCoreTriggerRunId`, `sourceRunId`, `matchTriggerRunId`, `matchRunId`, database-owned `claimReplayId`, and `claimTriggerRunId`, plus dimension/journey/report IDs. Implement that checkpoint as a bounded JSON object in Trigger run metadata: call `metadata.set("supervisor", nextCheckpoint)` and `await metadata.flush()` before every child handoff and before each explicit durable poll wait, then reconstruct/validate it on replay. For a `triggerAndWait` handoff, flush the stage/key before the call; once the durable call returns, capture `result.id` and flush that ID before branching on `result.ok` or reading output. Load/reuse `claimReplayId` from `startOrResumeClaimReplay`, and keep polling that database graph after the initial child returns until a terminal graph status or deadline. Import and source-boundary-test both metadata calls; never rely on an unflushed in-memory variable. A replay resolves the same global key instead of launching another, and advances the checkpoint before triggering the next stage. Before creating any Plan 1/2/claim graph, it invokes that plan's expired-lease reconciliation; a live different supervisor/run remains pending rather than being stolen. Both exported scheduled and manual entry points delegate to this same staged supervisor. It never accepts or logs private keys, organization IDs as authority, HMACs, profile IDs, raw provider data, or raw claim cursors. Keep the schedule disabled in deployment until the Reviv backfill/freshness checklist below is signed off; manual task triggering remains available.

- [ ] **Write an end-to-end database isolation test.**

Seed two organizations/connections, confirmed and candidate orders, nullable claims, journey events, and reports. Run claims refresh, report replay, failed partial refresh, and the incremental orchestrator. Assert:

- the other tenant is byte-for-byte unchanged;
- Shopify order/refund/money/bucket/Meta fields are unchanged;
- match candidates/status/confidence do not change from reports or claims;
- missing relationships remain null/unknown;
- journey membership uses exact profile ID only;
- report facts cannot appear in an order claim or explanation;
- no raw identity/URL/property data is present in stored rows, safe logs, or API projections.

- [ ] **Run all Plan 4 and repository checks.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimensions.test.ts src/lib/klaviyo/dimension-repository.integration.test.ts src/lib/klaviyo/claims.test.ts src/lib/klaviyo/claim-repository.integration.test.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/journey.test.ts src/lib/klaviyo/reports.test.ts src/lib/klaviyo/report-repository.integration.test.ts src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts src/lib/klaviyo/incremental-sync.test.ts src/lib/klaviyo/claims-reporting-isolation.integration.test.ts
bun run test
bun run lint
bun run build
git diff --check
```

Expected: all commands exit 0; `git diff --check` prints nothing.

- [ ] **Complete the rollout checklist before enabling the schedule.**

Verify a passed immutable Reviv probe, successful 90-day Shopify evidence and Klaviyo order-core backfills, current atomic match publication, successful trailing-seven-day replay without duplicates, visible source freshness/failure states, zero raw-data leaks, and unchanged Shopify reconciliation. Only then enable the daily Trigger.dev schedule in the target environment.

- [ ] **Commit the gated incremental workflow and isolation lock.**

```sh
git add src/lib/klaviyo/incremental-sync.ts src/lib/klaviyo/incremental-sync.test.ts trigger/klaviyo-incremental.ts src/lib/klaviyo/claims-reporting-isolation.integration.test.ts
git commit -m "feat(klaviyo): add gated incremental enrichment"
```
