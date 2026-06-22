# Plan 001: Characterize analytics query outputs before optimizing them

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b8dfd95..HEAD -- src/lib/trpc/routers/ad-creative.ts src/lib/trpc/routers/performance-log.ts src/lib/creative-health-rollup.ts src/lib/performance-log-sql.ts src/lib/trpc/test-helpers.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, stop and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b8dfd95`, 2026-06-21

## Why this matters

The dashboard, creatives, and MER pages are slow because their first-load queries are expensive, but the query math is product-sensitive. Spend, revenue, ROAS, CPA, CTR, health, active status, and canonical daily-row filtering all have deliberate semantics. Before optimizing SQL shape, add characterization tests that lock representative outputs so later plans can refactor without silently changing numbers.

## Current state

Relevant files:

- `src/lib/trpc/routers/ad-creative.ts` - owns `list`, `dashboardStats`, `getDailyPortfolioPerformance`, and `getMerAccountBreakdown`.
- `src/lib/trpc/routers/performance-log.ts` - owns `demographicBreakdown`.
- `src/lib/creative-health-rollup.ts` - computes creative health after list/dashboard queries.
- `src/lib/performance-log-sql.ts` - defines the canonical performance-log filter.
- `src/lib/trpc/test-helpers.ts` - creates tRPC callers for router tests.

Excerpts to preserve:

```ts
// src/lib/performance-log-sql.ts:16
// Filter for canonical per-ad-per-day aggregate rows:
//   - breakdown columns are empty/null (not a demographic split), AND
//   - date_start = date_end (not a legacy multi-day rollup)
```

```ts
// src/app/(protected)/(dashboard)/page.tsx:117
const stats = useQuery(
  trpc.adCreative.dashboardStats.queryOptions({
    from: fromValue,
    to: toValue,
    accountId: selectedAccountId,
    teamId: selectedTeamId,
  }),
);
```

```ts
// src/lib/trpc/routers/ad-creative.ts:439
const portfolioResult = await db.execute(sql`
  SELECT
    sum(pl.spend)::text as total_spend,
    sum(pl.purchase_value)::text as total_purchase_value,
    (coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as portfolio_roas,
```

```ts
// src/lib/trpc/routers/ad-creative.ts:262
const healthByCreative = await computeCreativeHealthByCreativeId({
  organizationId: ctx.organizationId,
  creativeIds: rows.map((r) => r.id),
  dateFilter: dateFilterForRollup,
});
```

Testing conventions:

- Existing router tests live in `src/lib/trpc/routers/*.test.ts`.
- They use Vitest and `createMockCaller` from `src/lib/trpc/test-helpers.ts`.
- Use `vi.mock` and dynamic imports when mocking module singletons such as `@/db`; do not mutate real database state.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` | exit 0, all new tests pass |
| Full tests | `bun test` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- `src/lib/trpc/routers/ad-creative.analytics.test.ts` (create)
- `src/lib/trpc/routers/performance-log.analytics.test.ts` (create if demographic coverage is easier separately)
- `src/lib/trpc/test-helpers.ts` only if a small test helper is needed
- `plans/README.md` status update

**Out of scope**:

- Changing SQL behavior.
- Adding pagination or new router inputs.
- Adding database indexes or migrations.
- Editing UI pages.

## Git workflow

- Branch: `lone/001-characterize-analytics-queries`
- Commit message style observed in repo: concise conventional-ish messages, for example `fix(ad-export): weight CSV aggregates correctly and clean up column semantics`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a database mock harness for analytics router tests

Create `src/lib/trpc/routers/ad-creative.analytics.test.ts`. Mock `@/db` before importing the app router. The mock must support:

- `db.execute(sql)` returning queued row sets for raw SQL procedures.
- The Drizzle select chain used by `adCreative.list`, if testing `list` in this file: `.select().from().where().orderBy()` returning queued rows.

Use dynamic import after `vi.mock`:

```ts
vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/creative-health-rollup", () => ({
  computeCreativeHealthByCreativeId: vi.fn(async () => new Map()),
}));
const { createMockCaller } = await import("../test-helpers");
```

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` -> the file runs and fails only because no assertions exist yet, or passes with the first smoke assertion.

### Step 2: Characterize `dashboardStats`

Add a test that calls:

```ts
caller.adCreative.dashboardStats({
  from: "2026-06-01",
  to: "2026-06-07",
  accountId: "acct_1",
  teamId: "team_1",
});
```

Queue raw SQL results for portfolio, top performers, surviving creatives, bottom performers, and health. Assert the returned object has:

- `portfolio.totalSpend`, `portfolio.totalRevenue`, `portfolio.roas`, `portfolio.cpa`, `portfolio.ctr`, `portfolio.conversions`.
- `topPerformers[*]` fields and `isEvergreen` behavior.
- `bottomPerformers[*]` fields including `bleederAdCount`, `activeAdCount`, `bleederDollarsAtRisk`, `bleederMetaIds`, and `tier`.
- `survivingCreatives[*]` fields.

Also assert `computeCreativeHealthByCreativeId` receives the union of top, bottom, and surviving creative IDs and the organization ID from the mock context.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t dashboardStats` -> exit 0.

### Step 3: Characterize `getDailyPortfolioPerformance`

Add a test with queued rows containing:

- A day with spend/revenue.
- A zero-spend trailing day.
- A no-spend middle day if you mock the final SQL result directly.

Assert the procedure preserves the existing trimming rule at `src/lib/trpc/routers/ad-creative.ts:933`: trailing zero-spend rows after the last spend day are removed, but earlier zero rows are preserved.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t getDailyPortfolioPerformance` -> exit 0.

### Step 4: Characterize `getMerAccountBreakdown`

Add a test for account breakdown mapping. Queue a row with `spend`, `revenue`, `roas`, `prior_spend`, `prior_roas`, and a sparkline array with trailing zero-spend points. Assert:

- `spendDelta` is current spend minus prior spend.
- `roasDelta` is current ROAS minus prior ROAS.
- Sparkline points are trimmed after the last spend point.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t getMerAccountBreakdown` -> exit 0.

### Step 5: Characterize `adCreative.list` response shape

Add a test for `adCreative.list` with one mocked creative row and one mocked health result. Assert the public shape includes all current fields used by `src/app/(protected)/creatives/page.tsx`: `id`, `name`, media URLs, resolution fields, `destinationUrl`, `totalSpend`, `avgRoas`, `avgCpa`, `avgCtr`, `totalConversions`, Meta IDs, account/team fields, trend fields, `health`, and `healthReasons`.

This is a shape test. Do not assert exact SQL text.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t "adCreative.list"` -> exit 0.

### Step 6: Characterize `performanceLog.demographicBreakdown`

If not included in the same file, create `src/lib/trpc/routers/performance-log.analytics.test.ts`. Mock `db.execute`, call `caller.performanceLog.demographicBreakdown`, and assert it returns the raw breakdown rows with `label`, `spend`, `conversions`, `roas`, and `impressions`.

**Verify**: `bun test src/lib/trpc/routers/performance-log.analytics.test.ts` -> exit 0.

## Test plan

- New tests should cover the five procedures named above.
- Use existing Vitest style from `src/lib/trpc/routers/data-mutations.test.ts`.
- Verification: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts src/lib/trpc/routers/performance-log.analytics.test.ts` -> all pass.

## Done criteria

- [ ] Focused analytics tests exit 0.
- [ ] `bun test` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun run build` exits 0.
- [ ] No production behavior changed except test-only helper exports if absolutely needed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Mocking `@/db` requires broad production refactors.
- Any analytics procedure cannot be imported in a test without connecting to a real database.
- You discover existing tests already cover these exact procedures and response shapes.
- The code excerpts above do not match the live code.

## Maintenance notes

These tests are guardrails for query rewrites, not a replacement for database-level `EXPLAIN ANALYZE`. Reviewers should check that the tests assert user-visible response shape and mapping semantics, not brittle SQL strings.
