# Klaviyo Claims Skip-Unchanged Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `klaviyo-claims` from re-fetching conversions whose claims are already complete under their current event checksum. Carry `claim_count` onto each new match run from claims already stored.

**Architecture:** Two changes in `src/lib/klaviyo/claim-repository.ts`.
- A new idempotent, set-based `syncCanonicalClaimCounts` runs once per binding inside `processClaimBatch`'s existing locked selection transaction, gated by writer readiness.
- `selectNextConversion`'s "missing" phase drops the 3-day lookback refresh and selects only conversions with no `complete` replay state under the event's current `source_checksum`.

No schema change, no migration, and the checkpoint shape is unchanged.

**Tech Stack:** TypeScript, Drizzle ORM (node-postgres), PostgreSQL, Vitest, Bun.

**Spec:** `docs/superpowers/specs/2026-09-24-klaviyo-claims-skip-unchanged-design.md`

## Global Constraints

- No schema change and no migration.
- `ClaimReplayCheckpoint` keeps its exact shape. `lookbackCutoff` is still written and validated, but no longer read.
- Lock order stays store → connection → graph. New writes happen only inside the existing `withKlaviyoStoreConnectionLock` selection transaction.
- Claim-side writes require the writer-readiness gate (`verifyGate`). If the gate is closed, the claim-count step is skipped; it never fails the batch.
- "Canonical" order result means the same conditions `verifyCurrentClaimAnchor` applies (`src/lib/klaviyo/match-freshness.ts`): order result confirmed, unsuperseded, non-null `selected_candidate_id`; the same run's event result for `selected_event_id` confirmed, unsuperseded, with the same `selected_candidate_id`.
- Tests run with `bun run test` (Vitest), never `bun test`.
- Integration tests need local Postgres: `docker start creatives-tracker-db-1`. `DATABASE_URL` in `.env` points at `localhost:5432`. Without it the suites are skipped or fail with `ECONNREFUSED`.
- Commit messages are a single conventional-commit title line: no body, no trailers.
- Branch: `feat/klaviyo-claims-skip-unchanged` (cut from `main`; the spec is already committed there).

## File Map

- `src/lib/klaviyo/claim-repository.ts`: add `syncCanonicalClaimCounts` (exported, so it can be tested directly); wire it into `processClaimBatch`; change the `selectNextConversion` missing-phase predicate.
- `src/lib/klaviyo/claims.ts`: update the comments on `CLAIM_REPLAY_LOOKBACK_DAYS` and `ClaimReplayCheckpoint.lookbackCutoff`. No code change.
- `src/lib/klaviyo/claim-repository.integration.test.ts`: make the shared helper checksum-aware; add the claim-count tests; update the selection tests.

---

### Task 1: Carry `claim_count` onto the bound run

**Files:**
- Modify: `src/lib/klaviyo/claim-repository.ts`. Add `syncCanonicalClaimCounts` just above `export type ClaimClient` (near line 603), and wire it into `processClaimBatch` (selection transaction, near lines 726–760).
- Test: `src/lib/klaviyo/claim-repository.integration.test.ts`

**Interfaces:**
- Consumes: `KlaviyoStoreTransaction`, `KlaviyoConnectionScope` (already imported in `claim-repository.ts`); `withKlaviyoStoreConnectionLock` from `@/lib/klaviyo/source-store` (used by tests).
- Produces: `export async function syncCanonicalClaimCounts(tx: KlaviyoStoreTransaction, scope: KlaviyoConnectionScope, matchRunId: string): Promise<number>`. It returns the number of order results whose `claim_count` changed.

- [ ] **Step 1: Make the coverage helper checksum-aware and shared**

In `claim-repository.integration.test.ts`, delete the `insertCoverageState` function from inside `describe("age-bounded replay scope", ...)` (near lines 1058–1080). Add this version, plus a claim helper, directly after the `beforeEach(...)` block of `describeIfDb("Klaviyo claim repository on PostgreSQL", ...)` (just before the first `it(`, near line 389), so both nested and top-level tests can use them:

```ts
  // A prior replay's state under an earlier run scope: visible to the
  // connection-wide coverage check, invisible to the current-run join.
  // Defaults to the event's current checksum, i.e. "covered as it is now".
  async function insertCoverageState(input: {
    conversionEventId: string;
    status: "complete" | "incomplete";
    matchRunId: string;
    sourceChecksum?: string;
  }): Promise<void> {
    const inserted = await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id,
          source_run_id, match_run_id, conversion_event_id, source_checksum,
          status, reason_codes, attempt_count, attempted_at, completed_at)
       SELECT $1, 'org-a', 'store-a', 'connection-a', 'probe-run-a', $2,
              e.id, coalesce($4::text, e.source_checksum), $5, '[]', 1,
              now(), $6::timestamp
         FROM klaviyo_event e
        WHERE e.id = $3`,
      [
        `state-${input.conversionEventId}`,
        input.matchRunId,
        input.conversionEventId,
        input.sourceChecksum ?? null,
        input.status,
        input.status === "complete" ? new Date() : null,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new Error(`no event ${input.conversionEventId} to cover`);
    }
  }

  async function insertStoredClaim(conversionEventId: string): Promise<void> {
    await testPool!.query(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, unknown_reason_codes,
          source_checksum, api_revision)
       VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, 'attribution-1',
         '[]', 'claim-checksum', '2026-07-15')`,
      [`claim-${conversionEventId}`, conversionEventId],
    );
  }

  async function claimCountOn(runId: string): Promise<number[]> {
    const result = await testPool!.query(
      `SELECT claim_count FROM klaviyo_order_match_result
        WHERE run_id = $1 AND status = 'confirmed'
        ORDER BY id`,
      [runId],
    );
    return result.rows.map((row) => row.claim_count as number);
  }
```

Also add, next to `const evidenceStore = await import(...)` (near line 50):

```ts
const sourceStore = await import("@/lib/klaviyo/source-store");
```

- [ ] **Step 2: Run the existing suite to confirm the helper move is behaviour-neutral**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: `Tests  27 passed (27)`. Today's code treats any complete state as coverage for an old conversion, so switching the default checksum changes no outcome yet.

- [ ] **Step 3: Write the failing claim-count tests**

Add this block inside `describeIfDb(...)`, after the closing `});` of `describe("age-bounded replay scope", ...)` and before the outer suite's closing `});`:

```ts
  describe("claim-count carry-forward", () => {
    const gateClosed = async () => ({ ready: false });

    function dependenciesFor(
      client: ReturnType<typeof fakeClaimClient>,
      verifyWriterReadiness = gateOpen,
    ) {
      return {
        createClient: () => client,
        credentialProvider: fakeCredentialProvider,
        verifyWriterReadiness,
      };
    }

    function syncOn(runId: string): Promise<number> {
      return sourceStore.withKlaviyoStoreConnectionLock(scope, (tx) =>
        repository.syncCanonicalClaimCounts(tx, scope, runId),
      );
    }

    it("sets claim_count for a covered conversion the graph does not re-fetch", async () => {
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-a",
        status: "complete",
        matchRunId,
      });
      await insertStoredClaim("event-a");
      expect(await claimCountOn(matchRunId)).toEqual([0]);

      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );

      expect(result).toMatchObject({ outcome: "done", processed: 0 });
      expect(client.getEventById).not.toHaveBeenCalled();
      expect(await claimCountOn(matchRunId)).toEqual([1]);
    });

    it("carries claim_count onto the run a graph rebinds to", async () => {
      const { matchRunId: firstRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-a",
        status: "complete",
        matchRunId: firstRunId,
      });
      await insertStoredClaim("event-a");
      const claimReplayId = await startGraph(firstRunId);
      const second = await publishSecondMatchWorld();

      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );

      expect(result.outcome).toBe("done");
      expect(client.getEventById).not.toHaveBeenCalled();
      expect(await claimCountOn(second.runId)).toEqual([1]);
      const graph = await graphRow(claimReplayId);
      expect((graph.checkpoint as ClaimReplayCheckpoint).matchRunId).toBe(
        second.runId,
      );
    });

    it("writes only current canonical results and is idempotent", async () => {
      const { matchRunId: firstRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-a",
        status: "complete",
        matchRunId: firstRunId,
      });
      await insertStoredClaim("event-a");
      const second = await publishSecondMatchWorld();

      // The first run's results are superseded: nothing to write there.
      expect(await syncOn(firstRunId)).toBe(0);
      expect(await syncOn(second.runId)).toBe(1);
      expect(await claimCountOn(second.runId)).toEqual([1]);
      // Second pass changes nothing.
      expect(await syncOn(second.runId)).toBe(0);
    });

    it("does not propagate claims whose complete state is under a stale checksum", async () => {
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-a",
        status: "complete",
        matchRunId,
        sourceChecksum: "stale-checksum",
      });
      await insertStoredClaim("event-a");

      expect(await syncOn(matchRunId)).toBe(0);
      expect(await claimCountOn(matchRunId)).toEqual([0]);
    });

    it("skips the sync without failing the batch when the gate is closed", async () => {
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-a",
        status: "complete",
        matchRunId,
      });
      await insertStoredClaim("event-a");
      const claimReplayId = await startGraph(matchRunId);

      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(fakeClaimClient(), gateClosed),
      );

      expect(result.outcome).toBe("done");
      expect(await claimCountOn(matchRunId)).toEqual([0]);
    });
  });
```

Coverage note: the spec also names non-confirmed results and a candidate mismatch as negative cases. The seeded world has no such rows, and building them by hand runs into `klaviyo_order_match_result`'s shape check constraints. Those conditions are therefore covered by the predicate copying `verifyCurrentClaimAnchor` word for word (Global Constraints), not by a dedicated test. Say so in the PR description.

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts -t "claim-count carry-forward"`
Expected: FAIL. The two `processClaimBatch` tests fail on `expect(await claimCountOn(...)).toEqual([1])` (received `[0]`). The three direct tests fail with `repository.syncCanonicalClaimCounts is not a function`. The gate-closed test may already pass; that's fine, since it guards the behaviour after Step 5.

- [ ] **Step 5: Implement `syncCanonicalClaimCounts`**

In `src/lib/klaviyo/claim-repository.ts`, add directly above `export type ClaimClient = Pick<KlaviyoApiClient, "getEventById">;`:

```ts
/**
 * Carries claim counts onto a match run's canonical order results from
 * claims already stored. Claims are per-conversion facts that outlive any
 * one publication, but `claim_count` lives on the run's order results, which
 * every new publication creates at 0 — and the selection only re-fetches a
 * conversion that has no complete state under its current checksum, so the
 * per-conversion commit alone would leave covered conversions at 0.
 *
 * "Canonical" is exactly verifyCurrentClaimAnchor's rule: a confirmed,
 * unsuperseded order result whose same-run event result is confirmed,
 * unsuperseded, and selects the identical candidate. Claims under a stale
 * event checksum are never propagated; the re-fetch owns those. Set-based
 * and idempotent: writes only counts that differ. Caller holds the
 * store→connection lock and has passed the writer-readiness gate.
 */
export async function syncCanonicalClaimCounts(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  matchRunId: string,
): Promise<number> {
  const updated = await tx.execute<{ id: string }>(sql`
    update klaviyo_order_match_result omr
       set claim_count = counted.claims
      from klaviyo_event_match_result emr
      join klaviyo_event e
        on e.connection_id = emr.connection_id
       and e.id = emr.event_id
      join lateral (
        select count(*)::int as claims
          from klaviyo_attribution_claim c
         where c.connection_id = emr.connection_id
           and c.conversion_event_id = emr.event_id
      ) counted on true
     where omr.run_id = ${matchRunId}
       and omr.connection_id = ${scope.connectionId}
       and omr.superseded_at is null
       and omr.status = 'confirmed'
       and omr.selected_candidate_id is not null
       and emr.run_id = omr.run_id
       and emr.connection_id = omr.connection_id
       and emr.event_id = omr.selected_event_id
       and emr.superseded_at is null
       and emr.status = 'confirmed'
       and emr.selected_candidate_id = omr.selected_candidate_id
       and exists (
         select 1
           from klaviyo_claim_replay_state covered
          where covered.connection_id = emr.connection_id
            and covered.conversion_event_id = emr.event_id
            and covered.status = 'complete'
            and covered.source_checksum = e.source_checksum
       )
       and omr.claim_count <> counted.claims
    returning omr.id
  `);
  return updated.rows.length;
}
```

- [ ] **Step 6: Wire it into `processClaimBatch`**

In `processClaimBatch`, directly after `let checkpoint: ClaimReplayCheckpoint | null = null;` (near line 701), add:

```ts
  // The binding whose claim counts this batch has already carried forward.
  let claimCountsSyncedFor: string | null = null;
```

Inside the selection transaction, directly after the `boundRunYieldsAnchors` / rebind block closes (after `current = rebound;` and its closing `}`), and before `if (current.stage === "handoff") {`, add:

```ts
        // Once per binding: carry claim counts onto the bound run from
        // stored claims, so conversions the selection no longer re-fetches
        // still show them (see syncCanonicalClaimCounts). A closed gate
        // skips it; a later selection retries.
        if (claimCountsSyncedFor !== current.matchRunId) {
          const countGate = await verifyGate(input.scope);
          if (countGate.ready) {
            await syncCanonicalClaimCounts(tx, input.scope, current.matchRunId);
            claimCountsSyncedFor = current.matchRunId;
          }
        }
```

- [ ] **Step 7: Run the claim-count tests to verify they pass**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts -t "claim-count carry-forward"`
Expected: PASS, 5 tests.

- [ ] **Step 8: Run the whole claim suite**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: `Tests  32 passed (32)`.

- [ ] **Step 9: Typecheck, lint, commit**

Run: `bun run typecheck && bunx eslint src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: no errors.

```bash
git add src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claim-repository.integration.test.ts
git commit -m "fix(klaviyo): carry claim counts onto each bound match run"
```

---

### Task 2: Select only conversions not covered under their current checksum

**Files:**
- Modify: `src/lib/klaviyo/claim-repository.ts`, `selectNextConversion` missing phase (near lines 475–488).
- Modify: `src/lib/klaviyo/claims.ts`, comments on `lookbackCutoff` (line 295) and `CLAIM_REPLAY_LOOKBACK_DAYS` (lines 307–316).
- Test: `src/lib/klaviyo/claim-repository.integration.test.ts`

**Interfaces:**
- Consumes: `insertCoverageState({ conversionEventId, status, matchRunId, sourceChecksum? })` from Task 1; the existing helpers `seedExtraConversionEvent`, `seedOldConversionWorld`, `publishMatchWorld`, `startGraph`, `fakeClaimClient`, `DAY_MS`.
- Produces: no new symbols.

- [ ] **Step 1: Write the failing selection tests**

In `describe("age-bounded replay scope", ...)`, rename the describe to `"checksum-covered replay scope"`.

Replace the whole test `it("re-replays a recent conversion that already has a complete state", ...)` with:

```ts
    it("skips a recent conversion already complete under its current checksum", async () => {
      await seedExtraConversionEvent(
        "event-recent",
        "external-event-recent",
        new Date(Date.now() - 2 * DAY_MS),
      );
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-recent",
        status: "complete",
        matchRunId,
      });
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result.outcome).toBe("done");
      expect(result.processed).toBe(1);
      expect(fetchedExternalIds(client)).not.toContain("external-event-recent");
      const recentClaims = await testPool!.query(
        `SELECT count(*)::int AS count FROM klaviyo_attribution_claim
          WHERE conversion_event_id = 'event-recent'`,
      );
      expect(recentClaims.rows[0].count).toBe(0);
    });

    it("fetches a conversion whose only complete state is under a stale checksum", async () => {
      await seedOldConversionWorld();
      const { matchRunId } = await publishMatchWorld();
      await insertCoverageState({
        conversionEventId: "event-old",
        status: "complete",
        matchRunId,
        sourceChecksum: "stale-checksum",
      });
      const claimReplayId = await startGraph(matchRunId);
      const client = fakeClaimClient();
      const result = await repository.processClaimBatch(
        { scope, claimReplayId },
        dependenciesFor(client),
      );
      expect(result.outcome).toBe("done");
      expect(result.processed).toBe(2);
      expect(fetchedExternalIds(client)).toContain("external-event-old");
    });
```

Rename `it("skips a covered conversion older than the three-day refresh window", ...)` to `it("skips a covered five-day-old conversion", ...)`, and replace its first comment line with `// Covered under its current checksum: skipped at any age.` The body stays the same.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts -t "checksum-covered replay scope"`
Expected: FAIL.
- "skips a recent conversion…" fails with `expected [ 'external-event-a', …, 'external-event-recent', … ] not to include 'external-event-recent'`: the lookback still refreshes it.
- "fetches a conversion whose only complete state is under a stale checksum" fails on `toContain("external-event-old")`: today any complete state covers an old conversion.

- [ ] **Step 3: Change the missing-phase predicate**

In `selectNextConversion`, replace the comment and `inScopePredicate` (the block starting `// An anchor is in scope when its conversion is recent` through the closing `))\`;`) with:

```ts
    // An anchor is in scope only while this connection has no complete
    // replay state for it under its CURRENT event checksum — never covered,
    // or its source changed since. A covered, unchanged conversion is not
    // re-fetched at any age: prod showed re-fetches never changed a checksum
    // or a claim count, and syncCanonicalClaimCounts carries claim counts
    // onto new runs without a fetch. Incomplete and failed states are the
    // retry phases' job and are untouched here.
    const inScopePredicate = sql`not exists (
        select 1
          from klaviyo_claim_replay_state covered
         where covered.connection_id = ${scope.connectionId}
           and covered.conversion_event_id = ${klaviyoEventMatchResults.eventId}
           and covered.status = 'complete'
           and covered.source_checksum = ${klaviyoEvents.sourceChecksum}
      )`;
```

Leave the rest of the query unchanged: the joins, the `cursorPredicate`, and the `(state.id is null or state.source_checksum <> event.source_checksum)` condition.

- [ ] **Step 4: Update the comments in `claims.ts`**

Replace the `lookbackCutoff: string;` line in `ClaimReplayCheckpoint` with:

```ts
  /** Written and validated but no longer read; see CLAIM_REPLAY_LOOKBACK_DAYS. */
  lookbackCutoff: string;
```

Replace the comment above `export const CLAIM_REPLAY_LOOKBACK_DAYS = 3;` (lines 307–315, from `// Klaviyo attribution for a conversion is fixed` through `// refresh can be dropped entirely.`) with:

```ts
// Selection no longer refreshes recent conversions: a conversion is fetched
// only while it has no complete replay state under its current event
// checksum (selectNextConversion). Measured in prod before the change
// (14 days): 60-70% of daily attempts re-fetched complete, unchanged
// conversions, and none changed a checksum or a claim count. This constant
// now only computes the checkpoint's lookbackCutoff, kept so in-flight
// checkpoints stay valid across deploy; remove both together later.
```

- [ ] **Step 5: Update the idempotency test's comments**

In `it("is idempotent across a full replay of an already-complete graph", ...)`, replace the first comment (`// A conversion inside the lookback window: its second-graph skip must` / `// travel the checksum-equality path, not the age bound.`) with:

```ts
    // A recent conversion: its second-graph skip must travel the
    // checksum-coverage path, the only one there is now.
```

Replace the comment before `const secondStart` (`// A second graph replays the same conversions: the old conversion is` … `// phase missing, and both bounded retry phases stay empty.`) with:

```ts
    // A second graph replays the same conversions: both are complete under
    // their current checksums, so phase missing selects neither and both
    // bounded retry phases stay empty.
```

- [ ] **Step 6: Run the selection tests to verify they pass**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts -t "checksum-covered replay scope"`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run the whole claim suite and the claim unit tests**

Run: `bun run test -- src/lib/klaviyo/claim-repository.integration.test.ts src/lib/klaviyo/claims.test.ts`
Expected: all pass. The integration suite has 33 tests (32 from Task 1, plus the one new stale-checksum test; the rewritten recent test replaces one).

- [ ] **Step 8: Typecheck, lint, commit**

Run: `bun run typecheck && bunx eslint src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claims.ts src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: no errors.

```bash
git add src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claims.ts src/lib/klaviyo/claim-repository.integration.test.ts
git commit -m "perf(klaviyo): stop re-fetching claim conversions complete under their checksum"
```

---

### Task 3: Full verification

**Files:** none modified, unless a failure below points at this change.

**Interfaces:** consumes the results of Tasks 1–2.

- [ ] **Step 1: Run every Klaviyo suite against local Postgres**

Run: `bun run test -- src/lib/klaviyo`
Expected: no failures. In particular, `claims-reporting-isolation.integration.test.ts` and `email-attribution.integration.test.ts` read claims and replay state and must stay green.

If a test there encodes the old lookback refresh (for example, it expects a recent, complete conversion to be fetched again), update that expectation to the new rule, the same way as Task 2 Step 1, and name the file in the commit title. Don't change production code to satisfy it.

- [ ] **Step 2: Run the full unit suite, typecheck, lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: tests pass; typecheck clean; lint reports no new warnings in the touched files.

- [ ] **Step 3: Confirm the branch contents**

Run: `git log --oneline origin/main..HEAD && git diff origin/main --stat`
Expected: four commits (spec, plan, Task 1, Task 2), plus any Task 3 fix-up, touching only the spec, the plan, `claim-repository.ts`, `claims.ts`, and test files.

- [ ] **Step 4: Commit any Task 3 fix-ups**

Only if Step 1 required a test update:

```bash
git add <the updated test file>
git commit -m "test(klaviyo): align <suite name> with checksum-covered claim selection"
```

## Post-merge verification (for the PR description)

After the first daily pass on prod:
- `klaviyo-claims` runs a day drop from ~80–100 to ~30–40 (Trigger API, `filter[taskIdentifier]=klaviyo-claims`).
- `bun rands/measure.mjs` (recreate it from the spec's measurement if it's missing): the new day's `refetch_same_checksum` is ~0, and `states` ≈ `first_time`.
- The email-attribution `claims_pending` bucket does not grow.
