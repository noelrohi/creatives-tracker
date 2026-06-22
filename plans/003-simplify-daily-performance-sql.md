# Plan 003: Simplify daily performance SQL for canonical daily rows

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b8dfd95..HEAD -- src/lib/trpc/routers/ad-creative.ts src/lib/performance-log-sql.ts src/lib/trpc/routers/ad-creative.analytics.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, stop and report.

## Status

- **Priority**: P1
- **Effort**: S-M
- **Risk**: LOW
- **Depends on**: `plans/001-characterize-analytics-queries.md`
- **Category**: perf
- **Planned at**: commit `b8dfd95`, 2026-06-21

## Why this matters

The daily portfolio and MER account sparkline queries build a date series and join each generated day to performance rows with `BETWEEN`. But the canonical filter already excludes legacy multi-day rows by requiring `date_start = date_end`. For canonical data, the query can aggregate directly by `pl.date_start` and fill missing days in TypeScript, reducing database work while preserving chart output.

## Current state

Relevant files:

- `src/lib/performance-log-sql.ts` - canonical filter.
- `src/lib/trpc/routers/ad-creative.ts` - `getDailyPortfolioPerformance` and `getMerAccountBreakdown`.

Current canonical filter:

```ts
// src/lib/performance-log-sql.ts:22
export function basePerformanceLogFilter(alias = "pl"): SQL {
  const parts: SQL[] = BREAKDOWN_COLUMNS.map(
    (column) => sql`coalesce(${qualifiedColumn(alias, column)}, '') = ''`,
  );
  parts.push(sql`${qualifiedColumn(alias, "date_start")} = ${qualifiedColumn(alias, "date_end")}`);
  return sql.join(parts, sql` AND `);
}
```

Current daily SQL:

```ts
// src/lib/trpc/routers/ad-creative.ts:891
WITH days AS (
  SELECT generate_series(${fromStr}::date, ${toStr}::date, '1 day'::interval)::date AS day
),
daily AS (
  SELECT
    d.day,
    sum(pl.spend / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS spend,
```

Current MER sparkline SQL:

```ts
// src/lib/trpc/routers/ad-creative.ts:1026
days AS (
  SELECT generate_series(${input.from}::date, ${input.to}::date, '1 day'::interval)::date AS day
),
daily_per_account AS (
  SELECT
    ad.account_id,
    d.day,
    sum(pl.spend / GREATEST((pl.date_end - pl.date_start + 1), 1)) AS spend,
```

The app has a data-health UI for legacy multi-day rows in `src/app/(protected)/mer/accounts/[id]/page.tsx`; do not reintroduce multi-day rollup support into these dashboard queries.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` | exit 0 |
| Full tests | `bun test` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |

## Scope

**In scope**:

- `src/lib/trpc/routers/ad-creative.ts`
- `src/lib/trpc/routers/ad-creative.analytics.test.ts`
- `plans/README.md` status update

**Out of scope**:

- Changing `basePerformanceLogFilter`.
- Changing import or purge behavior for legacy multi-day rows.
- Adding indexes or migrations.
- Changing chart components.

## Git workflow

- Branch: `lone/003-simplify-daily-performance-sql`
- Commit message: `perf(analytics): simplify daily performance queries`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a small date-fill helper

In `src/lib/trpc/routers/ad-creative.ts`, add a private helper near the analytics procedures:

```ts
function enumerateDateRange(from: string, to: string): string[] {
  // return YYYY-MM-DD strings inclusive
}
```

Use UTC-safe date-only arithmetic or the repo's existing date helpers if importing them is straightforward. The output must be inclusive of both `from` and `to`.

**Verify**: add a unit test or local assertion through analytics tests for `2026-06-01` to `2026-06-03` -> `["2026-06-01", "2026-06-02", "2026-06-03"]`.

### Step 2: Rewrite `getDailyPortfolioPerformance` to group by `pl.date_start`

Replace the `generate_series` SQL with a direct aggregate:

- `WHERE pl.date_start >= fromStr::date`
- `WHERE pl.date_start <= toStr::date`
- `AND ${basePl}`
- group by `pl.date_start`

Keep all existing metric formulas. Since canonical rows have one day per row, remove division by `GREATEST((pl.date_end - pl.date_start + 1), 1)`.

After the query returns, create a map by date and fill all dates from `enumerateDateRange(fromStr, toStr)` with zero rows where missing. Then preserve the existing trailing-zero trim:

```ts
// src/lib/trpc/routers/ad-creative.ts:933
let lastWithSpend = -1;
```

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t getDailyPortfolioPerformance` -> exit 0.

### Step 3: Rewrite `getMerAccountBreakdown` sparkline aggregation

Keep `current_period` and `prior_period` behavior unchanged unless tests require otherwise. In the `daily_per_account` CTE, stop joining generated days to `performance_log`. Aggregate canonical rows directly:

- `SELECT ad.account_id, pl.date_start::date AS day, sum(pl.spend) AS spend, sum(pl.purchase_value) AS revenue`
- filter `pl.date_start >= input.from::date` and `pl.date_start <= input.to::date`
- group by `ad.account_id, pl.date_start`

You may keep `days` and `sparkline_rows` for building one JSON point per account per day, but the expensive part should no longer be `JOIN performance_log pl ON d.day BETWEEN pl.date_start AND pl.date_end`.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t getMerAccountBreakdown` -> exit 0.

### Step 4: Check SQL text for removed pattern

Run:

```bash
rg -n "d\\.day BETWEEN pl\\.date_start AND pl\\.date_end|pl\\.spend / GREATEST" src/lib/trpc/routers/ad-creative.ts
```

Expected: no matches in `getDailyPortfolioPerformance` or `getMerAccountBreakdown`. If a match remains in unrelated export code, leave it alone.

**Verify**: the command above returns no matches for the two target procedures.

## Test plan

- Existing characterization tests from Plan 001 must still pass.
- Add a missing-day test for daily portfolio output: missing middle date returns a zero row and trailing zero dates are trimmed only after the last spend day.
- Add a MER sparkline test: sparkline still includes zero points between active days and trims trailing zero-spend points.

## Done criteria

- [ ] `getDailyPortfolioPerformance` aggregates by `pl.date_start` directly.
- [ ] `getMerAccountBreakdown` no longer joins each generated day to `performance_log`.
- [ ] Missing chart days are filled in TypeScript or in a cheap account/day join after aggregation.
- [ ] Focused analytics tests pass.
- [ ] `bun test`, `bun run lint`, and `bun run build` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Tests reveal the current product intentionally includes multi-day rows in these chart queries.
- Removing `BETWEEN` changes expected chart rows.
- Date-only arithmetic introduces timezone-dependent output.
- The SQL rewrite requires touching chart components.

## Maintenance notes

Future analytics queries should respect the same split: canonical daily rows can group by `date_start`; only legacy repair/export paths should allocate multi-day rows over generated days.
