# Shopify Evidence Commit Trims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant DB round-trips from `commitShopifyEvidenceOrder`'s non-replay path (~22 → ~13 per order), with every lock and invariant unchanged.

**Architecture:** Three focused changes inside `src/lib/shopify-evidence-store.ts`:
- **Task 1:** a one-read key-policy check that falls back to today's ensure only when the policy rows are missing.
- **Task 2:** compare stored lines with the fetched set and rewrite only on a difference. The checksum is computed from the in-memory set, and the already-locked order row is reused.
- **Task 3:** skip an unchanged `shopify_customer_id` write, and switch the observation and identity link to insert-first.

Each change is proven by a Postgres integration test that spies on the SQL statements the commit issues.

**Tech Stack:** TypeScript, Drizzle ORM (node-postgres, `pg`), PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-shopify-evidence-commit-trims-design.md`

## Global Constraints

- One transaction per order, with the same locks in the same order: store lock → run lock → order lock. The cursor compare-and-set, the window check, `assertAvailableIdentityEvidence`, the suppression check, the identity HMAC select/compare/rewrite, the run progress update, and the whole replay branch (`if (replay) { … }`) are unchanged.
- No schema change and no migration.
- `parent_order_updated_at` is not compared and not refreshed when lines are skipped.
- Every validation that `replaceCompleteLineSetWithExecutor` performs on a complete line set (completeness, a valid `orderUpdatedAt`, an array of lines) still runs on every complete commit, including when the rewrite is skipped.
- Tests run with Vitest, never `bun test`. **In this agent environment, `bun run` and `.env` are blocked by the sandbox.** Run tests as `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run <file>`. `rands/.local-db-url` holds the local dev Postgres URL (the user provides it); the test file creates its own `adsolute_shopify_evidence_persistence_test` database from it. If that file is missing or the DB is unreachable, report BLOCKED. Do not skip the tests.
- Typecheck: `./node_modules/.bin/tsc --noEmit`. Lint: `./node_modules/.bin/eslint <files>`.
- Commit messages: a single conventional-commit title line, no body, no trailers. Never stage `.gitignore`.
- Branch `perf/evidence-commit-trims` (cut from `main`; the spec is already committed there). Do not push.

## File Map

- `src/lib/shopify-evidence-store.ts`, all in `commitShopifyEvidenceOrder`'s non-replay path and its helpers:
  - `validateIdentityCryptoPolicyInOneRead` (new), `validateExistingIdentityCryptoPolicyWithExecutor` (rewritten onto it);
  - `assertCompleteLineSet`, `loadStoredLineSet` and `sameLineSet` (new);
  - `resolveScopedOrder` (one more column), `persistAvailableIdentityWithExecutor` (optional current customer id).
- `src/lib/shopify-evidence.integration.test.ts`: a statement-spy helper, a two-run helper, and new tests.

Line numbers below are approximate ("near line N"); find code by its quoted text.

---

### Task 1: Key-policy check in one read

**Files:**
- Modify: `src/lib/shopify-evidence-store.ts`, near lines 542–637 (`ensureIdentityCryptoPolicyWithExecutor`, `validateExistingIdentityCryptoPolicyWithExecutor`) and near line 1376 (the non-replay `ensureIdentityCryptoPolicyWithExecutor` call in `commitShopifyEvidenceOrder`).
- Test: `src/lib/shopify-evidence.integration.test.ts`

**Interfaces:**
- Produces, in the test file, for Tasks 2–3:
  - `statementsDuring<T>(work: () => Promise<T>): Promise<{ result: T; statements: string[] }>`
  - `commitOrderA(runId: string, overrides?: Partial<Parameters<typeof commitShopifyEvidenceOrder>[0]>)`
  - `twoRunsOfOrderA(secondOverrides?: Partial<Parameters<typeof commitShopifyEvidenceOrder>[0]>): Promise<{ first: Awaited<ReturnType<typeof commitShopifyEvidenceOrder>>; second: Awaited<ReturnType<typeof commitShopifyEvidenceOrder>>; secondStatements: string[] }>`
  - `ORDER_A_PROGRESS`
- Produces, in the store: `validateIdentityCryptoPolicyInOneRead(scope, keyChecks, executor): Promise<"valid" | "missing">` (not exported).

- [ ] **Step 1: Add the test helpers**

In `src/lib/shopify-evidence.integration.test.ts`:
- Change the first line `import { Pool } from "pg";` (or the existing `pg` import) so it also imports `Client`, e.g. `import { Client, Pool } from "pg";`.
- Add `canonicalContentChecksum` to the destructured `await import("@/lib/shopify-evidence-store")` list (near line 44).

Then add these helpers directly after `async function startRun(...) { ... }` (near line 284):

```ts
// Every statement Drizzle sends goes through pg's Client#query (pool queries
// and transaction clients alike), so spying on it shows exactly what a commit
// asked the database to do.
async function statementsDuring<T>(
  work: () => Promise<T>,
): Promise<{ result: T; statements: string[] }> {
  const spy = vi.spyOn(Client.prototype, "query");
  try {
    const result = await work();
    const statements = spy.mock.calls.map(([query]) =>
      typeof query === "string"
        ? query
        : String((query as { text?: unknown } | undefined)?.text ?? ""),
    );
    return { result, statements };
  } finally {
    spy.mockRestore();
  }
}

const ORDER_A_PROGRESS = {
  counts: { ...ZERO_COUNTS, ordersRead: 1, ordersEnriched: 1 },
  identityCapability: "available" as const,
  lineCompleteness: "complete" as const,
};

function commitOrderA(
  runId: string,
  overrides: Partial<Parameters<typeof commitShopifyEvidenceOrder>[0]> = {},
) {
  return commitShopifyEvidenceOrder({
    scope,
    evidenceRunId: runId,
    orderId: "order_a",
    shopifyOrderId: "gid://shopify/Order/1",
    expectedCursor: null,
    nextCursor: FIRST_CURSOR,
    lines: firstCompleteSet,
    lineDisposition: "complete",
    identity: availableIdentity(),
    progress: ORDER_A_PROGRESS,
    now: new Date("2026-08-01T00:01:00.000Z"),
    ...overrides,
  });
}

// Commits order_a in a finished first run, then again in a fresh second run
// (a non-replay commit over already-stored evidence), recording the second
// commit's statements.
async function twoRunsOfOrderA(
  secondOverrides: Partial<Parameters<typeof commitShopifyEvidenceOrder>[0]> = {},
) {
  const firstRun = await startRun("trigger-first-of-two");
  const first = await commitOrderA(firstRun.id);
  await finishShopifyEvidenceRun({
    scope,
    runId: firstRun.id,
    expectedCursor: FIRST_CURSOR,
    status: "success",
    progress: ORDER_A_PROGRESS,
  });
  const secondRun = await startRun(
    "trigger-second-of-two",
    new Date("2026-08-02T00:00:00.000Z"),
  );
  const { result: second, statements: secondStatements } =
    await statementsDuring(() =>
      commitOrderA(secondRun.id, {
        now: new Date("2026-08-02T00:01:00.000Z"),
        ...secondOverrides,
      }),
    );
  return { first, second, secondStatements };
}
```

If `startRun` for the second run or `finishShopifyEvidenceRun` rejects in this setup, mirror the existing test `"selects only new or source-updated orders against a compatible baseline"` (near line 467), which finishes a run and plans a second against it. Adapt only the helper, never the production code, and say so in your report.

- [ ] **Step 2: Write the failing test and a regression guard**

Add inside `describeIfDb(...)`, after the test `"initializes one lifetime crypto binding safely under replay and races"` (near line 822):

```ts
  it("checks an existing key policy with one read and no writes", async () => {
    const { secondStatements } = await twoRunsOfOrderA();
    const policyStatements = secondStatements.filter((statement) =>
      /identity_crypto_policy|identity_matching_key_binding/i.test(statement),
    );
    expect(policyStatements).toHaveLength(1);
    expect(policyStatements[0]).toMatch(/^\s*select/i);
  });

  it("still rejects a commit whose stored key policy no longer matches", async () => {
    const firstRun = await startRun("trigger-policy-drift");
    await commitOrderA(firstRun.id);
    await finishShopifyEvidenceRun({
      scope,
      runId: firstRun.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: ORDER_A_PROGRESS,
    });
    await testPool!.query(
      `UPDATE identity_crypto_policy SET matching_current_version = 'v2'
       WHERE organization_id = 'org_a' AND store_id = 'store_a'`,
    );
    const secondRun = await startRun(
      "trigger-policy-drift-2",
      new Date("2026-08-02T00:00:00.000Z"),
    );
    await expect(
      commitOrderA(secondRun.id, { now: new Date("2026-08-02T00:01:00.000Z") }),
    ).rejects.toThrow("identity_crypto_policy_conflict");
  });
```

- [ ] **Step 3: Run them**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts -t "key policy"`

Expected:
- `"checks an existing key policy with one read and no writes"` FAILS: today's ensure issues ~5 policy statements, including inserts.
- `"still rejects …"` PASSES. It is a regression guard: today's ensure already rejects the drift.

- [ ] **Step 4: Implement the one-read check**

In `src/lib/shopify-evidence-store.ts`, replace the whole `validateExistingIdentityCryptoPolicyWithExecutor` function (near lines 592–637) with:

```ts
/**
 * Reads the store's matching key binding and crypto policy in one round-trip
 * and validates them against the supplied key checks. "missing" means a row
 * does not exist yet (a store's first identity write) so the caller may
 * create it; any mismatch throws identity_crypto_policy_conflict. Every
 * policy writer holds the store row lock, so under that lock this read
 * cannot observe a rotation half-applied.
 */
async function validateIdentityCryptoPolicyInOneRead(
  scope: IdentityScope,
  keyChecks: IdentityCryptoKeyChecks,
  executor: EvidenceExecutor,
): Promise<"valid" | "missing"> {
  const checks = validateIdentityCryptoKeyChecks(keyChecks);
  const [row] = await executor
    .select({
      bindingKeyCheck: identityMatchingKeyBindings.keyCheck,
      matchingPreviousVersion: identityCryptoPolicies.matchingPreviousVersion,
      matchingPreviousKeyCheck: identityCryptoPolicies.matchingPreviousKeyCheck,
      matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
      matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
      suppressionVersion: identityCryptoPolicies.suppressionVersion,
      suppressionKeyCheck: identityCryptoPolicies.suppressionKeyCheck,
    })
    .from(identityCryptoPolicies)
    .leftJoin(
      identityMatchingKeyBindings,
      and(
        eq(identityMatchingKeyBindings.organizationId, identityCryptoPolicies.organizationId),
        eq(identityMatchingKeyBindings.storeId, identityCryptoPolicies.storeId),
        eq(identityMatchingKeyBindings.keyVersion, checks.matchingVersion),
      ),
    )
    .where(
      and(
        eq(identityCryptoPolicies.organizationId, scope.organizationId),
        eq(identityCryptoPolicies.storeId, scope.storeId),
      ),
    )
    .limit(1);
  if (!row || row.bindingKeyCheck === null) return "missing";
  if (
    !constantTimeTextEqual(row.bindingKeyCheck, checks.matchingCheck) ||
    row.matchingPreviousVersion !== null ||
    row.matchingPreviousKeyCheck !== null ||
    row.matchingCurrentVersion !== checks.matchingVersion ||
    row.suppressionVersion !== checks.suppressionVersion ||
    !constantTimeTextEqual(row.matchingCurrentKeyCheck, checks.matchingCheck) ||
    !constantTimeTextEqual(row.suppressionKeyCheck, checks.suppressionCheck)
  ) {
    return cryptoPolicyConflict();
  }
  return "valid";
}

async function validateExistingIdentityCryptoPolicyWithExecutor(
  scope: IdentityScope,
  keyChecks: IdentityCryptoKeyChecks,
  executor: EvidenceExecutor,
): Promise<void> {
  if (
    (await validateIdentityCryptoPolicyInOneRead(scope, keyChecks, executor)) ===
    "missing"
  ) {
    cryptoPolicyConflict();
  }
}
```

In `commitShopifyEvidenceOrder`'s non-replay path, replace:

```ts
    if (input.identity.status === "available") {
      await ensureIdentityCryptoPolicyWithExecutor(
        input.scope,
        input.identity.keyChecks,
        tx,
      );
    }
```

with:

```ts
    // The batch ensured the policy before its first order; per order one
    // read re-validates it under the store lock, and only a store's first
    // identity write (rows missing) falls back to the full ensure.
    if (input.identity.status === "available") {
      const policy = await validateIdentityCryptoPolicyInOneRead(
        input.scope,
        input.identity.keyChecks,
        tx,
      );
      if (policy === "missing") {
        await ensureIdentityCryptoPolicyWithExecutor(
          input.scope,
          input.identity.keyChecks,
          tx,
        );
      }
    }
```

Semantics check before moving on:
- `ensureIdentityCryptoPolicyWithExecutor` still ends by calling `validateExistingIdentityCryptoPolicyWithExecutor`, which now does one joined read and treats "missing" as a conflict. That matches today's validate: a missing binding or policy was a conflict.
- In the commit, both rows present means today's validate rules apply; either row missing means today's exact ensure runs.

- [ ] **Step 5: Run the new tests, then the whole file**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts -t "key policy"`
Expected: PASS (2 tests).

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts`
Expected: all pass. In particular the crypto-binding tests near lines 822–870, which expect `identity_crypto_policy_conflict`, must still pass.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts`

```bash
git add src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts
git commit -m "perf(shopify): validate the evidence key policy in one read per order"
```

---

### Task 2: Rewrite lines only when they differ; reuse the locked order row

**Files:**
- Modify: `src/lib/shopify-evidence-store.ts`, near lines 687–725 (`replaceCompleteLineSetWithExecutor`), near line 1089 (`loadMatcherVisibleLines`), and in `commitShopifyEvidenceOrder`'s non-replay path near lines 1383–1426.
- Test: `src/lib/shopify-evidence.integration.test.ts`

**Interfaces:**
- Consumes, from Task 1 (test file): `twoRunsOfOrderA`, `statementsDuring`, `firstCompleteSet`.
- Produces, in the store (not exported):
  - `assertCompleteLineSet(evidence: CompleteShopifyLineSet): void`
  - `loadStoredLineSet(executor, scope, orderId)`
  - `sameLineSet(stored, fetched: NormalizedShopifyOrderLine[]): boolean`

- [ ] **Step 1: Write the failing tests**

Add inside `describeIfDb(...)`, after the test `"replaces complete lines, clears with complete empty, and rolls back invalid insertion"` (near line 802):

```ts
  it("leaves identical stored lines untouched on a later run", async () => {
    const readLines = () =>
      testPool!.query(
        `SELECT id, xmin::text AS version FROM shopify_order_line
         WHERE order_id = 'order_a' ORDER BY id`,
      );
    const runFirstOnly = await startRun("trigger-lines-probe");
    await commitOrderA(runFirstOnly.id);
    const before = (await readLines()).rows;
    await finishShopifyEvidenceRun({
      scope,
      runId: runFirstOnly.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: ORDER_A_PROGRESS,
    });
    const secondRun = await startRun(
      "trigger-lines-probe-2",
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const { result: second, statements } = await statementsDuring(() =>
      commitOrderA(secondRun.id, { now: new Date("2026-08-02T00:01:00.000Z") }),
    );

    expect((await readLines()).rows).toEqual(before);
    expect(statements.some((s) => /delete from "?shopify_order_line/i.test(s))).toBe(false);
    expect(statements.some((s) => /insert into "?shopify_order_line/i.test(s))).toBe(false);
    const stored = await testPool!.query(
      `SELECT shopify_line_item_id AS "shopifyLineItemId",
              shopify_product_id AS "shopifyProductId",
              shopify_variant_id AS "shopifyVariantId", sku, quantity
       FROM shopify_order_line WHERE order_id = 'order_a'`,
    );
    const order = await testPool!.query(
      `SELECT id, shopify_order_id AS "shopifyOrderId",
              order_created_at AS "orderCreatedAt"
       FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(second.observedContentChecksum).toBe(
      canonicalContentChecksum({
        order: order.rows[0],
        lines: stored.rows,
        lineDisposition: "complete",
        identityDisposition: "available",
      }),
    );
  });

  it("rewrites stored lines when a title or quantity changed", async () => {
    const changedSet = {
      ...firstCompleteSet,
      lines: firstCompleteSet.lines.map((line, index) =>
        index === 0 ? { ...line, productTitle: "First v2", quantity: 3 } : line,
      ),
    };
    const { first, second, secondStatements } = await twoRunsOfOrderA({
      lines: changedSet,
    });

    expect(secondStatements.some((s) => /delete from "?shopify_order_line/i.test(s))).toBe(true);
    const stored = await testPool!.query(
      `SELECT product_title, quantity FROM shopify_order_line
       WHERE order_id = 'order_a' AND shopify_line_item_id = 'gid://shopify/LineItem/1'`,
    );
    expect(stored.rows[0]).toEqual({ product_title: "First v2", quantity: 3 });
    expect(second.observedContentChecksum).not.toBe(first.observedContentChecksum);
  });
```

`order_created_at` comes back from `pg` as a `Date`. If the timestamp-without-zone parse differs from Drizzle's, rebuild it the way the existing test file does elsewhere (search for `stored_text` or `replace(" ", "T")`). The checksum comparison must use the same instant the store uses.

- [ ] **Step 2: Run them**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts -t "stored lines"`

Expected:
- `"leaves identical stored lines untouched…"` FAILS: today the second commit deletes and re-inserts, so the line ids change and a `delete from` statement is present.
- `"rewrites stored lines when…"` PASSES. It is a regression guard.

- [ ] **Step 3: Split validation out of the rewrite**

Replace the head of `replaceCompleteLineSetWithExecutor` (near line 687) so the validation is reusable:

```ts
function assertCompleteLineSet(evidence: CompleteShopifyLineSet): void {
  if (
    evidence.completeness !== "complete" ||
    !(evidence.orderUpdatedAt instanceof Date) ||
    Number.isNaN(evidence.orderUpdatedAt.getTime()) ||
    !Array.isArray(evidence.lines)
  ) {
    throw new Error("Shopify evidence line set is not complete");
  }
}

async function replaceCompleteLineSetWithExecutor(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
  evidence: CompleteShopifyLineSet,
): Promise<void> {
  assertCompleteLineSet(evidence);
  await executor.delete(shopifyOrderLines).where(
```

Keep the rest of the function, from the `delete` onwards, exactly as it is.

- [ ] **Step 4: Add the stored-line read and comparison**

Add directly after `loadMatcherVisibleLines` (near line 1110):

```ts
async function loadStoredLineSet(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
) {
  return executor
    .select({
      shopifyLineItemId: shopifyOrderLines.shopifyLineItemId,
      shopifyProductId: shopifyOrderLines.shopifyProductId,
      shopifyVariantId: shopifyOrderLines.shopifyVariantId,
      sku: shopifyOrderLines.sku,
      productTitle: shopifyOrderLines.productTitle,
      variantTitle: shopifyOrderLines.variantTitle,
      quantity: shopifyOrderLines.quantity,
      sourcePosition: shopifyOrderLines.sourcePosition,
    })
    .from(shopifyOrderLines)
    .where(
      and(
        eq(shopifyOrderLines.organizationId, scope.organizationId),
        eq(shopifyOrderLines.storeId, scope.storeId),
        eq(shopifyOrderLines.orderId, orderId),
      ),
    );
}

/**
 * Whether the stored lines already say exactly what a fresh complete fetch
 * says, in every column a reader uses. parent_order_updated_at is
 * deliberately not compared: nothing reads it, and the lines it dates are
 * unchanged.
 */
function sameLineSet(
  stored: Awaited<ReturnType<typeof loadStoredLineSet>>,
  fetched: NormalizedShopifyOrderLine[],
): boolean {
  if (stored.length !== fetched.length) return false;
  const storedById = new Map(stored.map((line) => [line.shopifyLineItemId, line]));
  if (storedById.size !== stored.length) return false;
  return fetched.every((line) => {
    const current = storedById.get(line.shopifyLineItemId);
    return (
      current !== undefined &&
      current.shopifyProductId === line.shopifyProductId &&
      current.shopifyVariantId === line.shopifyVariantId &&
      current.sku === line.sku &&
      current.productTitle === line.productTitle &&
      current.variantTitle === line.variantTitle &&
      current.quantity === line.quantity &&
      current.sourcePosition === line.sourcePosition
    );
  });
}
```

If `NormalizedShopifyOrderLine` is not imported into the store yet, add it to the existing `import type { … } from "@/lib/shopify-evidence-admin"` (or `./shopify-evidence-admin`) line.

- [ ] **Step 5: Use them in the commit, and reuse the locked order row**

In `commitShopifyEvidenceOrder`'s non-replay path, replace:

```ts
    if (input.lines) {
      await replaceCompleteLineSetWithExecutor(
        tx,
        input.scope,
        order.id,
        input.lines,
      );
    }
```

with:

```ts
    // Unchanged lines (most re-fetches) are left as stored; the checksum
    // below is computed from the same set either way.
    if (input.lines) {
      assertCompleteLineSet(input.lines);
      const stored = await loadStoredLineSet(tx, input.scope, order.id);
      if (!sameLineSet(stored, input.lines.lines)) {
        await replaceCompleteLineSetWithExecutor(
          tx,
          input.scope,
          order.id,
          input.lines,
        );
      }
    }
```

Then replace the block from `const [projection] = await tx` through the `canonicalContentChecksum({ … })` call (near lines 1404–1426):

```ts
    const [projection] = await tx
      .select({
      …
    if (!projection) throw new Error("Shopify evidence order projection vanished");
    const lines = await loadMatcherVisibleLines(tx, input.scope, order.id);
    const observedContentChecksum = canonicalContentChecksum({
      order: projection,
      lines,
      lineDisposition: input.lineDisposition,
      identityDisposition,
    });
```

with:

```ts
    // `order` is locked FOR UPDATE above, so its columns cannot have moved
    // within this transaction; complete lines are exactly what is now stored.
    const lines = input.lines
      ? input.lines.lines
      : await loadMatcherVisibleLines(tx, input.scope, order.id);
    const observedContentChecksum = canonicalContentChecksum({
      order,
      lines,
      lineDisposition: input.lineDisposition,
      identityDisposition,
    });
```

- [ ] **Step 6: Run the new tests, then the whole file**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts -t "stored lines"`
Expected: PASS (2 tests).

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts`
Expected: all pass. These must stay green:
- `"preserves partial lines and unavailable identity while committing safe progress"` (the partial path still reads lines);
- `"canonicalizes line ordering while distinguishing semantic content changes"`;
- `"rolls back lines, identity, observation, and checkpoint together"`.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts`

```bash
git add src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts
git commit -m "perf(shopify): skip rewriting unchanged evidence lines"
```

---

### Task 3: Skip an unchanged customer id; insert-first observation and identity link

**Files:**
- Modify: `src/lib/shopify-evidence-store.ts`:
  - `resolveScopedOrder` (near line 658);
  - `persistAvailableIdentityWithExecutor` (near line 876) and its call in `commitShopifyEvidenceOrder` (near line 1390);
  - the observation and identity-observation writes in the non-replay path (near lines 1428–1512).
- Test: `src/lib/shopify-evidence.integration.test.ts`

**Interfaces:**
- Consumes, from Task 1: `twoRunsOfOrderA`, `availableIdentity`.
- Produces: `persistAvailableIdentityWithExecutor(executor, scope, orderId, evidence, currentShopifyCustomerId?: string | null)`. The existing caller `persistShopifyIdentityEvidence` passes nothing, so it keeps today's unconditional write.

- [ ] **Step 1: Write the failing tests**

Add inside `describeIfDb(...)`, after the test `"replays exactly without rewriting evidence and renews only the heartbeat"` (near line 1504):

```ts
  it("does not rewrite an unchanged customer id or pre-read fresh observations", async () => {
    const readOrderVersion = async () =>
      (await testPool!.query(
        `SELECT xmin::text AS version, shopify_customer_id FROM shopify_order
         WHERE id = 'order_a'`,
      )).rows[0];
    const firstRun = await startRun("trigger-customer-probe");
    await commitOrderA(firstRun.id);
    const before = await readOrderVersion();
    await finishShopifyEvidenceRun({
      scope,
      runId: firstRun.id,
      expectedCursor: FIRST_CURSOR,
      status: "success",
      progress: ORDER_A_PROGRESS,
    });
    const secondRun = await startRun(
      "trigger-customer-probe-2",
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const { statements } = await statementsDuring(() =>
      commitOrderA(secondRun.id, { now: new Date("2026-08-02T00:01:00.000Z") }),
    );

    expect(await readOrderVersion()).toEqual(before);
    expect(statements.some((s) => /update\s+"?shopify_order"?\s+set\s+"?shopify_customer_id/i.test(s))).toBe(false);
    expect(statements.some((s) => /select[\s\S]*from "?shopify_evidence_run_observation/i.test(s))).toBe(false);
    expect(statements.some((s) => /select[\s\S]*from "?shopify_evidence_run_identity_observation/i.test(s))).toBe(false);
  });

  it("rejects a fresh commit over a conflicting observation already in the run", async () => {
    const run = await startRun("trigger-observation-conflict");
    await testPool!.query(
      `INSERT INTO shopify_evidence_run_observation
         (id, organization_id, store_id, evidence_run_id, order_id,
          line_disposition, identity_disposition, observed_content_checksum)
       VALUES ('obs-conflict', 'org_a', 'store_a', $1, 'order_a',
         'complete', 'available', 'not-the-real-checksum')`,
      [run.id],
    );
    await expect(commitOrderA(run.id)).rejects.toThrow(
      "Shopify evidence observation replay conflicts",
    );
  });

  it("still writes a changed customer id", async () => {
    const changed = { ...availableIdentity(), shopifyCustomerId: "gid://shopify/Customer/2" };
    await twoRunsOfOrderA({ identity: changed });
    const order = await testPool!.query(
      `SELECT shopify_customer_id FROM shopify_order WHERE id = 'order_a'`,
    );
    expect(order.rows[0].shopify_customer_id).toBe("gid://shopify/Customer/2");
  });
```

- [ ] **Step 2: Run them**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts -t "customer id"`

Expected:
- `"does not rewrite an unchanged customer id…"` FAILS: today the `UPDATE` always runs (changing `xmin`), and both observation pre-reads are present.
- `"still writes a changed customer id"` PASSES. It is a regression guard.
- `"rejects a fresh commit over a conflicting observation…"` PASSES. It is a regression guard: today's pre-read finds the conflicting row and throws. After Step 5, the insert conflicts, then the read finds the row and throws the same error.

- [ ] **Step 3: Read the customer id with the locked order**

In `resolveScopedOrder`, add one column to the select:

```ts
    .select({
      id: shopifyOrders.id,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
      shopifyCustomerId: shopifyOrders.shopifyCustomerId,
    })
```

- [ ] **Step 4: Skip the unchanged write**

Change `persistAvailableIdentityWithExecutor`'s signature and its customer-id update:

```ts
async function persistAvailableIdentityWithExecutor(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
  evidence: Extract<NormalizedShopifyIdentityEvidence, { status: "available" }>,
  // The order's current value, read under the caller's order lock; when it
  // already matches, the write is skipped. Omitted: always write.
  currentShopifyCustomerId?: string | null,
): Promise<IdentityPersistenceResult> {
  assertAvailableIdentityEvidence(evidence);
  if (await suppressionExists(executor, scope, evidence)) {
    await clearOrderIdentity(executor, scope, orderId);
    return { disposition: "suppressed", identityHmacId: null };
  }

  if (currentShopifyCustomerId !== evidence.shopifyCustomerId) {
    await executor.execute(sql`
      update shopify_order
      set shopify_customer_id = ${evidence.shopifyCustomerId}
      where organization_id = ${scope.organizationId}
        and store_id = ${scope.storeId}
        and id = ${orderId}
    `);
  }
```

An omitted argument is `undefined`, which never equals a `string | null` evidence value, so callers that pass nothing always write. Everything after the update (the HMAC select, compare, rewrite) stays unchanged.

In `commitShopifyEvidenceOrder`, pass the locked value:

```ts
      const persisted = await persistAvailableIdentityWithExecutor(
        tx,
        input.scope,
        order.id,
        input.identity,
        order.shopifyCustomerId,
      );
```

- [ ] **Step 5: Make the observation insert-first**

In the non-replay path, replace the block from `const [existingObservation] = await tx` through the closing `}` of its `else { await tx.insert(shopifyEvidenceRunObservations)… }` with:

```ts
    const [insertedObservation] = await tx
      .insert(shopifyEvidenceRunObservations)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        evidenceRunId: input.evidenceRunId,
        orderId: order.id,
        lineDisposition: input.lineDisposition,
        identityDisposition,
        observedContentChecksum,
        sourceOrderUpdatedAt,
        observedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: shopifyEvidenceRunObservations.id });
    if (!insertedObservation) {
      // Already observed in this run: the stored row must say exactly this.
      const [existingObservation] = await tx
        .select({
          lineDisposition: shopifyEvidenceRunObservations.lineDisposition,
          identityDisposition: shopifyEvidenceRunObservations.identityDisposition,
          observedContentChecksum:
            shopifyEvidenceRunObservations.observedContentChecksum,
          sourceOrderUpdatedAt:
            shopifyEvidenceRunObservations.sourceOrderUpdatedAt,
        })
        .from(shopifyEvidenceRunObservations)
        .where(
          and(
            eq(shopifyEvidenceRunObservations.organizationId, input.scope.organizationId),
            eq(shopifyEvidenceRunObservations.storeId, input.scope.storeId),
            eq(shopifyEvidenceRunObservations.evidenceRunId, input.evidenceRunId),
            eq(shopifyEvidenceRunObservations.orderId, order.id),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !existingObservation ||
        existingObservation.lineDisposition !== input.lineDisposition ||
        existingObservation.identityDisposition !== identityDisposition ||
        !constantTimeTextEqual(
          existingObservation.observedContentChecksum,
          observedContentChecksum,
        ) ||
        existingObservation.sourceOrderUpdatedAt?.getTime() !==
          sourceOrderUpdatedAt?.getTime()
      ) {
        throw new Error("Shopify evidence observation replay conflicts");
      }
    }
```

- [ ] **Step 6: Make the identity link insert-first**

Replace the block from `const [existingIdentityObservation] = await tx` through the end of its `else if (existingIdentityObservation) { throw … }` with:

```ts
    const findIdentityObservation = async () => {
      const [row] = await tx
        .select({ identityHmacId: shopifyEvidenceRunIdentityObservations.identityHmacId })
        .from(shopifyEvidenceRunIdentityObservations)
        .where(
          and(
            eq(shopifyEvidenceRunIdentityObservations.organizationId, input.scope.organizationId),
            eq(shopifyEvidenceRunIdentityObservations.storeId, input.scope.storeId),
            eq(shopifyEvidenceRunIdentityObservations.evidenceRunId, input.evidenceRunId),
            eq(shopifyEvidenceRunIdentityObservations.orderId, order.id),
          ),
        )
        .limit(1)
        .for("update");
      return row;
    };
    if (identityHmacId) {
      const [insertedLink] = await tx
        .insert(shopifyEvidenceRunIdentityObservations)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          evidenceRunId: input.evidenceRunId,
          orderId: order.id,
          identityHmacId,
          observedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: shopifyEvidenceRunIdentityObservations.id });
      if (!insertedLink) {
        const existing = await findIdentityObservation();
        if (!existing || existing.identityHmacId !== identityHmacId) {
          throw new Error("Shopify evidence identity observation replay conflicts");
        }
      }
    } else if (await findIdentityObservation()) {
      throw new Error("Shopify evidence identity observation replay conflicts");
    }
```

The no-HMAC branch keeps today's read, because it must still refuse a stray link. Only the common HMAC branch drops its pre-read.

- [ ] **Step 7: Run the new tests, then the whole file**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts -t "customer id|conflicting observation"`
Expected: PASS (3 tests).

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence.integration.test.ts`
Expected: all pass. These must stay green:
- `"atomically commits complete evidence, safe observations, checkpoint, and exact replay"`;
- `"replays exactly without rewriting evidence and renews only the heartbeat"`;
- `"rejects a replay whose complete content checksum disagrees without mutation"`;
- `"does not resurrect an identity link legitimately removed before replay"`;
- `"suppresses identity without removing commerce and retains lifetime binding"`;
- `"shares the store-first lock with suppression so erasure-first cannot resurrect identity"`.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts`

```bash
git add src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts
git commit -m "perf(shopify): skip unchanged customer ids and pre-reads in evidence commits"
```

---

### Task 4: Full verification

**Files:** none, unless a failure below points at this change.

- [ ] **Step 1: Every suite that reads evidence**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run src/lib/shopify-evidence src/lib/shopify-privacy src/lib/klaviyo src/lib/shopify-store`

Expected: no failures. The Klaviyo match suites recompute checksums from stored lines (`shopify_content_mutated`), and must stay green. Skipped files that are gated on other environments are fine. Report them by name.

- [ ] **Step 2: Whole suite, typecheck, lint**

Run: `DATABASE_URL="$(cat rands/.local-db-url)" ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts`
Expected: tests pass, typecheck clean, touched files lint-clean.

- [ ] **Step 3: Branch contents**

Run: `git log --oneline origin/main..HEAD && git diff origin/main --stat`
Expected: the spec, the plan, and Tasks 1–3's three commits, touching only `src/lib/shopify-evidence-store.ts`, `src/lib/shopify-evidence.integration.test.ts`, and the two docs.
