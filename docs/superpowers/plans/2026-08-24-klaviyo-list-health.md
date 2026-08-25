# Klaviyo List Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track list subscribes, unsubscribes, won-backs, and quick churn through a third `consent` source mode, with a one-line strip in the Email revenue panel and a full Lab tab.

**Architecture:** Two new metric kinds ride the existing event engine via a `consent` source contract modeled on the journey contract; the journey batch machinery is parameterized (not duplicated) into a shared timeline path. Aggregates and flips are computed in TypeScript over fetched consent events (low volume) in a new `list-health` module, exposed by one `klaviyo.listHealth` query consumed by both UI surfaces. **No schema changes, no migrations** — the DB does not constrain metric kinds.

**Tech Stack:** Next.js 16, tRPC 11, Drizzle (node-postgres), Trigger.dev v4, Vitest 4 (+ jsdom for `.component.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-08-24-klaviyo-list-health-design.md`

---

## Before you start

- Branch `feat/klaviyo-list-health` (off main) is checked out with the spec committed. Never stage the user's uncommitted `.gitignore`.
- Commands: `npm run test -- --run <file>` (never `bun test`), `npm run test:components`, `npx tsc --noEmit`, `npx eslint <files>` (repo-wide `bun run lint` scans a local cache dir — known noise). Postgres runs in docker (`creatives-tracker-db-1`); integration tests manage disposable DBs.
- Commits: conventional title ONLY (no body, no trailers).
- Money-string and UTC rules don't apply here (no money), but the **UTC window rule does**: never interpolate raw `Date` into raw `sql` templates — use ISO text + `::timestamp` (see `utcTimestamp` in `src/lib/klaviyo/email-attribution.ts:115-124`).

## Recorded deviations from the spec (carry into the PR body)

1. **No migration.** `klaviyo_metric.canonical_kind` is unconstrained text (`drizzle/0056_klaviyo_source_core.sql:143`); kinds are gated in code only.
2. **No plaintext list reference stored in v1.** Redaction is fail-closed: only probe-approved alias keys survive into `redacted_properties`, and consent kinds (like journey kinds) run with an empty alias registry — unknown property keys are hashed into the key-type fingerprint, never stored plaintext. Storing `listId`/`listName` would require inventing an unverified static allowlist. Instead, v1 aggregates across lists (as approved), and the stored key fingerprints let us verify Klaviyo's real property names from live data before allowlisting them in a follow-up. Consequence: a cross-list unsub→sub counts as won-back — documented v1 coarseness.
3. **Flip computation is TypeScript, not SQL `LAG()`.** Consent volume is hundreds of events per 90d; fetching `{profileId, metricKind, occurredAt}` rows and computing totals/daily/flips in a pure function is simpler, uses the codebase's `deriveDayInTimezone` idiom (there is no `AT TIME ZONE` SQL anywhere in `src/`), and is exhaustively unit-testable without a DB.

## File structure

- Modify: `src/lib/klaviyo/types.ts` — consent kinds, contract, factory, asserts, checkpoint factory
- Modify: `src/lib/klaviyo/discovery.ts` — two metric-name map entries
- Modify: `src/lib/klaviyo/source-runner.ts` — parameterize journey machinery into a timeline-mode config; add `startOrResumeConsentSync`, consent bindings, dispatch branch
- Modify: `src/lib/klaviyo/incremental-sync.ts` + `trigger/klaviyo-incremental.ts` — consent supervisor stage
- Create: `src/lib/klaviyo/list-health.ts` — `computeListHealth` (pure) + `loadListHealth` (fetch)
- Create: `src/lib/klaviyo/list-health.test.ts` (pure-function unit tests)
- Create: `src/lib/klaviyo/list-health.integration.test.ts` (disposable-PG, harness world)
- Modify: `src/lib/trpc/routers/klaviyo.ts` + `klaviyo.test.ts` — `listHealth` query
- Modify: `src/components/blocks/attribution/klaviyo/copy.ts` — `LAB_VIEWS` + `listHealth` copy
- Create: `src/components/blocks/attribution/klaviyo/list-health-table.tsx` — presentational Lab view (KPIs, bars, daily table)
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-list-health.tsx` — panel strip (presentational)
- Modify: `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx` — mount strip + query
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx` — `VIEW_LABELS` + `ListHealthView`
- Create: `src/components/blocks/attribution/klaviyo/list-health.component.test.tsx`
- Modify: `src/lib/klaviyo/source-runner.test.ts`, `src/lib/klaviyo/discovery.test.ts`, `src/lib/klaviyo/incremental-sync.test.ts`

---

### Task 1: Consent kinds and contract in `types.ts`

**Files:**
- Modify: `src/lib/klaviyo/types.ts`
- Test: find the existing journey-contract assertions (grep `assertJourneySourceContract` in `src/lib/klaviyo/*.test.ts`; they live where the journey ones are tested — mirror in the same file)

- [ ] **Step 1: Write failing tests** mirroring the journey contract tests in the same test file (exact expectations):

```ts
describe("consent source contract", () => {
  it("builds the fixed two-kind contract", () => {
    expect(consentSourceContract()).toEqual({
      sourceMode: "consent",
      metricKinds: ["subscribed_to_list", "unsubscribed_from_list"],
    });
  });

  it("accepts only the exact consent shape", () => {
    expect(() =>
      assertExactEventSourceContract(consentSourceContract()),
    ).not.toThrow();
    expect(() =>
      assertExactEventSourceContract({
        sourceMode: "consent",
        metricKinds: ["unsubscribed_from_list", "subscribed_to_list"],
      }),
    ).toThrow("invalid source contract");
    expect(() =>
      assertExactEventSourceContract({
        sourceMode: "consent",
        metricKinds: ["subscribed_to_list", "unsubscribed_from_list"],
        extra: 1,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure** (`consentSourceContract` not exported).

- [ ] **Step 3: Implement in `src/lib/klaviyo/types.ts`**, mirroring the journey block at `types.ts:101-156` exactly:

```ts
export const KLAVIYO_CONSENT_KINDS = [
  "subscribed_to_list",
  "unsubscribed_from_list",
] as const;

export type ConsentSourceContract = {
  sourceMode: "consent";
  metricKinds: ["subscribed_to_list", "unsubscribed_from_list"];
};

export function consentSourceContract(): ConsentSourceContract {
  return {
    sourceMode: "consent",
    metricKinds: [
      ...KLAVIYO_CONSENT_KINDS,
    ] as ConsentSourceContract["metricKinds"],
  };
}

export function assertConsentSourceContract(
  value: unknown,
): asserts value is ConsentSourceContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
  const candidate = value as { sourceMode?: unknown; metricKinds?: unknown };
  const metricKinds = candidate.metricKinds;
  if (
    candidate.sourceMode !== "consent" ||
    !Array.isArray(metricKinds) ||
    metricKinds.length !== KLAVIYO_CONSENT_KINDS.length ||
    metricKinds.some((kind, index) => kind !== KLAVIYO_CONSENT_KINDS[index])
  ) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
}
```

Then wire the unions and gates (each site cited from current code):
- `KLAVIYO_ALLOWED_METRIC_KINDS` (`types.ts:18-25`) gains `...KLAVIYO_CONSENT_KINDS` (this also opens the normalizer gate at `event-normalizer.ts:973` — no normalizer edit needed; consent kinds inherit "no products, generic redaction" via the default branch at `event-normalizer.ts:533-537`).
- `KlaviyoEventSourceContract` union (`types.ts` near 115-119) gains `| ConsentSourceContract`.
- `assertExactEventSourceContract` (`types.ts:158-180`): add the `sourceMode === "consent"` dispatch to `assertConsentSourceContract` alongside the journey branch; the exact-keys check is shared and unchanged.
- Note: `assertExactEventCheckpoint` in `source-store.ts:1125-1154` validates via `assertExactEventSourceContract` and `metricIndex < metricKinds.length` — generic, no change needed.

- [ ] **Step 4: Run tests + `npx tsc --noEmit`** — the union change may surface exhaustive-switch errors elsewhere; fix each by adding the consent case per this plan's later tasks ONLY if the compiler forces it now (report any such site in the commit).

- [ ] **Step 5: Commit** `feat(klaviyo): add consent metric kinds and source contract`

---

### Task 2: Discovery name map

**Files:**
- Modify: `src/lib/klaviyo/discovery.ts:36-45` (the `METRIC_NAME_KINDS` map)
- Test: `src/lib/klaviyo/discovery.test.ts`

- [ ] **Step 1: Failing test** (mirror the existing map-classification tests in `discovery.test.ts` — find the test that classifies "Clicked Email" and copy its shape):

```ts
it("classifies list consent metrics regardless of integration", () => {
  expect(
    classifyMetric({
      id: "m-sub",
      name: "Subscribed to List",
      integrationName: "klaviyo",
      integrationCategory: "internal",
    }),
  ).toBe("subscribed_to_list");
  expect(
    classifyMetric({
      id: "m-unsub",
      name: "Unsubscribed from List",
      integrationName: "klaviyo",
      integrationCategory: "internal",
    }),
  ).toBe("unsubscribed_from_list");
});
```

(Adjust the metric-object shape to whatever `classifyMetric`'s parameter type requires — read its signature at `discovery.ts:58-69`. If `classifyMetric` is not exported, test through the exported discovery path the way existing tests classify journey kinds.)

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement** — two map entries after "Checkout Started" (`discovery.ts:36-45`):

```ts
  ["Subscribed to List", "subscribed_to_list"],
  ["Unsubscribed from List", "unsubscribed_from_list"],
```

Consent kinds are NOT order-core, so `classifyMetric`'s shopify-integration requirement (`discovery.ts:58-69`) doesn't apply and the enable policy (`discovery.ts:261-288`) leaves them `ingestion_enabled = 0` — exactly like journey kinds. Re-running discovery upserts them for existing connections (`source-store.ts:1056-1082`). No other discovery change.

- [ ] **Step 4: Run `discovery.test.ts` + full `npm run test -- --run src/lib/klaviyo/discovery.test.ts src/lib/klaviyo/source-store.integration.test.ts`** (the store test proves the enabled-kind unique index tolerates the new disabled rows).

- [ ] **Step 5: Commit** `feat(klaviyo): discover list consent metrics`

---

### Task 3: Timeline-mode generalization + consent sync in `source-runner.ts`

The journey machinery becomes parameterized; journey behavior must not change (its existing tests are the regression net).

**Files:**
- Modify: `src/lib/klaviyo/source-runner.ts`
- Test: `src/lib/klaviyo/source-runner.test.ts`

- [ ] **Step 1: Failing tests** (in `source-runner.test.ts`, mirroring the journey tests there — the file already exercises `startOrResumeJourneySync` and `processEventSourceBatch` with mocked dependencies; copy those fixtures):

```ts
describe("consent sync", () => {
  it("creates a consent run with the consent contract and checkpoint", async () => {
    // Mirror the startOrResumeJourneySync creation test: same deps fixture,
    // call startOrResumeConsentSync, assert ops.insertEventRun received
    // contract consentSourceContract() and checkpoint
    // { ...consentSourceContract(), metricIndex: 0, cursor: null, page: 0 }.
  });

  it("dispatches a consent run to the timeline batch path", async () => {
    // Mirror the journey dispatch test: run.requestParameters =
    // consentSourceContract(); assert processEventSourceBatch returns
    // sourceMode "consent" and used the consent bindings (two slots).
  });

  it("commits an empty page and advances when a consent metric is unbound", async () => {
    // Mirror the journey null-binding test with one of the two consent
    // slots missing.
  });
});
```

Write these as REAL tests by copying the corresponding journey test bodies in the file and swapping contract/kind fixtures — the journey tests define the dependency-mock idiom; keep it byte-consistent.

- [ ] **Step 2: Verify failure** (`startOrResumeConsentSync` not exported).

- [ ] **Step 3: Implement the generalization.** Mechanical parameterization of the existing journey path (line refs from current code):

1. Define a mode config near the journey helpers:

```ts
type TimelineModeConfig = {
  sourceMode: "journey" | "consent";
  kinds: readonly KlaviyoMetricKind[];
  contract: () => KlaviyoEventSourceContract;
  boundaryErrorMessage: string;
};

const JOURNEY_MODE: TimelineModeConfig = {
  sourceMode: "journey",
  kinds: KLAVIYO_JOURNEY_KINDS,
  contract: journeySourceContract,
  boundaryErrorMessage:
    "Klaviyo journey window must stay inside the 90-store-day boundary",
};

const CONSENT_MODE: TimelineModeConfig = {
  sourceMode: "consent",
  kinds: KLAVIYO_CONSENT_KINDS,
  contract: consentSourceContract,
  boundaryErrorMessage:
    "Klaviyo consent window must stay inside the 90-store-day boundary",
};
```

2. Rename the internals (keep exported names as thin wrappers so no caller changes):
   - `loadJourneyMetricBindings` (`:603-629`): extract `loadTimelineMetricBindings(scope, kinds)` — the body already maps over a kinds array; the journey export becomes `loadTimelineMetricBindings(scope, KLAVIYO_JOURNEY_KINDS)`.
   - `initialJourneyCheckpoint` (`:582-584`): `initialTimelineCheckpoint(config)` → `{ ...config.contract(), metricIndex: 0, cursor: null, page: 0 }`.
   - `startOrResumeJourneySync` (`:637-727`): extract `startOrResumeTimelineSync(config, input, dependencies)`; the only mode-specific points are the boundary error message (`:683`), the contract + checkpoint at `insertEventRun` (`:719-725`), and the live-run mode match (`:702`, `requestParameters.sourceMode !== "journey"` → `!== config.sourceMode`). Export:

```ts
export async function startOrResumeConsentSync(
  input: {
    scope: KlaviyoConnectionScope;
    window: HalfOpenWindow;
    triggerType: "manual_backfill" | "scheduled";
  },
  dependencies: SourceRunnerDependencies = {},
): Promise<{ syncRunId: string; resumed: boolean }> {
  return startOrResumeTimelineSync(CONSENT_MODE, input, dependencies);
}
```

   - `processJourneyBatch` (`:740-923`): extract `processTimelineBatch(config, input, dependencies)`; mode-specific points: the contract assert (`:768-771` → `assertExactEventSourceContract` then `sourceMode === config.sourceMode` check), bindings load (`:813-833` → `loadTimelineMetricBindings(scope, config.kinds)`), and `commitPage`'s `sourceContract: config.contract()` (`:896-904`). Everything else (identity keyring, `includeAttributions: false`, `includeProfileEmail: true`, empty alias registry, heartbeats, lease) is shared verbatim — consent events get the same generic fail-closed redaction and profile identity handling as journey events.
   - Dispatch (`:930-953`): add before the order-core fallthrough:

```ts
  if (run.requestParameters.sourceMode === "consent") {
    const result = await processTimelineBatch(CONSENT_MODE, input, dependencies);
    return { ...result, sourceMode: "consent" };
  }
```

   and have the journey branch call `processTimelineBatch(JOURNEY_MODE, ...)`. The `sourceMode` string in the batch result feeds the task's idempotency-key prefix (`trigger/klaviyo-source-sync.ts:148`) — the template there is `` `klaviyo-${result.sourceMode === "journey" ? "journey" : "order-core"}:...` ``; change it to use `result.sourceMode` directly for all three modes: `` `klaviyo-${result.sourceMode}:${payload.syncRunId}:${fingerprint}` `` — BUT this changes the order-core prefix from "order-core" to "order_core", breaking idempotency continuity for in-flight runs. Instead use:

```ts
const KEY_PREFIX: Record<string, string> = {
  journey: "journey",
  consent: "consent",
  order_core: "order-core",
};
// `klaviyo-${KEY_PREFIX[result.sourceMode]}:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`
```

- [ ] **Step 4: Run** `npm run test -- --run src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/klaviyo/incremental-sync.test.ts` — ALL existing journey tests must pass unchanged (they are the refactor's proof). `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(klaviyo): consent source mode through the shared timeline engine`

---

### Task 4: Supervisor consent stage

**Files:**
- Modify: `src/lib/klaviyo/incremental-sync.ts` (stage union `:13-20`, children interface `:150`, `emptyReport` `:155-165`, sequential run block `:262-282`)
- Modify: `trigger/klaviyo-incremental.ts` (children builder — mirror `runJourney` at `:365-392`)
- Test: `src/lib/klaviyo/incremental-sync.test.ts`

- [ ] **Step 1: Failing test** in `incremental-sync.test.ts` (mirror the journey-stage tests there):

```ts
it("records the consent stage after journey and isolates its failure", async () => {
  // children fixture: runConsent resolves { ok: true } → report.consent
  // { state: "completed" }; then a run where runConsent rejects →
  // { state: "failed", detail: "consent_failed" }, with every later stage
  // (dimensions, reports) still recorded — copy the journey-failure test
  // body and swap the stage.
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement.**

`incremental-sync.ts`:
- `IncrementalStageName` union gains `"consent"`; `emptyReport()` gains `consent: { state: "pending" }` (match the existing per-stage initial shape exactly);
- children interface gains `runConsent(scope): Promise<{ ok: boolean }>`;
- in the enrichment sequence (`:262-282`), after the journey block:

```ts
  const consent = await children.runConsent(input.scope).catch(() => ({ ok: false }));
  report.consent = consent.ok
    ? { state: "completed" }
    : { state: "failed", detail: "consent_failed" };
```

`trigger/klaviyo-incremental.ts` — `runConsent` mirrors `runJourney` (`:365-392`) verbatim with three substitutions: `flushStage("consent")`, `startOrResumeConsentSync` (import from source-runner), and idempotency key `` `klaviyo:consent:first:${prepared.syncRunId}` ``. Same child task `"klaviyo-order-core-batch"` (the run row's contract picks the mode), same `{ scope: "global" }` + `"7d"` TTL, same 7-day window derivation.

- [ ] **Step 4: Run** `incremental-sync.test.ts` + `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(klaviyo): consent stage in the incremental supervisor`

---

### Task 5: `list-health` module — pure computation + fetch

**Files:**
- Create: `src/lib/klaviyo/list-health.ts`
- Create: `src/lib/klaviyo/list-health.test.ts`
- Create: `src/lib/klaviyo/list-health.integration.test.ts`

- [ ] **Step 1: Write the pure-function unit tests** (`list-health.test.ts`, no DB):

```ts
import { describe, expect, it } from "vitest";
import { computeListHealth } from "@/lib/klaviyo/list-health";

const TZ = "Asia/Bangkok";
const window = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-15T00:00:00.000Z"),
};
const ev = (
  profileId: string,
  kind: "subscribed_to_list" | "unsubscribed_from_list",
  iso: string,
) => ({ profileId, metricKind: kind, occurredAt: new Date(iso) });

describe("computeListHealth", () => {
  it("counts subscribes and unsubscribes inside the window only", () => {
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-08-02T10:00:00Z"),
        ev("p2", "unsubscribed_from_list", "2026-08-03T10:00:00Z"),
        ev("p3", "subscribed_to_list", "2026-07-20T10:00:00Z"), // before window
        ev("p4", "subscribed_to_list", "2026-08-15T00:00:00Z"), // at exclusive end
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals).toEqual({
      subscribed: 1,
      unsubscribed: 1,
      wonBack: 0,
      quickChurn: 0,
      net: 0,
    });
  });

  it("counts won-back when the previous consent event is an unsubscribe, including history before the window", () => {
    const result = computeListHealth(
      [
        ev("p1", "unsubscribed_from_list", "2026-07-10T10:00:00Z"),
        ev("p1", "subscribed_to_list", "2026-08-05T10:00:00Z"),
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.wonBack).toBe(1);
    expect(result.totals.subscribed).toBe(1);
  });

  it("never counts a first-ever event as won-back or quick churn", () => {
    const result = computeListHealth(
      [ev("p1", "unsubscribed_from_list", "2026-08-05T10:00:00Z")],
      { window, timeZone: TZ },
    );
    expect(result.totals).toMatchObject({ unsubscribed: 1, wonBack: 0, quickChurn: 0 });
  });

  it("counts quick churn only within 14x24h of the previous subscribe", () => {
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-07-25T10:00:00Z"),
        ev("p1", "unsubscribed_from_list", "2026-08-08T09:59:00Z"), // 13d23h59m later
        ev("p2", "subscribed_to_list", "2026-07-25T10:00:00Z"),
        ev("p2", "unsubscribed_from_list", "2026-08-08T10:01:00Z"), // 14d + 1m later
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.quickChurn).toBe(1);
    expect(result.totals.unsubscribed).toBe(2);
  });

  it("buckets days in the store timezone", () => {
    // 2026-08-04T18:00:00Z is 2026-08-05 01:00 in Asia/Bangkok (+7).
    const result = computeListHealth(
      [ev("p1", "subscribed_to_list", "2026-08-04T18:00:00Z")],
      { window, timeZone: TZ },
    );
    expect(result.daily).toEqual([
      { day: "2026-08-05", subscribed: 1, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 1 },
    ]);
  });

  it("derives net and orders daily rows descending by day", () => {
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-08-02T10:00:00Z"),
        ev("p2", "subscribed_to_list", "2026-08-02T11:00:00Z"),
        ev("p3", "unsubscribed_from_list", "2026-08-04T10:00:00Z"),
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.net).toBe(1);
    expect(result.daily.map((row) => row.day)).toEqual(["2026-08-04", "2026-08-02"]);
  });

  it("counts one event per list membership — two same-kind events for one profile count twice", () => {
    // v1 stores no list identity: a person subscribing on two lists emits
    // two events and counts as 2, matching Klaviyo's own list numbers.
    const result = computeListHealth(
      [
        ev("p1", "subscribed_to_list", "2026-08-02T10:00:00Z"),
        ev("p1", "subscribed_to_list", "2026-08-02T10:05:00Z"),
      ],
      { window, timeZone: TZ },
    );
    expect(result.totals.subscribed).toBe(2);
    expect(result.totals.wonBack).toBe(0);
  });

  it("ignores event insertion order — occurred_at decides prior state", () => {
    const shuffled = [
      ev("p1", "subscribed_to_list", "2026-08-05T10:00:00Z"),
      ev("p1", "unsubscribed_from_list", "2026-07-10T10:00:00Z"),
    ];
    expect(computeListHealth(shuffled, { window, timeZone: TZ }).totals.wonBack).toBe(1);
  });
});
```

- [ ] **Step 2: Verify failure** (module missing).

- [ ] **Step 3: Implement `src/lib/klaviyo/list-health.ts`:**

```ts
import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deriveDayInTimezone } from "@/lib/klaviyo/types";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import type { HalfOpenUtcWindow } from "@/lib/klaviyo/queries";
import { klaviyoEvents, klaviyoMetrics } from "@/schema/klaviyo";

/**
 * List-membership consent aggregates. Counts are event counts (a person on
 * two lists counts once per list — v1 semantics matching Klaviyo's own list
 * numbers); flips are per-profile transitions ordered by occurred_at, so
 * out-of-order ingestion self-corrects on the next read. Aggregate-only:
 * nothing per-profile leaves this module.
 */

export const QUICK_CHURN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ConsentEventInput = {
  profileId: string | null;
  metricKind: "subscribed_to_list" | "unsubscribed_from_list";
  occurredAt: Date;
};

export type ListHealthDailyRow = {
  day: string;
  subscribed: number;
  unsubscribed: number;
  wonBack: number;
  quickChurn: number;
  net: number;
};

export type ListHealthSummary = {
  /** False when the consent metrics have not been discovered yet. */
  discovered: boolean;
  totals: {
    subscribed: number;
    unsubscribed: number;
    wonBack: number;
    quickChurn: number;
    net: number;
  };
  daily: ListHealthDailyRow[];
};

export function computeListHealth(
  events: ConsentEventInput[],
  options: { window: HalfOpenUtcWindow; timeZone: string },
): Omit<ListHealthSummary, "discovered"> {
  const { window, timeZone } = options;
  const byProfile = new Map<string, ConsentEventInput[]>();
  for (const event of events) {
    // Profile-less events (Klaviyo anomaly) still count toward totals but
    // can never form a transition.
    const key = event.profileId ?? `anon:${event.occurredAt.toISOString()}`;
    const list = byProfile.get(key);
    if (list) list.push(event);
    else byProfile.set(key, [event]);
  }

  const daily = new Map<string, ListHealthDailyRow>();
  const totals = { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 };
  const bump = (day: string, field: "subscribed" | "unsubscribed" | "wonBack" | "quickChurn") => {
    const row =
      daily.get(day) ??
      { day, subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 };
    row[field] += 1;
    daily.set(day, row);
    totals[field] += 1;
  };

  for (const sequence of byProfile.values()) {
    sequence.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (let index = 0; index < sequence.length; index += 1) {
      const event = sequence[index];
      const inWindow =
        event.occurredAt >= window.from && event.occurredAt < window.to;
      if (!inWindow) continue;
      const day = deriveDayInTimezone(event.occurredAt, timeZone);
      const previous = index > 0 ? sequence[index - 1] : null;
      if (event.metricKind === "subscribed_to_list") {
        bump(day, "subscribed");
        if (previous?.metricKind === "unsubscribed_from_list") {
          bump(day, "wonBack");
        }
      } else {
        bump(day, "unsubscribed");
        if (
          previous?.metricKind === "subscribed_to_list" &&
          event.occurredAt.getTime() - previous.occurredAt.getTime() <=
            QUICK_CHURN_WINDOW_MS
        ) {
          bump(day, "quickChurn");
        }
      }
    }
  }

  const rows = [...daily.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const row of rows) row.net = row.subscribed - row.unsubscribed;
  totals.net = totals.subscribed - totals.unsubscribed;
  return { totals, daily: rows };
}

export async function loadListHealth(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  timeZone: string;
}): Promise<ListHealthSummary> {
  const metrics = await db
    .select({ id: klaviyoMetrics.id, canonicalKind: klaviyoMetrics.canonicalKind })
    .from(klaviyoMetrics)
    .where(
      and(
        eq(klaviyoMetrics.organizationId, input.scope.organizationId),
        eq(klaviyoMetrics.storeId, input.scope.storeId),
        eq(klaviyoMetrics.connectionId, input.scope.connectionId),
        inArray(klaviyoMetrics.canonicalKind, [
          "subscribed_to_list",
          "unsubscribed_from_list",
        ]),
      ),
    );
  if (metrics.length === 0) {
    return {
      discovered: false,
      totals: { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 },
      daily: [],
    };
  }
  const kindByMetricId = new Map(
    metrics.map((metric) => [metric.id, metric.canonicalKind]),
  );
  // Full retained history (90d ingestion bound), NOT window-filtered: the
  // won-back/quick-churn "previous event" may predate the window.
  const rows = await db
    .select({
      profileId: klaviyoEvents.profileId,
      metricId: klaviyoEvents.metricId,
      occurredAt: klaviyoEvents.occurredAt,
    })
    .from(klaviyoEvents)
    .where(
      and(
        eq(klaviyoEvents.organizationId, input.scope.organizationId),
        eq(klaviyoEvents.storeId, input.scope.storeId),
        eq(klaviyoEvents.connectionId, input.scope.connectionId),
        inArray(
          klaviyoEvents.metricId,
          metrics.map((metric) => metric.id),
        ),
      ),
    );
  const events: ConsentEventInput[] = rows.map((row) => ({
    profileId: row.profileId,
    metricKind: kindByMetricId.get(row.metricId) as ConsentEventInput["metricKind"],
    occurredAt: row.occurredAt,
  }));
  return {
    discovered: true,
    ...computeListHealth(events, {
      window: input.window,
      timeZone: input.timeZone,
    }),
  };
}
```

(Check `deriveDayInTimezone`'s actual export location — it is re-exported from `src/lib/klaviyo/types.ts:1-11` per recon; verify the signature `(instant: Date, timeZone: string) => string` and adjust the import if it lives only in `src/lib/evidence-window.ts`. Check the drizzle column name for `klaviyoEvents.storeId` — the physical column is `shopify_store_id`; use whatever the schema object property is named, grep `shopify_store_id` in `src/schema/klaviyo.ts`.)

- [ ] **Step 4: Run unit tests to green.**

- [ ] **Step 5: Integration test** (`list-health.integration.test.ts`) — copy the harness pattern from `src/lib/klaviyo/email-attribution.integration.test.ts` (disposable DB name `adsolute_klaviyo_list_health_test`, `applyMatchFixture`, pool error listeners, `beforeEach` truncate + `seedMatchWorld`). Seed consent metrics + events with plain inserts (model on the harness's `klaviyo_metric` insert at `match-test-harness.ts:153-159` and the event-insert helper in `email-attribution.integration.test.ts`, adding a `profile_id` column value — check `klaviyo_event`'s insert columns there and add `profile_id`):

```ts
// seed helper shape (adapt columns to the existing seedEvent helper):
async function seedConsentMetric(id: string, kind: string, name: string) { /* insert klaviyo_metric with canonical_kind = kind, ingestion_enabled = 0 */ }
async function seedConsentEvent(id: string, metricId: string, profileId: string, occurredAt: string) { /* insert klaviyo_event with metric_id, profile_id, occurred_at */ }
```

Tests:
1. end-to-end totals + flips: profiles covering plain subscribe, unsub→resub (won back), sub→unsub at 13d (quick churn) and 15d (not), first-event-unsub — assert the exact totals object;
2. `discovered: false` with empty totals when no consent metric rows exist;
3. UTC window edges: events at exactly `window.from` (counted) and `window.to` (excluded) — seeds via ISO text timestamps (TZ-safe, per the harness convention);
4. prior-state from before the window: unsub in July, window starts in August, resub in window → wonBack 1.

- [ ] **Step 6: Run integration file to green** (`npm run test -- --run src/lib/klaviyo/list-health.integration.test.ts`).

- [ ] **Step 7: Commit** `feat(klaviyo): list health aggregates and flip computation`

---

### Task 6: `klaviyo.listHealth` router query

**Files:**
- Modify: `src/lib/trpc/routers/klaviyo.ts` (template: `emailAttribution` at `:274-283`)
- Modify: `src/lib/trpc/routers/klaviyo.test.ts`

- [ ] **Step 1: Test wiring first** — in `klaviyo.test.ts`: add `loadListHealth: vi.fn()` to the hoisted mocks; module mock `vi.mock("@/lib/klaviyo/list-health", () => ({ loadListHealth: mocks.loadListHealth }))` beside the email-attribution mock (`:68-70`); prime in the shared `beforeEach` with `{ discovered: true, totals: { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 }, daily: [] }`; `PROCEDURE_CALLS` entry:

```ts
  [
    "listHealth",
    (caller) => caller.listHealth({ dateFrom: "2026-08-01", dateTo: "2026-08-04" }),
  ],
```

Plus one behavior test asserting the loader receives the window from `inclusiveStoreDaysToHalfOpenUtc` and `timeZone: "America/New_York"` (the mocked connection's `storeTimezone` — check the hoisted connection fixture at `klaviyo.test.ts:3-16` for its actual value and assert that).

- [ ] **Step 2: Verify failure** ("No procedure found on path listHealth").

- [ ] **Step 3: Implement** after `emailAttribution`:

```ts
  listHealth: orgAdminProcedure
    .input(z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema }))
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        ...input,
        timeZone: connection.storeTimezone,
      });
      return loadListHealth({
        scope: connection,
        window,
        timeZone: connection.storeTimezone,
      });
    }),
```

with the import added beside `loadEmailAttribution`.

- [ ] **Step 4: Run `klaviyo.test.ts` to green** (RBAC loops now cover the new procedure automatically).

- [ ] **Step 5: Commit** `feat(klaviyo): expose list health query`

---

### Task 7: UI — panel strip + Lab tab

**Files:**
- Modify: `src/components/blocks/attribution/klaviyo/copy.ts`
- Create: `src/components/blocks/attribution/klaviyo/email-revenue-list-health.tsx`
- Create: `src/components/blocks/attribution/klaviyo/list-health-table.tsx`
- Create: `src/components/blocks/attribution/klaviyo/list-health.component.test.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/email-revenue-panel.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx`

- [ ] **Step 1: Copy.** In `copy.ts`: `LAB_VIEWS` (`:1`) gains `"list-health"`; add:

```ts
export const listHealth = {
  stripLead: "List health:",
  subscribed: (n: number) => `+${n} subscribed`,
  unsubscribed: (n: number) => `−${n} unsubscribed`,
  wonBack: (n: number) => `${n} won back`,
  quickChurn: (n: number) => `${n} quick churn`,
  net: (n: number) => `net ${n >= 0 ? `+${n}` : `${n}`}`,
  kpiSubscribed: "Subscribed",
  kpiUnsubscribed: "Unsubscribed",
  kpiWonBack: "Won back",
  kpiQuickChurn: "Quick churn (≤14d)",
  kpiNet: "Net",
  barsCaption: "Daily net (green in / red out), page range",
  aggregateNote:
    "Aggregate counts only — no per-person rows; list-membership semantics (a person on two lists counts once per list)",
  undiscovered:
    "Run discovery to enable list tracking — the consent metrics haven't been synced for this connection yet.",
  error: "Couldn't load list health.",
} as const;
```

- [ ] **Step 2: Failing component tests** (`list-health.component.test.tsx`, jsdom — import types with `import type` only):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailRevenueListHealth } from "./email-revenue-list-health";
import { ListHealthTable } from "./list-health-table";
import type { ListHealthSummary } from "@/lib/klaviyo/list-health";

function summary(overrides: Partial<ListHealthSummary> = {}): ListHealthSummary {
  return {
    discovered: true,
    totals: { subscribed: 142, unsubscribed: 38, wonBack: 12, quickChurn: 5, net: 104 },
    daily: [
      { day: "2026-08-22", subscribed: 19, unsubscribed: 4, wonBack: 2, quickChurn: 1, net: 15 },
      { day: "2026-08-21", subscribed: 11, unsubscribed: 7, wonBack: 0, quickChurn: 0, net: 4 },
    ],
    ...overrides,
  };
}

describe("EmailRevenueListHealth", () => {
  it("renders the strip with all five figures and the Lab deep link", () => {
    render(
      <EmailRevenueListHealth summary={summary()} dateFrom="2026-08-01" dateTo="2026-08-24" />,
    );
    const strip = screen.getByTestId("list-health-strip");
    expect(strip).toHaveTextContent("+142 subscribed");
    expect(strip).toHaveTextContent("−38 unsubscribed");
    expect(strip).toHaveTextContent("12 won back");
    expect(strip).toHaveTextContent("5 quick churn");
    expect(strip).toHaveTextContent("net +104");
    const href = screen.getByTestId("list-health-strip-href").getAttribute("href");
    expect(href).toContain("/attribution/klaviyo?");
    expect(href).toContain("view=list-health");
    expect(href).toContain("from=2026-08-01");
  });

  it("renders nothing when totals are all zero or undiscovered", () => {
    const zero = { subscribed: 0, unsubscribed: 0, wonBack: 0, quickChurn: 0, net: 0 };
    const { container } = render(
      <EmailRevenueListHealth
        summary={summary({ totals: zero })}
        dateFrom="2026-08-01"
        dateTo="2026-08-24"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ListHealthTable", () => {
  it("renders KPIs, daily rows, and the aggregate note", () => {
    render(<ListHealthTable summary={summary()} error={false} onRetry={() => {}} />);
    expect(screen.getByTestId("list-health-kpi-subscribed")).toHaveTextContent("142");
    expect(screen.getByTestId("list-health-kpi-net")).toHaveTextContent("+104");
    expect(screen.getByText("2026-08-22")).toBeInTheDocument();
    expect(screen.getByText(/Aggregate counts only/)).toBeInTheDocument();
  });

  it("shows the discovery hint when metrics are undiscovered", () => {
    render(
      <ListHealthTable summary={summary({ discovered: false })} error={false} onRetry={() => {}} />,
    );
    expect(screen.getByText(/Run discovery to enable list tracking/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Verify failure**, then implement the two presentational components.

`email-revenue-list-health.tsx` (mirror the gap strip's idiom — `email-revenue-gaps.tsx:8-19` labUrl and `:79-100` markup):

```tsx
"use client";

import Link from "next/link";
import type { ListHealthSummary } from "@/lib/klaviyo/list-health";
import { listHealth as copy } from "./copy";

function labUrl(range: { dateFrom: string; dateTo: string }): string {
  const search = new URLSearchParams({
    range: "custom",
    from: range.dateFrom,
    to: range.dateTo,
    view: "list-health",
  });
  return `/attribution/klaviyo?${search.toString()}`;
}

/** Hidden entirely when undiscovered or fully quiet — never an empty strip. */
export function EmailRevenueListHealth({
  summary,
  dateFrom,
  dateTo,
}: {
  summary: ListHealthSummary;
  dateFrom: string;
  dateTo: string;
}) {
  const { totals } = summary;
  const hasAny =
    totals.subscribed !== 0 ||
    totals.unsubscribed !== 0 ||
    totals.wonBack !== 0 ||
    totals.quickChurn !== 0;
  if (!summary.discovered || !hasAny) return null;
  const label = `${copy.subscribed(totals.subscribed)} · ${copy.unsubscribed(totals.unsubscribed)} · ${copy.wonBack(totals.wonBack)} · ${copy.quickChurn(totals.quickChurn)} · ${copy.net(totals.net)}`;
  return (
    <div
      className="mt-3 rounded-md border border-dashed border-emerald-600/40 bg-emerald-600/5 px-3 py-2 text-[11px]"
      data-testid="list-health-strip"
    >
      <span className="font-medium">{copy.stripLead}</span> {label}{" "}
      <Link
        aria-label={`${copy.stripLead} ${label}`}
        className="text-muted-foreground underline-offset-2 hover:underline"
        data-testid="list-health-strip-href"
        href={labUrl({ dateFrom, dateTo })}
      >
        ▸
      </Link>
    </div>
  );
}
```

`list-health-table.tsx` (Lab view: KPI row, CSS bars, daily table — typography per `coverage-summary.tsx`/`reports-table.tsx` idioms):

```tsx
"use client";

import type { ListHealthSummary } from "@/lib/klaviyo/list-health";
import { Button } from "@/components/ui/button";
import { listHealth as copy } from "./copy";

const KPIS = [
  { key: "subscribed", label: copy.kpiSubscribed, tone: "text-emerald-600" },
  { key: "unsubscribed", label: copy.kpiUnsubscribed, tone: "text-red-600" },
  { key: "wonBack", label: copy.kpiWonBack, tone: "text-amber-600" },
  { key: "quickChurn", label: copy.kpiQuickChurn, tone: "" },
  { key: "net", label: copy.kpiNet, tone: "text-emerald-600" },
] as const;

export function ListHealthTable({
  summary,
  error,
  onRetry,
}: {
  summary: ListHealthSummary | null;
  error: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        {copy.error}{" "}
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </p>
    );
  }
  if (summary === null) return null;
  if (!summary.discovered) {
    return <p className="text-sm text-muted-foreground">{copy.undiscovered}</p>;
  }
  const maxAbsNet = Math.max(1, ...summary.daily.map((row) => Math.abs(row.net)));
  const format = (key: (typeof KPIS)[number]["key"]) => {
    const value = summary.totals[key];
    return key === "net" && value >= 0 ? `+${value}` : `${value}`;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-7 gap-y-2">
        {KPIS.map((kpi) => (
          <div key={kpi.key}>
            <p
              className={`text-[20px] font-semibold tabular-nums ${kpi.tone}`}
              data-testid={`list-health-kpi-${kpi.key}`}
            >
              {format(kpi.key)}
            </p>
            <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {kpi.label}
            </p>
          </div>
        ))}
      </div>
      <div>
        <div className="flex h-12 items-end gap-[2px]">
          {[...summary.daily].reverse().map((row) => (
            <div
              key={row.day}
              title={`${row.day}: ${row.net >= 0 ? "+" : ""}${row.net}`}
              className={row.net >= 0 ? "w-2.5 bg-emerald-600/70" : "w-2.5 bg-red-600/70"}
              style={{ height: `${Math.max(8, (Math.abs(row.net) / maxAbsNet) * 100)}%` }}
            />
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground/70">{copy.barsCaption}</p>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {["Day", copy.kpiSubscribed, copy.kpiUnsubscribed, copy.kpiWonBack, copy.kpiQuickChurn, copy.kpiNet].map(
              (heading, index) => (
                <th
                  key={heading}
                  className={`px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground ${index === 0 ? "text-left" : "text-right"}`}
                >
                  {heading}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {summary.daily.map((row) => (
            <tr key={row.day}>
              <td className="border-b border-border/40 px-2 py-1">{row.day}</td>
              {[row.subscribed, row.unsubscribed, row.wonBack, row.quickChurn].map(
                (value, index) => (
                  <td key={index} className="border-b border-border/40 px-2 py-1 text-right tabular-nums">
                    {value}
                  </td>
                ),
              )}
              <td className="border-b border-border/40 px-2 py-1 text-right tabular-nums">
                {row.net >= 0 ? `+${row.net}` : row.net}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground/70">{copy.aggregateNote}</p>
    </div>
  );
}
```

- [ ] **Step 4: Wire both surfaces.**

`email-revenue-panel.tsx` container: add beside the existing queries (`:197-210`):

```tsx
const listHealth = useQuery({
  ...trpc.klaviyo.listHealth.queryOptions({ dateFrom, dateTo }),
  enabled: privileged,
  retry: false,
});
```

and in the happy-path block after `<EmailRevenueGaps …/>` (silently absent while loading or on error — the strip is supplementary):

```tsx
{listHealth.data ? (
  <EmailRevenueListHealth
    summary={listHealth.data}
    dateFrom={dateFrom}
    dateTo={dateTo}
  />
) : null}
```

`klaviyo-playground.tsx`: `VIEW_LABELS` (`:35-40`) gains `"list-health": "List health"` (the `Record<LabView, string>` type forces this once `LAB_VIEWS` grows). Add the view block beside the reports block (`:471-485`):

```tsx
{view === "list-health" ? (
  <ListHealthView range={range} />
) : null}
```

and the sibling component modeled on `ReportsView` (`:649-677`):

```tsx
function ListHealthView(props: { range: { dateFrom: string; dateTo: string } }) {
  const trpc = useTRPC();
  const listHealth = useQuery(
    trpc.klaviyo.listHealth.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
    }),
  );
  return (
    <ListHealthTable
      summary={listHealth.data ?? null}
      error={listHealth.isError}
      onRetry={() => void listHealth.refetch()}
    />
  );
}
```

Check `use-klaviyo-lab-state.ts:46` (`timezoneKind = view === "reports" ? "account" : "store"`) — `list-health` correctly falls to `store`; no change. Check `setView`'s order/candidate clearing (`:98-103`) — no change needed.

- [ ] **Step 5: Run** `npm run test:components` (all green incl. new file), `npx tsc --noEmit`, `npx eslint` on the six touched/created UI files.

- [ ] **Step 6: Commit** `feat(klaviyo): list health strip and Lab tab`

---

### Task 8: Full verification

- [ ] `npm run test` — all files green (confirm `list-health.integration.test.ts` RAN with a count, not skipped)
- [ ] `npm run test:components` — green
- [ ] `npx tsc --noEmit` — clean (ignore stale `.next/types` noise if present; `rm -rf .next/types .next/dev/types` clears it)
- [ ] `npx eslint` on all touched files — clean
- [ ] `git status` — clean except the user's `.gitignore`
- [ ] Do NOT push or open a PR; report status.

---

## Self-review checklist (applied)

- **Spec coverage:** kinds/contract (T1), discovery (T2), engine + fail-closed normalization inheritance (T3), supervisor stage + failure isolation (T4), aggregates/flips/edge cases incl. window edges, first-event-unsub, 14×24h boundary, TZ bucketing, out-of-order self-correction (T5), router + RBAC (T6), strip + Lab tab + undiscovered state + aggregate-only (T7). Spec's "list reference stored" and "SQL LAG()" are superseded by recorded deviations 2 and 3 at the top.
- **Type consistency:** `ListHealthSummary`/`computeListHealth`/`loadListHealth` defined once (T5), consumed by router (T6) and both components (T7); `KLAVIYO_CONSENT_KINDS`/`consentSourceContract` defined in T1, used in T3/T4.
- **Known judgment calls:** idempotency-key prefix map preserves the historical `order-core` spelling; profile-less events count toward totals but never flips; strip hides on all-zero (quiet range indistinguishable from undiscovered by design — the Lab tab differentiates).
