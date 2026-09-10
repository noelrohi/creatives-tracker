# Klaviyo Campaigns Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Klaviyo campaign ledger on a first-class `/klaviyo` page that every org role can open from the sidebar, keeping the rest of the Klaviyo Lab admin-only and the pilot's single-tenant binding unchanged.

**Architecture:** The three `klaviyo.ledger.*` reads and a new `ledgerContext` query move to the plain org procedure. The ledger's URL parsers, filter row, table wiring, and detail sheet are lifted out of the lab into prop-driven components under `ledger/`, consumed by both the lab's Campaigns tab (thin adapter) and the new page component under `src/components/blocks/klaviyo/`. Admin-only affordances (Refresh report, Open lab, View orders) render only for privileged roles.

**Tech Stack:** Next.js 16 App Router, React 19, tRPC 11, nuqs, Vitest 4 (`npm run test`, `npm run test:components`), shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-10-klaviyo-campaigns-page-design.md`

## Global Constraints

- Branch `feat/klaviyo-campaigns-page`, based on `origin/main`. Conventional-commit **titles only** — no body, no trailers.
- Run tests with `npm run test` (never `bun test`); component tests with `npm run test:components`; typecheck with `npx tsc --noEmit`; lint touched files with `npx eslint <files>`. Never stage `.gitignore`.
- Icons only from `@/components/icons` (`lucide-react` is blocked by lint).
- Only `klaviyo.ledger.list`, `.messages`, `.detail`, and the new `klaviyo.ledgerContext` use `orgProcedure`; every other `klaviyo.*` procedure stays `orgAdminProcedure`.
- Route `/klaviyo`; sidebar entry `{ label: "Klaviyo", href: "/klaviyo", icon: "solar:letter-linear" }` directly after Meta, not privileged; the privileged `/attribution/klaviyo` sidebar entry is removed; the lab route and its deep links are unchanged.
- Admin-only on the page: Refresh report button, "Open lab" link, and the sheet's "View orders" link. Members get read-only table, message rows, and sheet.
- Empty state copy for an unconfigured org: title "No Klaviyo connection for this organization", body "The Klaviyo pilot is bound to one store; ask an admin if you expected data here." No button.
- Member hint when no report exists for the range: "Ask an admin to refresh the report."
- `ledgerContext` returns `{ configured, accountName, accountTimezone, todayInAccountTz, lastMatchPublishedAt }` and never throws for an unconfigured org (spec §6 also listed `lastReportSyncedAt`; it is unused by the page and is dropped — YAGNI).
- The pilot binding, loaders, row rules, and the lab's other views are untouched.

## File Structure

**API**
- Modify `src/lib/trpc/routers/klaviyo.ts` — import `orgProcedure`; `ledger.*` → `orgProcedure`; add `ledgerContext`.
- Modify `src/lib/trpc/routers/klaviyo.test.ts` — RBAC tables split; `ledgerContext` tests.
- Modify `src/lib/organization-access.ts` (+ its test) — `/klaviyo` joins `MEMBER_PATH_PREFIXES`.

**Shared ledger units** (`src/components/blocks/attribution/klaviyo/ledger/`)
- Create `ledger-url-state.ts` — `LEDGER_URL_PARSERS`, `LedgerUrlState`, `ledgerStateHelpers`.
- Create `ledger-url-state.test.ts`.
- Create `ledger-filters.tsx` — `LabRangeControls` (range select + calendar + caption) and `LedgerFilters` (kind, channel, search).
- Create `ledger-section.tsx` — list query + expansion + `LedgerTable` + `LedgerMessageRows`.
- Modify `ledger-table.tsx` — `onRefresh` optional, `refreshHint` for members.
- Modify `ledger-detail-sheet.tsx` — props `{ objectId, range, onClose, onViewOrders? }`.
- Modify `../use-klaviyo-lab-state.ts` — spread `LEDGER_URL_PARSERS`, export `LAB_URL_PARSERS`, reuse helpers.
- Modify `../filter-bar.tsx` — render `LabRangeControls` and `LedgerFilters`.
- Modify `../klaviyo-playground.tsx` — `LedgerView` becomes an adapter over `LedgerSection`; sheet gets props.

**Page** (`src/components/blocks/klaviyo/`)
- Create `campaigns-page.copy.ts`, `use-ledger-page-state.ts`, `klaviyo-campaigns-page.tsx`, `klaviyo-campaigns-page.component.test.tsx`.
- Create `src/app/(protected)/klaviyo/page.tsx`.
- Modify `src/components/app-sidebar.tsx`.

---

### Task 1: Open the ledger reads to members and add `ledgerContext`

**Files:**
- Modify: `src/lib/trpc/routers/klaviyo.ts:4` (import), `:130-132` (`health`, unchanged, for reference), `:464-540` (`ledger` sub-router)
- Test: `src/lib/trpc/routers/klaviyo.test.ts`

**Interfaces:**
- Produces: `trpc.klaviyo.ledgerContext()` → `{ configured: boolean; accountName: string | null; accountTimezone: string; todayInAccountTz: string; lastMatchPublishedAt: Date | null }` on `orgProcedure`; `trpc.klaviyo.ledger.list/messages/detail` callable by members.

- [ ] **Step 1: Write the failing router tests**

In `src/lib/trpc/routers/klaviyo.test.ts`, remove the three `ledger.*` entries from `PROCEDURE_CALLS` and add, directly below that array:

```ts
/** Reads every org role may make: the campaigns page is not admin-only. */
const MEMBER_PROCEDURE_CALLS: Array<
  [string, (caller: ReturnType<typeof sessionCaller>) => Promise<unknown>]
> = [
  ["ledgerContext", (caller) => caller.ledgerContext()],
  ["ledger.list", (caller) => caller.ledger.list({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })],
  ["ledger.messages", (caller) => caller.ledger.messages({ dateFrom: "2026-07-01", dateTo: "2026-07-31", objectId: "obj" })],
  ["ledger.detail", (caller) => caller.ledger.detail({ dateFrom: "2026-07-01", dateTo: "2026-07-31", objectId: "obj" })],
];
```

Inside `describe("klaviyo router RBAC", ...)` add:

```ts
  it("lets every org role read the campaigns ledger but still bars API-key and worker callers", async () => {
    for (const [, call] of MEMBER_PROCEDURE_CALLS) {
      await expect(call(sessionCaller("member"))).resolves.toBeDefined();
      await expect(call(sessionCaller("admin"))).resolves.toBeDefined();
      await expect(
        call(apiKeyCaller() as unknown as ReturnType<typeof sessionCaller>),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        call(workerCaller() as unknown as ReturnType<typeof sessionCaller>),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
```

(The `beforeEach` already resolves `loadLedgerRows/Messages/Detail` mocks for the admin-passes test; keep them.) Add a new describe:

```ts
describe("ledgerContext", () => {
  it("projects the health payload down to what the campaigns page needs", async () => {
    mocks.getKlaviyoHealthForOrganization.mockResolvedValue({
      configured: true,
      store: { id: "store-1", shopDomain: "reviv.example.myshopify.com", ianaTimezone: "Asia/Bangkok", currency: "USD", todayInStoreTz: "2026-09-10" },
      connection: {
        status: "ready", accountName: "Reviv", timezone: "Asia/Bangkok", currency: "USD",
        todayInAccountTz: "2026-09-10", lastDiscoverySyncedAt: null, lastEventSyncedAt: null,
        lastMatchPublishedAt: new Date("2026-09-10T01:00:00Z"),
      },
    });
    await expect(sessionCaller("member").ledgerContext()).resolves.toEqual({
      configured: true,
      accountName: "Reviv",
      accountTimezone: "Asia/Bangkok",
      todayInAccountTz: "2026-09-10",
      lastMatchPublishedAt: new Date("2026-09-10T01:00:00Z"),
    });
  });

  it("reports not configured instead of throwing for an org without the pilot", async () => {
    mocks.getKlaviyoHealthForOrganization.mockResolvedValue({ configured: true, store: null, connection: null });
    await expect(sessionCaller("member").ledgerContext()).resolves.toEqual({
      configured: false,
      accountName: null,
      accountTimezone: "UTC",
      todayInAccountTz: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      lastMatchPublishedAt: null,
    });
    mocks.getKlaviyoHealthForOrganization.mockResolvedValue({ configured: false, store: null, connection: null });
    await expect(sessionCaller("member").ledgerContext()).resolves.toMatchObject({ configured: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- --run src/lib/trpc/routers/klaviyo.test.ts`
Expected: FAIL — members get FORBIDDEN on `ledger.list`; `ledgerContext` is not a function.

- [ ] **Step 3: Implement**

In `src/lib/trpc/routers/klaviyo.ts`:

```ts
import { router, orgAdminProcedure, orgProcedure } from "../init";
```

Add `deriveDayInTimezone` to the imports from `@/lib/shopify-ingest` (grep how the trigger imports it: `import { deriveDayInTimezone } from "@/lib/shopify-ingest";`). Change `list`, `messages`, `detail` inside `ledger: router({...})` from `orgAdminProcedure` to `orgProcedure`, and add above `ledger:`:

```ts
  /**
   * What the campaigns page needs from the connection, readable by every org
   * role: no statuses, sync timestamps, or store details from the admin-only
   * `health` payload. An org without the pilot gets `configured: false`
   * rather than an error, so the page can render its empty state.
   */
  ledgerContext: orgProcedure.query(async ({ ctx }) => {
    const health = await getKlaviyoHealthForOrganization(ctx.organizationId);
    const connection = health.connection;
    if (!health.configured || connection === null) {
      return {
        configured: false as const,
        accountName: null,
        accountTimezone: "UTC",
        todayInAccountTz: deriveDayInTimezone(new Date(), "UTC"),
        lastMatchPublishedAt: null,
      };
    }
    const accountTimezone = connection.timezone ?? "UTC";
    return {
      configured: true as const,
      accountName: connection.accountName,
      accountTimezone,
      todayInAccountTz:
        connection.todayInAccountTz ?? deriveDayInTimezone(new Date(), accountTimezone),
      lastMatchPublishedAt: connection.lastMatchPublishedAt,
    };
  }),
```

- [ ] **Step 4: Run and commit**

Run: `npm run test -- --run src/lib/trpc/routers/klaviyo.test.ts && npx tsc --noEmit && npx eslint src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts`
Expected: PASS, clean.

```bash
git add src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(klaviyo): open the campaigns ledger reads to every org role"
```

---

### Task 2: Shared ledger URL state

**Files:**
- Create: `src/components/blocks/attribution/klaviyo/ledger/ledger-url-state.ts`, `ledger-url-state.test.ts`
- Modify: `src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.ts:80-105` (parsers), `:147-168` (helpers)
- Modify: `src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.test.ts`

**Interfaces:**
- Produces:

```ts
export const LEDGER_URL_PARSERS: { range; from; to; ledgerKind; ledgerChannel; q; source; sort; dir };
export type LedgerUrlState = { range: LabRange; from: string | null; to: string | null; ledgerKind: LedgerKindFilter; ledgerChannel: LedgerChannelFilter; q: string | null; source: string | null; sort: LedgerSortColumn; dir: LedgerSortDirection };
export type LedgerUrlPatch = Partial<{ [K in keyof LedgerUrlState]: LedgerUrlState[K] | null }>;
export function ledgerStateHelpers(state: LedgerUrlState, setState: (patch: LedgerUrlPatch) => unknown): { openSource(id: string): void; closeSource(): void; toggleSort(column: LedgerSortColumn): void; clearLedgerFilters(): void };
export const LAB_URL_PARSERS (from use-klaviyo-lab-state.ts) — the lab's full parser map, spreading LEDGER_URL_PARSERS.
```

- [ ] **Step 1: Write the failing tests**

`ledger/ledger-url-state.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { LEDGER_URL_PARSERS, ledgerStateHelpers, type LedgerUrlState } from "./ledger-url-state";
import { LAB_URL_PARSERS } from "../use-klaviyo-lab-state";

const state: LedgerUrlState = {
  range: "last30", from: null, to: null, ledgerKind: "all", ledgerChannel: "all",
  q: null, source: null, sort: "revenue", dir: "desc",
};

describe("LEDGER_URL_PARSERS", () => {
  it("names exactly the ledger's params with their defaults", () => {
    expect(Object.keys(LEDGER_URL_PARSERS).sort()).toEqual(
      ["dir", "from", "ledgerChannel", "ledgerKind", "q", "range", "sort", "source", "to"],
    );
    expect(LEDGER_URL_PARSERS.range.defaultValue).toBe("last30");
    expect(LEDGER_URL_PARSERS.sort.defaultValue).toBe("revenue");
    expect(LEDGER_URL_PARSERS.dir.defaultValue).toBe("desc");
    expect(LEDGER_URL_PARSERS.ledgerKind.defaultValue).toBe("all");
  });

  it("is a subset of the lab's parsers, so a lab URL is a valid page URL", () => {
    for (const key of Object.keys(LEDGER_URL_PARSERS) as Array<keyof typeof LEDGER_URL_PARSERS>) {
      expect(LAB_URL_PARSERS[key]).toBe(LEDGER_URL_PARSERS[key]);
    }
  });
});

describe("ledgerStateHelpers", () => {
  it("opens and closes the source sheet and clears only ledger filters", () => {
    const setState = vi.fn();
    const helpers = ledgerStateHelpers(state, setState);
    helpers.openSource("camp-1");
    expect(setState).toHaveBeenLastCalledWith({ source: "camp-1" });
    helpers.closeSource();
    expect(setState).toHaveBeenLastCalledWith({ source: null });
    helpers.clearLedgerFilters();
    expect(setState).toHaveBeenLastCalledWith({ source: null, q: null, ledgerKind: "all", ledgerChannel: "all" });
  });

  it("toggles sort like the table header", () => {
    const setState = vi.fn();
    ledgerStateHelpers(state, setState).toggleSort("open");
    expect(setState).toHaveBeenLastCalledWith({ sort: "open", dir: "desc" });
    ledgerStateHelpers({ ...state, sort: "open" }, setState).toggleSort("open");
    expect(setState).toHaveBeenLastCalledWith({ sort: "open", dir: "asc" });
  });
});
```

Run: `npm run test -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-url-state.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `ledger-url-state.ts`**

```ts
import { parseAsString, parseAsStringLiteral } from "nuqs";
import {
  LAB_RANGES,
  LEDGER_CHANNEL_FILTERS,
  LEDGER_KIND_FILTERS,
  type LabRange,
  type LedgerChannelFilter,
  type LedgerKindFilter,
} from "../copy";
import {
  DEFAULT_LEDGER_SORT,
  LEDGER_SORT_COLUMNS,
  LEDGER_SORT_DIRECTIONS,
  nextLedgerSort,
  type LedgerSortColumn,
  type LedgerSortDirection,
} from "./ledger-sort";

/**
 * The ledger's URL params, shared by the lab (which adds its own) and the
 * standalone campaigns page, so a ledger URL means the same thing on both.
 * `source` selects the detail sheet on the ledger; the lab's orders view
 * reuses it as a filter.
 */
export const LEDGER_URL_PARSERS = {
  range: parseAsStringLiteral(LAB_RANGES).withDefault("last30"),
  from: parseAsString,
  to: parseAsString,
  ledgerKind: parseAsStringLiteral(LEDGER_KIND_FILTERS).withDefault("all"),
  ledgerChannel: parseAsStringLiteral(LEDGER_CHANNEL_FILTERS).withDefault("all"),
  q: parseAsString,
  source: parseAsString,
  sort: parseAsStringLiteral(LEDGER_SORT_COLUMNS).withDefault(DEFAULT_LEDGER_SORT.column),
  dir: parseAsStringLiteral(LEDGER_SORT_DIRECTIONS).withDefault(DEFAULT_LEDGER_SORT.direction),
};

export type LedgerUrlState = {
  range: LabRange;
  from: string | null;
  to: string | null;
  ledgerKind: LedgerKindFilter;
  ledgerChannel: LedgerChannelFilter;
  q: string | null;
  source: string | null;
  sort: LedgerSortColumn;
  dir: LedgerSortDirection;
};

export type LedgerUrlPatch = Partial<{
  [K in keyof LedgerUrlState]: LedgerUrlState[K] | null;
}>;

/** The ledger's state transitions, identical on the lab and the page. */
export function ledgerStateHelpers(
  state: LedgerUrlState,
  setState: (patch: LedgerUrlPatch) => unknown,
) {
  return {
    openSource: (objectId: string) => void setState({ source: objectId }),
    closeSource: () => void setState({ source: null }),
    toggleSort: (column: LedgerSortColumn) => {
      const next = nextLedgerSort({ column: state.sort, direction: state.dir }, column);
      void setState({ sort: next.column, dir: next.direction });
    },
    clearLedgerFilters: () =>
      void setState({ source: null, q: null, ledgerKind: "all", ledgerChannel: "all" }),
  };
}
```

- [ ] **Step 3: Make the lab hook spread the shared parsers**

In `use-klaviyo-lab-state.ts`: import `LEDGER_URL_PARSERS, ledgerStateHelpers` from `./ledger/ledger-url-state`; delete the local `range`, `from`, `to`, `ledgerKind`, `ledgerChannel`, `q`, `source`, `sort`, `dir` parsers and the now-unused imports (`LAB_RANGES`, `LEDGER_CHANNEL_FILTERS`, `LEDGER_KIND_FILTERS`, `DEFAULT_LEDGER_SORT`, `LEDGER_SORT_COLUMNS`, `LEDGER_SORT_DIRECTIONS`, `nextLedgerSort` — keep `LedgerSortColumn` if still referenced, otherwise drop it); export the map:

```ts
export const LAB_URL_PARSERS = {
  ...LEDGER_URL_PARSERS,
  view: parseAsStringLiteral(LAB_VIEWS).withDefault("ledger"),
  orderStatus: parseAsStringLiteral(ORDER_STATUS_FILTERS).withDefault("all"),
  productStatus: parseAsStringLiteral(PRODUCT_STATUS_FILTERS).withDefault("all"),
  claimType: parseAsStringLiteral(CLAIM_TYPE_FILTERS).withDefault("all"),
  channel: parseAsStringLiteral(CHANNEL_FILTERS).withDefault("all"),
  bucket: parseAsStringLiteral(["all", ...BUCKET_ORDER] as readonly string[]).withDefault("all"),
  order: parseAsString,
  candidate: parseAsString,
  detail: parseAsStringLiteral(DETAIL_TABS).withDefault("explanation"),
  lookback: parseAsInteger,
};
```

and in `useKlaviyoLabState` use `useQueryStates(LAB_URL_PARSERS, { history: "replace" })`. Replace the local `openSource`, `closeSource`, `toggleSort` with `const ledger = ledgerStateHelpers(state, setState);` and return `openSource: ledger.openSource, closeSource: ledger.closeSource, toggleSort: ledger.toggleSort`. `clearFilters` keeps clearing the orders filters AND calls the ledger clear in one `setState` — keep its current single-patch body (it already lists the ledger keys); do not call `ledger.clearLedgerFilters()` separately (two URL writes). `viewOrdersForSource` and `setView` are unchanged.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npm run test -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-url-state.test.ts src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.test.ts && npm run test:components && npx tsc --noEmit && npx eslint src/components/blocks/attribution/klaviyo`
Expected: PASS, clean.

```bash
git add src/components/blocks/attribution/klaviyo/ledger/ledger-url-state.ts src/components/blocks/attribution/klaviyo/ledger/ledger-url-state.test.ts src/components/blocks/attribution/klaviyo/use-klaviyo-lab-state.ts
git commit -m "refactor(klaviyo): share the ledger URL parsers between lab and page"
```

---

### Task 3: Prop-driven ledger units, consumed by the lab

**Files:**
- Create: `src/components/blocks/attribution/klaviyo/ledger/ledger-filters.tsx`, `ledger-section.tsx`
- Modify: `ledger/ledger-table.tsx:50-95` (props + Refresh block), `ledger/ledger-detail-sheet.tsx` (whole component), `../filter-bar.tsx` (range controls + ledger controls), `../klaviyo-playground.tsx:687-744` (`LedgerView`) and `:554` (sheet mount)
- Test: `ledger/ledger-table.component.test.tsx` (member hint case), `ledger/ledger-detail-sheet` behaviour is covered through the page test in Task 4; existing `evidence-views`/`ledger-*` component tests must stay green

**Interfaces:**
- Consumes: Task 2 `LedgerUrlState`, `LedgerUrlPatch`.
- Produces:

```ts
// ledger-filters.tsx
export function LabRangeControls(props: { state: Pick<LedgerUrlState, "range">; setState: (patch: LedgerUrlPatch) => unknown; range: { dateFrom: string; dateTo: string }; today: string; timezoneLabel: string }): JSX.Element;
export function LedgerFilters(props: { state: Pick<LedgerUrlState, "ledgerKind" | "ledgerChannel" | "q">; setState: (patch: LedgerUrlPatch) => unknown }): JSX.Element;
// ledger-section.tsx
export function LedgerSection(props: { range: { dateFrom: string; dateTo: string }; accountTimezone: string; state: Pick<LedgerUrlState, "ledgerKind" | "ledgerChannel" | "q" | "sort" | "dir">; onToggleSort: (column: LedgerSortColumn) => void; onOpenSource: (objectId: string) => void; onClearFilters: () => void; busy: boolean; onRefresh?: () => void; refreshHint?: string }): JSX.Element;
// ledger-table.tsx — `onRefresh` becomes optional and `refreshHint?: string` is added
// ledger-detail-sheet.tsx
export function LedgerDetailSheet(props: { objectId: string | null; range: { dateFrom: string; dateTo: string } | null; onClose: () => void; onViewOrders?: (objectId: string, sentDay: string | null) => void }): JSX.Element | null;
```

- [ ] **Step 1: Failing table test for the member hint**

Append to `ledger/ledger-table.component.test.tsx` inside `describe("LedgerTable")`:

```tsx
  it("shows a hint instead of the Refresh button when the viewer cannot refresh", () => {
    renderTable({
      data: { rows: [row({ klaviyo: null })], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false } },
      onRefresh: undefined,
      refreshHint: "Ask an admin to refresh the report.",
    });
    expect(screen.queryByRole("button", { name: "Refresh report" })).toBeNull();
    expect(screen.getByText("Ask an admin to refresh the report.")).toBeVisible();
  });
```

(`renderTable` spreads overrides after the defaults, so `onRefresh: undefined` removes it.) Run: `npm run test:components -- --run src/components/blocks/attribution/klaviyo/ledger/ledger-table.component.test.tsx` → FAIL (type error / button still rendered).

- [ ] **Step 2: Table props**

In `ledger-table.tsx` change `onRefresh: () => void;` to `onRefresh?: () => void;` and add `refreshHint?: string;`. Replace the Refresh `<Button>` block with:

```tsx
        {props.onRefresh ? (
          <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onRefresh}>
            {copy.refresh}
          </Button>
        ) : props.refreshHint && noReport ? (
          <span className="text-xs text-muted-foreground">{props.refreshHint}</span>
        ) : null}
```

- [ ] **Step 3: Filters**

Create `ledger/ledger-filters.tsx` by moving code out of `../filter-bar.tsx`: the `dayToLocalDate` helper, the range `<Select>` with its Custom seeding, the `DateRangePicker` block, the caption `<span>`, and the ledger kind/channel/search controls. Shape:

```tsx
"use client";

import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateOnly } from "@/lib/date";
import { isDay } from "@/lib/day";
import { LAB_RANGES, type LedgerChannelFilter, type LedgerKindFilter } from "../copy";
import { LedgerSearch } from "./ledger-search";
import type { LedgerUrlPatch, LedgerUrlState } from "./ledger-url-state";

/** (dayToLocalDate — moved verbatim, with its doc comment) */

/**
 * Range preset + calendar + caption. Shared by every lab view and the
 * campaigns page; `today` is the active timezone's calendar day.
 */
export function LabRangeControls(props: {
  state: Pick<LedgerUrlState, "range">;
  setState: (patch: LedgerUrlPatch) => unknown;
  range: { dateFrom: string; dateTo: string };
  today: string;
  timezoneLabel: string;
}) {
  const { state, setState } = props;
  return (
    <>
      {/* the range <Select> exactly as it is in filter-bar.tsx today */}
      {state.range === "custom" ? (
        /* the DateRangePicker block exactly as it is today */
      ) : null}
      <span className="text-xs text-muted-foreground">
        {props.range.dateFrom} → {props.range.dateTo} · {props.timezoneLabel}
      </span>
    </>
  );
}

/** Kind, channel, and search — the ledger's own filters. */
export function LedgerFilters(props: {
  state: Pick<LedgerUrlState, "ledgerKind" | "ledgerChannel" | "q">;
  setState: (patch: LedgerUrlPatch) => unknown;
}) {
  const { state, setState } = props;
  return (
    <>
      {/* the Kind <Select>, Channel <Select>, and <LedgerSearch> exactly as they are today */}
    </>
  );
}
```

Then `../filter-bar.tsx` renders `<LabRangeControls state={state} setState={setState} range={props.range} today={props.today} timezoneLabel={timezoneLabel} />` where the select/picker/caption were, and `{props.view === "ledger" ? <LedgerFilters state={state} setState={setState} /> : null}` where the ledger controls were; drop the imports that moved. The lab's `setState` from nuqs accepts a superset patch, so it satisfies `(patch: LedgerUrlPatch) => unknown`.

- [ ] **Step 4: Section**

Create `ledger/ledger-section.tsx` from the playground's `LedgerView` body:

```tsx
"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc/client";
import { LedgerMessageRows } from "./ledger-message-rows";
import type { LedgerSortColumn } from "./ledger-sort";
import { LedgerTable } from "./ledger-table";
import type { LedgerUrlState } from "./ledger-url-state";

/**
 * The ledger list query, expansion state, table, and lazily mounted message
 * rows — everything between the filters and the sheet. The lab's Campaigns
 * tab and the campaigns page both render this; only the URL state and the
 * admin affordances differ, and those arrive as props.
 */
export function LedgerSection(props: {
  range: { dateFrom: string; dateTo: string };
  accountTimezone: string;
  state: Pick<LedgerUrlState, "ledgerKind" | "ledgerChannel" | "q" | "sort" | "dir">;
  onToggleSort: (column: LedgerSortColumn) => void;
  onOpenSource: (objectId: string) => void;
  onClearFilters: () => void;
  busy: boolean;
  onRefresh?: () => void;
  refreshHint?: string;
}) {
  const trpc = useTRPC();
  const { state } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const search = state.q?.trim() ?? "";
  const list = useQuery({
    ...trpc.klaviyo.ledger.list.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
      kind: state.ledgerKind === "all" ? undefined : state.ledgerKind,
      channel: state.ledgerChannel === "all" ? undefined : state.ledgerChannel,
      search: search === "" ? undefined : search,
    }),
    // Typing in the search box or flipping a filter re-keys the query; without
    // this the table blanks to its empty state between keystrokes.
    placeholderData: keepPreviousData,
  });
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
      onToggleSort={props.onToggleSort}
      expanded={expanded}
      onToggleExpand={(objectId) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(objectId)) next.add(objectId);
          return next;
        })
      }
      renderMessageRows={(row) => <LedgerMessageRows parent={row} range={props.range} sort={sort} />}
      onOpenSource={props.onOpenSource}
      onRefresh={props.onRefresh}
      refreshHint={props.refreshHint}
      onRetry={() => void list.refetch()}
      onClearFilters={props.onClearFilters}
    />
  );
}
```

In `klaviyo-playground.tsx`, replace `LedgerView`'s body with an adapter:

```tsx
function LedgerView(props: {
  range: { dateFrom: string; dateTo: string };
  lab: ReturnType<typeof useKlaviyoLabState>;
  accountTimezone: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <LedgerSection
      range={props.range}
      accountTimezone={props.accountTimezone}
      state={props.lab.state}
      onToggleSort={props.lab.toggleSort}
      onOpenSource={props.lab.openSource}
      onClearFilters={props.lab.clearFilters}
      busy={props.busy}
      onRefresh={props.onRefresh}
    />
  );
}
```

and drop the now-unused imports (`keepPreviousData`, `LedgerMessageRows`, `LedgerTable`; keep `useState`/`useQuery` if other code uses them).

- [ ] **Step 5: Sheet by props**

Rewrite `ledger/ledger-detail-sheet.tsx`'s signature and wiring (body markup unchanged):

```tsx
/**
 * The detail sheet for one campaign or flow. Callers own the `source` URL
 * param and pass the selected id; `onViewOrders` is optional because only
 * privileged viewers can reach the orders view it links to.
 */
export function LedgerDetailSheet({
  objectId,
  range,
  onClose,
  onViewOrders,
}: {
  objectId: string | null;
  range: { dateFrom: string; dateTo: string } | null;
  onClose: () => void;
  onViewOrders?: (objectId: string, sentDay: string | null) => void;
}) {
  const trpc = useTRPC();
  const detail = useQuery({ /* unchanged, keyed on objectId/range */ });
  if (objectId === null) return null;
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      ...
            <LedgerDetailContent
              detail={detail.data}
              onViewOrders={
                onViewOrders
                  ? () =>
                      onViewOrders(
                        detail.data.object.objectId,
                        // A campaign's orders run past the ledger window; the send
                        // day is only a range START, so the UTC day is enough.
                        detail.data.object.objectType === "campaign" && detail.data.object.sentAt
                          ? new Date(detail.data.object.sentAt).toISOString().slice(0, 10)
                          : null,
                      )
                  : undefined
              }
            />
      ...
```

`LedgerDetailContent`'s `onViewOrders` prop becomes optional (`onViewOrders?: () => void`) and the "View orders in Orders →" button renders only when it is provided. Update `ledger-detail-content.component.test.tsx`: the existing click test keeps passing a callback; add one assertion in the member-style case (the "dashes" test) by rendering without `onViewOrders` and asserting `screen.queryByRole("button", { name: "View orders in Orders →" })` is null.

In the playground, mount becomes:

```tsx
      <LedgerDetailSheet
        objectId={lab.state.view === "ledger" ? lab.state.source : null}
        range={range}
        onClose={lab.closeSource}
        onViewOrders={lab.viewOrdersForSource}
      />
```

- [ ] **Step 6: Verify and commit**

Run: `npm run test:components && npx tsc --noEmit && npx eslint src/components/blocks/attribution/klaviyo`
Expected: PASS (the table test count grows by one, the content test by one assertion), clean.

```bash
git add src/components/blocks/attribution/klaviyo
git commit -m "refactor(klaviyo): drive the ledger filters, table, and sheet by props"
```

---

### Task 4: The `/klaviyo` page

**Files:**
- Create: `src/components/blocks/klaviyo/campaigns-page.copy.ts`, `use-ledger-page-state.ts`, `klaviyo-campaigns-page.tsx`, `klaviyo-campaigns-page.component.test.tsx`
- Create: `src/app/(protected)/klaviyo/page.tsx`
- Modify: `src/components/app-sidebar.tsx:63-82`, `src/lib/organization-access.ts:22-28`, `src/lib/organization-access.test.ts:43-51`

**Interfaces:**
- Consumes: Task 1 `trpc.klaviyo.ledgerContext`; Task 2 `LEDGER_URL_PARSERS`, `ledgerStateHelpers`; Task 3 `LabRangeControls`, `LedgerFilters`, `LedgerSection`, `LedgerDetailSheet`; `resolveLabDayRange` from the lab hook module; `useActiveOrganizationRole`, `isPrivilegedOrgRole`; `LEDGER_REFRESH_KINDS` from the lab copy.

- [ ] **Step 1: Copy**

`campaigns-page.copy.ts`:

```ts
export const campaignsPage = {
  title: "Klaviyo campaigns",
  freshness: (publishedAgo: string) => `matches published ${publishedAgo}`,
  openLab: "Open lab",
  refresh: "Refresh report",
  refreshQueued: "Report refresh queued",
  refreshFresh: "Reports already fresh",
  refreshFailed: "Report refresh could not start",
  refreshHint: "Ask an admin to refresh the report.",
  timezoneLabel: (timezone: string) => `Send dates use ${timezone} account days`,
  emptyTitle: "No Klaviyo connection for this organization",
  emptyBody: "The Klaviyo pilot is bound to one store; ask an admin if you expected data here.",
  error: "Couldn’t load Klaviyo.",
  retry: "Retry",
} as const;
```

- [ ] **Step 2: Page state hook**

`use-ledger-page-state.ts`:

```ts
"use client";

import { useQueryStates } from "nuqs";
import {
  LEDGER_URL_PARSERS,
  ledgerStateHelpers,
} from "@/components/blocks/attribution/klaviyo/ledger/ledger-url-state";

/** The campaigns page's URL state: the ledger's params and nothing else. */
export function useLedgerPageState() {
  const [state, setState] = useQueryStates(LEDGER_URL_PARSERS, { history: "replace" });
  return { state, setState, ...ledgerStateHelpers(state, setState) };
}
```

- [ ] **Step 3: Failing page component test**

`klaviyo-campaigns-page.component.test.tsx` (mock pattern from `email-revenue-panel.component.test.tsx`; nuqs needs its test adapter — check `grep -rn "nuqs/adapters" src --include='*.test.tsx'` and wrap with the same adapter other page tests use; if none exists, wrap the render in `NuqsTestingAdapter` from `nuqs/adapters/testing`):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KlaviyoCampaignsPage } from "./klaviyo-campaigns-page";

const queryState = vi.hoisted(() => ({
  contextFn: (): Promise<unknown> => Promise.resolve(null),
  listFn: (): Promise<unknown> => Promise.resolve({ rows: [], report: { asOf: null, hasCampaignGeneration: false, hasFlowGeneration: false } }),
  detailFn: (): Promise<unknown> => Promise.resolve(null),
  role: "member" as "member" | "admin" | "owner",
}));

vi.mock("@/lib/trpc/client", () => ({
  useTRPC: () => ({
    klaviyo: {
      ledgerContext: { queryOptions: () => ({ queryKey: ["ctx"], queryFn: queryState.contextFn, retry: false }) },
      ledger: {
        list: { queryOptions: (input: unknown) => ({ queryKey: ["list", input], queryFn: queryState.listFn, retry: false }) },
        messages: { queryOptions: (input: unknown) => ({ queryKey: ["messages", input], queryFn: () => Promise.resolve([]), retry: false }) },
        detail: { queryOptions: (input: unknown) => ({ queryKey: ["detail", input], queryFn: queryState.detailFn, retry: false }) },
      },
      refreshReports: { mutationOptions: (options: unknown) => ({ mutationFn: () => Promise.resolve({ kind: "fresh" }), ...(options as object) }) },
    },
  }),
}));
vi.mock("@/hooks/use-active-organization-role", () => ({
  useActiveOrganizationRole: () => ({ role: queryState.role, isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const configured = {
  configured: true, accountName: "Reviv", accountTimezone: "Asia/Bangkok",
  todayInAccountTz: "2026-09-10", lastMatchPublishedAt: "2026-09-10T01:00:00.000Z",
};

function renderPage(search = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NuqsTestingAdapter searchParams={search}>
      <QueryClientProvider client={client}>
        <KlaviyoCampaignsPage />
      </QueryClientProvider>
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  queryState.role = "member";
  queryState.contextFn = () => Promise.resolve(configured);
});

describe("KlaviyoCampaignsPage", () => {
  it("shows the empty state for an org without the pilot and issues no ledger query", async () => {
    queryState.contextFn = () => Promise.resolve({ ...configured, configured: false, accountName: null });
    const list = vi.fn(queryState.listFn);
    queryState.listFn = list;
    renderPage();
    expect(await screen.findByText("No Klaviyo connection for this organization")).toBeVisible();
    expect(screen.getByText(/bound to one store/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("gives admins the refresh button and the lab link", async () => {
    queryState.role = "admin";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Klaviyo campaigns" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open lab" })).toHaveAttribute("href", "/attribution/klaviyo");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh report" })).toBeVisible());
    expect(screen.getByText(/matches published/)).toBeVisible();
  });

  it("gives members a read-only page with the refresh hint and still opens the sheet", async () => {
    queryState.detailFn = () =>
      Promise.resolve({
        object: { objectId: "camp-1", objectType: "campaign", name: "July Sale", channel: "email", status: "sent", sentAt: "2026-07-10T09:00:00.000Z", subject: null, messageCount: 1 },
        klaviyo: null, rates: { delivered: null, open: null, click: null, unsubscribe: null },
        ours: { orderCount: 2, revenue: "97.50" },
        reconciliation: { unconfirmedOrders: null, revenuePerRecipient: null, averageOrderValue: "48.75" },
        ordersByDay: { mode: "offset", points: [] }, topProducts: [], messages: [],
      });
    renderPage("?source=camp-1");
    expect(await screen.findByRole("heading", { name: "Klaviyo campaigns" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open lab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh report" })).toBeNull();
    await waitFor(() => expect(screen.getByText("Ask an admin to refresh the report.")).toBeVisible());
    expect(await screen.findByRole("heading", { name: "July Sale" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "View orders in Orders →" })).toBeNull();
  });
});
```

Run: `npm run test:components -- --run src/components/blocks/klaviyo/klaviyo-campaigns-page.component.test.tsx` → FAIL (module missing).

- [ ] **Step 4: Page component**

`klaviyo-campaigns-page.tsx`:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LabRangeControls, LedgerFilters } from "@/components/blocks/attribution/klaviyo/ledger/ledger-filters";
import { LedgerDetailSheet } from "@/components/blocks/attribution/klaviyo/ledger/ledger-detail-sheet";
import { LedgerSection } from "@/components/blocks/attribution/klaviyo/ledger/ledger-section";
import { LEDGER_REFRESH_KINDS } from "@/components/blocks/attribution/klaviyo/copy";
import { resolveLabDayRange } from "@/components/blocks/attribution/klaviyo/use-klaviyo-lab-state";
import { LabPanelState } from "@/components/blocks/attribution/klaviyo/panel-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CloudDownload } from "@/components/icons";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { useTRPC } from "@/lib/trpc/client";
import { campaignsPage as copy } from "./campaigns-page.copy";
import { useLedgerPageState } from "./use-ledger-page-state";

const LAB_HREF = "/attribution/klaviyo";

/**
 * The front-and-center Klaviyo page: the campaign ledger for every org role.
 * Admin affordances (refresh, lab link, orders link) render only for
 * privileged roles; the data procedures themselves are org-readable and
 * aggregate-only, so hiding the controls is UX, not the security boundary.
 */
export function KlaviyoCampaignsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const page = useLedgerPageState();
  const { role } = useActiveOrganizationRole();
  const privileged = isPrivilegedOrgRole(role);

  const context = useQuery({ ...trpc.klaviyo.ledgerContext.queryOptions(), retry: false });
  const refresh = useMutation(
    trpc.klaviyo.refreshReports.mutationOptions({
      onSuccess: (result) => {
        toast.success(result.kind === "fresh" ? copy.refreshFresh : copy.refreshQueued);
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(getUserFacingErrorMessage(error, copy.refreshFailed)),
    }),
  );

  if (context.isError) {
    return (
      <div className="p-6">
        <LabPanelState kind="error" title={copy.error} body="" onRetry={() => void context.refetch()} />
      </div>
    );
  }
  if (!context.data) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!context.data.configured) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">{copy.title}</h1>
        <div className="mt-6 flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border py-20">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
            <CloudDownload className="size-5 text-muted-foreground/40" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{copy.emptyTitle}</p>
            <p className="text-[13px] text-muted-foreground/40">{copy.emptyBody}</p>
          </div>
        </div>
      </div>
    );
  }

  const { accountTimezone, todayInAccountTz: today } = context.data;
  const range = resolveLabDayRange({
    view: "ledger",
    range: page.state.range,
    from: page.state.from,
    to: page.state.to,
    storeToday: today,
    accountToday: today,
  });
  const publishedAt = context.data.lastMatchPublishedAt;

  const viewOrders = (objectId: string, sentDay: string | null) => {
    const params = new URLSearchParams({ view: "orders", source: objectId });
    if (sentDay) {
      params.set("range", "custom");
      params.set("from", sentDay);
    } else {
      params.set("range", "custom");
      params.set("from", range.dateFrom);
      params.set("to", range.dateTo);
    }
    router.push(`${LAB_HREF}?${params.toString()}`);
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">
            {context.data.accountName ?? "Klaviyo"}
            {publishedAt ? ` · ${copy.freshness(formatDistanceToNow(new Date(publishedAt), { addSuffix: true }))}` : ""}
          </p>
        </div>
        {privileged ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link href={LAB_HREF}>{copy.openLab}</Link>
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <LabRangeControls
          state={page.state}
          setState={page.setState}
          range={range}
          today={today}
          timezoneLabel={copy.timezoneLabel(accountTimezone)}
        />
        <LedgerFilters state={page.state} setState={page.setState} />
      </div>
      <LedgerSection
        range={range}
        accountTimezone={accountTimezone}
        state={page.state}
        onToggleSort={page.toggleSort}
        onOpenSource={page.openSource}
        onClearFilters={page.clearLedgerFilters}
        busy={refresh.isPending}
        onRefresh={
          privileged
            ? () => refresh.mutate({ dateFrom: range.dateFrom, dateTo: range.dateTo, kinds: [...LEDGER_REFRESH_KINDS] })
            : undefined
        }
        refreshHint={privileged ? undefined : copy.refreshHint}
      />
      <LedgerDetailSheet
        objectId={page.state.source}
        range={range}
        onClose={page.closeSource}
        onViewOrders={privileged ? viewOrders : undefined}
      />
    </div>
  );
}
```

Route `src/app/(protected)/klaviyo/page.tsx`:

```tsx
import { KlaviyoCampaignsPage } from "@/components/blocks/klaviyo/klaviyo-campaigns-page";

export default function KlaviyoPage() {
  return <KlaviyoCampaignsPage />;
}
```

- [ ] **Step 5: Navigation and member access**

`src/components/app-sidebar.tsx` `dashboardChildren`: replace the privileged Klaviyo entry with `{ label: "Klaviyo", href: "/klaviyo", icon: "solar:letter-linear" }` placed directly after Meta (Google keeps its privileged flag). Update the comment above the array: the labs are privileged; Klaviyo campaigns is not.

`src/lib/organization-access.ts` `MEMBER_PATH_PREFIXES`: add `"/klaviyo"` after `"/meta"`. In `organization-access.test.ts`, add `"/klaviyo"` to the member-reachable list, and assert `canAccessMemberPath("member", "/attribution/klaviyo")` stays `false` in the privileged test if it is not already there.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:components && npm run test -- --run src/lib/organization-access.test.ts && npx tsc --noEmit && npx eslint src/components/blocks/klaviyo src/components/app-sidebar.tsx src/lib/organization-access.ts "src/app/(protected)/klaviyo/page.tsx"`
Expected: PASS, clean. Then run `bun dev`, open `/klaviyo` as an admin and as a member of the Reviv org (or note in the report that only one role was checked) and confirm: the sidebar shows Klaviyo under Dashboard after Meta with no privileged Klaviyo entry, the ledger renders, the sheet opens, and "Open lab" leads to the lab.

```bash
git add src/components/blocks/klaviyo "src/app/(protected)/klaviyo" src/components/app-sidebar.tsx src/lib/organization-access.ts src/lib/organization-access.test.ts
git commit -m "feat(klaviyo): put the campaign ledger on its own page for every role"
```

---

### Task 5: Full verification and PR body

**Files:**
- Create: `rands/pr-body-klaviyo-campaigns-page.md` (git-ignored; never staged)

- [ ] **Step 1: Battery**

```bash
export DATABASE_URL="$(grep -m1 '^DATABASE_URL' .env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')"
npm run test 2>&1 | tail -5
npm run test:components 2>&1 | tail -3
npx tsc --noEmit && echo TSC-CLEAN
npm run lint 2>&1 | tail -3
```

Expected: all green (the `shopify-store.integration.test.ts` orphan test is a known flake; re-run alone if it is the only failure). Report the exact counts.

- [ ] **Step 2: PR body**

Write `rands/pr-body-klaviyo-campaigns-page.md` following `rands/pr-body-klaviyo-campaign-ledger.md`: summary; what changed (API/roles, shared ledger units, page, navigation); the decisions table from spec §1; verification counts; rollout ("no schema or job changes; the lab leaves the sidebar and `/klaviyo` appears for everyone on deploy"); follow-ups (self-serve connect; `ledgerContext` drops `lastReportSyncedAt` from the spec's list as unused).

- [ ] **Step 3: Report**

Reply with commit list, counts, and the PR body path. Do not push; the controller pushes after the final review.

