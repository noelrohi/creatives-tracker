# Klaviyo + Shopify Evidence Pilot Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Reviv Klaviyo evidence pilot through five independently verifiable implementation plans without changing Shopify money or production attribution.

**Architecture:** Build the safety and Shopify evidence boundary first, then ingest a redacted Klaviyo source core, publish versioned advisory matches, enrich those matches with claims/reports, and finally expose the order-first playground. Each plan has its own migration, tests, acceptance gate, and Conventional Commit sequence; later plans depend only on committed interfaces from earlier plans.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, tRPC 11, Drizzle ORM/PostgreSQL, Trigger.dev 4, TanStack Query, Tailwind CSS 4, shadcn/ui, Vitest, Bun.

---

## Approved source

- Design: `docs/superpowers/specs/2026-07-31-klaviyo-shopify-evidence-pilot-design.md`
- Working branch: `feat/klaviyo-shopify-evidence-pilot`
- Baseline design commit: `c2b38bd`

The design remains authoritative when a plan omits background explanation. Any change to advisory-only behavior, HMAC-only email storage, tenant/store scoping, the 90-day initial window, allowlisted events, raw-data redaction, or no-allocation policy requires a design amendment before code changes.

## Execution order

| Order | Plan | Working result | Gate for next plan |
| --- | --- | --- | --- |
| 1 | [`2026-07-31-klaviyo-01-shopify-evidence-foundation.md`](./2026-07-31-klaviyo-01-shopify-evidence-foundation.md) | Safe store ownership plus separately synced Shopify line/identity evidence | Existing monetary reconciliation is byte-for-byte unchanged and 90-day line coverage is measurable |
| 2 | [`2026-07-31-klaviyo-02-source-ingestion.md`](./2026-07-31-klaviyo-02-source-ingestion.md) | Reviv-bound Klaviyo connection, discovery/probe, redacted `Placed Order`/`Ordered Product` source core | Probe is persisted and approved; replay creates no duplicates |
| 3 | [`2026-07-31-klaviyo-03-advisory-matching.md`](./2026-07-31-klaviyo-03-advisory-matching.md) | Atomic, versioned order/event results and product evidence comparisons | Every evaluated order/event has an explicit state and no diagnostic edge confirms an order |
| 4 | [`2026-07-31-klaviyo-04-claims-reporting.md`](./2026-07-31-klaviyo-04-claims-reporting.md) | Nullable attribution claims, campaign/flow dimensions, allowlisted journeys, and separately labelled reports | Unknown relationships remain unknown; report values cannot enter order matching |
| 5 | [`2026-07-31-klaviyo-05-playground.md`](./2026-07-31-klaviyo-05-playground.md) | Owner/admin-only `/attribution/klaviyo` playground | UI exposes all required states while `/attribution` calculations remain unchanged |

Plans execute linearly. Plan 4 may be deferred after Plan 3 if the Reviv probe shows insufficient order linkage, but Plan 5 as written expects all four backend plans.

## Design coverage

| Approved design area | Owning plan |
| --- | --- |
| Truth boundaries, Shopify store safety, line/identity enrichment, erasure | Plan 1 |
| Connection binding, API client, discovery, redaction, durable probe, source core | Plan 2 |
| HMAC event identity, deterministic/diagnostic matching, product comparison, publication | Plan 3 |
| Campaign/flow dimensions, nullable claims, exact-profile journeys, aggregate reports | Plan 4 |
| Owner/admin route, coverage ledger, detail explanation, safe inspector, separate reports | Plan 5 |
| Rate limits, resumability, stale-data preservation | Plans 1–4, surfaced by Plan 5 |
| HMAC rotation and subject/connection deletion | Plans 1–3 |
| Monetary/production-attribution isolation | Plans 1 and 3, regression-checked again in Plans 4–5 |
| Reviv stop/go rollout and post-pilot decisions | This roadmap plus the Plan 2/3 gates |

## Migration order

Run schema generation only in the plan that owns the corresponding schema change:

1. Plan 1: `bun run db:generate --name klaviyo_shopify_evidence` must create `drizzle/0053_klaviyo_shopify_evidence.sql`.
2. Plan 2: `bun run db:generate --name klaviyo_source_core` must create `drizzle/0054_klaviyo_source_core.sql`.
3. Plan 3: `bun run db:generate --name klaviyo_advisory_matching` must create `drizzle/0055_klaviyo_advisory_matching.sql`.
4. Plan 4: `bun run db:generate --name klaviyo_claims_reporting` must create `drizzle/0056_klaviyo_claims_reporting.sql`.

Never run `db:push`; it is disabled by repository policy. Inspect every generated SQL migration and snapshot before `bun run db:migrate`.

## Cross-plan interfaces

The following names are stable contracts. Change them once in the owning plan and update every later plan before execution rather than creating aliases:

```ts
export type KlaviyoConnectionScope = {
  organizationId: string;
  storeId: string;
  connectionId: string;
};

// Owned by src/lib/evidence-window.ts in Plan 1; later plans import it.
export type HalfOpenWindow = {
  from: Date;
  to: Date;
};

export type OrderCoreRunParameters = {
  sourceMode: "order_core";
  metricKinds: ["placed_order", "ordered_product"];
};

export type JourneyRunParameters = {
  sourceMode: "journey";
  metricKinds: [
    "clicked_email",
    "clicked_sms",
    "active_on_site",
    "viewed_product",
    "added_to_cart",
    "checkout_started",
  ];
};

export type KlaviyoEventRunParameters =
  | OrderCoreRunParameters
  | JourneyRunParameters;

export type OrderMatchStatus =
  | "confirmed"
  | "candidate"
  | "ambiguous"
  | "no_klaviyo_event"
  | "duplicate_conversion_events";

// Read model only; never persisted as a match-result status.
export type OrderEvidenceStatus = OrderMatchStatus | "not_evaluated";

export type EventMatchStatus =
  | "confirmed"
  | "candidate"
  | "ambiguous"
  | "unmatched";

// Read model only; never persisted as a match-result status.
export type EventEvidenceStatus = EventMatchStatus | "not_evaluated";

export type ProductMatchStatus =
  | "exact"
  | "partial"
  | "contradictory"
  | "unavailable";
```

Every persistence or query entry point below the task/bootstrap boundary that touches Klaviyo accepts `KlaviyoConnectionScope`; no function joins on a provider ID without it. A Trigger task may receive globally unique internal resource IDs (`connectionId`, `evidenceRunId`, `syncRunId`, `sourceRunId`, `matchRunId`, or a workflow-graph ID) plus safe ranges/reasons, resolve scope from those rows, and then pass the derived full scope to every service/repository call. Browser and task payloads never carry authoritative organization/store scope. Internal time-based syncs accept a half-open UTC `[from, to)` window. Browser order/evidence filters use inclusive `{ dateFrom, dateTo }` calendar dates, which the authorized router converts with the selected Shopify store timezone (including DST). Plan 4 report ranges are the deliberate exception: the router converts those dates with the bound Klaviyo account timezone and preserves message-send-date semantics.

Plan 1's Shopify evidence start payload is mode-only (`initial_90d` or `incremental_7d`); it resolves the single configured store and derives its DST-correct range server-side. Its PostgreSQL `evidenceRunId` is distinct from its Trigger `triggerRunId`, and every committed order has immutable exact-run observation membership/checksum. Plan 2 event runs persist the direct closed `sourceMode`/`metricKinds` parameters even after their terminal checkpoint becomes null and own equivalent immutable event observations. Plan 3 creates no pre-compute running match row: each attempt holds its ID/start time in memory and persists only an atomic published or sanitized failed terminal row tied to the exact acceptable Shopify `evidenceRunId`, exact successful order-core `sourceRunId`, and both current-equals-observed canonical checksums. Later failed refreshes cannot donate mutable source rows to either bound run. Publication replaces directly evaluated entities and closes selected/dependent incident edges in both directions, including duplicate-event fan-in; outside-window counterparts become API-only `not_evaluated`, while inside no-event/unmatched results carry a window-boundary caveat. Untouched entities may keep an older run partially current, and a shared locked recount marks a nonempty run superseded only when its final result is noncurrent. Exact zero-result publications remain fresh until a later publication with the same logical scope explicitly supersedes them. Plan 4 claim continuations bind both source IDs through the published `matchRunId` and rederive full dual-source publication freshness. Every selected/attempting conversion must also retain its exact unsuperseded event result, and provider preflight plus final commit revalidate the same policy/gate/environment binding; only confirmed canonical order attachment and `claimCount` additionally require the same run's same-edge unsuperseded order result. A replaced anchor cannot receive claim writes, but untouched current anchors continue.

Every database-backed `running` workflow has a scoped heartbeat renewed atomically with entry/checkpoint commits, a bounded task duration, and an expired-lease reconciler. Ordinary graphs have an idempotent fixed-code retry-exhaustion finalizer; identity rotation is phase-aware—before dual it may fail terminally, but after dual failure remains nonterminal/recoverable until complete or rollback-safe abort. Initial and continuation handoffs use internal-run/checkpoint-qualified keys created with explicit Trigger global scope and seven-day TTLs, so replacement parents resolve the same child; a fresh claims replay adds a new server-generated replay ID so it cannot resolve an earlier graph. Fingerprint-owned matching and replay-owned claims use bounded deterministic recovery keys after canceled/non-publishing terminal handles. Trigger `onFailure` is best-effort only; fresh starts and the Plan 4 supervisor reconcile expired rows because crashed/system-failure/canceled/max-duration states may skip the hook. Reconciliation never reaps a live lease or deletes committed source/evidence, and every supervisor poll has a durable deadline. No dependent launches from a live, failed, stale, unavailable, or unapproved partial upstream; the one explicit exception is Plan 1's policy-labelled Shopify `partial + partial` line coverage, which Plan 4 may accept while preserving its visible partial status.

Plan 1 intentionally creates Shopify-only `source_identity_hmac` rows plus identity-free Shopify run observations, exact HMAC-row identity links, an append-only store lifetime registry mapping every matching-key label to one non-subject fixed-context check, an active `identity_crypto_policy`, and HMAC-only compliance suppressions. Plan 3 extends the HMAC table only after `klaviyo_event` exists: it adds nullable `klaviyo_connection_id` and `klaviyo_event_id`, adds the Klaviyo source kind/profile-alias suppression kind, enforces exactly one source plus a same-scope event foreign key, replaces only the Shopify source/version uniqueness with one partial unique index per source kind/version, and retains/adds the scoped row-ID keys required by both source families' identity-observation foreign keys. Same-digest replay reuses an immutable row ID; changed digest replacement, erasure, uninstall, and previous-version pruning cascade dependent identity links, while the lifetime label/check binding survives. Both scheduled writers check suppressions and validate registry + store policy + connection `current_only | dual` gate + environment checks under fixed locks before identity-bearing calls and again at commit. Rotation uses stable materialized membership that can transition from pending/complete/unavailable to tombstone-proven `suppressed` (or a post-terminal non-identifying `released` receipt), append-only bounded publication attempts, recoverable post-dual failures, writer/erasure projection-change rewind at any attempt stage, and one atomic policy+gate prune. Connection uninstall uses store→connection order, clears both source families, preserves registry/suppressions, normalizes any dual store policy to its bound current label/check, and records a store-owned completion receipt plus distinct noncurrent gate/completed-rotation retired-version children before cascading the connection/rotation so reinstall and prune→uninstall secret retirement retain executable proof.

Plan 1 owns `HalfOpenWindow` in `src/lib/evidence-window.ts`; Plan 2 re-exports that exact type from `src/lib/klaviyo/types.ts` and owns `KlaviyoConnectionScope` plus the allowed metric kinds there. Plan 2 also owns `klaviyo_event`/`klaviyo_event_product` in `src/schema/klaviyo.ts`; its normalized source record retains only bounded attribution relationship IDs, which Plan 4 must resolve against the same stored conversion event before publishing claims. Later plans import and extend those contracts; they do not redeclare the types or create parallel event schemas, normalizers, stores, runners, Trigger tasks, or router procedures. Plan 3 owns the match-status types and `MATCHER_VERSION` in `src/lib/klaviyo/match-types.ts`.

The browser-facing `trpc.klaviyo` contract is additive across Plans 2–4 and consumed unchanged by Plan 5:

- Reads: `health`, `syncRuns`, `probe`, `coverage`, `orders`, `orderExplanation`, `orderProducts`, `orderJourney`, `orderClaims`, `orderInspector`, `unmatchedEvents`, `reports`, and `matchInvocationStatus`.
- Actions: `startDiscovery`, `runProbe`, `approveProbe`, `rejectProbe`, `approveJoinRule`, `rejectJoinRule`, `startOrderCoreSync`, `recomputeMatches`, `refreshReports`, and `uninstall`.
- No browser input contains organization, store, connection, private-key, profile, or identity-digest authority. Resource IDs are always re-scoped server-side.
- Order/evidence day inputs use the Shopify store timezone; report day inputs use the bound Klaviyo account timezone and send-date semantics.
- `orders.orderStatus` uses query-only `OrderEvidenceStatus`; `unmatchedEvents.eventStatus` uses query-only `EventEvidenceStatus`, includes event-left-joined boundary rows, and never equates `not_evaluated` with globally unmatched. `orderProducts` may take a scoped opaque `candidateId` only when reachable through that exact entity's current result and never turns that edge into a published product conclusion.

## Global verification after each plan

- [ ] Run the focused Vitest files listed by the active plan with `bun run test --` and obtain exit code 0.
- [ ] Run `bun run test` and obtain exit code 0.
- [ ] Run `bun run lint` and obtain exit code 0.
- [ ] Run `bun run build` and obtain exit code 0.
- [ ] Run `git diff --check` and obtain no output.
- [ ] Confirm `git status --short` contains only files named by the active plan before each commit.
- [ ] Use the exact Conventional Commit messages in the active plan.

Database-backed tests may skip when `DATABASE_URL` is unavailable, following the existing manager-router test pattern. They must run against the configured disposable test database before a plan is considered complete.

## Pilot stop/go gates

After Plan 2, stop before Plan 3 unless the probe report has:

- 20–50 sampled recent Shopify orders;
- one explicitly bound Reviv Klaviyo account;
- uniquely identified Shopify-native `Placed Order` and `Ordered Product` metrics;
- zero collisions for any approved deterministic join rule;
- persisted redaction/property-shape results;
- no plaintext email or unrestricted URL in the database or logs.

After Plan 3, stop before Plans 4–5 if deterministic order coverage is too low to make the playground useful. There is deliberately no hard match-rate threshold; record the measured rate and make the go/no-go decision explicit in the probe report.

## Final pilot invariants

- [ ] Shopify order count, Net sales, refunds, bucket totals/rule versions, and Meta-verification totals match the pre-pilot snapshot exactly.
- [ ] Klaviyo source replay and trailing-seven-day refresh create no duplicate provider records.
- [ ] Simulated exhausted, crashed, canceled, and skipped-hook runs leave no permanently running row or blocked partial unique index; committed checkpoints/data remain intact.
- [ ] Ninety days remains the initial retrieval boundary; forward incremental records are retained for the pilot and no plan adds automatic age-based pruning.
- [ ] Every inspected Shopify order distinguishes evaluated/no-event from not evaluated.
- [ ] Every in-scope Klaviyo `Placed Order` event has a current explicit result or an API-only incident-boundary `not_evaluated` state with no global-absence claim.
- [ ] Diagnostic HMAC/time/product evidence never produces `confirmed`.
- [ ] Product observations never create allocated revenue.
- [ ] Aggregate reports remain separate from order claims and matching.
- [ ] Organization/store deletion and Klaviyo uninstall remove the identity/evidence required by the design.
- [ ] `/attribution` returns the same calculations before and after the pilot; `/attribution/klaviyo` is owner/admin-only.
