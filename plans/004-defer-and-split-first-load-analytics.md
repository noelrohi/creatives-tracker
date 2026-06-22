# Plan 004: Defer hidden analytics and split MER first-load data

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b8dfd95..HEAD -- 'src/app/(protected)/(dashboard)/page.tsx' 'src/app/(protected)/mer/page.tsx' src/lib/trpc/routers/ad-creative.ts src/lib/trpc/routers/performance-log.ts src/lib/trpc/routers/ad-creative.analytics.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, stop and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-characterize-analytics-queries.md`, `plans/003-simplify-daily-performance-sql.md`
- **Category**: perf
- **Planned at**: commit `b8dfd95`, 2026-06-21

## Why this matters

The overview page fetches chart and demographic data even when the default tab is `overview`, so hidden tab content competes with the visible KPI and leaderboard data. The MER page uses `dashboardStats` for a small KPI rail and a below-the-fold Needs Attention table, forcing all leaderboard SQL to run before the KPI query completes. This plan keeps existing endpoints available but changes first-load callers to request only data needed for the initial view.

## Current state

Overview page first-load queries:

```ts
// src/app/(protected)/(dashboard)/page.tsx:117
const stats = useQuery(trpc.adCreative.dashboardStats.queryOptions({ ... }));

// src/app/(protected)/(dashboard)/page.tsx:126
const dailyPerf = useQuery(trpc.adCreative.getDailyPortfolioPerformance.queryOptions({ ... }));

// src/app/(protected)/(dashboard)/page.tsx:135
const demographic = useQuery(trpc.performanceLog.demographicBreakdown.queryOptions({ ... }));
```

But daily performance is only rendered on the charts tab:

```tsx
// src/app/(protected)/(dashboard)/page.tsx:332
<TabsContent value="charts" className="pt-4">
  {dailyPerf.data && dailyPerf.data.length > 1 ? (
```

And demographic data is only rendered on the demographics tab:

```tsx
// src/app/(protected)/(dashboard)/page.tsx:344
<TabsContent value="demographics" className="pt-4">
  <DemographicBreakdownChart
    data={demographic.data}
```

MER page first-load queries:

```ts
// src/app/(protected)/mer/page.tsx:71
const stats = useQuery(trpc.adCreative.dashboardStats.queryOptions({ ... }));

// src/app/(protected)/mer/page.tsx:80
const dailyPerf = useQuery(trpc.adCreative.getDailyPortfolioPerformance.queryOptions({ ... }));

// src/app/(protected)/mer/page.tsx:89
const breakdown = useQuery(trpc.adCreative.getMerAccountBreakdown.queryOptions({ ... }));
```

MER only uses `stats` above the fold for `portfolio` and later for `bottomPerformers`:

```ts
// src/app/(protected)/mer/page.tsx:98
const portfolio = stats.data?.portfolio;
const bottomPerformers = stats.data?.bottomPerformers ?? [];
```

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts` | exit 0 |
| Full tests | `bun test` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Build | `bun run build` | exit 0 |
| Manual dev check | `bun dev` | Next.js starts on port 3000 |

## Scope

**In scope**:

- `src/app/(protected)/(dashboard)/page.tsx`
- `src/app/(protected)/mer/page.tsx`
- `src/lib/trpc/routers/ad-creative.ts`
- `src/lib/trpc/routers/ad-creative.analytics.test.ts`
- `plans/README.md` status update

**Out of scope**:

- Removing existing tRPC procedures.
- Changing leaderboard formulas.
- Changing chart UI.
- Adding server components or SSR prefetch.

## Git workflow

- Branch: `lone/004-defer-first-load-analytics`
- Commit message: `perf(dashboard): defer hidden analytics queries`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Gate overview tab queries by active tab

In `src/app/(protected)/(dashboard)/page.tsx`, change `dailyPerf` and `demographic` calls to object-style `useQuery` so `enabled` can be set:

```ts
const dailyPerf = useQuery({
  ...trpc.adCreative.getDailyPortfolioPerformance.queryOptions({ ... }),
  enabled: tab === "charts",
});
```

```ts
const demographic = useQuery({
  ...trpc.performanceLog.demographicBreakdown.queryOptions({ ... }),
  enabled: tab === "demographics",
});
```

Keep `stats` enabled on first load because the default overview tab needs KPIs and leaderboards.

**Verify**: `bun run lint` -> exit 0.

### Step 2: Add a lightweight portfolio summary query

In `src/lib/trpc/routers/ad-creative.ts`, add a new procedure, for example `portfolioSummary`, with the same core filters used by `dashboardStats`:

- `days`
- `from`
- `to`
- `accountId`
- `campaignIds`
- `adSetIds`
- `statuses`
- `ownership`
- `teamId`

Move or copy the portfolio SQL from `dashboardStats` into a private helper so both `dashboardStats` and `portfolioSummary` use exactly the same formula:

```ts
sum(pl.spend)::text as total_spend,
sum(pl.purchase_value)::text as total_purchase_value,
(coalesce(sum(pl.purchase_value), 0) / nullif(sum(pl.spend), 0))::text as portfolio_roas,
(coalesce(sum(pl.spend), 0) / nullif(sum(pl.conversions), 0))::text as portfolio_cpa,
avg(pl.ctr)::text as portfolio_ctr,
sum(pl.conversions)::text as total_conversions
```

Return the same `portfolio` object shape that `dashboardStats` returns.

**Verify**: add/update analytics tests so `portfolioSummary` and `dashboardStats(...).portfolio` map the same queued portfolio row. Run `bun test src/lib/trpc/routers/ad-creative.analytics.test.ts -t portfolio` -> exit 0.

### Step 3: Update MER page to use portfolio summary for KPIs

In `src/app/(protected)/mer/page.tsx`, replace the first-load KPI dependency on `dashboardStats` with `portfolioSummary`.

Keep `dailyPerf` and `breakdown` on first load because the visible MER page shows chart and account table immediately.

For Needs Attention, keep using `dashboardStats` but defer it until after the first browser paint. A simple approach:

```ts
const [loadSecondary, setLoadSecondary] = useState(false);
useEffect(() => setLoadSecondary(true), []);
const secondaryStats = useQuery({
  ...trpc.adCreative.dashboardStats.queryOptions({ ... }),
  enabled: loadSecondary,
});
const bottomPerformers = secondaryStats.data?.bottomPerformers ?? [];
```

Import `useEffect` from React. Make sure KPI loading state uses the portfolio summary query, while the Needs Attention table uses the deferred query.

**Verify**: `bun run lint` -> exit 0.

### Step 4: Manual first-load network check

Run `bun dev`, open browser devtools Network tab, and load `/` with no `tab` query parameter. Confirm the initial tRPC batch does not include:

- `adCreative.getDailyPortfolioPerformance`
- `performanceLog.demographicBreakdown`

Then click Charts and Demographics tabs and confirm each query fires only when its tab is selected.

Load `/mer`. Confirm the first tRPC batch includes `adCreative.portfolioSummary`, `adCreative.getDailyPortfolioPerformance`, and `adCreative.getMerAccountBreakdown`, and that `adCreative.dashboardStats` fires only after the first render for Needs Attention.

**Verify**: no console errors and the visible KPI/chart/table content renders.

## Test plan

- Add a `portfolioSummary` test in `ad-creative.analytics.test.ts`.
- Existing `dashboardStats` tests must still pass.
- Manual network verification is required because the main win is query timing in React Query.

## Done criteria

- [ ] Default dashboard overview no longer fetches chart or demographic queries until those tabs are active.
- [ ] MER KPI rail no longer depends on full `dashboardStats`.
- [ ] Existing `dashboardStats`, `getDailyPortfolioPerformance`, and `getMerAccountBreakdown` endpoints remain available.
- [ ] Focused analytics tests pass.
- [ ] `bun test`, `bun run lint`, and `bun run build` exit 0.
- [ ] Manual dev check confirms query timing.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- `portfolioSummary` cannot share the exact portfolio formula with `dashboardStats`.
- Gating hidden tab queries causes blank or stale content when opening with `?tab=charts` or `?tab=demographics`.
- Deferring Needs Attention on MER causes layout instability that cannot be fixed inside `src/app/(protected)/mer/page.tsx`.
- Any existing public endpoint must be removed to complete the plan.

## Maintenance notes

The rule after this plan: hidden tab content should not fetch heavyweight analytics on default first load. Reviewers should inspect query `enabled` conditions and make sure future dashboard tabs follow the same pattern.
