# Klaviyo Advisory Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe identity evidence to the approved Plan 2 order core and atomically publish reproducible, advisory-only Shopify order, event, and product evidence results.

**Architecture:** Consume the redacted, completeness-labelled provider observations already ingested by Plan 2, extend that existing path only with versioned identity digests, then keep candidate generation, scoring, and product comparison in pure TypeScript. A repository publishes a complete match run in one transaction; Trigger.dev only supervises the existing resumable source batches and matching jobs. Deterministic identifiers can confirm, diagnostic evidence can only rank candidates, and no code in this plan writes Shopify money or production attribution fields.

**Tech Stack:** TypeScript, Drizzle ORM/PostgreSQL, Trigger.dev 4, tRPC 11, Zod, Vitest, Bun.

---

## Preconditions and fixed contracts

Start only after Plans 1 and 2 are committed and their gates pass. The Reviv connection must be `ready`, the probe report must be `passed`, Shopify-native `Placed Order` and `Ordered Product` metric IDs must be unique, and every deterministic provider mapping must have an approved `klaviyo_join_rule`.

Import `KlaviyoConnectionScope`, `HalfOpenWindow`, `KlaviyoMetricKind`, and the normalized source types from Plan 2's `src/lib/klaviyo/types.ts`. Reuse `src/schema/klaviyo.ts`, `src/lib/klaviyo/event-normalizer.ts`, `src/lib/klaviyo/source-store.ts`, `src/lib/klaviyo/source-runner.ts`, `trigger/klaviyo-source-sync.ts`, and the mounted `klaviyoRouter`; this plan must not create parallel event-ingestion artifacts or redeclare Plan 2 contracts.

Use these exact result types throughout the plan:

```ts
export type OrderMatchStatus =
  | "confirmed"
  | "candidate"
  | "ambiguous"
  | "no_klaviyo_event"
  | "duplicate_conversion_events";

// API/read-model only. `not_evaluated` is never stored in a match-result row.
export type OrderEvidenceStatus = OrderMatchStatus | "not_evaluated";

// API/read-model only. Missing current event result after incident-edge closure.
export type EventEvidenceStatus = EventMatchStatus | "not_evaluated";

export type EventMatchStatus =
  | "confirmed"
  | "candidate"
  | "ambiguous"
  | "unmatched";

export type ProductMatchStatus =
  | "exact"
  | "partial"
  | "contradictory"
  | "unavailable";

export const MATCHER_VERSION = "klaviyo-v1" as const;
export const DIAGNOSTIC_MIN_SCORE = 5;
export const DIAGNOSTIC_MAX_SCORE = 11;
export const DIAGNOSTIC_MAX_DISTANCE_MS = 24 * 60 * 60 * 1000;
```

The 90-day backfill uses a half-open UTC `[from, to)` range. Incremental refreshes overlap the trailing seven days. An event or order outside a completed/current match result is **not evaluated**; do not synthesize an unmatched/no-event database row for it. `OrderEvidenceStatus` and `EventEvidenceStatus` are query-only unions used by the symmetric left-joined ledgers and filters; schema columns, matcher drafts, and publication continue to use only their stored match-status unions.

### Task 1: Extend identity and add product-link/match publication schema

**Files:**

- Create: `src/schema/klaviyo-match.ts`
- Create: `src/lib/klaviyo/match-types.ts`
- Modify: `src/schema/klaviyo.ts`
- Modify: `src/schema/shopify-evidence.ts`
- Create: `src/lib/klaviyo/persistence.integration.test.ts`
- Create: `drizzle/0055_klaviyo_advisory_matching.sql`
- Create: `drizzle/meta/0055_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Write failing database invariants before adding tables.**

Add cases to `src/lib/klaviyo/persistence.integration.test.ts` using its disposable-database fixture. Assert all of the following:

```ts
it("rejects a Klaviyo digest without exactly one Klaviyo event source");
it("rejects a Klaviyo digest whose connection/event scope disagrees");
it("rejects a Klaviyo identity observation outside its exact source run event or digest scope");
it("rejects a candidate edge outside its match-run connection");
it("rejects a match run whose source run is outside its exact scope");
it("rejects a match run whose Shopify evidence run is outside its store scope");
it("rejects running or malformed terminal match runs");
it("allows failed attempts no results and excludes them from current publication");
it("rejects candidates or results attached to a failed match run");
it("allows failed attempts to share a fingerprint but one published run only");
it("publishes a fresh zero-result window without pretending it was superseded");
it("allows one live identity rotation per connection and snapshots its retained sources");
it("keeps rotation memberships valid across suppression and compliance release");
it("retains a scoped completed uninstall receipt after connection cascade");
it("rejects rebinding a historical matching-key label to a new secret check");
it("rejects a retired receipt label equal to its resulting current label");
it("enforces a closed current-only or dual identity-write gate with key checks");
it("rejects gate bootstrap on a version/secret mismatch or unresolved dual rows");
it("extends erasure suppression only with HMACed Klaviyo profile aliases");
it("rejects confirmed event results without one deterministic edge");
it("rejects selected edges on ambiguous and unmatched event results");
it("allows only one current result per connection and source entity");
it("cascades events, products, links, candidates, and results from a connection");
```

- [ ] **Run the focused test and confirm the schema is missing.**

Run:

```sh
bun run test -- src/lib/klaviyo/persistence.integration.test.ts
```

Expected: FAIL because the match/link tables and Klaviyo identity extension do not exist. If `DATABASE_URL` is absent, set it to the repository's disposable test database before accepting this red step; a skipped database suite is not evidence for the migration.

- [ ] **Reuse the existing source schema and add only the derived product link.**

Plan 2 already defines `klaviyo_event` and `klaviyo_event_product` in `src/schema/klaviyo.ts`, the canonical kinds and `ProductEvidenceCompleteness` in `src/lib/klaviyo/types.ts`, and complete-only child replacement in `source-store.ts`. Do not recreate or alter those contracts, and do not rename `externalEventId`/`eventUuid`. Continue treating provider value/currency only as a source observation, never as allocated product revenue.

Define `klaviyo_product_evidence_link` in `src/schema/klaviyo-match.ts`. It must belong to a match run and require an `ordered_product` event, a `placed_order` event, a Shopify order, a deterministic method, matcher version, status, and reason-code JSON. Its run-scoped uniqueness makes links reproducible with the publication that selected them. Composite foreign keys must keep all sources inside one organization/store/connection, and the service layer must reject profile/time/product-only association methods.

- [ ] **Define match-run, candidate-edge, event-result, and order-result tables.**

In `src/schema/klaviyo-match.ts`, add:

- `klaviyo_match_run`, including required `source_run_id`, `shopify_evidence_run_id`, matcher version, a logical publication-scope fingerprint, canonical invocation fingerprint, closed status (`published | failed`), safe nullable failure code, `started_at`, `completed_at`, nullable `published_at`, and `superseded_at`. The publication-scope fingerprint covers full scope, evaluated windows, matcher/rule/config versions, but excludes bound run IDs/checksums; it lets a later exact-scope publication explicitly supersede a prior zero-result publication. Half-open Shopify/event windows, separate canonical Klaviyo-source and Shopify-evidence checksums, rule/config checksums, and result/count fields are nullable at the column level solely for minimal failed-attempt audit rows; database terminal-shape checks require every one of them for `published` and require them null for `failed`. Counts may validly be zero. A composite `(organization_id, store_id, connection_id, source_run_id)` foreign key targets Plan 2's scoped sync-run unique key and cascades on source-run deletion. Reuse Plan 1's existing scoped `(organization_id, store_id, id)` unique key on `shopify_evidence_sync_run` and target it from `(organization_id, store_id, shopify_evidence_run_id)` with `ON DELETE CASCADE`; the service additionally requires an exact acceptable terminal Shopify coverage run and a terminal-success order-core source before publication. There is deliberately no persisted `running` match row: each attempt captures `startedAt` beside its in-memory `matchRunId`, and both timestamps become a database row only in the complete publication transaction or a caught sanitized terminal-failure insert.
- `klaviyo_match_candidate`, including event, order, class, method, normalized feature vector, weights, tolerances, score, confidence, reasons, and `(run_id, event_id, order_id)` uniqueness.
- `klaviyo_event_match_result`, including one in-scope `Placed Order` event, status, nullable selected edge, candidate count, duplicate warning, reason codes, publication time, nullable supersession time, and nullable closed supersession reason (`entity_replaced | incident_edge_boundary | rotation_key_retired | privacy_erasure`).
- `klaviyo_order_match_result`, including one inspected Shopify order, status, nullable selected edge/event, nullable product status, claim count, reasons, matcher version, publication time, nullable supersession time, and the same closed supersession reason.

Use database checks for confidence in `[0, 1]`, candidate class values, status/selected-edge combinations, product status only on confirmed orders, ordered result `published_at <= superseded_at` when superseded, and the exact result supersession shape: `supersession_reason IS NULL` iff `superseded_at IS NULL`, with only the closed reasons above when superseded. Also check the full match-run terminal union: `published` requires publication time, both windows/checksums/fingerprints, rule/config checksums, and all nonnegative counts with no failure code; `failed` requires no publication/supersession, a fixed safe failure code, and null publication-only windows/checksums/counts. Add explicit constraint regressions for malformed terminal shapes, malformed result reason/time pairs, and the zero-count published shape. Add a partial unique index on `(connection_id, invocation_fingerprint)` where match-run status is `published`; failed retry-attempt rows may share that fingerprint and use a non-unique scoped lookup index. `publishMatchRun` catches the unique race and returns the winning published row after revalidating both bound run IDs, full scope, both canonical evidence checksums, and the remaining fingerprint fields. Give the match run a scoped unique key including status; every candidate/result/product-link child carries a checked `run_status = 'published'` discriminator and composite foreign key to that key, so a failed run cannot own publication children. Because a plain row check cannot inspect the selected candidate's class or source, use composite scoped foreign keys (including run, event/order, edge ID, and candidate class) plus a nullable selected-class column: `confirmed` requires `deterministic`, `candidate` requires `diagnostic`, and ambiguous/unmatched/no-event/duplicate results select no edge. PostgreSQL partial-index predicates cannot inspect the parent run, so current order/event uniqueness predicates use only the child row's own `superseded_at IS NULL`; the checked composite run-status foreign key separately proves the parent is published.

For a nonempty publication, `klaviyo_match_run.superseded_at` means the publication has **no remaining unsuperseded order or event result**, not merely that a newer overlapping window exists. Publication first supersedes prior current results for every directly evaluated entity, then closes selected/dependent incident edges: replacing an order also supersedes every prior current event conclusion selecting that order, even outside the new event window; replacing an event also supersedes any prior current order conclusion selecting that event, including duplicate-event fan-in dependencies. It never leaves contradictory cross-run current endpoints. An outside counterpart receives no synthetic result; order and event read models expose API-only `not_evaluated` plus `incident_edge_boundary` until a covering publication. If the inside endpoint receives `no_klaviyo_event`/`unmatched`, that status is explicitly **window-relative**, carries the same boundary reason, and must not be worded as proof that no Klaviyo/Shopify counterpart exists globally. Duplicate fan-in closure applies the caveat to the new inside conclusion rather than falsely promoting a single surviving event.

Then call one shared locked `recountMatchRunCurrentness(affectedRunIds, tx)` after every result supersession/deletion path (normal publication, privacy erasure, and rotation prune) and mark each affected prior nonempty run only when zero current results remain. A partially overlapped 90-day run stays active for genuinely untouched entities.

A valid zero-result publication has exact expected/result/candidate counts of zero, no result rows, and `superseded_at = NULL`; a later exact publication-scope fingerprint explicitly supersedes it. Run-level freshness therefore does not by itself prove a conversion anchor current. Every claim input requires its exact `klaviyo_event_match_result.superseded_at IS NULL`. Only canonical order attachment and `claimCount` additionally require the same run's confirmed selected edge plus its corresponding `klaviyo_order_match_result.superseded_at IS NULL`; unmatched, ambiguous, or candidate conversion events may retain provider claims without acquiring a canonical order. Add overlapping-window tests in both boundary directions plus duplicate fan-in: replaced/incident endpoints become noncurrent with the boundary reason, untouched old results remain current, canonical order attachment follows the same-run/same-edge rule, and recount marks the prior run only after its final current result disappears. Add an empty-window test proving freshness accepts exact zero membership and a later exact-scope publication supersedes it deliberately rather than via a vacuous entity count.

Put the fixed result unions and `MATCHER_VERSION = "klaviyo-v1"` in `src/lib/klaviyo/match-types.ts`; schema, matcher, repository, queries, and later plans import them from there rather than redeclaring string unions.

Also add `klaviyo_identity_rotation_run`, `klaviyo_identity_rotation_source`, and `klaviyo_identity_rotation_publication_attempt` now so Task 7 has durable workflow authority. The run stores full scope, opaque fingerprint, current/previous version **and key-check** pairs with composite foreign keys to Plan 1's lifetime `identity_matching_key_binding`, closed workflow state, bounded checkpoint/current-attempt number/counts, heartbeat, fixed safe failure code, and start/finish timestamps—never secrets or digests. A partial unique index permits one nonterminal rotation per connection. The source table materializes the exact retained identity-source set at preparation with a generated opaque `source_snapshot_id`, kind, nullable scoped Shopify-order/Klaviyo-event live reference using `ON DELETE SET NULL`, optional scoped erasure-suppression reference using `ON DELETE RESTRICT`, status (`pending | complete | unavailable | suppressed | released`), safe attempt count, nullable `released_at`, and uniqueness per rotation/snapshot. Add partial unique indexes on `(rotation_id, shopify_order_id)` and `(rotation_id, klaviyo_event_id)` while each live reference is non-null, so random snapshot IDs cannot admit the same source twice. `pending | complete | unavailable` requires exactly one live source reference and no suppression reference/release time; `suppressed` requires no live reference, one matching durable tombstone, and no release time; `released` requires no live/tombstone reference and a release timestamp. Privacy erasure or any writer suppression hit first attaches that tombstone proof and changes the membership to `suppressed`, then deletes identity-bearing source data. An explicit compliance release is blocked while a nonterminal rotation references the tombstone; after terminal rotation it first changes those historical memberships to non-identifying `released` receipts, then deletes the tombstone. This stable membership survives subject deletion without making later compliance release impossible and replaces unsafe UUID high-water marks.

The publication-attempt table is append-only bounded history for each rotation. It stores `(rotation_id, attempt_number)`, a closed stage (`refreshing_shopify_evidence | refreshing_order_core | matching | published | stale`), distinct Trigger/database child IDs as they become known, exact identity-free source checksums and publication-scope/invocation fingerprints, safe stale/failure code, and timestamps. It never stores secrets, digests, provider IDs, or raw errors. The parent checkpoint points to the current attempt number instead of overwriting prior child IDs. The rotation and attempt tables cascade from the connection/rotation; source live references use `SET NULL`, never cascade the membership back into evidence. Add checks/fixtures for cross-scope membership, every invalid live/suppressed/released shape, release blocked during a live rotation, terminal release conversion, erasure races, duplicate snapshots/attempt ordinals, the same live source under different snapshot IDs, live-run exclusion, terminal replay, and lease-safe replacement.

Add store-owned `identity_pilot_uninstall_receipt` and `identity_pilot_uninstall_retired_key` tables that survive connection deletion but cascade with organization/store/receipt deletion. The receipt stores an opaque ID, former internal connection ID as non-FK audit value, prior mode, resulting current version plus fixed-context key check and composite lifetime-binding foreign key, safe cleared-row counts, fixed `complete` status, and completion time. Its child carries full store scope plus `(receipt_id, retired_key_version)`, has scoped uniqueness, and foreign-keys that version to the lifetime registry. Neither stores a secret, digest, subject/provider identifier, or raw error. Nonnegative/terminal checks apply to the receipt; the service requires a dual uninstall to copy its gate previous label and also copies every previous label from a completed rotation that the connection cascade will remove, including a just-pruned graph when the gate is already current-only. It excludes/rejects any retired child equal to the receipt's resulting current label. The uninstall transaction inserts the receipt/children only after all identity clearing and policy normalization proofs succeed and before deleting the connection. Add cross-store, duplicate-retired-label, current-equals-retired, rollback, malformed-shape, prune→current-only-uninstall, and connection-cascade-survival fixtures.

Extend `klaviyo_connection` with the durable identity-write gate used by every writer after this migration: `identity_write_mode` (`current_only | dual`, default `current_only`), nullable `identity_current_key_version`/`identity_current_key_check`, and nullable `identity_previous_key_version`/`identity_previous_key_check`. Checks require version/check pairs, `dual` to have two non-null, distinct labels/checks, and `current_only` to have a null previous pair; the current pair may be null only during the post-migration/manual bootstrap state. Each non-null scoped pair has a composite foreign key to Plan 1's lifetime matching-key registry. Key checks are non-subject fixed-context HMAC bindings, never secrets or matcher inputs. No ordinary writer, matcher, or rotation prepare may initialize them opportunistically.

A dedicated bootstrap under store→connection locks first loads Plan 1's `identity_crypto_policy` and lifetime matching-key binding, then constant-time validates the environment current label/check against both. It permits gate initialization only when there are zero matching-HMAC rows or exactly one retained version equal to that validated policy current, with no previous/second version. If rows exist but the policy/binding is absent, or if the environment uses any historical label with a different secret/check, bootstrap fails for explicit remediation because retained digests alone cannot prove key possession. It then records `current_only(current label/check = validated policy/binding, previous = null)`. A mismatch or pre-existing dual set fails the Plan 3 manual gate; it never blesses or rebinds a version. Every later ordinary write must match the lifetime registry, stored connection pairs, and store policy or fail before evidence mutation. These durable bindings—not environment-variable presence—are the authority for which digests may be emitted.

Also add a nonnegative `events_suppressed` count to `klaviyo_sync_run` so order-core/journey coverage can expose erasure-filtered records without persisting their IDs. It is checkpointed monotonically with the existing source counts and is not interpreted as an ingestion failure.

Add `klaviyo_event_run_identity_observation` as source-lineage owned by this migration. It links one exact Plan 2 `(organization, store, connection, syncRunId, eventId)` content observation to the exact configured-current `source_identity_hmac.id` used by that run/event and stores no digest/checksum/profile/provider value. Composite foreign keys enforce both sides' full scope and `ON DELETE CASCADE`; uniqueness permits at most one current identity link per run/event. Extend `source_identity_hmac` with the scoped source-plus-row-ID unique keys required by this foreign key. Like Plan 1, Klaviyo digest rows are immutable per source/version: identical digest replay reuses the row ID, while changed digest replaces the row so dependent identity observations cascade. Erasure, uninstall, and previous-version pruning therefore remove identity lineage automatically without deleting identity-free event observations.

Extend Plan 1's `identity_erasure_suppression_kind` enum with `klaviyo_profile_id`; do not add a second tombstone table. The value stored for that kind is the domain-separated, tenant/store-scoped suppression HMAC of the provider profile ID, never the raw ID. Suppression rows remain store-owned and survive Klaviyo uninstall/reinstall; only explicit compliance release or store/organization deletion removes them.

- [ ] **Extend `source_identity_hmac` from its Plan 1 Shopify-only shape.**

Make the existing `shopify_order_id` nullable; add nullable `klaviyo_connection_id` and `klaviyo_event_id`; expand `source_identity_kind` with `klaviyo_event`; and add scoped connection/event `ON DELETE CASCADE` foreign keys. Replace the Plan 1 check with the final exactly-one-source rule:

```sql
CHECK (
  (source_kind = 'shopify_order' AND shopify_order_id IS NOT NULL
    AND klaviyo_connection_id IS NULL AND klaviyo_event_id IS NULL)
  OR
  (source_kind = 'klaviyo_event' AND shopify_order_id IS NULL
    AND klaviyo_connection_id IS NOT NULL AND klaviyo_event_id IS NOT NULL)
)
```

There is no `source_record` column. Replace Plan 1's Shopify-only source/version unique constraint with two partial unique indexes: `(shopify_order_id, key_version)` where the Shopify source is non-null, and `(klaviyo_connection_id, klaviyo_event_id, key_version)` where the Klaviyo source is non-null. Retain Plan 1's scoped row-ID/source-row-ID unique keys required by Shopify identity-observation foreign keys and add equivalent full-scope Klaviyo event-plus-row-ID keys for `klaviyo_event_run_identity_observation`. Retain the scoped `(organization_id, store_id, key_version, digest)` lookup index and add the connection-qualified digest lookup used on the Klaviyo side. Do not permit a digest without tenant/store scope or an event outside that connection scope.

Retain Plan 1's `rotation_state` column for migration compatibility, but redefine it as non-authoritative insertion-time metadata only. From Plan 3 onward, current/previous role is derived exclusively from the locked store policy plus connection gate. Persistence ignores a role-marker mismatch when source/version/digest are identical and reuses the opaque row ID across current→previous gate transition; never update/replace a row merely to relabel it, because doing so would cascade valid exact-run identity observations. Replace a row only when the digest for that same source/version truly changes. Tests prove the row ID and exact-run links survive gate role transition even if the legacy marker remains `active`.

- [ ] **Generate, inspect, apply, and re-test migration 0055.**

Run:

```sh
bun run db:generate --name klaviyo_advisory_matching
git diff -- drizzle/0055_klaviyo_advisory_matching.sql drizzle/meta/_journal.json src/schema/klaviyo.ts src/schema/klaviyo-match.ts src/schema/shopify-evidence.ts src/lib/klaviyo/match-types.ts
bun run db:migrate
bun run test -- src/lib/klaviyo/persistence.integration.test.ts
```

Expected: generated migration is `0055`; the SQL contains every match/identity-rotation table, the store-owned uninstall receipt/retired-key child, all scoped lifetime-key-binding foreign keys, status/check, retained-source live/suppressed/released constraints, connection identity-write gate/check, `events_suppressed`, Klaviyo profile suppression enum value, and every partial unique index above; it does not rewrite legacy rotation-state values or delete/update lifetime key bindings; migration succeeds; the focused suite passes.

- [ ] **Commit the schema slice.**

```sh
git add src/schema/klaviyo.ts src/schema/klaviyo-match.ts src/schema/shopify-evidence.ts src/lib/klaviyo/match-types.ts src/lib/klaviyo/persistence.integration.test.ts drizzle/0055_klaviyo_advisory_matching.sql drizzle/meta/0055_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(klaviyo): add order evidence and match schema"
```

### Task 2: Add identity digests to Plan 2 event commits

**Files:**

- Modify: `src/lib/klaviyo/types.ts`
- Modify: `src/lib/klaviyo/event-normalizer.ts`
- Modify: `src/lib/klaviyo/event-normalizer.test.ts`
- Modify: `src/lib/klaviyo/source-store.ts`
- Modify: `src/lib/klaviyo/source-store.test.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`
- Create: `src/lib/klaviyo/match-currentness.ts`
- Create: `src/lib/klaviyo/privacy-match-closure.ts`
- Create: `src/lib/klaviyo/privacy-match-closure.integration.test.ts`

- [ ] **Write failing identity normalization tests and retain completeness regressions.**

Cover these exact cases in `event-normalizer.test.ts`:

```ts
it("normalizes a Shopify-native Placed Order without retaining plaintext email");
it("emits current and previous tenant-derived digests during rotation");
it("keeps order-id and unique-event-id candidates in separate namespaces");
it("normalizes duplicate product keys as quantity-bearing observations");
it("preserves Plan 2 incomplete/unavailable product completeness");
it("keeps Plan 2 redaction and separate identifier namespaces unchanged");
it("keeps the event content checksum stable when identity digest versions change");
```

Extend Plan 2's `NormalizedKlaviyoEvent` with only the new identity field rather than introducing a page wrapper, a second normalizer, or another completeness enum:

```ts
// Add these fields directly to Plan 2's existing NormalizedKlaviyoEvent.
{
  identityDigests: VersionedIdentityDigest[];
}

// Add these fields to the existing Plan 2 normalizeEventPage input.
{
  scope: IdentityScope;
  identityKeyring: IdentityHmacKeyring;
}
```

- [ ] **Run the unit tests and confirm both features are absent.**

```sh
bun run test -- src/lib/klaviyo/event-normalizer.test.ts
```

Expected: FAIL because the Plan 2 normalized event has no identity-digest field; its existing completeness regressions remain green.

- [ ] **Bootstrap the durable identity-write gate before any Plan 3 source write.**

Add `initializeIdentityWriteGate({ scope, keyring, suppressionKey })` to the existing server-only source store. In one transaction it locks the Shopify store then the unique Klaviyo connection, computes non-secret checks, requires the gate still be uninitialized, and inspects Plan 1's store crypto policy plus all scoped Shopify/Klaviyo matching-HMAC rows. With zero identity rows and no policy it may initialize both the current-only store policy (including the stable suppression binding) and the identical connection current label/check. With a policy it must constant-time validate every environment label/check against it. With retained rows it additionally requires the policy already existed, exactly one distinct row version equal to policy current, and no previous/second version before setting the gate. Same-label/different-secret, environment v2 over retained v1, missing policy with retained rows, or unresolved dual rows fail with a fixed safe code and no writes. An already initialized identical gate/policy replays as a no-op; any other state fails. Neither ordinary writers nor `prepareIdentityRotation` may call this helper implicitly. Invoke it explicitly in the Plan 3 setup/manual gate before the first identity backfill/match. Integration tests cover zero rows/policy bind, retained v1 with correct secret, retained v1 with same-label wrong secret, missing policy, unresolved v1+v0, cross-store rows, concurrent bootstrap, and replay.

- [ ] **Extend the existing pure normalizer without weakening Plan 2 redaction.**

Reuse Plan 2's existing sparse profile include, revision constant, pagination host validation, redaction, and URL sanitation. Convert the included email with Plan 1's `computeIdentityDigests` in memory, and compute domain-separated erasure-suppression candidates for the email and opaque profile relationship ID with Plan 1's separate suppression key, then discard all source strings before returning. The safe normalized value may carry only versioned matching digests and suppression HMAC candidates. Persist every matching digest permitted by the connection's durable write gate, but keep `klaviyo_event.sourceChecksum` strictly identity-free: it hashes only the redacted event/content observation that Plan 2 owns. For the gate's current version, commit the exact digest-row link in `klaviyo_event_run_identity_observation` with the event's immutable run observation.

Match invocation computes the canonical Klaviyo-source checksum from exact-run identity-free event observations plus ordered opaque current identity-observation/digest-row IDs and key-version labels—never digest values or a digest-derived verifier. It computes Shopify evidence the same way from Plan 1's content and identity observations. Actual HMAC values are loaded only transiently to compare equal versions and are never copied into a persisted fingerprint/checksum/candidate. A changed digest replaces its immutable row ID and cascades old identity observations, so recomputation/staleness follows membership without retaining a verifier. Adding or pruning only an unreferenced previous-version row does not stale a just-published current-version match. The matcher compares only current-version digests after retained source sets have been reingested; previous rows exist solely for transition rollback and complete erasure. Do not infer an order mapping or product association while normalizing.

- [ ] **Write failing repository tests for atomic page commits.**

In `source-store.integration.test.ts`, prove the existing `commitKlaviyoEventPage` transaction now also guarantees:

- page replay is idempotent on connection/event IDs;
- the checkpoint advances in the same transaction as all source rows;
- a stale `expectedCheckpoint` returns Plan 2's `{ committed: false }` result without writes;
- write failure rolls back event, product, digest, and checkpoint changes;
- Plan 2's complete observations still replace stale children while incomplete/unavailable observations preserve the prior complete set;
- multiple HMAC key versions coexist, but the same event/version cannot duplicate;
- identical digest replay reuses its row ID and exact identity-observation link;
- a changed digest gets a fresh row ID and cascades the old identity observation;
- the same run/event cannot rewrite its identity-observation link; a different replay rolls back the whole page;
- a matching email/profile suppression HMAC first changes any pending, complete, or unavailable live rotation membership for that event to tombstone-proven `suppressed`, then skips/deletes only that subject's event evidence, advances a safe suppressed count, and cannot be recreated by replay;
- suppression deletion closes confirmed, candidate, ambiguous, and duplicate-fan-in incident order results with `privacy_erasure` and recounts every affected run;
- `current_only` ignores a still-present previous environment secret, while `dual` requires and writes the gate's exact two labels;
- an event from another connection/store cannot be committed;
- no raw email, profile document, full URL, arbitrary property value, request header, or secret is stored.

Keep the Plan 2 `commitKlaviyoEventPage` name, input shape, and checkpoint type. Do not introduce `commitEventPage`, string checkpoints, or a second repository.

- [ ] **Implement one transaction for the event page and checkpoint.**

`commitKlaviyoEventPage` upgrades Plan 2's commit boundary to lock the scoped Shopify store first, then the scoped connection, then the exact sync run. This unconditional order is required because a suppression hit may close Shopify-order incident results; it must never acquire the store after holding the connection. An injected executor is accepted only when its caller already holds those locks in that order. The commit requires the connection gate already be initialized by explicit bootstrap, loads the store `identity_crypto_policy`, and constant-time validates all gate/policy/environment version-check pairs—including the stable suppression binding—before source mutation. A null gate, same-label/different-secret drift, or policy disagreement fails closed. In `current_only`, it emits only the stored current label/check even if previous-secret variables remain present; in `dual`, it requires and emits exactly the stored current/previous pair. For each normalized event, query Plan 1's store-scoped erasure-suppression table with its HMAC-only email/profile candidates while both locks are held. Add lock-order and match-publication race tests.

On a hit, call one shared executor-aware `eraseSuppressedKlaviyoEventEvidence({ scope, eventId, suppressionId, tx })`. In the caller's transaction it attaches the exact tombstone to every pending/complete/unavailable live rotation membership and changes it to `suppressed`; resolves every current incident order result through selected edges, all candidate edges, and duplicate fan-in; supersedes those order conclusions with `privacy_erasure`; collects affected run IDs; deletes the event so its event result/claims/products/digests/candidates cascade; and calls `recountMatchRunCurrentness` after deletion. Task 2 owns that shared executor-only recount in `match-currentness.ts`; Task 5 publication and Task 7 erasure/prune import it instead of redeclaring it. The erasure helper is idempotent when the event is already gone and neither helper opens/nests a transaction. `commitKlaviyoEventPage` then records only a safe suppressed counter/reason and inserts no event, product, profile ID, digest, or observation. Seed older stored events in each live membership state—including an unavailable source that later reappears with a tombstoned alias—and prove the transition is valid and confirmed, candidate, ambiguous, and duplicate-fan-in order conclusions cannot survive current with stale counts/reasons. The public erasure path in Task 7 must call this same helper rather than duplicating cascade ordering. This makes scheduled order-core/journey replay unable to resurrect an erased subject or leave a null/false-complete rotation member.

For non-suppressed input, upsert source rows on Plan 2's `(connection_id, external_event_id)` key, replace child products only when their completeness flag is `complete`, reconcile the exact gate-authorized digest set with immutable row semantics, insert/reuse the current-version `klaviyo_event_run_identity_observation`, and compare-and-set the sync-run checkpoint in the same transaction. Identical source/version/digest retains its row ID; changed digest deletes/reinserts only that row and cascades older identity observations before linking the fresh row. Missing events in a partial page never delete stored source records. The gate—not environment presence—controls prior-version removal; rotation pruning is the only path that changes `dual` back to `current_only` and removes the previous set.

- [ ] **Run all Task 2 tests.**

```sh
bun run test -- src/lib/klaviyo/event-normalizer.test.ts src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/privacy-match-closure.integration.test.ts
```

Expected: PASS with no skipped integration tests in the configured test database.

- [ ] **Commit the event persistence slice.**

```sh
git add src/lib/klaviyo/types.ts src/lib/klaviyo/event-normalizer.ts src/lib/klaviyo/event-normalizer.test.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/match-currentness.ts src/lib/klaviyo/privacy-match-closure.ts src/lib/klaviyo/privacy-match-closure.integration.test.ts
git commit -m "feat(klaviyo): persist event identity evidence"
```

### Task 3: Reingest identity through Plan 2's resumable source runner

**Files:**

- Modify: `src/lib/klaviyo/source-runner.ts`
- Modify: `src/lib/klaviyo/source-runner.test.ts`
- Modify: `trigger/klaviyo-source-sync.ts`

- [ ] **Write failing orchestration tests against injected dependencies.**

Test the Plan 2 service rather than the Trigger.dev wrapper. Preserve its connection/account mismatch, readiness/probe gate, exact `[from, to)` forwarding, page replay, persisted resume, bounded page count, trailing-seven-day overlap, no deletion on a failed refresh, and continuation-only-after-commit behavior. Add cases proving the keyring is resolved server-side, current/previous digests reach the normalizer, and a missing/invalid keyring fails before any page write. After this task, assert every `order_core` page calls the existing `listEvents` client with `includeProfileEmail: true` and `includeAttributions` set only when required by the canonical order-core source contract. The Plan 3 identity backfill is simply a new ordinary `order_core` run; every later incremental `order_core` run follows the same path. Reserve the same sparse-profile HMAC behavior for Plan 4's allowlisted `journey` mode so erasure/rotation covers journey-only subjects; journey timelines still join only by exact profile ID and never use HMAC to expand. All other non-event fetches omit profile email. Capture logs, normalized output, source rows, digest rows, checkpoints, and sanitized task failures and prove none contains the sparse plaintext email or raw profile document.

Keep Plan 2's `startOrResumeOrderCoreSync`, `processOrderCoreBatch`, checkpoint types, `MAX_PAGES_PER_BATCH`, `klaviyo-events` queue, `klaviyo-order-core-batch` task ID, and `{ syncRunId }` batch payload. Do not define a second supervisor payload, event runner, or Trigger task.

- [ ] **Run the service tests and confirm the identity extension is missing.**

```sh
bun run test -- src/lib/klaviyo/source-runner.test.ts
```

Expected: FAIL because the existing runner does not yet provide the identity keyring to normalization.

- [ ] **Implement the injected orchestration service.**

The existing router-side supervisor receives the organization-derived connection scope, validates the explicit account/store binding, creates or resumes the existing `klaviyo_sync_run`, and records the pinned Events revision. Each bounded task resolves that run and full scope from `syncRunId`; extend the canonical `order_core` branch to resolve Plan 1's `IdentityHmacKeyring` and `ErasureSuppressionKey` server-side and call the existing `listEvents` page fetch with `includeProfileEmail: true` (plus `includeAttributions` only where the canonical order-core contract requires it). Pass tenant/store scope, both key configurations, and the sparse included profile email/relationship ID directly to the existing pure normalizer. Compute matching and suppression HMACs in memory and discard the email/profile document before the normalized page crosses into persistence or logging. Persistence then filters matching-key rows through the locked connection write gate and checks suppression HMACs. Plan 4 applies this same sparse include/suppression behavior to its closed journey branch while keeping journey matching exact-profile-only. Do not add an identity-reingestion flag or another request-parameter field: the immutable exact order-core source contract remains only `sourceMode: "order_core"` and `metricKinds: ["placed_order", "ordered_product"]`, and a new full or incremental order-core run always performs this behavior. The service must never accept an organization ID as authoritative input and must never call Shopify monetary ingest helpers.

- [ ] **Extend the existing thin Trigger.dev source tasks.**

Retain Plan 2's `klaviyo-events` queue and `klaviyo-order-core-batch` task ID. The wrapper continues to write only safe IDs/counts to logs and metadata, triggers the next bounded batch only after a committed outcome, and marks the run failed with a sanitized error code/message. Do not add a second supervisor Trigger task or enable a schedule in this plan.

- [ ] **Run focused tests and lint the worker boundary.**

```sh
bun run test -- src/lib/klaviyo/source-runner.test.ts
bun run lint -- src/lib/klaviyo/source-runner.ts trigger/klaviyo-source-sync.ts
```

Expected: both commands exit 0.

- [ ] **Commit the resumable sync slice.**

```sh
git add src/lib/klaviyo/source-runner.ts src/lib/klaviyo/source-runner.test.ts trigger/klaviyo-source-sync.ts
git commit -m "feat(klaviyo): reingest order identity evidence"
```

### Task 4: Implement the pure advisory matcher and product comparison

**Files:**

- Create: `src/lib/klaviyo/match-normalization.ts`
- Create: `src/lib/klaviyo/match-normalization.test.ts`
- Create: `src/lib/klaviyo/product-match.ts`
- Create: `src/lib/klaviyo/product-match.test.ts`
- Create: `src/lib/klaviyo/matcher.ts`
- Create: `src/lib/klaviyo/matcher.test.ts`

- [ ] **Write failing normalization tests.**

Prove only exact `gid://shopify/Order/<digits>`, `Product`, and `ProductVariant` structures are canonicalized; human order name/number stays in a separate namespace; surrounding whitespace is trimmed; punctuation/digits are not stripped; SKU comparison is exact after trim; and every applied canonicalizer is returned in versioned explanation data.

- [ ] **Write failing product comparison tests.**

Cover duplicate variants as multisets, exact variant/quantity agreement, product-family-only partial evidence, missing-side partial evidence, quantity contradiction, identifier contradiction, unavailable evidence, SKU support only when explicitly unambiguous for compared lines, and selection of either a complete `Placed Order` item array or explicitly associated `Ordered Product` events without summing both.

Use this output:

```ts
export type ProductComparison = {
  status: ProductMatchStatus;
  source: "placed_order_items" | "ordered_product_events" | "none";
  rows: ProductComparisonRow[];
  reasonCodes: string[];
};
```

- [ ] **Write failing matcher-policy tests.**

The table below is the required v1 behavior:

| Case | Required result |
| --- | --- |
| One approved explicit order-ID edge | event/order `confirmed`, confidence `1` |
| One approved unique-event rule resolving uniquely | event/order `confirmed`, confidence `1` |
| Conflicting deterministic keys | `ambiguous`, regardless of diagnostics |
| Same-store HMAC + 4-minute distance | score `7`, `candidate`, confidence `7/11` |
| Exact variant multiset + 30-minute distance | score `6`, `candidate`, confidence `6/11` |
| Partial product + 23-hour distance | score `3`, no eligible diagnostic edge |
| Eligible equal top scores | `ambiguous`, no selected edge |
| No eligible edge | event `unmatched`; evaluated order `no_klaviyo_event` |
| Two native conversion events resolve to one order | both event results retained; order `duplicate_conversion_events` |
| Diagnostic edge with perfect score | remains `candidate`, confidence at most `.99` |

Also assert amount has zero weight, candidates never cross connection/store, distance greater than 24 hours is ineligible, identity/product presence is required, product conclusion is null for candidate/ambiguous orders, and `Ordered Product` association rejects profile/time/product-only methods.

- [ ] **Run the pure suites and confirm missing exports.**

```sh
bun run test -- src/lib/klaviyo/match-normalization.test.ts src/lib/klaviyo/product-match.test.ts src/lib/klaviyo/matcher.test.ts
```

Expected: FAIL before implementation.

- [ ] **Implement pure matching with a complete audit output.**

Use an input/output contract with no database access:

```ts
export type MatchComputation = {
  matcherVersion: typeof MATCHER_VERSION;
  klaviyoSourceChecksum: string;
  shopifyEvidenceChecksum: string;
  ruleChecksum: string;
  configChecksum: string;
  candidates: MatchCandidateDraft[];
  eventResults: EventMatchResultDraft[];
  orderResults: OrderMatchResultDraft[];
  productLinks: ProductEvidenceLinkDraft[];
};

export function computeAdvisoryMatches(input: MatchInput): MatchComputation;
```

Every candidate draft includes bounded normalized feature outcomes, weights, tolerances, total score, confidence, tie metadata, and reason codes. Its normalized feature vector also retains the matcher's bounded, typed `diagnosticProductComparison`—source selection plus product/variant/SKU/quantity comparison rows and reason codes—when product evidence contributed to that edge. This is diagnostic data, has no revenue/value fields, and has no `ProductMatchStatus`. Persist it with the candidate so later reads never recompute a historical/current edge against mutable source rows. Identity evidence is stored only as a current-version equal-version match boolean plus the configured current key-version label—never by copying either digest into the candidate row or selecting a previous-version row. A confirmed result must be derived only from an approved deterministic rule resolving uniquely. Product status is computed only after confirmation.

- [ ] **Run the pure suites until all policy cases pass.**

```sh
bun run test -- src/lib/klaviyo/match-normalization.test.ts src/lib/klaviyo/product-match.test.ts src/lib/klaviyo/matcher.test.ts
```

Expected: PASS.

- [ ] **Commit the matching policy slice.**

```sh
git add src/lib/klaviyo/match-normalization.ts src/lib/klaviyo/match-normalization.test.ts src/lib/klaviyo/product-match.ts src/lib/klaviyo/product-match.test.ts src/lib/klaviyo/matcher.ts src/lib/klaviyo/matcher.test.ts
git commit -m "feat(klaviyo): add advisory match policy"
```

### Task 5: Publish complete match runs atomically

**Files:**

- Create: `src/lib/klaviyo/match-repository.ts`
- Create: `src/lib/klaviyo/match-repository.integration.test.ts`
- Reuse: `src/lib/klaviyo/match-currentness.ts`
- Create: `src/lib/klaviyo/match-freshness.ts`
- Create: `src/lib/klaviyo/match-freshness.test.ts`
- Create: `src/lib/klaviyo/match-service.ts`
- Create: `src/lib/klaviyo/match-service.test.ts`
- Create: `trigger/klaviyo-match.ts`

- [ ] **Write failing transaction tests.**

Prove `publishMatchRun` inserts the completed match-run row with its in-memory start/completion timestamps, exact Klaviyo source-run ID, exact Shopify evidence-run ID, logical publication-scope fingerprint, invocation fingerprint, both evidence checksums, candidates/results/product links, and all direct/incident-edge supersessions in one transaction. No repository/service call inserts a pre-compute `running` row. A process crash or candidate insertion failure, result-count mismatch, either bound run's ID/scope/coverage mismatch, either canonical checksum change, or incomplete source run must leave no orphan match row for that attempt and leave old results current. Replay of an already published fingerprint for the same exact pair of source runs and evidence projections returns that run without duplicate results. Race two complete publications for one invocation fingerprint and prove the partial unique index elects one winner while both callers return that same fully validated run. Race two zero-result publications for the same logical scope; one exact invocation wins/replays, and a later different invocation atomically supersedes the earlier zero row by publication-scope fingerprint. Add both incident-edge boundary directions and duplicate fan-in rollback tests. A caught computation failure may call the separate `publishFailedMatchRun` with the same in-memory run ID and a fixed safe code; it inserts no candidates/results, never supersedes current data, is idempotent, and cannot rewrite an existing published run. Simulate a failed first attempt followed by a successful retry with a fresh ID and prove the failed audit row remains terminal while only the successful run becomes current.

Use this boundary:

```ts
export async function publishMatchRun(input: {
  scope: KlaviyoConnectionScope;
  runId: string;
  startedAt: Date;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  publicationScopeFingerprint: string;
  invocationFingerprint: string;
  computation: MatchComputation;
  expectedOrderIds: string[];
  expectedEventIds: string[];
}): Promise<{ runId: string; publishedAt: Date; replayed: boolean }>;

export async function publishFailedMatchRun(input: {
  scope: KlaviyoConnectionScope;
  runId: string;
  startedAt: Date;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  publicationScopeFingerprint: string;
  invocationFingerprint: string;
  matcherVersion: typeof MATCHER_VERSION;
  safeFailureCode: "MATCH_COMPUTATION_FAILED" | "MATCH_PUBLICATION_FAILED";
}): Promise<{ runId: string; changed: boolean }>;
```

- [ ] **Write failing service tests.**

Test that the service loads only the explicitly requested `sourceRunId` and `shopifyEvidenceRunId` in the requested scope/windows. Derive one canonical `publicationScopeFingerprint` from full scope, both evaluated windows, matcher version, and rule/config checksums while excluding run IDs/evidence checksums; derive the invocation fingerprint from that logical value plus both exact run IDs/checksums. Pass both to publication and rederive both inside the locked transaction. The Klaviyo run must be successful terminal with immutable direct request parameters exactly `{ sourceMode: "order_core", metricKinds: ["placed_order", "ordered_product"] }`. The Shopify run must belong to the exact organization/store, cover the evaluated Shopify window, and have one of only two acceptable terminal coverage labels: `success + complete` or the roadmap's explicitly policy-labelled `partial + partial`; the latter stays a visible warning in the publication and health model. Running, failed, unavailable, wrong-window, or any other partial combination fails closed.

Matcher event content comes only from that Klaviyo run's `klaviyo_event_run_observation` rows joined by full scope/event ID; every current identity-free event checksum must equal its immutable observed checksum. Current HMAC evidence is eligible only through the exact run/event's `klaviyo_event_run_identity_observation` joined to an unchanged, same-scope `source_identity_hmac` row whose key version equals the configured current label. Missing/deleted links make identity unavailable; previous-version links never score. Compute `klaviyoSourceChecksum` from canonical ordered content-observation membership/checksums plus opaque current identity-link/HMAC-row IDs and key-version labels, never digest values.

Shopify matcher content likewise comes only from the bound run's `shopify_evidence_run_observation` membership joined by full organization/store/order scope. Recompute the exact Plan 1 canonical identity-free order/line projection and require it to equal each immutable `observedContentChecksum`; a later running/failed/partial refresh cannot donate mutable rows to an older bound run. Current HMAC evidence is eligible only through that order observation's exact `shopify_evidence_run_identity_observation` and unchanged current-version HMAC row. Customer ID is not a matcher input. For `success + complete`, content-observation membership must equal every scoped Shopify order in the evaluated window. For the explicitly accepted `partial + partial` case, only observed orders enter the matcher; orders after the partial stop remain query-only `not_evaluated`, and coverage exposes the missing count.

Compute `shopifyEvidenceChecksum` from the canonical ordered content-observation membership/checksums/dispositions, opaque current identity-link/HMAC-row IDs and version labels, plus the exact Shopify evidence-run ID, immutable window, and terminal coverage labels. Never hash the digest or customer ID into the persisted checksum/fingerprint. A `preserved_partial` line disposition may remain in deterministic order-ID evaluation, but its preserved lines are visibly stale/partial and cannot produce product `exact` or contribute diagnostic product-overlap score. `unavailable` or `not_refreshed` identity has no identity link, is excluded from identity scoring, and remains visibly unavailable. Do not include monetary fields because v1 gives amount zero weight and must not consume them. Canonical ordering is explicit at every collection level, so membership, row, line, disposition, or current identity-row change alters the checksum.

Reject a non-null Klaviyo terminal checkpoint, missing/extra/reordered metric kinds, journey mode, a generic `events` run, either run from another scope, either run whose requested window does not cover its evaluated window, missing/duplicate/malformed required membership, or a current Klaviyo/Shopify projection whose checksum differs from its immutable observation. That mismatch requires selecting a newer acceptable evidence run; it never silently stamps mutable data with an old run ID.

Immediately before publication, one `REPEATABLE READ` transaction locks the scoped Shopify store row first and the scoped Klaviyo connection row second, then reloads both exact run rows, reconstructs both canonical input projections through their exact observation memberships, recomputes both aggregate checksums, logical publication-scope fingerprint, and invocation fingerprint, and requires equality before inserting any match row/result or superseding current data. It applies direct entity replacement, incident-edge closure, zero-scope supersession, and Task 2's shared `recountMatchRunCurrentness` in this transaction. Plan 1 evidence commits take the store lock; Plan 3-upgraded event/digest commits take store then connection in the same order. No remote request occurs under either lock. This fixed store-then-connection publication order prevents either source from interleaving between validation and publication without creating a lock cycle with the single-source writers. Add races against each source commit and prove publication either sees the new canonical projection or finishes before that commit; it never publishes a mixed projection. Reads and health still compare published checksums with current canonical projections so any later evidence mutation becomes visibly stale until a new run is published.

Factor that repository-grounded check into server-only `verifyPublishedMatchFreshness({ scope, matchRunId, executor? })` in `match-freshness.ts`. It validates that a nonempty row still owns at least one current result **or** that a zero-result row has exact zero expected/result/candidate membership and remains unsuperseded, then proves both bound run IDs/scopes/status/coverage contracts still qualify, every exact content and identity observation is present/current, both persisted aggregate checksums and the full invocation fingerprint rederive exactly, and approved rule/config/matcher versions still agree. It returns only `{ fresh: true; matchRun } | { fresh: false; reason: SafeMatchStaleReason }`, never digest values or raw rows. With an executor, the caller already holds store then connection locks and the helper performs no nested transaction. Tests cover a fresh empty window and reject a row that claims zero while either expected projection is nonempty.

In the same module export `verifyCurrentClaimAnchor({ scope, matchRunId, conversionEventRowId, executor? })` with a closed result that distinguishes `{ fresh: false, reason: "publication_stale" }` from `{ fresh: false, reason: "event_result_superseded" }`. It first performs the full publication proof, then requires that exact run/event result to remain unsuperseded; that is sufficient for provider claim storage regardless of event-result status. It returns `canonicalOrderResultId` only when the event result is confirmed **and** the same run has an unsuperseded order result whose status is itself `confirmed` and whose selected event/deterministic edge is identical. Missing, superseded, nonconfirmed, or `duplicate_conversion_events` order results produce `canonicalOrderResultId: null` without making the event anchor stale. Current unmatched, ambiguous, candidate, and duplicate-order-linked conversion events may therefore retain provider claims without implying a canonical order. Plan 4 must use this helper at graph selection and before every per-conversion commit/recovery rather than duplicating either check. A full-publication failure blocks the graph; an entity-only supersession is safe to skip without a claim write so untouched results in a partially overlapped run are not stranded. Tests invalidate each source side independently—including content mutation, digest/identity-link erasure, run deletion/status change, rule/config change—and add a partially overlapped 90-day/7-day run where full run freshness still passes, the replaced event returns `event_result_superseded`, and an untouched old event remains current.

Each Trigger attempt generates a fresh `matchRunId` in memory but performs no database insert before computation. Snapshot approved rules and matcher config, call the pure matcher, verify one result per expected Shopify order and every observed `Placed Order` event, and delegate one atomic publication with both source-run IDs and the run ID. A retry after a caught failed attempt uses a new in-memory ID; a retry after commit returns the already-published fingerprint and its original ID. Recompute when either bound run ID/checksum, approved-rule checksum, matcher version, or scoring-config checksum changes; otherwise return the current version.

- [ ] **Run focused tests and confirm the repository/service do not exist.**

```sh
bun run test -- src/lib/klaviyo/match-repository.integration.test.ts src/lib/klaviyo/match-freshness.test.ts src/lib/klaviyo/match-service.test.ts
```

Expected: FAIL before implementation.

- [ ] **Implement repository, service, and a thin Trigger.dev task.**

Use a `klaviyo-matching` queue with concurrency one. Its payload contains the server-derived `invocationFingerprint`, `connectionId`, `sourceRunId`, `shopifyEvidenceRunId`, `from`, `to`, and an explicit reason (`source_sync`, `manual`, or `rule_change`); the browser never supplies either internal run ID or the fingerprint. Resolve the full connection scope, rederive the canonical fingerprint from both exact scoped evidence projections plus rules/config/windows and require exact equality, then load the exact completed source runs. Require the Klaviyo row's full scope, `operation = "events"`, `status = "success"`, terminal `checkpoint IS NULL`, exact order-core request parameters, and covering requested window; require the Shopify row's exact store scope, covering requested window, and acceptable terminal coverage pair above. Never select merely the latest generic event run or an unrelated latest Shopify run; after Plan 4, a journey run may share the Klaviyo operation/window. At the beginning of each task attempt, generate a fresh `matchRunId` in memory; compute entirely before persistence and pass that ID/fingerprint plus both run IDs to the single publication transaction. Catch ordinary computation/publication errors only to insert a sanitized terminal failed row for that attempt ID/fingerprint and both bound run IDs, then rethrow for Trigger retry; the next attempt uses a new ID. A process crash before either terminal transaction leaves no row, and a retry after a committed publication returns the existing fingerprint/run rather than inserting its new ID. The task result returns the distinct published `matchRunId`; Plan 4 checks `result.ok` before reading it. The task logs only internal run IDs, range, matcher version, and counts. It must not import `shopify-ingest.ts`, `attribution-bucket.ts`, or any function that updates `shopify_order`.

- [ ] **Run focused tests and lint.**

```sh
bun run test -- src/lib/klaviyo/match-repository.integration.test.ts src/lib/klaviyo/match-freshness.test.ts src/lib/klaviyo/match-service.test.ts
bun run lint -- src/lib/klaviyo/match-repository.ts src/lib/klaviyo/match-freshness.ts src/lib/klaviyo/match-service.ts trigger/klaviyo-match.ts
```

Expected: PASS and lint exit 0.

- [ ] **Commit atomic publication.**

```sh
git add src/lib/klaviyo/match-repository.ts src/lib/klaviyo/match-repository.integration.test.ts src/lib/klaviyo/match-freshness.ts src/lib/klaviyo/match-freshness.test.ts src/lib/klaviyo/match-service.ts src/lib/klaviyo/match-service.test.ts trigger/klaviyo-match.ts
git commit -m "feat(klaviyo): publish versioned advisory matches"
```

### Task 6: Expose scoped order-core evidence queries and controls

**Files:**

- Create: `src/lib/klaviyo/queries.ts`
- Create: `src/lib/klaviyo/queries.test.ts`
- Create: `src/lib/klaviyo/match-invocation.ts`
- Create: `src/lib/klaviyo/match-invocation.test.ts`
- Modify: `src/lib/trpc/routers/klaviyo.ts`
- Modify: `src/lib/trpc/routers/klaviyo.test.ts`

- [ ] **Write failing query-service tests.**

Cover connection health, covered date range, explicit not-evaluated order/event counts, all order/event/product statuses, server-side pagination with stable cursors, order explanation with candidate edges, product comparison rows, unmatched event pagination, and stale/failed/boundary warnings. The order ledger starts from scoped Shopify orders and left joins the current result; the event ledger/unmatched view does the symmetric scoped event join. Each returns API-only `not_evaluated` only when its current join is absent. A bounded lateral lookup of that entity's latest superseded result may project only the safe `incident_edge_boundary` reason; it never revives the old conclusion. The `not_evaluated` filters select exactly absent-current rows. Any canonical `confirmed` or selected `candidate` exposure additionally requires reciprocal event and order results to be current, same-run, and same-edge; duplicate fan-in never becomes canonical. A missing reciprocal endpoint maps to `not_evaluated` with the safe boundary caveat rather than surfacing a contradictory cross-run selection. Assert reads never insert/update results. Also prove `orderProducts` returns the published comparison for a reciprocally current confirmed result, returns a separately labelled per-edge diagnostic comparison only when the supplied candidate is reachable through that exact order's current result, never assigns a product status to that diagnostic response, and returns `NOT_FOUND` for a candidate from a superseded entity even if another entity keeps its run current, or from another order, run, connection, or tenant. Assert every query is scoped by organization + store + connection and never returns full HMACs, profile IDs, raw URLs, source property values, or secrets.

- [ ] **Write failing tRPC authorization and input tests.**

All procedures extend the Plan 2 `klaviyoRouter` and use `orgAdminProcedure`. The browser never supplies `organizationId`, `storeId`, or `connectionId`; the router derives organization from `ctx` and resolves the one configured pilot store/connection. Members, API keys, anonymous callers, and cross-tenant result/candidate/Trigger run IDs receive `FORBIDDEN` or `NOT_FOUND` without revealing existence. For `recomputeMatches`, prove the server selects the exact successful order-core Klaviyo source run plus exact acceptable Shopify evidence run, computes a canonical invocation fingerprint over connection, both run IDs, both evidence checksums, approved-rule checksum, matcher/config versions, and both normalized windows, and creates `klaviyo-match:${fingerprint}` through `idempotencyKeys.create(key, { scope: "global" })` with a seven-day TTL. Identical repeated calls return the same live or valid published Trigger handle; changed source/evidence/rules/config/window create a new one. For `matchInvocationStatus({ triggerRunId })`, retrieve the run server-side, require task ID `klaviyo-match`, parse its internal payload, re-resolve its connection plus both bound runs to the active organization/store, and return `NOT_FOUND` for any mismatch before exposing status.

Create the server-only helper in `src/lib/klaviyo/match-invocation.ts`, not in the tRPC router or a Trigger file, and require both the router and Plan 4 supervisor to import it. Its status adapter maps provider states into the closed internal union `live | completed | failed_auto_cleared | terminal_without_publication`: queued/executing/waiting/retrying are live; completed is valid only after output resolves to the verified scoped published row; ordinary failed is the auto-cleared case; canceled, crashed, system-failed, timed-out, expired, and every other documented non-live terminal state map to terminal-without-publication. An unknown/unparseable provider state fails closed without key mutation.

`triggerOrRepairMatchInvocation` follows a bounded deterministic key chain: first the base key above, then—for `terminal_without_publication` or completed without a verified row—`klaviyo-match:${fingerprint}:recover:${sha256(previousTriggerRunId)}`. Every key in the chain is explicitly global and has the same seven-day TTL. If a recovery run is also terminal without publication, derive the next key from that run ID, up to three recovery hops, then return a fixed safe unavailable error. Concurrent callers traverse the same prior run IDs and therefore deduplicate each recovery hop. `failed_auto_cleared` reuses its exact base/recovery key; an in-flight run and a valid completed run are never reset or versioned. The module accepts injected Trigger status/trigger adapters and a scoped published-row verifier, imports no router/session/browser code, and exposes no task payload. Unit tests cover every mapped state, unknown-state fail-closed behavior, base and recovery terminals, completed-without-publication, auto-cleared failure retry, concurrent repeated calls, the recovery bound, and the invariant that live/valid-completed keys are untouched.

Retain Plan 2's `health` and `syncRuns` keys. Extend the health projection with Shopify/Klaviyo source coverage, latest published match fingerprint/timestamp, bounded failed-attempt count, and freshness against both current canonical evidence checksums while preserving its safe no-connection shape, `store.todayInStoreTz`, and nullable `connection.todayInAccountTz`. Failed and published match rows are terminal-only; health never invents a running match database status or treats one failed attempt as terminal invocation failure. Add these procedures so Plan 5 can consume the stable order-core surface:

```ts
coverage
orders
orderExplanation
orderProducts
unmatchedEvents
recomputeMatches
matchInvocationStatus
```

Retain Plan 2's existing `startOrderCoreSync` key and browser date contract unchanged rather than adding a duplicate procedure or scope input.

Use these exact read-model boundaries:

```ts
orders({
  dateFrom,
  dateTo,
  orderStatus?: OrderEvidenceStatus,
  productStatus?,
  claimType?,
  channel?,
  bucket?,
  cursor?,
  limit?,
});

orderProducts({
  orderId: string;
  candidateId?: string;
});

unmatchedEvents({
  dateFrom,
  dateTo,
  eventStatus?: EventEvidenceStatus,
  channel?,
  cursor?,
  limit?,
});
```

`candidateId` is opaque and optional. The server first resolves the active organization/store/connection, then proves that the candidate belongs to the requested order **and is reachable through that exact order's unsuperseded current result**; another current entity on the candidate's historical run is insufficient. With no `candidateId`, `orderProducts` returns only the canonical confirmed comparison or an explicit unavailable/non-canonical state. With a valid `candidateId`, it projects that candidate row's stored, matcher-versioned `diagnosticProductComparison`; it never recomputes against mutable source rows, selects the edge, mutates a result, or returns a published `ProductMatchStatus` for that edge. Test that changing source rows without publishing a new match run does not alter this response, and that superseding only the requested order makes its historical candidate inaccessible while untouched entities keep the old run partially current.

`unmatchedEvents` is the stable non-confirmed event ledger. Its rows expose `eventStatus: EventEvidenceStatus`; `not_evaluated` is API-only and represents a scoped event with no current result after incident-edge closure. Such rows carry only the safe `incident_edge_boundary` warning and wording that the counterpart may lie outside the evaluated window—never a claim that no Shopify order exists globally. `coverage` counts every event status including `not_evaluated` and exposes the boundary-warning count independently. The query uses an event-left-join against current results and applies the optional status filter to the read union, not to stored result enums.

`matchInvocationStatus` maps Trigger run states into the closed safe union `{ status: "running"; invocationFingerprint } | { status: "published"; invocationFingerprint; matchRunId } | { status: "failed"; invocationFingerprint }`. Only successful task output may supply `matchRunId`, and the server verifies that published row, fingerprint, and scope before returning it. Pending/executing/retrying states map to `running`; a canceled, failed, or completed-without-a-verifiable-publication run maps to the same safe terminal `failed`. A failed per-attempt match row does not make the whole invocation failed while Trigger is still retrying; the Trigger run's terminal result is authoritative. Return no task payload, raw error/message, metadata, connection/source IDs, or attempt details.

Browser-facing range inputs use inclusive `{ dateFrom, dateTo }` ISO calendar dates. The router resolves the selected store timezone and converts them to the canonical half-open UTC `HalfOpenWindow`, including DST boundary cases, before calling queries or sending worker payloads; the browser never chooses the timezone or supplies authoritative UTC instants. Test invalid/reversed dates and spring/fall DST transitions. Inputs also use bounded page sizes no greater than 100, opaque cursors, and enum filters. `recomputeMatches` returns `{ triggerRunId, invocationFingerprint }`; the fingerprint is safe opaque server output used only to observe terminal freshness, never as authority. Mutations never wait for a 90-day operation.

- [ ] **Run focused tests and confirm missing query procedures.**

```sh
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/klaviyo/match-invocation.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: FAIL before the query surface is added.

- [ ] **Implement scoped read models and router procedures.**

Keep SQL in `queries.ts`; keep Zod parsing, authorization context, Trigger invocation/idempotency/status retrieval, and safe tRPC error mapping in the router. Derive order `notEvaluated = Shopify orders in range - current published order results in range`. Implement both the count and ledger rows with a scoped Shopify-order `LEFT JOIN` to current results: map a missing join to the API-only `"not_evaluated"` value after the query, and implement its filter as `current_result.id IS NULL`.

Implement `unmatchedEvents` symmetrically from scoped in-range `Placed Order` events with an event-result `LEFT JOIN`, returning the `EventEvidenceStatus` union and filtering event-side `not_evaluated` with the same null-current predicate. A bounded lateral lookup may read only that entity's latest superseded `incident_edge_boundary` reason to project the safe boundary warning; it must not revive status, selected edge, candidate, or claims from the superseded row. Include these rows/counts in `coverage`. Never persist, publish, or backfill a synthetic `not_evaluated` match row on either side. The recompute procedure calls one server-only fingerprint helper, passes only internal IDs, safe windows/reason, and that opaque non-authoritative `invocationFingerprint` to the task, then delegates all Trigger key creation/status repair to `triggerOrRepairMatchInvocation`. The task rederives and verifies the fingerprint before use. The status procedure uses the Trigger SDK only on the server and applies the scoped safe mapping above.

- [ ] **Run focused tests.**

```sh
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/klaviyo/match-invocation.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS.

- [ ] **Commit the order-core API.**

```sh
git add src/lib/klaviyo/queries.ts src/lib/klaviyo/queries.test.ts src/lib/klaviyo/match-invocation.ts src/lib/klaviyo/match-invocation.test.ts src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(klaviyo): expose order evidence queries"
```

### Task 7: Complete erasure and controlled HMAC rotation across both sources

**Files:**

- Modify: `src/lib/shopify-privacy.ts`
- Modify: `src/lib/shopify-privacy.integration.test.ts`
- Modify: `src/lib/klaviyo/connection-lifecycle.ts`
- Modify: `src/lib/klaviyo/connection-lifecycle.test.ts`
- Modify: `src/lib/klaviyo/client.ts`
- Modify: `src/lib/klaviyo/client.test.ts`
- Modify: `src/lib/klaviyo/source-runner.ts`
- Modify: `src/lib/klaviyo/source-runner.test.ts`
- Modify: `src/lib/klaviyo/source-store.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`
- Modify: `src/lib/shopify-evidence-store.ts`
- Modify: `src/lib/shopify-evidence.integration.test.ts`
- Modify: `src/lib/shopify-evidence-runner.ts`
- Modify: `src/lib/shopify-evidence-runner.test.ts`
- Create: `src/lib/klaviyo/identity-rotation.ts`
- Create: `src/lib/klaviyo/identity-rotation.test.ts`
- Modify: `trigger/shopify-evidence-sync.ts`
- Modify: `trigger/klaviyo-source-sync.ts`
- Create: `trigger/klaviyo-identity-rotation.ts`

- [ ] **Write failing cross-source erasure tests.**

Extend the Plan 1 erasure suite after the Klaviyo event tables exist. Given a store-scoped email, compute every configured/currently stored matching-key version plus the stable compliance-purpose suppression HMAC in memory, locate matching Shopify orders and Klaviyo events through scoped digest rows, and collect their customer/profile aliases only long enough to domain-separate and HMAC them. In one store-then-connection-locked transaction, upsert the email/customer/profile suppression rows **before** clearing matching `shopifyCustomerId`, deleting matching identity rows, and deleting associated Klaviyo event evidence. Retain Shopify orders, lines, refunds, Net sales, buckets, and Meta fields. Prove the same email in another store/organization survives and the supplied email, provider aliases, and digests never reach logs or error text.

If a matching-digest version exists in the bounded store data but its required secret is not configured, or the stable suppression key/version is absent or differs from the stored store policy, erasure must fail before writes with a sanitized key-version error. Do not silently erase only the versions that happen to be available. Suppression rows have no 90-day TTL and survive connection uninstall/reinstall; only explicit compliance release or store/organization deletion removes them.

After erasure, replay the same historical Shopify evidence page and both an order-core and journey Klaviyo page. The Shopify writer must keep non-identity order/line observations but persist `identityDisposition: "suppressed"`, clear any current customer ID/digests, and omit the identity-observation link. The Klaviyo writer must skip/delete the subject's event/products/profile/digests/claims and record only a safe suppressed count. Repeat with email absent but a previously tombstoned customer/profile alias present. Race both writers against erasure and prove the store→connection locking order makes either the writer commit first and then be erased, or erasure commit first and the writer suppress; neither schedule recreates personal evidence.

Extend the Plan 2 uninstall coverage too. After `source_identity_kind` expands, `uninstallKlaviyoConnection` must lock the scoped Shopify store before the connection, call `clearPilotShopifyIdentityForStore(scope, tx)` filtered to `source_kind = 'shopify_order'`, then delete the connection so event digests, rotation graphs, and derived evidence disappear through cascade. It deliberately preserves store-scoped erasure suppressions. If the locked store policy is `dual`, that same privacy-safe transaction first proves it matches the deleting connection gate, clears **all** pilot matching identity from both source families, and normalizes the store policy to `current_only` using the already-bound dual **current** label/check with previous null. Before the connection disappears, every uninstall writes the completed store-owned receipt and copies retirement children from the locked gate previous label (when dual) plus every completed rotation previous label that the cascade will remove. Thus uninstall immediately after a successful prune still preserves the just-retired version even though prior mode is already current-only. It never rolls back to the old label, retains no rotation as authority after uninstall, and needs no plaintext subject or secret for deletion. Any failure rolls back receipt/children, policy, clears, and deletion together. Reinstall remains disabled until its environment current secret constant-time matches that retained policy check. A prune/uninstall race serializes on the same locks and observes either complete current-only prune with copied retirement proof or the dual cleanup; policy can never remain stranded dual without a connection.

After Plan 3 is installed, a Shopify evidence commit may collect identity only when that store's unique pilot connection exists and its gate authorizes the write; absent/deleted/pending-disabled connection means lines may refresh but identity is cleared/omitted. Prove uninstall at every dual phase (before/after identity batches, publication, and prune) leaves zero source HMACs, a current-only store policy, preserved suppressions, no live rotation, one valid surviving receipt with the expected retirement children, and a reinstall that fails on the wrong secret but succeeds with the bound current secret. Explicitly test prune→current-only uninstall→previous-secret removal. Also prove uninstall racing either writer cannot recreate pilot identity, all new link/candidate/result rows cascade, and another store/connection/receipt survives.

- [ ] **Write failing rotation-state tests.**

Use an injected workflow harness to prove:

```ts
export type IdentityRotationState =
  | "validating"
  | "reingesting_shopify"
  | "reingesting_klaviyo"
  | "refreshing_shopify_evidence"
  | "refreshing_order_core"
  | "matching"
  | "published"
  | "awaiting_retry"
  | "pruning_previous"
  | "complete"
  | "failed"
  | "aborted";
```

The workflow rejects absent/incomplete previous-key configuration, requires distinct versions/secrets, validates all relevant stored versions, and snapshots the complete retained set of Shopify-order and Klaviyo-event identity sources carrying the previous version—not merely the current 90-day match window. Preparation requires a non-null, explicitly bootstrapped `current_only` gate whose locked current label/check and store-policy current label/check equal the environment **previous** key (the old active key) and its lifetime registry row. Under the store lock it insert-or-loads the proposed new label/check in that registry: a never-seen label binds once; identical historical replay is allowed; any same-label/different-check attempt fails even after prior prune or uninstall. It then atomically changes both store policy and connection gate to `dual` with current = new label/check and previous = old label/check in the same transaction that creates/reuses the graph and membership. The stable suppression pair must match and is not changed. Replay accepts only that exact graph/pair. It re-fetches sparse identity for every retained source missing the new current version, while ordinary gate-aware dual-key incremental writes cover rows created during rotation. Only after every retained source has a current digest does it run a fresh ordinary order-core source/match window, publish a complete match run using the gate's current version only, and prune previous rows. Gate transition makes prior publications visibly stale for freshness/claims immediately, although their result rows remain retained/current-by-entity until replacement; a failure before publication leaves both digest versions and the exact nonterminal graph available to resume, not a falsely fresh old claim surface.

Prove a second manual request with the same scope/key pair reuses the one live database rotation. A different fingerprint may proceed after expiry only when the old graph never committed `dual` and was safely terminalized; after dual, different fingerprints remain rejected until that exact graph completes or passes the explicit rollback-safe abort. Queue concurrency alone is not the mutex. Snapshot membership is stable even when UUID sort order is random, and rows inserted after preparation are handled by dual-key writes plus the final global coverage proof. Before pruning, atomically supersede every older current **result** whose explanation uses the previous key label and lies outside the newly published match window; candidates are immutable attempt history and are exposed only through an exact current incident result. Reads then expose those retained orders/events as `not_evaluated`/stale instead of presenting irreproducible prior-key evidence. Any query accepting `candidateId` must prove the candidate is reachable through that exact current result, not merely that its parent run still has some current entity.

Add lifetime-label regressions across graphs. Complete `v1/checkA → v2/checkB`, then attempt `v2/checkB → v1/checkDifferent` and fail before dual/calls/writes; repeat after uninstall/reinstall and fail against the surviving registry. Reusing `v1/checkA` validates the historical binding but must not create a retired-key receipt child equal to the resulting current label. A prune→uninstall receipt therefore copies distinct noncurrent retired labels only. Candidate explanations, rotation graphs, and receipt children may retain version labels because their store's registry makes each label resolve to one lifetime check.

Also model crash/replay at every stage boundary. A retry or recovered rotation must reconstruct the same database graph, retain each append-only publication attempt and its distinct Trigger/database IDs, and never infer publication from an in-memory return value. Simulate failure immediately before and after each metadata flush and child handoff, after source completion, immediately before and after match publication, and immediately before and after the pruning transaction. Before `dual` is committed, validation failure may terminally mark the graph `failed`. After `dual` is committed, an ordinary task/hook failure may only record a safe attempt code/heartbeat and leave the exact graph nonterminal in `awaiting_retry`; expired-lease reconciliation resumes or repairs that graph and never creates a competing rotation. Replaying after publication resumes at pruning; replaying after an atomically committed prune verifies both policy/gate cutover and zero previous-version rows, then finishes without requiring a second delete.

Test privacy erasure before snapshotting, between snapshot and an identity batch, during a batch, after source completion, and after a publication attempt. Under store→connection locks it converts any matching live membership to `suppressed` with its durable tombstone proof before source deletion. Every ordinary Shopify/Klaviyo writer and rotation batch performs the same transition on a suppression hit for `pending`, `complete`, and `unavailable` members before clearing identity or deleting an event; test all three states for both sources, including an unavailable source that later reappears. Rotation coverage accepts a `suppressed` member only when that exact scoped tombstone still exists and matches the stable suppression policy; it does not require or recreate a current digest for that subject. An unavailable member without a tombstone is not equivalent to `suppressed` and still blocks pruning. Explicit compliance release locks store then connection, rejects any tombstone referenced by a nonterminal rotation, and for terminal rotations atomically marks referencing memberships `released` before deleting the tombstone; test both outcomes and FK enforcement.

- [ ] **Run the focused privacy tests and establish red.**

```sh
bun run test -- src/lib/shopify-privacy.integration.test.ts src/lib/shopify-evidence.integration.test.ts src/lib/shopify-evidence-runner.test.ts src/lib/klaviyo/connection-lifecycle.test.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/identity-rotation.test.ts
```

Expected: FAIL because Klaviyo event erasure and rotation orchestration are missing.

- [ ] **Implement transactional erasure and an explicit rotation service.**

Extend the existing store-scoped erasure transaction instead of creating a second public erasure path. Any cross-source erasure locks the scoped Shopify store first and Klaviyo connection second. Before deleting an event/source that belongs to a live rotation, convert its membership to `suppressed` with the exact scoped tombstone reference. Before event/candidate cascades, resolve every current incident order result through selected edges, all candidate edges, and duplicate-event fan-in membership; supersede those conclusions with `privacy_erasure` even when an `ambiguous` or `duplicate_conversion_events` row has no selected edge. Then delete the subject event so its claims/evidence/event result and candidate edges cascade, collect all affected match-run IDs across both sides, call `recountMatchRunCurrentness` afterward, and mark coverage stale until recomputation. Deletion takes precedence over explicit event-result retention, but must never leave a stale incident order conclusion with obsolete candidate counts/reasons. Add confirmed, candidate, ambiguous, and duplicate-fan-in erasure regressions. `prepareIdentityRotation` uses the same store-then-connection order, reconciles only an expired nonterminal rotation, rejects a live different graph, and transactionally inserts/reuses the durable rotation row plus one materialized membership row for every retained Shopify/Klaviyo source carrying the previous digest. No checkpoint relies on a random UUID high-water mark.

Replace Plan 1's current-only Shopify runner check with one closed gate-aware preflight returning `{ identityMode: "disabled" | "current_only" | "dual" }`. Before any identity-bearing remote request, `shopify-evidence-runner.ts` locks store then the uniquely eligible pilot connection, validates the lifetime key registry, connection gate, store crypto policy, suppression binding, and fixed-context environment key checks, then releases locks. `disabled` covers absent/deleted/ineligible/unbootstrapped connection and skips the protected identity request entirely while still allowing identity-free order/line refresh; its commit clears/omits pilot identity. `current_only` authorizes exactly the stored current pair; `dual` authorizes exactly both stored pairs. `trigger/shopify-evidence-sync.ts` must inject this preflight instead of Plan 1's narrower `ensureCryptoPolicy`. The commit reacquires the same locks and revalidates the exact preflight decision so uninstall or gate change cannot race a stale response. Add zero-protected-call tests for disabled/uninstall races and same-label/different-secret configuration, including a historically retired label.

Apply the same fail-closed boundary to `source-runner.ts`, its Trigger wrapper, later Plan 4 journey ingestion, and dedicated rotation fetches: immediately before **each** provider request, briefly load and validate the exact lifetime-registry+gate+policy+environment binding, release locks for the request, and revalidate it at commit. Same-label/different-secret (including historical reuse), missing required dual key, changed gate, or changed suppression policy produces zero subsequent client calls and zero evidence writes. Both writers check HMAC-only erasure suppressions before identity persistence. On a hit, either writer or rotation batch must attach the exact tombstone and transition any pending/complete/unavailable live membership to `suppressed` in the same locked transaction **before** clearing Shopify identity or deleting Klaviyo source evidence. Dedicated rotation batches obey the same gate and per-source locks, while any transaction inspecting/mutating both source families takes store then connection. No remote call occurs under these locks.

Implement the worker as durable orchestration over that database graph, its retained-source membership, a fresh acceptable Plan 1 Shopify evidence run, a fresh order-core source run, and the match run rather than inventing a `klaviyo_sync_run` operation. Establish one closed single-event client request union in Plan 2's client; callers select a purpose and cannot construct arbitrary includes:

```ts
export type KlaviyoSingleEventRequest =
  | { purpose: "identity_rotation"; include: ["profile"]; profileFields: ["email"] }
  | { purpose: "attribution_claim"; include: ["metric", "attributions"] }
  | { purpose: "referenced_interaction"; include: ["metric"] };
```

Add the pinned `getEventById({ connectionId, externalEventId, request })` method with the same exact-host/revision/redaction tests; `identity_rotation` is the only branch that sparse-includes profile email, while the two Plan 4 claim purposes never do. It requires the primary returned ID to equal the requested stored external ID, rejects every extra/altered include or sparse field, and returns a purpose-discriminated safe result rather than a generic included-resource map. Dedicated bounded rotation batches call Plan 1's Shopify identity fetcher by stored order ID and this single-event method with `request: { purpose: "identity_rotation", include: ["profile"], profileFields: ["email"] }` by stored event ID, but may update only `source_identity_hmac` and rotation-source status; they never create/replace orders, lines, events, products, or monetary/source observations.

After every materialized retained source is complete and a connection-scoped query proves no retained previous-version source lacks the current version, invoke an ordinary Plan 1 evidence run for the canonical current match window and retain its exact acceptable `shopifyEvidenceRunId`; then invoke the ordinary Plan 2 order-core runner and retain its exact `sourceRunId`. Invoke Plan 3 matching only with that pair. Matching compares only the configured current digest version; never copy a digest to an unversioned source column.

Define a closed, bounded `IdentityRotationCheckpoint` persisted on `klaviyo_identity_rotation_run` with state, stable membership cursors/counts for both source kinds, canonical current match window, per-stage deadline, current publication-attempt number, and canonical child key. Per-publication Shopify-evidence Trigger/run IDs, order-core Trigger/source-run IDs, match invocation/published-match IDs, source checksums, and safe attempt outcome live in the append-only attempt child instead of being overwritten on the parent. Neither shape contains a secret, digest, provider ID, raw error, or source payload. The task payload is exactly `{ rotationRunId }`; it loads scope/fingerprint/version labels/membership from the row. Mirror only the safe checkpoint to Trigger metadata: before every child handoff and explicit durable poll wait, commit the database checkpoint/attempt, then call `metadata.set("rotation", checkpoint)` and `await metadata.flush()`. For `triggerAndWait`, persist/flush the stage/key before the call; when its durable wait resumes, capture `result.id`, persist/flush that ID, and only then inspect `result.ok` or output. Renew the graph heartbeat at every entry/commit/wait boundary, use a 20-minute expired-lease reconciler and bounded per-stage waits, reconcile only expired Plan 1/2/rotation leases, and launch no dependent from partial/failed/live-at-deadline upstream state. Do not use `Promise.all`.

All child keys are created with explicit `{ scope: "global" }` and seven-day TTL. A key includes `rotationRunId`, fingerprint, publication-attempt number, stage, and the owning persisted membership cursor/run ID; matching delegates to `triggerOrRepairMatchInvocation`. The rotation entry uses `klaviyo-identity-rotation:${rotationRunId}:${rotationFingerprint}` and the same closed terminal-status recovery mapping as matching, so concurrent retries of one database graph resolve one live child and a canceled/crashed/timed-out handle cannot block recovery. A different fingerprint cannot create another graph while the partial unique guard is live.

An ordinary dual writer or tombstone-proven privacy erasure may change exact membership/projection at any point after a publication attempt fixes its first source run: between Shopify completion, order-core completion, match handoff/commit, or after match publication before prune. At the next source preflight, match failure, or prune proof, classify only that fully proven authorized mutation as `rotation_projection_changed` with safe subtype `ordinary_dual_write | privacy_erasure`. Mark the current attempt `stale` even if it never published, retain all IDs/history, move the parent back through fresh Shopify evidence → order core → matching, and create the next monotonically numbered attempt with new durable keys/IDs. The fresh attempt excludes a tombstone-suppressed subject and proves the updated materialized membership; it never tries to reconstruct deleted evidence. Allow at most three automatic publication attempts per task invocation; exhaustion leaves the graph nonterminal `awaiting_retry` for explicit resume rather than looping or pruning. Any other freshness failure is fail-closed. Tests inject both writer kinds and erasure at every boundary above, prove each forces a new complete attempt, and prove a retry resumes a live child for the same attempt without overwriting history.

The pruning transaction is the only destructive rotation step. It locks the scoped Shopify store first and scoped Klaviyo connection second, requires both policy and gate still be the graph's exact `dual(current = new, previous = old)` pair, revalidates the durable graph/version labels and complete materialized membership, accepts `suppressed` only with its exact surviving tombstone/policy proof, proves globally that every other retained source with a previous digest also has a current digest, and proves that the exact current publication attempt's match run is still current and bound to that attempt's Shopify evidence run and order-core run. Recompute and compare the full canonical publication projection: Shopify order membership/deterministic fields/lines/current identity and dispositions plus exact Klaviyo observations/current identity, both run IDs/windows/coverage labels, rule/config checksums, matcher version, and fingerprint. An event-only or identity-only proof is insufficient. If this is either proven authorized projection change above, atomically mark the attempt stale and rewind without deleting; every other failed proof is a fixed-code no-delete outcome and leaves the graph nonterminal with policy/gate dual.

On a valid proof, collect affected match-run IDs and, in the same transaction, atomically switch **both** the store crypto policy and connection gate to `current_only(current = new label/check, previous = null)` while preserving/revalidating the suppression binding; supersede only older current results that retain the previous label; delete only previous-version **digest** rows but never either lifetime key-binding row; call `recountMatchRunCurrentness`; record safe counts; and finish the rotation `complete`. Candidates remain immutable history and their version labels stay resolvable through the registry. Because blocked writers read the gate only after acquiring these locks, a writer released after prune cannot reinsert old rows even while old environment variables remain. Event content checksums are identity-free and match inputs/explanations use the current version, so pruning does not mutate the new publication's semantic input. Metadata state alone is never publication proof, and no child/hook can prune. Add rollback tests proving policy and gate cannot split, plus post-prune tests for both writers, retained lifetime bindings, and publication freshness.

Add writers paused immediately before, during, and after prune. Prove prune either waits for an earlier dual-key commit and sees both rows, or commits the `current_only` cutover first and the released writer emits only current. Immediately after prune, run both ordinary writers while the previous environment pair is intentionally still present and prove zero previous-version row can reappear.

- [ ] **Add a thin manual-only Trigger.dev rotation task.**

Add a server-only `startIdentityRotation` entry that resolves organization/store/connection authority, loads the environment keyring, derives the canonical current 90-day match window, computes the opaque fingerprint over scope/key labels/window, and calls `prepareIdentityRotation`. It then triggers only `{ rotationRunId }` through the graph-qualified recovery helper. The task uses concurrency one only as provider-load control, `retry: ATTRIBUTION_TASK_RETRY`, `maxDuration: 600`, and reports only durable state, distinct run IDs, safe counts, and key-version labels. Its terminal `onFailure` is phase-aware: before the atomic dual transition it may fixed-code finish validation as `failed`; after dual it only records safe attempt/heartbeat state and leaves the exact graph nonterminal `awaiting_retry`. It never prunes or persists an error. A skipped hook converges through expired-lease reconciliation of that same graph. If a pre-dual validation failure is abandoned rather than corrected/retried, DB authority is still old current-only while the deployment may already expose new-current/old-previous variables; ordinary writers remain fail-closed until the operator performs the same old→ordinary-current environment cutback and `verifyIdentityWriterReadiness` proof described below. Test both exact retry and failed-before-dual abandonment/cutback.

Provide a separate operator-only `abortIdentityRotation` service, not a task hook or Plan 5 action. It is allowed only after dual and before **any** new-key match publication. Under store→connection locks it proves every new-version row has its corresponding old-version row, deletes only those rollback-safe new rows, restores both policy and gate atomically to `current_only(old label/check)` backed by its lifetime registry row, recounts any affected runs, and terminalizes the graph `aborted` with safe `requiresEnvironmentCutback: true`. Once any new-key publication exists, abort is forbidden and the operator must resume through prune.

Abort deliberately leaves ordinary writers fail-closed until the operator completes this explicit environment cutback: verify the graph is `aborted`, policy/gate are old current-only, and an independent scoped query finds zero new-version rows; promote the old version/secret from the rotation previous variables back into the ordinary current variables; remove the new secret and all previous-rotation variables; then call a server-only `verifyIdentityWriterReadiness` that recomputes the fixed-context check and constant-time matches the lifetime registry, store policy, and connection gate before resuming tasks. The old secret is not removed. A wrong/partial deployment keeps protected calls and identity writes disabled. Tests run both writers before cutback (zero protected calls/writes), after correct cutback (old current-only succeeds), and after wrong-secret cutback (still fail-closed).

Source-boundary tests assert full retained membership, suppression races, rows arriving during dual-key rotation, unavailable old Shopify/event identity fetches causing no prune, graph exclusivity, explicit global keys/TTLs, database checkpoint plus metadata flush before handoff/wait, bounded waits, result-ID/`ok` guards, no parallel waits, safe abort/environment-cutback boundaries, and recovery for every non-live terminal status. Do not expose rotation or abort in Plan 5 or schedule rotation automatically.

Removing a previous environment secret remains an operator step after either of two exact proofs for that version label: (a) the database rotation graph reports `complete`, policy/gate are current-only at new, and an independent scoped query finds zero rows for the previous version; or (b) uninstall removed the connection/graph, a completed store-owned receipt has the version in its retirement children and records the resulting current label/check, the store policy still matches that current-only binding, and independent scoped queries find no connection/live graph and zero rows for the retired version. This second proof covers prune followed by uninstall before secret removal. An absent graph or receipt without the matching child is never sufficient.

- [ ] **Run tests and lint.**

```sh
bun run test -- src/lib/shopify-privacy.integration.test.ts src/lib/shopify-evidence.integration.test.ts src/lib/shopify-evidence-runner.test.ts src/lib/klaviyo/connection-lifecycle.test.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/identity-rotation.test.ts
bun run lint -- src/lib/shopify-privacy.ts src/lib/shopify-evidence-store.ts src/lib/shopify-evidence-runner.ts src/lib/klaviyo/connection-lifecycle.ts src/lib/klaviyo/client.ts src/lib/klaviyo/source-runner.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/identity-rotation.ts trigger/shopify-evidence-sync.ts trigger/klaviyo-source-sync.ts trigger/klaviyo-identity-rotation.ts
```

Expected: exit 0.

- [ ] **Commit the identity lifecycle.**

```sh
git add src/lib/shopify-privacy.ts src/lib/shopify-privacy.integration.test.ts src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts src/lib/shopify-evidence-runner.ts src/lib/shopify-evidence-runner.test.ts src/lib/klaviyo/connection-lifecycle.ts src/lib/klaviyo/connection-lifecycle.test.ts src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/source-runner.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/identity-rotation.ts src/lib/klaviyo/identity-rotation.test.ts trigger/shopify-evidence-sync.ts trigger/klaviyo-source-sync.ts trigger/klaviyo-identity-rotation.ts
git commit -m "feat(privacy): complete Klaviyo identity lifecycle"
```

### Task 8: Lock advisory isolation and complete the Plan 3 gate

**Files:**

- Create: `src/lib/klaviyo/advisory-isolation.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-31-klaviyo-shopify-evidence-pilot-design.md` only if the live probe changes an approved rule or go/no-go decision

- [ ] **Add a reconciliation regression test around a full source/match replay.**

Seed Shopify orders/refunds with every production bucket and Meta-verification state. Snapshot order count, Net sales, refunds, bucket values/rule versions, Meta fields, and the outputs of `getBucketTotals` and `getMetaVerified`. Ingest/replay Klaviyo order events, publish/recompute matches, and assert exact equality of the snapshot and query outputs. Also assert there is no product revenue or allocated-revenue column in the new schema.

- [ ] **Run all Plan 3 suites.**

```sh
bun run test -- src/lib/klaviyo/client.test.ts src/lib/klaviyo/event-normalizer.test.ts src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/persistence.integration.test.ts src/lib/klaviyo/match-normalization.test.ts src/lib/klaviyo/product-match.test.ts src/lib/klaviyo/matcher.test.ts src/lib/klaviyo/match-repository.integration.test.ts src/lib/klaviyo/match-freshness.test.ts src/lib/klaviyo/match-service.test.ts src/lib/klaviyo/match-invocation.test.ts src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts src/lib/shopify-privacy.integration.test.ts src/lib/klaviyo/connection-lifecycle.test.ts src/lib/klaviyo/identity-rotation.test.ts src/lib/klaviyo/advisory-isolation.integration.test.ts
bun run test
bun run lint
bun run build
git diff --check
```

Expected: every command exits 0; `git diff --check` prints nothing.

- [ ] **Record the Plan 3 stop/go evidence.**

Confirm the current published view contains exactly one explicit result for every evaluated Shopify order and in-scope native `Placed Order` event; diagnostic edges never confirm; duplicate conversions are visible; product conclusions exist only for confirmed orders; and the measured deterministic coverage is recorded in the durable probe/report metadata. If coverage is too low to make the playground useful, stop before Plan 4 and amend the design with the go/no-go decision.

- [ ] **Commit the isolation lock.**

```sh
git add src/lib/klaviyo/advisory-isolation.integration.test.ts docs/superpowers/specs/2026-07-31-klaviyo-shopify-evidence-pilot-design.md
git commit -m "test(klaviyo): prove matching remains advisory"
```
