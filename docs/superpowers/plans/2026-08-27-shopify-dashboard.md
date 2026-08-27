# Shopify Summary Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shopify-style summary (Total Sales / Orders / Average Order / Refunds cards + a Total Sales chart) at the top of the `/` dashboard, and the nav renamed "Shopify Dashboard".

**Architecture:** Two new read helpers in `attribution-queries.ts` (refund totals, hourly sales) exposed as two new `attribution` router procedures; one new `ShopifySummary` client component owns those queries plus the existing `dailySeries`, while sales/order counts arrive as props from the page's existing `overview` query. No schema changes, no migrations.

**Tech Stack:** Next.js App Router, tRPC + React Query, Drizzle (Postgres), Recharts via `ChartContainer`, Vitest (`bun run test` unit+integration / `bun run test:components` jsdom).

**Spec:** `docs/superpowers/specs/2026-08-27-shopify-dashboard-design.md`
**Branch:** `feat/shopify-dashboard` (exists, based on `main`; spec commits are on it).

**Conventions you must know:**
- Money crosses the wire as decimal strings; `toCents` (`@/lib/money`) for arithmetic, `centsToAmount` back to strings, `formatMoneyExact` (attribution `format.ts`) to print.
- Component tests are `*.component.test.tsx` (`bun run test:components`); unit/integration are `*.test.ts` (`bun run test`). Never plain `bun test`.
- `attribution-queries.test.ts` ends with a real-Postgres integration `describe` (`describeWithDb`) with its own throwaway DB, DDL fixtures, and row seeders — extend it, don't build new scaffolding.
- Icons from `@/components/icons` only. Copy strings live in the attribution `copy.ts` (plain-voice contract: "no data yet", never a fake `$0`).
- `shopify_order.order_created_at` is a naive timestamp storing UTC; the store-local hour needs the double conversion `(col AT TIME ZONE 'utc') AT TIME ZONE <iana>`.

---

### Task 1: Query helpers — `getRefundsTotal` + `getHourlySales`

**Files:**
- Modify: `src/lib/attribution-queries.ts`
- Test: `src/lib/attribution-queries.test.ts` (extend the existing integration `describe`)

- [ ] **Step 1: Write the failing integration tests**

In `src/lib/attribution-queries.test.ts`:

(a) Add the two new names to the existing import block from `./attribution-queries` (which already imports `getMetaClaims` etc.):

```ts
  getHourlySales,
  getRefundsTotal,
```

(b) Inside the `describeWithDb("grouped-by-day reads agree with the per-day reads", …)` block, extend the `order` seeder with an optional `createdAt` so the hourly test can place orders on the clock. Replace the existing `order` function with:

```ts
  async function order(params: {
    id: string;
    day: string;
    netSales: string;
    bucket?: string | null;
    metaVerified?: boolean;
    verificationPending?: boolean;
    storeId?: string;
    organizationId?: string;
    createdAt?: string;
  }) {
    await testDb?.execute(sql`
      INSERT INTO shopify_order (
        id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales, bucket, meta_verified, verification_pending
      ) VALUES (
        ${params.id}, ${params.organizationId ?? ORG}, ${params.storeId ?? STORE},
        ${params.id}, ${params.createdAt ?? "2026-08-10T04:00:00Z"},
        ${params.day}, ${params.netSales},
        ${(params.bucket ?? "meta") as string}::"attribution_bucket",
        ${params.metaVerified ?? true}, ${params.verificationPending ?? false}
      )
    `);
  }
```

(The default `createdAt` keeps every existing call site valid — the column already has a `DEFAULT now()` in the fixture DDL, so old assertions are unaffected either way.)

(c) At the bottom of the same `describeWithDb` block, add:

```ts
  describe("getRefundsTotal", () => {
    it("sums refunds of every kind whose refund day is in range", async () => {
      await order({ id: "o-r1", day: "2026-08-10", netSales: "300.00" });
      await refund({ orderId: "o-r1", day: "2026-08-11", amount: "40.00" });
      await refund({ orderId: "o-r1", day: "2026-08-12", amount: "10.50" });
      // Outside the queried range — must not count.
      await refund({ orderId: "o-r1", day: "2026-08-16", amount: "99.00" });

      const result = await getRefundsTotal({
        organizationId: ORG,
        storeId: STORE,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-13",
      });

      expect(result.refundedCents).toBe(5_050);
      expect(result.count).toBe(2);
    });

    it("returns zeros for a range with no refunds", async () => {
      const result = await getRefundsTotal({
        organizationId: ORG,
        storeId: STORE,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-13",
      });
      expect(result.refundedCents).toBe(0);
      expect(result.count).toBe(0);
    });
  });

  describe("getHourlySales", () => {
    it("buckets a day's orders by store-clock hour, zero-filled to 24 rows", async () => {
      // 23:30 Bangkok on Aug 10 = 16:30 UTC; belongs to hour 23 of Aug 10.
      await order({
        id: "o-h1",
        day: "2026-08-10",
        netSales: "100.00",
        createdAt: "2026-08-10T16:30:00Z",
      });
      // 00:10 Bangkok on Aug 11 (17:10 UTC Aug 10): a different order day —
      // excluded even though its UTC timestamp is still Aug 10.
      await order({
        id: "o-h2",
        day: "2026-08-11",
        netSales: "50.00",
        createdAt: "2026-08-10T17:10:00Z",
      });
      // 09:00 Bangkok on Aug 10 (02:00 UTC), plus a second order same hour.
      await order({
        id: "o-h3",
        day: "2026-08-10",
        netSales: "20.00",
        createdAt: "2026-08-10T02:00:00Z",
      });
      await order({
        id: "o-h4",
        day: "2026-08-10",
        netSales: "5.00",
        createdAt: "2026-08-10T02:45:00Z",
      });

      const hours = await getHourlySales({
        organizationId: ORG,
        storeId: STORE,
        day: "2026-08-10",
        timeZone: "Asia/Bangkok",
      });

      expect(hours).toHaveLength(24);
      expect(hours[23]).toEqual({ hour: 23, netCents: 10_000, orders: 1 });
      expect(hours[9]).toEqual({ hour: 9, netCents: 2_500, orders: 2 });
      expect(hours[0]).toEqual({ hour: 0, netCents: 0, orders: 0 });
      expect(hours.reduce((sum, h) => sum + h.netCents, 0)).toBe(12_500);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/lib/attribution-queries.test.ts`
Expected: FAIL — `getRefundsTotal` / `getHourlySales` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/attribution-queries.ts`, below `getBucketTotals` (which shows the house refund-sum idiom and already provides `refundRangeWhere(scope)`):

```ts
/**
 * Refunds of every kind whose refund day lands in the range — the same rows
 * (and the same `refundRangeWhere`) the ledger nets out of gross sales, so
 * the Refunds card always agrees with the tie-out.
 */
export async function getRefundsTotal(
  scope: StoreScope,
): Promise<{ refundedCents: number; count: number }> {
  const [row] = await db
    .select({
      refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(shopifyRefunds)
    .where(refundRangeWhere(scope));

  return { refundedCents: toCents(row?.refunded ?? "0"), count: row?.count ?? 0 };
}

/**
 * One store-day's orders bucketed by the hour they were placed, on the store's
 * clock. `order_created_at` is a naive UTC timestamp, so the wall-clock hour
 * needs the double conversion; the day filter is the already-stamped
 * `order_day`, keeping "which orders belong to the day" identical to every
 * other read. Always 24 rows, zero-filled.
 */
export async function getHourlySales(params: {
  organizationId: string;
  storeId: string;
  day: string;
  timeZone: string;
}): Promise<Array<{ hour: number; netCents: number; orders: number }>> {
  const hourExpression = sql<number>`extract(hour from ((${shopifyOrders.orderCreatedAt} at time zone 'utc') at time zone ${params.timeZone}))::int`;
  const rows = await db
    .select({
      hour: hourExpression,
      net: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      orders: sql<number>`count(*)::int`,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, params.organizationId),
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.orderDay, params.day),
      ),
    )
    .groupBy(hourExpression);

  const byHour = new Map(rows.map((row) => [row.hour, row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour);
    return {
      hour,
      netCents: row ? toCents(row.net) : 0,
      orders: row?.orders ?? 0,
    };
  });
}
```

(`StoreScope`, `shopifyRefunds`, `shopifyOrders`, `toCents`, `and`, `eq`, and `sql` are all already imported/defined in this file — verify rather than re-import.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- src/lib/attribution-queries.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/attribution-queries.ts src/lib/attribution-queries.test.ts
git commit -m "feat(attribution): refund totals and hourly sales reads"
```

---

### Task 2: Router procedures — `refundsTotal` + `hourlySeries`

**Files:**
- Modify: `src/lib/trpc/routers/attribution.ts`

- [ ] **Step 1: Add the procedures**

(a) Extend the import from `@/lib/attribution-queries` with `getHourlySales, getRefundsTotal` (alphabetical position in the existing list).

(b) Next to the other output schemas near the top:

```ts
const refundsTotalOutputSchema = z.object({
  range: rangeSchema,
  total: z.string(),
  count: z.number().int(),
});

const hourlySeriesOutputSchema = z.object({
  day: z.string(),
  hours: z.array(
    z.object({
      hour: z.number().int(),
      net: z.string(),
      orders: z.number().int(),
    }),
  ),
});
```

(c) In the router, after `dailySeries`:

```ts
  refundsTotal: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "refundsTotal",
        "Refund total for a range",
        "Sum and count of Shopify refunds (all kinds) whose refund day falls in the range.",
      ),
    )
    .input(dateRangeSchema)
    .output(refundsTotalOutputSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);
      const refunds = await getRefundsTotal({
        organizationId: ctx.organizationId,
        storeId: store.id,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      });
      return {
        range: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        total: centsToAmount(refunds.refundedCents),
        count: refunds.count,
      };
    }),

  hourlySeries: orgProcedure
    .meta(
      openApiQueryMeta(
        "attribution",
        "hourlySeries",
        "Hourly net sales for one day",
        "One store-day's net sales bucketed by the hour orders were placed, on the store's clock. 24 zero-filled rows.",
      ),
    )
    .input(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .output(hourlySeriesOutputSchema)
    .query(async ({ input, ctx }) => {
      const store = await requireStore(ctx.organizationId);
      const hours = await getHourlySales({
        organizationId: ctx.organizationId,
        storeId: store.id,
        day: input.day,
        timeZone: store.ianaTimezone,
      });
      return {
        day: input.day,
        hours: hours.map((row) => ({
          hour: row.hour,
          net: centsToAmount(row.netCents),
          orders: row.orders,
        })),
      };
    }),
```

Check `rangeSchema` is the name the file's other output schemas use for the `{dateFrom, dateTo}` shape (it is used by `dailySeriesOutputSchema`); if the actual identifier differs, match the file. Confirm `store.ianaTimezone` exists on the `requireStore` result (the shared helper returns the `shopify_store` row, which has `iana_timezone`).

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/trpc/routers/attribution.ts
git commit -m "feat(attribution): refundsTotal and hourlySeries procedures"
```

---

### Task 3: `ShopifySummary` component + copy + component test

**Files:**
- Create: `src/components/blocks/attribution/shopify-summary.tsx`
- Create: `src/components/blocks/attribution/shopify-summary.component.test.tsx`
- Modify: `src/components/blocks/attribution/copy.ts`

- [ ] **Step 1: Add the copy**

In `src/components/blocks/attribution/copy.ts`, after the `headerRail` export:

```ts
/**
 * The Shopify-style summary above the ledger: the store's own reading of the
 * range, before any attribution. Figures come from the same orders the ledger
 * ties out, so the two never disagree.
 */
export const shopifySummary = {
  totalSales: "Total sales",
  orders: "Orders",
  averageOrder: "Average order",
  refunds: "Refunds",
  refundCount: (count: number) =>
    `${formatCount(count)} ${count === 1 ? "refund" : "refunds"}`,
  chartTitle: "Total sales",
  error: "The sales summary didn't load.",
  retry: "Try again",
};
```

- [ ] **Step 2: Write the failing component test**

Create `src/components/blocks/attribution/shopify-summary.component.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifySummary } from "./shopify-summary";

const queryState = vi.hoisted(() => ({
  refundsFn: (): Promise<unknown> => Promise.resolve(null),
  dailyFn: (): Promise<unknown> => Promise.resolve(null),
  hourlyFn: vi.fn((): Promise<unknown> => Promise.resolve(null)),
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    attribution: {
      refundsTotal: {
        queryOptions: (input: unknown) => ({
          queryKey: ["refundsTotal", input],
          queryFn: queryState.refundsFn,
          retry: false,
        }),
      },
      dailySeries: {
        queryOptions: (input: unknown) => ({
          queryKey: ["dailySeries", input],
          queryFn: queryState.dailyFn,
          retry: false,
        }),
      },
      hourlySeries: {
        queryOptions: (input: unknown) => ({
          queryKey: ["hourlySeries", input],
          queryFn: queryState.hourlyFn,
          retry: false,
        }),
      },
    },
  }),
}));

function refunds() {
  return {
    range: { dateFrom: "2026-08-20", dateTo: "2026-08-26" },
    total: "45.50",
    count: 2,
  };
}

function daily() {
  return {
    range: { dateFrom: "2026-08-20", dateTo: "2026-08-26" },
    days: [
      { day: "2026-08-20", buckets: {}, pendingNet: "0.00", totalNet: "100.00" },
      { day: "2026-08-21", buckets: {}, pendingNet: "0.00", totalNet: "250.00" },
    ],
  };
}

function hourly() {
  return {
    day: "2026-08-26",
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      net: hour === 9 ? "80.00" : "0.00",
      orders: hour === 9 ? 2 : 0,
    })),
  };
}

function summary(overrides: {
  dateFrom?: string;
  dateTo?: string;
  total?: string | null;
  orderCount?: number;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ShopifySummary
        dateFrom={overrides.dateFrom ?? "2026-08-20"}
        dateTo={overrides.dateTo ?? "2026-08-26"}
        currency="USD"
        total={overrides.total === undefined ? "350.00" : overrides.total}
        orderCount={overrides.orderCount ?? 5}
        loading={false}
      />
    </QueryClientProvider>,
  );
}

describe("ShopifySummary", () => {
  beforeEach(() => {
    queryState.refundsFn = () => Promise.resolve(refunds());
    queryState.dailyFn = () => Promise.resolve(daily());
    queryState.hourlyFn = vi.fn(() => Promise.resolve(hourly()));
  });

  it("shows the four cards with derived average order", async () => {
    summary();
    expect(screen.getByText("Total sales")).toBeInTheDocument();
    expect(screen.getByText("$350.00")).toBeInTheDocument();
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    // 350.00 / 5
    expect(screen.getByText("$70.00")).toBeInTheDocument();
    expect(await screen.findByText("$45.50")).toBeInTheDocument();
    expect(screen.getByText("2 refunds")).toBeInTheDocument();
  });

  it("wears the no-data chip instead of a fake $0 average when there are no orders", () => {
    summary({ total: "0.00", orderCount: 0 });
    const averageCard = screen.getByText("Average order").parentElement!;
    expect(averageCard).toHaveTextContent("no data yet");
    expect(averageCard).not.toHaveTextContent("$");
  });

  it("multi-day range charts the daily series and never asks for hours", async () => {
    summary();
    expect(await screen.findByTestId("shopify-sales-chart")).toBeInTheDocument();
    expect(queryState.hourlyFn).not.toHaveBeenCalled();
  });

  it("single-day range charts by hour", async () => {
    summary({ dateFrom: "2026-08-26", dateTo: "2026-08-26" });
    expect(await screen.findByTestId("shopify-sales-chart")).toBeInTheDocument();
    expect(queryState.hourlyFn).toHaveBeenCalled();
  });

  it("a chart error keeps the cards and offers a retry", async () => {
    queryState.dailyFn = () => Promise.reject(new Error("nope"));
    summary();
    expect(
      await screen.findByText("The sales summary didn't load."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText("$350.00")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test:components -- src/components/blocks/attribution/shopify-summary.component.test.tsx`
Expected: FAIL — cannot resolve `./shopify-summary`.

- [ ] **Step 4: Implement the component**

Create `src/components/blocks/attribution/shopify-summary.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toCents } from "@/lib/money";
import { useTRPC } from "@/lib/trpc/client";
import { page, shopifySummary as copy } from "./copy";
import { formatMoneyExact } from "./format";

const chartConfig: ChartConfig = {
  net: { label: "Total sales", color: "var(--chart-1)" },
};

function Card({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: string | null;
  caption?: string | null;
  tone?: "refund";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card px-3 py-2.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/55">
        {label}
      </span>
      {value === null ? (
        <span className="inline-flex w-fit items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground/80">
          {page.noDataYet}
        </span>
      ) : (
        <span
          className="text-[20px] font-semibold tabular-nums leading-none tracking-tight"
          style={tone === "refund" ? { color: "var(--attr-warning)" } : undefined}
        >
          {value}
        </span>
      )}
      {caption ? (
        <span className="text-[10px] text-muted-foreground/60">{caption}</span>
      ) : null}
    </div>
  );
}

/**
 * The store's own reading of the range, Shopify-style, above the attribution
 * ledger: what came in, in how many orders, at what average, less what went
 * back — and the curve of it. Sales and order counts arrive from the page's
 * `overview` query so the cards can never disagree with the ledger below.
 */
export function ShopifySummary({
  dateFrom,
  dateTo,
  currency,
  total,
  orderCount,
  loading,
}: {
  dateFrom: string;
  dateTo: string;
  currency: string;
  total: string | null;
  orderCount: number;
  loading: boolean;
}) {
  const trpc = useTRPC();
  const singleDay = dateFrom === dateTo;

  const refunds = useQuery(
    trpc.attribution.refundsTotal.queryOptions({ dateFrom, dateTo }),
  );
  const dailySeries = useQuery({
    ...trpc.attribution.dailySeries.queryOptions({ dateFrom, dateTo }),
    enabled: !singleDay,
  });
  const hourlySeries = useQuery({
    ...trpc.attribution.hourlySeries.queryOptions({ day: dateFrom }),
    enabled: singleDay,
  });

  const totalCents = total !== null ? toCents(total) : null;
  const averageOrder =
    totalCents !== null && orderCount > 0
      ? formatMoneyExact((totalCents / orderCount / 100).toFixed(2), currency)
      : null;

  const series = singleDay ? hourlySeries : dailySeries;
  const chartData = singleDay
    ? (hourlySeries.data?.hours ?? []).map((row) => ({
        label: `${String(row.hour).padStart(2, "0")}:00`,
        net: toCents(row.net) / 100,
      }))
    : (dailySeries.data?.days ?? []).map((row) => ({
        label: row.day.slice(5).replace("-", "/"),
        net: toCents(row.totalNet) / 100,
      }));

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[74px] w-full rounded-md" />
          ))
        ) : (
          <>
            <Card
              label={copy.totalSales}
              value={total !== null ? formatMoneyExact(total, currency) : null}
            />
            <Card
              label={copy.orders}
              value={String(orderCount)}
            />
            <Card label={copy.averageOrder} value={averageOrder} />
            <Card
              label={copy.refunds}
              value={
                refunds.data ? formatMoneyExact(refunds.data.total, currency) : null
              }
              caption={refunds.data ? copy.refundCount(refunds.data.count) : null}
              tone="refund"
            />
          </>
        )}
      </div>

      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
          {copy.chartTitle}
        </span>
        {series.isPending || loading ? (
          <Skeleton className="mt-2 h-[220px] w-full" />
        ) : series.isError ? (
          <p className="py-8 text-center text-[11px] text-muted-foreground">
            {copy.error}{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void series.refetch()}
            >
              {copy.retry}
            </Button>
          </p>
        ) : (
          <div data-testid="shopify-sales-chart" className="mt-1">
            <ChartContainer config={chartConfig} className="aspect-[5/1] w-full">
              <AreaChart
                data={chartData}
                margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="fill-shopify-net" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-net)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--color-net)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={50} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                <Area
                  type="monotone"
                  dataKey="net"
                  stroke="var(--color-net)"
                  strokeWidth={2}
                  fill="url(#fill-shopify-net)"
                />
              </AreaChart>
            </ChartContainer>
          </div>
        )}
      </div>
    </div>
  );
}
```

Verify `--attr-warning` is the CSS variable the attribution screens use for warning tones (it appears in `detail-folds.tsx`/`ledger` styles); if the actual token differs, match it. If `var(--chart-1)` isn't defined in this app's theme, use a literal color from the existing chart palette (`hsl(160, 84%, 39%)` — the green PerformanceChart uses for ROAS).

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test:components -- src/components/blocks/attribution/shopify-summary.component.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/blocks/attribution/shopify-summary.tsx src/components/blocks/attribution/shopify-summary.component.test.tsx src/components/blocks/attribution/copy.ts
git commit -m "feat(attribution): Shopify-style summary cards and sales chart"
```

---

### Task 4: Page wiring + "Shopify Dashboard" rename

**Files:**
- Modify: `src/app/(protected)/(dashboard)/page.tsx`
- Modify: `src/components/blocks/attribution/copy.ts` (navLabel)
- Modify: `src/components/app-sidebar.tsx`

- [ ] **Step 1: Render the block on `/`**

In `src/app/(protected)/(dashboard)/page.tsx`:

(a) Add the import:

```tsx
import { ShopifySummary } from "@/components/blocks/attribution/shopify-summary";
```

(b) Between the `FirstLoadProgress` block and the ledger `<section>` (i.e. immediately before the `{/* The ledger: … */}` comment), insert:

```tsx
      {range ? (
        <ShopifySummary
          dateFrom={range.dateFrom}
          dateTo={range.dateTo}
          currency={currency}
          total={data?.total ?? null}
          orderCount={orderCount}
          loading={overview.isPending}
        />
      ) : null}
```

(`range`, `currency`, `data`, `orderCount`, and `overview` all already exist in the component — verify against the file rather than re-deriving.)

- [ ] **Step 2: Rename the nav**

(a) `src/components/blocks/attribution/copy.ts`, in the `page` export: `navLabel: "Dashboard",` → `navLabel: "Shopify Dashboard",` (leave the doc comment truthful — adjust its wording if it still says the label reads "Dashboard").

(b) `src/components/app-sidebar.tsx`, in the Dashboard collapsible: `tooltip="Dashboard"` → `tooltip="Shopify Dashboard"` and `<span>Dashboard</span>` → `<span>Shopify Dashboard</span>`.

- [ ] **Step 3: Verify**

Run: `bun run lint && bunx tsc --noEmit && bun run test:components && bun run test`
Expected: lint 0 errors (baseline warnings in unrelated files are fine), tsc clean, all suites green.

Run: `rm -rf .next && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(protected)/(dashboard)/page.tsx" src/components/blocks/attribution/copy.ts src/components/app-sidebar.tsx
git commit -m "feat: Shopify summary tops the dashboard, nav renamed Shopify Dashboard"
```

---

### Task 5: Final verification, push, PR body

- [ ] **Step 1: Full pass**

```bash
bun run lint && bun run test && bun run test:components && rm -rf .next && bun run build
```

Expected: all green. (A known flaky DB-contention integration test occasionally fails in the full run — rerun the single file to confirm it passes in isolation before blaming the change.)

- [ ] **Step 2: Manual smoke (bun dev)**

- `/` shows: cards row (Total sales / Orders / Average order / Refunds) + Total sales chart above the existing ledger card; breadcrumb reads "Shopify Dashboard".
- Default "Yesterday" range → hourly chart (24 points); "Last 7 days" → daily chart.
- Zero-order range → Average order shows the "no data yet" chip.
- Sidebar first entry reads "Shopify Dashboard"; its dropdown children unchanged.

- [ ] **Step 3: Push and write the PR body**

```bash
git push -u origin feat/shopify-dashboard
```

Then write `rands/pr-body-shopify-dashboard.md` in the same format as `rands/pr-body-meta-charts-mer.md`: compare URL `https://github.com/noelrohi/creatives-tracker/compare/main...feat/shopify-dashboard`, title `feat: Shopify summary on the root dashboard`, body covering the four cards (refunds instead of unsynced discounts), the hourly-vs-daily chart behavior, the rename, the timezone audit outcome (resolved as no-op — see the spec's §4), a `TODO(@you)` screenshots line, and the checklist with **Contains DB migrations? No**.
