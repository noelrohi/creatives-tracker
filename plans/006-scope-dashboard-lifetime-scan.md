# Plan 006: Scope dashboard lifetime aggregation to relevant organization ads

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ed19da0..HEAD -- src/lib/trpc/routers/ad-creative.ts src/lib/trpc/routers/ad-creative.analytics.test.ts`
> If either in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: none (Plans 001–005 are already marked DONE)
- **Category**: perf
- **Planned at**: commit `ed19da0`, 2026-07-13

## Why this matters

Every `dashboardStats` call calculates each ad's lifetime running days for the Needs Attention leaderboard. The current `ad_lifetime_days` CTE scans and groups every canonical `performance_log` row in the database before a later CTE restricts work to the active organization and selected account/team filters. This cost grows with all tenants' history and also affects MER because MER requests `dashboardStats` for its secondary leaderboard. Restricting the lifetime aggregation to the exact ads eligible for the bottom-performer query preserves lifetime semantics while preventing unrelated tenant and account history from being processed.

## Current state

Relevant files:

- `src/lib/trpc/routers/ad-creative.ts` — defines `dashboardStats`; its bottom-performer SQL contains the unscoped lifetime CTE.
- `src/lib/trpc/routers/ad-creative.analytics.test.ts` — mocks Drizzle execution, compiles generated SQL with `PgDialect`, and characterizes analytics response shapes.

The bottom query currently begins as follows:

```ts
// src/lib/trpc/routers/ad-creative.ts:729-762
const bottomResult = await db.execute(sql`
  WITH ad_lifetime_days AS (
    SELECT
      pl.ad_id,
      (max(pl.date_end)::date - min(pl.date_start)::date) AS running_days
    FROM performance_log pl
    WHERE ${basePl}
    GROUP BY pl.ad_id
  ),
  ad_window AS (
    SELECT
      ad.id AS ad_id,
      ad.meta_id AS meta_ad_id,
      ad.ad_creative_id,
      ${effectiveAdStatusSql(sql`ad.status`, sql`ast.status`)} AS status,
      ...
    FROM ad
    JOIN performance_log pl ON pl.ad_id = ad.id
    JOIN ad_creative ac ON ac.id = ad.ad_creative_id
    LEFT JOIN ad_set ast ON ast.id = ad.ad_set_id
    LEFT JOIN ad_lifetime_days ald ON ald.ad_id = ad.id
    WHERE ${dateFilter}
      AND ${basePl}
      AND ad.organization_id = ${ctx.organizationId}
      ${accountFilter} ${campaignFilter} ${adSetFilter} ${ownershipFilter} ${teamFilter}
```

The important semantic constraint is documented immediately above the CTE: `running_days` is lifetime, not bounded by the dashboard's selected `from`/`to` window. Preserve that behavior.

`buildDashboardAnalyticsFilters` produces SQL fragments using the aliases `ad`, `ac`, and `ast`. Any shared relevant-ad CTE must use those aliases while applying the fragments. The current bottom query intentionally omits `statusFilter`; do not add it as part of this optimization.

Tests can inspect generated SQL using the existing helper:

```ts
// src/lib/trpc/routers/ad-creative.analytics.test.ts:26-28
function compileSql(query: unknown): string {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}
```

Repo conventions and commands:

- Bun is the package manager.
- Database changes use generated migrations, but this plan contains no schema change.
- Tests use Vitest and colocate router analytics coverage in `ad-creative.analytics.test.ts`.
- Recent commits use conventional messages such as `feat: support disabling ad accounts`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` | exit 0; all tests pass |
| Focused lint | `bun run lint -- src/lib/trpc/routers/ad-creative.ts src/lib/trpc/routers/ad-creative.analytics.test.ts` | exit 0 |
| Full tests | `bun test` | exit 0; all tests pass |
| Build | `bun run build` | exit 0 |

Do not run `bun install`, `db:push`, or migrations; this fix requires no dependency or schema changes.

## Scope

**In scope** (the only source files to modify):

- `src/lib/trpc/routers/ad-creative.ts`
- `src/lib/trpc/routers/ad-creative.analytics.test.ts`
- `plans/README.md` only for the final status update

**Out of scope**:

- `src/db/index.ts` and any migration from `pg` to `@neondatabase/serverless`.
- `package.json`, `bun.lock`, Vercel settings, and Neon configuration.
- Database indexes or migrations.
- Changes to analytics formulas, thresholds, ordering, response fields, or date-window semantics.
- Adding `statusFilter` to the bottom-performer query.
- Changing the intentionally lifetime-based Surviving Creatives query.
- Existing unrelated working-tree changes under `.agents/` and `skills-lock.json`; do not restore, stage, or modify them.

## Git workflow

- Suggested branch: `perf/scope-dashboard-lifetime-scan`
- Suggested commit: `perf: scope dashboard lifetime aggregation`
- Do not push or open a PR unless instructed.
- Never include the pre-existing `.agents/` or `skills-lock.json` changes in the commit.

## Steps

### Step 1: Add a SQL-shape regression test

In the existing `dashboardStats` describe block in `src/lib/trpc/routers/ad-creative.analytics.test.ts`, add a focused test that invokes `dashboardStats` with an organization plus `accountId` and `teamId`, queues empty result sets for all four direct `db.execute` calls, and inspects the fourth generated SQL statement (the bottom-performer query).

The test must establish these structural properties without depending on exact `$1`, `$2`, etc. placeholder numbers:

1. A relevant-ad relation/CTE is organization-scoped before lifetime performance rows are aggregated.
2. The lifetime aggregation joins `performance_log` only to that relevant-ad set rather than grouping all of `performance_log` directly.
3. The selected dashboard date range is applied to `ad_window`, not to `ad_lifetime_days`.
4. Account and team filters remain in the relevant-ad selection.

Prefer assertions on normalized compiled SQL fragments and CTE ordering rather than snapshotting the entire query. Keep the existing public-shape test unchanged.

**Verify**: run `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts`. Before the production SQL is changed, the new regression test should fail for the expected missing relevant-ad scope; all pre-existing tests should still pass.

### Step 2: Scope the bottom query with a relevant-ad CTE

In `dashboardStats`'s `bottomResult` SQL, introduce a first CTE such as `relevant_ads`. It should select only fields needed later (`id`, `meta_id`, `ad_creative_id`, and the effective status or its source statuses) from:

- `ad` using alias `ad`,
- `ad_creative` using alias `ac`,
- `ad_set` using alias `ast` via a left join.

Apply these existing constraints inside `relevant_ads`:

- `ad.organization_id = ${ctx.organizationId}`
- `${accountFilter}`
- `${campaignFilter}`
- `${adSetFilter}`
- `${ownershipFilter}`
- `${teamFilter}`

Do not apply `${dateFilter}`, `${basePl}`, or `${statusFilter}` in `relevant_ads`. The date and canonical-row predicates belong to performance rows; status filtering is deliberately absent from the current bottom query.

Rewrite `ad_lifetime_days` to join canonical `performance_log` rows to `relevant_ads`, then group only those ad IDs. Do not add any selected-window date predicate here.

Rewrite `ad_window` to start from `relevant_ads`, join `performance_log` and `ad_lifetime_days`, and retain `${dateFilter}` plus `${basePl}`. Preserve selected columns, grouping, downstream CTE names, thresholds, formulas, and output mapping. Remove only joins and filters made redundant by `relevant_ads`.

The resulting data semantics must remain:

- `running_days`: lifetime min/max canonical dates for each relevant ad.
- window spend/revenue/conversions: selected date range only.
- eligible ads: same organization/account/campaign/ad-set/ownership/team set as before.
- effective status: same `ad.status`/`ad_set.status` calculation as before.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` exits 0, including the new SQL-shape test and existing response-shape tests.

### Step 3: Run focused static verification

Run:

```bash
bun run lint -- src/lib/trpc/routers/ad-creative.ts src/lib/trpc/routers/ad-creative.analytics.test.ts
```

Expected: exit 0 with no lint errors.

Review the diff and confirm no dashboard output mapping or unrelated procedure changed.

**Verify**: `git diff --check` exits 0; `git diff --name-only` lists only the two source files and `plans/README.md` if its status has already been updated, aside from the explicitly pre-existing unrelated working-tree changes.

### Step 4: Run repository verification

Run:

```bash
bun test
bun run build
```

Expected: both exit 0. The build may emit existing warnings, but it must produce no new error.

### Step 5: Record completion

Update Plan 006's row in `plans/README.md` from `TODO` to `DONE`. Do not alter the statuses of Plans 001–005.

**Verify**: `rg '006.*DONE' plans/README.md` returns exactly one matching row.

## Test plan

Add one SQL-shape regression test to `src/lib/trpc/routers/ad-creative.analytics.test.ts`, modeled on the existing `dashboardStats` test and `compileSql` helper. It must cover organization, account, and team scoping and verify that lifetime aggregation is not date-window bounded. Existing tests already cover the public response mapping and must remain unchanged and passing.

Verification sequence:

1. New test fails before implementation for the expected unscoped SQL shape.
2. Focused analytics test passes after implementation.
3. Full `bun test`, focused lint, and production build pass.

## Done criteria

- [ ] The bottom-performer SQL selects relevant ads by organization before scanning lifetime performance rows.
- [ ] Account, campaign, ad-set, ownership, and team filter fragments retain their prior behavior.
- [ ] `ad_lifetime_days` scans canonical lifetime rows only for relevant ads and has no selected `from`/`to` date restriction.
- [ ] `ad_window` retains selected-window and canonical-row restrictions.
- [ ] Effective ad status, formulas, thresholds, ordering, response shape, and output mapping are unchanged.
- [ ] A focused SQL-shape regression test exists and passes.
- [ ] `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts`, `bun run lint -- ...`, `bun test`, and `bun run build` exit 0.
- [ ] No dependencies, schema files, migrations, DB driver code, or unrelated working-tree files changed.
- [ ] Plan 006 is marked DONE in `plans/README.md`.

## STOP conditions

Stop and report instead of improvising if:

- The bottom query no longer matches the current-state excerpt or its CTE structure has materially changed.
- Preserving the existing account/campaign/ad-set/ownership/team behavior requires changing `buildDashboardAnalyticsFilters` globally.
- The rewrite appears to require a schema migration, dependency change, or database-driver migration.
- Query output or existing analytics tests change after the rewrite.
- The test cannot distinguish lifetime scope from selected-window scope without asserting sensitive/runtime parameter values.
- Any verification command fails twice after a reasonable correction.

## Maintenance notes

A reviewer should scrutinize alias usage because the reusable filter fragments assume `ad`, `ac`, and `ast`. They should also verify that no dashboard `from`/`to` predicate leaked into `ad_lifetime_days`; doing so would improve speed but silently change the product meaning of ad age. This plan deliberately does not migrate to Neon's serverless driver or optimize the separate lifetime Surviving Creatives query; measure production after this focused fix before pursuing either follow-up.
