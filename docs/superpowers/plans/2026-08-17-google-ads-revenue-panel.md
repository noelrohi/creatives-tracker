# Google Ads Revenue Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-08-17-google-ads-revenue-panel-design.md` — a four-piece "Google Ads revenue" panel on `/attribution` below the email panel: feed/paid split of our google bucket, "Google says" range-sliced campaign facts, both-ROAS headline, name-matched campaign table, and a data-shaped insight strip.

**Architecture:** Mirrors the email revenue panel exactly: one read-only aggregate endpoint (`googleAds.revenuePanel`) backed by `src/lib/google-ads/revenue-panel.ts`, client panel components in `components/blocks/attribution/google-ads/`, one mount line in the attribution page. No schema changes, no new Trigger.dev tasks. Money travels as integer cents (the google-ads module convention).

**Tech Stack:** Drizzle/PostgreSQL, tRPC 11 `orgAdminProcedure`, React 19 client components with TanStack Query, Vitest (+ pg harness at `src/lib/google-ads/test-support/pg-harness.ts`).

**Branch:** `feat/google-ads-pilot` (continue on it; single PR with the pilot).

---

## Conventions (read once)

- Icons from `@/components/icons`; money display via `formatCentsMoney`/`formatMoney` from `components/blocks/attribution/format.ts`.
- The email panel trio to mirror: `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx`, `email-revenue-tables.tsx`, `email-revenue-gaps.tsx`, plus `copy.ts` — read them before Tasks 3–4.
- The panel's props contract comes from the mount site (`src/app/(protected)/attribution/page.tsx:413-420`): `{ role, dateFrom, dateTo, currency, shopifyTotal }`.
- Integration tests use the shared pg harness; the `shopify_order` fixture-table idiom lives in `src/lib/google-ads/gclid-probe.integration.test.ts` (copy its fixture DDL approach; it may need a `shopify_refund` fixture added — see Task 1).

## File structure

```
src/lib/google-ads/revenue-panel.ts                (+ .test.ts, .integration.test.ts)
src/lib/trpc/routers/google-ads.ts                 (add revenuePanel proc; + tests)
src/components/blocks/attribution/google-ads/
  copy.ts                                          (panel copy incl. insight variants)
  revenue-panel-table.tsx                          (by-campaign table)
  revenue-panel.tsx                                (panel shell: KPIs, share bar, states)
  revenue-panel.component.test.tsx                 (gate + pending states)
src/app/(protected)/attribution/page.tsx           (mount below EmailRevenuePanel)
```

---

### Task 1: Server module `revenue-panel.ts`

**Files:**
- Create: `src/lib/google-ads/revenue-panel.ts`
- Create: `src/lib/google-ads/revenue-panel.test.ts`
- Create: `src/lib/google-ads/revenue-panel.integration.test.ts`

- [ ] **Step 1: Read the ground truth first**

Read `src/lib/attribution-queries.ts` — specifically `getStoreForOrg` (~line 240) and `getBucketTotals` (~line 273 to its end): note the exact WHERE/window idiom it uses for orders and for refunds (refunds are ranged independently by their own day column and inherit the parent order's bucket). The split query in Step 3 MUST copy that idiom so feed + paid sums to the bucket row by construction. Also read `src/lib/google-ads/queries.ts` (`listCampaignFactsSummary`, `getGoogleBucketNetSales`) — the Google-side sums reuse `listCampaignFactsSummary`.

- [ ] **Step 2: Write the failing unit test**

`src/lib/google-ads/revenue-panel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchCampaignNames } from "@/lib/google-ads/revenue-panel";

describe("matchCampaignNames", () => {
  const PAID = [
    { utmCampaign: "brand_search", revenueCents: 1000, orders: 2 },
    { utmCampaign: "PMax-Main", revenueCents: 500, orders: 1 },
    { utmCampaign: null, revenueCents: 200, orders: 1 },
  ];

  it("matches case-insensitively after trimming", () => {
    expect(matchCampaignNames("  Brand_Search ", PAID)).toBe("brand_search");
    expect(matchCampaignNames("pmax-main", PAID)).toBe("PMax-Main");
  });

  it("returns null when nothing matches exactly", () => {
    expect(matchCampaignNames("brand search", PAID)).toBeNull();
    expect(matchCampaignNames("", PAID)).toBeNull();
  });

  it("never matches the null utm bucket", () => {
    expect(matchCampaignNames("null", PAID)).toBeNull();
  });
});
```

Run: `bun run test src/lib/google-ads/revenue-panel.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/google-ads/revenue-panel.ts`:

```ts
import "server-only";

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { GOOGLE_FEED_MEDIUMS } from "@/lib/attribution-bucket";
import { getBucketTotals } from "@/lib/attribution-queries";
import { listCampaignFactsSummary } from "@/lib/google-ads/queries";
import {
  getPilotGoogleAdsConnectionForOrganization,
  type ConnectionRecord,
} from "@/lib/google-ads/sync-store";
import { shopifyOrders } from "@/schema/shopify";

/** All money in integer cents (google-ads module convention). */
export type PaidCampaignSlice = {
  utmCampaign: string | null;
  revenueCents: number;
  orders: number;
};

export type RevenuePanelSummary = {
  connection: {
    status: string;
    lastFactsSyncedAt: Date | null;
    backfillCompletedAt: Date | null;
  } | null;
  /** Google figures are in this currency; null when no connection. */
  googleCurrencyCode: string | null;
  ourSide: {
    bucketRevenueCents: number;
    bucketOrders: number;
    feedRevenueCents: number;
    feedOrders: number;
    paidRevenueCents: number;
    paidOrders: number;
    paidByCampaign: PaidCampaignSlice[];
  };
  googleSays: {
    spendCents: number;
    conversions: number;
    conversionsValueCents: number;
    byCampaign: Array<{
      campaignId: string;
      campaignName: string;
      spendCents: number;
      conversions: number;
      conversionsValueCents: number;
      matchedUtmCampaign: string | null;
    }>;
  } | null;
};

/**
 * Exact, case-insensitive, trimmed name equality between a Google campaign
 * name and our paid utm_campaign values. Advisory presentation metadata —
 * never persisted, never fuzzy. The null-utm slice can never match.
 */
export function matchCampaignNames(
  campaignName: string,
  paidByCampaign: PaidCampaignSlice[],
): string | null {
  const needle = campaignName.trim().toLowerCase();
  if (needle === "") return null;
  for (const slice of paidByCampaign) {
    if (slice.utmCampaign !== null && slice.utmCampaign.trim().toLowerCase() === needle) {
      return slice.utmCampaign;
    }
  }
  return null;
}

const FEED_MEDIUMS = GOOGLE_FEED_MEDIUMS.map((medium) => medium.toLowerCase());

/**
 * Feed/paid split of the google bucket plus the paid-by-campaign slices.
 *
 * MUST mirror `getBucketTotals`' windowing and refund semantics exactly
 * (orders and refunds each ranged the way that function ranges them, with
 * refunds inheriting the parent order's classification), so that
 * feed + paid always sums to the bucket row the ledger shows. Copy the
 * window idiom from attribution-queries.ts rather than inventing one.
 */
async function loadOurSide(params: {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<RevenuePanelSummary["ourSide"]> {
  const totals = await getBucketTotals({
    organizationId: params.organizationId,
    storeId: params.storeId,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  });
  const googleRow = totals.buckets.find((bucket) => bucket.bucket === "google");
  const bucketRevenueCents = googleRow?.revenueCents ?? 0;
  const bucketOrders = googleRow?.orders ?? 0;

  // Split query — adapt the WHERE/window fragments to match getBucketTotals
  // verbatim (this skeleton assumes orderDay-ranged orders; correct it
  // against the real implementation in Step 1 if it differs, and apply the
  // same refund mirror it uses).
  const isFeed = sql`lower(coalesce(${shopifyOrders.lastClickUtmMedium}, '')) in ${FEED_MEDIUMS}`;
  const rows = await db
    .select({
      utmCampaign: shopifyOrders.lastClickUtmCampaign,
      feed: sql<boolean>`${isFeed}`,
      revenue: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      orders: sql<string>`count(*)`,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, params.organizationId),
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.bucket, "google"),
        gte(shopifyOrders.orderDay, params.dateFrom),
        lte(shopifyOrders.orderDay, params.dateTo),
      ),
    )
    .groupBy(shopifyOrders.lastClickUtmCampaign, sql`${isFeed}`);

  // ...aggregate rows into feed/paid totals and paidByCampaign, subtract the
  // refund mirror per slice the same way getBucketTotals nets refunds, and
  // reconcile so feed + paid === bucket totals (assert in the integration
  // test, not at runtime).
  // (Complete this against the real getBucketTotals internals.)
  throw new Error("implement against getBucketTotals internals");
}

export async function loadGoogleAdsRevenuePanel(params: {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<RevenuePanelSummary> {
  const connection: ConnectionRecord | null =
    await getPilotGoogleAdsConnectionForOrganization(params.organizationId);
  const ourSide = await loadOurSide(params);

  let googleSays: RevenuePanelSummary["googleSays"] = null;
  if (connection) {
    const campaigns = await listCampaignFactsSummary({
      connectionId: connection.id,
      fromDay: params.dateFrom,
      toDay: params.dateTo,
    });
    if (campaigns.length > 0) {
      const byCampaign = campaigns.map((campaign) => ({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        spendCents: Math.round(campaign.costMicros / 10_000),
        conversions: campaign.conversions,
        conversionsValueCents: Math.round(campaign.conversionsValue * 100),
        matchedUtmCampaign: matchCampaignNames(
          campaign.campaignName,
          ourSide.paidByCampaign,
        ),
      }));
      googleSays = {
        spendCents: byCampaign.reduce((total, c) => total + c.spendCents, 0),
        conversions: byCampaign.reduce((total, c) => total + c.conversions, 0),
        conversionsValueCents: byCampaign.reduce(
          (total, c) => total + c.conversionsValueCents,
          0,
        ),
        byCampaign,
      };
    }
  }

  return {
    connection: connection
      ? {
          status: connection.status,
          lastFactsSyncedAt: connection.lastFactsSyncedAt,
          backfillCompletedAt: connection.backfillCompletedAt,
        }
      : null,
    googleCurrencyCode: connection?.currencyCode ?? null,
    ourSide,
    googleSays,
  };
}
```

The `loadOurSide` body above is deliberately a SKELETON with a throw: the real
windowing must be copied from `getBucketTotals` (Step 1), including its refund
netting, and the aggregation completed. Do not ship the `orderDay`-ranged
guess if `getBucketTotals` ranges differently — the integration test's
sums-to-bucket assertion is the arbiter. `costMicros / 10_000` = cents
(1,000,000 micros per unit ÷ 100 cents); keep `Math.round`.

- [ ] **Step 4: Unit test passes**

Run: `bun run test src/lib/google-ads/revenue-panel.test.ts` → PASS (3 tests).

- [ ] **Step 5: Integration test**

`src/lib/google-ads/revenue-panel.integration.test.ts` — pg harness (copy the
setup from `gclid-probe.integration.test.ts`, including its `shopify_order`
fixture DDL; ADD a `shopify_refund` fixture table matching the real schema's
columns used by `getBucketTotals` — read `src/schema/shopify.ts` for its
column names — if `getBucketTotals` reads refunds; whatever it reads must
exist in the fixture). Seed one org/store plus:

- 2 google-bucket feed orders (`lastClickUtmMedium: "product_sync"`, netSales 100 and 50), one with `lastClickUtmCampaign: "sag_organic"`.
- 2 google-bucket paid orders (`lastClickUtmMedium: "cpc"`, `lastClickUtmCampaign: "brand_search"` netSales 80; `lastClickUtmCampaign: null` netSales 20).
- 1 meta-bucket order (excluded).
- 1 refund against the feed order (if the refund mirror applies) inside the range.
- A ready connection + campaign facts: campaign "Brand_Search" (matches by name, case-insensitive) and "PMax" (no match), each with one in-range fact day and one out-of-range fact day.

Tests:

```ts
it("splits feed/paid summing exactly to the bucket totals", async () => {
  const summary = await loadGoogleAdsRevenuePanel({ organizationId, storeId, dateFrom, dateTo });
  const { ourSide } = summary;
  expect(ourSide.feedRevenueCents + ourSide.paidRevenueCents).toBe(ourSide.bucketRevenueCents);
  expect(ourSide.feedOrders + ourSide.paidOrders).toBe(ourSide.bucketOrders);
  // And the bucket equals getBucketTotals' own google row for the same range
  // (call it directly and compare) — the ledger-agreement invariant.
});

it("slices google facts to the range and matches campaign names", async () => {
  const summary = await loadGoogleAdsRevenuePanel({ organizationId, storeId, dateFrom, dateTo });
  const brand = summary.googleSays?.byCampaign.find((c) => c.campaignName === "Brand_Search");
  expect(brand?.matchedUtmCampaign).toBe("brand_search");
  expect(summary.googleSays?.byCampaign.find((c) => c.campaignName === "PMax")?.matchedUtmCampaign).toBeNull();
  // out-of-range fact day excluded from sums — assert the exact spendCents.
});

it("returns googleSays null without a connection and ourSide still populated", async () => {
  // delete/skip connection seeding in this case
});
```

Run: `bun run test src/lib/google-ads/revenue-panel.integration.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/google-ads/revenue-panel.ts src/lib/google-ads/revenue-panel.test.ts src/lib/google-ads/revenue-panel.integration.test.ts
git commit -m "feat: add Google Ads revenue panel aggregate module"
```

---

### Task 2: Router procedure

**Files:**
- Modify: `src/lib/trpc/routers/google-ads.ts`
- Modify: `src/lib/trpc/routers/google-ads.test.ts`

- [ ] **Step 1: Add the procedure**

Mirror `klaviyo.emailAttribution` (`src/lib/trpc/routers/klaviyo.ts:266-275`) but resolve the store like the attribution page does — via `getStoreForOrg` from `@/lib/attribution-queries` — so the panel works before any Google connection exists:

```ts
revenuePanel: orgAdminProcedure
  .input(z.object({ dateFrom: daySchema, dateTo: daySchema }))
  .query(async ({ input, ctx }) => {
    if (input.dateFrom > input.dateTo) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid day range" });
    }
    const store = await getStoreForOrg(ctx.organizationId);
    if (!store) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No Shopify store configured" });
    }
    return loadGoogleAdsRevenuePanel({
      organizationId: ctx.organizationId,
      storeId: store.id,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
  }),
```

Check `getStoreForOrg`'s actual signature/return shape (`src/lib/attribution-queries.ts:240`) and adjust (it may return `{ id, ... }` or `null`; match reality).

- [ ] **Step 2: Router tests**

Add to `google-ads.test.ts` (same mock-bag conventions as the existing tests):
- inverted range → BAD_REQUEST;
- no store → NOT_FOUND;
- happy path forwards `organizationId` from ctx and `storeId` from the resolved store to `loadGoogleAdsRevenuePanel` (mock it; assert args — pins tenant scoping).

Run: `bun run test src/lib/trpc/routers/google-ads.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/trpc/routers/google-ads.ts src/lib/trpc/routers/google-ads.test.ts
git commit -m "feat: add googleAds.revenuePanel endpoint"
```

---

### Task 3: Panel copy + table component

**Files:**
- Create: `src/components/blocks/attribution/google-ads/copy.ts`
- Create: `src/components/blocks/attribution/google-ads/revenue-panel-table.tsx`

- [ ] **Step 1: Read the email panel trio** (`email-revenue-panel.tsx`, `email-revenue-tables.tsx`, `klaviyo/copy.ts`) for the exact caption/table idioms, class names, and the `EmailRevenueTables` props shape.

- [ ] **Step 2: Copy module**

`copy.ts` — centralize every panel string (mirroring `klaviyo/copy.ts`'s `emailRevenue` export). Include the three insight variants and the captions:

```ts
export const googleAdsRevenue = {
  title: "Google Ads revenue · Google",
  freshness: (age: string) => `Google facts as of ${age}`,
  awaitingAccess: "awaiting Google API access",
  noRangeData: "no Google data for this range yet",
  kpi: {
    bucket: "Google bucket",
    feed: "free listings feed",
    paid: "paid (UTM-tagged)",
    spend: "Spend (Google)",
    says: "Google says",
    saysCaption: "their conversion value, sliced to this range",
    roasClaims: "Google claims",
    roasConfirm: "we confirm",
    mixedCurrency: "mixed currencies — not comparable",
  },
  table: {
    heading: "By campaign — Google says vs we confirm",
    oursOnly: "ours only (no matching Google campaign)",
    feedFootnote:
      "Free-listings feed revenue is excluded here — it belongs to no paid campaign.",
    calendarCaption:
      "Google days are the ad account's calendar; ours are the store's — day-boundary orders can differ.",
  },
  insight: {
    untaggedPaid:
      "Google reports paid conversions but no paid-tagged revenue reaches our google bucket — paid revenue is likely landing in other buckets. Add UTM tracking templates to paid campaigns.",
    delta: (says: string, confirm: string) =>
      `Google says ${says}; our paid-tagged revenue confirms ${confirm}. The difference is unconfirmed by our books.`,
  },
} as const;
```

- [ ] **Step 3: Table component**

`revenue-panel-table.tsx` — a presentational component taking `{ googleSays, paidByCampaign, currency, googleCurrency }`: renders Google rows (name, spend, conv, conv value, matched "we confirm" revenue or "—"), then ours-only rows (paid slices whose `utmCampaign` matched no Google row — including the `null` slice labeled "(untagged)"), then the feed footnote + calendar caption. Use the `Table` primitives and `formatCentsMoney`. Match `email-revenue-tables.tsx`'s styling idioms.

- [ ] **Step 4: Lint/type check** (`bunx eslint`, `bunx tsc --noEmit`) → clean. Commit:

```bash
git add src/components/blocks/attribution/google-ads/copy.ts src/components/blocks/attribution/google-ads/revenue-panel-table.tsx
git commit -m "feat: add Google Ads revenue panel copy and campaign table"
```

---

### Task 4: Panel shell + mount

**Files:**
- Create: `src/components/blocks/attribution/google-ads/revenue-panel.tsx`
- Create: `src/components/blocks/attribution/google-ads/revenue-panel.component.test.tsx`
- Modify: `src/app/(protected)/attribution/page.tsx` (mount below `<EmailRevenuePanel/>`, ~line 413-420)

- [ ] **Step 1: Panel shell**

`revenue-panel.tsx` — `"use client"`; export `GoogleAdsRevenuePanel({ role, dateFrom, dateTo, currency, shopifyTotal })` (same props as `EmailRevenuePanel` — verify against its export). Behavior:

- `isPrivilegedOrgRole(role)` gate: members render nothing (`return null`).
- Query `trpc.googleAds.revenuePanel` with `{ dateFrom, dateTo }`; skeleton while loading (mirror the email panel's `Skeleton` usage), error state with retry (mirror its error convention).
- KPI row: bucket revenue (+ feed/paid split beneath) · spend · "Google says" conv value with delta vs paid slice · both ROAS figures. ROAS: render "—" when `spendCents` 0/absent; when `googleCurrencyCode` differs from `currency`, label each side's currency and render ROAS as "—" with the `mixedCurrency` caption.
- Share bar: reuse the email panel's cents-ratio width mechanics (`widthPercent`-style helper — local copy is fine, it's 6 lines) over `shopifyTotal`: feed segment (light), paid segment (dark), legend with amounts.
- Table: `<GoogleAdsRevenuePanelTable/>` from Task 3 when `googleSays` present; otherwise the awaiting/no-data line (`connection === null` → `awaitingAccess`; connection present but `googleSays === null` → `noRangeData`).
- Insight strip (dashed top border like `email-revenue-gaps.tsx`): choose copy by shape — `googleSays?.conversions > 0 && paidRevenueCents === 0` → `untaggedPaid`; `paidRevenueCents > 0 && googleSays` → `delta(...)`; else the awaiting/no-data line already covers it (render nothing extra).

- [ ] **Step 2: Component test**

`revenue-panel.component.test.tsx` (conventions from `klaviyo` component tests / `lab-link.component.test.tsx`): member role renders nothing; admin role with mocked query returning `connection: null` renders the `awaitingAccess` copy. Mock the tRPC hook the way existing component tests do (check `klaviyo` panel/component tests for the exact mocking idiom; if none mocks queries, keep to the two render-gate cases that don't need live data).

- [ ] **Step 3: Mount**

In `attribution/page.tsx`, inside the same `range ?` conditional as the email panel, directly below it:

```tsx
<GoogleAdsRevenuePanel
  role={role}
  dateFrom={range.dateFrom}
  dateTo={range.dateTo}
  currency={currency}
  shopifyTotal={data?.total != null ? String(data.total) : null}
/>
```

(+ import). Match the email panel's exact prop expressions at the mount site.

- [ ] **Step 4: Verify** — `bun run test:components` (all pass incl. new), `bunx tsc --noEmit`, `bunx eslint` on touched files, `bun run build` (compiles). Commit:

```bash
git add src/components/blocks/attribution/google-ads/revenue-panel.tsx src/components/blocks/attribution/google-ads/revenue-panel.component.test.tsx "src/app/(protected)/attribution/page.tsx"
git commit -m "feat: mount Google Ads revenue panel on attribution page"
```

---

### Task 5: Full verification

- [ ] `bun run test` → all pass, no regressions.
- [ ] `bun run test:components` → all pass.
- [ ] `bun run lint` → no findings in any google-ads or attribution file touched by this plan (repo-wide pre-existing findings excluded).
- [ ] `bun run build` → compiles.
- [ ] Invariant grep: `grep -rn "update(shopifyOrders)\|insert(shopifyOrders)" src/lib/google-ads/revenue-panel.ts` → no matches (read-only module).
- [ ] Visual check with `bun dev`: admin sees the panel below the email panel with live our-side numbers and "awaiting Google API access" on the Google cells; member sees nothing.
- [ ] Commit any stragglers.

---

## Self-review (performed while writing)

- **Spec coverage:** data contract → Task 1; endpoint + store resolution → Task 2; copy/insight variants + table → Task 3; KPI row/share bar/states/gate + mount → Task 4; testing section → Tasks 1/2/4 + Task 5; currency guard → Task 4 KPI row; non-goals respected (no schema, no tasks, read-only).
- **Known open items for the implementer (flagged in place):** `loadOurSide`'s window/refund idiom must be copied from `getBucketTotals` (Task 1 Steps 1/3 — the skeleton deliberately throws until completed); `getStoreForOrg` signature (Task 2); component-test mocking idiom (Task 4).
- **Type consistency:** `RevenuePanelSummary`/`PaidCampaignSlice` (Task 1) are the shapes consumed by Tasks 3–4; `matchCampaignNames` naming consistent; props contract matches the mount site.
