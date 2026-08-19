# Attribution Becomes the Main Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the attribution view the app's home page at `/`, move the old Meta dashboard to `/meta`, and merge each source's revenue panel + a dashboard/lab button into that source's ledger drawer.

**Architecture:** The attribution page file physically moves into the `(dashboard)` route group; the old dashboard moves to a new `/meta` route; `/attribution` becomes a redirect stub. A new `SourceDrawer` component owns a per-bucket registry (panel + action button) and wraps the existing `BucketOrdersPanel`. A new `MetaRevenuePanel` reuses the existing `attribution.metaCheck` and `attribution.campaignLedger` tRPC queries (React Query dedupes them against the page's own queries — zero extra requests). The `attribution` feature flag is retired.

**Tech Stack:** Next.js 16 App Router, React 19, tRPC + React Query, Tailwind v4, Vitest (`bun run test` unit / `bun run test:components` jsdom component tests).

**Spec:** `docs/superpowers/specs/2026-08-19-attribution-dashboard-design.md`

**Branch:** `feat/attribution-dashboard` (already created from `origin/main`; the spec commit is on it).

**Conventions you must know:**
- Icons come from `@/components/icons` (Solar via iconify, re-exported under Lucide names). `lucide-react` is blocked by lint.
- Component tests are `*.component.test.tsx`, run by `bun run test:components` (jsdom, config `vitest.components.config.ts`). Unit tests run with `bun run test`. Never `bun test` (wrong runner).
- Copy strings live in `copy.ts` files next to the components; components import them as `{ x as copy }`.
- Money figures are decimal strings (`"1200.00"`); `toCents` from `@/lib/money` converts for arithmetic; `formatMoneyExact` from `@/components/blocks/attribution/format` prints them.

---

### Task 1: MetaRevenuePanel component

The Meta drawer's panel: the "Meta check" figures (already computed by `attribution.metaCheck`), a share bar against the Shopify total, and the campaign ledger table. Visible to **all roles** (the fold it replaces was), unlike the privileged Google/Klaviyo panels.

**Files:**
- Create: `src/components/blocks/attribution/meta/revenue-panel.tsx`
- Create: `src/components/blocks/attribution/meta/revenue-panel.component.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `src/components/blocks/attribution/meta/revenue-panel.component.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaRevenuePanel } from "./revenue-panel";

const queryState = vi.hoisted(() => ({
  metaCheckFn: (): Promise<unknown> => Promise.resolve(null),
  campaignLedgerFn: (): Promise<unknown> => Promise.resolve(null),
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    attribution: {
      metaCheck: {
        queryOptions: (input: unknown) => ({
          queryKey: ["metaCheck", input],
          queryFn: queryState.metaCheckFn,
          retry: false,
        }),
      },
      campaignLedger: {
        queryOptions: (input: unknown) => ({
          queryKey: ["campaignLedger", input],
          queryFn: queryState.campaignLedgerFn,
          retry: false,
        }),
      },
    },
  }),
}));

/** Mirrors the `attribution.metaCheck` router output shape. */
function metaCheck() {
  return {
    range: { dateFrom: "2026-08-01", dateTo: "2026-08-07" },
    claims: {
      claimed: "1200.00",
      claimed7dClick: "900.00",
      claimed1dView: "300.00",
      labeledRowShare: 1,
    },
    spend: "400.00",
    verifiedRevenue: "800.00",
    verifiedOrderCount: 12,
    verificationPendingCount: 0,
    verifiedRoas: "2.00",
    roasTarget: "3.00",
  };
}

/** Mirrors the `attribution.campaignLedger` router output shape. */
function campaignLedger() {
  return {
    range: { dateFrom: "2026-08-01", dateTo: "2026-08-07" },
    campaigns: [
      {
        campaignId: "c-1",
        name: "Prospecting US",
        spend: "300.00",
        claimed: "900.00",
        confirmedRevenue: "600.00",
        orderCount: 9,
        roas: "2.00",
      },
    ],
    unresolved: null,
    roasTarget: "3.00",
  };
}

function renderPanel(overrides: { metaDown?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MetaRevenuePanel
        dateFrom="2026-08-01"
        dateTo="2026-08-07"
        currency="USD"
        metaDown={overrides.metaDown ?? false}
        detailHref="/mer?from=2026-08-01&to=2026-08-07"
        shopifyTotal="2000.00"
      />
    </QueryClientProvider>,
  );
}

describe("MetaRevenuePanel", () => {
  beforeEach(() => {
    queryState.metaCheckFn = () => Promise.resolve(metaCheck());
    queryState.campaignLedgerFn = () => Promise.resolve(campaignLedger());
  });

  it("shows the Meta check figures, share bar, and campaign table", async () => {
    renderPanel();
    expect(await screen.findByText("Spent on Meta")).toBeInTheDocument();
    expect(screen.getByText("The Meta check")).toBeInTheDocument();
    expect(screen.getByText("Campaign by campaign")).toBeInTheDocument();
    expect(await screen.findByText("Prospecting US")).toBeInTheDocument();
    expect(screen.getByTestId("meta-confirmed-share")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "See Meta vs Shopify →" }),
    ).toHaveAttribute("href", "/mer?from=2026-08-01&to=2026-08-07");
  });

  it("drops Meta's own claims while the connection is down", async () => {
    renderPanel({ metaDown: true });
    // "We can confirm" survives a Meta outage; the claim sentence does not.
    expect(
      await screen.findByText("We can confirm in Shopify"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Meta says its ads made \$/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:components -- src/components/blocks/attribution/meta/revenue-panel.component.test.tsx`
Expected: FAIL — cannot resolve `./revenue-panel` (file does not exist yet).

- [ ] **Step 3: Implement the panel**

Create `src/components/blocks/attribution/meta/revenue-panel.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { CampaignTable } from "@/components/blocks/attribution/campaign-table";
import { bucketColor } from "@/components/blocks/attribution/colors";
import {
  campaigns as campaignCopy,
  metaCheck as copy,
} from "@/components/blocks/attribution/copy";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { MetaCheckDetail } from "@/components/blocks/attribution/meta-check-card";
import { toCents } from "@/lib/money";
import { useTRPC } from "@/lib/trpc/client";

/** Width helper for the share bar; ratio of cents, display-only. */
function widthPercent(partCents: number, totalCents: number): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  return Math.min(100, Math.max(0, (partCents / totalCents) * 100));
}

/**
 * The Meta drawer's reading: the same `metaCheck` figures and campaign ledger
 * the two folds used to show, under one panel. Visible to every role — there
 * is no privileged data here, unlike the Google and Klaviyo panels. The
 * queries duplicate the page's own `metaCheck`/`campaignLedger` calls by
 * design: React Query dedupes on the key, so opening the drawer costs nothing.
 */
export function MetaRevenuePanel({
  dateFrom,
  dateTo,
  currency,
  metaDown,
  detailHref,
  shopifyTotal,
}: {
  dateFrom: string;
  dateTo: string;
  currency: string;
  metaDown: boolean;
  detailHref: string;
  shopifyTotal: string | null;
}) {
  const trpc = useTRPC();
  const metaCheck = useQuery(
    trpc.attribution.metaCheck.queryOptions({ dateFrom, dateTo }),
  );
  const campaigns = useQuery(
    trpc.attribution.campaignLedger.queryOptions({ dateFrom, dateTo }),
  );

  const confirmedCents = metaCheck.data
    ? toCents(metaCheck.data.verifiedRevenue)
    : 0;
  const totalCents = shopifyTotal !== null ? toCents(shopifyTotal) : 0;
  const confirmedWidth = widthPercent(confirmedCents, totalCents);
  const confirmedMoney = metaCheck.data
    ? formatMoneyExact(metaCheck.data.verifiedRevenue, currency)
    : null;

  return (
    <section className="rounded-md border border-border bg-card px-3 py-3 sm:px-4">
      <h2 className="mb-2.5 text-[13px] font-semibold tracking-tight">
        {copy.title}
      </h2>
      <div className="flex flex-col gap-4">
        <MetaCheckDetail
          data={metaCheck.data}
          loading={metaCheck.isPending}
          metaDown={metaDown}
          currency={currency}
          detailHref={detailHref}
        />
        {metaCheck.data && shopifyTotal !== null ? (
          <div>
            <div
              className="flex h-5 overflow-hidden rounded"
              data-testid="meta-confirmed-share"
            >
              <div
                style={{
                  width: `${confirmedWidth}%`,
                  backgroundColor: bucketColor("meta"),
                }}
              />
              <div className="flex-1 bg-muted" />
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
              <span>
                <span
                  className="mr-1 inline-block size-2 rounded-[2px]"
                  style={{ backgroundColor: bucketColor("meta") }}
                />
                {copy.weConfirmLabel} {confirmedMoney}
              </span>
            </div>
          </div>
        ) : null}
        <div>
          <h3 className="mb-1.5 text-[12px] font-semibold">
            {campaignCopy.title}
          </h3>
          <CampaignTable
            data={campaigns.data}
            loading={campaigns.isPending}
            metaDown={metaDown}
            currency={currency}
          />
        </div>
      </div>
    </section>
  );
}
```

Notes for the implementer:
- `MetaCheckDetail` (from `../meta-check-card`) already renders the three figures, the claim/payback sentences, the pending note, the footnote, and the "See Meta vs Shopify →" link — do not re-implement any of it.
- `CampaignTable` (from `../campaign-table`) already handles its own loading skeletons, the unresolved row, and phone-width scrolling.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:components -- src/components/blocks/attribution/meta/revenue-panel.component.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/blocks/attribution/meta/
git commit -m "feat(attribution): Meta revenue panel from metaCheck and campaign ledger"
```

---

### Task 2: SourceDrawer registry component

**Files:**
- Create: `src/components/blocks/attribution/source-drawer.tsx`
- Create: `src/components/blocks/attribution/source-drawer.component.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `src/components/blocks/attribution/source-drawer.component.test.tsx`. The four data-heavy children are mocked (they own tRPC queries and have their own tests); the lab links render for real, so role gating is exercised.

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { SourceDrawer } from "./source-drawer";

vi.mock("./bucket-orders-panel", () => ({
  BucketOrdersPanel: () => <div data-testid="orders-panel" />,
}));
vi.mock("./meta/revenue-panel", () => ({
  MetaRevenuePanel: () => <div data-testid="meta-panel" />,
}));
vi.mock("./google-ads/revenue-panel", () => ({
  GoogleAdsRevenuePanel: () => <div data-testid="google-panel" />,
}));
vi.mock("./klaviyo/email-revenue-panel", () => ({
  EmailRevenuePanel: () => <div data-testid="klaviyo-panel" />,
}));

function drawer(bucket: AttributionBucket, role: string | null = "owner") {
  return render(
    <SourceDrawer
      bucket={bucket}
      dateFrom="2026-08-01"
      dateTo="2026-08-07"
      currency="USD"
      timeZone="UTC"
      role={role}
      shopDomain={null}
      shopifyTotal="2000.00"
      metaDown={false}
      detailHref="/mer"
      onClose={() => {}}
    />,
  );
}

describe("SourceDrawer", () => {
  it("meta: panel, orders, and a dashboard link for every role", () => {
    drawer("meta", "member");
    expect(screen.getByTestId("meta-panel")).toBeInTheDocument();
    expect(screen.getByTestId("orders-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Meta dashboard" }),
    ).toHaveAttribute("href", "/meta");
  });

  it("google: panel plus a privileged lab link", () => {
    drawer("google");
    expect(screen.getByTestId("google-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Google Ads Lab" }),
    ).toHaveAttribute("href", "/attribution/google-ads");
  });

  it("google: members see no lab link", () => {
    drawer("google", "member");
    expect(screen.queryByRole("link", { name: "Google Ads Lab" })).toBeNull();
  });

  it("klaviyo: panel plus a privileged lab link", () => {
    drawer("klaviyo");
    expect(screen.getByTestId("klaviyo-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Klaviyo Lab" }),
    ).toHaveAttribute("href", "/attribution/klaviyo");
  });

  it("buckets without a panel render only the orders table", () => {
    drawer("tiktok");
    expect(screen.getByTestId("orders-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("meta-panel")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:components -- src/components/blocks/attribution/source-drawer.component.test.tsx`
Expected: FAIL — cannot resolve `./source-drawer`.

- [ ] **Step 3: Implement SourceDrawer**

Create `src/components/blocks/attribution/source-drawer.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { MousePointerClick } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { BucketOrdersPanel } from "./bucket-orders-panel";
import { GoogleAdsLabLink } from "./google-ads/lab-link";
import { GoogleAdsRevenuePanel } from "./google-ads/revenue-panel";
import { EmailRevenuePanel } from "./klaviyo/email-revenue-panel";
import { KlaviyoLabLink } from "./klaviyo/lab-link";
import { MetaRevenuePanel } from "./meta/revenue-panel";

export type SourceDrawerProps = {
  bucket: AttributionBucket;
  dateFrom: string;
  dateTo: string;
  currency: string;
  timeZone: string;
  role: string | null;
  shopDomain: string | null;
  shopifyTotal: string | null;
  metaDown: boolean;
  detailHref: string;
  onClose: () => void;
};

/** Visible to every role — /meta is not privileged, unlike the labs. */
function MetaDashboardLink() {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/meta">
        <MousePointerClick className="size-4" />
        Meta dashboard
      </Link>
    </Button>
  );
}

/**
 * Per-source drawer furniture. The action button lives in the drawer chrome
 * rather than inside the panels because the panels are privileged-only while
 * the Meta dashboard is for every role. Buckets missing from this map get the
 * plain orders table and nothing else.
 */
const SOURCES: Partial<
  Record<
    AttributionBucket,
    {
      action: (props: SourceDrawerProps) => ReactNode;
      panel: (props: SourceDrawerProps) => ReactNode;
    }
  >
> = {
  meta: {
    action: () => <MetaDashboardLink />,
    panel: (p) => (
      <MetaRevenuePanel
        dateFrom={p.dateFrom}
        dateTo={p.dateTo}
        currency={p.currency}
        metaDown={p.metaDown}
        detailHref={p.detailHref}
        shopifyTotal={p.shopifyTotal}
      />
    ),
  },
  google: {
    action: (p) => <GoogleAdsLabLink role={p.role} />,
    panel: (p) => (
      <GoogleAdsRevenuePanel
        role={p.role}
        dateFrom={p.dateFrom}
        dateTo={p.dateTo}
        currency={p.currency}
        shopifyTotal={p.shopifyTotal}
      />
    ),
  },
  klaviyo: {
    action: (p) => <KlaviyoLabLink role={p.role} />,
    panel: (p) => (
      <EmailRevenuePanel
        role={p.role}
        dateFrom={p.dateFrom}
        dateTo={p.dateTo}
        currency={p.currency}
        shopifyTotal={p.shopifyTotal}
      />
    ),
  },
};

export function SourceDrawer(props: SourceDrawerProps) {
  const source = SOURCES[props.bucket];
  return (
    <div className="flex flex-col gap-2 px-1 pb-2 pt-1">
      {source ? (
        <div className="flex justify-end">{source.action(props)}</div>
      ) : null}
      {source ? source.panel(props) : null}
      <BucketOrdersPanel
        bucket={props.bucket}
        dateFrom={props.dateFrom}
        dateTo={props.dateTo}
        currency={props.currency}
        timeZone={props.timeZone}
        shopDomain={props.shopDomain}
        onClose={props.onClose}
      />
    </div>
  );
}
```

Styling note (this is the spec's "light styling pass"): the Google/Klaviyo panels keep their own `rounded-md border bg-card` section chrome and render unchanged — nested inside the ledger card they read as drawer cards, and the `gap-2` stack plus `px-1` inset is the only drawer fitting needed. Do not add variant props to the panels.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:components -- src/components/blocks/attribution/source-drawer.component.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/blocks/attribution/source-drawer.tsx src/components/blocks/attribution/source-drawer.component.test.tsx
git commit -m "feat(attribution): SourceDrawer merges panels, orders, and dashboard links"
```

---

### Task 3: Wire SourceDrawer into the attribution page

Replace the drawer contents, delete the standalone panel sections and the header lab links. (The page still lives at `src/app/(protected)/attribution/page.tsx` in this task; it moves in Task 5.)

**Files:**
- Modify: `src/app/(protected)/attribution/page.tsx`

- [ ] **Step 1: Swap the imports**

In `src/app/(protected)/attribution/page.tsx`, delete these five imports:

```tsx
import { BucketOrdersPanel } from "@/components/blocks/attribution/bucket-orders-panel";
import { KlaviyoLabLink } from "@/components/blocks/attribution/klaviyo/lab-link";
import { GoogleAdsLabLink } from "@/components/blocks/attribution/google-ads/lab-link";
import { GoogleAdsRevenuePanel } from "@/components/blocks/attribution/google-ads/revenue-panel";
import { EmailRevenuePanel } from "@/components/blocks/attribution/klaviyo/email-revenue-panel";
```

and add one:

```tsx
import { SourceDrawer } from "@/components/blocks/attribution/source-drawer";
```

- [ ] **Step 2: Remove the header lab links**

In the title row, replace:

```tsx
        <div className="flex items-center gap-2">
          <KlaviyoLabLink role={role} />
          <GoogleAdsLabLink role={role} />
          <FreshnessCaption
```

with:

```tsx
        <div className="flex items-center gap-2">
          <FreshnessCaption
```

- [ ] **Step 3: Replace the drawer body**

In the `ChannelLedger` call, replace:

```tsx
            renderDrawer={(bucket) =>
              range ? (
                <div className="px-1 pb-2 pt-1">
                  <BucketOrdersPanel
                    bucket={bucket}
                    dateFrom={range.dateFrom}
                    dateTo={range.dateTo}
                    currency={currency}
                    timeZone={timeZone}
                    shopDomain={store.data?.store.shopDomain ?? null}
                    onClose={() => setOpenBucket(null)}
                  />
                </div>
              ) : null
            }
```

with:

```tsx
            renderDrawer={(bucket) =>
              range ? (
                <SourceDrawer
                  bucket={bucket}
                  dateFrom={range.dateFrom}
                  dateTo={range.dateTo}
                  currency={currency}
                  timeZone={timeZone}
                  role={role}
                  shopDomain={store.data?.store.shopDomain ?? null}
                  shopifyTotal={data?.total != null ? String(data.total) : null}
                  metaDown={metaDown}
                  detailHref={links.metaVsShopify}
                  onClose={() => setOpenBucket(null)}
                />
              ) : null
            }
```

- [ ] **Step 4: Delete the standalone panel sections**

Below the ledger `</section>`, delete both blocks entirely:

```tsx
      {range ? (
        <EmailRevenuePanel
          role={role}
          dateFrom={range.dateFrom}
          dateTo={range.dateTo}
          currency={currency}
          shopifyTotal={data?.total != null ? String(data.total) : null}
        />
      ) : null}

      {range ? (
        <GoogleAdsRevenuePanel
          role={role}
          dateFrom={range.dateFrom}
          dateTo={range.dateTo}
          currency={currency}
          shopifyTotal={data?.total != null ? String(data.total) : null}
        />
      ) : null}
```

(`<DetailFolds …/>` stays; it slims down in Task 4.)

- [ ] **Step 5: Verify lint and tests**

Run: `bun run lint && bun run test:components`
Expected: lint clean (no unused imports), all component tests pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(protected)/attribution/page.tsx"
git commit -m "feat(attribution): open source panels and dashboard links from the ledger drawers"
```

---

### Task 4: Slim DetailFolds to attention + how-we-count

The Meta and campaign folds' content now lives in the Meta drawer, so the folds go, along with the props and copy that fed them.

**Files:**
- Modify: `src/components/blocks/attribution/detail-folds.tsx` (full rewrite below)
- Modify: `src/app/(protected)/attribution/page.tsx` (call site + dead query)
- Modify: `src/components/blocks/attribution/copy.ts` (dead copy)

- [ ] **Step 1: Rewrite detail-folds.tsx**

Replace the entire contents of `src/components/blocks/attribution/detail-folds.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  findingHeadline,
  folds as copy,
  howWeCount,
  page,
  rail as railCopy,
} from "./copy";
import {
  FindingsBody,
  FindingsStatusFooter,
  useFindingsState,
  type FindingsContext,
} from "./findings-content";
import { HowWeCountList } from "./how-we-count";
import { TodaysChecks } from "./todays-checks";

type FoldKey = "attention" | "how";

/**
 * Everything that used to shout from a right-hand rail and two cards, folded
 * into rows. The Meta check and campaign folds moved into the Meta drawer on
 * the ledger; what stays here is what concerns every channel.
 */
export function DetailFolds({
  findings,
  timeZone,
  frozenClock,
  lastCheckedClock,
}: {
  findings: FindingsContext;
  timeZone: string;
  frozenClock: string | null;
  lastCheckedClock: string | null;
}) {
  const [open, setOpen] = useState<FoldKey | null>(null);
  const state = useFindingsState();
  const { items, checks, checksLoading, hasCritical, isPending } = state;

  const attentionSummary = findings.firstLoad
    ? copy.attentionFirstLoad
    : findings.frozen
      ? copy.attentionFrozen
      : isPending
        ? null
        : items.length > 0
          ? copy.attentionOpen(
              items.length,
              findingHeadline(items[0], findings.ctx),
            )
          : copy.attentionAllClear(checks?.length ?? 5);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <Fold
        foldKey="attention"
        title={copy.attention}
        summary={attentionSummary}
        open={open === "attention"}
        onToggle={setOpen}
        badge={
          items.length > 0 ? (
            <Badge
              variant="outline"
              className="h-5 rounded-full px-2 text-[11px] tabular-nums"
              style={
                hasCritical
                  ? {
                      backgroundColor: "var(--attr-critical-soft)",
                      borderColor: "var(--attr-critical)",
                      color: "var(--attr-critical)",
                    }
                  : undefined
              }
            >
              {items.length}
            </Badge>
          ) : null
        }
      >
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">
          {findings.frozen
            ? frozenClock
              ? railCopy.frozen(frozenClock)
              : railCopy.frozenNoClock
            : lastCheckedClock
              ? railCopy.checked(lastCheckedClock)
              : railCopy.checkedNoStamp}
        </p>
        <div className="overflow-hidden rounded-sm border border-border">
          <FindingsBody state={state} context={findings} />
          <TodaysChecks items={checks} loading={checksLoading} />
          <FindingsStatusFooter
            state={state}
            className="border-t border-border px-3 py-2"
          />
        </div>
      </Fold>

      <Fold
        foldKey="how"
        title={howWeCount.trigger}
        summary={copy.howSummary}
        open={open === "how"}
        onToggle={setOpen}
        last
      >
        <HowWeCountList timeZone={timeZone} />
      </Fold>
    </div>
  );
}

function Fold({
  foldKey,
  title,
  summary,
  badge,
  open,
  onToggle,
  last = false,
  children,
}: {
  foldKey: FoldKey;
  title: string;
  summary: string | null;
  badge?: React.ReactNode;
  open: boolean;
  onToggle: (next: FoldKey | null) => void;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(!last && "border-b border-border")}>
      <button
        type="button"
        onClick={() => onToggle(open ? null : foldKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[12.5px] font-semibold">{title}</span>
        {badge}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {summary ?? page.noDataYet}
        </span>
      </button>

      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}
```

(Removed relative to the old file: the `meta` and `campaigns` folds, `campaignSummaryFor`, the `MetaCheckData` type, and the now-unused imports `MetaCheckDetail`, `CampaignTable`, `CampaignLedgerData`, `campaigns as campaignCopy`, `formatMoneyExact`, `RouterOutputs`.)

- [ ] **Step 2: Update the page call site and drop the dead query**

In `src/app/(protected)/attribution/page.tsx`:

Replace:

```tsx
      <DetailFolds
        findings={findingsContext}
        metaCheck={metaCheck.data}
        metaLoading={metaCheck.isPending || !range}
        metaDown={metaDown}
        campaignLedger={campaignLedger.data}
        campaignsLoading={campaignLedger.isPending || !range}
        currency={currency}
        timeZone={timeZone}
        detailHref={links.metaVsShopify}
        frozenClock={frozen ? shopifyClock : null}
        lastCheckedClock={shopifyClock}
      />
```

with:

```tsx
      <DetailFolds
        findings={findingsContext}
        timeZone={timeZone}
        frozenClock={frozen ? shopifyClock : null}
        lastCheckedClock={shopifyClock}
      />
```

Then delete the page's now-unused `campaignLedger` query (the Meta panel owns this query now):

```tsx
  const campaignLedger = useQuery({
    ...trpc.attribution.campaignLedger.queryOptions({
      dateFrom: range?.dateFrom ?? browserDay,
      dateTo: range?.dateTo ?? browserDay,
    }),
    enabled: range !== null,
  });
```

Do NOT touch the `metaCheck` / `previousMetaCheck` queries — the header rail still reads them.

- [ ] **Step 3: Remove the dead copy**

In `src/components/blocks/attribution/copy.ts`:

From the `folds` export, delete these three entries (all uses were in the removed folds; `folds.attention*`, `how`, `howSummary` stay):

```ts
  meta: metaCheck.title,
  metaSummary: (
    metaSays: string | null,
    confirm: string,
    back: string | null,
  ) =>
    [
      metaSays ? `Meta says ${metaSays}` : null,
      `we confirm ${confirm}`,
      back ? `${back} back per $1` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  metaSummaryNoData: "no data yet",
```

From the `campaigns` export, delete the two fold-summary builders `summary` and `summaryNoBack` (keep `title`, `columns`, and everything else — `CampaignTable` uses them):

```ts
  summary: (worstName: string, back: string, campaignCount: number) =>
    `${worstName} gives back ${back} per $1 · ${formatCount(campaignCount)} ${
      campaignCount === 1 ? "campaign" : "campaigns"
    }`,
  /** Spend with nothing behind it is the sharpest version of the same list. */
  summaryNoBack: (worstName: string, spent: string, campaignCount: number) =>
    `${worstName} spent ${spent} with no orders behind it · ${formatCount(
      campaignCount,
    )} ${campaignCount === 1 ? "campaign" : "campaigns"}`,
```

Verify nothing else references them: `grep -rn "campaignCopy.summary\|metaSummary\|folds.meta" src` — expect zero hits.

- [ ] **Step 4: Verify**

Run: `bun run lint && bun run test && bun run test:components`
Expected: all green. Lint would catch any import or copy reference left dangling.

- [ ] **Step 5: Commit**

```bash
git add src/components/blocks/attribution/detail-folds.tsx src/components/blocks/attribution/copy.ts "src/app/(protected)/attribution/page.tsx"
git commit -m "refactor(attribution): fold Meta check and campaigns into the Meta drawer"
```

---

### Task 5: Route moves — attribution to `/`, Meta dashboard to `/meta`

**Files:**
- Move: `src/app/(protected)/(dashboard)/page.tsx` → `src/app/(protected)/meta/page.tsx`
- Move: `src/app/(protected)/(dashboard)/loading.tsx` → `src/app/(protected)/meta/loading.tsx`
- Move: `src/app/(protected)/attribution/page.tsx` → `src/app/(protected)/(dashboard)/page.tsx`
- Create: `src/app/(protected)/attribution/page.tsx` (redirect stub)
- Modify: `src/components/blocks/attribution/copy.ts` (nav label)
- Modify: `src/components/app-sidebar.tsx` (Meta nav item)

- [ ] **Step 1: Move the files with git mv**

```bash
git mv "src/app/(protected)/(dashboard)/page.tsx" "src/app/(protected)/meta/page.tsx"
git mv "src/app/(protected)/(dashboard)/loading.tsx" "src/app/(protected)/meta/loading.tsx"
git mv "src/app/(protected)/attribution/page.tsx" "src/app/(protected)/(dashboard)/page.tsx"
```

The moved Meta dashboard needs **no code changes** — it imports everything via `@/` aliases and manages its own state. The moved attribution page likewise keeps working (same alias imports).

- [ ] **Step 2: Rename the moved page component**

In `src/app/(protected)/(dashboard)/page.tsx` (the moved attribution page), rename the default export:

```tsx
export default function AttributionPage() {
```

becomes:

```tsx
export default function DashboardPage() {
```

- [ ] **Step 3: Create the redirect stub**

Create `src/app/(protected)/attribution/page.tsx`:

```tsx
import { redirect } from "next/navigation";

/** The attribution view graduated to the dashboard at `/`; old links land there. */
export default function AttributionRedirect() {
  redirect("/");
}
```

(The labs at `/attribution/klaviyo` and `/attribution/google-ads` are child routes with their own `page.tsx` — they are not affected by the parent redirecting.)

- [ ] **Step 4: Update the nav label**

In `src/components/blocks/attribution/copy.ts`, in the `page` export:

```ts
  navLabel: "Attribution",
```

becomes:

```ts
  navLabel: "Dashboard",
```

(`title: "Where your sales came from"` stays — that's the on-page heading.)

- [ ] **Step 5: Add the Meta item to the sidebar**

In `src/components/app-sidebar.tsx`, in `dashboardSubItems`, replace:

```tsx
  { label: "Dashboard", href: "/", icon: "solar:widget-5-linear" },
  { label: "MER", href: "/mer", icon: "solar:graph-up-linear" },
```

with:

```tsx
  { label: "Dashboard", href: "/", icon: "solar:widget-5-linear" },
  { label: "Meta", href: "/meta", icon: "solar:cursor-square-linear" },
  { label: "MER", href: "/mer", icon: "solar:graph-up-linear" },
```

(`solar:cursor-square-linear` is the same Solar glyph as the ledger's Meta bucket icon — `MousePointerClick` in `src/components/icons.tsx` maps to `createSolarIcon("cursor-square")`. The existing active-state logic already handles `/meta` via `pathname.startsWith`.)

- [ ] **Step 6: Verify the routes build**

Run: `bun run lint && bun run build`
Expected: build succeeds; the route list printed by Next includes `/`, `/meta`, `/attribution`, `/attribution/klaviyo`, and `/attribution/google-ads`.

Then, optionally with `bun dev`: `/` shows the attribution view titled "Where your sales came from"; `/meta` shows the old KPI dashboard; `/attribution` lands on `/`.

- [ ] **Step 7: Commit**

```bash
git add -A "src/app/(protected)" src/components/app-sidebar.tsx src/components/blocks/attribution/copy.ts
git commit -m "feat: attribution view becomes the dashboard at /, Meta dashboard moves to /meta"
```

---

### Task 6: Retire the attribution feature flag

**Files:**
- Modify: `src/lib/feature-flags.ts`
- Modify: `src/lib/trpc/routers/org-settings.test.ts`

- [ ] **Step 1: Remove the flag definition**

In `src/lib/feature-flags.ts`, delete the whole `attribution` entry from `featureFlagDefs`:

```ts
  {
    key: "attribution",
    label: "Attribution",
    description:
      "Shows the Attribution view, where revenue is credited back to campaigns.",
    badge: "Beta",
    href: "/attribution",
    icon: "solar:pie-chart-2-linear",
    group: "analyze",
  },
```

Everything downstream is derived (`featureFlagKeys`, the settings page rows, the sidebar's flag-gated "Analyze" group), so no other production code changes. Stored `attribution: true` values in the org-settings jsonb are simply ignored from now on — no migration.

- [ ] **Step 2: Update the org-settings router tests**

`src/lib/trpc/routers/org-settings.test.ts` uses `attribution` as its example flag key; `setFeatureFlag`'s zod enum will now reject it. Replace every occurrence of the flag key `attribution` in this file with `imageStudio` (mechanical rename — fixture rows, `setFeatureFlag` inputs, and expected objects; e.g. `{ featureFlags: { attribution: true } }` → `{ featureFlags: { imageStudio: true } }`, `key: "attribution"` → `key: "imageStudio"`).

Run: `grep -n "attribution" src/lib/trpc/routers/org-settings.test.ts`
Expected: no matches after the rename.

- [ ] **Step 3: Verify no other references remain**

Run: `grep -rn '"attribution"' src --include="*.ts" --include="*.tsx"`
Expected: no hits related to the feature flag. (`trpc.attribution.*` — the tRPC router namespace — is unrelated and stays.)

- [ ] **Step 4: Run the tests**

Run: `bun run test`
Expected: PASS, including `org-settings.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/feature-flags.ts src/lib/trpc/routers/org-settings.test.ts
git commit -m "feat(settings): retire the attribution feature flag"
```

---

### Task 7: Full verification pass

- [ ] **Step 1: Run everything**

```bash
bun run lint && bun run test && bun run test:components && bun run build
```

Expected: all four green.

- [ ] **Step 2: Manual smoke test (bun dev)**

- `/` → attribution view, breadcrumb "Dashboard", no lab links in the header.
- Click **Meta ads** row → drawer shows "Meta dashboard" button (top right) → "The Meta check" panel with share bar and "Campaign by campaign" table → orders table. Button lands on `/meta`.
- Click **Google ads** row (as owner/admin) → "Google Ads Lab" button + Google panel + orders.
- Click **Klaviyo email** row (as owner/admin) → "Klaviyo Lab" button + email panel + orders.
- Click **TikTok** (or any other) row → orders table only.
- As a `member`: Meta drawer still shows the "Meta dashboard" button; Google/Klaviyo drawers show orders only (panels and lab buttons hidden by their own role checks).
- `/attribution` redirects to `/`; `/attribution/klaviyo` and `/attribution/google-ads` still load.
- Settings → Features no longer lists "Attribution".

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/attribution-dashboard
```

Then open a PR to `main` titled `feat: attribution view becomes the main dashboard`, following the repo's `creating-pr` conventions.
