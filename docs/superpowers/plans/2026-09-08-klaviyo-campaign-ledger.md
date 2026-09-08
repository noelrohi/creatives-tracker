# Klaviyo Campaign Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Klaviyo Lab's Reports view with a Meta-style campaign ledger: every campaign and flow as a sortable row (Recipients, Delivered, Open, Click, Orders, We confirm, Klaviyo says, Unsub), expandable to its messages, with a one-third-width detail sheet showing funnel, revenue reconciliation, list impact, orders by day, top products, and variants.

**Architecture:** Extend the existing report pipeline (four new statistics, two new per-message report kinds sent with an explicit `group_by`, a grouping-unsupported fallback), add `sent_at` and `subject` to the marketing hierarchy, and build one loader module (`campaign-ledger.ts`) that joins the hierarchy, the current report generations, and our claims-derived confirmed orders under the send-time row rule. Three admin-only `klaviyo.ledger.*` queries feed a new `ledger/` component folder in the lab.

**Tech Stack:** Next.js 16 App Router, tRPC 11, Drizzle ORM (node-postgres), Trigger.dev v4, Vitest 4 (`npm run test`, `npm run test:components`), nuqs, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-08-klaviyo-campaign-ledger-design.md`

## Global Constraints

- Branch `feat/klaviyo-campaign-ledger`, based on `origin/main`. Conventional-commit **titles only** — no body, no trailers.
- Run tests with `npm run test` (never `bun test`); component tests with `npm run test:components`; typecheck with `npx tsc --noEmit`; lint touched files with `npx eslint <files>`.
- Integration tests need `DATABASE_URL` from `.env`: `export DATABASE_URL="$(grep -m1 '^DATABASE_URL' .env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')"` before running them. Never print secrets; never stage `.gitignore`.
- Icons come from `@/components/icons` (`lucide-react` is blocked by lint).
- Money is summed and rounded in SQL and travels as a two-decimal string; counts are integers; rates are `number | null`, never formatted in a loader.
- Rates use Klaviyo's definitions: delivered ÷ recipients; opens, clicks, unsubscribes each ÷ delivered; `null` when the denominator is null or zero.
- Row rule: a campaign appears when `sent_at` is inside the account-timezone window and carries every confirmed order whose primary claim names it, with no order-date filter. A flow appears when it has a current fact or a confirmed order in the window, and carries orders whose primary claim's `interaction_occurred_at` is in the window.
- The parent report kinds `campaign` and `flow` still send **no** grouping on the wire; only `campaign_message` / `flow_message` send `group_by`.
- Every id crossing the wire is our internal row id. All new queries use `orgAdminProcedure`. No new mutations.
- Raw `Date` parameters never go into raw `sql` templates against naive-UTC timestamp columns; use `utcTimestamp()` (`toISOString()::timestamp`).
- `db:push` is disabled; generate with `bun run db:generate --name klaviyo_campaign_ledger` and verify with `node scripts/check-migrations.mjs`.

## File Structure

**Schema / migration**
- Modify `src/schema/klaviyo-claim.ts` — `reportKinds` widened; `sent_at`/`subject` on `klaviyo_marketing_object`; four statistic columns on `klaviyo_report_fact`; `failure_reason` on `klaviyo_report_generation`; widened kind checks.
- Create `drizzle/0074_klaviyo_campaign_ledger.sql` (+ `drizzle/meta/0074_snapshot.json`, journal entry) via `db:generate`.
- Modify `src/lib/klaviyo/match-test-harness.ts` — `applyMatchFixture` applies 0074.

**Report pipeline**
- Modify `src/lib/klaviyo/reports.ts` — kinds, statistics, groupings, endpoint/grouping helpers, wider `NormalizedReportFact`.
- Modify `src/lib/klaviyo/client.ts` — `queryValuesReport` serializes `group_by` for message kinds; `listCampaigns` requests `send_time,scheduled_at`.
- Modify `src/lib/klaviyo/report-repository.ts` — per-kind grouping, message-object resolution, new columns, grouping-unsupported fallback, window-keyed supersession.
- Modify `trigger/klaviyo-incremental.ts` — nightly refresh requests all four kinds through the account timezone.
- Modify `src/lib/trpc/routers/klaviyo.ts` — `refreshReports` accepts four kinds; `reports` procedure removed; `orders` gains `sourceObjectId`; new `ledger` sub-router.

**Dimensions**
- Modify `src/lib/klaviyo/dimensions.ts` — `sentAt`, `subject` normalization (dotted definition paths).
- Modify `src/lib/klaviyo/dimension-repository.ts` — upsert writes the two columns.

**Loaders**
- Create `src/lib/klaviyo/email-link-sql.ts` — shared `utcTimestamp`, `QUALIFYING_CLAIM`, `PRIMARY_CLAIM_LATERAL`, `emailLinkJoin` (moved out of `email-attribution.ts`).
- Create `src/lib/klaviyo/campaign-ledger.ts` — `ledgerRates`, `loadLedgerRows`, `loadLedgerMessages`, `loadLedgerDetail`.
- Modify `src/lib/klaviyo/queries.ts` — `sourceObjectId` predicate on `listEvidenceOrders`.

**UI** (`src/components/blocks/attribution/klaviyo/`)
- Modify `copy.ts`, `use-klaviyo-lab-state.ts`, `filter-bar.tsx`, `klaviyo-playground.tsx`.
- Delete `reports-table.tsx` and its tests in `evidence-views.component.test.tsx`.
- Create `ledger/ledger-types.ts`, `ledger/ledger-format.ts`, `ledger/ledger-sort.ts`, `ledger/ledger-row.tsx`, `ledger/ledger-table.tsx`, `ledger/ledger-message-rows.tsx`, `ledger/ledger-funnel.tsx`, `ledger/ledger-day-bars.tsx`, `ledger/ledger-detail-content.tsx`, `ledger/ledger-detail-sheet.tsx`, plus `ledger/ledger-table.component.test.tsx`, `ledger/ledger-detail-content.component.test.tsx`, `ledger/ledger-sort.test.ts`.

---

### Task 1: Schema columns, widened report kinds, migration 0074

**Files:**
- Modify: `src/schema/klaviyo-claim.ts:65-66` (report kinds), `:81-145` (marketing object), `:610-704` (generation), `:711-823` (fact)
- Create: `drizzle/0074_klaviyo_campaign_ledger.sql` (generated)
- Modify: `src/lib/klaviyo/match-test-harness.ts:100-113`, `src/lib/klaviyo/report-repository.integration.test.ts:160-172`, `src/lib/klaviyo/claims-reporting-isolation.integration.test.ts` (its migration list)
- Test: `src/lib/klaviyo/schema-contract.test.ts`

**Interfaces:**
- Produces: `reportKinds = ["campaign","flow","campaign_message","flow_message"]` and `ReportKind`; columns `klaviyoMarketingObjects.sentAt`, `.subject`; `klaviyoReportFacts.delivered`, `.bounced`, `.unsubscribes`, `.spamComplaints`; `klaviyoReportGenerations.failureReason`.

- [ ] **Step 1: Write the failing schema-contract test**

Append to `src/lib/klaviyo/schema-contract.test.ts` inside the existing `describe("Klaviyo source schema", ...)` block:

```ts
  it("exposes the campaign ledger columns and four report kinds", async () => {
    const claim = await import("@/schema/klaviyo-claim");
    expect([...claim.reportKinds]).toEqual([
      "campaign",
      "flow",
      "campaign_message",
      "flow_message",
    ]);
    expect(claim.klaviyoMarketingObjects.sentAt.name).toBe("sent_at");
    expect(claim.klaviyoMarketingObjects.subject.name).toBe("subject");
    expect(claim.klaviyoReportFacts.delivered.name).toBe("delivered");
    expect(claim.klaviyoReportFacts.bounced.name).toBe("bounced");
    expect(claim.klaviyoReportFacts.unsubscribes.name).toBe("unsubscribes");
    expect(claim.klaviyoReportFacts.spamComplaints.name).toBe("spam_complaints");
    expect(claim.klaviyoReportGenerations.failureReason.name).toBe(
      "failure_reason",
    );
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- --run src/lib/klaviyo/schema-contract.test.ts -t "campaign ledger columns"`
Expected: FAIL — `reportKinds` has two entries and `sentAt` is undefined.

- [ ] **Step 3: Widen the schema**

In `src/schema/klaviyo-claim.ts`:

```ts
export const reportKinds = [
  "campaign",
  "flow",
  "campaign_message",
  "flow_message",
] as const;
export type ReportKind = (typeof reportKinds)[number];
```

In `klaviyoMarketingObjects`, after `providerUpdatedAt`:

```ts
    /** Campaigns only: Klaviyo `send_time`, else `scheduled_at`; null for drafts and flows. */
    sentAt: timestamp("sent_at"),
    /** Message rows only: the subject line inside the message definition. */
    subject: text("subject"),
```

In `klaviyoReportGenerations`, after `factCount`:

```ts
    /** Set only on `failed`; `grouping_unsupported` when the revision rejected a message grouping. */
    failureReason: text("failure_reason"),
```

and replace its kind check:

```ts
    check(
      "klaviyo_report_generation_kind_check",
      sql`(${table.kind})::text in ('campaign', 'flow', 'campaign_message', 'flow_message')`,
    ),
```

In `klaviyoReportFacts`, after `uniqueOpens`:

```ts
    delivered: numeric("delivered"),
    bounced: numeric("bounced"),
    unsubscribes: numeric("unsubscribes"),
    spamComplaints: numeric("spam_complaints"),
```

and replace its kind check:

```ts
    check(
      "klaviyo_report_fact_kind_check",
      sql`(${table.reportKind})::text in ('campaign', 'flow', 'campaign_message', 'flow_message')`,
    ),
```

- [ ] **Step 4: Generate the migration and verify the chain**

Run: `bun run db:generate --name klaviyo_campaign_ledger && node scripts/check-migrations.mjs`
Expected: `drizzle/0074_klaviyo_campaign_ledger.sql` exists containing `ALTER TABLE "klaviyo_marketing_object" ADD COLUMN "sent_at"`, `ADD COLUMN "subject"`, four `ALTER TABLE "klaviyo_report_fact" ADD COLUMN`, `ALTER TABLE "klaviyo_report_generation" ADD COLUMN "failure_reason"`, and a `DROP CONSTRAINT` + `ADD CONSTRAINT` pair for each kind check. `check-migrations` prints no error.

- [ ] **Step 5: Apply 0074 in every integration fixture**

In `src/lib/klaviyo/match-test-harness.ts` `applyMatchFixture`, append `"0074_klaviyo_campaign_ledger.sql"` to the migration array. Do the same in the explicit lists of `src/lib/klaviyo/report-repository.integration.test.ts` and `src/lib/klaviyo/claims-reporting-isolation.integration.test.ts` (find them with `grep -rln '0058_klaviyo_claims_reporting.sql' src/`; every list that names 0058 gets 0074 appended).

- [ ] **Step 6: Run the contract test, typecheck, and one DB suite**

Run: `npm run test -- --run src/lib/klaviyo/schema-contract.test.ts && npx tsc --noEmit && npm run test -- --run src/lib/klaviyo/report-repository.integration.test.ts`
Expected: all PASS (the repository suite proves 0074 applies on top of 0055–0058).

- [ ] **Step 7: Commit**

```bash
git add src/schema/klaviyo-claim.ts drizzle/0074_klaviyo_campaign_ledger.sql drizzle/meta src/lib/klaviyo/match-test-harness.ts src/lib/klaviyo/schema-contract.test.ts src/lib/klaviyo/report-repository.integration.test.ts src/lib/klaviyo/claims-reporting-isolation.integration.test.ts
git commit -m "feat(klaviyo): add ledger columns and per-message report kinds"
```

---

### Task 2: Report statistics, message kinds, and the wire body

**Files:**
- Modify: `src/lib/klaviyo/reports.ts`
- Modify: `src/lib/klaviyo/client.ts:666-696` (`queryValuesReport`)
- Modify: `docs/superpowers/specs/2026-09-08-klaviyo-campaign-ledger-design.md` §3.3 (fingerprint sentence)
- Test: `src/lib/klaviyo/reports.test.ts`, `src/lib/klaviyo/client.test.ts:1038-1091`

**Interfaces:**
- Produces: `KLAVIYO_REPORT_KINDS` (4), `KLAVIYO_REPORT_STATISTICS` (9), `KLAVIYO_REPORT_GROUPINGS` (+`campaign_message_id`, `flow_message_id`), `reportEndpointKind(kind): "campaign" | "flow"`, `isMessageReportKind(kind): boolean`, `wireGroupBy(request): string[] | null`, `NormalizedReportFact.statistics` gains `delivered`, `bounced`, `unsubscribes`, `spamComplaints`.

- [ ] **Step 1: Write the failing reports tests**

Append to `src/lib/klaviyo/reports.test.ts` (top-level):

```ts
import {
  KLAVIYO_REPORT_KINDS,
  KLAVIYO_REPORT_STATISTICS,
  isMessageReportKind,
  reportEndpointKind,
  wireGroupBy,
} from "@/lib/klaviyo/reports";

describe("message report kinds and the nine statistics", () => {
  it("exposes four kinds routed to two endpoints", () => {
    expect([...KLAVIYO_REPORT_KINDS]).toEqual([
      "campaign",
      "flow",
      "campaign_message",
      "flow_message",
    ]);
    expect(reportEndpointKind("campaign_message")).toBe("campaign");
    expect(reportEndpointKind("flow_message")).toBe("flow");
    expect(isMessageReportKind("campaign")).toBe(false);
    expect(isMessageReportKind("flow_message")).toBe(true);
  });

  it("sends group_by only for message kinds", () => {
    expect(wireGroupBy(reportRequest())).toBeNull();
    expect(wireGroupBy(reportRequest({ kind: "flow", grouping: ["flow_id"] }))).toBeNull();
    expect(
      wireGroupBy(
        reportRequest({ kind: "campaign_message", grouping: ["campaign_message_id"] }),
      ),
    ).toEqual(["campaign_message_id"]);
    expect(
      wireGroupBy(reportRequest({ kind: "flow_message", grouping: ["flow_message_id"] })),
    ).toEqual(["flow_message_id"]);
  });

  it("accepts the four new statistics and message groupings", () => {
    expect([...KLAVIYO_REPORT_STATISTICS]).toEqual([
      "conversions",
      "conversion_value",
      "recipients",
      "clicks_unique",
      "opens_unique",
      "delivered",
      "bounced",
      "unsubscribes",
      "spam_complaints",
    ]);
    expect(() =>
      assertExactReportRequest(
        reportRequest({
          kind: "campaign_message",
          statistics: ["delivered", "unsubscribes"],
          grouping: ["campaign_message_id"],
        }),
      ),
    ).not.toThrow();
  });

  it("normalizes the new statistics into typed columns and keeps the message id", () => {
    const { facts, warnings } = normalizeReportRows({
      kind: "campaign_message",
      requestFingerprint: "req",
      rows: [
        {
          groupings: { campaign_id: "camp-1", campaign_message_id: "msg-1" },
          statistics: {
            recipients: 100,
            delivered: "99",
            bounced: 1,
            unsubscribes: 2,
            spam_complaints: 0,
            opens_unique: 40,
            conversion_value: "12.50",
          },
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(facts[0]).toMatchObject({
      reportKind: "campaign_message",
      campaignExternalId: "camp-1",
      flowExternalId: null,
      messageExternalId: "msg-1",
      statistics: {
        recipients: "100",
        delivered: "99",
        bounced: "1",
        unsubscribes: "2",
        spamComplaints: "0",
        uniqueOpens: "40",
        uniqueClicks: null,
        conversions: null,
        conversionValue: "12.50",
      },
    });
    expect(facts[0].additionalStatistics).toEqual({});
  });

  it("changes the parent fingerprint only through the statistics list", () => {
    const withGrouping = reportRequest();
    // Same statistics, same grouping: identical scope fingerprint.
    expect(publicationScopeFingerprint(withGrouping, "UTC")).toBe(
      publicationScopeFingerprint({ ...withGrouping }, "UTC"),
    );
    expect(publicationScopeFingerprint(withGrouping, "UTC")).not.toBe(
      publicationScopeFingerprint(
        reportRequest({ statistics: ["conversions", "delivered"] }),
        "UTC",
      ),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/klaviyo/reports.test.ts`
Expected: FAIL — `isMessageReportKind`/`reportEndpointKind`/`wireGroupBy` are not exported; the statistics assertion fails.

- [ ] **Step 3: Implement in `reports.ts`**

Replace the constants and add helpers:

```ts
export const KLAVIYO_REPORT_KINDS = [
  "campaign",
  "flow",
  "campaign_message",
  "flow_message",
] as const;
export type KlaviyoReportKind = (typeof KLAVIYO_REPORT_KINDS)[number];

/** Which provider endpoint a kind queries; message kinds share their parent's. */
export function reportEndpointKind(kind: KlaviyoReportKind): "campaign" | "flow" {
  return kind === "campaign" || kind === "campaign_message" ? "campaign" : "flow";
}

export function isMessageReportKind(kind: KlaviyoReportKind): boolean {
  return kind === "campaign_message" || kind === "flow_message";
}

// Wire names pinned to the 2026-07-15 reporting revision: the provider
// uses suffix form (clicks_unique), verified against the live endpoint.
export const KLAVIYO_REPORT_STATISTICS = [
  "conversions",
  "conversion_value",
  "recipients",
  "clicks_unique",
  "opens_unique",
  "delivered",
  "bounced",
  "unsubscribes",
  "spam_complaints",
] as const;
export type KlaviyoReportStatistic = (typeof KLAVIYO_REPORT_STATISTICS)[number];

export const KLAVIYO_REPORT_GROUPINGS = [
  "send_date",
  "campaign_id",
  "flow_id",
  "send_channel",
  "campaign_message_id",
  "flow_message_id",
] as const;
export type KlaviyoReportGrouping = (typeof KLAVIYO_REPORT_GROUPINGS)[number];

/**
 * Only message kinds put a grouping on the wire. Parent kinds keep the
 * provider's default grouping exactly as before this feature, so their
 * request body shape is unchanged (their fingerprints still move with the
 * widened statistics list, which is intended: it forces one refresh).
 */
export function wireGroupBy(request: KlaviyoReportRequest): string[] | null {
  if (request.kind === "campaign_message") return ["campaign_message_id"];
  if (request.kind === "flow_message") return ["flow_message_id"];
  return null;
}
```

Extend `NormalizedReportFact.statistics`:

```ts
  statistics: {
    conversions: string | null;
    conversionValue: string | null;
    recipients: string | null;
    uniqueClicks: string | null;
    uniqueOpens: string | null;
    delivered: string | null;
    bounced: string | null;
    unsubscribes: string | null;
    spamComplaints: string | null;
  };
```

Extend `STATISTIC_COLUMN_BY_KEY`:

```ts
  delivered: "delivered",
  bounced: "bounced",
  unsubscribes: "unsubscribes",
  spam_complaints: "spamComplaints",
```

In `normalizeReportRows`, initialise the four new keys to `null` in the `statistics` literal, and change the id assignment so message kinds carry their parent when the provider echoes it:

```ts
    const endpoint = reportEndpointKind(input.kind);
    const fact: NormalizedReportFact = {
      reportKind: input.kind,
      campaignExternalId: endpoint === "campaign" ? campaignId : null,
      flowExternalId: endpoint === "flow" ? flowId : null,
      messageExternalId: messageId,
      ...
```

- [ ] **Step 4: Serialize `group_by` in the client**

In `src/lib/klaviyo/client.ts` import `reportEndpointKind, wireGroupBy` from `@/lib/klaviyo/reports` and rewrite the body in `queryValuesReport`:

```ts
    const isCampaign = reportEndpointKind(input.request.kind) === "campaign";
    const groupBy = wireGroupBy(input.request);
    const body = {
      data: {
        type: isCampaign ? "campaign-values-report" : "flow-values-report",
        attributes: {
          timeframe: {
            start: input.request.timeframe.from,
            end: input.request.timeframe.to,
          },
          conversion_metric_id: input.request.conversionExternalMetricId,
          statistics: [...input.request.statistics],
          ...(groupBy !== null ? { group_by: groupBy } : {}),
          ...(input.pageCursor !== null
            ? { page_cursor: input.pageCursor }
            : {}),
        },
      },
    };
```

- [ ] **Step 5: Add the exact-shape client tests**

In `src/lib/klaviyo/client.test.ts` inside `describe("queryValuesReport", ...)`:

```ts
  it("omits group_by for parent kinds and sends it only for message kinds", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: { type: "campaign-values-report", id: "r", attributes: { results: [] } },
      }),
    );
    const client = clientWith(fetchMock);
    await client.queryValuesReport({ request, pageCursor: null });
    const parentBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(Object.keys(parentBody.data.attributes).sort()).toEqual([
      "conversion_metric_id",
      "statistics",
      "timeframe",
    ]);

    await client.queryValuesReport({
      request: {
        ...request,
        kind: "flow_message",
        grouping: ["flow_message_id"],
      },
      pageCursor: null,
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/flow-values-reports");
    const messageBody = JSON.parse(init.body as string);
    expect(messageBody.data.type).toBe("flow-values-report");
    expect(messageBody.data.attributes.group_by).toEqual(["flow_message_id"]);
  });
```

- [ ] **Step 6: Run both suites**

Run: `npm run test -- --run src/lib/klaviyo/reports.test.ts src/lib/klaviyo/client.test.ts`
Expected: PASS. If a pre-existing client test asserts the exact `fields[campaign]` string, leave it — Task 4 changes that.

- [ ] **Step 7: Correct the spec sentence**

In the spec §3.3, replace the bullet beginning "The parent kinds `campaign` and `flow` keep sending **no** grouping on the wire, so their request fingerprints and facts are byte-identical to the current ones." with:

```
- The parent kinds `campaign` and `flow` keep sending **no** grouping on the
  wire, so their request body shape is unchanged. Their publication-scope
  fingerprints *do* change, because the statistics list is part of the
  fingerprint; that is intended — it makes the next scheduled preflight see
  every slot as stale and refresh it once with the nine statistics. Prior
  current generations are superseded by window and kind at publication
  (§3.3 supersession), so no stale slot lingers.
```

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: errors only in `report-repository.ts` (exhaustive kind handling) — those are fixed in Task 3. If `tsc` reports nothing, still commit.

```bash
git add src/lib/klaviyo/reports.ts src/lib/klaviyo/reports.test.ts src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts docs/superpowers/specs/2026-09-08-klaviyo-campaign-ledger-design.md
git commit -m "feat(klaviyo): request nine report statistics and per-message groupings"
```

---

### Task 3: Report repository — message kinds, new columns, fallback, nightly kinds

**Files:**
- Modify: `src/lib/klaviyo/report-repository.ts` (`reportRequestForKind`, `processReportBatch`, `resolveReportObject`, `publishTerminalReportSync`, `listCurrentReportFacts`)
- Modify: `trigger/klaviyo-incremental.ts:566-598` (`runReports`)
- Modify: `src/lib/trpc/routers/klaviyo.ts:479-485` (`refreshReports` kinds)
- Test: `src/lib/klaviyo/report-repository.integration.test.ts`, `src/lib/trpc/routers/klaviyo.test.ts`

**Interfaces:**
- Consumes: Task 1 columns; Task 2 `reportEndpointKind`, `isMessageReportKind`, `KLAVIYO_REPORT_KINDS`.
- Produces: message-kind facts with `message_object_id` and the parent id set; generations may end `failed` with `failure_reason = 'grouping_unsupported'` while siblings publish; `listCurrentReportFacts` returns the four new columns plus `messageObjectId`; `refreshReports` accepts `kinds` from the four-kind enum.

- [ ] **Step 1: Write the failing repository tests**

In `src/lib/klaviyo/report-repository.integration.test.ts`, extend `startRun`'s `kinds` parameter type to `Array<"campaign" | "flow" | "campaign_message" | "flow_message">`, extend `fakeReportClient` so message kinds return per-message rows, and add a message-object seed in `beforeEach` after the campaign seed:

```ts
    await testPool!.query(
      `INSERT INTO klaviyo_marketing_object
         (id, organization_id, shopify_store_id, connection_id, object_type,
          external_id, parent_id, name, tracking_projection, source_checksum,
          api_revision)
       VALUES ('message-row-1', 'org-a', 'store-a', 'connection-a',
         'campaign_message', 'message-ext-1', 'campaign-row-1', 'Variant A',
         '{}', 'checksum', '2026-07-15')`,
    );
```

Replace `fakeReportClient` with:

```ts
function fakeReportClient(
  spacerLog: number[] = [],
  campaignConversions = 3,
  options: { rejectMessageGrouping?: boolean } = {},
) {
  void spacerLog;
  return {
    queryValuesReport: vi
      .fn<
        (input: {
          request: { kind: string };
          pageCursor: string | null;
        }) => Promise<KlaviyoCompoundPage>
      >()
      .mockImplementation(async ({ request }) => {
        if (request.kind === "campaign") {
          return reportPage([
            {
              groupings: { campaign_id: "campaign-ext-1", send_date: "2026-07-15" },
              statistics: {
                conversions: campaignConversions,
                conversion_value: "99.50",
                recipients: 200,
                delivered: 198,
                unsubscribes: 4,
                bounced: 2,
                spam_complaints: 0,
              },
            },
          ]);
        }
        if (request.kind === "flow") {
          return reportPage([
            {
              groupings: { flow_id: "flow-ext-1", send_date: "2026-07-16" },
              statistics: { conversions: 2 },
            },
          ]);
        }
        if (options.rejectMessageGrouping) {
          throw new KlaviyoApiError(
            "Klaviyo API request failed (400)",
            400,
            false,
          );
        }
        if (request.kind === "campaign_message") {
          return reportPage([
            {
              groupings: { campaign_message_id: "message-ext-1" },
              statistics: { recipients: 200, conversions: 3 },
            },
            {
              groupings: { campaign_message_id: "message-ext-unknown" },
              statistics: { recipients: 1 },
            },
          ]);
        }
        return reportPage([]);
      }),
  };
}
```

Add `import { KlaviyoApiError } from "@/lib/klaviyo/client";` at the top. Then add these tests inside the `describeIfDb` block:

```ts
  it("stores the four new statistics on parent facts", async () => {
    const start = await startRun(["campaign"]);
    if (start.kind !== "started") throw new Error("expected started");
    await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      { createClient: () => fakeReportClient(), credentialProvider: fakeCredentialProvider, spacer: async () => {} },
    );
    const facts = await testPool!.query(
      `SELECT recipients, delivered, unsubscribes, bounced, spam_complaints
         FROM klaviyo_report_fact WHERE report_kind = 'campaign'`,
    );
    expect(facts.rows[0]).toEqual({
      recipients: "200",
      delivered: "198",
      unsubscribes: "4",
      bounced: "2",
      spam_complaints: "0",
    });
  });

  it("resolves message facts to the message and its parent, skipping unknown messages", async () => {
    const start = await startRun(["campaign", "campaign_message"]);
    if (start.kind !== "started") throw new Error("expected started");
    const client = fakeReportClient();
    const result = await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      { createClient: () => client, credentialProvider: fakeCredentialProvider, spacer: async () => {} },
    );
    expect(result.done).toBe(true);
    const messageCall = client.queryValuesReport.mock.calls.find(
      ([input]) => input.request.kind === "campaign_message",
    );
    expect(messageCall).toBeDefined();
    const facts = await testPool!.query(
      `SELECT report_kind, campaign_object_id, message_object_id, recipients
         FROM klaviyo_report_fact WHERE report_kind = 'campaign_message'`,
    );
    expect(facts.rows).toEqual([
      {
        report_kind: "campaign_message",
        campaign_object_id: "campaign-row-1",
        message_object_id: "message-row-1",
        recipients: "200",
      },
    ]);
    const generations = await testPool!.query(
      `SELECT kind, status, fact_count FROM klaviyo_report_generation
        WHERE sync_run_id = $1 ORDER BY kind`,
      [start.syncRunId],
    );
    expect(generations.rows).toEqual([
      { kind: "campaign", status: "current", fact_count: 1 },
      { kind: "campaign_message", status: "current", fact_count: 1 },
    ]);
  });

  it("fails only the message generation when the revision rejects the grouping", async () => {
    const start = await startRun(["campaign", "campaign_message"]);
    if (start.kind !== "started") throw new Error("expected started");
    const result = await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      {
        createClient: () => fakeReportClient([], 3, { rejectMessageGrouping: true }),
        credentialProvider: fakeCredentialProvider,
        spacer: async () => {},
      },
    );
    expect(result.done).toBe(true);
    const generations = await testPool!.query(
      `SELECT kind, status, failure_reason FROM klaviyo_report_generation
        WHERE sync_run_id = $1 ORDER BY kind`,
      [start.syncRunId],
    );
    expect(generations.rows).toEqual([
      { kind: "campaign", status: "current", failure_reason: null },
      { kind: "campaign_message", status: "failed", failure_reason: "grouping_unsupported" },
    ]);
    const run = await testPool!.query(
      `SELECT status FROM klaviyo_sync_run WHERE id = $1`,
      [start.syncRunId],
    );
    expect(run.rows[0].status).toBe("success");
  });

  it("supersedes a prior current generation for the same window and kind even when its fingerprint differs", async () => {
    // A finished report run from "before the statistics list widened", with
    // a current generation whose scope fingerprint no new request can match.
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters,
          requested_from, requested_to)
       VALUES ('old-run', 'org-a', 'store-a', 'connection-a', 'reports',
         'manual', 'success', NULL, '{}', $1, $2)`,
      [WINDOW.from.toISOString(), WINDOW.to.toISOString()],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_report_generation
         (id, organization_id, shopify_store_id, connection_id, sync_run_id,
          kind, requested_from, requested_to, account_timezone,
          publication_scope_fingerprint, refresh_fingerprint, status,
          fact_count, published_at)
       VALUES ('old-gen', 'org-a', 'store-a', 'connection-a', 'old-run',
         'campaign', $1, $2, 'America/New_York', 'old-scope', 'old-refresh',
         'current', 0, now())`,
      [WINDOW.from.toISOString(), WINDOW.to.toISOString()],
    );
    const start = await startRun(["campaign"]);
    if (start.kind !== "started") throw new Error("expected started");
    await repository.processReportBatch(
      { scope, syncRunId: start.syncRunId },
      { createClient: () => fakeReportClient(), credentialProvider: fakeCredentialProvider, spacer: async () => {} },
    );
    const old = await testPool!.query(
      `SELECT status FROM klaviyo_report_generation WHERE id = 'old-gen'`,
    );
    expect(old.rows[0].status).toBe("superseded");
  });
```

(If the `klaviyo_sync_run` insert in the catch branch fails on a NOT NULL column, read `src/schema/klaviyo.ts` for `klaviyoSyncRuns` and add the missing columns with placeholder values — the point of the fixture is only a `current` generation with a foreign fingerprint.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/klaviyo/report-repository.integration.test.ts`
Expected: the four new tests FAIL (unknown statistics land in `additional_statistics`; message kind throws; 400 fails the whole run; old generation stays current).

- [ ] **Step 3: Implement the repository changes**

In `report-repository.ts`:

Imports: add `KlaviyoApiError` to the client import, and `isMessageReportKind`, `reportEndpointKind` to the reports import.

`reportRequestForKind` grouping:

```ts
const GROUPING_BY_KIND: Record<KlaviyoReportKind, KlaviyoReportRequest["grouping"]> = {
  campaign: ["campaign_id", "send_date"],
  flow: ["flow_id", "send_date"],
  campaign_message: ["campaign_message_id"],
  flow_message: ["flow_message_id"],
};
// in reportRequestForKind:
    grouping: [...GROUPING_BY_KIND[kind]],
```

Relax the intact checks. In `processReportBatch`, replace the `generations.some((g) => g.status !== "staging")` condition with:

```ts
    generations.some(
      (generation) =>
        generation.status !== "staging" && generation.status !== "failed",
    )
```

and select `failureReason: klaviyoReportGenerations.failureReason` alongside status. Inside the loop, right after `const generation = generations[checkpoint.kindIndex];` + the `undefined` guard, skip already-failed kinds:

```ts
    if (generation.status === "failed") {
      checkpoint = await advanceKindLocked(input, checkpoint, now());
      if (checkpoint.kindIndex >= generations.length) {
        await publishTerminalReportSync({ scope: input.scope, syncRunId: input.syncRunId, now: now() });
        return { done: true, checkpoint: null };
      }
      continue;
    }
```

Wrap the provider call:

```ts
    let page: KlaviyoCompoundPage;
    try {
      page = await client.queryValuesReport({ request, pageCursor: checkpoint.cursor });
    } catch (error) {
      if (
        error instanceof KlaviyoApiError &&
        error.status === 400 &&
        isMessageReportKind(generation.kind)
      ) {
        // The pinned revision rejected the message grouping: fail only this
        // generation and let the parent kinds publish (spec §3.3 fallback).
        requestsUsed += 1;
        await withKlaviyoConnectionLock(input.scope, async (tx) => {
          await tx
            .update(klaviyoReportGenerations)
            .set({ status: "failed", failureReason: "grouping_unsupported" })
            .where(eq(klaviyoReportGenerations.id, generation.id));
        });
        generation.status = "failed";
        checkpoint = await advanceKindLocked(input, checkpoint, now());
        if (checkpoint.kindIndex >= generations.length) {
          await publishTerminalReportSync({ scope: input.scope, syncRunId: input.syncRunId, now: now() });
          return { done: true, checkpoint: null };
        }
        continue;
      }
      throw error;
    }
```

(`KlaviyoCompoundPage` is exported from `@/lib/klaviyo/client`; import the type.) Add the helper next to `resolveReportObject`:

```ts
/** Move the checkpoint to the next kind under the lock, guarding against a moved checkpoint. */
async function advanceKindLocked(
  input: { scope: KlaviyoConnectionScope; syncRunId: string },
  checkpoint: KlaviyoReportSyncCheckpoint,
  now: Date,
): Promise<KlaviyoReportSyncCheckpoint> {
  const next: KlaviyoReportSyncCheckpoint = {
    operation: "reports",
    kindIndex: checkpoint.kindIndex + 1,
    cursor: null,
    page: 0,
  };
  await withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [locked] = await tx
      .select({ checkpoint: klaviyoSyncRuns.checkpoint })
      .from(klaviyoSyncRuns)
      .where(and(eq(klaviyoSyncRuns.id, input.syncRunId), eq(klaviyoSyncRuns.status, "running")))
      .for("update");
    if (!locked) throw new Error("Klaviyo report run is not active");
    assertExactReportSyncCheckpoint(locked.checkpoint);
    if (locked.checkpoint.kindIndex !== checkpoint.kindIndex) {
      throw new Error("Klaviyo report checkpoint moved; replay this batch");
    }
    await tx
      .update(klaviyoSyncRuns)
      .set({ checkpoint: next, heartbeatAt: now })
      .where(eq(klaviyoSyncRuns.id, input.syncRunId));
  });
  return next;
}
```

Fact insertion: replace the per-fact object resolution with:

```ts
      let insertedFacts = 0;
      for (const fact of facts) {
        const endpoint = reportEndpointKind(generation.kind);
        let campaignObjectId = await resolveReportObject(tx, input.scope, "campaign", fact.campaignExternalId);
        let flowObjectId = await resolveReportObject(tx, input.scope, "flow", fact.flowExternalId);
        let messageObjectId: string | null = null;
        if (isMessageReportKind(generation.kind)) {
          const message = await resolveMessageObject(
            tx,
            input.scope,
            generation.kind === "campaign_message" ? "campaign_message" : "flow_message",
            fact.messageExternalId,
          );
          // A message fact that names no known message is unusable: skip it
          // (rows_read - rows_inserted on the run records how many).
          if (message === null) continue;
          messageObjectId = message.id;
          if (endpoint === "campaign" && campaignObjectId === null) campaignObjectId = message.parentId;
          if (endpoint === "flow" && flowObjectId === null) flowObjectId = message.parentId;
        }
        await tx.insert(klaviyoReportFacts).values({
            ...(unchanged fields)...
            campaignObjectId,
            flowObjectId,
            messageObjectId,
            conversions: fact.statistics.conversions,
            conversionValue: fact.statistics.conversionValue,
            recipients: fact.statistics.recipients,
            uniqueClicks: fact.statistics.uniqueClicks,
            uniqueOpens: fact.statistics.uniqueOpens,
            delivered: fact.statistics.delivered,
            bounced: fact.statistics.bounced,
            unsubscribes: fact.statistics.unsubscribes,
            spamComplaints: fact.statistics.spamComplaints,
            ...
        }).onConflictDoNothing({ target: [klaviyoReportFacts.generationId, klaviyoReportFacts.factFingerprint] });
        insertedFacts += 1;
      }
```

and use `insertedFacts` instead of `facts.length` in the `rowsInserted` update. Add:

```ts
async function resolveMessageObject(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  objectType: "campaign_message" | "flow_message",
  externalId: string | null,
): Promise<{ id: string; parentId: string | null } | null> {
  if (externalId === null) return null;
  const [row] = await tx
    .select({ id: klaviyoMarketingObjects.id, parentId: klaviyoMarketingObjects.parentId })
    .from(klaviyoMarketingObjects)
    .where(
      and(
        eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
        eq(klaviyoMarketingObjects.objectType, objectType),
        eq(klaviyoMarketingObjects.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}
```

`publishTerminalReportSync`: select `failureReason` too; change the intact check to allow `failed`; require at least one `staging`:

```ts
    const stagingOnly = staging.filter((generation) => generation.status === "staging");
    if (
      staging.length === 0 ||
      staging.some((g) => g.status !== "staging" && g.status !== "failed") ||
      stagingOnly.length === 0
    ) {
      throw new Error("Klaviyo report staging generations are not intact");
    }
    for (const generation of stagingOnly) {
      // Supersede by logical slot (window + kind) as well as fingerprint, so a
      // fingerprint change (e.g. a widened statistics list) cannot leave a
      // stale `current` beside the new one.
      await tx
        .update(klaviyoReportGenerations)
        .set({ status: "superseded", supersededAt: input.now })
        .where(
          and(
            eq(klaviyoReportGenerations.connectionId, input.scope.connectionId),
            eq(klaviyoReportGenerations.status, "current"),
            or(
              eq(klaviyoReportGenerations.publicationScopeFingerprint, generation.publicationScopeFingerprint),
              and(
                eq(klaviyoReportGenerations.kind, generation.kind),
                eq(klaviyoReportGenerations.requestedFrom, generation.requestedFrom),
                eq(klaviyoReportGenerations.requestedTo, generation.requestedTo),
              ),
            ),
          ),
        );
      await tx
        .update(klaviyoReportGenerations)
        .set({ status: "current", publishedAt: input.now })
        .where(eq(klaviyoReportGenerations.id, generation.id));
    }
    ...
    return { publishedKinds: stagingOnly.map((generation) => generation.kind) };
```

Select `requestedFrom`/`requestedTo` in that query and import `or` from `drizzle-orm`. `failReportSyncLocked` keeps failing only `staging` rows — unchanged.

`listCurrentReportFacts`: add `delivered`, `bounced`, `unsubscribes`, `spamComplaints`, `messageObjectId` to the select and the return type.

- [ ] **Step 4: Nightly kinds through the account timezone**

In `trigger/klaviyo-incremental.ts` `runReports`, replace the window and kinds:

```ts
      // Report windows are keyed by the Klaviyo ACCOUNT timezone — the same
      // conversion the lab's router applies — so the nightly generation is
      // the exact slot the ledger reads for "last 30 days".
      const accountTimezone = connection.accountTimezone ?? "UTC";
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        dateTo: today.toISOString().slice(0, 10),
        timeZone: accountTimezone,
      });
      const prepared = await startOrResumeReportSync({
        scope,
        window,
        kinds: [...KLAVIYO_REPORT_KINDS],
        reason: "scheduled",
        now: new Date(),
      });
```

Import `KLAVIYO_REPORT_KINDS` from `@/lib/klaviyo/reports`.

- [ ] **Step 5: Router refresh enum**

In `src/lib/trpc/routers/klaviyo.ts` `refreshReports`:

```ts
        kinds: z
          .array(z.enum(["campaign", "flow", "campaign_message", "flow_message"]))
          .min(1),
```

- [ ] **Step 6: Run the suites**

Run: `npm run test -- --run src/lib/klaviyo/report-repository.integration.test.ts src/lib/klaviyo/claims-reporting-isolation.integration.test.ts src/lib/trpc/routers/klaviyo.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/klaviyo/report-repository.ts src/lib/klaviyo/report-repository.integration.test.ts trigger/klaviyo-incremental.ts src/lib/trpc/routers/klaviyo.ts
git commit -m "feat(klaviyo): stage per-message report generations with a grouping fallback"
```

---

### Task 4: Send time and subject on marketing objects

**Files:**
- Modify: `src/lib/klaviyo/dimensions.ts` (`NormalizedMarketingObject`, `withDefinitionFields`, `normalizeObject`, `normalizeDimensionSnapshot`)
- Modify: `src/lib/klaviyo/client.ts:506-528` (`listCampaigns` fields)
- Modify: `src/lib/klaviyo/dimension-repository.ts:166-200` (upsert)
- Test: `src/lib/klaviyo/dimensions.test.ts`, `src/lib/klaviyo/client.test.ts`, `src/lib/klaviyo/dimension-repository.integration.test.ts`

**Interfaces:**
- Produces: `NormalizedMarketingObject.sentAt: Date | null`, `.subject: string | null`; rows persisted with `sent_at` / `subject`.

- [ ] **Step 1: Write the failing normalization tests**

In `src/lib/klaviyo/dimensions.test.ts`, change the "hoists message names" test's campaign-message definition to `content: { subject: "Sale subject" }` and replace its final two assertions with:

```ts
    expect(message?.subject).toBe("Sale subject");
    expect(JSON.stringify(snapshot)).not.toContain("x@y.com");
```

Then add a new test in the same `describe`:

```ts
  it("reads campaign send time with a scheduled_at fallback and leaves flows unsent", () => {
    const snapshot = normalizeDimensionSnapshot(
      traversal({
        campaigns: [
          {
            channel: "email",
            resource: {
              type: "campaign",
              id: "sent",
              attributes: {
                name: "Sent",
                send_time: "2026-09-01T09:00:00Z",
                scheduled_at: "2026-08-31T09:00:00Z",
              },
            },
          },
          {
            channel: "email",
            resource: {
              type: "campaign",
              id: "scheduled",
              attributes: { name: "Scheduled", scheduled_at: "2026-09-02T09:00:00Z" },
            },
          },
          {
            channel: "email",
            resource: { type: "campaign", id: "draft", attributes: { name: "Draft" } },
          },
        ],
        flows: [{ type: "flow", id: "flow-1", attributes: { name: "Welcome" } }],
      }),
    );
    const byId = new Map(snapshot.objects.map((object) => [object.externalId, object]));
    expect(byId.get("sent")?.sentAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
    expect(byId.get("scheduled")?.sentAt?.toISOString()).toBe("2026-09-02T09:00:00.000Z");
    expect(byId.get("draft")?.sentAt).toBeNull();
    expect(byId.get("flow-1")?.sentAt).toBeNull();
    expect(byId.get("sent")?.subject).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/klaviyo/dimensions.test.ts`
Expected: FAIL — `sentAt`/`subject` undefined.

- [ ] **Step 3: Implement normalization**

In `dimensions.ts`:

```ts
export type NormalizedMarketingObject = {
  ...existing fields...
  /** Campaigns: `send_time` else `scheduled_at`; null for drafts and flows. */
  sentAt: Date | null;
  /** Messages: the subject line inside the definition; null elsewhere. */
  subject: string | null;
};
```

Replace `withDefinitionFields` so mapping values may be dotted paths into the definition:

```ts
function readDefinitionPath(definition: Record<string, unknown>, path: string): unknown {
  let current: unknown = definition;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function withDefinitionFields(
  resource: KlaviyoResource,
  mapping: Record<string, string>,
): KlaviyoResource {
  const attributes = resource.attributes ?? {};
  const definition = attributes.definition;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return resource;
  }
  const hoisted: Record<string, unknown> = { ...attributes };
  for (const [target, sourcePath] of Object.entries(mapping)) {
    if (hoisted[target] === undefined) {
      hoisted[target] = readDefinitionPath(definition as Record<string, unknown>, sourcePath);
    }
  }
  delete hoisted.definition;
  return { ...resource, attributes: hoisted };
}
```

Extend `normalizeObject`'s input with `sentKeys?: string[]` and `subjectKey?: string`, and its return:

```ts
  let sentAt: Date | null = null;
  for (const key of input.sentKeys ?? []) {
    sentAt = providerTimestamp(attributes[key]);
    if (sentAt !== null) break;
  }
  return {
    ...,
    sentAt,
    subject: input.subjectKey === undefined ? null : boundedName(attributes[input.subjectKey]),
    trackingProjection: {},
  };
```

In `normalizeDimensionSnapshot`: campaigns pass `sentKeys: ["send_time", "scheduled_at"]`; campaign messages use `withDefinitionFields(message.resource, { label: "label", channel: "channel", subject: "content.subject" })` and `subjectKey: "subject"`; flow messages use `withDefinitionFields(message.resource, { name: "name", subject: "content.subject" })` and `subjectKey: "subject"`. Flows pass neither.

- [ ] **Step 4: Request the send fields and persist both columns**

`client.ts` `listCampaigns`:

```ts
      "fields[campaign]": "name,status,archived,created_at,updated_at,send_time,scheduled_at",
```

Update the `client.test.ts` assertion on `fields[campaign]` if one exists (`grep -n "fields\[campaign\]" src/lib/klaviyo/client.test.ts`) to the new string.

`dimension-repository.ts` upsert: add `sentAt: object.sentAt, subject: object.subject,` to both `.values({...})` and the `set: {...}` block. In `dimension-repository.integration.test.ts`, the `marketingObject()` fixture gains `sentAt: new Date("2026-07-03T09:00:00Z"), subject: null,`; add to the "replays page upserts" test an assertion after the first commit:

```ts
    const persisted = await testPool!.query(
      `SELECT sent_at::text AS sent_at FROM klaviyo_marketing_object WHERE external_id = 'campaign-1'`,
    );
    expect(persisted.rows[0].sent_at).toBe("2026-07-03 09:00:00");
```

(If the fixture's `NormalizedMarketingObject` literals elsewhere in that file now fail typecheck, add `sentAt: null, subject: null` to them.)

- [ ] **Step 5: Run and commit**

Run: `npm run test -- --run src/lib/klaviyo/dimensions.test.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimension-repository.integration.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

```bash
git add src/lib/klaviyo/dimensions.ts src/lib/klaviyo/dimensions.test.ts src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts src/lib/klaviyo/dimension-repository.ts src/lib/klaviyo/dimension-repository.integration.test.ts
git commit -m "feat(klaviyo): keep campaign send time and message subjects"
```

---

### Task 5: Shared email-link SQL and the ledger loaders

**Files:**
- Create: `src/lib/klaviyo/email-link-sql.ts`
- Modify: `src/lib/klaviyo/email-attribution.ts` (import the shared fragments; delete the local copies of `utcTimestamp`, `QUALIFYING_CLAIM`, `PRIMARY_CLAIM_LATERAL`, `emailLinkJoin`)
- Create: `src/lib/klaviyo/campaign-ledger.ts`
- Test: `src/lib/klaviyo/campaign-ledger.test.ts` (pure rates), `src/lib/klaviyo/campaign-ledger.integration.test.ts`, existing `email-attribution.integration.test.ts` must stay green

**Interfaces:**
- Consumes: `HalfOpenUtcWindow` from `@/lib/klaviyo/queries`; `KlaviyoConnectionScope`.
- Produces (all exported from `campaign-ledger.ts`):

```ts
export type LedgerKind = "campaign" | "flow";
export type LedgerKlaviyoStats = {
  recipients: number | null; delivered: number | null; uniqueOpens: number | null;
  uniqueClicks: number | null; bounced: number | null; unsubscribes: number | null;
  spamComplaints: number | null; conversions: number | null; conversionValue: string | null;
};
export type LedgerRates = { delivered: number | null; open: number | null; click: number | null; unsubscribe: number | null };
export type LedgerRow = {
  objectId: string; objectType: LedgerKind; name: string; channel: string | null; status: string | null;
  sentAt: Date | null; messageCount: number; klaviyo: LedgerKlaviyoStats | null; rates: LedgerRates;
  orderCount: number; revenue: string;
};
export type LedgerMessageRow = {
  objectId: string; objectType: "campaign_message" | "flow_message"; name: string; subject: string | null;
  channel: string | null; klaviyo: LedgerKlaviyoStats | null; rates: LedgerRates; orderCount: number; revenue: string;
};
export type LedgerReportMeta = { asOf: Date | null; hasCampaignGeneration: boolean; hasFlowGeneration: boolean };
export type LedgerListResult = { rows: LedgerRow[]; report: LedgerReportMeta };
export type LedgerProduct = { productKey: string; title: string; units: number; orderCount: number; orderRevenue: string };
export type LedgerDayPoint = { label: string; orders: number; netSales: string };
export type LedgerDetail = {
  object: { objectId: string; objectType: LedgerKind; name: string; channel: string | null; status: string | null; sentAt: Date | null; subject: string | null; messageCount: number };
  klaviyo: LedgerKlaviyoStats | null; rates: LedgerRates;
  ours: { orderCount: number; revenue: string };
  reconciliation: { unconfirmedOrders: number | null; revenuePerRecipient: string | null; averageOrderValue: string | null };
  ordersByDay: { mode: "offset" | "calendar"; points: LedgerDayPoint[] };
  topProducts: LedgerProduct[];
  messages: LedgerMessageRow[];
};
export function ledgerRates(stats: LedgerKlaviyoStats | null): LedgerRates;
export function loadLedgerRows(input: { scope; window; kind?: LedgerKind; channel?: "email" | "sms"; search?: string }): Promise<LedgerListResult>;
export function loadLedgerMessages(input: { scope; window; objectId: string }): Promise<LedgerMessageRow[] | null>;
export function loadLedgerDetail(input: { scope; window; objectId: string }): Promise<LedgerDetail | null>;
```

- [ ] **Step 1: Extract the shared SQL (behavior-preserving)**

Create `src/lib/klaviyo/email-link-sql.ts`:

```ts
import { sql } from "drizzle-orm";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";

/**
 * SQL fragments shared by the attribution panel and the campaign ledger so
 * "which campaign or flow gets this order" is decided in exactly one place.
 * Every fragment expects the enclosing query to alias shopify_order as `o`
 * and the current order-match result as `r`.
 */

/**
 * node-postgres serializes a raw Date parameter for a naive `timestamp`
 * column in the PROCESS's local time, while these columns store UTC wall
 * time. Interpolate the UTC ISO text and cast; Postgres drops the trailing
 * Z and keeps the UTC wall-clock value.
 */
export function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

/** A non-bot claim pointing at a campaign or flow qualifies an order as email-linked. */
export const QUALIFYING_CLAIM = sql`
  select 1 from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1`;

/**
 * Last non-bot touch decides campaign-vs-flow assignment. Ties on timestamp
 * (or all-null timestamps) break deterministically on the provider
 * attribution id. Exposes the message and the interaction instant so the
 * ledger can apply its send-time window rule and per-message rows.
 */
export const PRIMARY_CLAIM_LATERAL = sql`
  select case when c.campaign_object_id is not null then 'campaign'
              else 'flow' end as kind,
         coalesce(c.campaign_object_id, c.flow_object_id) as object_id,
         c.message_object_id,
         c.interaction_occurred_at
    from klaviyo_attribution_claim c
   where c.connection_id = r.connection_id
     and c.conversion_event_id = r.selected_event_id
     and (c.campaign_object_id is not null or c.flow_object_id is not null)
     and c.bot_click is distinct from 1
   order by c.interaction_occurred_at desc nulls last,
            c.klaviyo_attribution_id desc
   limit 1`;

/**
 * Confirms an `o` shopify_order alias as email-linked and exposes the
 * primary claim as `pc` (kind, object_id, message_object_id,
 * interaction_occurred_at).
 */
export function emailLinkJoin(scope: KlaviyoConnectionScope) {
  return sql`
    join klaviyo_order_match_result r
      on r.organization_id = o.organization_id
     and r.shopify_store_id = o.store_id
     and r.connection_id = ${scope.connectionId}
     and r.order_id = o.id
     and r.superseded_at is null
     and r.status = 'confirmed'
     and r.selected_event_id is not null
    cross join lateral (${PRIMARY_CLAIM_LATERAL}) pc`;
}
```

In `email-attribution.ts`: delete the local `utcTimestamp`, `QUALIFYING_CLAIM`, `PRIMARY_CLAIM_LATERAL`, `emailLinkJoin` and add `import { emailLinkJoin, QUALIFYING_CLAIM, utcTimestamp } from "@/lib/klaviyo/email-link-sql";` (`PRIMARY_CLAIM_LATERAL` is only used through `emailLinkJoin`). Keep `CLAIMS_COVERED`, `BUCKET_CASE`, `currentResultLeftJoin` where they are.

Run: `npm run test -- --run src/lib/klaviyo/email-attribution.integration.test.ts`
Expected: PASS unchanged (the lateral's two extra columns are never selected by the panel).

- [ ] **Step 2: Write the failing pure rates test**

Create `src/lib/klaviyo/campaign-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ledgerRates } from "@/lib/klaviyo/campaign-ledger";

const stats = {
  recipients: 1000, delivered: 990, uniqueOpens: 400, uniqueClicks: 40,
  bounced: 10, unsubscribes: 2, spamComplaints: 0, conversions: 20, conversionValue: "1200.00",
};

describe("ledgerRates", () => {
  it("uses Klaviyo's denominators", () => {
    expect(ledgerRates(stats)).toEqual({
      delivered: 0.99,
      open: 400 / 990,
      click: 40 / 990,
      unsubscribe: 2 / 990,
    });
  });
  it("is null on a null or zero denominator, never 0%", () => {
    expect(ledgerRates(null)).toEqual({ delivered: null, open: null, click: null, unsubscribe: null });
    expect(ledgerRates({ ...stats, delivered: 0 })).toMatchObject({ open: null, click: null, unsubscribe: null });
    expect(ledgerRates({ ...stats, recipients: null })).toMatchObject({ delivered: null });
    expect(ledgerRates({ ...stats, uniqueOpens: null })).toMatchObject({ open: null, click: 40 / 990 });
  });
});
```

Run: `npm run test -- --run src/lib/klaviyo/campaign-ledger.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write the failing integration tests**

Create `src/lib/klaviyo/campaign-ledger.integration.test.ts`. Copy the harness preamble from `email-attribution.integration.test.ts` (lines 1–30) with `TEST_DATABASE = "adsolute_klaviyo_ledger_test"`, importing `loadEmailAttribution` too, and copy the seed helpers `seedPublishedRun`, `seedOrder`, `seedRefund`, `seedEvent`, `seedOrderResult`, `seedClaim` verbatim. Add these helpers:

```ts
async function seedObject(input: {
  id: string;
  objectType: "campaign" | "flow" | "campaign_message" | "flow_message";
  name: string;
  parentId?: string | null;
  sentAt?: string | null;
  channel?: string | null;
  subject?: string | null;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_marketing_object
       (id, organization_id, shopify_store_id, connection_id, object_type,
        external_id, parent_id, name, channel, sent_at, subject,
        tracking_projection, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $1 || '-ext', $3, $4,
       $5, $6, $7, '{}', $1 || '-checksum', '2026-07-15')`,
    [input.id, input.objectType, input.parentId ?? null, input.name,
     input.channel ?? "email", input.sentAt ?? null, input.subject ?? null],
  );
}

/** One current generation per kind for the July window. */
async function seedGeneration(kind: string, id = `gen-${kind}`): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_report_generation
       (id, organization_id, shopify_store_id, connection_id, sync_run_id,
        kind, requested_from, requested_to, account_timezone,
        publication_scope_fingerprint, refresh_fingerprint, status,
        fact_count, published_at)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'source-run-a', $2,
       '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'UTC',
       $1 || '-scope', $1 || '-refresh', 'current', 0, '2026-08-02T00:00:00Z')`,
    [id, kind],
  );
}

async function seedFact(input: {
  id: string;
  kind: string;
  campaignObjectId?: string | null;
  flowObjectId?: string | null;
  messageObjectId?: string | null;
  stats: Partial<Record<
    "recipients" | "delivered" | "unique_opens" | "unique_clicks" | "bounced"
    | "unsubscribes" | "spam_complaints" | "conversions" | "conversion_value",
    string
  >>;
}): Promise<void> {
  const s = input.stats;
  await testPool!.query(
    `INSERT INTO klaviyo_report_fact
       (id, organization_id, shopify_store_id, connection_id, generation_id,
        report_kind, conversion_metric_id, campaign_object_id, flow_object_id,
        message_object_id, requested_from, requested_to, account_timezone,
        grouping, request_fingerprint, fact_fingerprint, recipients, delivered,
        unique_opens, unique_clicks, bounced, unsubscribes, spam_complaints,
        conversions, conversion_value, api_revision, as_of)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'gen-' || $2, $2,
       'metric-placed', $3, $4, $5, '2026-07-01T00:00:00Z',
       '2026-08-01T00:00:00Z', 'UTC', '{}', $1 || '-req', $1 || '-fact',
       $6, $7, $8, $9, $10, $11, $12, $13, $14, '2026-07-15',
       '2026-08-02T00:00:00Z')`,
    [input.id, input.kind, input.campaignObjectId ?? null, input.flowObjectId ?? null,
     input.messageObjectId ?? null, s.recipients ?? null, s.delivered ?? null,
     s.unique_opens ?? null, s.unique_clicks ?? null, s.bounced ?? null,
     s.unsubscribes ?? null, s.spam_complaints ?? null, s.conversions ?? null,
     s.conversion_value ?? null],
  );
}

/**
 * World on top of seedMatchWorld's order-a (42.50, event-a, created 07-20):
 * - campaign "July Sale" sent 07-10 (in window) with two messages; order-a
 *   (07-20, message m1) and order-late (08-05, OUTSIDE the window) both name it.
 * - campaign "June Blast" sent 06-15 (out of window); order-june names it.
 * - flow "Welcome": order-flow-in (interaction 07-22, in window) and
 *   order-flow-out (interaction 06-30, out of window).
 * - flow "Dormant": no facts, no orders → never a row.
 * - a 5.00 refund on order-a.
 */
async function seedLedgerWorld(): Promise<void> {
  await seedPublishedRun();
  await seedObject({ id: "camp-july", objectType: "campaign", name: "July Sale", sentAt: "2026-07-10T09:00:00Z" });
  await seedObject({ id: "msg-a", objectType: "campaign_message", name: "Variant A", parentId: "camp-july", subject: "20% off" });
  await seedObject({ id: "msg-b", objectType: "campaign_message", name: "Variant B", parentId: "camp-july", subject: "Last call" });
  await seedObject({ id: "camp-june", objectType: "campaign", name: "June Blast", sentAt: "2026-06-15T09:00:00Z" });
  await seedObject({ id: "camp-draft", objectType: "campaign", name: "Draft" });
  await seedObject({ id: "flow-welcome", objectType: "flow", name: "Welcome", channel: null });
  await seedObject({ id: "flow-dormant", objectType: "flow", name: "Dormant", channel: null });

  await seedOrderResult("res-a", "order-a", "confirmed", "event-a");
  await seedClaim({ id: "claim-a", conversionEventId: "event-a", attributionId: "attr-a", campaignObjectId: "camp-july", interactionOccurredAt: "2026-07-10T10:00:00Z" });
  await testPool!.query(`UPDATE klaviyo_attribution_claim SET message_object_id = 'msg-a' WHERE id = 'claim-a'`);
  await seedRefund("refund-a", "order-a", "2026-07-25", "5.00");

  await seedOrder("order-late", "9101", "60.00", { createdAt: "2026-08-05T12:00:00Z", orderDay: "2026-08-05" });
  await seedEvent("event-late", "external-event-late", "2026-08-05T12:05:00Z");
  await seedOrderResult("res-late", "order-late", "confirmed", "event-late");
  await seedClaim({ id: "claim-late", conversionEventId: "event-late", attributionId: "attr-late", campaignObjectId: "camp-july", interactionOccurredAt: "2026-07-10T11:00:00Z" });
  await testPool!.query(`UPDATE klaviyo_attribution_claim SET message_object_id = 'msg-b' WHERE id = 'claim-late'`);

  await seedOrder("order-june", "9102", "15.00", { createdAt: "2026-07-02T12:00:00Z", orderDay: "2026-07-02" });
  await seedEvent("event-june", "external-event-june", "2026-07-02T12:05:00Z");
  await seedOrderResult("res-june", "order-june", "confirmed", "event-june");
  await seedClaim({ id: "claim-june", conversionEventId: "event-june", attributionId: "attr-june", campaignObjectId: "camp-june", interactionOccurredAt: "2026-06-15T10:00:00Z" });

  await seedOrder("order-flow-in", "9103", "30.00", { createdAt: "2026-07-22T12:00:00Z", orderDay: "2026-07-22" });
  await seedEvent("event-flow-in", "external-event-flow-in", "2026-07-22T12:05:00Z");
  await seedOrderResult("res-flow-in", "order-flow-in", "confirmed", "event-flow-in");
  await seedClaim({ id: "claim-flow-in", conversionEventId: "event-flow-in", attributionId: "attr-flow-in", flowObjectId: "flow-welcome", interactionOccurredAt: "2026-07-22T11:00:00Z" });

  await seedOrder("order-flow-out", "9104", "25.00", { createdAt: "2026-07-03T12:00:00Z", orderDay: "2026-07-03" });
  await seedEvent("event-flow-out", "external-event-flow-out", "2026-07-03T12:05:00Z");
  await seedOrderResult("res-flow-out", "order-flow-out", "confirmed", "event-flow-out");
  await seedClaim({ id: "claim-flow-out", conversionEventId: "event-flow-out", attributionId: "attr-flow-out", flowObjectId: "flow-welcome", interactionOccurredAt: "2026-06-30T11:00:00Z" });
}
```

Then the suite (same `beforeAll`/`afterAll`/`beforeEach` as the attribution test, `window` = July UTC):

```ts
const { loadLedgerRows, loadLedgerMessages, loadLedgerDetail } = await import("@/lib/klaviyo/campaign-ledger");

describeIfDb("Klaviyo campaign ledger on PostgreSQL", () => {
  // beforeAll / afterAll / beforeEach copied from email-attribution.integration.test.ts

  it("applies the send-time rule to campaigns and the interaction rule to flows", async () => {
    await seedLedgerWorld();
    const { rows } = await loadLedgerRows({ scope, window });
    const byId = new Map(rows.map((row) => [row.objectId, row]));
    // July Sale: both orders, including the August one; refund-net 42.50 + 60 - 5.
    expect(byId.get("camp-july")).toMatchObject({
      objectType: "campaign", name: "July Sale", orderCount: 2, revenue: "97.50",
      messageCount: 2, klaviyo: null,
    });
    expect(byId.get("camp-july")?.sentAt?.toISOString()).toBe("2026-07-10T09:00:00.000Z");
    // Sent in June: not a row, even though an order landed in July.
    expect(byId.has("camp-june")).toBe(false);
    expect(byId.has("camp-draft")).toBe(false);
    // Welcome flow: only the interaction-in-window order.
    expect(byId.get("flow-welcome")).toMatchObject({ objectType: "flow", orderCount: 1, revenue: "30.00", sentAt: null });
    expect(byId.has("flow-dormant")).toBe(false);
    expect(rows.map((row) => row.objectId)).toEqual(["camp-july", "flow-welcome"]);
  });

  it("joins the current generations and computes rates with Klaviyo's denominators", async () => {
    await seedLedgerWorld();
    await seedGeneration("campaign");
    await seedGeneration("flow");
    await seedFact({ id: "f1", kind: "campaign", campaignObjectId: "camp-july", stats: { recipients: "1000", delivered: "990", unique_opens: "400", unique_clicks: "40", unsubscribes: "2", bounced: "10", spam_complaints: "0", conversions: "3", conversion_value: "120.00" } });
    // A second send-date fact for the same campaign sums.
    await seedFact({ id: "f2", kind: "campaign", campaignObjectId: "camp-july", stats: { recipients: "10", delivered: "10", conversion_value: "5.00" } });
    await seedFact({ id: "f3", kind: "flow", flowObjectId: "flow-dormant", stats: { recipients: "50", delivered: "50" } });
    const result = await loadLedgerRows({ scope, window });
    const july = result.rows.find((row) => row.objectId === "camp-july");
    expect(july?.klaviyo).toEqual({
      recipients: 1010, delivered: 1000, uniqueOpens: 400, uniqueClicks: 40,
      bounced: 10, unsubscribes: 2, spamComplaints: 0, conversions: 3, conversionValue: "125.00",
    });
    expect(july?.rates).toEqual({ delivered: 1000 / 1010, open: 0.4, click: 0.04, unsubscribe: 0.002 });
    // A flow with a fact but no orders is a row now.
    expect(result.rows.find((row) => row.objectId === "flow-dormant")).toMatchObject({ orderCount: 0, revenue: "0.00" });
    expect(result.report).toMatchObject({ hasCampaignGeneration: true, hasFlowGeneration: true });
    expect(result.report.asOf?.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("filters by kind, channel, and name", async () => {
    await seedLedgerWorld();
    expect((await loadLedgerRows({ scope, window, kind: "flow" })).rows.map((r) => r.objectId)).toEqual(["flow-welcome"]);
    expect((await loadLedgerRows({ scope, window, channel: "sms" })).rows).toEqual([]);
    expect((await loadLedgerRows({ scope, window, search: "july" })).rows.map((r) => r.objectId)).toEqual(["camp-july"]);
    expect((await loadLedgerRows({ scope, window, search: "%" })).rows).toEqual([]);
  });

  it("reports empty metadata when no generation exists for the window", async () => {
    await seedLedgerWorld();
    const { report } = await loadLedgerRows({ scope, window });
    expect(report).toEqual({ asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false });
  });

  it("returns child rows joined by message id, or null for an unknown object", async () => {
    await seedLedgerWorld();
    await seedGeneration("campaign_message");
    await seedFact({ id: "fm-a", kind: "campaign_message", campaignObjectId: "camp-july", messageObjectId: "msg-a", stats: { recipients: "600", delivered: "600", unique_opens: "300" } });
    const messages = await loadLedgerMessages({ scope, window, objectId: "camp-july" });
    expect(messages).toEqual([
      expect.objectContaining({ objectId: "msg-a", name: "Variant A", subject: "20% off", orderCount: 1, revenue: "37.50", klaviyo: expect.objectContaining({ recipients: 600 }), rates: expect.objectContaining({ open: 0.5 }) }),
      expect.objectContaining({ objectId: "msg-b", name: "Variant B", orderCount: 1, revenue: "60.00", klaviyo: null }),
    ]);
    expect(await loadLedgerMessages({ scope, window, objectId: "nope" })).toBeNull();
  });

  it("builds the detail: header, reconciliation, day offsets, products, and variants", async () => {
    await seedLedgerWorld();
    await seedGeneration("campaign");
    await seedFact({ id: "f1", kind: "campaign", campaignObjectId: "camp-july", stats: { recipients: "1000", delivered: "990", conversions: "5", conversion_value: "150.00" } });
    const detail = await loadLedgerDetail({ scope, window, objectId: "camp-july" });
    expect(detail?.object).toMatchObject({ name: "July Sale", objectType: "campaign", subject: "20% off", messageCount: 2 });
    expect(detail?.ours).toEqual({ orderCount: 2, revenue: "97.50" });
    expect(detail?.reconciliation).toEqual({ unconfirmedOrders: 3, revenuePerRecipient: "0.10", averageOrderValue: "48.75" });
    expect(detail?.ordersByDay.mode).toBe("offset");
    expect(detail?.ordersByDay.points).toHaveLength(14);
    // order-a is 10 days after the 07-10 send; order-late is 26 days after (outside the 14-day strip).
    expect(detail?.ordersByDay.points[10]).toEqual({ label: "10", orders: 1, netSales: "42.50" });
    expect(detail?.ordersByDay.points.reduce((sum, point) => sum + point.orders, 0)).toBe(1);
    // seedMatchWorld gave order-a product 77 "Product" qty 2.
    expect(detail?.topProducts).toEqual([
      { productKey: "77", title: "Product", units: 2, orderCount: 1, orderRevenue: "42.50" },
    ]);
    expect(detail?.messages.map((message) => message.objectId)).toEqual(["msg-a", "msg-b"]);
  });

  it("uses calendar days and in-window orders for a flow detail", async () => {
    await seedLedgerWorld();
    const detail = await loadLedgerDetail({ scope, window, objectId: "flow-welcome" });
    expect(detail?.ordersByDay.mode).toBe("calendar");
    expect(detail?.ordersByDay.points).toHaveLength(31);
    expect(detail?.ordersByDay.points.find((point) => point.label === "2026-07-22")).toEqual({ label: "2026-07-22", orders: 1, netSales: "30.00" });
    expect(detail?.reconciliation).toEqual({ unconfirmedOrders: null, revenuePerRecipient: null, averageOrderValue: "30.00" });
    expect(detail?.messages).toEqual([]);
    expect(await loadLedgerDetail({ scope, window, objectId: "nope" })).toBeNull();
  });

  it("agrees with the attribution panel's per-source totals for the same orders", async () => {
    await seedLedgerWorld();
    // Restrict to orders created in July so both loaders see the same set:
    // July Sale's August order is out of the panel's window by design.
    await testPool!.query(`DELETE FROM shopify_order WHERE id = 'order-late'`);
    const panel = await loadEmailAttribution({ scope, window, days: { dateFrom: "2026-07-01", dateTo: "2026-07-31" } });
    const ledger = await loadLedgerRows({ scope, window });
    const panelJuly = panel.sources.find((source) => source.objectId === "camp-july");
    const ledgerJuly = ledger.rows.find((row) => row.objectId === "camp-july");
    expect(ledgerJuly?.orderCount).toBe(panelJuly?.orderCount);
    expect(ledgerJuly?.revenue).toBe(panelJuly?.revenue);
  });
});
```

Run: `npm run test -- --run src/lib/klaviyo/campaign-ledger.integration.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `campaign-ledger.ts`**

```ts
import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { emailLinkJoin, utcTimestamp } from "@/lib/klaviyo/email-link-sql";
import type { HalfOpenUtcWindow } from "@/lib/klaviyo/queries";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";

/**
 * Read-only loaders for the lab's campaign ledger. The window is the
 * Klaviyo ACCOUNT-timezone day range converted to half-open UTC — the same
 * key the report request uses, so "the current generation for this window"
 * is an exact match.
 *
 * Row rule (spec §4): a campaign is selected by its send time and carries
 * every confirmed order whose primary claim names it, with no order-date
 * filter; a flow carries orders whose primary claim's interaction falls in
 * the window. Refunds net per order lifetime.
 */

export type LedgerKind = "campaign" | "flow";

export type LedgerKlaviyoStats = {
  recipients: number | null;
  delivered: number | null;
  uniqueOpens: number | null;
  uniqueClicks: number | null;
  bounced: number | null;
  unsubscribes: number | null;
  spamComplaints: number | null;
  conversions: number | null;
  conversionValue: string | null;
};

export type LedgerRates = {
  delivered: number | null;
  open: number | null;
  click: number | null;
  unsubscribe: number | null;
};

export type LedgerRow = {
  objectId: string;
  objectType: LedgerKind;
  name: string;
  channel: string | null;
  status: string | null;
  sentAt: Date | null;
  messageCount: number;
  klaviyo: LedgerKlaviyoStats | null;
  rates: LedgerRates;
  orderCount: number;
  revenue: string;
};

export type LedgerMessageRow = {
  objectId: string;
  objectType: "campaign_message" | "flow_message";
  name: string;
  subject: string | null;
  channel: string | null;
  klaviyo: LedgerKlaviyoStats | null;
  rates: LedgerRates;
  orderCount: number;
  revenue: string;
};

export type LedgerReportMeta = {
  asOf: Date | null;
  hasCampaignGeneration: boolean;
  hasFlowGeneration: boolean;
};

export type LedgerListResult = { rows: LedgerRow[]; report: LedgerReportMeta };

export type LedgerProduct = {
  productKey: string;
  title: string;
  units: number;
  orderCount: number;
  orderRevenue: string;
};

export type LedgerDayPoint = { label: string; orders: number; netSales: string };

export type LedgerDetail = {
  object: {
    objectId: string;
    objectType: LedgerKind;
    name: string;
    channel: string | null;
    status: string | null;
    sentAt: Date | null;
    subject: string | null;
    messageCount: number;
  };
  klaviyo: LedgerKlaviyoStats | null;
  rates: LedgerRates;
  ours: { orderCount: number; revenue: string };
  reconciliation: {
    unconfirmedOrders: number | null;
    revenuePerRecipient: string | null;
    averageOrderValue: string | null;
  };
  ordersByDay: { mode: "offset" | "calendar"; points: LedgerDayPoint[] };
  topProducts: LedgerProduct[];
  messages: LedgerMessageRow[];
};

const OFFSET_DAYS = 14;
const ZERO_OURS = { orderCount: 0, revenue: "0.00" };

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

/** Klaviyo's own denominators: delivered over recipients, the rest over delivered. */
export function ledgerRates(stats: LedgerKlaviyoStats | null): LedgerRates {
  if (stats === null) return { delivered: null, open: null, click: null, unsubscribe: null };
  return {
    delivered: ratio(stats.delivered, stats.recipients),
    open: ratio(stats.uniqueOpens, stats.delivered),
    click: ratio(stats.uniqueClicks, stats.delivered),
    unsubscribe: ratio(stats.unsubscribes, stats.delivered),
  };
}

/** Report sums arrive as numeric text; counts become numbers, money stays text. */
function countOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function centsOf(money: string): number {
  return Math.round(Number(money) * 100);
}

function moneyRatio(money: string, divisor: number | null): string | null {
  if (divisor === null || divisor <= 0) return null;
  return (centsOf(money) / divisor / 100).toFixed(2);
}

/** `%`, `_`, and `\` are ILIKE metacharacters; a search for them must be literal. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

type FactRow = {
  kind: string;
  object_id: string;
  message_object_id: string | null;
  recipients: string | null;
  delivered: string | null;
  unique_opens: string | null;
  unique_clicks: string | null;
  bounced: string | null;
  unsubscribes: string | null;
  spam_complaints: string | null;
  conversions: string | null;
  conversion_value: string | null;
};

function statsOf(row: FactRow): LedgerKlaviyoStats {
  return {
    recipients: countOf(row.recipients),
    delivered: countOf(row.delivered),
    uniqueOpens: countOf(row.unique_opens),
    uniqueClicks: countOf(row.unique_clicks),
    bounced: countOf(row.bounced),
    unsubscribes: countOf(row.unsubscribes),
    spamComplaints: countOf(row.spam_complaints),
    conversions: countOf(row.conversions),
    conversionValue: row.conversion_value,
  };
}

/**
 * Email-linked orders under the ledger's window rule, as a CTE named
 * `linked`. Campaign orders are unwindowed; flow orders are kept when the
 * primary claim's interaction is inside the window. Optionally restricted
 * to one campaign or flow.
 */
function linkedOrdersCte(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  objectId: string | null,
) {
  return sql`
    linked as (
      select pc.kind, pc.object_id, pc.message_object_id,
             o.id as order_id, o.net_sales, o.order_created_at
        from shopify_order o
        ${emailLinkJoin(scope)}
       where o.organization_id = ${scope.organizationId}
         and o.store_id = ${scope.storeId}
         and (pc.kind = 'campaign'
              or (pc.interaction_occurred_at >= ${utcTimestamp(window.from)}
                  and pc.interaction_occurred_at < ${utcTimestamp(window.to)}))
         ${objectId === null ? sql`` : sql`and pc.object_id = ${objectId}`}
    )`;
}

/** Refund-net order count and revenue per (object, optionally message). */
async function loadOurSide(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  objectId: string | null,
  byMessage: boolean,
): Promise<Map<string, { orderCount: number; revenue: string }>> {
  const rows = await db.execute<{
    key: string | null;
    orders: number;
    revenue: string;
  }>(sql`
    with ${linkedOrdersCte(scope, window, objectId)},
    refunds as (
      select rf.order_id, sum(rf.amount) as refunded
        from shopify_refund rf
       where rf.organization_id = ${scope.organizationId}
         and rf.store_id = ${scope.storeId}
         and rf.order_id in (select order_id from linked)
       group by rf.order_id
    )
    select ${byMessage ? sql`l.message_object_id` : sql`l.object_id`} as key,
           count(*)::int as orders,
           round(coalesce(sum(l.net_sales), 0) - coalesce(sum(rf.refunded), 0), 2)::text
             as revenue
      from linked l
      left join refunds rf on rf.order_id = l.order_id
     group by 1`);
  const result = new Map<string, { orderCount: number; revenue: string }>();
  for (const row of rows.rows) {
    if (row.key === null) continue;
    result.set(row.key, { orderCount: row.orders, revenue: row.revenue });
  }
  return result;
}

/**
 * Klaviyo's numbers from the current generations for this exact window,
 * summed per object (parent kinds arrive one row per send date). Keyed by
 * object id for parent kinds and by message id for message kinds.
 */
async function loadKlaviyoSide(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
  kinds: readonly string[],
  objectId: string | null,
): Promise<Map<string, LedgerKlaviyoStats>> {
  const rows = await db.execute<FactRow>(sql`
    select g.kind,
           coalesce(f.campaign_object_id, f.flow_object_id) as object_id,
           f.message_object_id,
           sum(f.recipients)::text as recipients,
           sum(f.delivered)::text as delivered,
           sum(f.unique_opens)::text as unique_opens,
           sum(f.unique_clicks)::text as unique_clicks,
           sum(f.bounced)::text as bounced,
           sum(f.unsubscribes)::text as unsubscribes,
           sum(f.spam_complaints)::text as spam_complaints,
           sum(f.conversions)::text as conversions,
           round(sum(f.conversion_value), 2)::text as conversion_value
      from klaviyo_report_fact f
      join klaviyo_report_generation g on g.id = f.generation_id
     where g.organization_id = ${scope.organizationId}
       and g.shopify_store_id = ${scope.storeId}
       and g.connection_id = ${scope.connectionId}
       and g.status = 'current'
       and g.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
       and g.requested_from = ${utcTimestamp(window.from)}
       and g.requested_to = ${utcTimestamp(window.to)}
       and coalesce(f.campaign_object_id, f.flow_object_id) is not null
       ${objectId === null ? sql`` : sql`and coalesce(f.campaign_object_id, f.flow_object_id) = ${objectId}`}
     group by 1, 2, 3`);
  const result = new Map<string, LedgerKlaviyoStats>();
  for (const row of rows.rows) {
    const key = row.message_object_id ?? row.object_id;
    result.set(key, statsOf(row));
  }
  return result;
}

async function loadReportMeta(
  scope: KlaviyoConnectionScope,
  window: HalfOpenUtcWindow,
): Promise<LedgerReportMeta> {
  const rows = await db.execute<{ kind: string; published_at: Date | null }>(sql`
    select kind, published_at
      from klaviyo_report_generation
     where organization_id = ${scope.organizationId}
       and shopify_store_id = ${scope.storeId}
       and connection_id = ${scope.connectionId}
       and status = 'current'
       and kind in ('campaign', 'flow')
       and requested_from = ${utcTimestamp(window.from)}
       and requested_to = ${utcTimestamp(window.to)}`);
  let asOf: Date | null = null;
  for (const row of rows.rows) {
    if (row.published_at !== null && (asOf === null || row.published_at > asOf)) {
      asOf = row.published_at;
    }
  }
  return {
    asOf,
    hasCampaignGeneration: rows.rows.some((row) => row.kind === "campaign"),
    hasFlowGeneration: rows.rows.some((row) => row.kind === "flow"),
  };
}

type ObjectRow = {
  id: string;
  object_type: LedgerKind;
  name: string;
  channel: string | null;
  status: string | null;
  sent_at: Date | null;
  message_count: number;
};

export async function loadLedgerRows(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  kind?: LedgerKind;
  channel?: "email" | "sms";
  search?: string;
}): Promise<LedgerListResult> {
  const { scope, window } = input;
  const search = input.search?.trim() ?? "";
  const objects = await db.execute<ObjectRow>(sql`
    select o.id, o.object_type, o.name, o.channel, o.status, o.sent_at,
           (select count(*)::int from klaviyo_marketing_object m
             where m.connection_id = o.connection_id and m.parent_id = o.id)
             as message_count
      from klaviyo_marketing_object o
     where o.organization_id = ${scope.organizationId}
       and o.shopify_store_id = ${scope.storeId}
       and o.connection_id = ${scope.connectionId}
       and o.object_type in ('campaign', 'flow')
       and (o.object_type = 'flow'
            or (o.sent_at >= ${utcTimestamp(window.from)}
                and o.sent_at < ${utcTimestamp(window.to)}))
       ${input.kind ? sql`and o.object_type = ${input.kind}` : sql``}
       ${input.channel ? sql`and o.channel = ${input.channel}` : sql``}
       ${search ? sql`and o.name ilike ${likePattern(search)}` : sql``}
     order by o.sent_at desc nulls last, o.name asc, o.id asc`);

  const [ours, klaviyo, report] = await Promise.all([
    loadOurSide(scope, window, null, false),
    loadKlaviyoSide(scope, window, ["campaign", "flow"], null),
    loadReportMeta(scope, window),
  ]);

  const rows: LedgerRow[] = [];
  for (const object of objects.rows) {
    const stats = klaviyo.get(object.id) ?? null;
    const own = ours.get(object.id) ?? ZERO_OURS;
    // A flow with nothing in the range stays out rather than showing dashes.
    if (object.object_type === "flow" && stats === null && own.orderCount === 0) continue;
    rows.push({
      objectId: object.id,
      objectType: object.object_type,
      name: object.name,
      channel: object.channel,
      status: object.status,
      sentAt: object.sent_at,
      messageCount: object.message_count,
      klaviyo: stats,
      rates: ledgerRates(stats),
      orderCount: own.orderCount,
      revenue: own.revenue,
    });
  }
  return { rows, report };
}

async function loadObject(
  scope: KlaviyoConnectionScope,
  objectId: string,
): Promise<(ObjectRow & { subject: string | null }) | null> {
  const rows = await db.execute<ObjectRow & { subject: string | null }>(sql`
    select o.id, o.object_type, o.name, o.channel, o.status, o.sent_at,
           (select count(*)::int from klaviyo_marketing_object m
             where m.connection_id = o.connection_id and m.parent_id = o.id)
             as message_count,
           (select m.subject from klaviyo_marketing_object m
             where m.connection_id = o.connection_id and m.parent_id = o.id
             order by m.provider_created_at asc nulls last, m.id asc
             limit 1) as subject
      from klaviyo_marketing_object o
     where o.organization_id = ${scope.organizationId}
       and o.shopify_store_id = ${scope.storeId}
       and o.connection_id = ${scope.connectionId}
       and o.id = ${objectId}
       and o.object_type in ('campaign', 'flow')`);
  return rows.rows[0] ?? null;
}

export async function loadLedgerMessages(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  objectId: string;
}): Promise<LedgerMessageRow[] | null> {
  const { scope, window, objectId } = input;
  const parent = await loadObject(scope, objectId);
  if (parent === null) return null;
  const messages = await db.execute<{
    id: string;
    object_type: "campaign_message" | "flow_message";
    name: string;
    subject: string | null;
    channel: string | null;
  }>(sql`
    select m.id, m.object_type, m.name, m.subject, m.channel
      from klaviyo_marketing_object m
     where m.connection_id = ${scope.connectionId}
       and m.parent_id = ${objectId}
       and m.object_type in ('campaign_message', 'flow_message')
     order by m.provider_created_at asc nulls last, m.name asc, m.id asc`);
  const messageKind =
    parent.object_type === "campaign" ? "campaign_message" : "flow_message";
  const [ours, klaviyo] = await Promise.all([
    loadOurSide(scope, window, objectId, true),
    loadKlaviyoSide(scope, window, [messageKind], objectId),
  ]);
  return messages.rows.map((message) => {
    const stats = klaviyo.get(message.id) ?? null;
    const own = ours.get(message.id) ?? ZERO_OURS;
    return {
      objectId: message.id,
      objectType: message.object_type,
      name: message.name,
      subject: message.subject,
      channel: message.channel,
      klaviyo: stats,
      rates: ledgerRates(stats),
      orderCount: own.orderCount,
      revenue: own.revenue,
    };
  });
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

export async function loadLedgerDetail(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  objectId: string;
}): Promise<LedgerDetail | null> {
  const { scope, window, objectId } = input;
  const object = await loadObject(scope, objectId);
  if (object === null) return null;

  const [ours, klaviyoMap] = await Promise.all([
    loadOurSide(scope, window, objectId, false),
    loadKlaviyoSide(scope, window, [object.object_type], objectId),
  ]);
  const own = ours.get(objectId) ?? ZERO_OURS;
  const stats = klaviyoMap.get(objectId) ?? null;

  // Orders by day: offset from the send for a campaign (first 14 days), UTC
  // calendar day across the window for a flow.
  let ordersByDay: LedgerDetail["ordersByDay"];
  if (object.object_type === "campaign" && object.sent_at !== null) {
    const rows = await db.execute<{ day_offset: number; orders: number; net_sales: string }>(sql`
      with ${linkedOrdersCte(scope, window, objectId)}
      select day_offset, count(*)::int as orders,
             round(sum(net_sales), 2)::text as net_sales
        from (select floor(extract(epoch from
                       (order_created_at - ${utcTimestamp(object.sent_at)})) / 86400)::int
                       as day_offset,
                     net_sales
                from linked) d
       where day_offset between 0 and ${OFFSET_DAYS - 1}
       group by 1 order by 1`);
    const byOffset = new Map(rows.rows.map((row) => [row.day_offset, row]));
    ordersByDay = {
      mode: "offset",
      points: Array.from({ length: OFFSET_DAYS }, (_, offset) => {
        const row = byOffset.get(offset);
        return { label: String(offset), orders: row?.orders ?? 0, netSales: row?.net_sales ?? "0.00" };
      }),
    };
  } else {
    const rows = await db.execute<{ day: string; orders: number; net_sales: string }>(sql`
      with ${linkedOrdersCte(scope, window, objectId)}
      select to_char(order_created_at, 'YYYY-MM-DD') as day,
             count(*)::int as orders,
             round(sum(net_sales), 2)::text as net_sales
        from linked
       group by 1 order by 1`);
    const byDay = new Map(rows.rows.map((row) => [row.day, row]));
    const points: LedgerDayPoint[] = [];
    const last = utcDay(new Date(window.to.getTime() - 1));
    for (let day = utcDay(window.from); day <= last; day = addUtcDays(day, 1)) {
      const row = byDay.get(day);
      points.push({ label: day, orders: row?.orders ?? 0, netSales: row?.net_sales ?? "0.00" });
    }
    ordersByDay = { mode: "calendar", points };
  }

  // Top products among this object's confirmed orders; an order with
  // several products counts toward each, once per order.
  const products = await db.execute<{
    product_key: string;
    title: string;
    units: number;
    order_count: number;
    order_revenue: string;
  }>(sql`
    with ${linkedOrdersCte(scope, window, objectId)}
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

  const messages =
    object.message_count > 1
      ? ((await loadLedgerMessages({ scope, window, objectId })) ?? [])
      : [];

  return {
    object: {
      objectId: object.id,
      objectType: object.object_type,
      name: object.name,
      channel: object.channel,
      status: object.status,
      sentAt: object.sent_at,
      subject: object.subject,
      messageCount: object.message_count,
    },
    klaviyo: stats,
    rates: ledgerRates(stats),
    ours: own,
    reconciliation: {
      unconfirmedOrders:
        stats?.conversions == null ? null : Math.max(0, stats.conversions - own.orderCount),
      revenuePerRecipient: moneyRatio(own.revenue, stats?.recipients ?? null),
      averageOrderValue: moneyRatio(own.revenue, own.orderCount),
    },
    ordersByDay,
    topProducts: products.rows.map((row) => ({
      productKey: row.product_key,
      title: row.title,
      units: row.units,
      orderCount: row.order_count,
      orderRevenue: row.order_revenue,
    })),
    messages,
  };
}
```

- [ ] **Step 5: Run everything that touches the loaders**

Run: `npm run test -- --run src/lib/klaviyo/campaign-ledger.test.ts src/lib/klaviyo/campaign-ledger.integration.test.ts src/lib/klaviyo/email-attribution.integration.test.ts && npx tsc --noEmit && npx eslint src/lib/klaviyo/campaign-ledger.ts src/lib/klaviyo/email-link-sql.ts src/lib/klaviyo/email-attribution.ts`
Expected: PASS, tsc and eslint clean. If the `flow-welcome` detail test's `points` length differs, check `window.to` handling: July is 31 days and `last` must be `2026-07-31`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/klaviyo/email-link-sql.ts src/lib/klaviyo/email-attribution.ts src/lib/klaviyo/campaign-ledger.ts src/lib/klaviyo/campaign-ledger.test.ts src/lib/klaviyo/campaign-ledger.integration.test.ts
git commit -m "feat(klaviyo): load the campaign ledger under the send-time rule"
```

---

### Task 6: `klaviyo.ledger` router and the orders source filter

**Files:**
- Modify: `src/lib/trpc/routers/klaviyo.ts` (remove `reports`; add `ledger` sub-router; `orders` input + call)
- Modify: `src/lib/klaviyo/queries.ts:121-222` (`listEvidenceOrders` gains `sourceObjectId`)
- Test: `src/lib/trpc/routers/klaviyo.test.ts`, `src/lib/klaviyo/queries.integration.test.ts` (create if absent — see Step 3)

**Interfaces:**
- Consumes: Task 5 loaders.
- Produces: `trpc.klaviyo.ledger.list({ dateFrom, dateTo, kind?, channel?, search? })` → `LedgerListResult`; `trpc.klaviyo.ledger.messages({ dateFrom, dateTo, objectId })` → `LedgerMessageRow[]` (NOT_FOUND when unknown); `trpc.klaviyo.ledger.detail({ dateFrom, dateTo, objectId })` → `LedgerDetail` (NOT_FOUND when unknown); `trpc.klaviyo.orders` accepts `sourceObjectId?: string`.

- [ ] **Step 1: Write the failing router tests**

In `src/lib/trpc/routers/klaviyo.test.ts`:

Add to `mocks`: `loadLedgerRows: vi.fn(), loadLedgerMessages: vi.fn(), loadLedgerDetail: vi.fn(),` and the module mock:

```ts
vi.mock("@/lib/klaviyo/campaign-ledger", () => ({
  loadLedgerRows: mocks.loadLedgerRows,
  loadLedgerMessages: mocks.loadLedgerMessages,
  loadLedgerDetail: mocks.loadLedgerDetail,
}));
```

Remove `listCurrentReportFacts` from the mocks object and from the `report-repository` mock, and delete the test "reads report facts only through the current-slot query". In `PROCEDURE_CALLS` add:

```ts
  ["ledger.list", (caller) => caller.ledger.list({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })],
  ["ledger.messages", (caller) => caller.ledger.messages({ dateFrom: "2026-07-01", dateTo: "2026-07-31", objectId: "obj" })],
  ["ledger.detail", (caller) => caller.ledger.detail({ dateFrom: "2026-07-01", dateTo: "2026-07-31", objectId: "obj" })],
```

and, wherever the file's `beforeEach` seeds default resolved values for the admin-passes-through test, add `mocks.loadLedgerRows.mockResolvedValue({ rows: [], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false } }); mocks.loadLedgerMessages.mockResolvedValue([]); mocks.loadLedgerDetail.mockResolvedValue({ object: {} });`. Then add a describe:

```ts
describe("campaign ledger procedures", () => {
  it("derives the window through the ACCOUNT timezone and forwards filters", async () => {
    mocks.loadLedgerRows.mockResolvedValue({ rows: [], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false } });
    await sessionCaller("admin").ledger.list({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      kind: "flow",
      channel: "sms",
      search: "  sale ",
    });
    expect(mocks.loadLedgerRows).toHaveBeenCalledWith({
      scope: mocks.connection,
      window: {
        from: new Date("2026-07-01T07:00:00.000Z"),
        to: new Date("2026-08-01T07:00:00.000Z"),
      },
      kind: "flow",
      channel: "sms",
      search: "sale",
    });
  });

  it("caps the search string", async () => {
    await expect(
      sessionCaller("admin").ledger.list({ dateFrom: "2026-07-01", dateTo: "2026-07-31", search: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps an unknown object to NOT_FOUND for messages and detail", async () => {
    mocks.loadLedgerMessages.mockResolvedValue(null);
    mocks.loadLedgerDetail.mockResolvedValue(null);
    const caller = sessionCaller("admin");
    await expect(
      caller.ledger.messages({ dateFrom: "2026-07-01", dateTo: "2026-07-31", objectId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.ledger.detail({ dateFrom: "2026-07-01", dateTo: "2026-07-31", objectId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("forwards sourceObjectId to the orders ledger", async () => {
    mocks.listEvidenceOrders.mockResolvedValue({ items: [], nextCursor: null });
    await sessionCaller("admin").orders({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      sourceObjectId: "camp-1",
    });
    expect(mocks.listEvidenceOrders).toHaveBeenCalledWith(
      expect.objectContaining({ sourceObjectId: "camp-1" }),
    );
  });

  it("no longer exposes the raw reports procedure", () => {
    expect((klaviyoRouter as unknown as { reports?: unknown }).reports).toBeUndefined();
  });
});
```

Run: `npm run test -- --run src/lib/trpc/routers/klaviyo.test.ts` → FAIL (`ledger` undefined).

- [ ] **Step 2: Implement the router**

In `src/lib/trpc/routers/klaviyo.ts`: import `loadLedgerDetail, loadLedgerMessages, loadLedgerRows` from `@/lib/klaviyo/campaign-ledger`; drop `listCurrentReportFacts` from the report-repository import; delete the whole `reports:` procedure. Add a helper near `requirePilotConnection`:

```ts
/** Report and ledger days use the bound Klaviyo ACCOUNT timezone (send-date semantics). */
function accountWindow(connection: ConnectionRecord, days: { dateFrom: string; dateTo: string }) {
  return inclusiveStoreDaysToHalfOpenUtc({
    dateFrom: days.dateFrom,
    dateTo: days.dateTo,
    timeZone: connection.accountTimezone ?? "UTC",
  });
}
```

Add before `refreshReports`:

```ts
  ledger: router({
    list: orgAdminProcedure
      .input(
        z.object({
          dateFrom: storeDaySchema,
          dateTo: storeDaySchema,
          kind: z.enum(["campaign", "flow"]).optional(),
          channel: z.enum(["email", "sms"]).optional(),
          search: z.string().trim().max(200).optional(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const connection = await requirePilotConnection(ctx.organizationId);
        return loadLedgerRows({
          scope: connection,
          window: accountWindow(connection, input),
          kind: input.kind,
          channel: input.channel,
          search: input.search,
        });
      }),
    messages: orgAdminProcedure
      .input(
        z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema, objectId: resourceIdSchema }),
      )
      .query(async ({ input, ctx }) => {
        const connection = await requirePilotConnection(ctx.organizationId);
        const messages = await loadLedgerMessages({
          scope: connection,
          window: accountWindow(connection, input),
          objectId: input.objectId,
        });
        if (messages === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
        }
        return messages;
      }),
    detail: orgAdminProcedure
      .input(
        z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema, objectId: resourceIdSchema }),
      )
      .query(async ({ input, ctx }) => {
        const connection = await requirePilotConnection(ctx.organizationId);
        const detail = await loadLedgerDetail({
          scope: connection,
          window: accountWindow(connection, input),
          objectId: input.objectId,
        });
        if (detail === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
        }
        return detail;
      }),
  }),
```

Use `accountWindow` inside `refreshReports` too (replacing its inline conversion). In `orders`, add `sourceObjectId: resourceIdSchema.optional(),` to the input and `sourceObjectId: input.sourceObjectId,` to the `listEvidenceOrders` call.

- [ ] **Step 3: The orders predicate**

In `src/lib/klaviyo/queries.ts`, add to `listEvidenceOrders`'s input type `sourceObjectId?: string;` and, after the `channel` condition:

```ts
  if (input.sourceObjectId) {
    // Same primary-claim rule as the campaign ledger, so "View all N orders"
    // lands on exactly the N orders the ledger counted.
    conditions.push(sql`(
      select coalesce(c.campaign_object_id, c.flow_object_id)
        from klaviyo_attribution_claim c
       where c.connection_id = ${klaviyoOrderMatchResults.connectionId}
         and c.conversion_event_id = ${klaviyoOrderMatchResults.selectedEventId}
         and (c.campaign_object_id is not null or c.flow_object_id is not null)
         and c.bot_click is distinct from 1
       order by c.interaction_occurred_at desc nulls last,
                c.klaviyo_attribution_id desc
       limit 1) = ${input.sourceObjectId}`);
  }
```

Add an integration test to `src/lib/klaviyo/campaign-ledger.integration.test.ts` (it already has the world), importing `listEvidenceOrders` from `@/lib/klaviyo/queries`:

```ts
  it("filters the orders ledger by the same primary-claim rule", async () => {
    await seedLedgerWorld();
    const july = await listEvidenceOrders({ scope, window: { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-09-01T00:00:00Z") }, sourceObjectId: "camp-july" });
    expect(july.items.map((item) => item.orderId).sort()).toEqual(["order-a", "order-late"]);
    const flow = await listEvidenceOrders({ scope, window, sourceObjectId: "flow-welcome" });
    expect(flow.items.map((item) => item.orderId).sort()).toEqual(["order-flow-in", "order-flow-out"]);
  });
```

(The orders view keeps its own order-date window; the flow's June-interaction order created 07-03 is inside July and therefore listed — the ledger count and the orders list agree only inside the ledger's rule, which the sheet link documents by passing the same date range.)

- [ ] **Step 4: Run and commit**

Run: `npm run test -- --run src/lib/trpc/routers/klaviyo.test.ts src/lib/klaviyo/campaign-ledger.integration.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` now fails only in `klaviyo-playground.tsx`/`reports-table.tsx` (they call the deleted `reports` procedure) — Task 7 removes them. If you prefer a green tree at every commit, leave the `reports` procedure deletion for Task 7 Step 6 instead; either is acceptable, but say which in the commit.

```bash
git add src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts src/lib/klaviyo/queries.ts src/lib/klaviyo/campaign-ledger.integration.test.ts
git commit -m "feat(klaviyo): expose ledger queries and a source filter for orders"
```

---

### Task 7: Lab wiring and the ledger table

**Files:**
- Modify: `src/components/blocks/attribution/klaviyo/copy.ts`, `use-klaviyo-lab-state.ts`, `use-klaviyo-lab-state.test.ts`, `filter-bar.tsx`, `klaviyo-playground.tsx`, `evidence-views.component.test.tsx`
- Delete: `src/components/blocks/attribution/klaviyo/reports-table.tsx`
- Create: `src/components/blocks/attribution/klaviyo/ledger/ledger-types.ts`, `ledger-format.ts`, `ledger-sort.ts`, `ledger-sort.test.ts`, `ledger-row.tsx`, `ledger-table.tsx`, `ledger-message-rows.tsx`, `ledger-table.component.test.tsx`

**Interfaces:**
- Consumes: `RouterOutputs["klaviyo"]["ledger"]["list"]` / `["messages"]`.
- Produces: lab view `ledger`; URL params `ledgerKind`, `ledgerChannel`, `q`, `source`, `sort`, `dir`; `lab.openSource(id)`, `lab.closeSource()`, `lab.viewOrdersForSource(id)`; `LedgerTable` props (below); `LEDGER_SORT_COLUMNS`, `sortLedgerRows`, `nextLedgerSort`.

- [ ] **Step 1: Copy, state, and their tests**

`copy.ts`: replace `"reports"` with `"ledger"` in `LAB_VIEWS`; delete `REPORT_KINDS` and `ReportKind`; add:

```ts
export const LEDGER_KIND_FILTERS = ["all", "campaign", "flow"] as const;
export const LEDGER_CHANNEL_FILTERS = ["all", "email", "sms"] as const;
export type LedgerKindFilter = (typeof LEDGER_KIND_FILTERS)[number];
export type LedgerChannelFilter = (typeof LEDGER_CHANNEL_FILTERS)[number];

export const ledger = {
  tab: "Campaigns",
  caption: (timezone: string, from: string, to: string) =>
    `Send dates use ${timezone} account days · ${from} → ${to}`,
  asOf: (iso: string) => `as of ${iso}`,
  refresh: "Refresh report",
  noReport: "No report for this range yet",
  noRows: "No campaigns or flows in this range",
  noResults: "No results match your filters",
  clearFilters: "Clear filters",
  error: "Couldn’t load campaigns.",
  retry: "Retry",
  ongoing: "ongoing",
  loadingMessages: "Loading messages",
  noMessages: "No messages",
  messagesError: "Couldn’t load messages.",
  columns: {
    name: "Name",
    sent: "Sent",
    recipients: "Recipients",
    delivered: "Delivered",
    open: "Open",
    click: "Click",
    orders: "Orders",
    revenue: "We confirm",
    klaviyoSays: "Klaviyo says",
    unsub: "Unsub",
  },
  chips: { campaign: "CMP", flow: "FLW", email: "EMAIL", sms: "SMS" },
  sourceFilter: "Filtered to one campaign or flow",
  clearSource: "Show all orders",
} as const;
```

`use-klaviyo-lab-state.ts`: `timezoneKind = input.view === "ledger" ? "account" : "store"`; replace `reportKind` parser with:

```ts
  ledgerKind: parseAsStringLiteral(LEDGER_KIND_FILTERS).withDefault("all"),
  ledgerChannel: parseAsStringLiteral(LEDGER_CHANNEL_FILTERS).withDefault("all"),
  q: parseAsString,
  source: parseAsString,
  sort: parseAsStringLiteral(LEDGER_SORT_COLUMNS).withDefault(DEFAULT_LEDGER_SORT.column),
  dir: parseAsStringLiteral(LEDGER_SORT_DIRECTIONS).withDefault(DEFAULT_LEDGER_SORT.direction),
```

(import from `./copy` and `./ledger/ledger-sort`). `setView` becomes:

```ts
  const setView = (view: LabView) => {
    void setState({
      view,
      ...(view === "orders" ? {} : { order: null, candidate: null }),
      // `source` means "open sheet" on the ledger and "filter" on orders; any
      // other view drops it so it cannot float.
      ...(view === "orders" || view === "ledger" ? {} : { source: null }),
    });
  };
```

Add and return:

```ts
  const openSource = (objectId: string) => void setState({ source: objectId });
  const closeSource = () => void setState({ source: null });
  const viewOrdersForSource = (objectId: string) =>
    void setState({ view: "orders", source: objectId, order: null, candidate: null });
  const toggleSort = (column: LedgerSortColumn) => {
    const next = nextLedgerSort({ column: state.sort, direction: state.dir }, column);
    void setState({ sort: next.column, dir: next.direction });
  };
```

`clearFilters` also sets `source: null`, `q: null`, `ledgerKind: "all"`, `ledgerChannel: "all"`.

`use-klaviyo-lab-state.test.ts`: change `view: "reports"` to `view: "ledger"` in the account-timezone test and its name.

- [ ] **Step 2: Sort module with its unit test**

`ledger/ledger-sort.ts`:

```ts
import { toNumber } from "@/components/blocks/manager/manager-ledger-format";

export const LEDGER_SORT_COLUMNS = [
  "sent", "recipients", "delivered", "open", "click", "orders", "revenue", "klaviyoSays", "unsub",
] as const;
export type LedgerSortColumn = (typeof LEDGER_SORT_COLUMNS)[number];
export const LEDGER_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type LedgerSortDirection = (typeof LEDGER_SORT_DIRECTIONS)[number];
export type LedgerSort = { column: LedgerSortColumn; direction: LedgerSortDirection };
/** Ranking is the job (spec §6.3): confirmed revenue descending. */
export const DEFAULT_LEDGER_SORT: LedgerSort = { column: "revenue", direction: "desc" };

/** The fields every ledger level carries; parent and message rows both fit. */
export type LedgerSortableRow = {
  name: string;
  sentAt?: string | Date | null;
  klaviyo: {
    recipients: number | null;
    unsubscribes: number | null;
    conversionValue: string | null;
  } | null;
  rates: { delivered: number | null; open: number | null; click: number | null };
  orderCount: number;
  revenue: string;
};

function sortValue(row: LedgerSortableRow, column: LedgerSortColumn): number | null {
  switch (column) {
    case "sent":
      return row.sentAt ? new Date(row.sentAt).getTime() : null;
    case "recipients":
      return row.klaviyo?.recipients ?? null;
    case "delivered":
      return row.rates.delivered;
    case "open":
      return row.rates.open;
    case "click":
      return row.rates.click;
    case "orders":
      return row.orderCount;
    case "revenue":
      return toNumber(row.revenue);
    case "klaviyoSays":
      return toNumber(row.klaviyo?.conversionValue ?? null);
    case "unsub":
      return row.klaviyo?.unsubscribes ?? null;
  }
}

/** Nulls last in both directions; ties fall back to name ascending. */
export function compareLedgerRows(a: LedgerSortableRow, b: LedgerSortableRow, sort: LedgerSort): number {
  const left = sortValue(a, sort.column);
  const right = sortValue(b, sort.column);
  if (left == null || right == null) {
    if (left != null) return -1;
    if (right != null) return 1;
  } else if (left !== right) {
    return sort.direction === "asc" ? left - right : right - left;
  }
  return a.name.localeCompare(b.name);
}

/** One sibling group at a time, so ordering never crosses parent boundaries. */
export function sortLedgerRows<T extends LedgerSortableRow>(rows: readonly T[], sort: LedgerSort): T[] {
  return [...rows].sort((a, b) => compareLedgerRows(a, b, sort));
}

/** A click on a new column starts descending; on the active column it toggles. */
export function nextLedgerSort(current: LedgerSort, column: LedgerSortColumn): LedgerSort {
  if (current.column !== column) return { column, direction: "desc" };
  return { column, direction: current.direction === "desc" ? "asc" : "desc" };
}
```

`ledger/ledger-sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_LEDGER_SORT, nextLedgerSort, sortLedgerRows } from "./ledger-sort";

const row = (name: string, revenue: string, open: number | null, sentAt: string | null = null) => ({
  name, sentAt, revenue, orderCount: 0,
  klaviyo: open === null ? null : { recipients: 10, unsubscribes: 0, conversionValue: null },
  rates: { delivered: null, open, click: null },
});

describe("sortLedgerRows", () => {
  it("defaults to confirmed revenue descending with name tie-breaks", () => {
    const sorted = sortLedgerRows([row("B", "5.00", null), row("A", "5.00", null), row("C", "9.00", null)], DEFAULT_LEDGER_SORT);
    expect(sorted.map((r) => r.name)).toEqual(["C", "A", "B"]);
  });
  it("puts null metrics last in both directions", () => {
    const rows = [row("none", "0.00", null), row("low", "0.00", 0.1), row("high", "0.00", 0.5)];
    expect(sortLedgerRows(rows, { column: "open", direction: "desc" }).map((r) => r.name)).toEqual(["high", "low", "none"]);
    expect(sortLedgerRows(rows, { column: "open", direction: "asc" }).map((r) => r.name)).toEqual(["low", "high", "none"]);
  });
  it("sorts flows (no send time) after campaigns on the Sent column", () => {
    const rows = [row("flow", "0.00", null, null), row("old", "0.00", null, "2026-07-01T00:00:00Z"), row("new", "0.00", null, "2026-07-20T00:00:00Z")];
    expect(sortLedgerRows(rows, { column: "sent", direction: "desc" }).map((r) => r.name)).toEqual(["new", "old", "flow"]);
  });
  it("toggles direction only on the active column", () => {
    expect(nextLedgerSort(DEFAULT_LEDGER_SORT, "open")).toEqual({ column: "open", direction: "desc" });
    expect(nextLedgerSort({ column: "open", direction: "desc" }, "open")).toEqual({ column: "open", direction: "asc" });
  });
});
```

Run: `npm run test -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-sort.test.ts` → PASS (write the test first; it fails until the module exists).

- [ ] **Step 3: Types and formatting**

`ledger/ledger-types.ts`:

```ts
import type { RouterOutputs } from "@/lib/trpc/client";

export type LedgerListData = RouterOutputs["klaviyo"]["ledger"]["list"];
export type LedgerRowData = LedgerListData["rows"][number];
export type LedgerMessageData = RouterOutputs["klaviyo"]["ledger"]["messages"][number];
export type LedgerDetailData = RouterOutputs["klaviyo"]["ledger"]["detail"];
export type LedgerLevel = "campaign" | "flow" | "message";

/** Client cache only; matches the Meta ledger's stale time. */
export const LEDGER_STALE_TIME_MS = 3 * 60 * 1000;
```

`ledger/ledger-format.ts`:

```ts
// Number conventions are the Meta ledger's (imported, not copied); the one
// email-specific formatter is the percent with a single decimal.
export { EM_DASH, formatCurrency, toNumber } from "@/components/blocks/manager/manager-ledger-format";
import { EM_DASH } from "@/components/blocks/manager/manager-ledger-format";

/** Rates are 0..1 ratios from the loader; null renders as a dash, never 0.0%. */
export function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return `${(value * 100).toFixed(1)}%`;
}

export function formatCount(value: number | null): string {
  return value == null ? EM_DASH : value.toLocaleString("en-US");
}

/** "Sep 1" style, in the viewer's locale; `null` is the flow's "ongoing" (copy). */
export function formatSentDay(value: string | Date | null): string | null {
  if (value == null) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
```

- [ ] **Step 4: Write the failing table component test**

`ledger/ledger-table.component.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LEDGER_SORT } from "./ledger-sort";
import { LedgerTable } from "./ledger-table";
import type { LedgerRowData } from "./ledger-types";

const stats = {
  recipients: 1000, delivered: 990, uniqueOpens: 400, uniqueClicks: 40,
  bounced: 10, unsubscribes: 2, spamComplaints: 0, conversions: 5, conversionValue: "150.00",
};

function row(overrides: Partial<LedgerRowData> = {}): LedgerRowData {
  return {
    objectId: "camp-1",
    objectType: "campaign",
    name: "July Sale",
    channel: "email",
    status: "sent",
    sentAt: "2026-07-10T09:00:00.000Z" as unknown as Date,
    messageCount: 2,
    klaviyo: stats,
    rates: { delivered: 0.99, open: 400 / 990, click: 40 / 990, unsubscribe: 2 / 990 },
    orderCount: 3,
    revenue: "97.50",
    ...overrides,
  };
}

const report = { asOf: "2026-08-02T00:00:00.000Z" as unknown as Date, hasCampaignGeneration: true, hasFlowGeneration: true };
const noop = () => undefined;

function renderTable(props: Partial<Parameters<typeof LedgerTable>[0]> = {}) {
  return render(
    <LedgerTable
      data={{ rows: [row()], report }}
      error={false}
      filtered={false}
      busy={false}
      accountTimezone="America/Los_Angeles"
      range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }}
      sort={DEFAULT_LEDGER_SORT}
      onToggleSort={noop}
      expanded={new Set()}
      onToggleExpand={noop}
      renderMessageRows={() => null}
      onOpenSource={noop}
      onRefresh={noop}
      onRetry={noop}
      onClearFilters={noop}
      {...props}
    />,
  );
}

describe("LedgerTable", () => {
  it("renders the ten columns with the row's chips, rates, and money", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent?.trim());
    expect(headers).toEqual(["", "Name", "Sent", "Recipients", "Delivered", "Open", "Click", "Orders", "We confirm", "Klaviyo says", "Unsub"]);
    const body = screen.getAllByRole("row")[1];
    expect(within(body).getByText("CMP")).toBeVisible();
    expect(within(body).getByText("EMAIL")).toBeVisible();
    expect(within(body).getByText("Jul 10")).toBeVisible();
    expect(within(body).getByText("1,000")).toBeVisible();
    expect(within(body).getByText("99.0%")).toBeVisible();
    expect(within(body).getByText("40.4%")).toBeVisible();
    expect(within(body).getByText("$97.50")).toBeVisible();
    expect(within(body).getByText("$150")).toBeVisible();
    expect(within(body).getByText("2")).toBeVisible();
    expect(screen.getByText(/Send dates use America\/Los_Angeles account days/)).toBeVisible();
    expect(screen.getByText(/as of 2026-08-02/)).toBeVisible();
  });

  it("shows dashes for a row without a fact and 'ongoing' for a flow", () => {
    renderTable({ data: { rows: [row({ objectId: "flow-1", objectType: "flow", name: "Welcome", sentAt: null, klaviyo: null, rates: { delivered: null, open: null, click: null, unsubscribe: null }, messageCount: 3 })], report } });
    const body = screen.getAllByRole("row")[1];
    expect(within(body).getByText("FLW")).toBeVisible();
    expect(within(body).getByText("ongoing")).toBeVisible();
    expect(within(body).getAllByText("—")).toHaveLength(6);
  });

  it("only offers a chevron when there is something to expand and opens the sheet on row click", async () => {
    const onToggleExpand = vi.fn();
    const onOpenSource = vi.fn();
    renderTable({
      data: { rows: [row(), row({ objectId: "camp-2", name: "Single", messageCount: 1 })], report },
      onToggleExpand,
      onOpenSource,
    });
    expect(screen.getByRole("button", { name: "Expand July Sale" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Expand Single" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Expand July Sale" }));
    expect(onToggleExpand).toHaveBeenCalledWith("camp-1");
    expect(onOpenSource).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Single"));
    expect(onOpenSource).toHaveBeenCalledWith("camp-2");
  });

  it("renders message rows under an expanded parent", () => {
    renderTable({
      expanded: new Set(["camp-1"]),
      renderMessageRows: (parent) => (
        <tr data-testid="messages">
          <td>{`children of ${parent.name}`}</td>
        </tr>
      ),
    });
    expect(screen.getByTestId("messages")).toHaveTextContent("children of July Sale");
  });

  it("sorts headers via the callback and marks the active column", async () => {
    const onToggleSort = vi.fn();
    renderTable({ onToggleSort, sort: { column: "open", direction: "asc" } });
    expect(screen.getByRole("columnheader", { name: /Open/ })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: "Sort by Unsub" }));
    expect(onToggleSort).toHaveBeenCalledWith("unsub");
  });

  it("keeps the no-report, empty, filtered, and error states distinct", () => {
    const { rerender } = renderTable({ data: { rows: [row({ klaviyo: null })], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false } } });
    expect(screen.getByText("No report for this range yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh report" })).toBeVisible();
    // Our numbers still render for the row.
    expect(screen.getByText("$97.50")).toBeVisible();
    rerender(<LedgerTable data={{ rows: [], report }} error={false} filtered={false} busy={false} accountTimezone="UTC" range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }} sort={DEFAULT_LEDGER_SORT} onToggleSort={noop} expanded={new Set()} onToggleExpand={noop} renderMessageRows={() => null} onOpenSource={noop} onRefresh={noop} onRetry={noop} onClearFilters={noop} />);
    expect(screen.getByText("No campaigns or flows in this range")).toBeVisible();
    rerender(<LedgerTable data={{ rows: [], report }} error={false} filtered={true} busy={false} accountTimezone="UTC" range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }} sort={DEFAULT_LEDGER_SORT} onToggleSort={noop} expanded={new Set()} onToggleExpand={noop} renderMessageRows={() => null} onOpenSource={noop} onRefresh={noop} onRetry={noop} onClearFilters={noop} />);
    expect(screen.getByText("No results match your filters")).toBeVisible();
    rerender(<LedgerTable data={null} error={true} filtered={false} busy={false} accountTimezone="UTC" range={{ dateFrom: "2026-07-01", dateTo: "2026-07-31" }} sort={DEFAULT_LEDGER_SORT} onToggleSort={noop} expanded={new Set()} onToggleExpand={noop} renderMessageRows={() => null} onOpenSource={noop} onRefresh={noop} onRetry={noop} onClearFilters={noop} />);
    expect(screen.getByText("Couldn’t load campaigns.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
```

Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-table.component.test.tsx` → FAIL (module missing).

- [ ] **Step 5: Row and table components**

`ledger/ledger-row.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ledger as copy } from "../copy";
import { formatCount, formatCurrency, formatPercent, formatSentDay } from "./ledger-format";
import type { LedgerLevel, LedgerMessageData, LedgerRowData } from "./ledger-types";

// Mirrors the Meta ledger's density so the two tables read identically.
export const ROW_HEIGHT = "h-[29px]";
export const CELL = "px-2 py-0 text-[13px]";
export const NUMERIC_CELL = `${CELL} text-right font-mono tabular-nums`;
export const METRIC_COLUMN = "w-[84px]";
// chevron · name · sent · 8 metrics.
export const LEDGER_COLUMN_COUNT = 11;

const LEVEL_CHIPS: Record<LedgerLevel, { label: string; className: string }> = {
  campaign: { label: copy.chips.campaign, className: "bg-primary/15 text-primary" },
  flow: { label: copy.chips.flow, className: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  message: { label: "", className: "" },
};

const LEVEL_STRIPES: Record<LedgerLevel, string> = {
  campaign: "before:bg-primary/70",
  flow: "before:bg-violet-500/70",
  message: "before:bg-border",
};

type RowShape = LedgerRowData | LedgerMessageData;

function isParent(row: RowShape): row is LedgerRowData {
  return "sentAt" in row;
}

/** Message rows show the channel chip only; parents show level + channel. */
function chipsFor(row: RowShape, level: LedgerLevel) {
  const chips: Array<{ label: string; className: string }> = [];
  if (level !== "message") chips.push(LEVEL_CHIPS[level]);
  if (row.channel === "email" || row.channel === "sms") {
    chips.push({
      label: row.channel === "email" ? copy.chips.email : copy.chips.sms,
      className: "bg-muted text-muted-foreground",
    });
  }
  return chips;
}

export function LedgerRow({
  row,
  level,
  expandable = false,
  isExpanded = false,
  onToggle,
  onOpen,
}: {
  row: RowShape;
  level: LedgerLevel;
  expandable?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
}) {
  const sent = isParent(row) ? formatSentDay(row.sentAt) : null;
  const sentLabel = isParent(row) ? (sent ?? (row.objectType === "flow" ? copy.ongoing : "—")) : "";
  return (
    <TableRow
      className={cn(ROW_HEIGHT, "group", onOpen && "cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none")}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Open ${row.name}` : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <TableCell className={cn(CELL, "w-7")} onClick={(event) => event.stopPropagation()}>
        {expandable && onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
            className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} />
          </button>
        ) : null}
      </TableCell>
      <TableCell
        className={cn(CELL, "relative before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']", LEVEL_STRIPES[level], level === "message" && "pl-6")}
      >
        <div className="flex items-center gap-2">
          {chipsFor(row, level).map((chip) => (
            <Badge key={chip.label} variant="secondary" className={cn("h-4 shrink-0 rounded px-1 font-mono text-[9px] tracking-wider", chip.className)}>
              {chip.label}
            </Badge>
          ))}
          <span className="truncate">{row.name}</span>
          {!isParent(row) && row.subject ? (
            <span className="truncate text-[11px] text-muted-foreground">· {row.subject}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className={cn(CELL, "w-16 text-muted-foreground")}>{sentLabel}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>{formatCount(row.klaviyo?.recipients ?? null)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>{formatPercent(row.rates.delivered)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>{formatPercent(row.rates.open)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>{formatPercent(row.rates.click)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>{formatCount(row.orderCount)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>{formatCurrency(row.revenue)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN, "text-muted-foreground")}>{formatCurrency(row.klaviyo?.conversionValue ?? null)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN, (row.klaviyo?.unsubscribes ?? 0) > 0 && "text-amber-600")}>{formatCount(row.klaviyo?.unsubscribes ?? null)}</TableCell>
    </TableRow>
  );
}

/** One skeleton child row at the exact row height while a messages query runs. */
export function LedgerChildSkeletonRow() {
  return (
    <TableRow className={ROW_HEIGHT}>
      <TableCell className={cn(CELL, "w-7")} />
      <TableCell className={CELL}><Skeleton className="h-3 w-56" /></TableCell>
      <TableCell className={CELL} />
      {Array.from({ length: 8 }).map((_, index) => (
        <TableCell key={index} className={NUMERIC_CELL}><Skeleton className="ml-auto h-3 w-10" /></TableCell>
      ))}
    </TableRow>
  );
}

/** Inline state row (error, empty) at the ledger's row height. */
export function LedgerStateRow({ children }: { children: ReactNode }) {
  return (
    <TableRow className={cn(ROW_HEIGHT, "hover:bg-transparent")}>
      <TableCell colSpan={LEDGER_COLUMN_COUNT} className={CELL}>{children}</TableCell>
    </TableRow>
  );
}
```

Note the "dashes" test expects six dashes on a factless flow row: Sent shows "ongoing" (not a dash), and Recipients, Delivered, Open, Click, Klaviyo says, Unsub are dashes (Orders and We confirm are `0` / `$0.00`).

`ledger/ledger-table.tsx`:

```tsx
"use client";

import { Fragment, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ledger as copy } from "../copy";
import { LabPanelState } from "../panel-state";
import { LedgerRow, LedgerStateRow, METRIC_COLUMN } from "./ledger-row";
import { LEDGER_SORT_COLUMNS, sortLedgerRows, type LedgerSort, type LedgerSortColumn } from "./ledger-sort";
import type { LedgerListData, LedgerRowData } from "./ledger-types";

const HEAD = "h-8 px-2 text-[11px] font-medium text-muted-foreground/70";
const NUMERIC_HEAD = `${HEAD} text-right`;

const COLUMN_LABELS: Record<LedgerSortColumn, string> = {
  sent: copy.columns.sent,
  recipients: copy.columns.recipients,
  delivered: copy.columns.delivered,
  open: copy.columns.open,
  click: copy.columns.click,
  orders: copy.columns.orders,
  revenue: copy.columns.revenue,
  klaviyoSays: copy.columns.klaviyoSays,
  unsub: copy.columns.unsub,
};

export function isExpandable(row: LedgerRowData): boolean {
  // A campaign always has one message; only variants are worth a level.
  return row.objectType === "flow" ? row.messageCount > 0 : row.messageCount > 1;
}

function asOfLabel(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

export function LedgerTable(props: {
  data: LedgerListData | null;
  error: boolean;
  filtered: boolean;
  busy: boolean;
  accountTimezone: string;
  range: { dateFrom: string; dateTo: string };
  sort: LedgerSort;
  onToggleSort: (column: LedgerSortColumn) => void;
  expanded: ReadonlySet<string>;
  onToggleExpand: (objectId: string) => void;
  renderMessageRows: (row: LedgerRowData) => ReactNode;
  onOpenSource: (objectId: string) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  if (props.data === null && !props.error) {
    return <LabPanelState kind="loading" title="Loading campaigns" body="" />;
  }
  const rows = props.data ? sortLedgerRows(props.data.rows, props.sort) : [];
  const report = props.data?.report ?? null;
  const noReport = report !== null && !report.hasCampaignGeneration && !report.hasFlowGeneration;
  const asOf = asOfLabel(report?.asOf ?? null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {copy.caption(props.accountTimezone, props.range.dateFrom, props.range.dateTo)}
          {asOf ? ` · ${copy.asOf(asOf)}` : ""}
        </p>
        <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onRefresh}>
          {copy.refresh}
        </Button>
      </div>
      {noReport ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{copy.noReport}</p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "w-7")} />
              <TableHead className={HEAD}>{copy.columns.name}</TableHead>
              {LEDGER_SORT_COLUMNS.map((column) => (
                <TableHead
                  key={column}
                  className={cn(column === "sent" ? cn(HEAD, "w-16") : cn(NUMERIC_HEAD, METRIC_COLUMN))}
                  aria-sort={props.sort.column === column ? (props.sort.direction === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    aria-label={`Sort by ${COLUMN_LABELS[column]}`}
                    onClick={() => props.onToggleSort(column)}
                    className={cn("inline-flex items-center gap-0.5 hover:text-foreground", column !== "sent" && "ml-auto")}
                  >
                    {COLUMN_LABELS[column]}
                    {props.sort.column === column ? (
                      props.sort.direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                    ) : null}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.error ? (
              <LedgerStateRow>
                <span className="text-muted-foreground">{copy.error}</span>{" "}
                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[12px]" onClick={props.onRetry}>{copy.retry}</Button>
              </LedgerStateRow>
            ) : null}
            {!props.error && rows.length === 0 ? (
              <LedgerStateRow>
                <span className="text-muted-foreground">{props.filtered ? copy.noResults : copy.noRows}</span>
                {props.filtered ? (
                  <Button variant="ghost" size="sm" className="ml-1 h-5 px-1.5 text-[12px]" onClick={props.onClearFilters}>{copy.clearFilters}</Button>
                ) : null}
              </LedgerStateRow>
            ) : null}
            {rows.map((row) => {
              const expandable = isExpandable(row);
              const isExpanded = expandable && props.expanded.has(row.objectId);
              return (
                <Fragment key={row.objectId}>
                  <LedgerRow
                    row={row}
                    level={row.objectType}
                    expandable={expandable}
                    isExpanded={isExpanded}
                    onToggle={() => props.onToggleExpand(row.objectId)}
                    onOpen={() => props.onOpenSource(row.objectId)}
                  />
                  {isExpanded ? props.renderMessageRows(row) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

`ledger/ledger-message-rows.tsx` (query-backed, mounted only while expanded):

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { ledger as copy } from "../copy";
import { LedgerChildSkeletonRow, LedgerRow, LedgerStateRow } from "./ledger-row";
import { sortLedgerRows, type LedgerSort } from "./ledger-sort";
import { LEDGER_STALE_TIME_MS, type LedgerRowData } from "./ledger-types";

export function LedgerMessageRows({
  parent,
  range,
  sort,
}: {
  parent: LedgerRowData;
  range: { dateFrom: string; dateTo: string };
  sort: LedgerSort;
}) {
  const trpc = useTRPC();
  const messages = useQuery(
    trpc.klaviyo.ledger.messages.queryOptions(
      { dateFrom: range.dateFrom, dateTo: range.dateTo, objectId: parent.objectId },
      { staleTime: LEDGER_STALE_TIME_MS },
    ),
  );
  if (messages.isPending) return <LedgerChildSkeletonRow />;
  if (messages.isError) {
    return (
      <LedgerStateRow>
        <span className="pl-6 text-muted-foreground">{copy.messagesError}</span>
      </LedgerStateRow>
    );
  }
  if (messages.data.length === 0) {
    return (
      <LedgerStateRow>
        <span className="pl-6 text-muted-foreground">{copy.noMessages}</span>
      </LedgerStateRow>
    );
  }
  return (
    <>
      {sortLedgerRows(messages.data, sort).map((message) => (
        <LedgerRow key={message.objectId} row={message} level="message" />
      ))}
    </>
  );
}
```

Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-table.component.test.tsx` → PASS. Adjust the `getAllByText("—")` count if the dash count differs, but only after confirming which cells you expect to dash.

- [ ] **Step 6: Wire the playground and filter bar; delete the Reports view**

`klaviyo-playground.tsx`:
- Replace the `ReportsTable` import with `import { LedgerTable } from "./ledger/ledger-table"; import { LedgerMessageRows } from "./ledger/ledger-message-rows";` and `import { LEDGER_REFRESH_KINDS, ledger as ledgerCopy } from "./copy";`. Do **not** import `@/lib/klaviyo/reports` here: it pulls `node:crypto` into a client bundle. Add to `copy.ts` instead:

```ts
/** Mirrors KLAVIYO_REPORT_KINDS for the browser (reports.ts is server-side). */
export const LEDGER_REFRESH_KINDS = ["campaign", "flow", "campaign_message", "flow_message"] as const;
```

and use `kinds: [...LEDGER_REFRESH_KINDS]` in the refresh call below.
- `VIEW_LABELS`: replace `reports: "Reports"` with `ledger: ledgerCopy.tab`.
- Replace the `view === "reports"` block with:

```tsx
          {view === "ledger" ? (
            <LedgerView
              range={range}
              lab={lab}
              accountTimezone={health.data?.connection?.timezone ?? "UTC"}
              busy={anyMutationPending || queuedOperation !== null}
              onRefresh={() =>
                refreshReports.mutate({
                  dateFrom: range.dateFrom,
                  dateTo: range.dateTo,
                  kinds: [...LEDGER_REFRESH_KINDS],
                })
              }
            />
          ) : null}
```

- Replace `function ReportsView` with:

```tsx
function LedgerView(props: {
  range: { dateFrom: string; dateTo: string };
  lab: ReturnType<typeof useKlaviyoLabState>;
  accountTimezone: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  const trpc = useTRPC();
  const { state } = props.lab;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const search = state.q?.trim() ?? "";
  const list = useQuery(
    trpc.klaviyo.ledger.list.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
      kind: state.ledgerKind === "all" ? undefined : state.ledgerKind,
      channel: state.ledgerChannel === "all" ? undefined : state.ledgerChannel,
      search: search === "" ? undefined : search,
    }),
  );
  const filtered = state.ledgerKind !== "all" || state.ledgerChannel !== "all" || search !== "";
  const sort = { column: state.sort, direction: state.dir };
  return (
    <LedgerTable
      data={list.data ?? null}
      error={list.isError}
      filtered={filtered}
      busy={props.busy}
      accountTimezone={props.accountTimezone}
      range={props.range}
      sort={sort}
      onToggleSort={props.lab.toggleSort}
      expanded={expanded}
      onToggleExpand={(objectId) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(objectId)) next.add(objectId);
          return next;
        })
      }
      renderMessageRows={(row) => <LedgerMessageRows parent={row} range={props.range} sort={sort} />}
      onOpenSource={props.lab.openSource}
      onRefresh={props.onRefresh}
      onRetry={() => void list.refetch()}
      onClearFilters={props.lab.clearFilters}
    />
  );
}
```

- In `OrdersView`, pass `sourceObjectId: state.source ?? undefined,` to the infinite query input and include `state.source !== null` in `filtered`.

`filter-bar.tsx`:
- `timezoneLabel`: `props.view === "ledger" ? \`Send dates use ${props.accountTimezone} account days\` : ...`.
- The shared channel select renders for `orders` and `unmatched` only (drop `reports`).
- Replace the report-kind select with the ledger controls:

```tsx
      {props.view === "ledger" ? (
        <>
          <Select value={state.ledgerKind} onValueChange={(value) => void setState({ ledgerKind: value as LedgerKindFilter })}>
            <SelectTrigger className="h-8 w-36" aria-label="Kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Campaigns & flows</SelectItem>
              <SelectItem value="campaign">Campaigns</SelectItem>
              <SelectItem value="flow">Flows</SelectItem>
            </SelectContent>
          </Select>
          <Select value={state.ledgerChannel} onValueChange={(value) => void setState({ ledgerChannel: value as LedgerChannelFilter })}>
            <SelectTrigger className="h-8 w-32" aria-label="Channel"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
            </SelectContent>
          </Select>
          <LedgerSearch value={state.q ?? ""} onChange={(q) => void setState({ q: q === "" ? null : q })} />
        </>
      ) : null}
      {props.view === "orders" && state.source !== null ? (
        <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
          {ledgerCopy.sourceFilter}
          <button type="button" aria-label={ledgerCopy.clearSource} className="text-muted-foreground hover:text-foreground" onClick={() => void setState({ source: null })}>
            <X className="size-3" />
          </button>
        </span>
      ) : null}
```

with a 300 ms debounced input in the same file:

```tsx
function LedgerSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, onChange, value]);
  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder="Search campaigns and flows"
      aria-label="Search"
      className="h-8 w-56"
    />
  );
}
```

(imports: `Input` from `@/components/ui/input`, `X` from `@/components/icons`, `useEffect, useState` from `react`, `ledger as ledgerCopy, type LedgerChannelFilter, type LedgerKindFilter` from `./copy`; drop `REPORT_KINDS`.)

Delete `reports-table.tsx`; in `evidence-views.component.test.tsx` remove the `ReportsTable` import and its whole `describe("ReportsTable", ...)` block.

- [ ] **Step 7: Run every affected suite**

Run: `npm run test:components && npm run test -- --run src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.test.ts src/components/blocks/attribution/klaviyo/ledger/ledger-sort.test.ts && npx tsc --noEmit && npx eslint src/components/blocks/attribution/klaviyo`
Expected: PASS; tsc and eslint clean (no `lucide-react`, no unused `REPORT_KINDS`).

- [ ] **Step 8: Commit**

```bash
git add src/components/blocks/attribution/klaviyo
git commit -m "feat(klaviyo): replace the lab reports view with the campaign ledger"
```

---

### Task 8: The detail sheet

**Files:**
- Create: `src/components/blocks/attribution/klaviyo/ledger/ledger-funnel.tsx`, `ledger-day-bars.tsx`, `ledger-detail-content.tsx`, `ledger-detail-sheet.tsx`, `ledger-detail-content.component.test.tsx`
- Modify: `copy.ts` (sheet strings), `klaviyo-playground.tsx` (mount the sheet)

**Interfaces:**
- Consumes: `trpc.klaviyo.ledger.detail`, `lab.state.source`, `lab.closeSource`, `lab.viewOrdersForSource`, `LedgerRow` (Task 7).
- Produces: `LedgerDetailContent({ detail, onViewOrders })` (pure), `LedgerDetailSheet({ lab, range })` (query-backed).

- [ ] **Step 1: Sheet copy**

Add to `ledger` in `copy.ts`:

```ts
  sheet: {
    title: "Campaign detail",
    advisory: "Advisory evidence only",
    sentAt: (day: string) => `Sent ${day}`,
    subject: (subject: string) => `Subject: “${subject}”`,
    funnel: "Funnel",
    recipients: "recipients",
    delivered: "delivered",
    opened: "opened",
    clicked: "clicked",
    ordered: "ordered ✓",
    revenue: "Revenue",
    weConfirm: "We confirm",
    weConfirmNote: (orders: number) => `${orders} order${orders === 1 ? "" : "s"}, refund-net`,
    klaviyoSays: "Klaviyo says",
    unconfirmed: (orders: number) => `${orders} order${orders === 1 ? "" : "s"} we couldn’t confirm`,
    perRecipient: "Per recipient",
    aov: (amount: string) => `AOV ${amount}`,
    listImpact: "List impact",
    unsubscribed: "Unsubscribed",
    spam: "Spam complaints",
    bounced: "Bounced",
    ordersByDayOffset: "Confirmed orders by day after send",
    ordersByDayCalendar: "Confirmed orders by day",
    viewOrders: (orders: number) => `View all ${orders} order${orders === 1 ? "" : "s"} in Orders →`,
    topProducts: "Top products",
    variants: "Variants (A/B)",
    emails: "Emails in this flow",
    loading: "Loading campaign detail",
    error: "Couldn’t load this campaign.",
  },
```

- [ ] **Step 2: Write the failing content test**

`ledger/ledger-detail-content.component.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LedgerDetailContent } from "./ledger-detail-content";
import type { LedgerDetailData } from "./ledger-types";

const stats = {
  recipients: 18420, delivered: 18254, uniqueOpens: 7520, uniqueClicks: 694,
  bounced: 163, unsubscribes: 38, spamComplaints: 2, conversions: 226, conversionValue: "12980.00",
};

function detail(overrides: Partial<LedgerDetailData> = {}): LedgerDetailData {
  return {
    object: {
      objectId: "camp-1", objectType: "campaign", name: "Labor Day Sale", channel: "email", status: "sent",
      sentAt: "2026-09-01T09:00:00.000Z" as unknown as Date, subject: "20% off ends tonight", messageCount: 2,
    },
    klaviyo: stats,
    rates: { delivered: 18254 / 18420, open: 7520 / 18254, click: 694 / 18254, unsubscribe: 38 / 18254 },
    ours: { orderCount: 212, revenue: "11904.00" },
    reconciliation: { unconfirmedOrders: 14, revenuePerRecipient: "0.65", averageOrderValue: "56.15" },
    ordersByDay: {
      mode: "offset",
      points: Array.from({ length: 14 }, (_, i) => ({ label: String(i), orders: i === 0 ? 120 : i === 1 ? 60 : 0, netSales: "0.00" })),
    },
    topProducts: [
      { productKey: "1", title: "Vitamin C Serum", units: 88, orderCount: 80, orderRevenue: "4290.00" },
    ],
    messages: [
      { objectId: "m-a", objectType: "campaign_message", name: "A", subject: "20% off ends tonight", channel: "email", klaviyo: { ...stats, uniqueOpens: 4000 }, rates: { delivered: 0.99, open: 0.43, click: 0.04, unsubscribe: 0.002 }, orderCount: 120, revenue: "6410.00" },
      { objectId: "m-b", objectType: "campaign_message", name: "B", subject: "Last call", channel: "email", klaviyo: stats, rates: { delivered: 0.99, open: 0.394, click: 0.03, unsubscribe: 0.002 }, orderCount: 92, revenue: "5494.00" },
    ],
    ...overrides,
  };
}

describe("LedgerDetailContent", () => {
  it("renders all seven blocks for a campaign with variants", async () => {
    const onViewOrders = vi.fn();
    render(<LedgerDetailContent detail={detail()} onViewOrders={onViewOrders} />);
    expect(screen.getByRole("heading", { name: "Labor Day Sale" })).toBeVisible();
    expect(screen.getByText(/Subject: “20% off ends tonight”/)).toBeVisible();
    expect(screen.getByTestId("funnel-recipients")).toHaveTextContent("18,420");
    expect(screen.getByTestId("funnel-opened")).toHaveTextContent("41.2%");
    expect(screen.getByTestId("funnel-ordered")).toHaveTextContent("212");
    expect(screen.getByTestId("we-confirm")).toHaveTextContent("$11904");
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("$12980");
    expect(screen.getByText("14 orders we couldn’t confirm")).toBeVisible();
    expect(screen.getByTestId("per-recipient")).toHaveTextContent("$0.65");
    expect(screen.getByText("AOV $56.15")).toBeVisible();
    expect(screen.getByTestId("list-unsubscribed")).toHaveTextContent("38");
    expect(screen.getByTestId("list-unsubscribed")).toHaveTextContent("0.2%");
    expect(screen.getByText("Confirmed orders by day after send")).toBeVisible();
    expect(screen.getAllByTestId("day-bar")).toHaveLength(14);
    await userEvent.click(screen.getByRole("button", { name: "View all 212 orders in Orders →" }));
    expect(onViewOrders).toHaveBeenCalledOnce();
    expect(screen.getByText("Vitamin C Serum")).toBeVisible();
    expect(screen.getByText("Variants (A/B)")).toBeVisible();
    expect(screen.getByText("Last call")).toBeVisible();
  });

  it("dashes Klaviyo blocks without a fact and hides the variants block for a single message", () => {
    render(
      <LedgerDetailContent
        detail={detail({
          klaviyo: null,
          rates: { delivered: null, open: null, click: null, unsubscribe: null },
          reconciliation: { unconfirmedOrders: null, revenuePerRecipient: null, averageOrderValue: "56.15" },
          object: { ...detail().object, messageCount: 1 },
          messages: [],
        })}
        onViewOrders={() => undefined}
      />,
    );
    expect(screen.getByTestId("funnel-opened")).toHaveTextContent("—");
    expect(screen.getByTestId("klaviyo-says")).toHaveTextContent("—");
    expect(screen.queryByText(/we couldn’t confirm/)).toBeNull();
    expect(screen.getByTestId("list-unsubscribed")).toHaveTextContent("—");
    expect(screen.queryByText("Variants (A/B)")).toBeNull();
  });

  it("labels a flow as ongoing with calendar-day bars and an emails block", () => {
    render(
      <LedgerDetailContent
        detail={detail({
          object: { ...detail().object, objectType: "flow", name: "Welcome", sentAt: null, subject: null, messageCount: 3 },
          ordersByDay: { mode: "calendar", points: [{ label: "2026-07-01", orders: 2, netSales: "80.00" }, { label: "2026-07-02", orders: 0, netSales: "0.00" }] },
        })}
        onViewOrders={() => undefined}
      />,
    );
    expect(screen.getByText("ongoing")).toBeVisible();
    expect(screen.getByText("Confirmed orders by day")).toBeVisible();
    expect(screen.getAllByTestId("day-bar")).toHaveLength(2);
    expect(screen.getByText("Emails in this flow")).toBeVisible();
  });
});
```

Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-detail-content.component.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Funnel and bars**

`ledger/ledger-funnel.tsx`:

```tsx
"use client";

import { cn } from "@/lib/utils";
import { ledger as copy } from "../copy";
import { formatCount, formatPercent } from "./ledger-format";
import type { LedgerDetailData } from "./ledger-types";

/** Five equal cells: recipients → delivered → opened → clicked → ordered (ours). */
export function LedgerFunnel({ detail }: { detail: LedgerDetailData }) {
  const cells: Array<{ id: string; value: string; label: string; last?: boolean }> = [
    { id: "recipients", value: formatCount(detail.klaviyo?.recipients ?? null), label: copy.sheet.recipients },
    { id: "delivered", value: formatPercent(detail.rates.delivered), label: copy.sheet.delivered },
    { id: "opened", value: formatPercent(detail.rates.open), label: copy.sheet.opened },
    { id: "clicked", value: formatPercent(detail.rates.click), label: copy.sheet.clicked },
    { id: "ordered", value: formatCount(detail.ours.orderCount), label: copy.sheet.ordered, last: true },
  ];
  return (
    <div className="grid grid-cols-5 gap-1">
      {cells.map((cell) => (
        <div
          key={cell.id}
          data-testid={`funnel-${cell.id}`}
          className={cn("rounded px-1.5 py-1.5", cell.last ? "bg-emerald-600/15" : "bg-muted")}
        >
          <p className="font-mono text-[12px] font-semibold tabular-nums">{cell.value}</p>
          <p className="text-[10px] text-muted-foreground">{cell.label}</p>
        </div>
      ))}
    </div>
  );
}
```

`ledger/ledger-day-bars.tsx` (plain divs, no chart library, like the list-health strip):

```tsx
"use client";

import type { LedgerDetailData } from "./ledger-types";

export function LedgerDayBars({ ordersByDay }: { ordersByDay: LedgerDetailData["ordersByDay"] }) {
  const max = Math.max(1, ...ordersByDay.points.map((point) => point.orders));
  return (
    <div className="flex h-10 items-end gap-[2px]" role="img" aria-label="Confirmed orders per day">
      {ordersByDay.points.map((point) => (
        <div
          key={point.label}
          data-testid="day-bar"
          title={`${ordersByDay.mode === "offset" ? `Day ${point.label}` : point.label}: ${point.orders} orders`}
          className="min-w-[3px] flex-1 rounded-t-[2px] bg-emerald-600"
          style={{ height: `${Math.max(point.orders === 0 ? 2 : 6, (point.orders / max) * 100)}%`, opacity: point.orders === 0 ? 0.25 : 1 }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Content and sheet**

`ledger/ledger-detail-content.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ledger as copy } from "../copy";
import { LedgerDayBars } from "./ledger-day-bars";
import { formatCount, formatCurrency, formatPercent, formatSentDay } from "./ledger-format";
import { LedgerFunnel } from "./ledger-funnel";
import type { LedgerDetailData } from "./ledger-types";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value, note, testId, tone }: { label: string; value: string; note?: string | null; testId?: string; tone?: "warn" }) {
  return (
    <div className="contents">
      <span className="text-muted-foreground">{label}</span>
      <span data-testid={testId} className={tone === "warn" ? "font-mono font-semibold text-amber-600" : "font-mono font-semibold"}>
        {value}
        {note ? <span className="ml-1 font-sans font-normal text-muted-foreground">{note}</span> : null}
      </span>
    </div>
  );
}

function rateNote(numerator: number | null, rate: number | null): string | null {
  return numerator == null ? null : formatPercent(rate);
}

export function LedgerDetailContent({ detail, onViewOrders }: { detail: LedgerDetailData; onViewOrders: () => void }) {
  const { object, klaviyo, rates, ours, reconciliation } = detail;
  const sent = formatSentDay(object.sentAt);
  const isFlow = object.objectType === "flow";
  const bouncedRate = klaviyo?.bounced == null || klaviyo.recipients == null || klaviyo.recipients <= 0 ? null : klaviyo.bounced / klaviyo.recipients;
  const spamRate = klaviyo?.spamComplaints == null || klaviyo.delivered == null || klaviyo.delivered <= 0 ? null : klaviyo.spamComplaints / klaviyo.delivered;

  return (
    <div className="space-y-4 text-[12px]">
      <header className="space-y-0.5">
        <h2 className="text-[14px] font-semibold">{object.name}</h2>
        {/* Each segment is its own span so tests and screen readers get one
            phrase per node ("ongoing", the subject) rather than one run-on. */}
        <p className="flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className="h-4 rounded px-1 font-mono text-[9px]">{isFlow ? copy.chips.flow : copy.chips.campaign}</Badge>
          {object.channel ? <span>{object.channel.toUpperCase()} ·</span> : null}
          <span>{sent ? copy.sheet.sentAt(sent) : copy.ongoing}</span>
          {object.subject ? <span>· {copy.sheet.subject(object.subject)}</span> : null}
        </p>
      </header>

      <Block title={copy.sheet.funnel}><LedgerFunnel detail={detail} /></Block>

      <Block title={copy.sheet.revenue}>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <Stat label={copy.sheet.weConfirm} value={formatCurrency(ours.revenue)} note={copy.sheet.weConfirmNote(ours.orderCount)} testId="we-confirm" />
          <Stat
            label={copy.sheet.klaviyoSays}
            value={formatCurrency(klaviyo?.conversionValue ?? null)}
            note={reconciliation.unconfirmedOrders != null && reconciliation.unconfirmedOrders > 0 ? copy.sheet.unconfirmed(reconciliation.unconfirmedOrders) : null}
            testId="klaviyo-says"
          />
          <Stat
            label={copy.sheet.perRecipient}
            value={formatCurrency(reconciliation.revenuePerRecipient)}
            note={reconciliation.averageOrderValue ? copy.sheet.aov(formatCurrency(reconciliation.averageOrderValue)) : null}
            testId="per-recipient"
          />
        </div>
      </Block>

      <Block title={copy.sheet.listImpact}>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <Stat label={copy.sheet.unsubscribed} value={formatCount(klaviyo?.unsubscribes ?? null)} note={rateNote(klaviyo?.unsubscribes ?? null, rates.unsubscribe)} testId="list-unsubscribed" tone={(klaviyo?.unsubscribes ?? 0) > 0 ? "warn" : undefined} />
          <Stat label={copy.sheet.spam} value={formatCount(klaviyo?.spamComplaints ?? null)} note={rateNote(klaviyo?.spamComplaints ?? null, spamRate)} testId="list-spam" />
          <Stat label={copy.sheet.bounced} value={formatCount(klaviyo?.bounced ?? null)} note={rateNote(klaviyo?.bounced ?? null, bouncedRate)} testId="list-bounced" />
        </div>
      </Block>

      <Block title={detail.ordersByDay.mode === "offset" ? copy.sheet.ordersByDayOffset : copy.sheet.ordersByDayCalendar}>
        <LedgerDayBars ordersByDay={detail.ordersByDay} />
        <Button variant="link" size="sm" className="h-auto p-0 text-[11.5px]" onClick={onViewOrders}>
          {copy.sheet.viewOrders(ours.orderCount)}
        </Button>
      </Block>

      {detail.topProducts.length > 0 ? (
        <Block title={copy.sheet.topProducts}>
          <table className="w-full text-[11px]">
            <tbody>
              {detail.topProducts.map((product) => (
                <tr key={product.productKey} className="border-b border-border/60">
                  <td className="py-0.5 pr-2">{product.title}</td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatCount(product.units)} units</td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatCurrency(product.orderRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ) : null}

      {detail.messages.length > 0 ? (
        <Block title={isFlow ? copy.sheet.emails : copy.sheet.variants}>
          <table className="w-full text-[11px]">
            <tbody>
              {detail.messages.map((message) => (
                <tr key={message.objectId} className="border-b border-border/60">
                  <td className="py-0.5 pr-2">
                    {message.name}
                    {message.subject ? <span className="text-muted-foreground"> · {message.subject}</span> : null}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatPercent(message.rates.open)} open</td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatCurrency(message.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ) : null}
    </div>
  );
}
```

`ledger/ledger-detail-sheet.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTRPC } from "@/lib/trpc/client";
import { ledger as copy } from "../copy";
import { LabPanelState } from "../panel-state";
import type { useKlaviyoLabState } from "../use-klaviyo-lab-state";
import { LedgerDetailContent } from "./ledger-detail-content";
import { LEDGER_STALE_TIME_MS } from "./ledger-types";

/**
 * URL-addressable (`source=<objectId>`) one-third-width sheet. Only the
 * ledger view opens it; on the orders view the same param is a filter.
 */
export function LedgerDetailSheet({
  lab,
  range,
}: {
  lab: ReturnType<typeof useKlaviyoLabState>;
  range: { dateFrom: string; dateTo: string } | null;
}) {
  const trpc = useTRPC();
  const objectId = lab.state.view === "ledger" ? lab.state.source : null;
  const detail = useQuery({
    ...trpc.klaviyo.ledger.detail.queryOptions(
      { dateFrom: range?.dateFrom ?? "", dateTo: range?.dateTo ?? "", objectId: objectId ?? "" },
      { staleTime: LEDGER_STALE_TIME_MS },
    ),
    enabled: objectId !== null && range !== null,
    retry: false,
  });
  if (objectId === null) return null;
  return (
    <Sheet open onOpenChange={(open) => { if (!open) lab.closeSource(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:w-[33vw] sm:min-w-[380px] sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{copy.sheet.title}</SheetTitle>
          <p className="text-xs text-muted-foreground">{copy.sheet.advisory}</p>
        </SheetHeader>
        <div className="px-4 pb-6">
          {detail.isError ? (
            <LabPanelState kind="error" title={copy.sheet.error} body="" onRetry={() => void detail.refetch()} />
          ) : !detail.data ? (
            <LabPanelState kind="loading" title={copy.sheet.loading} body="" />
          ) : (
            <LedgerDetailContent detail={detail.data} onViewOrders={() => lab.viewOrdersForSource(detail.data.object.objectId)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

In `klaviyo-playground.tsx`, next to `<OrderDetailSheet lab={lab} />` add `<LedgerDetailSheet lab={lab} range={range} />` (import from `./ledger/ledger-detail-sheet`).

- [ ] **Step 5: Run, lint, commit**

Run: `npm run test:components && npx tsc --noEmit && npx eslint src/components/blocks/attribution/klaviyo`
Expected: PASS and clean. If `formatCurrency("11904.00")` renders `$11904` (its ≥100 rule drops decimals) the test's `$11904` assertion already matches; keep the panel's formatter — the Meta ledger uses the same.

```bash
git add src/components/blocks/attribution/klaviyo
git commit -m "feat(klaviyo): open a campaign detail sheet from the ledger"
```

---

### Task 9: Full verification, PR body, and memory

**Files:**
- Create: `rands/pr-body-klaviyo-campaign-ledger.md` (git-ignored; never staged)
- Modify: `/Users/ivan/.claude/projects/-Users-ivan-Documents-Projects-creatives-tracker/memory/` (a `project-klaviyo-campaign-ledger-status.md` entry + `MEMORY.md` line)

- [ ] **Step 1: The whole battery**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL' .env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')"
npm run test 2>&1 | tail -5
npm run test:components 2>&1 | tail -3
npx tsc --noEmit && echo TSC-CLEAN
npm run lint 2>&1 | tail -3
node scripts/check-migrations.mjs
```

Expected: all test files pass (the `shopify-store.integration.test.ts` orphan test is a known flake: re-run it alone if it is the only failure), 151+ component tests pass, tsc clean, lint clean, migrations chain intact.

- [ ] **Step 2: Manual grouping probe (dev credentials, read-only)**

With the dev `.env` loaded, run a one-off script from the scratchpad that instantiates `KlaviyoApiClient` with the pilot key and calls `queryValuesReport` for `kind: "campaign_message"` over the last 7 days, printing only the HTTP status and the first row's `groupings` keys — never the key, never row values. If the revision rejects `group_by`, note the error body's `detail` field in the PR body under "Grouping probe" and confirm the fallback path (Task 3) is what production will exercise; the ledger still ships. If it accepts, note the returned grouping keys.

- [ ] **Step 3: PR body**

Write `rands/pr-body-klaviyo-campaign-ledger.md` following the structure of `rands/pr-body-claims-continuity.md`: summary, what changed (data/sync, loaders, API, UI), the decisions from spec §1's table, the grouping probe result, verification counts, rollout steps (apply migration 0074 in prod with `bun run db:migrate:prod`, then a manual Refresh in the lab, then let the nightly run take over), and follow-ups (full lab redesign, spec §10).

- [ ] **Step 4: Memory and push**

Write the memory file with the branch, status, and rollout steps; add its line to `MEMORY.md`. Then:

```bash
git push -u origin feat/klaviyo-campaign-ledger
```

Report: commit list, test counts, probe outcome, and the PR body path.

