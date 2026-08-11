# Klaviyo Email Revenue Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an "Email revenue · Klaviyo" panel on the main attribution page: Shopify total vs claims-confirmed email revenue, per-campaign/flow "Klaviyo says vs we confirm", top products, and a gap strip accounting for every remaining dollar.

**Architecture:** One new read-only aggregate loader (`loadEmailAttribution`) in a new focused module, exposed through a single `orgAdminProcedure` (`klaviyo.emailAttribution`). The panel is a client component mounted between the channel ledger and detail folds in `src/app/(protected)/attribution/page.tsx`; it reads the Shopify total from the page's existing `attribution.overview` query and freshness from the existing `klaviyo.health` query. No schema changes, no migrations, no new pipeline stages.

**Tech Stack:** Next.js 16 App Router, React 19, tRPC 11, Drizzle ORM (node-postgres), Zod, Vitest 4 (+ jsdom for `.component.test.tsx`), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-11-klaviyo-email-revenue-panel-design.md`

---

## Before you start

- **Branch:** this work starts from a fresh branch off `main` **after** the pilot PR (`feat/klaviyo-shopify-evidence-pilot`) merges: `git checkout main && git pull && git checkout -b feat/klaviyo-email-revenue-panel`. If the pilot is not merged yet, branch off `feat/klaviyo-shopify-evidence-pilot` instead and say so in the PR.
- **Commands:** unit/integration tests `npm run test -- --run <file>`; component tests `npm run test:components`; typecheck `npx tsc --noEmit`; lint `bun run lint`. Never `bun test` (wrong runner).
- Integration tests need PostgreSQL. They read `DATABASE_URL` from the environment or fall back to parsing `.env` (see `resolveConnectionString` in `src/lib/klaviyo/match-test-harness.ts`). The local dev DB runs in docker (`creatives-tracker-db-1`); tests create/drop their own disposable databases and never touch `adsolute` data.
- Icons come from `@/components/icons` (Solar via iconify, Lucide-style names). `lucide-react` is not installed and is blocked by lint.
- Money values travel as **numeric strings** (Postgres `numeric` → drizzle `string`). Sum money in SQL, never in JS; JS `Number()` is allowed only for display percentages/widths.

## Two deliberate deviations from the spec (record in the PR body)

1. **Product "revenue" is order revenue.** `shopify_order_line` has no money column (quantity only — see `src/schema/shopify-evidence.ts:48`). Per-product rows therefore report `units`, `orderCount`, and `orderRevenue` = summed `net_sales` of the email-linked orders containing that product, labeled "order revenue" with a footnote that an order containing several products counts toward each. Nothing is invented per line.
2. **No `connection` field in the payload.** Freshness (`lastMatchPublishedAt` etc.) already comes from the existing `klaviyo.health` procedure; the panel calls it alongside the new query. A `NOT_FOUND` from `emailAttribution` (no pilot connection) is the panel's signal to render nothing.

One naming generalization: the spec's `confirmedNoEmailLink` gap bucket is implemented as `noEmailLink` and also absorbs `candidate`/`ambiguous` order results (statuses that exist in the schema but weren't observed at Reviv). This keeps the partition exact: every order in range lands in exactly one of `email_linked`, `no_email_link`, `not_evaluated`, `no_klaviyo_event`, `duplicate_flagged`.

## File structure

- Create: `src/lib/klaviyo/email-attribution.ts` — aggregate loader + exported types (server-only). New file rather than appending to `src/lib/klaviyo/queries.ts`, which is already ~1,100 lines.
- Create: `src/lib/klaviyo/email-attribution.integration.test.ts` — disposable-DB tests (mirrors `claim-repository.integration.test.ts` harness usage).
- Modify: `src/lib/trpc/routers/klaviyo.ts` — add `emailAttribution` procedure.
- Modify: `src/lib/trpc/routers/klaviyo.test.ts` — mock the new module, add a `PROCEDURE_CALLS` entry (RBAC coverage comes free from the two existing loop tests).
- Modify: `src/components/blocks/attribution/klaviyo/copy.ts` — panel copy + deep-link filter constants already live here.
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx` — container (queries, gating, states) + presentational `EmailRevenueHeadline`.
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-tables.tsx` — presentational sources + products tables.
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-gaps.tsx` — presentational gap strip with Lab deep links.
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx` — jsdom tests for the presentational pieces.
- Modify: `src/app/(protected)/attribution/page.tsx` — mount the panel between the ledger `<section>` and `<DetailFolds>`.

---

### Task 1: Loader module — partition, headline, and sources

The loader's heart: one CASE-bucketed partition query, plus an email-linked query with a last-touch lateral that also yields per-source rows.

**Files:**
- Create: `src/lib/klaviyo/email-attribution.ts`
- Create: `src/lib/klaviyo/email-attribution.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `src/lib/klaviyo/email-attribution.integration.test.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCOPE,
  applyMatchFixture,
  resolveConnectionString,
  seedMatchWorld,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_email_attr_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 6,
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const evidenceStore = await import("@/lib/shopify-evidence-store");
const { loadEmailAttribution } = await import("@/lib/klaviyo/email-attribution");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
// seedMatchWorld's order-a sits at 2026-07-20T10:00Z; use a window around July.
const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
};

/** Insert one published match run all result rows can hang off. */
async function seedPublishedRun(): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_match_run
       (id, organization_id, shopify_store_id, connection_id, source_run_id,
        shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
        invocation_fingerprint, status, started_at, completed_at, published_at)
     VALUES ('match-run-1', 'org-a', 'store-a', 'connection-a', 'source-run-a',
       'evidence-run-a', 'klaviyo-v1', 'scope-fp-1', 'invocation-fp-1',
       'published', now(), now(), now())`,
  );
}

async function seedOrder(
  id: string,
  shopifyOrderId: string,
  netSales: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales)
     VALUES ($1, 'org-a', 'store-a', $2, '2026-07-21T12:00:00Z', '2026-07-21', $3)`,
    [id, shopifyOrderId, netSales],
  );
}

async function seedEvent(id: string, externalEventId: string): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, explicit_order_id_candidate,
        attribution_relationship_ids, redacted_properties,
        key_type_fingerprint, warnings, product_evidence_completeness,
        source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'metric-placed',
       $2, '2026-07-21T12:05:00Z', NULL, '[]', '{}', '[]', '[]',
       'unavailable', $2 || '-checksum', '2026-07-15')`,
    [id, externalEventId],
  );
}

async function seedOrderResult(
  id: string,
  orderId: string,
  status: string,
  selectedEventId: string | null,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_order_match_result
       (id, organization_id, shopify_store_id, connection_id, run_id, order_id,
        status, selected_event_id, reason_codes, matcher_version, published_at)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'match-run-1', $2,
       $3, $4, '[]', 'klaviyo-v1', now())`,
    [id, orderId, status, selectedEventId],
  );
}

async function seedClaim(input: {
  id: string;
  conversionEventId: string;
  attributionId: string;
  campaignObjectId?: string | null;
  flowObjectId?: string | null;
  interactionOccurredAt?: string | null;
  botClick?: number | null;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_attribution_claim
       (id, organization_id, shopify_store_id, connection_id,
        conversion_event_id, klaviyo_attribution_id, campaign_object_id,
        flow_object_id, interaction_occurred_at, bot_click,
        unknown_reason_codes, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $3, $4, $5, $6, $7,
       '[]', $1 || '-checksum', '2026-07-15')`,
    [
      input.id,
      input.conversionEventId,
      input.attributionId,
      input.campaignObjectId ?? null,
      input.flowObjectId ?? null,
      input.interactionOccurredAt ?? null,
      input.botClick ?? null,
    ],
  );
}

async function seedMarketingObject(
  id: string,
  objectType: "campaign" | "flow",
  name: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_marketing_object
       (id, organization_id, shopify_store_id, connection_id, object_type,
        external_id, name, tracking_projection, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $1 || '-ext', $3,
       '{}', $1 || '-checksum', '2026-07-15')`,
    [id, objectType, name],
  );
}

/**
 * World, on top of seedMatchWorld's order-a (42.50, event-a):
 * - order-a  42.50 confirmed + campaign claim            -> email (campaign)
 * - order-f  30.00 confirmed + flow claim (last touch),
 *            older campaign claim, newer BOT campaign    -> email (flow)
 * - order-b  10.00 confirmed, no claims                  -> no_email_link
 * - order-c  20.00 no current result                     -> not_evaluated
 * - order-d   5.00 no_klaviyo_event                      -> no_klaviyo_event
 * - order-e   7.25 duplicate_conversion_events           -> duplicate_flagged
 * Total 114.75; email 72.50 (campaigns 42.50, flows 30.00).
 */
async function seedAggregateWorld(): Promise<void> {
  await seedPublishedRun();
  await seedMarketingObject("campaign-row-1", "campaign", "Summer Sale");
  await seedMarketingObject("flow-row-1", "flow", "Welcome");

  await seedOrderResult("res-a", "order-a", "confirmed", "event-a");
  await seedClaim({
    id: "claim-a",
    conversionEventId: "event-a",
    attributionId: "attr-a",
    campaignObjectId: "campaign-row-1",
    interactionOccurredAt: "2026-07-20T09:00:00Z",
  });

  await seedOrder("order-f", "9006", "30.00");
  await seedEvent("event-f", "external-event-f");
  await seedOrderResult("res-f", "order-f", "confirmed", "event-f");
  // Flow touch is the latest NON-BOT interaction -> primary.
  await seedClaim({
    id: "claim-f-flow",
    conversionEventId: "event-f",
    attributionId: "attr-f-flow",
    flowObjectId: "flow-row-1",
    interactionOccurredAt: "2026-07-21T11:00:00Z",
  });
  await seedClaim({
    id: "claim-f-camp-old",
    conversionEventId: "event-f",
    attributionId: "attr-f-camp-old",
    campaignObjectId: "campaign-row-1",
    interactionOccurredAt: "2026-07-19T08:00:00Z",
  });
  await seedClaim({
    id: "claim-f-camp-bot",
    conversionEventId: "event-f",
    attributionId: "attr-f-camp-bot",
    campaignObjectId: "campaign-row-1",
    interactionOccurredAt: "2026-07-21T11:30:00Z",
    botClick: 1,
  });

  await seedOrder("order-b", "9002", "10.00");
  await seedEvent("event-b", "external-event-b");
  await seedOrderResult("res-b", "order-b", "confirmed", "event-b");

  await seedOrder("order-c", "9003", "20.00");

  await seedOrder("order-d", "9004", "5.00");
  await seedOrderResult("res-d", "order-d", "no_klaviyo_event", null);

  await seedOrder("order-e", "9005", "7.25");
  await seedOrderResult("res-e", "order-e", "duplicate_conversion_events", null);
}

describeIfDb("Klaviyo email attribution aggregates on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    // A DROP DATABASE ... WITH (FORCE) from a leftover or concurrent run kills
    // idle clients, which surfaces as a pool-level error; without a listener
    // that crashes the worker even when every assertion passed.
    adminPool.on("error", () => {});
    testPool?.on("error", () => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await applyMatchFixture(testPool!);
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`,
      );
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE klaviyo_connection, shopify_store, organization
         RESTART IDENTITY CASCADE`,
    );
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
  });

  it("partitions every order into exactly one bucket and sums to the total", async () => {
    await seedAggregateWorld();
    const summary = await loadEmailAttribution({ scope, window });

    expect(summary.email).toEqual({
      revenue: "72.50",
      orderCount: 2,
      campaignsRevenue: "42.50",
      flowsRevenue: "30.00",
    });
    expect(summary.gaps.noEmailLink).toEqual({ orders: 1, revenue: "10.00" });
    expect(summary.gaps.notEvaluated).toEqual({ orders: 1, revenue: "20.00" });
    expect(summary.gaps.noKlaviyoEvent).toEqual({ orders: 1, revenue: "5.00" });
    expect(summary.gaps.duplicateFlagged).toEqual({ orders: 1, revenue: "7.25" });

    // Partition invariant: bucket revenues sum to the range total.
    const total =
      Number(summary.email.revenue) +
      Number(summary.gaps.noEmailLink.revenue) +
      Number(summary.gaps.notEvaluated.revenue) +
      Number(summary.gaps.noKlaviyoEvent.revenue) +
      Number(summary.gaps.duplicateFlagged.revenue);
    expect(total).toBeCloseTo(114.75, 2);
  });

  it("assigns sources by the last non-bot touch and names them from the graph", async () => {
    await seedAggregateWorld();
    const summary = await loadEmailAttribution({ scope, window });

    expect(summary.sources).toEqual([
      {
        objectId: "campaign-row-1",
        objectType: "campaign",
        name: "Summer Sale",
        orderCount: 1,
        revenue: "42.50",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
      {
        objectId: "flow-row-1",
        objectType: "flow",
        name: "Welcome",
        orderCount: 1,
        revenue: "30.00",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
    ]);
  });

  it("treats an order whose only claims are bot clicks as not email-linked", async () => {
    await seedPublishedRun();
    await seedMarketingObject("campaign-row-1", "campaign", "Summer Sale");
    await seedOrderResult("res-a", "order-a", "confirmed", "event-a");
    await seedClaim({
      id: "claim-bot-only",
      conversionEventId: "event-a",
      attributionId: "attr-bot",
      campaignObjectId: "campaign-row-1",
      interactionOccurredAt: "2026-07-20T09:00:00Z",
      botClick: 1,
    });
    const summary = await loadEmailAttribution({ scope, window });
    expect(summary.email.orderCount).toBe(0);
    expect(summary.gaps.noEmailLink).toEqual({ orders: 1, revenue: "42.50" });
  });

  it("returns empty aggregates for a window with no orders", async () => {
    const summary = await loadEmailAttribution({
      scope,
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-02-01T00:00:00.000Z"),
      },
    });
    expect(summary.email).toEqual({
      revenue: "0.00",
      orderCount: 0,
      campaignsRevenue: "0.00",
      flowsRevenue: "0.00",
    });
    expect(summary.sources).toEqual([]);
    expect(summary.gaps.notEvaluated).toEqual({ orders: 0, revenue: "0.00" });
  });
});
```

Money-string representation is pinned: every SQL revenue projection uses `round(..., 2)::text`, which Postgres always renders with two decimals (`"0.00"`, `"72.50"` — verified against the project's PG image). JS-side fallbacks and fixtures use the same two-decimal form.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --run src/lib/klaviyo/email-attribution.integration.test.ts`
Expected: FAIL — `Cannot find module '@/lib/klaviyo/email-attribution'` (or equivalent import error).

- [ ] **Step 3: Implement the loader**

Create `src/lib/klaviyo/email-attribution.ts`:

```ts
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import type { HalfOpenUtcWindow } from "@/lib/klaviyo/queries";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoMarketingObjects } from "@/schema/klaviyo-claim";

/**
 * Advisory read-only aggregates for the attribution page's email revenue
 * panel. Reads Shopify money and reads claims; never mutates buckets,
 * order rows, or match results. Every money value is summed in SQL and
 * travels as a numeric string.
 */

export type EmailAttributionBucket = { orders: number; revenue: string };

export type EmailAttributionSource = {
  objectId: string;
  objectType: "campaign" | "flow";
  name: string;
  orderCount: number;
  revenue: string;
  klaviyoConversionValue: string | null;
  klaviyoWindow: { requestedFrom: Date; requestedTo: Date; asOf: Date } | null;
};

export type EmailAttributionProduct = {
  productKey: string;
  title: string;
  units: number;
  orderCount: number;
  orderRevenue: string;
};

export type EmailAttributionSummary = {
  email: {
    revenue: string;
    orderCount: number;
    campaignsRevenue: string;
    flowsRevenue: string;
  };
  klaviyoSays: {
    conversionValue: string;
    requestedFrom: Date;
    requestedTo: Date;
    asOf: Date;
  } | null;
  sources: EmailAttributionSource[];
  products: EmailAttributionProduct[];
  gaps: {
    noEmailLink: EmailAttributionBucket;
    notEvaluated: EmailAttributionBucket;
    noKlaviyoEvent: EmailAttributionBucket;
    duplicateFlagged: EmailAttributionBucket;
    unmatchedEvents: number;
  };
};

const ZERO_BUCKET: EmailAttributionBucket = { orders: 0, revenue: "0.00" };

/**
 * A claim qualifies an order as email-linked when it points at a campaign
 * or flow and is not a bot click. `r` is the current (unsuperseded)
 * order-match-result alias in the enclosing query.
 */
const QUALIFYING_CLAIM = sql`
  select 1 from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1`;

/**
 * Last non-bot touch decides campaign-vs-flow assignment. Ties on
 * timestamp (or all-null timestamps) break deterministically on the
 * provider attribution id.
 */
const PRIMARY_CLAIM_LATERAL = sql`
  select case when c.campaign_object_id is not null then 'campaign'
              else 'flow' end as kind,
         coalesce(c.campaign_object_id, c.flow_object_id) as object_id
    from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1
   order by c.interaction_occurred_at desc nulls last,
            c.klaviyo_attribution_id desc
   limit 1`;

function emailLinkedFrom(scope: KlaviyoConnectionScope, window: HalfOpenUtcWindow) {
  return sql`
    from shopify_order o
    join klaviyo_order_match_result r
      on r.organization_id = o.organization_id
     and r.shopify_store_id = o.store_id
     and r.connection_id = ${scope.connectionId}
     and r.order_id = o.id
     and r.superseded_at is null
     and r.status = 'confirmed'
     and r.selected_event_id is not null
    cross join lateral (${PRIMARY_CLAIM_LATERAL}) pc
   where o.organization_id = ${scope.organizationId}
     and o.store_id = ${scope.storeId}
     and o.order_created_at >= ${window.from}
     and o.order_created_at < ${window.to}`;
}

export async function loadEmailAttribution(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
}): Promise<EmailAttributionSummary> {
  const { scope, window } = input;

  // 1. Partition: every order in range lands in exactly one bucket.
  const partition = await db.execute<{
    bucket: string;
    orders: number;
    revenue: string;
  }>(sql`
    select case
             when r.id is null then 'not_evaluated'
             when r.status = 'no_klaviyo_event' then 'no_klaviyo_event'
             when r.status = 'duplicate_conversion_events' then 'duplicate_flagged'
             when r.status = 'confirmed'
                  and r.selected_event_id is not null
                  and exists (${QUALIFYING_CLAIM}) then 'email_linked'
             else 'no_email_link'
           end as bucket,
           count(*)::int as orders,
           round(coalesce(sum(o.net_sales), 0), 2)::text as revenue
      from shopify_order o
      left join klaviyo_order_match_result r
        on r.organization_id = o.organization_id
       and r.shopify_store_id = o.store_id
       and r.connection_id = ${scope.connectionId}
       and r.order_id = o.id
       and r.superseded_at is null
     where o.organization_id = ${scope.organizationId}
       and o.store_id = ${scope.storeId}
       and o.order_created_at >= ${window.from}
       and o.order_created_at < ${window.to}
     group by 1`);

  const buckets = new Map(
    partition.rows.map((row) => [
      row.bucket,
      { orders: row.orders, revenue: row.revenue },
    ]),
  );
  const bucket = (key: string): EmailAttributionBucket =>
    buckets.get(key) ?? ZERO_BUCKET;

  // 2. Headline split, summed in SQL so money never crosses JS floats.
  const headline = await db.execute<{
    orders: number;
    revenue: string;
    campaigns_revenue: string;
    flows_revenue: string;
  }>(sql`
    select count(*)::int as orders,
           round(coalesce(sum(o.net_sales), 0), 2)::text as revenue,
           round(coalesce(sum(o.net_sales)
             filter (where pc.kind = 'campaign'), 0), 2)::text as campaigns_revenue,
           round(coalesce(sum(o.net_sales)
             filter (where pc.kind = 'flow'), 0), 2)::text as flows_revenue
    ${emailLinkedFrom(scope, window)}`);
  const head = headline.rows[0];

  // 3. Per-source rows by primary claim.
  const sourceRows = await db.execute<{
    kind: "campaign" | "flow";
    object_id: string;
    orders: number;
    revenue: string;
  }>(sql`
    select pc.kind, pc.object_id,
           count(*)::int as orders,
           round(coalesce(sum(o.net_sales), 0), 2)::text as revenue
    ${emailLinkedFrom(scope, window)}
     group by 1, 2
     order by sum(o.net_sales) desc, pc.object_id asc`);

  const objectIds = sourceRows.rows.map((row) => row.object_id);
  const objects = objectIds.length
    ? await db
        .select({
          id: klaviyoMarketingObjects.id,
          name: klaviyoMarketingObjects.name,
        })
        .from(klaviyoMarketingObjects)
        .where(
          and(
            eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
            inArray(klaviyoMarketingObjects.id, objectIds),
          ),
        )
    : [];
  const nameById = new Map(objects.map((object) => [object.id, object.name]));

  // 4. Klaviyo's own campaign report facts (current generation only) —
  // their windows travel with the numbers; nothing is re-sliced.
  const factRows = await db.execute<{
    campaign_object_id: string | null;
    conversion_value: string | null;
    requested_from: Date;
    requested_to: Date;
    as_of: Date;
  }>(sql`
    select f.campaign_object_id, f.conversion_value,
           f.requested_from, f.requested_to, f.as_of
      from klaviyo_report_fact f
      join klaviyo_report_generation g on g.id = f.generation_id
     where g.organization_id = ${scope.organizationId}
       and g.shopify_store_id = ${scope.storeId}
       and g.connection_id = ${scope.connectionId}
       and g.kind = 'campaign'
       and g.status = 'current'`);
  const factByCampaign = new Map(
    factRows.rows
      .filter((row) => row.campaign_object_id !== null)
      .map((row) => [row.campaign_object_id as string, row]),
  );
  const saysTotal = await db.execute<{
    conversion_value: string | null;
    requested_from: Date | null;
    requested_to: Date | null;
    as_of: Date | null;
  }>(sql`
    select round(sum(f.conversion_value), 2)::text as conversion_value,
           min(f.requested_from) as requested_from,
           max(f.requested_to) as requested_to,
           max(f.as_of) as as_of
      from klaviyo_report_fact f
      join klaviyo_report_generation g on g.id = f.generation_id
     where g.organization_id = ${scope.organizationId}
       and g.shopify_store_id = ${scope.storeId}
       and g.connection_id = ${scope.connectionId}
       and g.kind = 'campaign'
       and g.status = 'current'
       and f.conversion_value is not null`);
  const says = saysTotal.rows[0];

  // 5. Top products inside email-linked orders. shopify_order_line has no
  // money column, so "orderRevenue" is the summed net_sales of the linked
  // orders containing the product — an order with several products counts
  // toward each (labeled in the UI).
  // `emailLinkedFrom` ends in a WHERE clause, so the line join lives in a
  // CTE consumer, never appended after it.
  const productRows = await db.execute<{
    product_key: string;
    title: string;
    units: number;
    order_count: number;
    order_revenue: string;
  }>(sql`
    with linked as (
      select o.id as order_id, o.net_sales
      ${emailLinkedFrom(scope, window)}
    )
    select product_key,
           min(title) as title,
           sum(units)::int as units,
           count(*)::int as order_count,
           round(sum(net_sales), 2)::text as order_revenue
      from (
        select coalesce(l.shopify_product_id, 'title:' || l.product_title)
                 as product_key,
               min(l.product_title) as title,
               sum(l.quantity) as units,
               l.order_id,
               min(linked.net_sales) as net_sales
          from shopify_order_line l
          join linked on linked.order_id = l.order_id
         where l.organization_id = ${scope.organizationId}
           and l.store_id = ${scope.storeId}
         group by 1, l.order_id
      ) per_order
     group by product_key
     order by sum(net_sales) desc, product_key asc
     limit 10`);

  // 6. Range's non-confirmed placed-order events (same predicate as the
  // Lab's unmatched ledger).
  const unmatched = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
      from klaviyo_event e
      join klaviyo_metric m on m.id = e.metric_id
      left join klaviyo_event_match_result er
        on er.connection_id = e.connection_id
       and er.event_id = e.id
       and er.superseded_at is null
     where e.organization_id = ${scope.organizationId}
       and e.shopify_store_id = ${scope.storeId}
       and e.connection_id = ${scope.connectionId}
       and m.canonical_kind = 'placed_order'
       and e.occurred_at >= ${window.from}
       and e.occurred_at < ${window.to}
       and (er.status is null or er.status <> 'confirmed')`);

  return {
    email: {
      revenue: head?.revenue ?? "0",
      orderCount: head?.orders ?? 0,
      campaignsRevenue: head?.campaigns_revenue ?? "0",
      flowsRevenue: head?.flows_revenue ?? "0",
    },
    klaviyoSays:
      says?.conversion_value != null &&
      says.requested_from !== null &&
      says.requested_to !== null &&
      says.as_of !== null
        ? {
            conversionValue: says.conversion_value,
            requestedFrom: says.requested_from,
            requestedTo: says.requested_to,
            asOf: says.as_of,
          }
        : null,
    sources: sourceRows.rows.map((row) => {
      const fact = factByCampaign.get(row.object_id);
      return {
        objectId: row.object_id,
        objectType: row.kind,
        name: nameById.get(row.object_id) ?? "",
        orderCount: row.orders,
        revenue: row.revenue,
        klaviyoConversionValue:
          row.kind === "campaign" ? (fact?.conversion_value ?? null) : null,
        klaviyoWindow:
          row.kind === "campaign" && fact
            ? {
                requestedFrom: fact.requested_from,
                requestedTo: fact.requested_to,
                asOf: fact.as_of,
              }
            : null,
      };
    }),
    products: productRows.rows.map((row) => ({
      productKey: row.product_key,
      title: row.title,
      units: row.units,
      orderCount: row.order_count,
      orderRevenue: row.order_revenue,
    })),
    gaps: {
      noEmailLink: bucket("no_email_link"),
      notEvaluated: bucket("not_evaluated"),
      noKlaviyoEvent: bucket("no_klaviyo_event"),
      duplicateFlagged: bucket("duplicate_flagged"),
      unmatchedEvents: unmatched.rows[0]?.count ?? 0,
    },
  };
}
```

Two implementation notes:
- `db.execute<T>` with node-postgres returns `{ rows: T[] }`. If the generic form differs in this drizzle version, check how `db.execute` is used elsewhere or destructure `.rows` untyped and cast — do not silence with `any` on the whole result.
- `round(..., 2)::text` normalizes numeric scale so `"72.50"` never comes back `"72.5"`. Postgres `round(numeric, 2)` output like `72.50` keeps two decimals when cast to text **only when the value has them** — if the empty-window test fails on `"0.00"` vs `"0"`, normalize expectations to `"0.00"` in both the test and `ZERO_BUCKET`/fallbacks (pick one representation and use it everywhere).

- [ ] **Step 4: Run the tests until green**

Run: `npm run test -- --run src/lib/klaviyo/email-attribution.integration.test.ts`
Expected: PASS (4 tests). If the scale note above bites, fix representation consistently and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/lib/klaviyo/email-attribution.ts src/lib/klaviyo/email-attribution.integration.test.ts
git commit -m "feat(klaviyo): add email attribution aggregate loader"
```

---

### Task 2: Loader — Klaviyo-says facts and products coverage

Extend the integration test to cover report facts and the product join, exercising code already written in Task 1 (the loader is complete; this task proves the remaining paths).

**Files:**
- Modify: `src/lib/klaviyo/email-attribution.integration.test.ts`

- [ ] **Step 1: Add report-fact and product tests**

Append inside the `describeIfDb` block:

```ts
  async function seedCampaignReport(): Promise<void> {
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters)
       VALUES ('report-run-1', 'org-a', 'store-a', 'connection-a', 'reports',
         'manual', 'success', NULL, '{}')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_report_generation
         (id, organization_id, shopify_store_id, connection_id, sync_run_id,
          kind, requested_from, requested_to, account_timezone,
          publication_scope_fingerprint, refresh_fingerprint, status,
          published_at)
       VALUES ('gen-1', 'org-a', 'store-a', 'connection-a', 'report-run-1',
         'campaign', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z',
         'America/New_York', 'scope-fp-r', 'refresh-fp-r', 'current', now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_report_fact
         (id, organization_id, shopify_store_id, connection_id, generation_id,
          report_kind, conversion_metric_id, campaign_object_id,
          requested_from, requested_to, account_timezone, grouping,
          request_fingerprint, fact_fingerprint, conversions, conversion_value,
          additional_statistics, api_revision, as_of)
       VALUES ('fact-1', 'org-a', 'store-a', 'connection-a', 'gen-1',
         'campaign', 'metric-placed', 'campaign-row-1',
         '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z', 'America/New_York',
         '{}', 'req-fp-1', 'fact-fp-1', 3, 60.00, '{}', '2026-07-15',
         '2026-07-31T00:00:00Z')`,
    );
  }

  it("carries Klaviyo-reported conversion value with its own window", async () => {
    await seedAggregateWorld();
    await seedCampaignReport();
    const summary = await loadEmailAttribution({ scope, window });

    expect(summary.klaviyoSays).toMatchObject({ conversionValue: "60.00" });
    expect(summary.klaviyoSays?.requestedFrom).toBeInstanceOf(Date);
    const campaign = summary.sources.find(
      (source) => source.objectId === "campaign-row-1",
    );
    expect(campaign?.klaviyoConversionValue).toBe("60.00");
    expect(campaign?.klaviyoWindow).not.toBeNull();
    const flow = summary.sources.find(
      (source) => source.objectId === "flow-row-1",
    );
    expect(flow?.klaviyoConversionValue).toBeNull();
  });

  it("aggregates products over email-linked orders with order revenue", async () => {
    await seedAggregateWorld();
    // seedMatchWorld gave order-a line-a: product 77 "Product" qty 2.
    await testPool!.query(
      `INSERT INTO shopify_order_line
         (id, organization_id, store_id, order_id, shopify_line_item_id,
          shopify_product_id, product_title, quantity, parent_order_updated_at)
       VALUES
         ('line-f1', 'org-a', 'store-a', 'order-f', 'li-f1', '77', 'Product', 1, now()),
         ('line-f2', 'org-a', 'store-a', 'order-f', 'li-f2', '99', 'Other Thing', 4, now()),
         ('line-b1', 'org-a', 'store-a', 'order-b', 'li-b1', '77', 'Product', 9, now())`,
    );
    const summary = await loadEmailAttribution({ scope, window });

    // order-b is NOT email-linked; its 9 units never appear.
    expect(summary.products).toEqual([
      {
        productKey: "77",
        title: "Product",
        units: 3,
        orderCount: 2,
        orderRevenue: "72.50",
      },
      {
        productKey: "99",
        title: "Other Thing",
        units: 4,
        orderCount: 1,
        orderRevenue: "30.00",
      },
    ]);
  });

  it("counts non-confirmed placed-order events in range as unmatched", async () => {
    await seedAggregateWorld();
    // event-a and event-f have no confirmed event-match-result rows in this
    // world (order results were inserted directly), plus one extra stray.
    await seedEvent("event-x", "external-event-x");
    const summary = await loadEmailAttribution({ scope, window });
    expect(summary.gaps.unmatchedEvents).toBe(3);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm run test -- --run src/lib/klaviyo/email-attribution.integration.test.ts`
Expected: PASS (7 tests). These paths were implemented in Task 1; failures here mean the loader's fact/product SQL is wrong — fix the loader, not the test, unless the seed itself contradicts a schema constraint (then read the schema file and correct the seed).

- [ ] **Step 3: Commit**

```bash
git add src/lib/klaviyo/email-attribution.integration.test.ts
git commit -m "test(klaviyo): cover report facts, products, and unmatched events in email attribution"
```

---

### Task 3: Router procedure + RBAC coverage

**Files:**
- Modify: `src/lib/trpc/routers/klaviyo.ts`
- Modify: `src/lib/trpc/routers/klaviyo.test.ts`

- [ ] **Step 1: Add the failing router test wiring**

In `src/lib/trpc/routers/klaviyo.test.ts`:

1. Add to the `vi.hoisted` mocks object (alongside `loadEvidenceCoverage`):

```ts
    loadEmailAttribution: vi.fn(),
```

2. Add a module mock next to the `@/lib/klaviyo/queries` mock:

```ts
vi.mock("@/lib/klaviyo/email-attribution", () => ({
  loadEmailAttribution: mocks.loadEmailAttribution,
}));
```

3. Find the `PROCEDURE_CALLS` table (it lists `[name, call]` pairs; the `coverage` entry is the model) and add:

```ts
  [
    "emailAttribution",
    (caller) =>
      caller.emailAttribution({ dateFrom: "2026-08-01", dateTo: "2026-08-04" }),
  ],
```

4. Wherever the suite primes query mocks so the owner/admin loop resolves (the `beforeEach` that does `mocks.loadEvidenceCoverage.mockResolvedValue(...)` or the shared reset block), add:

```ts
    mocks.loadEmailAttribution.mockResolvedValue({
      email: {
        revenue: "0.00",
        orderCount: 0,
        campaignsRevenue: "0.00",
        flowsRevenue: "0.00",
      },
      klaviyoSays: null,
      sources: [],
      products: [],
      gaps: {
        noEmailLink: { orders: 0, revenue: "0.00" },
        notEvaluated: { orders: 0, revenue: "0.00" },
        noKlaviyoEvent: { orders: 0, revenue: "0.00" },
        duplicateFlagged: { orders: 0, revenue: "0.00" },
        unmatchedEvents: 0,
      },
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/trpc/routers/klaviyo.test.ts`
Expected: FAIL — `caller.emailAttribution is not a function`.

- [ ] **Step 3: Add the procedure**

In `src/lib/trpc/routers/klaviyo.ts`, import the loader next to the other query imports:

```ts
import { loadEmailAttribution } from "@/lib/klaviyo/email-attribution";
```

Add the procedure directly after the existing `coverage` procedure (it is the same shape):

```ts
  emailAttribution: orgAdminProcedure
    .input(z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema }))
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        ...input,
        timeZone: connection.storeTimezone,
      });
      return loadEmailAttribution({ scope: connection, window });
    }),
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- --run src/lib/trpc/routers/klaviyo.test.ts`
Expected: PASS — the two RBAC loop tests now also prove member/API-key/worker are FORBIDDEN and owner/admin pass for `emailAttribution`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(klaviyo): expose emailAttribution aggregate procedure"
```

---

### Task 4: Panel copy and presentational components

**Files:**
- Modify: `src/components/blocks/attribution/klaviyo/copy.ts`
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx`
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-tables.tsx`
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-gaps.tsx`
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx`

- [ ] **Step 1: Add copy**

Append to `src/components/blocks/attribution/klaviyo/copy.ts`:

```ts
export const emailRevenue = {
  title: "Email revenue · Klaviyo",
  freshness: (publishedAgo: string) => `matches published ${publishedAgo}`,
  netSales: "Shopify net sales",
  linked: (percent: string, orders: number) =>
    `Tied to email · ${percent} · ${orders} order${orders === 1 ? "" : "s"}`,
  says: "Klaviyo says",
  saysUnconfirmed: (amount: string) => `+${amount} unconfirmed`,
  saysWindowNote:
    "“Klaviyo says” is their report over each campaign’s own window, not this date range",
  segCampaigns: (amount: string) => `Campaigns ${amount}`,
  segFlows: (amount: string) => `Flows ${amount}`,
  segRest: (amount: string) => `Everything else ${amount}`,
  sourcesHeading: "By campaign & flow — we confirm vs Klaviyo says",
  productsHeading: "Top products in email-linked orders",
  productsRevenueNote:
    "Order revenue: net sales of email-linked orders containing the product; an order with several products counts toward each",
  gapsLead: "Where the rest is:",
  gapNoEmailLink: (orders: number) =>
    `${orders} order${orders === 1 ? "" : "s"} had a Klaviyo event but no campaign/flow link`,
  gapNotEvaluated: (orders: number) =>
    `${orders} not evaluated yet (newer than evidence)`,
  gapNoEvent: (orders: number) =>
    `${orders} with no Klaviyo event at all`,
  gapDuplicates: (orders: number) =>
    `${orders} flagged for duplicate conversion events`,
  gapUnmatched: (count: number) =>
    `${count} Klaviyo event${count === 1 ? "" : "s"} matched no order`,
  noDataYet: "No data yet",
  error: "Couldn’t load email revenue.",
  retry: "Retry",
} as const;
```

- [ ] **Step 2: Write failing component tests**

Create `src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailRevenueHeadline } from "./email-revenue-panel";
import { EmailRevenueGaps } from "./email-revenue-gaps";
import { EmailRevenueTables } from "./email-revenue-tables";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";

function summary(
  overrides: Partial<EmailAttributionSummary> = {},
): EmailAttributionSummary {
  return {
    email: {
      revenue: "1000.00",
      orderCount: 62,
      campaignsRevenue: "620.00",
      flowsRevenue: "380.00",
    },
    klaviyoSays: {
      conversionValue: "1450.00",
      requestedFrom: new Date("2026-06-01T00:00:00Z"),
      requestedTo: new Date("2026-08-01T00:00:00Z"),
      asOf: new Date("2026-08-01T00:00:00Z"),
    },
    sources: [
      {
        objectId: "campaign-1",
        objectType: "campaign",
        name: "Summer Sale",
        orderCount: 21,
        revenue: "340.00",
        klaviyoConversionValue: "505.00",
        klaviyoWindow: {
          requestedFrom: new Date("2026-06-01T00:00:00Z"),
          requestedTo: new Date("2026-08-01T00:00:00Z"),
          asOf: new Date("2026-08-01T00:00:00Z"),
        },
      },
      {
        objectId: "flow-1",
        objectType: "flow",
        name: "Welcome",
        orderCount: 17,
        revenue: "280.00",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
    ],
    products: [
      {
        productKey: "77",
        title: "Collagen Peptides 500g",
        units: 31,
        orderCount: 28,
        orderRevenue: "430.00",
      },
    ],
    gaps: {
      noEmailLink: { orders: 480, revenue: "8300.00" },
      notEvaluated: { orders: 22, revenue: "410.00" },
      noKlaviyoEvent: { orders: 14, revenue: "290.00" },
      duplicateFlagged: { orders: 2, revenue: "18.00" },
      unmatchedEvents: 141,
    },
    ...overrides,
  };
}

describe("EmailRevenueHeadline", () => {
  it("shows the KPI trio with share percent and the unconfirmed delta", () => {
    render(
      <EmailRevenueHeadline
        summary={summary()}
        shopifyTotal="10000.00"
        currency="USD"
      />,
    );
    expect(screen.getByTestId("email-linked-revenue")).toHaveTextContent(
      "$1,000.00",
    );
    expect(screen.getByTestId("email-linked-label")).toHaveTextContent("10%");
    expect(screen.getByTestId("email-linked-label")).toHaveTextContent(
      "62 orders",
    );
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$1,450.00");
    expect(screen.getByTestId("klaviyo-says-delta")).toHaveTextContent(
      "unconfirmed",
    );
  });

  it("omits the Klaviyo-says figure when no report exists", () => {
    render(
      <EmailRevenueHeadline
        summary={summary({ klaviyoSays: null })}
        shopifyTotal="10000.00"
        currency="USD"
      />,
    );
    expect(screen.queryByTestId("klaviyo-says-delta")).toBeNull();
  });
});

describe("EmailRevenueTables", () => {
  it("renders sources with their kind and Klaviyo comparison, dash for flows", () => {
    render(<EmailRevenueTables summary={summary()} currency="USD" />);
    expect(screen.getByText("Summer Sale")).toBeInTheDocument();
    expect(screen.getByTestId("source-campaign-1-says")).toHaveTextContent(
      "$505.00",
    );
    expect(screen.getByTestId("source-flow-1-says")).toHaveTextContent("—");
    expect(screen.getByText("Collagen Peptides 500g")).toBeInTheDocument();
  });
});

describe("EmailRevenueGaps", () => {
  it("accounts for every remaining bucket and deep-links into the Lab", () => {
    render(
      <EmailRevenueGaps
        summary={summary()}
        currency="USD"
        dateFrom="2026-05-14"
        dateTo="2026-08-11"
      />,
    );
    expect(screen.getByTestId("gap-no-email-link")).toHaveTextContent("480");
    expect(screen.getByTestId("gap-no-email-link")).toHaveTextContent(
      "$8,300.00",
    );
    const link = screen.getByTestId("gap-no-email-link-href");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/attribution/klaviyo?"),
    );
    expect(link.getAttribute("href")).toContain("orderStatus=confirmed");
    expect(link.getAttribute("href")).toContain("claimType=none");
    expect(link.getAttribute("href")).toContain("from=2026-05-14");
    expect(
      screen.getByTestId("gap-unmatched-href").getAttribute("href"),
    ).toContain("view=unmatched");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 4: Implement the presentational components**

Create `src/components/blocks/attribution/klaviyo/email-revenue-tables.tsx`:

```tsx
"use client";

import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { emailRevenue as copy } from "./copy";

const headCell =
  "px-2 py-1 text-left text-[9px] uppercase tracking-[0.07em] text-muted-foreground";
const cell = "border-b border-border/40 px-2 py-1 text-[11px]";
const numCell = `${cell} text-right tabular-nums`;

export function EmailRevenueTables({
  summary,
  currency,
}: {
  summary: EmailAttributionSummary;
  currency: string;
}) {
  return (
    <div className="flex flex-wrap gap-4">
      <div className="min-w-[260px] flex-1">
        <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {copy.sourcesHeading}
        </p>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={headCell}>Source</th>
              <th className={`${headCell} text-right`}>Orders</th>
              <th className={`${headCell} text-right`}>We confirm</th>
              <th className={`${headCell} text-right`}>Klaviyo says</th>
            </tr>
          </thead>
          <tbody>
            {summary.sources.map((source) => (
              <tr key={`${source.objectType}:${source.objectId}`}>
                <td className={cell}>
                  {source.name || source.objectId}{" "}
                  <span className="text-muted-foreground">
                    {source.objectType}
                  </span>
                </td>
                <td className={numCell}>{source.orderCount}</td>
                <td className={numCell}>
                  {formatMoneyExact(source.revenue, currency)}
                </td>
                <td
                  className={numCell}
                  data-testid={`source-${source.objectId}-says`}
                >
                  {source.klaviyoConversionValue === null
                    ? "—"
                    : formatMoneyExact(source.klaviyoConversionValue, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          {copy.saysWindowNote}
        </p>
      </div>
      <div className="min-w-[260px] flex-1">
        <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {copy.productsHeading}
        </p>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={headCell}>Product</th>
              <th className={`${headCell} text-right`}>Units</th>
              <th className={`${headCell} text-right`}>Orders</th>
              <th className={`${headCell} text-right`}>Order revenue</th>
            </tr>
          </thead>
          <tbody>
            {summary.products.map((product) => (
              <tr key={product.productKey}>
                <td className={cell}>{product.title}</td>
                <td className={numCell}>{product.units}</td>
                <td className={numCell}>{product.orderCount}</td>
                <td className={numCell}>
                  {formatMoneyExact(product.orderRevenue, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          {copy.productsRevenueNote}
        </p>
      </div>
    </div>
  );
}
```

Create `src/components/blocks/attribution/klaviyo/email-revenue-gaps.tsx`:

```tsx
"use client";

import Link from "next/link";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { emailRevenue as copy } from "./copy";

function labUrl(
  params: Record<string, string>,
  range: { dateFrom: string; dateTo: string },
): string {
  const search = new URLSearchParams({
    range: "custom",
    from: range.dateFrom,
    to: range.dateTo,
    ...params,
  });
  return `/attribution/klaviyo?${search.toString()}`;
}

export function EmailRevenueGaps({
  summary,
  currency,
  dateFrom,
  dateTo,
}: {
  summary: EmailAttributionSummary;
  currency: string;
  dateFrom: string;
  dateTo: string;
}) {
  const range = { dateFrom, dateTo };
  const { gaps } = summary;
  const entries: Array<{
    key: string;
    text: string;
    revenue: string | null;
    href: string;
  }> = [
    {
      key: "no-email-link",
      text: copy.gapNoEmailLink(gaps.noEmailLink.orders),
      revenue: gaps.noEmailLink.revenue,
      href: labUrl(
        { view: "orders", orderStatus: "confirmed", claimType: "none" },
        range,
      ),
    },
    {
      key: "not-evaluated",
      text: copy.gapNotEvaluated(gaps.notEvaluated.orders),
      revenue: gaps.notEvaluated.revenue,
      href: labUrl({ view: "orders", orderStatus: "not_evaluated" }, range),
    },
    {
      key: "no-event",
      text: copy.gapNoEvent(gaps.noKlaviyoEvent.orders),
      revenue: gaps.noKlaviyoEvent.revenue,
      href: labUrl({ view: "orders", orderStatus: "no_klaviyo_event" }, range),
    },
    {
      key: "duplicates",
      text: copy.gapDuplicates(gaps.duplicateFlagged.orders),
      revenue: gaps.duplicateFlagged.revenue,
      href: labUrl(
        { view: "orders", orderStatus: "duplicate_conversion_events" },
        range,
      ),
    },
    {
      key: "unmatched",
      text: copy.gapUnmatched(gaps.unmatchedEvents),
      revenue: null,
      href: labUrl({ view: "unmatched" }, range),
    },
  ];
  return (
    <div className="mt-3 rounded-md border border-dashed border-amber-600/40 bg-amber-600/5 px-3 py-2 text-[11px]">
      <span className="font-medium">{copy.gapsLead}</span>{" "}
      {entries.map((entry, index) => (
        <span key={entry.key} data-testid={`gap-${entry.key}`}>
          {index > 0 ? " · " : " "}
          {entry.revenue !== null
            ? `${formatMoneyExact(entry.revenue, currency)} · `
            : ""}
          {entry.text}{" "}
          <Link
            className="text-muted-foreground underline-offset-2 hover:underline"
            data-testid={`gap-${entry.key}-href`}
            href={entry.href}
          >
            ▸
          </Link>
        </span>
      ))}
    </div>
  );
}
```

Create `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx` (headline now; the container comes in Task 5 in this same file):

```tsx
"use client";

import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { emailRevenue as copy } from "./copy";

function percentOf(part: string, total: string): string {
  const totalNumber = Number(total);
  if (!Number.isFinite(totalNumber) || totalNumber <= 0) return "0%";
  return `${Math.round((Number(part) / totalNumber) * 100)}%`;
}

/** Width helper for the share bar; display-only, never money math. */
function widthPercent(part: string, total: string): number {
  const totalNumber = Number(total);
  if (!Number.isFinite(totalNumber) || totalNumber <= 0) return 0;
  return Math.min(100, Math.max(0, (Number(part) / totalNumber) * 100));
}

export function EmailRevenueHeadline({
  summary,
  shopifyTotal,
  currency,
}: {
  summary: EmailAttributionSummary;
  shopifyTotal: string;
  currency: string;
}) {
  const { email, klaviyoSays } = summary;
  const delta =
    klaviyoSays === null
      ? null
      : Number(klaviyoSays.conversionValue) - Number(email.revenue);
  const campaignsWidth = widthPercent(email.campaignsRevenue, shopifyTotal);
  const flowsWidth = widthPercent(email.flowsRevenue, shopifyTotal);
  const restRevenue = Math.max(0, Number(shopifyTotal) - Number(email.revenue));
  return (
    <div>
      <div className="flex flex-wrap gap-x-7 gap-y-2">
        <div>
          <p className="text-[20px] font-semibold tabular-nums">
            {formatMoneyExact(shopifyTotal, currency)}
          </p>
          <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {copy.netSales}
          </p>
        </div>
        <div>
          <p
            className="text-[20px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-500"
            data-testid="email-linked-revenue"
          >
            {formatMoneyExact(email.revenue, currency)}
          </p>
          <p
            className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="email-linked-label"
          >
            {copy.linked(
              percentOf(email.revenue, shopifyTotal),
              email.orderCount,
            )}
          </p>
        </div>
        {klaviyoSays !== null ? (
          <div>
            <p
              className="text-[20px] font-semibold tabular-nums"
              data-testid="klaviyo-says"
            >
              {formatMoneyExact(klaviyoSays.conversionValue, currency)}
            </p>
            <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {copy.says}
              {delta !== null && delta > 0 ? (
                <span
                  className="ml-1 text-amber-600"
                  data-testid="klaviyo-says-delta"
                >
                  · {copy.saysUnconfirmed(formatMoneyExact(delta, currency))}
                </span>
              ) : null}
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 flex h-5 overflow-hidden rounded">
        <div
          className="bg-emerald-600"
          style={{ width: `${campaignsWidth}%` }}
        />
        <div
          className="bg-emerald-600/50"
          style={{ width: `${flowsWidth}%` }}
        />
        <div className="flex-1 bg-muted" />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-2 rounded-[2px] bg-emerald-600" />
          {copy.segCampaigns(formatMoneyExact(email.campaignsRevenue, currency))}
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-[2px] bg-emerald-600/50" />
          {copy.segFlows(formatMoneyExact(email.flowsRevenue, currency))}
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-[2px] bg-muted" />
          {copy.segRest(formatMoneyExact(restRevenue, currency))}
        </span>
      </div>
    </div>
  );
}
```

If `formatMoneyExact` rejects a `number` argument (check its signature in `src/components/blocks/attribution/format.ts`), wrap with `String(delta)` / `String(restRevenue)` — do not change `format.ts`.

- [ ] **Step 5: Run component tests**

Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx`
Expected: PASS (5 tests). Adjust `data-testid` placement, not test intent, if a matcher misses.

- [ ] **Step 6: Commit**

```bash
git add src/components/blocks/attribution/klaviyo/copy.ts src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx src/components/blocks/attribution/klaviyo/email-revenue-tables.tsx src/components/blocks/attribution/klaviyo/email-revenue-gaps.tsx src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx
git commit -m "feat(klaviyo): email revenue panel presentational components"
```

---

### Task 5: Container + page wiring

**Files:**
- Modify: `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx` (append container)
- Modify: `src/app/(protected)/attribution/page.tsx`

- [ ] **Step 1: Append the container to `email-revenue-panel.tsx`**

Add imports at the top of the file:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { useTRPC } from "@/lib/trpc/client";
import { EmailRevenueGaps } from "./email-revenue-gaps";
import { EmailRevenueTables } from "./email-revenue-tables";
```

Append the container component:

```tsx
/**
 * Privileged-only panel: hiding it is UX; `orgAdminProcedure` on the
 * queries remains the security boundary (same stance as KlaviyoLabLink).
 * NOT_FOUND means no pilot connection — the section renders nothing.
 */
export function EmailRevenuePanel({
  role,
  dateFrom,
  dateTo,
  currency,
  shopifyTotal,
}: {
  role: string | null;
  dateFrom: string;
  dateTo: string;
  currency: string;
  shopifyTotal: string | null;
}) {
  const trpc = useTRPC();
  const privileged = isPrivilegedOrgRole(
    role as Parameters<typeof isPrivilegedOrgRole>[0],
  );
  const attribution = useQuery({
    ...trpc.klaviyo.emailAttribution.queryOptions({ dateFrom, dateTo }),
    enabled: privileged,
    retry: false,
  });
  const health = useQuery({
    ...trpc.klaviyo.health.queryOptions(),
    enabled: privileged,
    retry: false,
  });

  if (!privileged) return null;
  if (attribution.error?.data?.code === "NOT_FOUND") return null;

  const connectionReady =
    health.data?.connection?.status === "ready" || health.data == null;
  const publishedAt = health.data?.connection?.lastMatchPublishedAt ?? null;

  return (
    <section className="rounded-md border border-border bg-card px-3 py-3 sm:px-4">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold tracking-tight">
          {copy.title}
        </h2>
        {publishedAt !== null ? (
          <span className="text-[10px] text-muted-foreground/70">
            {copy.freshness(new Date(publishedAt).toLocaleString())}
          </span>
        ) : null}
      </div>
      {attribution.isPending || shopifyTotal === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : attribution.isError ? (
        <p className="text-[11px] text-muted-foreground">
          {copy.error}{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void attribution.refetch()}
          >
            {copy.retry}
          </Button>
        </p>
      ) : !connectionReady ? (
        <p className="text-[11px] text-muted-foreground">{copy.noDataYet}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <EmailRevenueHeadline
            summary={attribution.data}
            shopifyTotal={shopifyTotal}
            currency={currency}
          />
          <EmailRevenueTables summary={attribution.data} currency={currency} />
          <EmailRevenueGaps
            summary={attribution.data}
            currency={currency}
            dateFrom={dateFrom}
            dateTo={dateTo}
          />
        </div>
      )}
    </section>
  );
}
```

Check the actual `klaviyo.health` response shape in `getKlaviyoHealthForOrganization` (`src/lib/klaviyo/source-store.ts:2070`) — the connection object carries `status` and `lastMatchPublishedAt`; adjust property paths if they differ (e.g. `health.data.connection` may be `null` before discovery — the code above already tolerates that). If `attribution.error?.data?.code` is not typed on the client error, use `(attribution.error as { data?: { code?: string } } | null)?.data?.code`.

- [ ] **Step 2: Mount on the attribution page**

In `src/app/(protected)/attribution/page.tsx`:

1. Import next to `KlaviyoLabLink`:

```tsx
import { EmailRevenuePanel } from "@/components/blocks/attribution/klaviyo/email-revenue-panel";
```

2. Between the closing `</section>` of the ledger block and `<DetailFolds`, insert:

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
```

(`data` is the existing `overview.data` alias in the page — the panel's Shopify total is the very number the header rail shows.)

- [ ] **Step 3: Typecheck, lint, re-run component tests, and dev smoke**

Run: `npx tsc --noEmit` — expected: clean.
Run: `bun run lint` — expected: clean (watch for the icon-import rule).
Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/email-revenue-panel.component.test.tsx` — expected: still PASS. The test file imports from `./email-revenue-panel`, which now also carries the container's `@/lib/trpc/client` import; this run proves the module still loads under jsdom.
Optional but recommended: `bun dev` (or `./.bun/bin/bun dev`), open `/attribution` as an owner/admin with the pilot connection configured, and confirm: panel renders between ledger and folds, member accounts see nothing, range chips re-scope it.

- [ ] **Step 4: Commit**

```bash
git add src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx src/app/\(protected\)/attribution/page.tsx
git commit -m "feat(attribution): mount Klaviyo email revenue panel"
```

---

### Task 6: Full verification

**Files:** none new.

- [ ] **Step 1: Run everything**

```bash
npm run test            # 72+ files; all green
npm run test:components # all green
npx tsc --noEmit
bun run lint
```

Expected: all pass. The integration file self-skips when no `DATABASE_URL` is resolvable, so also confirm it actually ran (look for `email-attribution.integration.test.ts` in the output with a test count, not "skipped").

- [ ] **Step 2: Commit anything outstanding and stop**

```bash
git status   # should be clean; commit stragglers with a conventional title if any
```

Do not push or open a PR unless the user asked; report status instead.

---

## Self-review checklist (already applied)

- **Spec coverage:** headline totals (Task 1/4), campaign-flow table + Klaviyo-says (Tasks 2/4), products (Tasks 2/4), gap diagnostics + deep links (Tasks 1/4), partition invariant test (Task 1), RBAC (Task 3), page mount + range obedience (Task 5), error/no-data states (Task 5), timezone separation (loader keeps report windows verbatim; order window comes from `inclusiveStoreDaysToHalfOpenUtc` on the store timezone).
- **Known judgment calls recorded:** product order-revenue definition, `noEmailLink` bucket naming, health-based freshness instead of a `connection` payload field. Member non-render is a one-line gate (`if (!privileged) return null`) verified in the Task 5 smoke; the security boundary is the router RBAC loop test (Task 3), not the component — the container cannot be rendered under jsdom without a tRPC provider, so it gets no component test.
- **Type consistency:** `EmailAttributionSummary` defined once in `email-attribution.ts`; component tests and components import that type; router returns the loader result untouched.
