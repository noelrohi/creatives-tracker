# Klaviyo Claims Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the claims replay run to completion in production so the email revenue panel shows real numbers, and tell the truth about coverage while it catches up.

**Architecture:** Claims stop enforcing publication-level freshness (a predicate built for *publishing*, broken continuously by hourly Shopify ingest) and enforce only what claims need — the run is published and this conversion's event result is unsuperseded. When a newer publication supersedes the bound run's results, the graph rebinds to the current publication and continues from its cursor instead of dying. The refresh window shrinks 14 → 3 days, and the loader/panel gain an explicit "not checked yet" bucket and coverage caption.

**Tech Stack:** TypeScript, Drizzle (node-postgres), Vitest 4 (+ jsdom), Trigger.dev v4.

**Spec:** `docs/superpowers/specs/2026-08-28-klaviyo-claims-continuity-design.md` (read §0 first — it corrects §1).

---

## Before you start

- Branch `feat/klaviyo-claims-continuity` off `origin/main` is checked out with the spec committed. Never stage `.gitignore` (it carries a local edit).
- Commands: `npm run test -- --run <file>` (never `bun test`), `npm run test:components`, `npx tsc --noEmit`, `npx eslint <files>`. Postgres runs in docker (`creatives-tracker-db-1`); integration tests manage disposable databases.
- Commits: conventional title ONLY — no body, no trailers.
- **Review-sensitive:** several existing tests pin the behavior this plan changes. Every such change must be called out individually in your report, never quietly edited. They are named in the tasks below.

## File structure

- Modify `src/lib/klaviyo/match-freshness.ts` — narrow `verifyCurrentClaimAnchor`; add `resolveCurrentPublishedMatchRun` and `verifyClaimPublication`.
- Modify `src/lib/klaviyo/claim-repository.ts` — `rebindGraphLocked` helper; wire into the four gates and into `startOrResumeClaimReplay`.
- Modify `src/lib/klaviyo/claims.ts` — `CLAIM_REPLAY_LOOKBACK_DAYS` 14 → 3.
- Modify `src/lib/klaviyo/email-attribution.ts` — `claims_pending` bucket + `claimCoverage`.
- Modify `src/components/blocks/attribution/klaviyo/{copy.ts,email-revenue-gaps.tsx,email-revenue-panel.tsx}`.
- Tests: `match-freshness.test.ts`, `claim-repository.integration.test.ts`, `email-attribution.integration.test.ts`, `list-health.component.test.tsx` (panel/gaps tests live in `email-revenue-panel.component.test.tsx`).

---

### Task 1: Narrow the claims predicate

**Files:**
- Modify: `src/lib/klaviyo/match-freshness.ts`
- Test: `src/lib/klaviyo/match-freshness.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `match-freshness.test.ts`, mirroring the fixtures its neighbours use:

```ts
it("keeps a claim anchor valid when only the Shopify projection drifted", async () => {
  // Claims are facts about a Klaviyo event; a later Shopify order edit
  // cannot change what Klaviyo attributed a conversion to.
  const { matchRunId } = await publishWorld();
  await testPool!.query(
    `UPDATE shopify_order_line SET quantity = quantity + 1 WHERE order_id = 'order-a'`,
  );
  const publication = await freshness.verifyPublishedMatchFreshness({
    scope,
    matchRunId,
  });
  expect(publication).toEqual({
    fresh: false,
    reason: "source_projection_stale",
  });
  const anchor = await freshness.verifyCurrentClaimAnchor({
    scope,
    matchRunId,
    conversionEventRowId: "event-a",
  });
  expect(anchor.fresh).toBe(true);
});
```

Reuse whatever helper the file already uses to publish a world (read the top of `match-freshness.test.ts`; if it publishes inline, copy that inline setup rather than inventing a helper).

- [ ] **Step 2: Run to verify it fails.**

Run: `npm run test -- --run src/lib/klaviyo/match-freshness.test.ts`
Expected: FAIL — the anchor returns `{fresh: false, reason: "publication_stale"}` because it currently delegates to publication freshness.

- [ ] **Step 3: Implement.** In `match-freshness.ts`, replace the publication gate at the head of `verifyCurrentClaimAnchor` (currently lines 213-220) with a published-only check, and add the two new exports:

```ts
/**
 * Proves only that a match run is published — the claims flow's gate.
 * Deliberately weaker than verifyPublishedMatchFreshness: claims are
 * immutable facts about a Klaviyo event, so a Shopify projection that
 * drifted after publication cannot invalidate them, and the panel
 * re-joins claims to current order results at read time.
 */
export async function verifyClaimPublication(input: {
  scope: KlaviyoConnectionScope;
  matchRunId: string;
  executor?: Executor;
}): Promise<boolean> {
  const executor = input.executor ?? db;
  const [run] = await executor
    .select({ status: klaviyoMatchRuns.status })
    .from(klaviyoMatchRuns)
    .where(
      and(
        eq(klaviyoMatchRuns.id, input.matchRunId),
        eq(klaviyoMatchRuns.organizationId, input.scope.organizationId),
        eq(klaviyoMatchRuns.storeId, input.scope.storeId),
        eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
      ),
    )
    .limit(1);
  return run?.status === "published";
}

/**
 * The connection's newest published, unsuperseded match run — the target a
 * claim graph rebinds onto when its own run is replaced. Returns null when
 * the connection has no such run, leaving the caller nothing to continue
 * against.
 */
export async function resolveCurrentPublishedMatchRun(input: {
  scope: KlaviyoConnectionScope;
  executor?: Executor;
}): Promise<{ id: string; sourceRunId: string } | null> {
  const executor = input.executor ?? db;
  const [run] = await executor
    .select({
      id: klaviyoMatchRuns.id,
      sourceRunId: klaviyoMatchRuns.sourceRunId,
    })
    .from(klaviyoMatchRuns)
    .where(
      and(
        eq(klaviyoMatchRuns.organizationId, input.scope.organizationId),
        eq(klaviyoMatchRuns.storeId, input.scope.storeId),
        eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
        eq(klaviyoMatchRuns.status, "published"),
        isNull(klaviyoMatchRuns.supersededAt),
      ),
    )
    .orderBy(desc(klaviyoMatchRuns.publishedAt))
    .limit(1);
  return run ?? null;
}
```

Then in `verifyCurrentClaimAnchor` replace lines 213-220 with:

```ts
  // Claims need only that the run published and this conversion's event
  // result is still current — never that the Shopify projection still
  // matches, which hourly ingest breaks continuously and which has no
  // bearing on what Klaviyo attributed a conversion to.
  if (
    !(await verifyClaimPublication({
      scope: input.scope,
      matchRunId: input.matchRunId,
      executor,
    }))
  ) {
    return { fresh: false, reason: "publication_stale" };
  }
```

Add `desc` and `isNull` to the drizzle-orm import if absent. `publication_stale` keeps its literal (now meaning "missing or not published"), so `ClaimAnchorResult` is unchanged.

- [ ] **Step 4: Run tests.**

Run: `npm run test -- --run src/lib/klaviyo/match-freshness.test.ts`
Expected: the new test PASSES. **Two existing tests change meaning** — `"goes stale when the source projection mutates"` (~:93) and `"goes stale when approved rules change"` (~:111) assert the anchor returns `publication_stale` after drift; the anchor now stays fresh. Update ONLY their anchor assertions (the `verifyPublishedMatchFreshness` assertions must stay exactly as they are — publication strictness is unchanged), and report both changes explicitly.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/klaviyo/match-freshness.ts src/lib/klaviyo/match-freshness.test.ts
git commit -m "fix(klaviyo): gate claims on publication status, not projection freshness"
```

---

### Task 2: Rebind the graph instead of staling it

**Files:**
- Modify: `src/lib/klaviyo/claim-repository.ts`
- Test: `src/lib/klaviyo/claim-repository.integration.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `claim-repository.integration.test.ts` (reuse `publishMatchWorld`, `startGraph`, `graphRow`, `fakeClaimClient`, `dependenciesFor` from the file):

```ts
it("rebinds a superseded graph to the current publication and keeps going", async () => {
  const first = await publishMatchWorld();
  const claimReplayId = await startGraph(first.matchRunId);
  // A second publication supersedes the first run's results; the graph is
  // pointed at yesterday's run, not invalid.
  const second = await matchService.computeAndPublishMatches({
    scope,
    sourceRunId: "source-run-a",
    shopifyEvidenceRunId: "evidence-run-a",
  });
  expect(second.runId).not.toBe(first.matchRunId);

  const result = await repository.processClaimBatch(
    { scope, claimReplayId },
    dependenciesFor(fakeClaimClient()),
  );

  expect(result.outcome).not.toBe("stale");
  const row = await graphRow(claimReplayId);
  expect(row.status).toBe("running");
  expect(row.checkpoint.matchRunId).toBe(second.runId);
  const bindings = await testPool!.query(
    `SELECT match_run_id FROM klaviyo_claim_replay_run WHERE id = $1`,
    [claimReplayId],
  );
  expect(bindings.rows[0].match_run_id).toBe(second.runId);
});

it("stales only when the connection has no published run to rebind onto", async () => {
  const { matchRunId } = await publishMatchWorld();
  const claimReplayId = await startGraph(matchRunId);
  await testPool!.query(
    `UPDATE klaviyo_match_run SET status = 'failed' WHERE id = $1`,
    [matchRunId],
  );
  const result = await repository.processClaimBatch(
    { scope, claimReplayId },
    dependenciesFor(fakeClaimClient()),
  );
  expect(result.outcome).toBe("stale");
  expect((await graphRow(claimReplayId)).status).toBe("stale");
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test -- --run src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: the rebind test FAILS (`outcome` is `"stale"`, graph status `stale`); the no-target test passes already.

- [ ] **Step 3: Implement.** Add the helper near `finishGraphLocked` in `claim-repository.ts`:

```ts
/**
 * Claims are immutable per-conversion facts keyed by conversion_event_id,
 * never by publication — so a graph whose run was replaced is not invalid,
 * merely pointed at yesterday's run. Rebind it to the current publication
 * and continue from the same cursor. Returns null when there is nothing
 * fresher to rebind onto, and the caller must stale.
 *
 * The cursor is deliberately preserved: an event the new publication
 * confirms behind the cursor is skipped by THIS graph but stays in scope
 * for the next one, because "no complete claim state" is always in scope
 * regardless of age. Resetting instead would re-walk from the start on
 * every publication and never finish.
 */
async function rebindGraphLocked(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  claimReplayId: string,
  current: ClaimReplayCheckpoint,
  reason: string,
): Promise<ClaimReplayCheckpoint | null> {
  const target = await resolveCurrentPublishedMatchRun({ scope, executor: tx });
  if (target === null || target.id === current.matchRunId) return null;
  const rebound: ClaimReplayCheckpoint = {
    ...current,
    sourceRunId: target.sourceRunId,
    matchRunId: target.id,
  };
  await tx
    .update(klaviyoClaimReplayRuns)
    .set({
      sourceRunId: target.sourceRunId,
      matchRunId: target.id,
      checkpoint: rebound as unknown as Record<string, never>,
      heartbeatAt: new Date(),
    })
    .where(eq(klaviyoClaimReplayRuns.id, claimReplayId));
  console.info("klaviyo claim replay rebound", {
    connectionId: scope.connectionId,
    claimReplayId,
    fromMatchRunId: current.matchRunId,
    toMatchRunId: target.id,
    reason,
  });
  return rebound;
}
```

Import `resolveCurrentPublishedMatchRun` and `verifyClaimPublication` from `@/lib/klaviyo/match-freshness`.

Now replace each publication gate. **Selection transaction** (currently lines 581-589) becomes:

```ts
        if (
          !(await verifyClaimPublication({
            scope: input.scope,
            matchRunId: current.matchRunId,
            executor: tx,
          }))
        ) {
          const rebound = await rebindGraphLocked(
            tx,
            input.scope,
            input.claimReplayId,
            current,
            "publication_not_published",
          );
          if (rebound === null) {
            await finishGraphLocked(tx, input.claimReplayId, "stale", null);
            return { kind: "stale" as const };
          }
          current = rebound;
        }
```

**Per-conversion anchor** (currently lines 641-651): before treating a non-fresh anchor as terminal, attempt one rebind and re-check:

```ts
        let anchor = await verifyCurrentClaimAnchor({
          scope: input.scope,
          matchRunId: current.matchRunId,
          conversionEventRowId: conversion.eventRowId,
          executor: tx,
        });
        if (!anchor.fresh) {
          // A replaced publication re-confirms the same events; rebind and
          // re-ask before concluding this conversion is gone.
          const rebound = await rebindGraphLocked(
            tx,
            input.scope,
            input.claimReplayId,
            current,
            anchor.reason,
          );
          if (rebound !== null) {
            current = rebound;
            anchor = await verifyCurrentClaimAnchor({
              scope: input.scope,
              matchRunId: current.matchRunId,
              conversionEventRowId: conversion.eventRowId,
              executor: tx,
            });
          }
        }
        if (!anchor.fresh) {
          if (anchor.reason === "publication_stale") {
            await finishGraphLocked(tx, input.claimReplayId, "stale", null);
            return { kind: "stale" as const };
          }
```

(keep the existing superseded-skip block that follows unchanged).

**Commit transaction** (currently lines 850-855): apply the same shape as the selection gate — `verifyClaimPublication`, rebind, stale only if `rebound === null`. The commit's `current` is `const`; change it to `let` so the rebound checkpoint can replace it, and make sure the subsequent attempt-tuple checks read the rebound value.

Leave `recoverExhaustedClaimBatch`'s gate (≈line 1235) unchanged — that path is already terminal by design (retries exhausted). Note this in your report.

- [ ] **Step 4: Run tests.**

Run: `npm run test -- --run src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: both new tests PASS. The existing `"skips a superseded attempting anchor and goes stale with none left"` (~:531) may now rebind rather than stale — read it, and if its intent (recovery with no anchors left) still holds under the new behavior, adjust it minimally; report exactly what you changed and why.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claim-repository.integration.test.ts
git commit -m "fix(klaviyo): rebind a replaced claim graph instead of staling it"
```

---

### Task 3: Rebind at the start path

**Files:**
- Modify: `src/lib/klaviyo/claim-repository.ts` (`startOrResumeClaimReplay`, the conflict branch ~lines 170-179)
- Test: `src/lib/klaviyo/claim-repository.integration.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
it("rebinds a live graph to the requested current publication instead of conflicting", async () => {
  const first = await publishMatchWorld();
  const claimReplayId = await startGraph(first.matchRunId);
  const second = await matchService.computeAndPublishMatches({
    scope,
    sourceRunId: "source-run-a",
    shopifyEvidenceRunId: "evidence-run-a",
  });
  const result = await repository.startOrResumeClaimReplay({
    scope,
    sourceRunId: "source-run-a",
    matchRunId: second.runId,
    now: new Date(),
  });
  expect(result).toEqual({ kind: "pending", claimReplayId });
  const row = await graphRow(claimReplayId);
  expect(row.checkpoint.matchRunId).toBe(second.runId);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test -- --run src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: FAIL — returns `{kind: "conflict"}`.

- [ ] **Step 3: Implement.** In the live-graph branch, replace the bare `return { kind: "conflict" as const };` with:

```ts
        // A live graph pointed at a replaced publication is healthy, just
        // behind: rebind it to the requested run rather than reporting a
        // conflict the supervisor would record as a failed stage.
        assertExactClaimReplayCheckpoint(running.checkpoint);
        const rebound = await rebindGraphLocked(
          tx,
          input.scope,
          running.id,
          running.checkpoint,
          "start_rebind",
        );
        if (rebound !== null && rebound.matchRunId === input.matchRunId) {
          return { kind: "pending" as const, claimReplayId: running.id };
        }
        return { kind: "conflict" as const };
```

The running-graph `select` currently reads only `{id, sourceRunId, matchRunId, heartbeatAt}` — add `checkpoint: klaviyoClaimReplayRuns.checkpoint` to it.

- [ ] **Step 4: Run tests.**

Run: `npm run test -- --run src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: PASS. **Review-sensitive:** `"starts one graph, reuses it live, and conflicts on a different binding"` (~:317) asserts `{kind:"conflict"}` for `matchRunId: "match-run-other"`. That id is not a published run, so `rebindGraphLocked` returns null and the test should still pass unchanged — confirm it does, and if it needed any edit, report exactly what and why.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/klaviyo/claim-repository.ts src/lib/klaviyo/claim-repository.integration.test.ts
git commit -m "fix(klaviyo): rebind a live graph at the claims start path"
```

---

### Task 4: Shrink the refresh window

**Files:**
- Modify: `src/lib/klaviyo/claims.ts:306-311`
- Test: `src/lib/klaviyo/claim-repository.integration.test.ts` (the `describe("age-bounded replay scope")` block)

- [ ] **Step 1: Write the failing test.** In that describe block, using its `insertCoverageState` and `seedExtraConversionEvent` helpers:

```ts
it("skips a covered conversion older than the three-day refresh window", async () => {
  // 5 days old: inside the old 14-day refresh, outside the new 3-day one.
  const occurredAt = new Date(Date.now() - 5 * DAY_MS);
  await seedExtraConversionEvent("event-5d", "external-5d", occurredAt);
  const { matchRunId } = await publishMatchWorld();
  await insertCoverageState({
    conversionEventId: "event-5d",
    status: "complete",
    matchRunId,
  });
  const claimReplayId = await startGraph(matchRunId);
  const client = fakeClaimClient();
  await repository.processClaimBatch(
    { scope, claimReplayId },
    dependenciesFor(client),
  );
  expect(fetchedExternalIds(client)).not.toContain("external-5d");
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test -- --run src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: FAIL — the 14-day window still refreshes a 5-day-old covered conversion.

- [ ] **Step 3: Implement.** Replace the constant and its comment:

```ts
// Klaviyo attribution for a conversion is fixed once its attribution
// windows close; 3 days is a generous bound on a late-resolving
// attribution link, and ~5x cheaper than the 14 days it replaces — at
// production volume the old window re-fetched ~2,450 conversions per pass
// (~3.5 hours) and starved the backlog it was meant to serve. Anchors
// older than the lookback are replayed only while the connection has no
// complete replay state for them (never successfully covered). Follow-up:
// if re-fetches are observed never to change a stored source_checksum,
// refresh can be dropped entirely.
export const CLAIM_REPLAY_LOOKBACK_DAYS = 3;
```

- [ ] **Step 4: Run tests.**

Run: `npm run test -- --run src/lib/klaviyo/claim-repository.integration.test.ts`
Expected: PASS. If an existing age-bound test seeded a fixture between 3 and 14 days old expecting a refresh, its intent changes — report it individually.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/klaviyo/claims.ts src/lib/klaviyo/claim-repository.integration.test.ts
git commit -m "fix(klaviyo): shrink the claim refresh window to three days"
```

---

### Task 5: Loader — claimsPending bucket and coverage

**Files:**
- Modify: `src/lib/klaviyo/email-attribution.ts`
- Test: `src/lib/klaviyo/email-attribution.integration.test.ts`

- [ ] **Step 1: Write the failing test.** Reuse the file's existing seeding helpers:

```ts
it("separates orders whose claims have not been fetched from real no-link orders", async () => {
  await seedAggregateWorld();
  // order-b is confirmed with a conversion event and no claims at all —
  // today it is reported as "no email link"; it is really "not asked yet".
  const summary = await loadEmailAttribution({ scope, window, days });
  expect(summary.gaps.claimsPending.orders).toBeGreaterThan(0);
  expect(summary.claimCoverage.covered).toBeLessThan(
    summary.claimCoverage.total,
  );
  const partitionTotal =
    Number(summary.email.revenue) +
    Number(summary.gaps.noEmailLink.revenue) +
    Number(summary.gaps.claimsPending.revenue) +
    Number(summary.gaps.notEvaluated.revenue) +
    Number(summary.gaps.noKlaviyoEvent.revenue) +
    Number(summary.gaps.duplicateFlagged.revenue);
  expect(partitionTotal).toBeCloseTo(114.75, 2);
});
```

(Adjust the expected total to whatever `seedAggregateWorld` produces in the current file — read its existing partition-invariant test and reuse that number.)

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test -- --run src/lib/klaviyo/email-attribution.integration.test.ts`
Expected: FAIL — `gaps.claimsPending` and `claimCoverage` are undefined.

- [ ] **Step 3: Implement.** In `email-attribution.ts`, add a fragment beside `QUALIFYING_CLAIM`:

```ts
/**
 * A conversion whose claims have never been fetched. Distinguishing this
 * from a real "no campaign/flow link" matters: an unfetched order is not
 * evidence that email did nothing, and conflating them overstated the
 * no-link bucket by the size of the claims backlog.
 */
const CLAIMS_COVERED = sql`
  select 1 from klaviyo_claim_replay_state s
   where s.connection_id = r.connection_id
     and s.conversion_event_id = r.selected_event_id
     and s.status = 'complete'`;
```

Add the arm to `BUCKET_CASE`, immediately after the `email_linked` arm:

```ts
    when r.status = 'confirmed'
         and r.selected_event_id is not null
         and not exists (${CLAIMS_COVERED}) then 'claims_pending'
```

Extend the summary type:

```ts
  claimCoverage: { covered: number; total: number };
  gaps: {
    noEmailLink: EmailAttributionBucket;
    claimsPending: EmailAttributionBucket;
    notEvaluated: EmailAttributionBucket;
    noKlaviyoEvent: EmailAttributionBucket;
    duplicateFlagged: EmailAttributionBucket;
    unmatchedEvents: number;
  };
```

Add the coverage aggregate beside the other queries (it uses the partial index `(connection_id, conversion_event_id) WHERE status = 'complete'`):

```ts
  const coverage = await db.execute<{ covered: number; total: number }>(sql`
    select count(*) filter (where exists (${CLAIMS_COVERED}))::int as covered,
           count(*)::int as total
      from shopify_order o
      join klaviyo_order_match_result r
        on r.organization_id = o.organization_id
       and r.shopify_store_id = o.store_id
       and r.connection_id = ${scope.connectionId}
       and r.order_id = o.id
       and r.superseded_at is null
       and r.status = 'confirmed'
       and r.selected_event_id is not null
     where o.organization_id = ${scope.organizationId}
       and o.store_id = ${scope.storeId}
       and o.order_created_at >= ${utcTimestamp(window.from)}
       and o.order_created_at < ${utcTimestamp(window.to)}`);
```

And in the return statement:

```ts
    claimCoverage: {
      covered: coverage.rows[0]?.covered ?? 0,
      total: coverage.rows[0]?.total ?? 0,
    },
    gaps: {
      noEmailLink: bucket("no_email_link"),
      claimsPending: bucket("claims_pending"),
      notEvaluated: bucket("not_evaluated"),
      noKlaviyoEvent: bucket("no_klaviyo_event"),
      duplicateFlagged: bucket("duplicate_flagged"),
      unmatchedEvents: unmatched.rows[0]?.count ?? 0,
    },
```

- [ ] **Step 4: Run tests.**

Run: `npm run test -- --run src/lib/klaviyo/email-attribution.integration.test.ts src/lib/trpc/routers/klaviyo.test.ts`
Expected: PASS. The router test's mocked `loadListHealth`-style zero payload for `loadEmailAttribution` needs the two new fields — add them to its priming.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/klaviyo/email-attribution.ts src/lib/klaviyo/email-attribution.integration.test.ts src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(klaviyo): report claim coverage and pending-claim orders"
```

---

### Task 6: Panel caption and gap entry

**Files:**
- Modify: `src/components/blocks/attribution/klaviyo/copy.ts`, `email-revenue-gaps.tsx`, `email-revenue-panel.tsx`
- Test: `src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx`

- [ ] **Step 1: Write the failing tests.** Extend the panel/gaps fixture with the new fields, then:

```tsx
it("captions the email KPI while claim coverage is partial", () => {
  render(
    <EmailRevenueHeadline
      summary={summary({ claimCoverage: { covered: 124, total: 1184 } })}
      shopifyTotal="10000.00"
      currency="USD"
      dateFrom="2026-06-01"
      dateTo="2026-08-01"
    />,
  );
  expect(screen.getByTestId("email-coverage")).toHaveTextContent(
    "124/1,184 checked",
  );
});

it("drops the caption once coverage is complete", () => {
  render(
    <EmailRevenueHeadline
      summary={summary({ claimCoverage: { covered: 1184, total: 1184 } })}
      shopifyTotal="10000.00"
      currency="USD"
      dateFrom="2026-06-01"
      dateTo="2026-08-01"
    />,
  );
  expect(screen.queryByTestId("email-coverage")).toBeNull();
});

it("reports pending-claim orders separately from no-link orders", () => {
  render(
    <EmailRevenueGaps
      summary={summary()}
      currency="USD"
      dateFrom="2026-08-01"
      dateTo="2026-08-24"
    />,
  );
  expect(screen.getByTestId("gap-claims-pending")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx`
Expected: FAIL on the missing testids.

- [ ] **Step 3: Implement.** Copy additions in `copy.ts` inside `emailRevenue`:

```ts
  coverage: (covered: string, total: string) => `${covered}/${total} checked`,
  gapClaimsPending: (orders: number) =>
    `${orders} order${orders === 1 ? "" : "s"} not checked for email links yet`,
```

In `email-revenue-panel.tsx`, append inside the existing `email-linked-label` paragraph, after the `copy.linked(...)` call:

```tsx
            {summary.claimCoverage.covered < summary.claimCoverage.total ? (
              <span className="ml-1 text-amber-600" data-testid="email-coverage">
                ·{" "}
                {copy.coverage(
                  summary.claimCoverage.covered.toLocaleString(),
                  summary.claimCoverage.total.toLocaleString(),
                )}
              </span>
            ) : null}
```

In `email-revenue-gaps.tsx`, add an entry immediately after the `no-email-link` entry:

```tsx
    {
      key: "claims-pending",
      text: copy.gapClaimsPending(gaps.claimsPending.orders),
      revenue: gaps.claimsPending.revenue,
      href: labUrl({ view: "orders", orderStatus: "confirmed" }, range),
    },
```

- [ ] **Step 4: Run tests.**

Run: `npm run test:components`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/components/blocks/attribution/klaviyo/copy.ts src/components/blocks/attribution/klaviyo/email-revenue-gaps.tsx src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx
git commit -m "feat(klaviyo): surface claim coverage in the email revenue panel"
```

---

### Task 7: Full verification

- [ ] `npm run test` — all files green; confirm the klaviyo integration suites RAN (counts, not skipped).
- [ ] `npm run test:components` — green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx eslint` on every touched file — clean.
- [ ] `git status` — clean except `.gitignore`.
- [ ] Do NOT push or open a PR; report status, and list every test whose meaning changed with the reason.

---

## Self-review checklist (applied)

- **Spec coverage:** §0 predicate correction (Task 1), §1 rebind incl. start path (Tasks 2-3), §2 cursor preserved (documented in the Task 2 helper comment), §3 lookback (Task 4), §4 coverage + claimsPending (Tasks 5-6), §5 observability (the `console.info` in Task 2's helper), §6 out-of-scope respected (no throughput constants, no schema change, no sync auto-trigger), §7 testing distributed across tasks.
- **Type consistency:** `rebindGraphLocked` returns `ClaimReplayCheckpoint | null` everywhere; `claimCoverage: {covered,total}` and `gaps.claimsPending` named identically in loader, router priming, and both components.
- **Known judgment calls:** `recoverExhaustedClaimBatch`'s gate stays terminal (retries already exhausted); `publication_stale` keeps its literal with a widened meaning so `ClaimAnchorResult` is untouched; the claims-pending Lab deep link filters `orderStatus=confirmed` only, since no "missing claims" Lab filter exists.
