# Klaviyo claims: stop re-fetching unchanged conversions

## Problem

`klaviyo-claims` is the most expensive Trigger task. Each pass re-fetches from Klaviyo every conversion in the last 3 days (`CLAIM_REPLAY_LOOKBACK_DAYS`), including ones that are already complete. One conversion costs ~10s of billed time: ~50–70 sequential DB round-trips, each ~200ms, because Trigger runs in us-east-1 and the DB is in ap-southeast-1.

The lookback exists for late-resolving attribution. `claims.ts` records the follow-up: *"if re-fetches are observed never to change a stored source_checksum, refresh can be dropped entirely."*

## Evidence (prod, read-only, 2026-09-23/24)

- **Re-fetches change nothing.** Over 14 days, 60–70% of daily claim attempts were re-fetches of a conversion already `complete` under the same event `source_checksum`. None changed the checksum and none changed the resolved claim count. The event checksum covers `attributionRelationshipIds`, so late attribution would have shown up here.
- **Re-fetches never repair links.** Across all 1,008 claims linked to a campaign or flow, the linked `klaviyo_marketing_object` already existed at the conversion's first claim attempt. None was repaired by a later re-fetch. Only 2 claims ever have neither link, both genuinely unlinked (`referenced_metric_not_allowlisted`).
- **Most conversions have no claims.** 82% of complete conversions have 0 claims (4,690 of 5,700).
- **Volume:** ~120–190 new conversions a day, against ~400–480 attempts a day.

## Goal

Fetch a conversion from Klaviyo only when there is something new to learn: it has never completed under its current event checksum, or it needs a retry. Expected result: ~150 fetches a day instead of ~450, about −65% of `klaviyo-claims` cost.

## Non-goals

- Reducing round-trips within one conversion's fetch.
- The Shopify evidence task (a separate spec).
- Removing `lookbackCutoff` from the checkpoint (a later cleanup).

## Design

### 1. Selection: "missing" means "not yet covered under this checksum"

In `selectNextConversion`, phase `missing`, today's in-scope predicate is:

```
occurred_at >= lookbackCutoff
OR NOT EXISTS (complete state for this conversion on this connection, any run, any checksum)
```

It becomes:

```
NOT EXISTS (
  select 1 from klaviyo_claim_replay_state covered
   where covered.connection_id = <connection>
     and covered.conversion_event_id = <event>
     and covered.status = 'complete'
     and covered.source_checksum = klaviyo_event.source_checksum
)
```

Everything else in the query stays as it is: current bound run, unsuperseded event result, cursor, and the existing left join that excludes conversions already holding a same-checksum state for this run.

Behaviour this produces:

| Conversion | Today | After |
|---|---|---|
| New, never attempted | fetched | fetched |
| Complete, checksum unchanged, within 3 days | re-fetched on every pass | **skipped** |
| Complete, checksum unchanged, older | skipped | skipped |
| Complete under an old checksum, checksum since changed, older than 3 days | skipped (any complete state counted) | **fetched** (a correction) |
| Incomplete or failed for this run | retry phases | retry phases (unchanged) |

### 2. Claim counts on the bound run

`klaviyo_order_match_results.claim_count` belongs to a match run. It appears in the orders table and the source inspector. Each daily match run creates fresh order results with `claim_count = 0`. Today only a re-fetch's commit writes it. Once re-fetches stop, a new step must carry the count forward from claims already stored.

**Where:** in `processClaimBatch`'s selection transaction, under the same store → connection → graph locks, after the bound-run check (`boundRunYieldsAnchors`, or the rebind) has succeeded. It runs once per batch, and again after any rebind within the batch. It requires the writer-readiness gate, like every other claim-side write. If the gate is closed, the step is skipped and the next batch tries again.

**What:** one set-based statement that sets `claim_count` on the bound run's **canonical** order results. "Canonical" uses the same rules `verifyCurrentClaimAnchor` applies per conversion:

- order result: `run_id = bound run`, same connection, `superseded_at is null`, `status = 'confirmed'`, `selected_candidate_id is not null`;
- the event result for `selected_event_id` in the same run: unsuperseded, `status = 'confirmed'`, and the same `selected_candidate_id`;
- the conversion has a `complete` replay state under its current event `source_checksum`, so claims under a stale checksum are never propagated;
- the new value is `count(*)` of `klaviyo_attribution_claim` rows for that conversion on the connection. The statement only writes where `claim_count` differs.

The statement is idempotent. It touches no claim, replay-state, match-status or Shopify data.

### 3. No replay-state copies

Reporting reads coverage per conversion, regardless of run (`CLAIMS_COVERED` in `email-attribution.ts`, and the per-conversion history in `queries.ts`). A skipped conversion's existing complete state still counts, so no rows are copied onto the new run.

### 4. Checkpoint compatibility

`ClaimReplayCheckpoint.lookbackCutoff` is checked by `assertExactClaimReplayCheckpoint`, and graphs may be in flight during deploy. The field keeps being written and validated but is no longer read. `CLAIM_REPLAY_LOOKBACK_DAYS` remains only to compute it, and its comment is updated to record the evidence and point at the cleanup.

## Files

- `src/lib/klaviyo/claim-repository.ts`: `selectNextConversion` predicate; the new claim-count step inside `processClaimBatch`'s selection transaction.
- `src/lib/klaviyo/claims.ts`: the constant's comment.
- `src/lib/klaviyo/claim-repository.integration.test.ts`: new and updated tests.

No schema change and no migration.

## Testing

Postgres integration tests, in `claim-repository.integration.test.ts`:

1. A conversion `complete` under the current checksum from an **earlier run**, occurring within the old 3-day window, is not selected, and no Klaviyo call is made.
2. The same conversion after its event checksum changes is selected and fetched.
3. A conversion with an `incomplete` or `failed` state for the bound run is still retried by the retry phases.
4. After a batch, the bound run's canonical order result has `claim_count` equal to the stored claims, including for a conversion that was skipped.
5. `claim_count` is not written to a superseded order result, a non-confirmed one, one whose event result selects a different candidate, or a conversion whose complete state is under a stale checksum.
6. Running the step twice changes nothing.
7. A graph rebound to a newer run gets that run's counts.
8. A closed writer-readiness gate skips the step without failing the batch.

Existing tests that encode the lookback are updated to the new rule:

- "is idempotent across a full replay of an already-complete graph" expects the recent conversion to be skipped via the checksum, not the age bound;
- "persists the lookback cutoff in the checkpoint across batch resume" still passes, because the field is still written.

## Rollout and verification

Deploys through `main` (CI's `trigger-deploy`), no migration. After the first daily pass:

- `klaviyo-claims` runs a day drop from ~80–100 to ~30–40 (Trigger API);
- replay-state rows a day approximately equal the `first_time` count (re-run `rands/measure.mjs`);
- the email attribution `claims_pending` bucket does not grow;
- `claim_count > 0` on the current run's order results matches the number of conversions with stored claims.

## Risks

- **Klaviyo changes an attribution without changing the event.** The 14-day measurement found none. If it ever happens, it shows up as a changed checksum when the source sync re-reads the event, and the conversion is fetched again.
- **Claim counts briefly show 0 on a new run** between match publication and the first claims batch. Today that is already the case, and it is worse. Conversions older than the 3-day window are never re-fetched, so on every new run their `claim_count` stays 0 permanently. The claim-count step fixes this existing bug: every canonical order result on the bound run gets its count on the first batch.
