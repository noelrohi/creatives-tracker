# Plan 002: Make the creatives list query set-based and avoid initial health rollup

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b8dfd95..HEAD -- src/lib/trpc/routers/ad-creative.ts 'src/app/(protected)/creatives/page.tsx' src/lib/creative-health-rollup.ts src/lib/performance-log-sql.ts src/lib/trpc/routers/ad-creative.analytics.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, stop and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-characterize-analytics-queries.md`
- **Category**: perf
- **Planned at**: commit `b8dfd95`, 2026-06-21

## Why this matters

The creatives page currently asks for one list, but `adCreative.list` calculates many metrics through correlated subqueries for every creative row and then runs a health rollup for all returned creatives. As creative count grows, this becomes a row-count multiplier on `performance_log`. This plan preserves the list response shape while replacing repeated per-row work with set-based aggregates and making health computation opt-in for the first page load.

## Current state

Relevant files:

- `src/app/(protected)/creatives/page.tsx` - calls `trpc.adCreative.list` on first render.
- `src/lib/trpc/routers/ad-creative.ts` - implements `adCreative.list`.
- `src/lib/creative-health-rollup.ts` - separate health query called after the list query.
- `src/lib/performance-log-sql.ts` - canonical performance-log filter.

Current UI call:

```ts
// src/app/(protected)/creatives/page.tsx:613
const creatives = useQuery(
  trpc.adCreative.list.queryOptions({
    format: format || undefined,
    awarenessLevel: awareness || undefined,
    search: search || undefined,
    accountId: accountId ? accountId : undefined,
    adSetIds: adSetIds ? adSetIds.split(",") : undefined,
    teamId: teamId || undefined,
    from: fromValue,
    to: toValue,
  }),
);
```

Current router shape:

```ts
// src/lib/trpc/routers/ad-creative.ts:98
const rows = await db
  .select({
    id: adCreatives.id,
    name: adCreatives.name,
    destinationUrl: sql<string | null>`(
      SELECT ad.destination_url FROM ad
      WHERE ad.ad_creative_id = "ad_creative"."id"
        AND ad.destination_url IS NOT NULL
      ORDER BY ad.updated_at DESC NULLS LAST, ad.created_at DESC
      LIMIT 1
    )`.as("destination_url"),
```

```ts
// src/lib/trpc/routers/ad-creative.ts:123
totalSpend: sql<string | null>`(
  SELECT sum(pl.spend) FROM performance_log pl
  JOIN ad ON ad.id = pl.ad_id
  WHERE ad.ad_creative_id = "ad_creative"."id" ${win}
)`.as("total_spend"),
```

```ts
// src/lib/trpc/routers/ad-creative.ts:262
const healthByCreative = await computeCreativeHealthByCreativeId({
  organizationId: ctx.organizationId,
  creativeIds: rows.map((r) => r.id),
  dateFilter: dateFilterForRollup,
});
```

Important compatibility rule: existing callers of `adCreative.list` should not break. If you add an input flag, default it to current behavior unless a specific UI caller opts into faster behavior.

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
- `src/app/(protected)/creatives/page.tsx`
- `src/lib/trpc/routers/ad-creative.analytics.test.ts`
- `plans/README.md` status update

**Out of scope**:

- Changing displayed metric formulas.
- Adding database indexes or migrations.
- Changing `computeCreativeHealthByCreativeId` internals.
- Adding server-side pagination. That is valid future work, but not this plan.

## Git workflow

- Branch: `lone/002-optimize-creatives-list-query`
- Commit message: `perf(creatives): optimize list analytics query`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Extend `adCreative.list` input with an opt-in health flag

In `src/lib/trpc/routers/ad-creative.ts`, add:

```ts
includeHealth: z.boolean().optional(),
```

to the `list` input object. Treat `undefined` as current behavior for compatibility:

```ts
const includeHealth = input?.includeHealth ?? true;
```

When `includeHealth` is false, skip `computeCreativeHealthByCreativeId` and return `health: null`, `healthReasons: []` for every row.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t "adCreative.list"` -> existing list shape test passes after updating it for both `includeHealth: true` and `includeHealth: false`.

### Step 2: Update the creatives page to avoid health on default first load

In `src/app/(protected)/creatives/page.tsx`, move `columnVisibility` state above the `useQuery` call if needed. Pass:

```ts
includeHealth: Boolean(healthFilter) || columnVisibility.health === true,
```

to `adCreative.list`.

The default `columnVisibility` currently hides health:

```ts
// src/app/(protected)/creatives/page.tsx:629
const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({
  angle: false,
  awarenessLevel: false,
  format: false,
  health: false,
  avgCpa: false,
});
```

Keep health available when a user filters by health or turns the health column on.

**Verify**: `bun run lint` -> exit 0.

### Step 3: Replace list metric subqueries with set-based SQL

In `adCreative.list`, replace the many correlated metric subqueries with one set-based query. Prefer a raw SQL CTE because the existing router already uses raw SQL for complex analytics.

Target SQL shape:

- `filtered_creatives`: all creative fields matching organization, format, awareness, search, account, ad set, ownership, team, and untagged filters.
- `window_perf`: aggregates canonical `performance_log` rows grouped by `ad.ad_creative_id`.
- `recent_cutoff`: max `pl.date_end - 3` per creative inside the same window.
- `recent_perf`: recent CTR, CPC, CPA, hook rate grouped by creative.
- `prior_perf`: prior hook rate grouped by creative.
- `latest_ad`: one row per creative for `destinationUrl`, `metaAdId`, `metaCampaignId`, `metaAdSetId`, `accountName`, and effective ad status.

Preserve current formulas unless Plan 001 tests say otherwise:

- `totalSpend = sum(pl.spend)`
- `avgRoas = coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0)`
- `totalConversions = sum(pl.conversions)`
- `avgCpa = coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0)`
- `avgCtr` currently uses `avg(pl.ctr)` in `adCreative.list`; do not change to weighted CTR in this plan.
- `thumbstopRatio = sum(pl.video_views_3s)::float / nullif(sum(pl.impressions), 0)`

Keep the date semantics from current `win`: when both `from` and `to` exist, use canonical rows with `pl.date_start >= from` and `pl.date_start <= to`.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t "adCreative.list"` -> exit 0.

### Step 4: Preserve filters exactly

Re-check every current input condition:

- `format`
- `awarenessLevel`
- `search`
- `accountId`
- `adSetIds`
- `ownership`
- `teamId`, including `"none"`
- `untaggedOnly`
- `from` and `to`

Add or update tests so at least one test asserts that these filters are included in the mocked SQL path or in helper output if you extracted a query builder.

**Verify**: `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t "filters"` -> exit 0.

### Step 5: Compare response shape manually in development

Run the dev server and open `/creatives` with no health filter. Confirm initial table renders with the same columns and no runtime errors. Then open `/creatives?health=critical` and confirm health values are present.

**Verify**: `bun dev` -> starts Next.js; browser console has no tRPC or React errors on `/creatives` and `/creatives?health=critical`.

## Test plan

- Update Plan 001 tests to cover `includeHealth: false`.
- Keep existing response-shape expectations for `includeHealth: true`.
- Add a filter preservation test if the SQL generation was extracted into a helper.

## Done criteria

- [ ] `adCreative.list` no longer projects repeated metric subqueries per creative row.
- [ ] `/creatives` default query passes `includeHealth: false`.
- [ ] Health still loads when health filter is active or the health column is visible.
- [ ] `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` exits 0.
- [ ] `bun test`, `bun run lint`, and `bun run build` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Preserving the current response shape requires changing more than `adCreative.list` and the creatives page.
- Current formulas are ambiguous or contradicted by tests.
- The new query changes numeric outputs in characterization tests.
- You need to add pagination to make the plan work.

## Maintenance notes

This plan intentionally does not solve all table scalability. If creative count becomes very large, add server-side pagination and sorting as a separate plan. Reviewers should scrutinize filter parity and date semantics first.
