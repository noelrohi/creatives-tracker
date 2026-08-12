# Klaviyo Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner/admin-only `/attribution/klaviyo` playground for connection health, probe review, order-first coverage, advisory evidence inspection, unmatched events, aggregate reports, and explicit sync controls without changing `/attribution` calculations.

**Architecture:** Plans 2–4 own the `trpc.klaviyo` router and every persisted/read model; this plan adds only a client presentation layer over that safe, organization-scoped API. URL state owns date/filter/view/detail selection, server cursor queries own pagination, and the inspector renders named safe projection fields rather than arbitrary JSON. Order/probe/evidence dates are inclusive Shopify-store-local `YYYY-MM-DD` values; report dates are inclusive Klaviyo-account-local days because reports use send-date semantics. `src/lib/trpc/routers/klaviyo.ts` performs the applicable conversion once to the backend half-open UTC `[from,to)` window before any query or task call.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, tRPC 11, TanStack Query, Nuqs, Tailwind CSS 4, shadcn/ui/Radix, Solar Iconify wrappers, Vitest 4, React Testing Library, jsdom, Bun.

---

## Dependencies and fixed contracts

Start only after Plans 1–4 are committed and their gates pass. Plan 5 creates no schema, migration, provider client, matcher, repository, or Trigger.dev task. It consumes these existing `trpc.klaviyo` procedures:

```ts
// Reads
health;
syncRuns;
probe;
coverage;
orders;
orderExplanation;
orderProducts;
orderJourney;
orderClaims;
orderInspector;
unmatchedEvents;
reports;
matchInvocationStatus;

// Explicit owner/admin actions
startDiscovery;
runProbe;
approveProbe;
rejectProbe;
approveJoinRule;
rejectJoinRule;
startOrderCoreSync;
recomputeMatches;
refreshReports;
```

Stable browser action inputs are:

```ts
startDiscovery();
runProbe({ sampleSize: 30 });
approveProbe({ reportId, reviewNote });
rejectProbe({ reportId, reviewNote });
approveJoinRule({ ruleId, reviewNote });
rejectJoinRule({ ruleId, reviewNote });
startOrderCoreSync({ dateFrom, dateTo });
recomputeMatches({ dateFrom, dateTo });
refreshReports({ dateFrom, dateTo, kinds: [reportKind] });
```

Stable order read inputs include the API-only status and optional diagnostic edge:

```ts
orders({
  dateFrom,
  dateTo,
  orderStatus?: OrderEvidenceStatus,
  productStatus?,
  claimType?,
  channel?,
  bucket?,
  cursor?,
  limit?,
});

orderProducts({ orderId, candidateId? });

unmatchedEvents({
  dateFrom,
  dateTo,
  eventStatus?: EventEvidenceStatus,
  channel?,
  cursor?,
  limit?,
});
```

`OrderEvidenceStatus` and `EventEvidenceStatus` are Plan 3 read-model unions. On either side, `not_evaluated` means a scoped source entity has no current published result and is produced by a left join; it is never a stored match status. Event-side `not_evaluated` carries the safe `incident_edge_boundary` warning and means only that a counterpart may sit outside the evaluated window—not that no Shopify order exists globally. A product `candidateId` returns diagnostic per-edge comparison only and never a published product conclusion.

`reportKind` comes only from a compile-time allowlist. Join-rule canonicalization is the stored, probe-generated allowlisted value: the UI may display it read-only but never submits or changes it during approval. Procedures may enrich worker payloads with connection/scope internally; the browser never does.

Every procedure already uses `orgAdminProcedure`. Browser inputs never contain authoritative `organizationId`, `storeId`, or `connectionId`. Resource IDs remain server-scoped to the active organization and return `NOT_FOUND` across tenants.

The order/probe/evidence browser contract uses inclusive Shopify store days:

```ts
export type KlaviyoEvidenceDayRange = {
  dateFrom: string; // YYYY-MM-DD in selected Shopify store timezone
  dateTo: string;   // inclusive YYYY-MM-DD in same timezone
};

export type KlaviyoReportDayRange = {
  dateFrom: string; // YYYY-MM-DD in bound Klaviyo account timezone
  dateTo: string;   // inclusive send-date day in same timezone
};
```

The router resolves the selected store timezone and performs one conversion to `HalfOpenWindow`. Spring-forward single-day input must produce a 23-hour window; fall-back input must produce a 25-hour window. UI code must never call `new Date(day)` to derive that backend window.

`reports` and `refreshReports` deliberately interpret the same calendar-day shape in the bound Klaviyo account timezone, matching report send-date semantics from design §10.6. The reports view must label that timezone beside its range; it must never imply Shopify order-occurrence semantics or reuse the store-timezone label.

## File structure

Create:

- `vitest.components.config.ts` — isolated jsdom component-test configuration.
- `src/test-component-setup.ts` — jest-dom matchers and cleanup.
- `src/app/(protected)/attribution/klaviyo/page.tsx` — thin route entry.
- `src/app/(protected)/attribution/klaviyo/loading.tsx` — route skeleton.
- `src/app/(protected)/attribution/klaviyo/error.tsx` — route reset state.
- `src/components/blocks/attribution/klaviyo/copy.ts` — stable filter values, labels, and status vocabulary.
- `src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.ts` — Nuqs URL contract and store-day range resolution.
- `src/components/blocks/attribution/klaviyo/lab-link.tsx` — privileged link used by existing Attribution header.
- `src/components/blocks/attribution/klaviyo/klaviyo-access-gate.tsx` — no-flash owner/admin route guard layered over the existing protected layout.
- `src/components/blocks/attribution/klaviyo/panel-state.tsx` — loading, empty, filtered-empty, and error states.
- `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx` — query/mutation orchestration only.
- `src/components/blocks/attribution/klaviyo/lab-header.tsx` — connection/freshness/actions.
- `src/components/blocks/attribution/klaviyo/probe-panel.tsx` — probe gate and join-rule review.
- `src/components/blocks/attribution/klaviyo/coverage-summary.tsx` — explicit order/event/product/claim counts.
- `src/components/blocks/attribution/klaviyo/filter-bar.tsx` — date and evidence filters.
- `src/components/blocks/attribution/klaviyo/orders-table.tsx` — server-cursor Shopify-first ledger.
- `src/components/blocks/attribution/klaviyo/order-detail-sheet.tsx` — five-tab, URL-addressable detail shell.
- `src/components/blocks/attribution/klaviyo/order-explanation.tsx` — matcher/candidate explanation.
- `src/components/blocks/attribution/klaviyo/product-comparison.tsx` — quantity-aware source comparison.
- `src/components/blocks/attribution/klaviyo/journey-timeline.tsx` — approved exact-profile events.
- `src/components/blocks/attribution/klaviyo/claims-chain.tsx` — advisory interaction/message/campaign-or-flow chain.
- `src/components/blocks/attribution/klaviyo/source-inspector.tsx` — normalized, redacted, bounded evidence only.
- `src/components/blocks/attribution/klaviyo/unmatched-events-table.tsx` — event-side cursor ledger.
- `src/components/blocks/attribution/klaviyo/reports-table.tsx` — separate campaign/flow aggregate claims.
- `src/components/blocks/attribution/klaviyo/sync-runs-panel.tsx` — recent run counts/errors/checkpoints.
- `src/components/blocks/attribution/klaviyo/*.component.test.tsx` — behavior tests beside components.

Modify:

- `package.json` and `bun.lock` — minimal component-test dependencies and script.
- `src/app/(protected)/attribution/page.tsx` — add one privileged `Klaviyo Lab` link; leave ledger/query behavior unchanged.
- `src/lib/trpc/routers/klaviyo.test.ts` — assert store-timezone conversion and browser RBAC contract only; do not add a second router.

Do not modify `src/components/app-sidebar.tsx`, `src/lib/organization-access.ts`, production attribution queries, attribution bucket rules, Shopify money fields, or Trigger tasks.

### Task 1: Lock dependencies and add the minimal component-test harness

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `vitest.components.config.ts`
- Create: `src/test-component-setup.ts`
- Create: `src/components/blocks/attribution/klaviyo/panel-state.component.test.tsx`
- Create: `src/components/blocks/attribution/klaviyo/panel-state.tsx`

- [ ] **Step 1: Verify backend dependency surface before frontend work.**

Run:

```sh
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS, with all read/control procedures and exact no-scope browser inputs named above present. The router tests must compile/call those shapes, not only check procedure keys. If this gate fails, stop and complete the owning Plan 2–4 task; do not shim missing procedures or legacy inputs in UI code.

- [ ] **Step 2: Install only component-test dependencies.**

Run:

```sh
bun add -d @testing-library/dom @testing-library/jest-dom @testing-library/react @testing-library/user-event jsdom
```

Expected: exit 0; `package.json` and `bun.lock` change. Do not add Playwright: repository has no browser-auth/fixture harness, while safe tRPC integration plus jsdom component behavior covers this plan's automated boundary.

- [ ] **Step 3: Add isolated component-test configuration and script.**

Create `vitest.components.config.ts`:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.component.test.tsx"],
    setupFiles: ["src/test-component-setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./src/test-stubs/server-only.ts"),
    },
  },
});
```

Create `src/test-component-setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
```

Add this exact script to `package.json`:

```json
"test:components": "vitest run --config vitest.components.config.ts"
```

- [ ] **Step 4: Write the first failing component test.**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LabPanelState } from "./panel-state";

describe("LabPanelState", () => {
  it("distinguishes a failed query from an empty result and retries it", async () => {
    const retry = vi.fn();
    render(
      <LabPanelState
        kind="error"
        title="Orders could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={retry}
      />,
    );

    expect(screen.getByText("Orders could not load")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 5: Run the test and establish red.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/panel-state.component.test.tsx
```

Expected: FAIL with `Cannot find module './panel-state'`.

- [ ] **Step 6: Implement the reusable state panel.**

`LabPanelState` accepts `kind: "loading" | "empty" | "filtered-empty" | "error"`, `title`, `body`, optional `onRetry`, and optional `onClearFilters`. Loading renders three `Skeleton` rows. Error uses `AlertCircle` and a `Retry` button. Filtered-empty uses a `Clear filters` button. Empty renders text only. Import icons exclusively from `@/components/icons` and controls from `@/components/ui/button`.

- [ ] **Step 7: Run component tests and commit the harness.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/panel-state.component.test.tsx
```

Expected: PASS.

```sh
git add package.json bun.lock vitest.components.config.ts src/test-component-setup.ts src/components/blocks/attribution/klaviyo/panel-state.tsx src/components/blocks/attribution/klaviyo/panel-state.component.test.tsx
git commit -m "test(frontend): add component test harness"
```

### Task 2: Add exact URL state, timezone contract tests, and privileged route entry

**Files:**

- Create: `src/components/blocks/attribution/klaviyo/copy.ts`
- Create: `src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.ts`
- Create: `src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.test.ts`
- Create: `src/components/blocks/attribution/klaviyo/lab-link.tsx`
- Create: `src/components/blocks/attribution/klaviyo/klaviyo-access-gate.tsx`
- Create: `src/components/blocks/attribution/klaviyo/lab-link.component.test.tsx`
- Create: `src/components/blocks/attribution/klaviyo/klaviyo-access-gate.component.test.tsx`
- Create: `src/app/(protected)/attribution/klaviyo/page.tsx`
- Create: `src/app/(protected)/attribution/klaviyo/loading.tsx`
- Create: `src/app/(protected)/attribution/klaviyo/error.tsx`
- Create: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx`
- Modify: `src/app/(protected)/attribution/page.tsx:69-88,296-308`
- Modify: `src/lib/trpc/routers/klaviyo.test.ts`

- [ ] **Step 1: Add failing timezone-boundary contract tests.**

Extend the existing router test around the query-service mock already used by the Plan 3 `coverage` procedure. Name the captured spy `coverageQuery` in this test regardless of the owning module's export name; do not rename the service or introduce a second date converter:

```ts
it("converts an inclusive spring-forward store day once", async () => {
  await adminCaller.klaviyo.coverage({
    dateFrom: "2026-03-08",
    dateTo: "2026-03-08",
  });
  expect(coverageQuery).toHaveBeenLastCalledWith(
    expect.objectContaining({
      window: {
        from: new Date("2026-03-08T05:00:00.000Z"),
        to: new Date("2026-03-09T04:00:00.000Z"),
      },
    }),
  );
});

it("converts an inclusive fall-back store day once", async () => {
  await adminCaller.klaviyo.coverage({
    dateFrom: "2026-11-01",
    dateTo: "2026-11-01",
  });
  expect(coverageQuery).toHaveBeenLastCalledWith(
    expect.objectContaining({
      window: {
        from: new Date("2026-11-01T04:00:00.000Z"),
        to: new Date("2026-11-02T05:00:00.000Z"),
      },
    }),
  );
});
```

Fixture store timezone is `America/New_York`. Repeat the store-day assertion, using each procedure's other minimum valid fields, for `orders`, `unmatchedEvents`, `startOrderCoreSync`, and `recomputeMatches`: each accepts `dateFrom/dateTo`, rejects legacy `from/to` datetime input, and passes the same single router-resolved store `HalfOpenWindow` to its query/task boundary.

Give the fixture connection Klaviyo account timezone `America/Los_Angeles`. Add separate `reports` and `refreshReports` assertions showing `2026-03-08..2026-03-08` becomes `2026-03-08T08:00:00.000Z..2026-03-09T07:00:00.000Z` and `2026-11-01..2026-11-01` becomes `2026-11-01T07:00:00.000Z..2026-11-02T08:00:00.000Z`. These procedures reject legacy `from/to` instants and must not reuse the Shopify timezone conversion.

Also assert members, API keys, workers, and anonymous callers cannot call `health`; admin and owner can. No browser call includes organization/store/connection authority.

- [ ] **Step 2: Run router tests and establish contract status.**

Run:

```sh
bun run test -- src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS if Plans 2–4 implemented the approved browser boundary. If timezone tests fail, stop Plan 5 and repair the owning Plan 2–4 router contract before frontend work continues; Plan 5 must not add a converter or change backend query/task behavior.

- [ ] **Step 3: Define exact URL vocabulary and range resolver.**

In `copy.ts`, export these literal arrays:

```ts
export const LAB_VIEWS = ["orders", "unmatched", "reports", "probe"] as const;
export const LAB_RANGES = ["last7", "last30", "last90", "custom"] as const;
export const ORDER_STATUS_FILTERS = [
  "all",
  "confirmed",
  "candidate",
  "ambiguous",
  "no_klaviyo_event",
  "duplicate_conversion_events",
  "not_evaluated",
] as const;
export const PRODUCT_STATUS_FILTERS = [
  "all",
  "exact",
  "partial",
  "contradictory",
  "unavailable",
] as const;
export const CLAIM_TYPE_FILTERS = [
  "all",
  "campaign",
  "flow",
  "message",
  "interaction",
  "none",
] as const;
export const CHANNEL_FILTERS = ["all", "email", "sms", "onsite", "unknown"] as const;
export const DETAIL_TABS = [
  "explanation",
  "products",
  "journey",
  "claims",
  "inspector",
] as const;
export const JOURNEY_LOOKBACKS = [7, 30, 90] as const;
export const REPORT_KINDS = ["campaign", "flow"] as const;
```

`use-klaviyo-lab-state.ts` uses `parseAsStringLiteral`, `parseAsString`, and `parseAsInteger` for:

```text
view, range, from, to, orderStatus, productStatus, claimType,
channel, bucket, order, candidate, detail, lookback, reportKind
```

Use literal parsers for every enum-valued key, including `bucket` from `BUCKET_ORDER`; after parsing `lookback`, accept only a member of `JOURNEY_LOOKBACKS` and otherwise use `30`. Validate `from` and `to` with the existing `isDay` helper before resolving them. Arbitrary URL values must fall back locally instead of reaching tRPC and turning a bookmark into a validation error.

Keep the compile-time `ORDER_STATUS_FILTERS` aligned with Plan 3's `OrderEvidenceStatus`: exclude only the local `"all"` sentinel before calling `orders`. Test that `not_evaluated` reaches the router unchanged, returns Shopify-left-joined rows with no result ID, and is never presented as `no_klaviyo_event`.

Defaults: `orders`, `last30`, all filters, `explanation`, lookback `30`, report kind `campaign`. For `orders`, `unmatched`, and `probe`, resolve `last7`, `last30`, and `last90` from `health.store.todayInStoreTz`; for `reports`, resolve and clamp them from `health.connection.todayInAccountTz`. Use `addDays` and `isDay` from `@/components/blocks/attribution/days`; custom values remain calendar-day strings and clamp to the active view's today. Filter/view changes clear cursor stacks; leaving `orders` also clears `order` and `candidate` so detail cannot float over unmatched/reports/probe. Closing detail clears `order` and `candidate`.

Add pure tests in `use-klaviyo-lab-state.test.ts` asserting `today=2026-07-31` resolves to `2026-07-25..2026-07-31`, `2026-07-02..2026-07-31`, and `2026-05-03..2026-07-31`; custom future days clamp to `2026-07-31`; reversed custom input collapses to the earlier valid day; malformed days, unknown buckets, and unsupported lookbacks fall back without issuing invalid procedure inputs. With store today `2026-07-31` and account today `2026-07-30`, assert `view=reports&range=last7` resolves to `2026-07-24..2026-07-30` and carries the account-timezone label, while `view=orders` remains `2026-07-25..2026-07-31`. Run `bun run test -- src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.test.ts`; expected: FAIL before the resolver exists, then PASS after implementation.

- [ ] **Step 4: Write failing privileged-link and direct-route guard tests.**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KlaviyoLabLink } from "./lab-link";

describe("KlaviyoLabLink", () => {
  it.each(["owner", "admin"] as const)("shows for %s", (role) => {
    render(<KlaviyoLabLink role={role} />);
    expect(screen.getByRole("link", { name: "Klaviyo Lab" })).toHaveAttribute(
      "href",
      "/attribution/klaviyo",
    );
  });

  it.each(["member", null] as const)("hides for %s", (role) => {
    render(<KlaviyoLabLink role={role} />);
    expect(screen.queryByRole("link", { name: "Klaviyo Lab" })).toBeNull();
  });
});
```

Add `klaviyo-access-gate.component.test.tsx` with controlled mocks for `useActiveOrganizationRole` and `useRouter`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KlaviyoAccessGate } from "./klaviyo-access-gate";

const access = vi.hoisted(() => ({
  role: "member" as string | null,
  isPending: false,
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: access.replace }),
}));
vi.mock("@/hooks/use-active-organization-role", () => ({
  useActiveOrganizationRole: () => ({
    role: access.role,
    isPending: access.isPending,
  }),
}));

describe("KlaviyoAccessGate", () => {
  beforeEach(() => {
    access.role = "member";
    access.isPending = false;
    access.replace.mockReset();
  });

  it("redirects a member without flashing playground content", async () => {
    render(
      <KlaviyoAccessGate>
        <p>Sensitive evidence</p>
      </KlaviyoAccessGate>,
    );

    expect(screen.queryByText("Sensitive evidence")).toBeNull();
    await waitFor(() => expect(access.replace).toHaveBeenCalledWith("/"));
  });

  it.each(["owner", "admin"])("renders for %s", (role) => {
    access.role = role;
    render(
      <KlaviyoAccessGate>
        <p>Sensitive evidence</p>
      </KlaviyoAccessGate>,
    );
    expect(screen.getByText("Sensitive evidence")).toBeVisible();
  });

  it("shows only a neutral loading state while role is pending", () => {
    access.isPending = true;
    render(
      <KlaviyoAccessGate>
        <p>Sensitive evidence</p>
      </KlaviyoAccessGate>,
    );
    expect(screen.queryByText("Sensitive evidence")).toBeNull();
    expect(access.replace).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run the link test and establish red.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/lab-link.component.test.tsx
bun run test:components -- src/components/blocks/attribution/klaviyo/klaviyo-access-gate.component.test.tsx
```

Expected: FAIL with missing `lab-link` and `klaviyo-access-gate` modules.

- [ ] **Step 6: Implement route entry and navigation.**

`KlaviyoLabLink` calls `isPrivilegedOrgRole(role)` and renders `Button asChild`, `Link href="/attribution/klaviyo"`, and `Mail` from `@/components/icons`. Add it beside `FreshnessCaption` in existing Attribution header; pass current `role`. Do not change existing queries, figures, bucket ledger, filters, or calculations.

`KlaviyoAccessGate` is a client component. It reads `role` and `isPending` from `useActiveOrganizationRole`, uses `isPrivilegedOrgRole`, and calls `router.replace("/")` after a resolved non-privileged role. While pending or redirecting it renders only a neutral `role="status"` loading shell; it must never render children first. This is a route-level no-flash guard in addition to the protected layout's `OrgGuard`. Link hiding is only navigation UX, and every `orgAdminProcedure` remains the security boundary for data/actions.

Route entry is exact:

```tsx
import { KlaviyoAccessGate } from "@/components/blocks/attribution/klaviyo/klaviyo-access-gate";
import { KlaviyoPlayground } from "@/components/blocks/attribution/klaviyo/klaviyo-playground";

export default function KlaviyoPage() {
  return (
    <KlaviyoAccessGate>
      <KlaviyoPlayground />
    </KlaviyoAccessGate>
  );
}
```

Create `loading.tsx` with header, four coverage-card, filter-bar, and eight-row table skeletons. Create client `error.tsx` with heading `Klaviyo Lab could not load`, safe body text, and a `Retry` button calling `reset`. Initial `KlaviyoPlayground` renders a back link to `/attribution`, title, and `Advisory evidence only — production attribution stays unchanged.`

- [ ] **Step 7: Run tests, lint, and commit route entry.**

Run:

```sh
bun run test -- src/lib/trpc/routers/klaviyo.test.ts
bun run test:components -- src/components/blocks/attribution/klaviyo/lab-link.component.test.tsx
bun run test:components -- src/components/blocks/attribution/klaviyo/klaviyo-access-gate.component.test.tsx
bun run lint -- src/app/\(protected\)/attribution/page.tsx src/app/\(protected\)/attribution/klaviyo src/components/blocks/attribution/klaviyo
```

Expected: PASS and lint exit 0.

```sh
git add src/app/\(protected\)/attribution/page.tsx src/app/\(protected\)/attribution/klaviyo src/components/blocks/attribution/klaviyo/copy.ts src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.ts src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.test.ts src/components/blocks/attribution/klaviyo/lab-link.tsx src/components/blocks/attribution/klaviyo/lab-link.component.test.tsx src/components/blocks/attribution/klaviyo/klaviyo-access-gate.tsx src/components/blocks/attribution/klaviyo/klaviyo-access-gate.component.test.tsx src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(attribution): add privileged Klaviyo Lab route"
```

### Task 3: Add connection health, probe review, and explicit controls

**Files:**

- Create: `src/components/blocks/attribution/klaviyo/lab-header.tsx`
- Create: `src/components/blocks/attribution/klaviyo/probe-panel.tsx`
- Create: `src/components/blocks/attribution/klaviyo/sync-runs-panel.tsx`
- Create: `src/components/blocks/attribution/klaviyo/probe-panel.component.test.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx`

- [ ] **Step 1: Write failing probe/operation tests.**

Use typed fixtures with `satisfies RouterOutputs["klaviyo"]["probe"]`. Assert:

```tsx
it("blocks evidence views until the probe passes");
it("shows sampled orders, field coverage, collisions, product coverage, and claim coverage");
it("starts discovery from the environment-backed empty-connection state");
it("requires a review note before approving or rejecting the probe");
it("requires a review note before approving or rejecting a rule");
it("disables join-rule approval when that rule has nonzero collisions");
it("renders incomplete Shopify access as partial coverage, not complete");
it("shows sanitized failed-run text and never raw provider data");
it("renders only safe checkpoint mode index and page never provider cursor");
it("tracks recompute by scoped Trigger invocation status not sync-run operation");
it("keeps recompute locked when one match attempt failed but Trigger is still retrying");
it("clears recompute only for matching published or terminal failed invocation status");
it("distinguishes missing connection from health query failure and retries the latter");
it("keeps prior probe and run rows visible when a refetch fails");
```

Probe review requires `reportId` plus a bounded non-empty `reviewNote`; buttons are exactly `Approve probe` and `Reject probe`. Rule review displays the stored probe-generated canonicalization read-only and submits only `ruleId` plus required `reviewNote`; buttons are exactly `Approve rule` and `Reject rule`. Rule approval remains unavailable until the probe is passed.

- [ ] **Step 2: Run the probe test and establish red.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/probe-panel.component.test.tsx
```

Expected: FAIL because probe components do not exist.

- [ ] **Step 3: Implement safe health and probe components.**

`LabHeader` receives `RouterOutputs["klaviyo"]["health"]`, active-run state, and callbacks. Render connection status, account name, store timezone, Klaviyo account timezone/currency, covered day range, stage freshness, last successful sync, stale/degraded badge, `Sync now`, and `Recompute matches`. Missing connection renders an environment-configuration explanation plus `Discover connection`, which invokes server-owned `startDiscovery`; it does not request credentials or invent self-service connection UI.

`ProbePanel` receives `RouterOutputs["klaviyo"]["probe"]`, mutation busy state, and run/probe-review/rule-review callbacks. Render passed/pending/failed status, sample range/count, bounded field shapes, collision/unmatched/product/claim coverage, access limitations, reviewer metadata, and join-rule table. Never render unrestricted property values, profile IDs, HMACs, or secrets.

`SyncRunsPanel` receives `RouterOutputs["klaviyo"]["syncRuns"]`; render operation, requested range, status, read/inserted/updated/ignored/warning/failure counts, the server-projected checkpoint summary (`sourceMode`, `metricIndex`, and `page` only), sanitized error, and timestamps. Never render or infer the stored opaque provider cursor or raw request/checkpoint JSON. Include a hostile component fixture whose mocked transport attempts to add an email-like `cursor` field and assert the panel's explicit field rendering never displays it. Preserve old rows during refetch.

Health, probe, and run queries each receive explicit loading and query-error/retry states. A successful health response with no configured connection is the configuration empty state, not an error. When a refetch fails after cached probe/run data exists, keep that data visible with a stale/error banner.

`KlaviyoPlayground` renders one keyboard-accessible view switcher with exact URL values `orders`, `unmatched`, `reports`, and `probe`. Inactive view bodies are unmounted so their queries cannot run accidentally. `Unmatched events` and `Reports` remain sibling views, never tabs inside an order detail.

- [ ] **Step 4: Wire tRPC queries, polling, mutations, and invalidation.**

In `KlaviyoPlayground`, use:

```ts
const health = useQuery({
  ...trpc.klaviyo.health.queryOptions(),
});
const probe = useQuery(trpc.klaviyo.probe.queryOptions());
const syncRuns = useQuery({
  ...trpc.klaviyo.syncRuns.queryOptions({ limit: 20, cursor: null }),
  refetchInterval: (query) =>
    hasLocallyQueuedSourceOperation ||
    query.state.data?.runs.some((run) => run.status === "running")
      ? 5_000
      : false,
});
const matchInvocation = useQuery({
  ...trpc.klaviyo.matchInvocationStatus.queryOptions({
    triggerRunId: locallyQueuedRecompute?.triggerRunId ?? "",
  }),
  enabled: locallyQueuedRecompute !== null,
  refetchInterval: (query) =>
    query.state.data?.status === "running" ? 5_000 : false,
});
```

Use mutations `startDiscovery`, `runProbe`, `approveProbe`, `rejectProbe`, `approveJoinRule`, `rejectJoinRule`, `startOrderCoreSync`, and `recomputeMatches`. `runProbe` submits a fixed `sampleSize: 30`; the broad order-core sync stays disabled until the latest durable probe is passed. Supply only inclusive `dateFrom/dateTo`, fixed/allowlisted mode values, and server-defined report/rule/review fields. On success, toast queued/reviewed status and invalidate `health`, `syncRuns`, `probe`, `coverage`, `orders`, `orderExplanation`, `orderProducts`, `orderJourney`, `orderClaims`, `orderInspector`, `unmatchedEvents`, and `reports` path filters. On error, call `getUserFacingErrorMessage` with action-specific safe fallback.

Treat `queued` as local UI state from a pending mutation/returned Trigger handle; never require or invent a `queued` database run status. For discovery/probe/order-core/report actions backed by `klaviyo_sync_run`, record the operation and click time locally, poll `syncRuns`, and clear that marker when a matching operation with a newer `startedAt` appears in any server status. If no row appears within a bounded 30-second confirmation window, show `Queue confirmation delayed`, clear the local lock, and let the backend handoff/lease/idempotency guard remain authoritative.

`recomputeMatches` is deliberately different: Plan 3 has no persisted running match row. Store its returned `{ triggerRunId, invocationFingerprint }` and poll only `matchInvocationStatus({ triggerRunId })`. Keep the local lock for `running`. Clear it only when that scoped response carries the same fingerprint and is either `published` (with its verified `matchRunId`) or terminal `failed`; then invalidate health/coverage/order evidence reads. Never infer invocation failure from health's failed-attempt count or a persisted failed match-attempt row, because Trigger may still be retrying, and never wait for a `syncRuns` operation named matching. A mismatched fingerprint or query error fails closed and remains locked until the bounded 30-second UI confirmation window; on timeout show `Match confirmation delayed` and clear only the local lock. A duplicate click remains safe because Plan 3's server helper reuses a live canonical global key and deterministically recovers a canceled/non-publishing terminal handle. Disable each control while its mutation is pending or matching local marker is active; also disable database-backed controls while their corresponding server run is `running`.

- [ ] **Step 5: Run tests and commit controls.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/probe-panel.component.test.tsx
bun run test -- src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS.

```sh
git add src/components/blocks/attribution/klaviyo/lab-header.tsx src/components/blocks/attribution/klaviyo/probe-panel.tsx src/components/blocks/attribution/klaviyo/sync-runs-panel.tsx src/components/blocks/attribution/klaviyo/probe-panel.component.test.tsx src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx
git commit -m "feat(klaviyo): add probe and sync controls"
```

### Task 4: Add coverage filters and Shopify-order-first ledger

**Files:**

- Create: `src/components/blocks/attribution/klaviyo/coverage-summary.tsx`
- Create: `src/components/blocks/attribution/klaviyo/filter-bar.tsx`
- Create: `src/components/blocks/attribution/klaviyo/orders-table.tsx`
- Create: `src/components/blocks/attribution/klaviyo/orders-table.component.test.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx`

- [ ] **Step 1: Write failing coverage/table tests.**

Use typed API fixtures and assert these visible behaviors:

```tsx
it("shows confirmed candidate ambiguous no-event duplicate and not-evaluated counts");
it("counts event-side not-evaluated separately and shows its boundary caveat");
it("shows exact partial contradictory and unavailable product counts");
it("puts Shopify order date Net sales bucket and products before Klaviyo evidence");
it("labels candidate confidence as advisory and never as confirmed");
it("does not choose one campaign chain for duplicate conversion events");
it("distinguishes success with zero rows from query failure");
it("loads the next cursor without client-side resorting");
it("clears all evidence filters while retaining the selected date range");
```

- [ ] **Step 2: Run the table test and establish red.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/orders-table.component.test.tsx
```

Expected: FAIL because coverage/filter/table components do not exist.

- [ ] **Step 3: Implement coverage and filters.**

`CoverageSummary` renders explicit counts from `RouterOutputs["klaviyo"]["coverage"]`: Shopify inspected/evaluated and each order status, every `EventEvidenceStatus` including API-only `not_evaluated`, product statuses, orders with claims, incident-edge boundary warnings, and stale/failed stages. Event-side `not_evaluated` is labelled `Outside evaluated boundary`, with the caveat `A counterpart may exist outside this window.` Zero is `0`; unavailable is labelled `Unavailable`; no count is inferred from another count.

`FilterBar` receives the active view's day anchor and visible timezone label: Shopify store timezone for orders/unmatched/probe, Klaviyo account timezone for reports. Orders show date, order status, product status, claim type, channel, and current Shopify bucket. Unmatched shows date and channel only. Reports show account-day date, channel, and report kind only. Probe shows no evidence-ledger filters. Hidden filters never enter the active query input. Use existing `Calendar`, `Popover`, `Select`, and attribution bucket labels. Never add `last90` to existing production Attribution presets because that would change `/attribution` UI.

- [ ] **Step 4: Implement server-cursor order ledger.**

Use semantic `Table` primitives, not `DataTable`. Input is:

```ts
{
  dateFrom,
  dateTo,
  orderStatus: orderStatus === "all" ? undefined : orderStatus,
  productStatus: productStatus === "all" ? undefined : productStatus,
  claimType: claimType === "all" ? undefined : claimType,
  channel: channel === "all" ? undefined : channel,
  bucket: bucket || undefined,
  cursor,
  limit: 25,
}
```

Fixed server order is newest `(orderCreatedAt, orderId)` first. Columns are grouped and ordered:

```text
Shopify truth: Order | Date | Net sales | Current bucket | Purchased products
Klaviyo evidence: Order status | Product status | Channel | Campaign / flow / message | Warnings
```

Each cursor page owns one query as `BucketOrdersPanel` does today. First-page empty state says `No Shopify orders in this range`; filtered empty says `No orders match these evidence filters`; query error shows Retry. Clicking a row sets URL `order=<internal id>` and `detail=explanation`. External Shopify links stop row propagation.

For `duplicate_conversion_events`, render `Multiple conversion events` plus the warning/count and leave canonical campaign/flow/message blank; never choose one event's claim chain in the row.

- [ ] **Step 5: Wire only active-view queries.**

Run `coverage` only when the connection exists, the latest durable probe status is exactly `passed`, and the active view uses Shopify-store-day semantics (`orders` or `unmatched`); do not issue or display order coverage in the separate reports view. Run `orders` only for `view=orders`, a resolved range, and that same passed-probe gate. Pending/failed/no-probe states keep all broad evidence queries disabled and show `ProbePanel`; they do not merely hide already-issued requests. When filters/range change, reset cursor list and selected order/candidate. Use existing cached data during refetch; if refetch fails with cached rows, show a stale/error banner above rows instead of replacing them.

- [ ] **Step 6: Run tests and commit the ledger.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/orders-table.component.test.tsx
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS.

```sh
git add src/components/blocks/attribution/klaviyo/coverage-summary.tsx src/components/blocks/attribution/klaviyo/filter-bar.tsx src/components/blocks/attribution/klaviyo/orders-table.tsx src/components/blocks/attribution/klaviyo/orders-table.component.test.tsx src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx
git commit -m "feat(klaviyo): add order evidence ledger"
```

### Task 5: Add URL-addressable five-tab order evidence detail

**Files:**

- Create: `src/components/blocks/attribution/klaviyo/order-detail-sheet.tsx`
- Create: `src/components/blocks/attribution/klaviyo/order-explanation.tsx`
- Create: `src/components/blocks/attribution/klaviyo/product-comparison.tsx`
- Create: `src/components/blocks/attribution/klaviyo/journey-timeline.tsx`
- Create: `src/components/blocks/attribution/klaviyo/claims-chain.tsx`
- Create: `src/components/blocks/attribution/klaviyo/source-inspector.tsx`
- Create: `src/components/blocks/attribution/klaviyo/order-detail-sheet.component.test.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx`

- [ ] **Step 1: Write failing detail and redaction tests.**

```tsx
it("opens the order selected in URL and closes by clearing order and candidate");
it("shows matcher version method confidence features normalization and reasons");
it("lets ambiguous results inspect each candidate without selecting a winner");
it("compares Shopify and Klaviyo product multisets without allocating revenue");
it("labels the selected Placed Order or Ordered Product source and never sums both");
it("shows candidate product overlap per edge without publishing a concluded status");
it("labels journey events same Klaviyo profile rather than same customer");
it("shows the source caveat when Klaviyo reports a profile merge");
it("shows unknown claim relationships as unknown instead of guessing names");
it("shows duplicate conversion claim chains separately without naming a canonical one");
it("does not query inspector until its tab opens");
it("never renders raw customerJourney email HMAC profile ID query string or secret");
it("shows the safe truncation warning without enumerating omitted keys or values");
```

The hostile inspector fixture places keys named `customerJourney`, `email`, `identityHmac`, `profileId`, `privateKey`, and `rawPayload` both at the response root and inside a forged `redactedProperties` object; none may appear in rendered text. Include a server-projected `truncated: true`/safe warning fixture and assert the warning appears without any omitted key or value.

- [ ] **Step 2: Run detail tests and establish red.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/order-detail-sheet.component.test.tsx
```

Expected: FAIL because detail components do not exist.

- [ ] **Step 3: Implement detail shell and lazy query boundaries.**

Use right `Sheet`; `className="w-full sm:max-w-4xl"`. Header contains order name/date/Net sales/current production bucket and `Advisory evidence only`. Use line `Tabs` with exact values from `DETAIL_TABS`.

Query rules:

```ts
orderExplanation: enabled when orderId exists;
orderProducts: enabled when orderId exists && detail === "products", input { orderId, candidateId? };
orderJourney: enabled when orderId exists && detail === "journey";
orderClaims: enabled when orderId exists && detail === "claims", input { orderId, candidateId? };
orderInspector: enabled when orderId exists && detail === "inspector", input { orderId, candidateId? };
```

Pass `candidateId` only to `orderProducts`, `orderClaims`, and `orderInspector`, and only when selected from explanation candidates. Never pass it to `orderJourney`; pass `lookbackDays` only to journey. The server remains authoritative and returns `NOT_FOUND` if a bookmarked candidate no longer belongs to that order's current scoped run; clear the stale `candidate` URL key and keep the order sheet open on that response. Every tab has its own skeleton, retry, safe empty state, and stale warning.

- [ ] **Step 4: Implement exact tab semantics.**

- Explanation: matcher version, method, confidence, evidence features/weights/tolerances, normalization, candidate count, tie/conflict reasons. Diagnostic candidates retain `candidate`/`ambiguous`; UI offers no “confirm” action.
- Products: Shopify line snapshots beside the explicitly labelled selected Klaviyo source, product/variant/SKU/quantity differences, and one order-level Shopify Net sales figure. Never sum `Placed Order` and `Ordered Product` observations or display product revenue. Without `candidateId`, a published exact/partial/contradictory/unavailable status appears only for a confirmed conversion. With `candidateId`, render `orderProducts`' separately labelled per-edge overlap as diagnostic evidence and render no concluded product status; the UI must not reconstruct overlap from raw fields or treat the edge as selected.
- Journey: approved events sorted chronologically, 7/30/90 lookback bounded by ingested coverage, directly attributed interaction distinguished from `same_klaviyo_profile`, later/cross-profile events absent, and a source caveat shown when the projection reports a profile merge.
- Claims: interaction, message, campaign or flow, conversion chain; open/delivery never called click; bot warning only when source field exists; missing relationship remains `Unknown`. For duplicate conversions, group each event's chain separately and label the set non-canonical.
- Inspector: render an explicit compile-time list of typed normalized/redacted fields plus fingerprint rows `{ approvedKey | keyHash, valueType }`; never enumerate response objects or nested property maps with `Object.keys`, `Object.entries`, or generic JSON rendering. Show server-projected redaction/schema-drift/truncation warnings without exposing omitted keys or values. Never call `JSON.stringify` on the full query object. Copy controls exist only for event/campaign/flow/message external IDs. Render no Klaviyo profile ID and no HMAC digest; at most show coarse server-projected identity-evidence presence/key-version metadata, with no copy control.

- [ ] **Step 5: Run tests and commit detail.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/order-detail-sheet.component.test.tsx
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS, including hostile inspector fixture.

```sh
git add src/components/blocks/attribution/klaviyo/order-detail-sheet.tsx src/components/blocks/attribution/klaviyo/order-explanation.tsx src/components/blocks/attribution/klaviyo/product-comparison.tsx src/components/blocks/attribution/klaviyo/journey-timeline.tsx src/components/blocks/attribution/klaviyo/claims-chain.tsx src/components/blocks/attribution/klaviyo/source-inspector.tsx src/components/blocks/attribution/klaviyo/order-detail-sheet.component.test.tsx src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx
git commit -m "feat(klaviyo): add order evidence inspector"
```

### Task 6: Add separate unmatched-event and aggregate-report views

**Files:**

- Create: `src/components/blocks/attribution/klaviyo/unmatched-events-table.tsx`
- Create: `src/components/blocks/attribution/klaviyo/reports-table.tsx`
- Create: `src/components/blocks/attribution/klaviyo/evidence-views.component.test.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx`

- [ ] **Step 1: Write failing separation tests.**

```tsx
it("shows unmatched Placed Order events without inventing Shopify orders");
it("renders event status and a boundary caveat for event-side not-evaluated");
it("labels provider value as Klaviyo observation rather than Shopify Net sales");
it("paginates unmatched events by server cursor");
it("keeps campaign and flow report facts outside the order ledger and detail");
it("labels reports with Klaviyo account timezone date semantics and as-of time");
it("does not label a report range as Shopify order-occurrence time");
it("refreshes only the selected report kinds and range");
```

- [ ] **Step 2: Run view tests and establish red.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/evidence-views.component.test.tsx
```

Expected: FAIL because unmatched/report components do not exist.

- [ ] **Step 3: Implement unmatched-event view.**

Call `unmatchedEvents` only for `view=unmatched`, a passed latest probe, and a resolved range, with `dateFrom/dateTo`, optional `EventEvidenceStatus`, optional channel, `limit: 25`, and cursor. Its server read model includes current non-confirmed results plus event-left-joined `not_evaluated` rows created by incident-edge closure. Columns: event/time, event external ID, **Event status**, Klaviyo-observed value/currency, product observations, claim summary, warnings. Render `not_evaluated` as `Outside evaluated boundary` and show `A Shopify counterpart may exist outside this evaluated window`; never relabel it `unmatched` or claim no order exists. No Shopify order/Net sales label appears. Use the same first-page/filtered/error/load-more distinctions as Orders; preserve cached rows with a stale/error banner on failed refetch.

- [ ] **Step 4: Implement aggregate-report view.**

Call `reports` only for `view=reports`, a passed latest probe, and a resolved account-day range, with `dateFrom/dateTo`, `kind: reportKind`, optional channel, `limit: 50`, and cursor. Columns: marketing object, kind, channel/status, recipients, unique opens, unique clicks, conversions, `Klaviyo conversion value`, Klaviyo-account-timezone send-date range, and `as of`. Beside the date controls, render `Report dates use <account timezone> message-send days`; show permanent caption `Aggregate Klaviyo claims — not order-level attribution.` Give reports their own loading, first-page empty, filtered-empty, error/retry, load-more, and cached-stale states; never reuse an order-ledger empty label.

Wire `refreshReports` with `{ dateFrom, dateTo, kinds: [reportKind] }` using account-day semantics; toast queued status, invalidate `reports`, `syncRuns`, and `health`, and use the same mutation-pending/local-queued/server-running lock from Task 3.

- [ ] **Step 5: Run tests and commit separate views.**

Run:

```sh
bun run test:components -- src/components/blocks/attribution/klaviyo/evidence-views.component.test.tsx
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts
```

Expected: PASS.

```sh
git add src/components/blocks/attribution/klaviyo/unmatched-events-table.tsx src/components/blocks/attribution/klaviyo/reports-table.tsx src/components/blocks/attribution/klaviyo/evidence-views.component.test.tsx src/components/blocks/attribution/klaviyo/klaviyo-playground.tsx
git commit -m "feat(klaviyo): add unmatched events and reports"
```

### Task 7: Verify every UI state, production isolation, and responsive behavior

**Files:**

- Modify: `src/components/blocks/attribution/klaviyo/*.component.test.tsx` only when a named state below lacks coverage.
- No product file should change after this task starts unless a failing check identifies a concrete defect.

- [ ] **Step 1: Run complete component state matrix.**

Run:

```sh
bun run test:components
```

Expected: PASS. Tests cover missing/pending/ready/degraded/disabled connection states; pending/passed/failed probe review; confirmed, candidate, ambiguous, no-Klaviyo-event, duplicate-conversion-event, not-evaluated, unmatched-event, exact, partial, contradictory, unavailable, stale, partial-run, failed, empty, filtered-empty, and loading states; inspector redaction/truncation; owner/admin link visibility; member direct-route no-flash redirect; and mutation-pending/local-queued/server-running controls.

- [ ] **Step 2: Run backend contract and production-attribution regression suites.**

Run:

```sh
bun run test -- src/lib/klaviyo/queries.test.ts src/lib/trpc/routers/klaviyo.test.ts src/lib/attribution-queries.test.ts src/lib/attribution-bucket.test.ts src/components/blocks/attribution/ledger.test.ts
```

Expected: PASS. `/attribution` revenue identity, bucket behavior, Meta verification, and campaign ledger remain unchanged.

- [ ] **Step 3: Run full repository verification.**

Run each command separately:

```sh
bun run test
bun run test:components
bun run lint
bun run build
git diff --check
```

Expected: every command exits 0; `git diff --check` prints nothing.

- [ ] **Step 4: Perform authenticated browser smoke verification.**

Run:

```sh
bun dev
```

Expected: Next.js serves `http://localhost:3000`.

Verify with seeded Plan 2–4 data:

1. Owner/admin sees `Klaviyo Lab` in `/attribution`; member does not.
2. Member direct navigation to `/attribution/klaviyo` returns to `/`; direct tRPC reads remain `FORBIDDEN`.
3. URL filters survive reload and browser Back/Forward.
4. Probe gate blocks broad evidence until passed.
5. Sync/recompute/report controls show queued/running state and do not double-submit.
6. Every order state opens correct detail; Inspector exposes only safe projection.
7. Unmatched events never look like Shopify orders; reports never look order-level.
8. Mobile viewport has no page-level horizontal overflow; tables scroll inside their containers and detail sheet fills viewport.
9. Light/dark themes preserve status contrast and keyboard focus.
10. Order/unmatched ranges show Shopify-store timezone semantics; report ranges switch to and visibly name Klaviyo account-timezone send-date semantics.

- [ ] **Step 5: Confirm final scope and commit only if verification added test coverage.**

Run:

```sh
git status --short
```

Expected: only files named by this plan. If Task 7 added tests, commit them:

```sh
git add src/components/blocks/attribution/klaviyo
git commit -m "test(klaviyo): cover playground state matrix"
```

If no files changed during verification, do not create an empty commit.

## Final acceptance checklist

- [ ] `/attribution/klaviyo` renders playground content only for owner/admin; the Attribution-header link is hidden otherwise, and member direct navigation redirects without flashing content.
- [ ] Every browser tRPC call uses `trpc.klaviyo.*`; no UI imports Trigger.dev or Klaviyo services.
- [ ] Every read/action remains protected by `orgAdminProcedure` and active-organization scope.
- [ ] Order/probe/evidence store days and report account days each convert exactly once in their declared timezone, including 23/25-hour DST days; report dates are visibly labelled as account-timezone send days.
- [ ] Probe state and join-rule decisions are inspectable before broad sync is enabled.
- [ ] Every inspected Shopify order and in-scope Klaviyo event has an explicit visible state.
- [ ] Shopify truth appears before Klaviyo evidence; production bucket and Net sales remain unchanged.
- [ ] Candidate/ambiguous evidence never reads as confirmed.
- [ ] Product comparison never allocates revenue.
- [ ] Journey uses exact profile relationship and says `same Klaviyo profile`, not same customer.
- [ ] Inspector renders no raw payload, customer journey, email, full HMAC, profile ID, secret, or unrestricted URL/query.
- [ ] Aggregate reports remain separate and visibly labelled as Klaviyo claims.
- [ ] Failed refreshes preserve prior data and visibly mark it stale/failed.
- [ ] Existing `/attribution` query behavior and calculations remain unchanged.
