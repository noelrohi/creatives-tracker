# Klaviyo Claims Continuity — Design

2026-08-28 · brainstormed and approved with owner. Branch `feat/klaviyo-claims-continuity`.

## Problem

Production publishes match runs (fixed 2026-08-27) but the email revenue panel still shows `$0 tied to email`. Measured in the prod database:

- 1,182 confirmed orders in the 7-day window; **124 conversions have claim coverage**.
- Both claim replay runs finished `stale`, not `success`.
- The 9 claims that exist sit on window-edge events that are `unmatched` in the current publication, so they contribute no revenue.

Two independent causes, both quantified:

1. **Cancellation.** A replay is bound to one match run and finishes `stale` whenever that publication's freshness check fails — which in production happens constantly (a new publication supersedes the old run's results; hourly Shopify ingest drifts the input checksums). Observed throughput is ~700 conversions/hour, so the 1,184 backlog needs ~1.7 hours of *uninterrupted* running that it never gets. Arrivals (~175 orders/day) outpace the ~100 conversions completed per pass, so the backlog grows forever.
2. **Refresh tax.** The in-scope rule re-fetches every conversion inside a 14-day lookback on every run — ~2,450 conversions ≈ 3.5 hours per pass at prod volume, dwarfing the backlog itself.

**Core insight (owner's):** Klaviyo's attribution for a conversion event is an immutable per-conversion fact. Claims are keyed by `conversion_event_id`, never by match run. Binding a replay to one publication and killing it when inputs churn is over-strict.

## Decisions

| Decision | Choice |
| --- | --- |
| Approach | **Narrow the claims predicate (§0) + rebind on supersession (§1)** — not the full standing-backlog rewrite, not throughput-only. |
| Cursor on rebind | Continue from the existing cursor; never reset. |
| Refresh window | `CLAIM_REPLAY_LOOKBACK_DAYS` 14 → **3**. |
| Coverage honesty | Panel caption **and** a distinct `claimsPending` gap bucket. |
| Observability | Structured log on rebind; no schema change, no migration. |
| Sync → matching | No change (see Out of scope). |

## 0. Correction after recon (2026-08-28)

The rebind rule below is necessary but **not sufficient**, discovered while planning:

`verifyCurrentClaimAnchor` itself calls `verifyPublishedMatchFreshness` first (`match-freshness.ts:213-220`), so every claims gate runs the full publication predicate — which re-derives the Shopify projection and compares checksums, and therefore fails the moment any in-window order is mutated. Production's hourly ingest guarantees that: 1,308 orders were measured as touched since the latest evidence run, so **the current publication is already not-fresh**, and a rebind would find nothing fresher to rebind onto.

**Root cause restated:** the claims flow enforces the wrong invariant. Publication freshness answers *"is it safe to publish new matching?"* — necessarily strict, because publishing writes authoritative attribution. Claims answer *"for this conversion event that a published run confirmed, what does Klaviyo say attributed it?"* — an immutable fact about a **Klaviyo event**. Whether Shopify orders mutated afterwards is irrelevant to it, and nothing downstream is endangered: the panel joins claims to *current* order results at read time, so a drifted Shopify projection cannot corrupt a claim.

**Therefore the claims flow gates on a narrower predicate:** the bound match run is `published`, and this conversion's `klaviyo_event_match_result` in that run is unsuperseded (the check already at `match-freshness.ts:222-240`). The projection/checksum/fingerprint gate is dropped **for claims only** — `verifyPublishedMatchFreshness` keeps its current strictness for publication, which is its real job. Rebinding (below) is retained for the case it genuinely serves: a new publication supersedes the old run's results.

## 1. The rebind rule

When the replay's freshness check fails — bound run superseded, its results no longer current, or input checksums drifted — do not finish `stale`. Instead resolve the connection's current published match run and re-run the same freshness check against it:

- **Fresh current publication exists** → rebind: update the graph row's and checkpoint's `matchRunId`/`sourceRunId`, log the rebind, and continue processing from the same cursor.
- **No fresh publication** → finish `stale`, exactly as today.

The same rule applies at the per-conversion anchor check (`verifyCurrentClaimAnchor` returning `publication_stale`): rebind first, then re-validate that conversion against the new publication. If it is no longer confirmed there, the existing skip-and-advance path handles it — no new behavior.

Safe because claims are keyed by `conversion_event_id`: everything already fetched stays valid, and every conversion is individually re-validated against whatever publication is current when it is processed.

**Also rebind at the start path.** `startOrResumeClaimReplay` currently returns `conflict` when a running graph's binding differs from the requested one — a spurious supervisor-stage failure, since the background chain is healthy and would rebind itself on its next batch. Apply the same rule: if the requested binding is the current fresh publication, rebind the running graph and return `pending`. `conflict` retains its real meaning — incompatible bindings with no current publication to reconcile them.

## 2. Cursor semantics

The cursor (`afterOccurredAt`/`afterEventRowId`) is a position in the anchor enumeration ordered by `occurred_at`. Under a new publication the anchor set can differ at the margins. Continuing from the cursor is correct, with one documented consequence: if the new publication newly confirms an event *older* than the cursor, this graph will not revisit it — but the in-scope rule treats "no complete claim state" as always in scope regardless of age, so the next graph picks it up. Nothing is permanently lost.

Resetting the cursor on rebind is explicitly rejected: it would re-walk from the beginning on every publication and, at production cadence, never finish — the current bug in a different costume.

## 3. Refresh window: 14 → 3 days

`CLAIM_REPLAY_LOOKBACK_DAYS = 3`. The window exists so a late-resolving attribution link is picked up; 3 days is generous for that and ~5× cheaper than 14, turning steady state into ~175 new conversions/day (~15 minutes). Recorded follow-up: if re-fetches are observed never to change a stored `source_checksum`, refresh can be dropped entirely so only never-covered conversions are fetched.

## 4. Coverage honesty

- `loadEmailAttribution` gains one aggregate: of the confirmed orders in range, how many have a conversion event with a **complete** claim state. Returned as `claimCoverage: { covered, total }`. This is the exact shape the existing partial index `(connection_id, conversion_event_id) WHERE status = 'complete'` serves.
- Panel: the "Tied to email" label carries `· 124/1,184 checked` in amber while partial; nothing when complete.
- **New partition bucket.** Today a confirmed order whose claims have not been fetched is reported in the gap strip as *"had a Klaviyo event but no campaign/flow link"* — it reads as a finding about the email program when it is really "not asked yet" (this misled the owner: it showed $14,749). Split it: confirmed + has conversion event + no complete claim state becomes `claimsPending`, rendered as "N orders not checked for email links yet". `noEmailLink` then means what it says, and the partition stays exact.

## 5. Observability

A rebind emits one structured server log (`connectionId`, old → new `matchRunId`, triggering freshness reason). No schema change: the graph row already carries bindings and progress counters, and the checkpoint keeps its exact 12-key shape. A durable rebind counter is an easy follow-up if it proves useful.

## 6. Out of scope

- **Throughput constants unchanged.** Once continuity is fixed the backlog clears in ~2 hours; the batch-size and remote-call knobs remain a lever if measurement disappoints.
- **Sync does not auto-trigger matching.** Matching needs fresh evidence; a bare sync does not refresh it, so auto-chaining would mostly manufacture `shopify_content_mutated` failures. The full pass (nightly or "Run full pass") already chains evidence → sync → match → claims in the correct order.
- **Event sync windows unchanged.** The trailing 7-day re-read dedupes on `external_event_id` (read, not rewritten) and completes in 10–20 minutes; it is not falling behind.
- No schema change, no migration, Lab tab untouched, and the standing-backlog rewrite (brainstormed Approach B) is not attempted.

## 7. Testing

Integration (disposable-Postgres harness):

- Graph bound to run A with run B published and superseding it must **rebind and continue**: graph `matchRunId` becomes B, status stays `running`, cursor advances, conversions process — not `stale`.
- With **no** fresh publication it must still finish `stale` (regression pin).
- A per-conversion anchor staleness must rebind, then continue or skip correctly.
- Claims already fetched must survive a rebind untouched — asserted by the fake client never being called for already-complete conversions.
- `startOrResumeClaimReplay` with a differing binding must rebind and return `pending`; with no current publication it must still return `conflict`.
- Lookback: a conversion 5 days old with a complete state is now skipped (would have been re-fetched at 14 days); one 2 days old is still refreshed.

Loader integration: the `claimsPending` bucket and `claimCoverage` counts, with the partition invariant still summing exactly to the range total.

Component: caption present when partial and absent when complete; the new gap entry renders.

**Review-sensitive:** existing tests that pin "stales on supersession" change meaning. Each such change must be called out individually in the implementation report, never quietly edited.
