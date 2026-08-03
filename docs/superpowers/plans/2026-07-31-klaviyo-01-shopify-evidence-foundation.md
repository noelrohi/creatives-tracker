# Klaviyo Shopify Evidence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-safe, separately synchronized Shopify order-line and privacy-safe identity foundation for the Reviv Klaviyo pilot without changing Shopify monetary ingestion or production attribution.

**Architecture:** Keep `trigger/shopify-sync.ts`, its order/refund query, and its monetary writes load-bearing and unchanged apart from the fail-closed store-ownership fix. A new evidence path reads existing Shopify order IDs, validates the explicit organization/store/domain binding, fetches every order-line page plus optional protected identity, normalizes email directly into tenant-derived versioned HMACs, checks a separate HMAC-only compliance suppression registry, and transactionally replaces only evidence-owned columns and tables. Evidence runs, durable erasure, and organization/store cascades are independent from the production attribution ledger.

**Tech Stack:** TypeScript, Node.js crypto, Shopify Admin GraphQL `2026-07`, Drizzle ORM, PostgreSQL, Trigger.dev 4, Vitest 4, Bun.

---

## Approved source and dependencies

- Design: `docs/superpowers/specs/2026-07-31-klaviyo-shopify-evidence-pilot-design.md`
- Roadmap: `docs/superpowers/plans/2026-07-31-klaviyo-shopify-evidence-pilot-roadmap.md`
- Baseline design commit: `c2b38bd`
- This is Plan 1. It has no dependency on a Klaviyo client, connection, event schema, matcher, report, or UI.
- A disposable PostgreSQL server reachable through `DATABASE_URL` is required for database-backed tests. Tests may skip without it during local focused work, but this plan is not complete until they have run against PostgreSQL.
- Shopify line fetching needs `read_orders`; orders older than 60 days need `read_all_orders`. Shopify customer ID/email remain optional and must be capability-probed because they are protected customer data.
- The first migration owned by this plan is exactly `drizzle/0053_klaviyo_shopify_evidence.sql`, generated with `bun run db:generate --name klaviyo_shopify_evidence`. If Drizzle proposes another number, stop and reconcile concurrent migration work before continuing.
- `source_identity_hmac` is deliberately valid for Shopify orders only in this plan. Plan 3 owns making `shopify_order_id` nullable, adding nullable `klaviyo_connection_id` and `klaviyo_event_id`, expanding `source_identity_kind`, replacing the Shopify-only check with the exactly-one-source check, adding a same-scope Klaviyo-event cascade once `klaviyo_event` exists, and replacing source uniqueness with one partial unique index per source kind/version.
- Do not use `bun test`; repository tests must run through `bun run test` so Vitest reads `vitest.config.ts`.
- Do not run `db:push`; repository policy requires generated migrations.

## File map

| Path | Action | Responsibility |
| --- | --- | --- |
| `.env.example` | Modify | Document Shopify evidence and current/previous HMAC server-only configuration. |
| `src/schema/shopify.ts` | Modify | Add store ownership FK/composite keys and nullable `shopifyCustomerId`; leave monetary columns intact. |
| `src/schema/finding.ts` | Modify | Scope nullable store-backed findings by organization/store while retaining organization-only findings. |
| `src/schema/shopify-evidence.ts` | Create | Own order lines, Shopify-only source HMAC rows, per-store non-secret crypto-key bindings, durable HMAC-only erasure suppressions, independent evidence sync runs, identity-free per-run order observations, and digest-backed identity observation links. |
| `drizzle/0053_klaviyo_shopify_evidence.sql` | Generate/inspect | Apply Plan 1 schema without rewriting existing monetary data. |
| `drizzle/meta/0053_snapshot.json` | Generate/inspect | Drizzle snapshot for the Plan 1 schema. |
| `drizzle/meta/_journal.json` | Generate/inspect | Register migration 0053. |
| `src/lib/shopify-ingest.ts` | Modify | Make store-domain ownership conflict fail closed; do not add evidence fields to monetary mapping/upserts. |
| `src/lib/shopify-ingest.test.ts` | Modify | Characterize the immutable monetary query and mapping boundary. |
| `src/lib/shopify-store.integration.test.ts` | Create | Verify race-safe store ownership behavior against PostgreSQL. |
| `src/lib/shopify-evidence-schema.test.ts` | Create | Normalize the Drizzle relation graph, including direct evidence-run identity observations. |
| `src/lib/identity-hmac.ts` | Create | Normalize email, parse matching/suppression key configuration, derive tenant/store keys, and emit versioned/domain-separated digests. |
| `src/lib/identity-hmac.test.ts` | Create | Verify deterministic HMAC behavior, isolation, rotation, suppression domains, and invalid configuration. |
| `src/lib/evidence-window.ts` | Create | Own the cross-plan half-open UTC window type and inclusive store-day conversion. |
| `src/lib/evidence-window.test.ts` | Create | Verify date validation and DST-correct 23/25-hour windows. |
| `src/lib/shopify-evidence-admin.ts` | Create | Capability probe, complete line pagination, and immediate protected-identity normalization. |
| `src/lib/shopify-evidence-admin.test.ts` | Create | Contract-test pagination, terminal versus retryable line failures, capability degradation, and no plaintext return. |
| `src/lib/shopify-evidence-store.ts` | Create | Load explicit store/order scope, transactionally replace evidence, and checkpoint independent runs. |
| `src/lib/shopify-evidence.integration.test.ts` | Create | Verify tenant constraints, complete-only replacement, rollback, replay, and identity persistence. |
| `src/lib/shopify-evidence-runner.ts` | Create | Dependency-injected batch orchestration that is testable without Trigger.dev. |
| `src/lib/shopify-evidence-runner.test.ts` | Create | Verify fail-before-write binding checks, partial identity behavior, scoped checkpoints, retry replay, and continuations. |
| `trigger/shopify-evidence-sync.ts` | Create | Thin start/batch Trigger.dev wrappers on a separate queue. |
| `src/lib/shopify-privacy.ts` | Create | Data-subject erasure and pilot-identity clearing hook for later Klaviyo uninstall. |
| `src/lib/shopify-privacy.integration.test.ts` | Create | Verify tenant-safe dual-version erasure, durable reingestion suppression, and identity-only uninstall cleanup. |
| `src/lib/trpc/routers/organization.ts` | Modify | Explicitly remove Shopify stores inside workspace deletion; database cascades remain the backstop. |
| `src/lib/shopify-evidence-reconciliation.integration.test.ts` | Create | Prove evidence backfill, replay, erasure, and cleanup cannot alter monetary attribution. |

## Stable Plan 1 contracts

Later plans must import these names rather than creating aliases:

```ts
export type IdentityScope = {
  organizationId: string;
  storeId: string;
};

export type IdentityHmacKey = {
  version: string;
  secret: Uint8Array;
};

export type IdentityHmacKeyring = {
  current: IdentityHmacKey;
  previous?: IdentityHmacKey;
};

export type VersionedIdentityDigest = {
  keyVersion: string;
  digest: string;
  rotationState: "active" | "rotation_previous";
};

export type ErasureSuppressionKind = "email" | "shopify_customer_id";

export type ErasureSuppressionKey = {
  version: string;
  secret: Uint8Array;
};

export type ErasureSuppressionDigest = {
  kind: ErasureSuppressionKind;
  keyVersion: string;
  digest: string;
};

export type IdentityCryptoKeyChecks = {
  matching: Array<{ keyVersion: string; keyCheck: string }>;
  suppression: { keyVersion: string; keyCheck: string };
};

export function parseErasureSuppressionKey(
  env?: NodeJS.ProcessEnv,
): ErasureSuppressionKey;

export function computeErasureSuppressionDigests(input: {
  scope: IdentityScope;
  key: ErasureSuppressionKey;
  email?: string | null;
  shopifyCustomerId?: string | null;
}): ErasureSuppressionDigest[];

export function computeIdentityCryptoKeyChecks(input: {
  scope: IdentityScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): IdentityCryptoKeyChecks;

export type HalfOpenWindow = {
  from: Date;
  to: Date;
};

export type ShopifyEvidenceMode = "initial_90d" | "incremental_7d";

export function assertValidStoreDay(value: string): void;
export function assertValidIanaTimezone(value: string): void;

export function deriveShopifyEvidenceWindow(input: {
  mode: ShopifyEvidenceMode;
  anchorStoreDay: string;
  timeZone: string;
}): HalfOpenWindow;

export function inclusiveStoreDaysToHalfOpenUtc(input: {
  dateFrom: string;
  dateTo: string;
  timeZone: string;
}): HalfOpenWindow;

export type CompleteShopifyLineSet = {
  completeness: "complete";
  shopifyOrderId: string;
  orderUpdatedAt: Date;
  lines: NormalizedShopifyOrderLine[];
};
```

Schema exports from `src/schema/shopify-evidence.ts` are `shopifyOrderLines`, `sourceIdentityHmacs`, `identityMatchingKeyBindings`, `identityCryptoPolicies`, `identityErasureSuppressions`, `shopifyEvidenceSyncRuns`, `shopifyEvidenceRunObservations`, and `shopifyEvidenceRunIdentityObservations`.

`HalfOpenWindow` and `inclusiveStoreDaysToHalfOpenUtc` are exported from `src/lib/evidence-window.ts`; Plans 2–4 import or re-export those exact contracts rather than declaring structurally similar aliases or timezone converters.

`src/lib/shopify-evidence-store.ts` exports `ensureIdentityCryptoPolicy({ scope, keyChecks, executor? })`. The caller derives `keyChecks` in memory from validated secrets. Without an executor it opens a transaction and locks the scoped store; with one, the caller already holds that lock. It first insert-or-loads the lifetime matching-key binding by `(organization, store, version)`, constant-time accepts only the identical check, then initializes/validates the active policy in the same transaction. Plan 1 initializes only a current matching key plus the stable suppression binding and rejects a configured previous key. It validates both stored active checks before any protected-identity remote call/write. Plan 3 is the only plan allowed to transactionally bind a never-seen matching label and transition the matching current/previous policy alongside the connection write gate; it can replay an identical historical binding but can never rebind its label.

The Plan 2 uninstall contract is transaction-injectable:

```ts
export type ShopifyPrivacyExecutor = Pick<typeof db, "execute" | "delete">;

export function clearPilotShopifyIdentityForStore(
  scope: IdentityScope,
  executor?: ShopifyPrivacyExecutor,
): Promise<{ ordersCleared: number; digestsDeleted: number }>;
```

## Task 1: Lock the existing monetary boundary

**Files:**
- Modify: `src/lib/shopify-ingest.test.ts`
- Read only: `src/lib/shopify-admin.ts:75-125`
- Read only: `src/lib/shopify-ingest.ts:127-214,549-680`

- [ ] **Step 1: Add a characterization test for the production order query**

Add `ORDER_FIELDS` to the existing import from `@/lib/shopify-admin`, then add this test after the test fixture helpers:

```ts
describe("Shopify monetary sync boundary", () => {
  it("does not request evidence-only line or identity fields", () => {
    expect(ORDER_FIELDS).not.toMatch(/\blineItems\b/);
    expect(ORDER_FIELDS).not.toMatch(/\bcustomer\s*\{/);
    expect(ORDER_FIELDS).not.toMatch(/\bemail\b/);
  });

  it("does not map protected identity onto a monetary order row", () => {
    const row = mapOrderToRow(order(), CONTEXT);
    expect(Object.keys(row)).not.toContain("shopifyCustomerId");
    expect(Object.keys(row)).not.toContain("email");
    expect(Object.keys(row)).not.toContain("lineItems");
  });
});
```

- [ ] **Step 2: Run the characterization tests**

Run: `bun run test -- src/lib/shopify-ingest.test.ts`

Expected: PASS. These tests characterize the current safe boundary before evidence code exists.

- [ ] **Step 3: Commit the boundary tests**

```bash
git add src/lib/shopify-ingest.test.ts
git commit -m "test(shopify): lock monetary sync boundary"
```

## Task 2: Make Shopify store ownership fail closed

**Files:**
- Create: `src/lib/shopify-store.integration.test.ts`
- Modify: `src/lib/shopify-ingest.ts:336-376`

- [ ] **Step 1: Write the PostgreSQL ownership tests**

Create `src/lib/shopify-store.integration.test.ts` with a disposable database named `adsolute_shopify_store_test`. Use the same `.env` resolution and `describeIfDb` convention as `src/lib/trpc/routers/manager.test.ts`. The behavior section must contain these tests:

```ts
describeIfDb("upsertShopifyStore ownership", () => {
  beforeEach(async () => {
    await testDb!.execute(sql.raw("TRUNCATE shopify_store, organization CASCADE"));
    await testDb!.execute(sql`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES
        ('org_a', 'Org A', 'org-a', now()),
        ('org_b', 'Org B', 'org-b', now())
    `);
  });

  it("updates mutable metadata without changing the owner", async () => {
    await upsertShopifyStore({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "UTC",
      currency: "USD",
    });

    const updated = await upsertShopifyStore({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "Asia/Manila",
      currency: "PHP",
    });

    expect(updated).toMatchObject({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "Asia/Manila",
      currency: "PHP",
    });
  });

  it("rejects a domain already owned by another organization", async () => {
    await upsertShopifyStore({
      organizationId: "org_a",
      shopDomain: "reviv.myshopify.com",
      ianaTimezone: "UTC",
      currency: "USD",
    });

    await expect(
      upsertShopifyStore({
        organizationId: "org_b",
        shopDomain: "reviv.myshopify.com",
        ianaTimezone: "Asia/Manila",
        currency: "PHP",
      }),
    ).rejects.toBeInstanceOf(ShopifyStoreOwnershipConflictError);

    const [stored] = await testDb!.execute(sql`
      SELECT organization_id, iana_timezone, currency
      FROM shopify_store
      WHERE shop_domain = 'reviv.myshopify.com'
    `);
    expect(stored).toMatchObject({
      organization_id: "org_a",
      iana_timezone: "UTC",
      currency: "USD",
    });
  });

  it("allows exactly one owner under a concurrent first claim", async () => {
    const claims = await Promise.allSettled([
      upsertShopifyStore({
        organizationId: "org_a",
        shopDomain: "reviv.myshopify.com",
        ianaTimezone: "UTC",
        currency: "USD",
      }),
      upsertShopifyStore({
        organizationId: "org_b",
        shopDomain: "reviv.myshopify.com",
        ianaTimezone: "UTC",
        currency: "USD",
      }),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  });
});
```

The fixture schema must contain the existing `organization` and `shopify_store` columns and the unique `shop_domain` constraint. Mock `@/db` to `testDb` before importing `shopify-ingest`.

- [ ] **Step 2: Run the ownership tests to verify the unsafe behavior**

Run: `bun run test -- src/lib/shopify-store.integration.test.ts`

Expected: FAIL because the current conflict update rewrites `organization_id`, so the second and concurrent-claim tests do not reject.

- [ ] **Step 3: Add the explicit ownership error and conditional conflict update**

In `src/lib/shopify-ingest.ts`, add this exported error above `upsertShopifyStore`:

```ts
export class ShopifyStoreOwnershipConflictError extends Error {
  constructor(
    readonly shopDomain: string,
    readonly existingOrganizationId: string,
    readonly requestedOrganizationId: string,
  ) {
    super("Shopify store domain is already owned by another organization");
    this.name = "ShopifyStoreOwnershipConflictError";
  }
}
```

Replace the existing upsert body with a conditional conflict update that never writes the ownership column:

```ts
  const [store] = await db
    .insert(shopifyStores)
    .values({
      organizationId: params.organizationId,
      shopDomain: params.shopDomain,
      ianaTimezone: params.ianaTimezone,
      currency: params.currency,
    })
    .onConflictDoUpdate({
      target: shopifyStores.shopDomain,
      set: {
        ianaTimezone: params.ianaTimezone,
        currency: params.currency,
        updatedAt: new Date(),
      },
      setWhere: eq(shopifyStores.organizationId, params.organizationId),
    })
    .returning({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      currency: shopifyStores.currency,
    });

  if (store) return store;

  const existing = await getShopifyStoreByDomain(params.shopDomain);
  if (!existing) {
    throw new Error("Shopify store conflict produced no persisted owner");
  }

  throw new ShopifyStoreOwnershipConflictError(
    params.shopDomain,
    existing.organizationId,
    params.organizationId,
  );
```

Do not put `organizationId` back into the conflict `set` object.

- [ ] **Step 4: Run focused ownership and monetary tests**

Run: `bun run test -- src/lib/shopify-store.integration.test.ts src/lib/shopify-ingest.test.ts`

Expected: PASS. The monetary characterization remains green.

- [ ] **Step 5: Commit fail-closed ownership**

```bash
git add src/lib/shopify-ingest.ts src/lib/shopify-store.integration.test.ts
git commit -m "fix(shopify): fail closed on store ownership conflicts"
```

## Task 3: Add tenant-derived versioned identity HMACs

**Files:**
- Create: `src/lib/identity-hmac.ts`
- Create: `src/lib/identity-hmac.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the HMAC unit tests**

Create `src/lib/identity-hmac.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  computeIdentityDigests,
  normalizeIdentityEmail,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";

const CURRENT_SECRET = Buffer.alloc(32, 7).toString("base64url");
const PREVIOUS_SECRET = Buffer.alloc(32, 9).toString("base64url");

describe("identity HMAC", () => {
  it("normalizes email with trim and lowercase only", () => {
    expect(normalizeIdentityEmail("  Ivan.Example+Tag@Example.COM ")).toBe(
      "ivan.example+tag@example.com",
    );
  });

  it("is deterministic inside one tenant, store, and version", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const input = {
      scope: { organizationId: "org_a", storeId: "store_a" },
      email: "person@example.com",
      keyring,
    };
    expect(computeIdentityDigests(input)).toEqual(computeIdentityDigests(input));
  });

  it("does not correlate the same email across tenants or stores", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const digest = (organizationId: string, storeId: string) =>
      computeIdentityDigests({
        scope: { organizationId, storeId },
        email: "person@example.com",
        keyring,
      })[0].digest;

    expect(digest("org_a", "store_a")).not.toBe(digest("org_b", "store_a"));
    expect(digest("org_a", "store_a")).not.toBe(digest("org_a", "store_b"));
  });

  it("emits current and previous rows during rotation", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
      IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
      IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
    });
    expect(
      computeIdentityDigests({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring,
      }).map(({ keyVersion, rotationState }) => ({ keyVersion, rotationState })),
    ).toEqual([
      { keyVersion: "v2", rotationState: "active" },
      { keyVersion: "v1", rotationState: "rotation_previous" },
    ]);
  });

  it("rejects short, incomplete, same-version, and reused-root rotation configuration", () => {
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: Buffer.alloc(16, 1).toString("base64url"),
        IDENTITY_HMAC_KEY_VERSION: "v2",
      }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
      }),
    ).toThrow("must be configured together");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
        IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v2",
      }),
    ).toThrow("must differ");
    expect(() =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
      }),
    ).toThrow("different decoded byte sequences");
  });

  it("rejects directly constructed equal-root keyrings before producing a digest", () => {
    const reusedRoot = Buffer.alloc(32, 7);
    expect(() =>
      computeIdentityDigests({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring: {
          current: { version: "v2", secret: reusedRoot },
          previous: { version: "v1", secret: Buffer.from(reusedRoot) },
        },
      }),
    ).toThrow("different decoded byte sequences");
  });

  it("never returns plaintext email or master secrets", () => {
    const keyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
    });
    const serialized = JSON.stringify(
      computeIdentityDigests({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring,
      }),
    );
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain(CURRENT_SECRET);
  });
});
```

Pin literal known-answer vectors for the matching email digest, email suppression digest, customer-ID suppression digest, matching key check, and suppression key check, including at least one vector with multibyte scope components. Prove organization and store isolation in every relevant domain (matching email, both suppression subject kinds, and both key checks). Test well-formed Unicode / PostgreSQL-representable scope text including empty components, colons, a representable control character, and multibyte components for deterministic output; reject U+0000 and an unpaired UTF-16 surrogate before any output; and prove `{ organizationId: "org", storeId: "store:x" }` and `{ organizationId: "org:store", storeId: "x" }` produce different outputs, not errors. Prove the same email/customer alias produces deterministic but domain-distinct suppression HMACs inside one scope; `parseErasureSuppressionKey` rejects a short/missing secret or invalid version; and configuration/use rejects a matching current/previous pair with identical decoded root bytes plus a suppression root reused from either current or previous matching root before returning key checks or doing identity-bearing work. Directly construct wrong-type (`as unknown as ...`), short-secret, and invalid-version matching keys and prove the matching operations throw before HMAC output; directly construct an equal-root/different-label `IdentityHmacKeyring` and prove `computeIdentityDigests` throws without producing a digest. Directly construct wrong-type (`as unknown as ...`), short-secret, and invalid-version `ErasureSuppressionKey` values and prove `computeErasureSuppressionDigests` throws before output. `computeIdentityCryptoKeyChecks` is deterministic, scoped, distinct between matching/suppression domains, and changes when a secret changes without revealing either secret or subject data. Same version plus a different secret must produce a different check. Only null or absent suppression fields are omitted. A present blank/whitespace email is trim-and-lowercase normalized then HMACed, while Shopify customer/profile aliases remain exact opaque strings (including whitespace) and are never normalized or trimmed before HMAC; matching `email: string` remains accepted without blank rejection. No serialized result may contain the email, customer ID, matching secret, or suppression secret. The suppression key is deliberately separate from the rotatable matching keyring.

- [ ] **Step 2: Run the HMAC tests to verify they fail**

Run: `bun run test -- src/lib/identity-hmac.test.ts`

Expected: on the original clean baseline, FAIL with `Failed to resolve import "@/lib/identity-hmac"`. When applying this approved amendment to an already-created module, the new scope/root/direct-key regression cases must fail until the implementation is updated.

- [ ] **Step 3: Implement the HMAC module**

Create `src/lib/identity-hmac.ts`:

```ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export type IdentityScope = {
  organizationId: string;
  storeId: string;
};

export type IdentityHmacKey = {
  version: string;
  secret: Uint8Array;
};

export type IdentityHmacKeyring = {
  current: IdentityHmacKey;
  previous?: IdentityHmacKey;
};

export type VersionedIdentityDigest = {
  keyVersion: string;
  digest: string;
  rotationState: "active" | "rotation_previous";
};

type IdentityHmacEnvironment = Pick<
  NodeJS.ProcessEnv,
  | "IDENTITY_HMAC_SECRET"
  | "IDENTITY_HMAC_KEY_VERSION"
  | "IDENTITY_HMAC_PREVIOUS_SECRET"
  | "IDENTITY_HMAC_PREVIOUS_KEY_VERSION"
>;

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function parseVersion(value: string | undefined, name: string): string {
  if (!value || !VERSION_PATTERN.test(value)) {
    throw new Error(`${name} must be 1-64 letters, digits, dot, underscore, or dash`);
  }
  return value;
}

function parseSecret(value: string | undefined, name: string): Uint8Array {
  if (!value) throw new Error(`${name} is required`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 32) {
    throw new Error(`${name} must decode to at least 32 bytes`);
  }
  return decoded;
}

function equalSecretBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function assertValidMatchingKey(key: IdentityHmacKey, name: string): void {
  if (typeof key.version !== "string") {
    throw new Error(`${name} version must be a string`);
  }
  if (!(key.secret instanceof Uint8Array)) {
    throw new Error(`${name} secret must be a Uint8Array`);
  }
  if (!VERSION_PATTERN.test(key.version)) {
    throw new Error(`${name} version must be 1-64 letters, digits, dot, underscore, or dash`);
  }
  if (key.secret.byteLength < 32) {
    throw new Error(`${name} secret must be at least 32 bytes`);
  }
}

function assertValidMatchingKeyring(keyring: IdentityHmacKeyring): void {
  assertValidMatchingKey(keyring.current, "Current identity HMAC key");
  if (!keyring.previous) return;
  assertValidMatchingKey(keyring.previous, "Previous identity HMAC key");
  if (keyring.previous.version === keyring.current.version) {
    throw new Error("Current and previous identity HMAC versions must differ");
  }
  if (equalSecretBytes(keyring.previous.secret, keyring.current.secret)) {
    throw new Error(
      "Current and previous identity HMAC secrets must use different decoded byte sequences",
    );
  }
}

function assertWellFormedIdentityScope(scope: IdentityScope): void {
  for (const [name, value] of [
    ["organizationId", scope.organizationId],
    ["storeId", scope.storeId],
  ]) {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) {
      throw new Error(`${name} must be PostgreSQL-representable well-formed Unicode text`);
    }
  }
}

export function normalizeIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseIdentityHmacKeyring(
  env: IdentityHmacEnvironment = process.env,
): IdentityHmacKeyring {
  const current = {
    version: parseVersion(env.IDENTITY_HMAC_KEY_VERSION, "IDENTITY_HMAC_KEY_VERSION"),
    secret: parseSecret(env.IDENTITY_HMAC_SECRET, "IDENTITY_HMAC_SECRET"),
  };
  const hasPreviousSecret = Boolean(env.IDENTITY_HMAC_PREVIOUS_SECRET);
  const hasPreviousVersion = Boolean(env.IDENTITY_HMAC_PREVIOUS_KEY_VERSION);
  if (hasPreviousSecret !== hasPreviousVersion) {
    throw new Error(
      "IDENTITY_HMAC_PREVIOUS_SECRET and IDENTITY_HMAC_PREVIOUS_KEY_VERSION must be configured together",
    );
  }
  if (!hasPreviousSecret) {
    const keyring = { current };
    assertValidMatchingKeyring(keyring);
    return keyring;
  }

  const previous = {
    version: parseVersion(
      env.IDENTITY_HMAC_PREVIOUS_KEY_VERSION,
      "IDENTITY_HMAC_PREVIOUS_KEY_VERSION",
    ),
    secret: parseSecret(
      env.IDENTITY_HMAC_PREVIOUS_SECRET,
      "IDENTITY_HMAC_PREVIOUS_SECRET",
    ),
  };
  const keyring = { current, previous };
  assertValidMatchingKeyring(keyring);
  return keyring;
}

function encodeIdentityScope(scope: IdentityScope): string {
  assertWellFormedIdentityScope(scope);
  const organizationLength = Buffer.byteLength(scope.organizationId, "utf8");
  const storeLength = Buffer.byteLength(scope.storeId, "utf8");
  return `scope-v1:${organizationLength}:${scope.organizationId}:${storeLength}:${scope.storeId}`;
}

export function deriveTenantIdentityKey(
  key: IdentityHmacKey,
  scope: IdentityScope,
): Uint8Array {
  assertValidMatchingKey(key, "Identity HMAC key");
  return createHmac("sha256", key.secret)
    .update(`identity-tenant:${encodeIdentityScope(scope)}`, "utf8")
    .digest();
}

export function digestIdentityEmail(params: {
  scope: IdentityScope;
  email: string;
  key: IdentityHmacKey;
}): string {
  assertValidMatchingKey(params.key, "Identity HMAC key");
  const tenantKey = deriveTenantIdentityKey(params.key, params.scope);
  const normalized = normalizeIdentityEmail(params.email);
  return createHmac("sha256", tenantKey)
    .update(`email:${params.key.version}:${normalized}`, "utf8")
    .digest("base64url");
}

export function computeIdentityDigests(params: {
  scope: IdentityScope;
  email: string;
  keyring: IdentityHmacKeyring;
}): VersionedIdentityDigest[] {
  assertValidMatchingKeyring(params.keyring);
  const rows: VersionedIdentityDigest[] = [
    {
      keyVersion: params.keyring.current.version,
      digest: digestIdentityEmail({
        scope: params.scope,
        email: params.email,
        key: params.keyring.current,
      }),
      rotationState: "active",
    },
  ];
  if (params.keyring.previous) {
    rows.push({
      keyVersion: params.keyring.previous.version,
      digest: digestIdentityEmail({
        scope: params.scope,
        email: params.email,
        key: params.keyring.previous,
      }),
      rotationState: "rotation_previous",
    });
  }
  return rows;
}
```

In the same server-only module, add `parseErasureSuppressionKey`, `computeErasureSuppressionDigests`, and `computeIdentityCryptoKeyChecks` matching the stable contracts above. `encodeIdentityScope` is an internal primitive, not a new stable public export. Derive the suppression tenant key as `HMAC-SHA256(suppression-secret, "identity-erasure-tenant:" + encodeIdentityScope(scope))`; matching uses `HMAC-SHA256(matching-secret, "identity-tenant:" + encodeIdentityScope(scope))`. The canonical `scope-v1` encoding accepts only well-formed Unicode / PostgreSQL-representable scope text, including empty components, colons, controls other than U+0000, and multibyte text; it rejects U+0000 and unpaired UTF-16 surrogates before byte-length calculation or derivation. UTF-8 byte lengths are unsigned ASCII decimal with no leading zero except `0`, no Unicode normalization occurs, and every HMAC context string is UTF-8. Then HMAC the unchanged distinct subject domains: email is trim-and-lowercase normalized before `email:<normalized>`, while `shopify-customer-id:<opaque-id>` and profile aliases use exact opaque strings byte-for-byte, including whitespace, with no trimming or normalization. Only null/absent suppression inputs are omitted. The returned subject rows contain only kind, suppression-key version, and base64url digest. Key checks are non-subject sentinels: HMAC the fixed UTF-8 contexts `identity-key-binding:<version>` and `erasure-key-binding:<version>` under their respective tenant/store-derived keys. They prove that a later process holds the same high-entropy secret for a stored label; they are never matcher inputs, subject lookup values, or aggregate checksums. Centralize direct-constructed-key validation in private primitives: parsing and every matching-key operation (`deriveTenantIdentityKey`, `digestIdentityEmail`, `computeIdentityDigests`, and `computeIdentityCryptoKeyChecks`) validate secret length and version syntax; keyring operations additionally validate distinct current/previous labels and decoded roots. Add a private suppression-key validator (version syntax plus `Uint8Array` secret type/length) used by parsing, `computeErasureSuppressionDigests`, and `computeIdentityCryptoKeyChecks`, so direct structural keys cannot bypass validation. Combined operations validate suppression-root independence from both matching roots before output or protected work, using the same equal-length `timingSafeEqual` helper as matching-root comparison (different lengths return false). This does not replace the required domains. This suppression key is a compliance key, not a matcher key: matching, rotation, reports, checksums, and UI must never read its subject rows. Because erased plaintext is unavailable for migration, the pilot keeps this key/version stable for the lifetime of its suppression rows; changing it requires an explicit compliance migration/upstream-deletion procedure and is outside automatic matching-key rotation.

Both private key validators first require `typeof key.version === "string"` and `key.secret instanceof Uint8Array` (so `Buffer` is accepted), before version-pattern or length checks. The suppression validator is called by parsing, suppression-only derivation, and combined key checks; invalid direct objects throw before any HMAC output.

- [ ] **Step 4: Document server-only environment variables**

Append this exact block to `.env.example`:

```dotenv
# Shopify Admin API (server/worker only)
SHOPIFY_SHOP_DOMAIN=example.myshopify.com
SHOPIFY_ACCESS_TOKEN=
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
# Add read_all_orders/read_customers only after Shopify grants the required access.
SHOPIFY_SCOPES=read_orders

# Pilot identity HMAC (server/worker only; base64url encoding of at least 32 random bytes)
IDENTITY_HMAC_SECRET=
IDENTITY_HMAC_KEY_VERSION=v1
# Rotation-only pair. Set both together, reingest, publish, retire old rows, then remove both.
IDENTITY_HMAC_PREVIOUS_SECRET=
IDENTITY_HMAC_PREVIOUS_KEY_VERSION=

# Stable erasure-suppression HMAC (server/worker only; separate 32+ byte secret).
# Do not rotate automatically: retained tombstones cannot be re-keyed without plaintext.
IDENTITY_ERASURE_HMAC_SECRET=
IDENTITY_ERASURE_HMAC_KEY_VERSION=e1
```

- [ ] **Step 5: Run the HMAC tests**

Run: `bun run test -- src/lib/identity-hmac.test.ts`

Expected: PASS with matching-HMAC, suppression-HMAC, and non-secret key-binding cases.

- [ ] **Step 6: Commit the identity primitive**

```bash
git add .env.example src/lib/identity-hmac.ts src/lib/identity-hmac.test.ts
git commit -m "feat(privacy): add tenant-scoped identity digests"
```

## Task 4: Add the Shopify evidence schema and migration

**Files:**
- Modify: `src/schema/shopify.ts:1-112,187-220`
- Modify: `src/schema/finding.ts`
- Create: `src/schema/shopify-evidence.ts`
- Create: `src/lib/shopify-evidence-schema.test.ts`
- Generate: `drizzle/0053_klaviyo_shopify_evidence.sql`
- Generate: `drizzle/meta/0053_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/shopify-store.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-31-klaviyo-shopify-evidence-pilot-design.md`
- Modify: `docs/superpowers/plans/2026-07-31-klaviyo-01-shopify-evidence-foundation.md`

- [ ] **Step 1: Add failing database-constraint cases**

Extend `src/lib/shopify-store.integration.test.ts` with a `Shopify evidence constraints` describe block. Seed one order for `org_a/store_a`, then execute these assertions:

The suite creates only the minimal relevant pre-0053 tables with their exact legacy foreign-key names, then reads and executes `drizzle/0053_klaviyo_shopify_evidence.sql` statement-by-statement using the checked-in `--> statement-breakpoint` delimiters. Do not duplicate post-0053 evidence DDL in the fixture. Add isolated legacy mismatch fixtures proving each migration preflight aborts before any enum, table, column, unique, or foreign-key mutation. Add catalog and behavior coverage for the scoped order/refund/sync-run/finding constraints, nullable-store findings, organization/order/run cascades, run window/mode/start/running uniqueness, dispositions, identity-observation uniqueness, and both invalid previous-key null-pair directions.

Add `src/lib/shopify-evidence-schema.test.ts` and invoke Drizzle relation extraction plus normalization for the direct evidence-run-to-identity-observations edge. It must normalize the full `(organization_id, store_id, id) -> (organization_id, store_id, evidence_run_id)` shape without inference errors.

```ts
describe("Shopify evidence constraints", () => {
  it("rejects a line whose organization/store/order tuple disagrees", async () => {
    await expect(
      testDb!.execute(sql`
        INSERT INTO shopify_order_line (
          id, organization_id, store_id, order_id, shopify_line_item_id,
          product_title, quantity, source_position, parent_order_updated_at
        ) VALUES (
          'line_internal_1', 'org_b', 'store_a', 'order_a',
          'gid://shopify/LineItem/1', 'Product', 1, 0, now()
        )
      `),
    ).rejects.toThrow();
  });

  it("rejects duplicate Shopify line IDs inside a store", async () => {
    const insert = () =>
      testDb!.execute(sql`
        INSERT INTO shopify_order_line (
          id, organization_id, store_id, order_id, shopify_line_item_id,
          product_title, quantity, source_position, parent_order_updated_at
        ) VALUES (
          ${crypto.randomUUID()}, 'org_a', 'store_a', 'order_a',
          'gid://shopify/LineItem/1', 'Product', 1, 0, now()
        )
      `);
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("rejects zero line quantity", async () => {
    await expect(
      testDb!.execute(sql`
        INSERT INTO shopify_order_line (
          id, organization_id, store_id, order_id, shopify_line_item_id,
          product_title, quantity, source_position, parent_order_updated_at
        ) VALUES (
          'line_internal_2', 'org_a', 'store_a', 'order_a',
          'gid://shopify/LineItem/2', 'Product', 0, 1, now()
        )
      `),
    ).rejects.toThrow();
  });

  it("rejects duplicate identity versions for one Shopify order", async () => {
    const insert = () =>
      testDb!.execute(sql`
        INSERT INTO source_identity_hmac (
          id, organization_id, store_id, source_kind, shopify_order_id,
          key_version, digest, rotation_state
        ) VALUES (
          ${crypto.randomUUID()}, 'org_a', 'store_a', 'shopify_order',
          'order_a', 'v1', 'digest-value', 'active'
        )
      `);
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("rejects an evidence observation outside its exact run/order scope");
  it("rejects duplicate order membership inside one evidence run");
  it("rejects an identity observation outside its exact run order or digest scope");
  it("rejects a suppression row outside its exact organization/store scope");
  it("deduplicates one suppression kind/version/digest inside a store");
  it("binds one matching key check to a store/version for its lifetime");
  it("rejects a policy pair that is absent from the matching key registry");
  it("allows one crypto policy per store and rejects half-configured previous keys");
});
```

- [ ] **Step 2: Run the constraint cases to verify they fail**

Run: `bun run test -- src/lib/shopify-store.integration.test.ts`

Expected: FAIL because the evidence tables and `shopify_customer_id` column do not exist.

- [ ] **Step 3: Add fail-closed parent ownership, scoped foreign keys, and customer-ID schema changes**

In `src/schema/shopify.ts`:

1. Import `organization` from `@/schema/auth`.
2. Change `shopifyStores.organizationId` to reference `organization.id` with `onDelete: "cascade"`.
3. Add `unique("shopify_store_org_id_uniq").on(table.organizationId, table.id)`.
4. Add nullable `shopifyCustomerId: text("shopify_customer_id")` immediately after `shopifyOrderId`.
5. Add `unique("shopify_order_org_store_id_uniq").on(table.organizationId, table.storeId, table.id)`.
6. Add `index("shopify_order_store_customer_idx").on(table.storeId, table.shopifyCustomerId)` for store-scoped protected-identity cleanup and diagnostics.
7. Replace `shopify_order`'s single-column store foreign key with named composite `shopify_order_org_store_fk` on `(organizationId, storeId) -> shopify_store(organizationId, id)`, cascading on store deletion.
8. Replace `shopify_refund`'s independent store/order foreign keys with named composite `shopify_refund_org_store_order_fk` on `(organizationId, storeId, orderId) -> shopify_order(organizationId, storeId, id)`, cascading on order deletion and transitively on store deletion.
9. Replace `shopify_sync_run`'s single-column store foreign key with named composite `shopify_sync_run_org_store_fk` on `(organizationId, storeId) -> shopify_store(organizationId, id)`, cascading on store deletion.
10. In `src/schema/finding.ts`, replace the nullable single-column store foreign key with named composite `finding_org_store_fk` on `(organizationId, storeId) -> shopify_store(organizationId, id)`, cascading on store deletion. Keep `storeId` nullable; PostgreSQL `MATCH SIMPLE` permits organization-only findings.
11. Update the Drizzle relations for these four paths to use the same full scoped fields. Do not repair, reassign, or delete legacy rows.

The resulting ownership fields and unique keys must be:

```ts
organizationId: text("organization_id")
  .notNull()
  .references(() => organization.id, { onDelete: "cascade" }),
```

```ts
unique("shopify_store_org_id_uniq").on(table.organizationId, table.id),
```

```ts
shopifyOrderId: text("shopify_order_id").notNull(),
shopifyCustomerId: text("shopify_customer_id"),
```

```ts
unique("shopify_order_org_store_id_uniq").on(
  table.organizationId,
  table.storeId,
  table.id,
),
index("shopify_order_store_customer_idx").on(
  table.storeId,
  table.shopifyCustomerId,
),
```

Do not add `shopifyCustomerId` to `ShopifyOrderNode`, `ShopifyOrderRow`, `mapOrderToRow`, or `upsertOrderRows`; the monetary sync must omit it on insert and conflict update.

- [ ] **Step 4: Create the evidence schema**

Create `src/schema/shopify-evidence.ts` with these enums and tables:

```ts
import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";

export const sourceIdentityKindEnum = pgEnum("source_identity_kind", [
  "shopify_order",
]);

export const identityHmacRotationStateEnum = pgEnum(
  "identity_hmac_rotation_state",
  ["active", "rotation_previous"],
);

export const identityErasureSuppressionKindEnum = pgEnum(
  "identity_erasure_suppression_kind",
  ["email", "shopify_customer_id"],
);

export const shopifyEvidenceRunStatusEnum = pgEnum(
  "shopify_evidence_run_status",
  ["running", "success", "partial", "failed"],
);

export const shopifyEvidenceCapabilityEnum = pgEnum(
  "shopify_evidence_capability",
  ["unknown", "available", "unavailable"],
);

export const shopifyEvidenceCompletenessEnum = pgEnum(
  "shopify_evidence_completeness",
  ["unknown", "complete", "partial", "unavailable"],
);

export const shopifyOrderLines = pgTable(
  "shopify_order_line",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    orderId: text("order_id").notNull(),
    shopifyLineItemId: text("shopify_line_item_id").notNull(),
    shopifyProductId: text("shopify_product_id"),
    shopifyVariantId: text("shopify_variant_id"),
    sku: text("sku"),
    productTitle: text("product_title").notNull(),
    variantTitle: text("variant_title"),
    quantity: integer("quantity").notNull(),
    sourcePosition: integer("source_position"),
    parentOrderUpdatedAt: timestamp("parent_order_updated_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId, table.orderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
      name: "shopify_order_line_org_store_order_fk",
    }).onDelete("cascade"),
    unique("shopify_order_line_store_external_uniq").on(
      table.storeId,
      table.shopifyLineItemId,
    ),
    check("shopify_order_line_quantity_positive", sql`${table.quantity} > 0`),
    index("shopify_order_line_order_idx").on(table.orderId),
    index("shopify_order_line_store_product_idx").on(
      table.storeId,
      table.shopifyProductId,
    ),
    index("shopify_order_line_store_variant_idx").on(
      table.storeId,
      table.shopifyVariantId,
    ),
    index("shopify_order_line_store_sku_idx").on(table.storeId, table.sku),
  ],
);

export const sourceIdentityHmacs = pgTable(
  "source_identity_hmac",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    sourceKind: sourceIdentityKindEnum("source_kind").notNull(),
    shopifyOrderId: text("shopify_order_id").notNull(),
    keyVersion: text("key_version").notNull(),
    digest: text("digest").notNull(),
    rotationState: identityHmacRotationStateEnum("rotation_state").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId, table.shopifyOrderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
      name: "source_identity_hmac_shopify_order_fk",
    }).onDelete("cascade"),
    check(
      "source_identity_hmac_shopify_only",
      sql`${table.sourceKind} = 'shopify_order' and ${table.shopifyOrderId} is not null`,
    ),
    unique("source_identity_hmac_shopify_version_uniq").on(
      table.shopifyOrderId,
      table.keyVersion,
    ),
    unique("source_identity_hmac_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    unique("source_identity_hmac_scope_order_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.shopifyOrderId,
      table.id,
    ),
    index("source_identity_hmac_scope_digest_idx").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.digest,
    ),
  ],
);

export const identityErasureSuppressions = pgTable(
  "identity_erasure_suppression",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    kind: identityErasureSuppressionKindEnum("kind").notNull(),
    keyVersion: text("key_version").notNull(),
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
      name: "identity_erasure_suppression_org_store_fk",
    }).onDelete("cascade"),
    unique("identity_erasure_suppression_scope_digest_uniq").on(
      table.organizationId,
      table.storeId,
      table.kind,
      table.keyVersion,
      table.digest,
    ),
    unique("identity_erasure_suppression_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    index("identity_erasure_suppression_lookup_idx").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.kind,
      table.digest,
    ),
  ],
);

export const identityMatchingKeyBindings = pgTable(
  "identity_matching_key_binding",
  {
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    keyVersion: text("key_version").notNull(),
    keyCheck: text("key_check").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
      name: "identity_matching_key_binding_org_store_fk",
    }).onDelete("cascade"),
    unique("identity_matching_key_binding_scope_version_uniq").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
    ),
    unique("identity_matching_key_binding_scope_version_check_uniq").on(
      table.organizationId,
      table.storeId,
      table.keyVersion,
      table.keyCheck,
    ),
  ],
);

export const identityCryptoPolicies = pgTable(
  "identity_crypto_policy",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    matchingCurrentVersion: text("matching_current_version").notNull(),
    matchingCurrentKeyCheck: text("matching_current_key_check").notNull(),
    matchingPreviousVersion: text("matching_previous_version"),
    matchingPreviousKeyCheck: text("matching_previous_key_check"),
    suppressionVersion: text("suppression_version").notNull(),
    suppressionKeyCheck: text("suppression_key_check").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
      name: "identity_crypto_policy_org_store_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.organizationId,
        table.storeId,
        table.matchingCurrentVersion,
        table.matchingCurrentKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
      name: "identity_crypto_policy_current_binding_fk",
    }),
    foreignKey({
      columns: [
        table.organizationId,
        table.storeId,
        table.matchingPreviousVersion,
        table.matchingPreviousKeyCheck,
      ],
      foreignColumns: [
        identityMatchingKeyBindings.organizationId,
        identityMatchingKeyBindings.storeId,
        identityMatchingKeyBindings.keyVersion,
        identityMatchingKeyBindings.keyCheck,
      ],
      name: "identity_crypto_policy_previous_binding_fk",
    }),
    unique("identity_crypto_policy_org_store_uniq").on(
      table.organizationId,
      table.storeId,
    ),
    check(
      "identity_crypto_policy_previous_pair",
      sql`(${table.matchingPreviousVersion} is null) = (${table.matchingPreviousKeyCheck} is null)`,
    ),
    check(
      "identity_crypto_policy_versions_distinct",
      sql`${table.matchingPreviousVersion} is null or ${table.matchingPreviousVersion} <> ${table.matchingCurrentVersion}`,
    ),
  ],
);

export const shopifyEvidenceSyncRuns = pgTable(
  "shopify_evidence_sync_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    startTriggerRunId: text("start_trigger_run_id").notNull(),
    firstBatchTriggerRunId: text("first_batch_trigger_run_id"),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    mode: text("mode").notNull(),
    storeTimezone: text("store_timezone").notNull(),
    anchorStoreDay: text("anchor_store_day").notNull(),
    requestedFrom: timestamp("requested_from").notNull(),
    requestedTo: timestamp("requested_to").notNull(),
    cursor: text("cursor"),
    status: shopifyEvidenceRunStatusEnum("status").default("running").notNull(),
    identityCapability: shopifyEvidenceCapabilityEnum("identity_capability")
      .default("unknown")
      .notNull(),
    lineCompleteness: shopifyEvidenceCompletenessEnum("line_completeness")
      .default("unknown")
      .notNull(),
    ordersRead: integer("orders_read").default(0).notNull(),
    ordersEnriched: integer("orders_enriched").default(0).notNull(),
    ordersPartial: integer("orders_partial").default(0).notNull(),
    ordersUnavailable: integer("orders_unavailable").default(0).notNull(),
    warnings: integer("warnings").default(0).notNull(),
    failures: integer("failures").default(0).notNull(),
    error: text("error"),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
      name: "shopify_evidence_sync_run_org_store_fk",
    }).onDelete("cascade"),
    check(
      "shopify_evidence_sync_run_window_valid",
      sql`${table.requestedFrom} < ${table.requestedTo}`,
    ),
    check(
      "shopify_evidence_sync_run_mode_check",
      sql`${table.mode} in ('initial_90d', 'incremental_7d')`,
    ),
    unique("shopify_evidence_sync_run_start_trigger_uniq").on(
      table.startTriggerRunId,
    ),
    unique("shopify_evidence_sync_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    uniqueIndex("shopify_evidence_sync_run_one_running_store_uidx")
      .on(table.storeId)
      .where(sql`${table.status} = 'running'`),
    index("shopify_evidence_sync_run_scope_started_idx").on(
      table.organizationId,
      table.storeId,
      table.startedAt,
    ),
  ],
);

export const shopifyEvidenceRunObservations = pgTable(
  "shopify_evidence_run_observation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    evidenceRunId: text("evidence_run_id").notNull(),
    orderId: text("order_id").notNull(),
    lineDisposition: text("line_disposition").notNull(),
    identityDisposition: text("identity_disposition").notNull(),
    observedContentChecksum: text("observed_content_checksum").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.storeId, table.evidenceRunId],
      foreignColumns: [
        shopifyEvidenceSyncRuns.organizationId,
        shopifyEvidenceSyncRuns.storeId,
        shopifyEvidenceSyncRuns.id,
      ],
      name: "shopify_evidence_observation_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.storeId, table.orderId],
      foreignColumns: [
        shopifyOrders.organizationId,
        shopifyOrders.storeId,
        shopifyOrders.id,
      ],
      name: "shopify_evidence_observation_order_fk",
    }).onDelete("cascade"),
    check(
      "shopify_evidence_observation_line_disposition_check",
      sql`${table.lineDisposition} in ('complete', 'preserved_partial')`,
    ),
    check(
      "shopify_evidence_observation_identity_disposition_check",
      sql`${table.identityDisposition} in ('available', 'unavailable', 'not_refreshed', 'suppressed')`,
    ),
    unique("shopify_evidence_observation_scope_run_order_uniq").on(
      table.organizationId,
      table.storeId,
      table.evidenceRunId,
      table.orderId,
    ),
    index("shopify_evidence_observation_run_order_idx").on(
      table.organizationId,
      table.storeId,
      table.evidenceRunId,
      table.orderId,
    ),
  ],
);

export const shopifyEvidenceRunIdentityObservations = pgTable(
  "shopify_evidence_run_identity_observation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    storeId: text("store_id").notNull(),
    evidenceRunId: text("evidence_run_id").notNull(),
    orderId: text("order_id").notNull(),
    identityHmacId: text("identity_hmac_id").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.organizationId,
        table.storeId,
        table.evidenceRunId,
        table.orderId,
      ],
      foreignColumns: [
        shopifyEvidenceRunObservations.organizationId,
        shopifyEvidenceRunObservations.storeId,
        shopifyEvidenceRunObservations.evidenceRunId,
        shopifyEvidenceRunObservations.orderId,
      ],
      name: "shopify_evidence_identity_observation_content_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.organizationId,
        table.storeId,
        table.orderId,
        table.identityHmacId,
      ],
      foreignColumns: [
        sourceIdentityHmacs.organizationId,
        sourceIdentityHmacs.storeId,
        sourceIdentityHmacs.shopifyOrderId,
        sourceIdentityHmacs.id,
      ],
      name: "shopify_evidence_identity_observation_hmac_fk",
    }).onDelete("cascade"),
    unique("shopify_evidence_identity_observation_run_order_uniq").on(
      table.storeId,
      table.evidenceRunId,
      table.orderId,
    ),
    index("shopify_evidence_identity_observation_run_idx").on(
      table.organizationId,
      table.storeId,
      table.evidenceRunId,
    ),
  ],
);

export const shopifyOrderLineRelations = relations(
  shopifyOrderLines,
  ({ one }) => ({
    order: one(shopifyOrders, {
      fields: [shopifyOrderLines.orderId],
      references: [shopifyOrders.id],
    }),
  }),
);

export const sourceIdentityHmacRelations = relations(
  sourceIdentityHmacs,
  ({ one }) => ({
    order: one(shopifyOrders, {
      fields: [sourceIdentityHmacs.shopifyOrderId],
      references: [shopifyOrders.id],
    }),
  }),
);

export const shopifyEvidenceSyncRunRelations = relations(
  shopifyEvidenceSyncRuns,
  ({ one, many }) => ({
    store: one(shopifyStores, {
      fields: [shopifyEvidenceSyncRuns.storeId],
      references: [shopifyStores.id],
    }),
    observations: many(shopifyEvidenceRunObservations),
    identityObservations: many(shopifyEvidenceRunIdentityObservations),
  }),
);

export const shopifyEvidenceRunObservationRelations = relations(
  shopifyEvidenceRunObservations,
  ({ one, many }) => ({
    run: one(shopifyEvidenceSyncRuns, {
      fields: [shopifyEvidenceRunObservations.evidenceRunId],
      references: [shopifyEvidenceSyncRuns.id],
    }),
    order: one(shopifyOrders, {
      fields: [shopifyEvidenceRunObservations.orderId],
      references: [shopifyOrders.id],
    }),
    identityObservations: many(shopifyEvidenceRunIdentityObservations),
  }),
);

export const shopifyEvidenceRunIdentityObservationRelations = relations(
  shopifyEvidenceRunIdentityObservations,
  ({ one }) => ({
    observation: one(shopifyEvidenceRunObservations, {
      fields: [
        shopifyEvidenceRunIdentityObservations.organizationId,
        shopifyEvidenceRunIdentityObservations.storeId,
        shopifyEvidenceRunIdentityObservations.evidenceRunId,
        shopifyEvidenceRunIdentityObservations.orderId,
      ],
      references: [
        shopifyEvidenceRunObservations.organizationId,
        shopifyEvidenceRunObservations.storeId,
        shopifyEvidenceRunObservations.evidenceRunId,
        shopifyEvidenceRunObservations.orderId,
      ],
    }),
    identity: one(sourceIdentityHmacs, {
      fields: [shopifyEvidenceRunIdentityObservations.identityHmacId],
      references: [sourceIdentityHmacs.id],
    }),
  }),
);
```

`observedContentChecksum` is an immutable, identity-free SHA-256 over canonical JSON for the exact matcher-visible non-identity snapshot committed for that order: internal/external order identifier candidates, order timestamp, canonically ordered line ID/product/variant/SKU/quantity/null fields, and the two safe dispositions. It excludes customer ID, every HMAC/digest or digest-derived verifier, revenue, refunds, buckets, attribution fields, and raw email. Canonical arrays have explicit sort keys and canonical nulls.

When fresh current-version email identity exists, `shopify_evidence_run_identity_observation` links the exact run/order observation to the exact `source_identity_hmac` row; it stores no digest, checksum, customer ID, or provider value. Identity HMAC rows are immutable per source/version: exact same-digest replay reuses the row ID, while a changed digest deletes/reinserts a fresh row so dependent observations cascade rather than silently changing meaning. Erasure, uninstall cleanup, and rotation pruning delete digest rows and therefore automatically delete every identity observation that depended on them. Customer ID remains an erasable inspector field and is not a matcher input. Both observation shapes are inserted only in the same transaction that finishes that order's evidence write and advances the run checkpoint. Replay of the same run/order must reproduce the same content checksum/dispositions and identity-row link; disagreement fails closed rather than rewriting history.

`identity_matching_key_binding` is the store-owned append-only lifetime registry for matching-key labels. First use inserts `(organization, store, version, fixed-context key check)`; exact same-check replay is allowed, but the application exposes no update/delete path and any historical same-label/different-check attempt fails before calls/writes. It survives connector uninstall and retired-row pruning, cascading only with the store/organization. `identity_crypto_policy` references registry-backed current/previous pairs and represents only the active write set. It is initialized/validated under the store lock before any protected-identity remote fetch or write. Plan 1 may initialize it only from a current-only keyring; the pure crypto primitive understands a previous key for later Plan 3, but ordinary Plan 1 persistence rejects previous-key activation because no durable rotation graph exists yet. Plan 3 alone changes the matching current/previous pair atomically with its connection gate. The stable suppression version/check survives matching rotation and connector uninstall. Both rows are excluded from matching, reports, UI, and aggregate fingerprints.

`identity_erasure_suppression` is a compliance control, not source evidence. It contains only tenant/store-scoped, domain-separated HMACs under the stable suppression key. It has no relation to match runs and is excluded from fingerprints, reports, inspector output, ordinary logs, and the 90-day source window. Subject erasure validates `identity_crypto_policy`, upserts suppressions before deleting identity, and evidence commits check candidate HMACs while holding the same scoped store lock. A hit actively clears current pilot identity and records `identityDisposition: "suppressed"` while retaining identity-free order/line evidence. Suppression rows survive pilot uninstall and matching-key rotation, and cascade only with their store/organization unless an explicit compliance release removes an exact tombstone.

- [ ] **Step 5: Put all legacy ownership preflights before every 0053 mutation**

Run this read-only query against the target database:

```sql
SELECT s.id, s.organization_id, s.shop_domain
FROM shopify_store AS s
LEFT JOIN organization AS o ON o.id = s.organization_id
WHERE o.id IS NULL;
```

Expected: 0 rows. If rows exist, stop; do not delete or reassign them as part of this plan.

At the absolute start of 0053, before creating an enum/table, adding `shopify_customer_id`, adding a unique, or dropping a legacy foreign key, fail closed when any of these exist:

- a `shopify_store.organization_id` with no organization;
- a `shopify_order` whose organization differs from its referenced store;
- a `shopify_refund` whose organization/store differs from its referenced order;
- a `shopify_sync_run` whose organization differs from its referenced store;
- a nonnull-store `finding` whose organization differs from its referenced store.

Each failure raises a fixed safe migration error and leaves all five exact legacy constraints plus the entire pre-0053 catalog unchanged. After all preflights pass, add the parent composite uniques before dependent foreign keys, drop the exact 0052 constraint names, and install the four named scoped replacements. No automatic data repair is allowed.

- [ ] **Step 6: Generate migration 0053**

Run: `bun run db:generate --name klaviyo_shopify_evidence`

Expected: Drizzle creates `drizzle/0053_klaviyo_shopify_evidence.sql`, `drizzle/meta/0053_snapshot.json`, and one journal entry.

- [ ] **Step 7: Inspect the generated SQL**

Confirm all of these are present exactly once:

- `shopify_order.shopify_customer_id`
- `shopify_order_store_customer_idx` on `(store_id, shopify_customer_id)`
- `shopify_evidence_sync_run.mode`, immutable `store_timezone`, and immutable `anchor_store_day`
- unique `shopify_evidence_sync_run.start_trigger_run_id`, nullable first-batch Trigger handle, running heartbeat, and one-running-run-per-store partial unique index
- `shopify_store.organization_id → organization.id ON DELETE CASCADE`
- parent composite unique constraints
- top-of-file fail-closed ownership preflights before every mutation
- exact removal of the five legacy single-column/independent foreign keys and installation of `shopify_order_org_store_fk`, `shopify_refund_org_store_order_fk`, `shopify_sync_run_org_store_fk`, and `finding_org_store_fk`
- all eight new tables, including `identity_matching_key_binding`, `identity_crypto_policy`, `identity_erasure_suppression`, `shopify_evidence_run_observation`, and `shopify_evidence_run_identity_observation`
- the positive quantity, valid-window, and closed evidence-mode checks
- the Shopify-only source check
- composite tenant foreign keys and cascades
- no `DROP TABLE`, no update to monetary values, and no change to `net_sales`, refund amount, bucket, bucket rule, Meta verification, cancellation, source, or customer journey columns

Run: `git diff -- drizzle/0053_klaviyo_shopify_evidence.sql drizzle/meta/0053_snapshot.json drizzle/meta/_journal.json src/schema/shopify.ts src/schema/shopify-evidence.ts`

Expected: only the Plan 1 additions listed above.

- [ ] **Step 8: Apply 0053 to the disposable minimal pre-0053 database**

The repository's clean historical replay is already blocked before this task by the known 0010/0011 `ad_account` duplication. Do not modify historical migrations or claim a full replay. Apply the actual 0053 statements to the minimal pre-0053 integration fixture and a disposable equivalent database; expect all preflights to pass, all eight evidence tables to exist, and the scoped replacement constraints to appear in the PostgreSQL catalog.

- [ ] **Step 9: Run schema and monetary tests**

Run: `bun run test -- src/lib/shopify-store.integration.test.ts src/lib/shopify-evidence-schema.test.ts src/lib/shopify-ingest.test.ts`

Expected: PASS; the evidence constraints reject invalid rows and monetary characterization remains green.

- [ ] **Step 10: Commit schema and migration**

```bash
git add src/schema/shopify.ts src/schema/finding.ts src/schema/shopify-evidence.ts src/lib/shopify-store.integration.test.ts src/lib/shopify-evidence-schema.test.ts drizzle/0053_klaviyo_shopify_evidence.sql drizzle/meta/0053_snapshot.json drizzle/meta/_journal.json docs/superpowers/specs/2026-07-31-klaviyo-shopify-evidence-pilot-design.md docs/superpowers/plans/2026-07-31-klaviyo-01-shopify-evidence-foundation.md
git commit -m "feat(shopify): add evidence persistence schema"
```

## Task 5: Fetch complete Shopify line evidence and optional protected identity

**Files:**
- Create: `src/lib/shopify-evidence-admin.ts`
- Create: `src/lib/shopify-evidence-admin.test.ts`
- Read only: `src/lib/shopify-admin.ts`

- [ ] **Step 1: Write line-pagination failure tests**

Create `src/lib/shopify-evidence-admin.test.ts` with a `vi.fn()` implementing the stable `ShopifyGraphql` interface. Add these tests first:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ShopifyGraphql } from "@/lib/shopify-evidence-admin";
import {
  IncompleteShopifyLineSetError,
  fetchCompleteShopifyOrderLines,
  isRetryableShopifyLineFailure,
} from "@/lib/shopify-evidence-admin";

describe("fetchCompleteShopifyOrderLines", () => {
  it("assembles every line page before returning a complete set", async () => {
    const graphql = vi
      .fn<ShopifyGraphql>()
      .mockResolvedValueOnce({
        node: {
          id: "gid://shopify/Order/1",
          updatedAt: "2026-07-31T01:00:00Z",
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/1",
                product: { id: "gid://shopify/Product/1" },
                variant: { id: "gid://shopify/ProductVariant/1" },
                sku: "SKU-1",
                title: "One",
                variantTitle: "Small",
                quantity: 1,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          id: "gid://shopify/Order/1",
          updatedAt: "2026-07-31T01:00:00Z",
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/2",
                product: null,
                variant: null,
                sku: null,
                title: "Custom item",
                variantTitle: null,
                quantity: 2,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

    const result = await fetchCompleteShopifyOrderLines(
      graphql,
      "gid://shopify/Order/1",
    );

    expect(result.completeness).toBe("complete");
    expect(result.lines.map((line) => line.shopifyLineItemId)).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
    expect(result.lines.map((line) => line.sourcePosition)).toEqual([0, 1]);
    expect(graphql).toHaveBeenNthCalledWith(2, expect.any(String), {
      orderId: "gid://shopify/Order/1",
      cursor: "cursor-1",
    });
  });

  it("rejects a non-progressing cursor", async () => {
    const graphql = vi.fn<ShopifyGraphql>().mockResolvedValue({
      node: {
        id: "gid://shopify/Order/1",
        updatedAt: "2026-07-31T01:00:00Z",
        lineItems: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    });
    await expect(
      fetchCompleteShopifyOrderLines(graphql, "gid://shopify/Order/1"),
    ).rejects.toBeInstanceOf(IncompleteShopifyLineSetError);
  });

  it("returns no complete set when a later page fails", async () => {
    const graphql = vi
      .fn<ShopifyGraphql>()
      .mockResolvedValueOnce({
        node: {
          id: "gid://shopify/Order/1",
          updatedAt: "2026-07-31T01:00:00Z",
          lineItems: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      })
      .mockRejectedValueOnce(new Error("remote page failed"));
    await expect(
      fetchCompleteShopifyOrderLines(graphql, "gid://shopify/Order/1"),
    ).rejects.toThrow("remote page failed");
  });

  it("classifies transport failures for task retry but deterministic invalid sets as terminal", () => {
    expect(isRetryableShopifyLineFailure(new Error("network reset"))).toBe(true);
    expect(
      isRetryableShopifyLineFailure(
        new IncompleteShopifyLineSetError("Shopify line cursor did not advance"),
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Write protected-identity degradation tests**

In the same file, add:

```ts
import {
  fetchShopifyIdentityEvidence,
  probeShopifyEvidenceCapabilities,
} from "@/lib/shopify-evidence-admin";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";

const keyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: Buffer.alloc(32, 4).toString("base64url"),
  IDENTITY_HMAC_KEY_VERSION: "v1",
});
const suppressionKey = parseErasureSuppressionKey({
  IDENTITY_ERASURE_HMAC_SECRET: Buffer.alloc(32, 6).toString("base64url"),
  IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
});

describe("fetchShopifyIdentityEvidence", () => {
  it("returns customer ID and digests without returning plaintext email", async () => {
    const graphql = vi.fn<ShopifyGraphql>().mockResolvedValue({
      node: {
        id: "gid://shopify/Order/1",
        email: "Person@Example.com",
        customer: { id: "gid://shopify/Customer/1" },
      },
    });
    const result = await fetchShopifyIdentityEvidence({
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring,
      suppressionKey,
    });
    expect(result.status).toBe("available");
    expect(JSON.stringify(result)).not.toContain("Person@Example.com");
    if (result.status === "available") {
      expect(result.shopifyCustomerId).toBe("gid://shopify/Customer/1");
      expect(result.digests).toHaveLength(1);
      expect(result.evaluatedKeyVersions).toEqual(["v1"]);
    }
  });

  it("degrades identity without changing the line-fetch contract", async () => {
    const graphql = vi.fn<ShopifyGraphql>().mockRejectedValue(
      new Error("Access denied for customer field"),
    );
    await expect(
      fetchShopifyIdentityEvidence({
        graphql,
        shopifyOrderId: "gid://shopify/Order/1",
        scope: { organizationId: "org_a", storeId: "store_a" },
        keyring,
        suppressionKey,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "protected_identity_unavailable",
    });
  });
});

describe("probeShopifyEvidenceCapabilities", () => {
  it("distinguishes read_orders from the read_all_orders historical grant");
  it("reports a missing read_all_orders grant as unavailable without throwing");
  it("does not treat read_customers as proof that protected identity is readable");
});
```

- [ ] **Step 3: Run the evidence-client tests to verify they fail**

Run: `bun run test -- src/lib/shopify-evidence-admin.test.ts`

Expected: FAIL because `shopify-evidence-admin.ts` does not exist.

- [ ] **Step 4: Implement the evidence client types and queries**

Create `src/lib/shopify-evidence-admin.ts` with these public types:

```ts
import "server-only";
import {
  computeErasureSuppressionDigests,
  computeIdentityCryptoKeyChecks,
  computeIdentityDigests,
  type ErasureSuppressionDigest,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
  type IdentityCryptoKeyChecks,
  type IdentityScope,
  type VersionedIdentityDigest,
} from "@/lib/identity-hmac";

export interface ShopifyGraphql {
  <T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

export type NormalizedShopifyOrderLine = {
  shopifyLineItemId: string;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  sku: string | null;
  productTitle: string;
  variantTitle: string | null;
  quantity: number;
  sourcePosition: number;
};

export type CompleteShopifyLineSet = {
  completeness: "complete";
  shopifyOrderId: string;
  orderUpdatedAt: Date;
  lines: NormalizedShopifyOrderLine[];
};

export type NormalizedShopifyIdentityEvidence =
  | {
      status: "available";
      shopifyCustomerId: string | null;
      digests: VersionedIdentityDigest[];
      suppressionCandidates: ErasureSuppressionDigest[];
      keyChecks: IdentityCryptoKeyChecks;
      evaluatedKeyVersions: string[];
    }
  | {
      status: "unavailable";
      reason: "protected_identity_unavailable";
    };

export type ShopifyEvidenceCapabilities = {
  orderScope: "available" | "unavailable";
  historicalOrders: "available" | "unavailable";
  identityScope: "declared" | "missing";
  scopes: string[];
};

export class IncompleteShopifyLineSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteShopifyLineSetError";
  }
}

/**
 * A deterministic incomplete source set is safe to record as partial. Remote
 * transport/API failures must escape so Trigger.dev can replay from the last
 * committed order cursor. No provider error text is persisted by this helper.
 */
export function isRetryableShopifyLineFailure(error: unknown): boolean {
  return !(error instanceof IncompleteShopifyLineSetError);
}
```

Add these query constants:

```ts
const ORDER_LINE_PAGE_QUERY = `
  query ShopifyEvidenceOrderLines($orderId: ID!, $cursor: String) {
    node(id: $orderId) {
      ... on Order {
        id
        updatedAt
        lineItems(first: 250, after: $cursor) {
          nodes {
            id
            product { id }
            variant { id }
            sku
            title
            variantTitle
            quantity
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const ORDER_IDENTITY_QUERY = `
  query ShopifyEvidenceOrderIdentity($orderId: ID!) {
    node(id: $orderId) {
      ... on Order {
        id
        email
        customer { id }
      }
    }
  }
`;

const ACCESS_SCOPES_QUERY = `
  query ShopifyEvidenceAccessScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;
```

Implement `probeShopifyEvidenceCapabilities` by reading the exact returned scope handles. `orderScope` is available only with `read_orders`, `historicalOrders` only with `read_all_orders`, and `identityScope` is declared only with `read_customers`. Return a closed safe state for absent grants instead of throwing a retryable access-denied error. This is a preflight hint, not proof of protected-field access; only the identity query proves that. Keep the raw scope array in the in-memory result for the start decision only; never persist or log it.

- [ ] **Step 5: Implement complete line pagination**

Use this cursor loop. It returns only after every page is assembled and validated:

```ts
export async function fetchCompleteShopifyOrderLines(
  graphql: ShopifyGraphql,
  shopifyOrderId: string,
): Promise<CompleteShopifyLineSet> {
  const lines: NormalizedShopifyOrderLine[] = [];
  const seenCursors = new Set<string>();
  const seenLineIds = new Set<string>();
  let cursor: string | null = null;
  let orderUpdatedAt: Date | null = null;

  while (true) {
    const data = await graphql<{
      node: {
        id: string;
        updatedAt: string;
        lineItems: {
          nodes: Array<{
            id: string;
            product: { id: string } | null;
            variant: { id: string } | null;
            sku: string | null;
            title: string;
            variantTitle: string | null;
            quantity: number;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    }>(ORDER_LINE_PAGE_QUERY, { orderId: shopifyOrderId, cursor });

    if (!data.node || data.node.id !== shopifyOrderId) {
      throw new IncompleteShopifyLineSetError("Shopify order was missing or changed identity");
    }
    const updatedAt = new Date(data.node.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      throw new IncompleteShopifyLineSetError("Shopify order returned an invalid updatedAt");
    }
    orderUpdatedAt ??= updatedAt;
    if (orderUpdatedAt.getTime() !== updatedAt.getTime()) {
      throw new IncompleteShopifyLineSetError("Shopify order changed during line pagination");
    }

    for (const node of data.node.lineItems.nodes) {
      if (node.quantity <= 0 || seenLineIds.has(node.id)) {
        throw new IncompleteShopifyLineSetError("Shopify line page was invalid or duplicated");
      }
      seenLineIds.add(node.id);
      lines.push({
        shopifyLineItemId: node.id,
        shopifyProductId: node.product?.id ?? null,
        shopifyVariantId: node.variant?.id ?? null,
        sku: node.sku?.trim() || null,
        productTitle: node.title,
        variantTitle: node.variantTitle ?? null,
        quantity: node.quantity,
        sourcePosition: lines.length,
      });
    }

    const pageInfo = data.node.lineItems.pageInfo;
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor || seenCursors.has(pageInfo.endCursor)) {
      throw new IncompleteShopifyLineSetError("Shopify line cursor did not advance");
    }
    seenCursors.add(pageInfo.endCursor);
    cursor = pageInfo.endCursor;
  }

  if (!orderUpdatedAt) {
    throw new IncompleteShopifyLineSetError("Shopify order returned no snapshot timestamp");
  }
  return {
    completeness: "complete",
    shopifyOrderId,
    orderUpdatedAt,
    lines,
  };
}
```

- [ ] **Step 6: Implement immediate identity normalization**

Implement the identity function so the raw response is local and never returned or logged:

```ts
export async function fetchShopifyIdentityEvidence(params: {
  graphql: ShopifyGraphql;
  shopifyOrderId: string;
  scope: IdentityScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): Promise<NormalizedShopifyIdentityEvidence> {
  const keyChecks = computeIdentityCryptoKeyChecks({
    scope: params.scope,
    keyring: params.keyring,
    suppressionKey: params.suppressionKey,
  });
  try {
    const data = await params.graphql<{
      node: {
        id: string;
        email: string | null;
        customer: { id: string } | null;
      } | null;
    }>(ORDER_IDENTITY_QUERY, { orderId: params.shopifyOrderId });
    if (!data.node || data.node.id !== params.shopifyOrderId) {
      return { status: "unavailable", reason: "protected_identity_unavailable" };
    }
    const evaluatedKeyVersions = [
      params.keyring.current.version,
      ...(params.keyring.previous ? [params.keyring.previous.version] : []),
    ];
    return {
      status: "available",
      shopifyCustomerId: data.node.customer?.id ?? null,
      digests: data.node.email !== null
        ? computeIdentityDigests({
            scope: params.scope,
            email: data.node.email,
            keyring: params.keyring,
          })
        : [],
      suppressionCandidates: computeErasureSuppressionDigests({
        scope: params.scope,
        key: params.suppressionKey,
        email: data.node.email,
        shopifyCustomerId: data.node.customer?.id,
      }),
      keyChecks,
      evaluatedKeyVersions,
    };
  } catch {
    return { status: "unavailable", reason: "protected_identity_unavailable" };
  }
}
```

The raw email and customer ID exist only inside this function. Unit tests must prove the returned `suppressionCandidates` are HMAC-only, cover both available aliases, remain store-scoped, and contain neither source value nor either secret. `email: ""` is present and produces matching/suppression HMACs; only null/absent suppression aliases are omitted. Compute the combined non-secret key checks before entering the provider `try` or calling `params.graphql`, so all combined configuration/root-independence validation occurs before the protected remote request. Test suppression-root reuse against both current and previous matching roots: each error must escape with `graphql` uncalled. Do not convert either into the ordinary capability-unavailable branch.

- [ ] **Step 7: Run evidence-client and monetary-boundary tests**

Run: `bun run test -- src/lib/shopify-evidence-admin.test.ts src/lib/shopify-ingest.test.ts`

Expected: PASS. The evidence query paginates independently while the monetary query still excludes line and identity fields.

- [ ] **Step 8: Commit the Shopify evidence client**

```bash
git add src/lib/shopify-evidence-admin.ts src/lib/shopify-evidence-admin.test.ts
git commit -m "feat(shopify): fetch complete isolated order evidence"
```

## Task 6: Persist complete evidence transactionally

**Files:**
- Create: `src/lib/evidence-window.ts`
- Create: `src/lib/evidence-window.test.ts`
- Create: `src/lib/shopify-evidence-store.ts`
- Create: `src/lib/shopify-evidence.integration.test.ts`

- [ ] **Step 1: Write complete-only replacement tests**

Create the disposable PostgreSQL fixture in `src/lib/shopify-evidence.integration.test.ts`, apply migration 0053, mock `@/db` to the disposable Drizzle client, and seed one organization/store/order. Add these tests:

```ts
describeIfDb("Shopify evidence persistence", () => {
  it("replaces a complete line set and removes stale lines", async () => {
    await replaceCompleteShopifyLineSet(scope, firstCompleteSet);
    await replaceCompleteShopifyLineSet(scope, secondCompleteSet);
    expect(await listStoredLineExternalIds("order_internal_1")).toEqual([
      "gid://shopify/LineItem/2",
    ]);
  });

  it("accepts a complete empty set and clears previous lines", async () => {
    await replaceCompleteShopifyLineSet(scope, firstCompleteSet);
    await replaceCompleteShopifyLineSet(scope, {
      completeness: "complete",
      shopifyOrderId: "gid://shopify/Order/1",
      orderUpdatedAt: new Date("2026-07-31T03:00:00Z"),
      lines: [],
    });
    expect(await listStoredLineExternalIds("order_internal_1")).toEqual([]);
  });

  it("rolls back deletion when insertion fails", async () => {
    await replaceCompleteShopifyLineSet(scope, firstCompleteSet);
    await expect(
      replaceCompleteShopifyLineSet(scope, {
        completeness: "complete",
        shopifyOrderId: "gid://shopify/Order/1",
        orderUpdatedAt: new Date("2026-07-31T03:00:00Z"),
        lines: [
          {
            shopifyLineItemId: "gid://shopify/LineItem/3",
            shopifyProductId: null,
            shopifyVariantId: null,
            sku: null,
            productTitle: "Invalid",
            variantTitle: null,
            quantity: 0,
            sourcePosition: 0,
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await listStoredLineExternalIds("order_internal_1")).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
  });

  it("preserves identity when protected access is unavailable", async () => {
    await persistShopifyIdentityEvidence(scope, "gid://shopify/Order/1", {
      status: "available",
      shopifyCustomerId: "gid://shopify/Customer/1",
      digests: [
        { keyVersion: "v1", digest: "digest-v1", rotationState: "active" },
      ],
      suppressionCandidates: [
        { kind: "email", keyVersion: "e1", digest: "suppression-email" },
        {
          kind: "shopify_customer_id",
          keyVersion: "e1",
          digest: "suppression-customer",
        },
      ],
      keyChecks: TEST_IDENTITY_CRYPTO_KEY_CHECKS,
      evaluatedKeyVersions: ["v1"],
    });
    await persistShopifyIdentityEvidence(scope, "gid://shopify/Order/1", {
      status: "unavailable",
      reason: "protected_identity_unavailable",
    });
    expect(await readStoredIdentity("order_internal_1")).toEqual({
      shopifyCustomerId: "gid://shopify/Customer/1",
      versions: ["v1"],
    });
  });
});
```

Define `scope`, `firstCompleteSet`, `secondCompleteSet`, `TEST_IDENTITY_CRYPTO_KEY_CHECKS`, `listStoredLineExternalIds`, and `readStoredIdentity` in that test file with fixed fixture values; do not use snapshots containing digest values.

Add crypto-policy cases proving current-only first use atomically inserts one lifetime matching-key binding plus one policy row; exact same-check replay succeeds; same labels with a different matching or suppression secret fail before identity writes; deleting/pruning active digest rows does not delete the lifetime binding; previous-key configuration is rejected in Plan 1 persistence; another store is isolated; and a suppression candidate computed under a same-version/different secret can never bypass the policy. Race initialization and require one identical winner. These tests assert safe codes/counts only and never snapshot key checks.

Also test the production per-order commit boundary: line replacement, suppression check, identity write, identity-free content observation, optional exact-digest-row identity observation, and cursor/count/heartbeat checkpoint either all commit or all roll back; replay of the same run/order/content/link is idempotent; a different replay checksum/link fails closed; cross-run/store/order/digest membership fails; a later failed evidence run may change current rows but cannot change an older run's observations; same-digest replay reuses the HMAC row ID; changed digest replaces it and cascades dependent identity observations; and no observation contains plaintext identity, customer ID, either HMAC family, a digest-derived checksum, monetary values, or previous-version digest data. Delete a digest through subject erasure, pilot uninstall, and rotation-prune fixtures and prove its identity-observation rows disappear while identity-free content observations remain. Seed a suppression before commit and race suppression insertion/erasure against commit under the shared store lock. Erasure-first makes that new run commit `suppressed`; commit-first preserves the immutable historical content observation/disposition but erasure cascades its identity link, makes dependent publication stale, and the next run records `suppressed`. Both schedules end with no customer ID, matching digest, or identity resurrection while lines/checkpoints remain coherent.

- [ ] **Step 2: Run persistence tests to verify missing exports**

Run: `bun run test -- src/lib/shopify-evidence.integration.test.ts`

Expected: FAIL because `shopify-evidence-store.ts` does not exist.

- [ ] **Step 3: Implement the repository contract and scoped lookup**

Create `src/lib/evidence-window.ts` with the stable contract:

```ts
export type HalfOpenWindow = {
  from: Date;
  to: Date;
};

export type ShopifyEvidenceMode = "initial_90d" | "incremental_7d";

export function assertValidStoreDay(value: string): void;
export function assertValidIanaTimezone(value: string): void;

export function deriveShopifyEvidenceWindow(input: {
  mode: ShopifyEvidenceMode;
  anchorStoreDay: string;
  timeZone: string;
}): HalfOpenWindow;

export function inclusiveStoreDaysToHalfOpenUtc(input: {
  dateFrom: string;
  dateTo: string;
  timeZone: string;
}): HalfOpenWindow;
```

`assertValidStoreDay` accepts only a real canonical `YYYY-MM-DD` day, and `assertValidIanaTimezone` must construct and round-trip an `Intl.DateTimeFormat` for that exact zone. `deriveShopifyEvidenceWindow` calls both validators, applies calendar-day subtraction for its closed mode, and delegates conversion to `inclusiveStoreDaysToHalfOpenUtc`. Accept only real dates with `dateFrom <= dateTo`. Convert local midnight at `dateFrom` and local midnight on the calendar day after `dateTo` independently through `Intl.DateTimeFormat`, then round-trip each result in the requested zone. Do not parse the dates as UTC first, add a fixed offset, depend on the process timezone, or assume every day has 24 hours.

In `src/lib/evidence-window.test.ts`, assert at minimum:

```ts
it("converts the 2026 New York spring-forward day to 23 hours");
it("converts the 2026 New York fall-back day to 25 hours");
it("converts an ordinary Manila inclusive range to next-day exclusive UTC");
it("rejects malformed, impossible, reversed, and invalid-timezone input");
```

The New York cases are `2026-03-08T05:00:00.000Z` to `2026-03-09T04:00:00.000Z` and `2026-11-01T04:00:00.000Z` to `2026-11-02T05:00:00.000Z`.

Create `src/lib/shopify-evidence-store.ts` with these public contracts:

```ts
import "server-only";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assertValidIanaTimezone,
  assertValidStoreDay,
  deriveShopifyEvidenceWindow,
  type HalfOpenWindow,
  type ShopifyEvidenceMode,
} from "@/lib/evidence-window";
import type { IdentityScope } from "@/lib/identity-hmac";
import type {
  CompleteShopifyLineSet,
  NormalizedShopifyIdentityEvidence,
} from "@/lib/shopify-evidence-admin";
import {
  shopifyEvidenceRunIdentityObservations,
  shopifyEvidenceRunObservations,
  shopifyEvidenceSyncRuns,
  shopifyOrderLines,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";

export type EvidenceOrderCursor = {
  orderCreatedAt: Date;
  id: string;
};

export type EvidenceOrderBatch = {
  orders: Array<{
    id: string;
    shopifyOrderId: string;
    orderCreatedAt: Date;
  }>;
  nextCursor: EvidenceOrderCursor | null;
};

export async function loadEvidenceStore(scope: IdentityScope) {
  const [store] = await db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      currency: shopifyStores.currency,
    })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.id, scope.storeId),
        eq(shopifyStores.organizationId, scope.organizationId),
      ),
    )
    .limit(1);
  if (!store) throw new Error("Shopify evidence store binding was not found");
  return store;
}
```

Implement `listEvidenceOrderBatch` with `organizationId`, `storeId`, and half-open `orderCreatedAt >= from AND orderCreatedAt < to`; order by `(orderCreatedAt, id)` ascending and use that tuple as the cursor. Use a default batch limit of 25 and a hard maximum of 100.

Also export `countEvidenceOrders(scope, window)`. It applies the same full-scope and half-open predicates and returns an integer count without loading order identifiers. The start task uses it only to make a required-capability denial measurable; it is a local PostgreSQL read, not a Shopify request.

Use this implementation:

```ts
export async function listEvidenceOrderBatch(
  scope: IdentityScope,
  window: HalfOpenWindow,
  cursor: EvidenceOrderCursor | null,
  requestedLimit = 25,
): Promise<EvidenceOrderBatch> {
  if (window.from >= window.to) throw new Error("Evidence window must be half-open");
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const cursorWhere = cursor
    ? or(
        gt(shopifyOrders.orderCreatedAt, cursor.orderCreatedAt),
        and(
          eq(shopifyOrders.orderCreatedAt, cursor.orderCreatedAt),
          gt(shopifyOrders.id, cursor.id),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      id: shopifyOrders.id,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, scope.organizationId),
        eq(shopifyOrders.storeId, scope.storeId),
        sql`${shopifyOrders.orderCreatedAt} >= ${window.from}`,
        lt(shopifyOrders.orderCreatedAt, window.to),
        cursorWhere,
      ),
    )
    .orderBy(asc(shopifyOrders.orderCreatedAt), asc(shopifyOrders.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const orders = rows.slice(0, limit);
  const last = orders.at(-1);
  return {
    orders,
    nextCursor:
      hasMore && last
        ? { orderCreatedAt: last.orderCreatedAt, id: last.id }
        : null,
  };
}
```

- [ ] **Step 3a: Bind crypto keys before protected-identity work.**

Implement the stable `ensureIdentityCryptoPolicy` helper in `shopify-evidence-store.ts`. Its input carries the non-secret checks computed in memory. Its standalone form opens a transaction and locks the exact store; its executor form requires that lock already be held. On first use it rejects a previous matching key, insert-or-loads the current lifetime matching-key binding, constant-time rejects a same-version/different-check conflict, then inserts the current active policy plus stable suppression pair in that same transaction. Replay validates the lifetime row and compares every active label/check with constant-time byte comparison. Any mismatch, missing pair, or unexpected previous key fails with a fixed safe code before source writes; never update/delete a lifetime binding or log a stored/computed check. `commitShopifyEvidenceOrder` calls the executor form with `identity.keyChecks` before inspecting suppressions or identity rows. Plan 3 later adds the only authorized transition method for current/previous matching checks, still subject to lifetime binding.

- [ ] **Step 4: Implement transactional line replacement**

Add this function:

```ts
export async function replaceCompleteShopifyLineSet(
  scope: IdentityScope,
  evidence: CompleteShopifyLineSet,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: shopifyOrders.id })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, scope.organizationId),
          eq(shopifyOrders.storeId, scope.storeId),
          eq(shopifyOrders.shopifyOrderId, evidence.shopifyOrderId),
        ),
      )
      .limit(1);
    if (!order) throw new Error("Scoped Shopify evidence order was not found");

    await tx.delete(shopifyOrderLines).where(eq(shopifyOrderLines.orderId, order.id));
    if (evidence.lines.length === 0) return;
    await tx.insert(shopifyOrderLines).values(
      evidence.lines.map((line) => ({
        organizationId: scope.organizationId,
        storeId: scope.storeId,
        orderId: order.id,
        shopifyLineItemId: line.shopifyLineItemId,
        shopifyProductId: line.shopifyProductId,
        shopifyVariantId: line.shopifyVariantId,
        sku: line.sku,
        productTitle: line.productTitle,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
        sourcePosition: line.sourcePosition,
        parentOrderUpdatedAt: evidence.orderUpdatedAt,
      })),
    );
  });
}
```

- [ ] **Step 5: Implement identity persistence without fail-open deletion**

Add `persistShopifyIdentityEvidence`. Return immediately for `status: "unavailable"`. For available evidence, perform one transaction that:

1. Locks the scoped Shopify store and resolves the order by organization/store/external order ID.
2. Calls `ensureIdentityCryptoPolicy` with the evidence's non-secret key checks and this transaction; same-label/different-secret or unexpected previous-key input fails before identity mutation.
3. Checks every HMAC-only `suppressionCandidate` against `identity_erasure_suppression` in the same scope. On a hit, use targeted SQL to clear `shopifyCustomerId`, delete that order's matching-identity rows, and return `{ disposition: "suppressed", identityHmacId: null }`; never persist the candidate or source alias as evidence.
4. Otherwise updates only `shopifyOrders.shopifyCustomerId`. Use a targeted SQL update rather than Drizzle's table update builder because `shopifyOrders.updatedAt` has `$onUpdate`; evidence writes must not advance that production-row timestamp.
5. Locks the order's digest rows for `evaluatedKeyVersions` and compares each exact source/version.
6. Reuses the existing row ID when digest and rotation state are identical. When either changes, delete that one old row (cascading identity observations) and insert a fresh row. Delete an evaluated version with no returned digest only when the available response explicitly proves that version is absent. Never mass-delete/reinsert identical rows, because run identity observations use row identity as immutable provenance.

Use this targeted identity write inside the transaction:

```ts
await tx.execute(sql`
  update shopify_order
  set shopify_customer_id = ${evidence.shopifyCustomerId}
  where organization_id = ${scope.organizationId}
    and store_id = ${scope.storeId}
    and id = ${order.id}
`);
```

Do not update `updatedAt`, `netSales`, refunds, journey, bucket/rule version, Meta verification, cancellation, or source fields. Extend the integration test's before/after order snapshot with `updated_at` and assert it is byte-for-byte unchanged after identity persistence.

- [ ] **Step 5a: Add one atomic per-order production commit**

Keep the lower-level line and identity helpers for focused tests and privacy maintenance, but the resumable runner must call only `commitShopifyEvidenceOrder`. It accepts full scope, the exact running `evidenceRunId`, expected/next cursor, complete lines or a typed `preserved_partial` disposition, available/unavailable/not-refreshed identity evidence, and the next validated run progress. In one transaction it:

1. Locks the scoped Shopify store, then locks and validates the exact scoped running evidence run and cursor. Every evidence/order-observation commit uses this short store-first lock; no Shopify remote call occurs inside it.
2. For freshly evaluated identity, validates its non-secret key checks against `identity_crypto_policy` before any other identity read/write.
3. Resolves and locks the exact scoped order.
4. Replaces lines only for a complete fetch; `preserved_partial` leaves the prior line set byte-for-byte unchanged.
5. For freshly evaluated identity, checks its HMAC-only suppression candidates while the store lock is held. A hit actively clears that order's customer ID and matching identity rows, produces `identityDisposition: "suppressed"`, and cannot insert an identity observation. Otherwise apply the allowlisted identity write; unavailable/not-refreshed evidence preserves prior identity.
6. Reloads the exact matcher-visible identity-free order/line projection and computes the canonical `observedContentChecksum` defined in Task 4. Customer ID is never part of matching or this checksum.
7. Inserts the immutable `(evidenceRunId, orderId)` content observation and, only when freshly available and not suppressed, links it to the exact configured-current `source_identity_hmac.id` in `shopify_evidence_run_identity_observation`. Exact replay returns the existing rows; any checksum, disposition, or identity-row disagreement throws. Digest persistence reuses an existing row only when source/version/digest are identical; changed content gets a fresh row ID and cascades prior identity observations.
8. Compare-and-sets the cursor/count/capability/completeness state and renews the heartbeat.

Any failure rolls back every step. The helper returns the committed cursor, content checksum, safe dispositions (including `suppressed`), and nullable opaque identity-row ID but never a matching or suppression digest. There is no production path that separately replaces lines or identity and then advances the cursor. A nonretryable incomplete line fetch commits a `preserved_partial` content observation with no fresh identity observation plus its checkpoint before the runner returns terminal partial, so durable counts and the cursor cannot get ahead of observation membership.

- [ ] **Step 6: Implement independent run methods**

Export `startShopifyEvidenceRun`, `recordFirstBatchTriggerRunId`, `renewShopifyEvidenceRunHeartbeat`, `checkpointShopifyEvidenceRun`, `finishShopifyEvidenceRun`, `failShopifyEvidenceRunAfterRetryExhaustion`, and `failExpiredShopifyEvidenceRun`. They may mutate only `shopify_evidence_sync_run`. `start` get-or-creates by stable start Trigger ID, validates the exact anchored window, and inserts capability-unavailable disposition already terminal in one write; `recordFirstBatchTriggerRunId` is null-to-value/same-value idempotent CAS; renew/checkpoint lock the scoped running row and atomically refresh its liveness heartbeat; `checkpoint` also compare-and-sets cursor and stores nondecreasing counts plus monotonic safe state; `finish` locks, validates the exact expected cursor/progress, accepts only `success`, `partial`, or `failed`, and stamps `finishedAt`; terminal-failure finalizers are the only escape hatches for exhausted retries or an expired running lease.

Use this counts type consistently:

```ts
export type ShopifyEvidenceRunCounts = {
  ordersRead: number;
  ordersEnriched: number;
  ordersPartial: number;
  ordersUnavailable: number;
  warnings: number;
  failures: number;
};

export type ShopifyEvidenceRunProgress = {
  counts: ShopifyEvidenceRunCounts;
  identityCapability: "unknown" | "available" | "unavailable";
  lineCompleteness: "unknown" | "complete" | "partial" | "unavailable";
};

export type ShopifyEvidenceStartDisposition =
  | {
      kind: "running";
      identityCapability: "unknown" | "unavailable";
    }
  | {
      kind: "terminal_unavailable";
      identityCapability: "unknown" | "unavailable";
      counts: ShopifyEvidenceRunCounts;
      errorCode: "required_order_scope_unavailable";
    };

export const SHOPIFY_EVIDENCE_STALE_AFTER_MS = 20 * 60 * 1000;
```

Use these signatures and writes:

```ts
function encodeEvidenceOrderCursor(cursor: EvidenceOrderCursor): string {
  return Buffer.from(
    JSON.stringify({
      orderCreatedAt: cursor.orderCreatedAt.toISOString(),
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");
}

function assertForwardEvidenceCursor(
  expected: EvidenceOrderCursor | null,
  next: EvidenceOrderCursor,
): void {
  if (
    expected &&
    (next.orderCreatedAt < expected.orderCreatedAt ||
      (next.orderCreatedAt.getTime() === expected.orderCreatedAt.getTime() &&
        next.id <= expected.id))
  ) {
    throw new Error("Shopify evidence cursor must advance");
  }
}

const EVIDENCE_COUNT_KEYS = [
  "ordersRead",
  "ordersEnriched",
  "ordersPartial",
  "ordersUnavailable",
  "warnings",
  "failures",
] as const;

function assertNondecreasingEvidenceCounts(
  current: ShopifyEvidenceRunCounts,
  next: ShopifyEvidenceRunCounts,
): void {
  for (const key of EVIDENCE_COUNT_KEYS) {
    if (!Number.isSafeInteger(next[key]) || next[key] < current[key]) {
      throw new Error("Shopify evidence counts cannot decrease");
    }
  }
}

const IDENTITY_TRANSITIONS = {
  unknown: ["unknown", "available", "unavailable"],
  available: ["available", "unavailable"],
  unavailable: ["unavailable"],
} as const;

const LINE_TRANSITIONS = {
  unknown: ["unknown", "complete", "partial", "unavailable"],
  complete: ["complete", "partial"],
  partial: ["partial"],
  unavailable: ["unavailable"],
} as const;

function assertEvidenceStateTransitions(
  current: Omit<ShopifyEvidenceRunProgress, "counts">,
  next: ShopifyEvidenceRunProgress,
): void {
  if (
    !IDENTITY_TRANSITIONS[current.identityCapability].includes(
      next.identityCapability as never,
    ) ||
    !LINE_TRANSITIONS[current.lineCompleteness].includes(
      next.lineCompleteness as never,
    )
  ) {
    throw new Error("Shopify evidence state transition is invalid");
  }
}

export async function loadEvidenceRunByStartTriggerId(
  startTriggerRunId: string,
) {
  const [run] = await db
    .select()
    .from(shopifyEvidenceSyncRuns)
    .where(eq(shopifyEvidenceSyncRuns.startTriggerRunId, startTriggerRunId))
    .limit(1);
  return run ?? null;
}

function assertSameEvidenceStart(
  existing: NonNullable<Awaited<ReturnType<typeof loadEvidenceRunByStartTriggerId>>>,
  params: {
    scope: IdentityScope;
    mode: ShopifyEvidenceMode;
    storeTimezone: string;
    anchorStoreDay: string;
    window: HalfOpenWindow;
  },
): void {
  if (
    existing.organizationId !== params.scope.organizationId ||
    existing.storeId !== params.scope.storeId ||
    existing.mode !== params.mode ||
    existing.storeTimezone !== params.storeTimezone ||
    existing.anchorStoreDay !== params.anchorStoreDay ||
    existing.requestedFrom.getTime() !== params.window.from.getTime() ||
    existing.requestedTo.getTime() !== params.window.to.getTime()
  ) {
    throw new Error("Shopify evidence start idempotency conflict");
  }
}

export async function startShopifyEvidenceRun(params: {
  startTriggerRunId: string;
  scope: IdentityScope;
  mode: ShopifyEvidenceMode;
  storeTimezone: string;
  anchorStoreDay: string;
  window: HalfOpenWindow;
  disposition: ShopifyEvidenceStartDisposition;
  now: Date;
}): Promise<{
  id: string;
  status: "running" | "success" | "partial" | "failed";
  firstBatchTriggerRunId: string | null;
  replayed: boolean;
}> {
  if (params.mode !== "initial_90d" && params.mode !== "incremental_7d") {
    throw new Error("Unsupported Shopify evidence mode");
  }
  assertValidStoreDay(params.anchorStoreDay);
  assertValidIanaTimezone(params.storeTimezone);
  const expectedWindow = deriveShopifyEvidenceWindow({
    mode: params.mode,
    anchorStoreDay: params.anchorStoreDay,
    timeZone: params.storeTimezone,
  });
  if (
    params.window.from.getTime() !== expectedWindow.from.getTime() ||
    params.window.to.getTime() !== expectedWindow.to.getTime()
  ) {
    throw new Error("Shopify evidence window does not match its store-day anchor");
  }
  const terminal = params.disposition.kind === "terminal_unavailable";
  return db.transaction(async (tx) => {
    const [store] = await tx
      .select({ id: shopifyStores.id })
      .from(shopifyStores)
      .where(
        and(
          eq(shopifyStores.organizationId, params.scope.organizationId),
          eq(shopifyStores.id, params.scope.storeId),
        ),
      )
      .for("update");
    if (!store) throw new Error("Shopify evidence store is outside this scope");

    const [existing] = await tx
      .select()
      .from(shopifyEvidenceSyncRuns)
      .where(
        eq(
          shopifyEvidenceSyncRuns.startTriggerRunId,
          params.startTriggerRunId,
        ),
      )
      .limit(1);
    if (existing) {
      assertSameEvidenceStart(existing, params);
      return {
        id: existing.id,
        status: existing.status,
        firstBatchTriggerRunId: existing.firstBatchTriggerRunId,
        replayed: true,
      };
    }

    const [active] = await tx
      .select({ id: shopifyEvidenceSyncRuns.id })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.organizationId, params.scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .limit(1);
    if (active) {
      const recovery = await failExpiredShopifyEvidenceRun(
        params.scope,
        active.id,
        params.now,
        tx,
      );
      if (!recovery.changed) {
        throw new Error("A live Shopify evidence run already owns this store");
      }
    }

    const [inserted] = await tx
      .insert(shopifyEvidenceSyncRuns)
      .values({
        startTriggerRunId: params.startTriggerRunId,
        organizationId: params.scope.organizationId,
        storeId: params.scope.storeId,
        mode: params.mode,
        storeTimezone: params.storeTimezone,
        anchorStoreDay: params.anchorStoreDay,
        requestedFrom: params.window.from,
        requestedTo: params.window.to,
        identityCapability: params.disposition.identityCapability,
        status: terminal ? "partial" : "running",
        lineCompleteness: terminal ? "unavailable" : "unknown",
        ...(terminal ? params.disposition.counts : {}),
        warnings: terminal ? Math.max(1, params.disposition.counts.warnings) : 0,
        error: terminal ? params.disposition.errorCode : null,
        heartbeatAt: params.now,
        startedAt: params.now,
        finishedAt: terminal ? params.now : null,
      })
      .returning({
        id: shopifyEvidenceSyncRuns.id,
        status: shopifyEvidenceSyncRuns.status,
        firstBatchTriggerRunId: shopifyEvidenceSyncRuns.firstBatchTriggerRunId,
      });
    if (!inserted) throw new Error("Shopify evidence run insert failed");
    return { ...inserted, replayed: false };
  });
}

export async function recordFirstBatchTriggerRunId(params: {
  scope: IdentityScope;
  runId: string;
  triggerRunId: string;
}): Promise<void> {
  const rows = await db
    .update(shopifyEvidenceSyncRuns)
    .set({
      firstBatchTriggerRunId: params.triggerRunId,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.id, params.runId),
        eq(shopifyEvidenceSyncRuns.organizationId, params.scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
        or(
          isNull(shopifyEvidenceSyncRuns.firstBatchTriggerRunId),
          eq(shopifyEvidenceSyncRuns.firstBatchTriggerRunId, params.triggerRunId),
        ),
      ),
    )
    .returning({ id: shopifyEvidenceSyncRuns.id });
  if (rows.length !== 1) {
    throw new Error("Shopify evidence first-batch handoff conflicts");
  }
}

export async function checkpointShopifyEvidenceRun(
  scope: IdentityScope,
  runId: string,
  expectedCursor: EvidenceOrderCursor | null,
  nextCursor: EvidenceOrderCursor,
  progress: ShopifyEvidenceRunProgress,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: shopifyEvidenceSyncRuns.id,
        cursor: shopifyEvidenceSyncRuns.cursor,
        ordersRead: shopifyEvidenceSyncRuns.ordersRead,
        ordersEnriched: shopifyEvidenceSyncRuns.ordersEnriched,
        ordersPartial: shopifyEvidenceSyncRuns.ordersPartial,
        ordersUnavailable: shopifyEvidenceSyncRuns.ordersUnavailable,
        warnings: shopifyEvidenceSyncRuns.warnings,
        failures: shopifyEvidenceSyncRuns.failures,
        identityCapability: shopifyEvidenceSyncRuns.identityCapability,
        lineCompleteness: shopifyEvidenceSyncRuns.lineCompleteness,
      })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, runId),
          eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (!current) throw new Error("Shopify evidence run is not active in this scope");
    const expectedEncoded = expectedCursor
      ? encodeEvidenceOrderCursor(expectedCursor)
      : null;
    if (current.cursor !== expectedEncoded) {
      throw new Error("Shopify evidence cursor compare-and-set failed");
    }
    assertForwardEvidenceCursor(expectedCursor, nextCursor);
    assertNondecreasingEvidenceCounts(current, progress.counts);
    assertEvidenceStateTransitions(current, progress);
    const updated = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        cursor: encodeEvidenceOrderCursor(nextCursor),
        heartbeatAt: new Date(),
        ...progress.counts,
        identityCapability: progress.identityCapability,
        lineCompleteness: progress.lineCompleteness,
      })
      .where(eq(shopifyEvidenceSyncRuns.id, current.id))
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (updated.length !== 1) throw new Error("Shopify evidence checkpoint failed");
  });
}

export async function finishShopifyEvidenceRun(params: {
  scope: IdentityScope;
  runId: string;
  expectedCursor: EvidenceOrderCursor | null;
  status: "success" | "partial" | "failed";
  progress: ShopifyEvidenceRunProgress;
  error?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: shopifyEvidenceSyncRuns.id,
        cursor: shopifyEvidenceSyncRuns.cursor,
        ordersRead: shopifyEvidenceSyncRuns.ordersRead,
        ordersEnriched: shopifyEvidenceSyncRuns.ordersEnriched,
        ordersPartial: shopifyEvidenceSyncRuns.ordersPartial,
        ordersUnavailable: shopifyEvidenceSyncRuns.ordersUnavailable,
        warnings: shopifyEvidenceSyncRuns.warnings,
        failures: shopifyEvidenceSyncRuns.failures,
        identityCapability: shopifyEvidenceSyncRuns.identityCapability,
        lineCompleteness: shopifyEvidenceSyncRuns.lineCompleteness,
      })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, params.runId),
          eq(shopifyEvidenceSyncRuns.organizationId, params.scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (!current) throw new Error("Shopify evidence run is not active in this scope");
    const expectedEncoded = params.expectedCursor
      ? encodeEvidenceOrderCursor(params.expectedCursor)
      : null;
    if (current.cursor !== expectedEncoded) {
      throw new Error("Shopify evidence cursor compare-and-set failed");
    }
    assertNondecreasingEvidenceCounts(current, params.progress.counts);
    assertEvidenceStateTransitions(current, params.progress);
    const updated = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        status: params.status,
        ...params.progress.counts,
        identityCapability: params.progress.identityCapability,
        lineCompleteness: params.progress.lineCompleteness,
        error: params.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(shopifyEvidenceSyncRuns.id, current.id))
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (updated.length !== 1) throw new Error("Shopify evidence finish failed");
  });
}

export async function failShopifyEvidenceRunAfterRetryExhaustion(
  scope: IdentityScope,
  runId: string,
  stage: "start" | "batch",
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: shopifyEvidenceSyncRuns.id,
        status: shopifyEvidenceSyncRuns.status,
        cursor: shopifyEvidenceSyncRuns.cursor,
        ordersRead: shopifyEvidenceSyncRuns.ordersRead,
        ordersEnriched: shopifyEvidenceSyncRuns.ordersEnriched,
        ordersPartial: shopifyEvidenceSyncRuns.ordersPartial,
        ordersUnavailable: shopifyEvidenceSyncRuns.ordersUnavailable,
        warnings: shopifyEvidenceSyncRuns.warnings,
        failures: shopifyEvidenceSyncRuns.failures,
        identityCapability: shopifyEvidenceSyncRuns.identityCapability,
        lineCompleteness: shopifyEvidenceSyncRuns.lineCompleteness,
      })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, runId),
          eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
        ),
      )
      .for("update");
    if (!current) throw new Error("Shopify evidence run is outside this scope");
    if (current.status !== "running") return { changed: false };

    // Preserve the locked cursor, committed counts, and safe capability state.
    // Only the terminal state, one safe failure count, and fixed code change.
    const updated = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        status: "failed",
        failures: current.failures + 1,
        error:
          stage === "start"
            ? "start_retries_exhausted"
            : "batch_retries_exhausted",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, current.id),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (updated.length !== 1) {
      throw new Error("Shopify evidence retry-exhaustion finalization raced");
    }
    return { changed: true };
  });
}
```

`renewShopifyEvidenceRunHeartbeat(scope, runId, now, executor?)` locks exactly one scoped `running` row and sets only `heartbeatAt = now`; every batch calls it before a remote request, and every committed order checkpoint renews it in the same transaction. `failExpiredShopifyEvidenceRun(scope, runId, now, executor?)` locks that row and changes it only when `heartbeatAt <= now - SHOPIFY_EVIDENCE_STALE_AFTER_MS`; it preserves cursor/progress/evidence, adds one failure, stores only `lease_expired`, and is idempotent for terminal or still-live rows. Use one local structural Drizzle executor type shared by both helpers so the default is `db` and the store-locked start transaction can pass `tx` without opening a nested transaction. The 20-minute stale threshold is greater than the task's 600-second `maxDuration`, so a live bounded attempt is never reaped. A task resolver may locate the row by globally unique `runId` or `startTriggerRunId`, but passes the loaded full `IdentityScope` into every mutation.

The locked implementations above are the prescribed persistence boundary. The validators allow idempotent same-state transitions plus identity `unknown → available | unavailable`, `available → unavailable`, and terminal `unavailable`; line `unknown → complete | partial | unavailable`, `complete → partial`, and terminal `partial | unavailable`. Counts may stay equal or increase but never decrease. Cursor compare-and-set allows the exact expected cursor and a strictly later next tuple; finish requires the exact current cursor and progress. No provider error text enters these helpers.

Add integration cases proving start persists the exact approved mode, server-derived timezone/anchor store day, and initial safe capability state; an invalid timezone/anchor/unsupported mode fails before insert; the partial unique index rejects a second live run for the store; a later-order failure followed by retry resumes after the last committed cursor; a stale worker loses the cursor CAS without changing state; each entry/checkpoint renews the heartbeat; count regression and every invalid state transition fail; a checkpoint/finish/failure-finalizer with the wrong organization or store changes zero rows and throws; a second finish cannot rewrite a terminal run; retry-exhaustion finalization locks and preserves the exact committed cursor/counts/capability state, adds only one failure, writes only the stage-derived fixed safe code, and is a no-op when replayed against any terminal run; expired-lease reconciliation cannot reap a live row, reaps an expired row once with `lease_expired`, and permits a replacement run; and the correctly scoped running run changes exactly one row. No run mutation may accept `runId` without `IdentityScope` below the task resolver.

- [ ] **Step 7: Run persistence and schema tests**

Run: `bun run test -- src/lib/evidence-window.test.ts src/lib/shopify-evidence.integration.test.ts src/lib/shopify-store.integration.test.ts`

Expected: PASS. Replacement is atomic, replay is idempotent, and unavailable identity preserves prior evidence.

- [ ] **Step 8: Commit evidence persistence**

```bash
git add src/lib/evidence-window.ts src/lib/evidence-window.test.ts src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts
git commit -m "feat(shopify): replace complete evidence transactionally"
```

## Task 7: Add the fail-closed, resumable evidence runner

**Files:**
- Create: `src/lib/shopify-evidence-runner.ts`
- Create: `src/lib/shopify-evidence-runner.test.ts`

- [ ] **Step 1: Write dependency-isolated runner tests**

Create `src/lib/shopify-evidence-runner.test.ts`. Import `IncompleteShopifyLineSetError` from `@/lib/shopify-evidence-admin`, use `vi.fn()` dependencies, and add these exact behaviors:

```ts
const NOW = new Date("2026-07-31T01:00:00Z");
const ZERO_COUNTS = {
  ordersRead: 0,
  ordersEnriched: 0,
  ordersPartial: 0,
  ordersUnavailable: 0,
  warnings: 0,
  failures: 0,
};
const PAYLOAD = {
  organizationId: "org_a",
  storeId: "store_a",
  from: new Date("2026-05-02T00:00:00Z"),
  to: new Date("2026-08-01T00:00:00Z"),
  runId: "run_a",
  cursor: null,
  counts: ZERO_COUNTS,
  identityCapability: "unknown" as const,
  lineCompleteness: "unknown" as const,
};

describe("runShopifyEvidenceBatch", () => {
  it("fails a domain mismatch before a remote call or write", async () => {
    const deps = makeDeps({ storedDomain: "other.myshopify.com" });
    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "configured Shopify domain does not match the scoped store",
    );
    expect(deps.graphql).not.toHaveBeenCalled();
    expect(deps.commitOrder).not.toHaveBeenCalled();
  });

  it("fails invalid HMAC configuration before a remote call or write", async () => {
    const deps = makeDeps({ keyringError: new Error("IDENTITY_HMAC_SECRET is required") });
    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "IDENTITY_HMAC_SECRET is required",
    );
    expect(deps.graphql).not.toHaveBeenCalled();
    expect(deps.commitOrder).not.toHaveBeenCalled();
  });

  it("persists complete lines when protected identity is unavailable", async () => {
    const deps = makeDeps({ identityStatus: "unavailable" });
    const result = await runShopifyEvidenceBatch(PAYLOAD, deps);
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        lineDisposition: "complete",
        identity: { status: "unavailable", reason: "protected_identity_unavailable" },
      }),
    );
    expect(result.counts.ordersEnriched).toBe(1);
    expect(result.counts.ordersPartial).toBe(1);
    expect(result.counts.ordersUnavailable).toBe(1);
    expect(result.identityCapability).toBe("unavailable");
    expect(result.lineCompleteness).toBe("complete");
  });

  it("skips protected identity GraphQL when the capability probe already denied it", async () => {
    const deps = makeDeps();
    const result = await runShopifyEvidenceBatch(
      { ...PAYLOAD, identityCapability: "unavailable" },
      deps,
    );
    expect(deps.fetchIdentity).not.toHaveBeenCalled();
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { status: "unavailable", reason: "protected_identity_unavailable" },
      }),
    );
    expect(result.counts.ordersUnavailable).toBe(1);
  });

  it("preserves prior evidence and stops only for a deterministic incomplete set", async () => {
    const deps = makeDeps({
      lineError: new IncompleteShopifyLineSetError(
        "Shopify line cursor did not advance",
      ),
    });
    const result = await runShopifyEvidenceBatch(PAYLOAD, deps);
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ lineDisposition: "preserved_partial" }),
    );
    expect(result).toMatchObject({
      kind: "terminal",
      status: "partial",
      nextCursor: null,
      committedCursor: { orderCreatedAt: NOW, id: "order_internal_1" },
      lineCompleteness: "partial",
    });
  });

  it("rethrows a retryable line failure so the task replays from its committed cursor", async () => {
    const deps = makeDeps({ lineError: new Error("network reset") });
    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "network reset",
    );
    expect(deps.commitOrder).not.toHaveBeenCalled();
  });

  it("returns the exact committed continuation cursor", async () => {
    const deps = makeDeps({ nextCursor: { orderCreatedAt: NOW, id: "order_internal_1" } });
    const result = await runShopifyEvidenceBatch(PAYLOAD, deps);
    expect(result.kind).toBe("continue");
    expect(result.nextCursor).toEqual({
      orderCreatedAt: NOW,
      id: "order_internal_1",
    });
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organizationId: PAYLOAD.organizationId, storeId: PAYLOAD.storeId },
        evidenceRunId: PAYLOAD.runId,
        expectedCursor: null,
        nextCursor: { orderCreatedAt: NOW, id: "order_internal_1" },
        progress: {
          counts: result.counts,
          identityCapability: result.identityCapability,
          lineCompleteness: result.lineCompleteness,
        },
      }),
    );
  });

  it("returns a terminal success with finish state only when no page remains", async () => {
    const result = await runShopifyEvidenceBatch(PAYLOAD, makeDeps({ nextCursor: null }));
    expect(result).toMatchObject({
      kind: "terminal",
      status: "success",
      nextCursor: null,
      committedCursor: { orderCreatedAt: NOW, id: "order_internal_1" },
      lineCompleteness: "complete",
    });
  });
});
```

Define `NOW`, `PAYLOAD`, and `makeDeps` in the test with fixed data. `makeDeps` must return every dependency listed in the interface below so tests cannot reach the real database, environment, network, or Trigger.dev SDK.

- [ ] **Step 2: Run runner tests to verify they fail**

Run: `bun run test -- src/lib/shopify-evidence-runner.test.ts`

Expected: FAIL because `shopify-evidence-runner.ts` does not exist.

- [ ] **Step 3: Define runner payload, result, and dependency interfaces**

Create `src/lib/shopify-evidence-runner.ts`:

```ts
import "server-only";
import type { HalfOpenWindow } from "@/lib/evidence-window";
import type { IdentityHmacKeyring, IdentityScope } from "@/lib/identity-hmac";
import type {
  CompleteShopifyLineSet,
  NormalizedShopifyIdentityEvidence,
  ShopifyGraphql,
} from "@/lib/shopify-evidence-admin";
import { isRetryableShopifyLineFailure } from "@/lib/shopify-evidence-admin";
import type {
  EvidenceOrderBatch,
  EvidenceOrderCursor,
  ShopifyEvidenceRunCounts,
} from "@/lib/shopify-evidence-store";

export type ShopifyEvidenceBatchPayload = IdentityScope &
  HalfOpenWindow & {
    runId: string;
    cursor: EvidenceOrderCursor | null;
    counts: ShopifyEvidenceRunCounts;
    identityCapability: "unknown" | "available" | "unavailable";
    lineCompleteness: "unknown" | "complete" | "partial" | "unavailable";
  };

type ShopifyEvidenceCheckpointProgress = {
  counts: ShopifyEvidenceRunCounts;
  identityCapability: "unknown" | "available" | "unavailable";
  lineCompleteness: "unknown" | "complete" | "partial" | "unavailable";
};

type ShopifyEvidenceBatchProgress = ShopifyEvidenceCheckpointProgress & {
  committedCursor: EvidenceOrderCursor | null;
};

export type ShopifyEvidenceBatchResult =
  | (ShopifyEvidenceBatchProgress & {
      kind: "continue";
      nextCursor: EvidenceOrderCursor;
    })
  | (ShopifyEvidenceBatchProgress & {
      kind: "terminal";
      status: "success" | "partial";
      nextCursor: null;
    });

export type ShopifyEvidenceRunnerDependencies = {
  configuredShopDomain: string;
  loadKeyring: () => IdentityHmacKeyring;
  loadSuppressionKey: () => ErasureSuppressionKey;
  ensureCryptoPolicy: (input: {
    scope: IdentityScope;
    keyChecks: IdentityCryptoKeyChecks;
  }) => Promise<void>;
  loadStore: (scope: IdentityScope) => Promise<{ shopDomain: string }>;
  graphql: ShopifyGraphql;
  listOrderBatch: (
    scope: IdentityScope,
    window: HalfOpenWindow,
    cursor: EvidenceOrderCursor | null,
  ) => Promise<EvidenceOrderBatch>;
  fetchLines: (
    graphql: ShopifyGraphql,
    shopifyOrderId: string,
  ) => Promise<CompleteShopifyLineSet>;
  fetchIdentity: (params: {
    graphql: ShopifyGraphql;
    shopifyOrderId: string;
    scope: IdentityScope;
    keyring: IdentityHmacKeyring;
    suppressionKey: ErasureSuppressionKey;
  }) => Promise<NormalizedShopifyIdentityEvidence>;
  commitOrder: (input: {
    scope: IdentityScope;
    evidenceRunId: string;
    orderId: string;
    shopifyOrderId: string;
    expectedCursor: EvidenceOrderCursor | null;
    nextCursor: EvidenceOrderCursor;
    lines: CompleteShopifyLineSet | null;
    lineDisposition: "complete" | "preserved_partial";
    identity: NormalizedShopifyIdentityEvidence | { status: "not_refreshed" };
    progress: ShopifyEvidenceCheckpointProgress;
  }) => Promise<{
    observedContentChecksum: string;
    identityHmacId: string | null;
  }>;
};
```

- [ ] **Step 4: Implement batch orchestration**

Implement `runShopifyEvidenceBatch` in this order:

1. Load the matching keyring and stable erasure-suppression key; either configuration failure aborts before a database write or remote call. Test suppression-root reuse against both current and previous matching roots: each preflight must make zero provider calls and zero writes.
2. Read the scoped store.
3. Compare lowercased configured/stored domains and throw the fixed mismatch error before `graphql` or evidence/policy writes.
4. Derive non-secret key checks and call `ensureCryptoPolicy` before a protected-identity or line remote call. Same-label/different-secret fails here.
5. Read the next existing-order batch from PostgreSQL.
6. For each order, fetch all lines. Rethrow retryable remote/transport failures so Trigger.dev replays from its last committed cursor. Convert only `IncompleteShopifyLineSetError` to `lineDisposition: "preserved_partial"`, preserve the prior line set, and never persist provider error text.
7. When lines are complete, fetch identity. If the carried capability is already `unavailable`, do not issue the protected-field GraphQL call; pass the typed local unavailable evidence. For a preserved-partial line failure, do not start a new identity call and pass `{ status: "not_refreshed" }`.
8. Compute the next counts/capability/completeness in memory, then call `commitOrder` once so policy revalidation, line/identity changes, immutable observation, cursor, counts, and heartbeat commit atomically. Any unavailable identity increments both `ordersPartial` and `ordersUnavailable` plus one warning, but does not undo lines.
9. Return terminal `partial` after the committed preserved-partial observation, or continue after a committed complete observation.
10. Return a discriminated continuation only when another database page remains; otherwise return terminal success. Every result carries cumulative counts plus the exact identity-capability and line-completeness state required by `finishShopifyEvidenceRun`.

The start row initializes counts with this concrete value. Each batch task reloads the cumulative value from the locked run row and passes it to the in-process runner; no Trigger continuation carries counts:

```ts
const counts: ShopifyEvidenceRunCounts = {
  ordersRead: 0,
  ordersEnriched: 0,
  ordersPartial: 0,
  ordersUnavailable: 0,
  warnings: 0,
  failures: 0,
};
```

Inside `runShopifyEvidenceBatch`, begin with `const counts = { ...payload.counts };`; never reset a continuation to zero.

Use this complete function:

```ts
export async function runShopifyEvidenceBatch(
  payload: ShopifyEvidenceBatchPayload,
  deps: ShopifyEvidenceRunnerDependencies,
): Promise<ShopifyEvidenceBatchResult> {
  const keyring = deps.loadKeyring();
  const suppressionKey = deps.loadSuppressionKey();
  const scope: IdentityScope = {
    organizationId: payload.organizationId,
    storeId: payload.storeId,
  };
  const store = await deps.loadStore(scope);
  if (
    store.shopDomain.trim().toLowerCase() !==
    deps.configuredShopDomain.trim().toLowerCase()
  ) {
    throw new Error("configured Shopify domain does not match the scoped store");
  }
  await deps.ensureCryptoPolicy({
    scope,
    keyChecks: computeIdentityCryptoKeyChecks({ scope, keyring, suppressionKey }),
  });

  const batch = await deps.listOrderBatch(
    scope,
    { from: payload.from, to: payload.to },
    payload.cursor,
  );
  const counts = { ...payload.counts };
  let identityCapability = payload.identityCapability;
  let lineCompleteness = payload.lineCompleteness;
  let lastCommittedCursor = payload.cursor;

  for (const order of batch.orders) {
    counts.ordersRead += 1;
    const nextCommittedCursor = {
      orderCreatedAt: order.orderCreatedAt,
      id: order.id,
    };
    let lines: CompleteShopifyLineSet | null = null;
    let lineDisposition: "complete" | "preserved_partial" = "complete";
    let identity:
      | NormalizedShopifyIdentityEvidence
      | { status: "not_refreshed" } = { status: "not_refreshed" };
    let stopPartial = false;

    try {
      lines = await deps.fetchLines(deps.graphql, order.shopifyOrderId);
    } catch (error) {
      if (isRetryableShopifyLineFailure(error)) throw error;
      lineDisposition = "preserved_partial";
      identity = { status: "not_refreshed" };
      counts.ordersPartial += 1;
      counts.failures += 1;
      lineCompleteness = "partial";
      stopPartial = true;
    }

    if (!stopPartial) {
      counts.ordersEnriched += 1;
      if (lineCompleteness === "unknown") lineCompleteness = "complete";
      identity =
        identityCapability === "unavailable"
          ? { status: "unavailable", reason: "protected_identity_unavailable" }
          : await deps.fetchIdentity({
              graphql: deps.graphql,
              shopifyOrderId: order.shopifyOrderId,
              scope,
              keyring,
              suppressionKey,
            });
      if (identity.status === "unavailable") {
        identityCapability = "unavailable";
        counts.ordersPartial += 1;
        counts.ordersUnavailable += 1;
        counts.warnings += 1;
      } else if (identityCapability === "unknown") {
        identityCapability = "available";
      }
    }

    await deps.commitOrder({
      scope,
      evidenceRunId: payload.runId,
      orderId: order.id,
      shopifyOrderId: order.shopifyOrderId,
      expectedCursor: lastCommittedCursor,
      nextCursor: nextCommittedCursor,
      lines,
      lineDisposition,
      identity,
      progress: { counts, identityCapability, lineCompleteness },
    });
    lastCommittedCursor = nextCommittedCursor;

    if (stopPartial) {
      return {
        kind: "terminal",
        status: "partial",
        nextCursor: null,
        committedCursor: lastCommittedCursor,
        counts,
        identityCapability,
        lineCompleteness,
      };
    }
  }

  if (batch.nextCursor) {
    return {
      kind: "continue",
      nextCursor: batch.nextCursor,
      committedCursor: lastCommittedCursor,
      counts,
      identityCapability,
      lineCompleteness,
    };
  }

  return {
    kind: "terminal",
    status: "success",
    nextCursor: null,
    committedCursor: lastCommittedCursor,
    counts,
    identityCapability,
    lineCompleteness: lineCompleteness === "unknown" ? "complete" : lineCompleteness,
  };
}
```

The runner must not import `ingestOrderNodes`, `stampBuckets`, `upsertShopifyStore`, `startSyncRun`, `finishSyncRun`, `shopifyOrders.netSales`, or `shopifyRefunds`.

- [ ] **Step 5: Run runner, admin-client, and persistence tests**

Run: `bun run test -- src/lib/shopify-evidence-runner.test.ts src/lib/shopify-evidence-admin.test.ts src/lib/shopify-evidence.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the runner**

```bash
git add src/lib/shopify-evidence-runner.ts src/lib/shopify-evidence-runner.test.ts
git commit -m "feat(shopify): orchestrate isolated evidence batches"
```

## Task 8: Add separate Trigger.dev start and continuation tasks

**Files:**
- Create: `trigger/shopify-evidence-sync.ts`
- Modify: `src/lib/evidence-window.ts`
- Modify: `src/lib/evidence-window.test.ts`
- Modify: `src/lib/shopify-evidence-store.ts`
- Modify: `src/lib/shopify-evidence.integration.test.ts`
- Modify: `src/lib/shopify-evidence-runner.test.ts`
- Modify: `src/lib/shopify-evidence-admin.test.ts`
- Read only: `trigger/shopify-sync.ts`

- [ ] **Step 1: Add orchestration-boundary assertions**

Extend `src/lib/shopify-evidence-runner.test.ts` with a source-boundary test that reads the new Trigger file once it exists:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

it("keeps the Trigger wrapper outside monetary ingestion", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "trigger/shopify-evidence-sync.ts"),
    "utf8",
  );
  expect(source).not.toContain("ingestOrderNodes");
  expect(source).not.toContain("stampBuckets");
  expect(source).not.toContain("upsertShopifyStore");
  expect(source).not.toContain("startSyncRun");
  expect(source).not.toContain("finishSyncRun");
});

it("accepts only a server-derived evidence mode at the start boundary");
it("derives 90 inclusive store days across DST for initial_90d");
it("derives seven inclusive store days across DST for incremental_7d");
it("rejects start payloads containing organization store from or to authority");
it("accepts only runId in a continuation and loads all authority from the run row");
it("rejects a persisted window beyond its anchor next-midnight or with the wrong floor");
it("probes Shopify capabilities before creating a run or fetching an order");
it("finishes initial_90d as measurable unavailable when read_all_orders is missing");
it("enqueues a second database page without prematurely finishing the run");
it("finishes exactly once only after a terminal page and forwards runner completeness");
it("reuses one run after a crash immediately after start insertion");
it("reuses one idempotent first batch after trigger succeeds before start returns");
it("returns the same atomically terminal unavailable run on start retry");
it("marks an inserted run failed when start handoff retries are exhausted");
it("resumes a later-order failure from the locked persisted cursor and progress");
it("marks the persisted run failed after batch retries are exhausted");
it("preserves terminal state when the failure hook is replayed");
it("reaps an expired start or batch lease but never a live heartbeat");
it("rejects stale workers count regressions invalid transitions and beyond-next-midnight windows");
it("exports both Trigger tasks, installs both terminal onFailure hooks, caps duration, and uses global idempotency keys with an explicit TTL");
```

- [ ] **Step 2: Run the boundary test to verify it fails**

Run: `bun run test -- src/lib/shopify-evidence-runner.test.ts`

Expected: FAIL with `ENOENT` for `trigger/shopify-evidence-sync.ts`.

- [ ] **Step 3: Create the Trigger wrapper**

Create `trigger/shopify-evidence-sync.ts` with:

```ts
import { idempotencyKeys, logger, metadata, task, tasks } from "@trigger.dev/sdk";
import { shopifyGraphql } from "@/lib/shopify-admin";
import {
  fetchCompleteShopifyOrderLines,
  fetchShopifyIdentityEvidence,
  probeShopifyEvidenceCapabilities,
} from "@/lib/shopify-evidence-admin";
import {
  commitShopifyEvidenceOrder,
  countEvidenceOrders,
  failShopifyEvidenceRunAfterRetryExhaustion,
  finishShopifyEvidenceRun,
  listEvidenceOrderBatch,
  loadEvidenceStore,
  loadEvidenceRunByStartTriggerId,
  recordFirstBatchTriggerRunId,
  startShopifyEvidenceRun,
} from "@/lib/shopify-evidence-store";
import { runShopifyEvidenceBatch } from "@/lib/shopify-evidence-runner";
import type { ShopifyEvidenceMode } from "@/lib/evidence-window";
import { parseIdentityHmacKeyring } from "@/lib/identity-hmac";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const SHOPIFY_EVIDENCE_QUEUE = {
  name: "shopify-evidence",
  concurrencyLimit: 1,
};

export type ShopifyEvidenceStartPayload = {
  mode: ShopifyEvidenceMode;
};

export type ShopifyEvidenceContinuationPayload = {
  runId: string;
};

export type ShopifyEvidenceStartResult = {
  evidenceRunId: string;
  triggerRunId: string;
  terminal: boolean;
};

export function assertExactEvidenceStartPayload(
  value: unknown,
): asserts value is ShopifyEvidenceStartPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    (input.mode !== "initial_90d" && input.mode !== "incremental_7d") ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Shopify evidence start accepts only an approved mode");
  }
}
```

Reuse Task 6's shared `deriveShopifyEvidenceWindow({ mode, anchorStoreDay, timeZone })`, strict day/timezone validators, and `ShopifyEvidenceMode`; do not redeclare them in the Trigger file. The start task derives `anchorStoreDay` by formatting injected `now` in the validated store timezone; no caller supplies the anchor or either boundary.

Add `resolveConfiguredEvidenceStore(shopDomain)` and `loadShopifyEvidenceRun(runId)` to `shopify-evidence-store.ts`. The first resolves exactly one store by the allowlisted normalized domain and returns its organization, store ID, domain, and timezone; zero or multiple rows fail closed. The second returns the persisted scope, mode, `storeTimezone`, `anchorStoreDay`, requested window, decoded cursor, cumulative counts, run state, and safe capability/completeness fields. `startShopifyEvidenceRun` persists mode, timezone, and `anchorStoreDay` with the derived window and probe-derived initial identity-capability state.

Export `shopifyEvidenceBatchTask` first with `retry: ATTRIBUTION_TASK_RETRY` and `maxDuration: 600`. Its exact payload is `{ runId: string }`; reject every extra key. Load the run by that ID, require it to be running, renew its heartbeat before the first remote request, revalidate the persisted store timezone, and re-derive the mode's 90-day or seven-day store-local range from persisted `anchorStoreDay`. Require exact equality with the persisted window; this permits the expected `to` boundary at the anchor day's next local midnight and rejects only a boundary beyond it or the wrong floor. The persisted full scope, decoded cursor, counts, identity capability, and line completeness are the sole authoritative inputs to `runShopifyEvidenceBatch`. Thus retry after one or more per-order commits resumes from persisted progress instead of deadlocking on stale payload state. It derives one `IdentityScope` from the row, injects `commitShopifyEvidenceOrder` as the runner's sole evidence/checkpoint mutation, and passes that same scope to every commit/finish call.

Configure that exported batch task with a terminal `onFailure` hook in addition to `retry: ATTRIBUTION_TASK_RETRY`. The hook validates the exact `{ runId }` payload, reloads the persisted run solely to derive its stored `IdentityScope`, and calls `failShopifyEvidenceRunAfterRetryExhaustion(scope, runId, "batch")`. Attempt-level failures still rethrow and leave the row `running`; only Trigger.dev's terminal hook after retries are exhausted writes the immediate `failed` disposition. The finalizer locks the row, preserves its last committed cursor/progress/capability state, records only `batch_retries_exhausted`, and does not overwrite any already-terminal result. Never persist `error.message` or provider response text.

Treat the runner's discriminated result as the only lifecycle authority. For `{ kind: "continue", nextCursor }`, require that cursor to equal the runner's `committedCursor`; create a stable cursor-qualified key with `idempotencyKeys.create(key, { scope: "global" })`, then enqueue exactly one `{ runId }` payload with that `idempotencyKey` and an explicit seven-day `idempotencyKeyTTL`; never call `finishShopifyEvidenceRun`. The explicit global scope is required because a replacement supervisor/parent must resolve the same child graph rather than parent-scoping an otherwise identical key. For `{ kind: "terminal", nextCursor: null }`, call `finishShopifyEvidenceRun` exactly once with `expectedCursor: committedCursor`, its `status`, and its exact returned progress; never enqueue. An explicit capability-unavailable outcome is inserted terminally by the start path below and also never enqueued. Do not infer terminal success merely from a batch's `status` field, and do not both finish and enqueue in one invocation. Do not catch errors rethrown as retryable line failures: Trigger.dev replays `{ runId }` and the task reconstructs current progress from the row. Only an `IncompleteShopifyLineSetError` becomes a sanitized terminal partial result. Persisted run scope/progress/window is authoritative; no Trigger payload carries scope, dates, cursor, counts, or capability state.

Export `shopifyEvidenceStartTask` second with the same retry policy, `maxDuration: 600`, and its own terminal `onFailure({ ctx })`. The hook locates a row by `startTriggerRunId = ctx.run.id`; if insertion never happened it returns safely, otherwise it resolves the stored scope and calls `failShopifyEvidenceRunAfterRetryExhaustion(scope, runId, "start")`. Its result is the exact `ShopifyEvidenceStartResult` above: `evidenceRunId` is the PostgreSQL `shopify_evidence_sync_run.id`, while `triggerRunId` is the stable Trigger.dev start-run ID from task context and the run's unique idempotency key. They are never interchangeable; Plan 4 stores both and polls terminal evidence state only by `evidenceRunId`.

1. Call `assertExactEvidenceStartPayload(payload)`. Load by `startTriggerRunId = ctx.run.id` before deriving a day or probing. If a row exists, require its immutable mode to equal the payload and reuse its original scope/timezone/anchor/window. Return it immediately if terminal; if running but its heartbeat is expired, call the scoped lease finalizer and return the resulting terminal row; otherwise reuse or repair only its first-batch handoff below. A retry never derives a new day for an existing start ID.
2. For no existing row, call `parseIdentityHmacKeyring()` so missing/invalid secrets cause no write or remote call and resolve the one configured store through `resolveConfiguredEvidenceStore(SHOPIFY_SHOP_DOMAIN)`. In a short transaction, lock that store, reconcile any expired running evidence row, reject a still-live one, then release the lock before any remote request. Derive `anchorStoreDay` and the exact window from one injected `now`, then call `probeShopifyEvidenceCapabilities(shopifyGraphql)` before insertion or any order-line/identity fetch. A transport failure escapes while no run exists. Convert only closed safe capability fields; never persist/log raw scopes. After the probe, `startShopifyEvidenceRun` locks the store again, repeats expired/live reconciliation, and inserts in that same short transaction; the partial unique index handles a race between the two lock windows. No transaction spans a Shopify call.
3. Require `read_orders` for both modes and `read_all_orders` for `initial_90d`. If absent, locally count eligible orders and call `startShopifyEvidenceRun` with `terminal_unavailable`; that single insert already has `status: "partial"`, `lineCompleteness: "unavailable"`, finished time, safe counts/warning/code. Return the same terminal IDs. Never insert running and then finish, fetch an order, enqueue, or indefinitely retry access denial.
4. If access is available, get-or-create the running row by unique start Trigger ID. Create the stable first-batch key with `idempotencyKeys.create("shopify-evidence:first:" + evidenceRunId, { scope: "global" })`, call `tasks.trigger` with `{ runId: evidenceRunId }`, that `idempotencyKey`, and explicit seven-day `idempotencyKeyTTL`, then CAS-store the returned first-batch Trigger run ID. If the field already equals it, replay succeeds; a different value fails closed. A crash after insert retries the missing handoff; a crash after trigger-before-return receives the same child from Trigger idempotency. Reload terminal state before returning `{ evidenceRunId, triggerRunId: ctx.run.id, terminal }`.

The task IDs are `shopify-evidence-start` and `shopify-evidence-batch`. Do not add a schedule in Plan 1.

Per Trigger.dev's lifecycle contract, `onFailure` is immediate best-effort recovery after ordinary retry exhaustion; it is not called for every crashed/system-failure/canceled/max-duration status, and errors inside it do not change the Trigger result. Therefore the persisted heartbeat/lease is mandatory rather than optional. Every later supervisor and every fresh start reconciles an expired row before waiting or inserting. Source-boundary tests prove both hooks ignore their `error` object, use only fixed codes, and that a simulated missing hook still converges through lease expiry without overwriting committed evidence.

- [ ] **Step 4: Type-check and run the Trigger boundary tests**

Run: `bun run test -- src/lib/evidence-window.test.ts src/lib/shopify-evidence.integration.test.ts src/lib/shopify-evidence-runner.test.ts`

Expected: PASS.

Run: `bunx tsc --noEmit`

Expected: exit code 0; Trigger payload and task references type-check.

- [ ] **Step 5: Commit the Trigger evidence path**

```bash
git add trigger/shopify-evidence-sync.ts src/lib/evidence-window.ts src/lib/evidence-window.test.ts src/lib/shopify-evidence-admin.test.ts src/lib/shopify-evidence-store.ts src/lib/shopify-evidence.integration.test.ts src/lib/shopify-evidence-runner.test.ts
git commit -m "feat(shopify): add resumable evidence sync tasks"
```

## Task 9: Add erasure, uninstall cleanup, and organization cascades

**Files:**
- Create: `src/lib/shopify-privacy.ts`
- Create: `src/lib/shopify-privacy.integration.test.ts`
- Modify: `src/lib/trpc/routers/organization.ts:1-85`

- [ ] **Step 1: Write privacy integration tests**

Create `src/lib/shopify-privacy.integration.test.ts` using the migration-0053 disposable database fixture. Seed the same email under two stores using `computeIdentityDigests`, then add:

```ts
describeIfDb("Shopify pilot privacy", () => {
  it("erases every configured version for one subject and one store", async () => {
    const result = await eraseShopifySubjectByEmail({
      scope: { organizationId: "org_a", storeId: "store_a" },
      email: "person@example.com",
      keyring,
      suppressionKey,
    });
    expect(result).toEqual({
      ordersCleared: 1,
      digestsDeleted: 2,
      suppressionsUpserted: 2,
    });
    expect(await readOrderCustomerId("order_a")).toBeNull();
    expect(await readDigestCount("order_a")).toBe(0);
  });

  it("does not erase the same email in another store", async () => {
    await eraseShopifySubjectByEmail({
      scope: { organizationId: "org_a", storeId: "store_a" },
      email: "person@example.com",
      keyring,
      suppressionKey,
    });
    expect(await readOrderCustomerId("order_b")).toBe(
      "gid://shopify/Customer/2",
    );
    expect(await readDigestCount("order_b")).toBe(2);
  });

  it("fails without writes when a stored key version has no configured secret", async () => {
    await insertStoredDigest({
      orderId: "order_a",
      keyVersion: "v0",
      digest: "retired-secret-digest",
    });
    const before = await readOrderIdentitySnapshot("order_a");
    await expect(
      eraseShopifySubjectByEmail({
        scope: { organizationId: "org_a", storeId: "store_a" },
        email: "person@example.com",
        keyring,
        suppressionKey,
      }),
    ).rejects.toThrow("Identity HMAC secret is unavailable for stored key version v0");
    expect(await readOrderIdentitySnapshot("order_a")).toEqual(before);
  });

  it("clears all pilot identity for uninstall but retains commerce and lines", async () => {
    const before = await readCommerceSnapshot("store_a");
    await clearPilotShopifyIdentityForStore({
      organizationId: "org_a",
      storeId: "store_a",
    });
    expect(await readAllCustomerIds("store_a")).toEqual([null]);
    expect(await readStoreDigestCount("store_a")).toBe(0);
    expect(await readCommerceSnapshot("store_a")).toEqual(before);
  });

  it("cascades Shopify truth and evidence when the organization is deleted", async () => {
    await testDb!.execute(sql`DELETE FROM organization WHERE id = 'org_a'`);
    expect(await readStoreCount("org_a")).toBe(0);
    expect(await readOrderCount("org_a")).toBe(0);
    expect(await readEvidenceCount("org_a")).toBe(0);
  });
});
```

Add cases proving an erasure with no currently matching order still inserts the email tombstone; replay is idempotent; a different store survives; a missing/mismatched stable suppression key fails before writes; and uninstall preserves tombstones. Explicitly use the same suppression version with a different secret and prove the stored `identity_crypto_policy` check rejects it before lookup/deletion. Test suppression-root reuse against both current and previous matching roots: `eraseShopifySubjectByEmail` must make zero writes. After erasure, replay the same historical order through `commitShopifyEvidenceOrder` using both its email and customer-alias suppression candidates. It must retain commerce/lines, clear identity, store `identityDisposition: "suppressed"`, omit the identity observation, and never recreate matching HMAC rows. Race erasure against that commit and prove either lock ordering produces the same final private state.

`readCommerceSnapshot` must include order count, `sum(net_sales)`, refund count/amount, line count, bucket/rule version, and Meta-verification fields. It must exclude customer ID and matching-HMAC rows because those are the intended deletion targets. Snapshot suppression rows separately: they must be inserted by subject erasure, survive identity-only uninstall, and cascade only with store/organization deletion.

- [ ] **Step 2: Run privacy tests to verify missing functions**

Run: `bun run test -- src/lib/shopify-privacy.integration.test.ts`

Expected: FAIL because `shopify-privacy.ts` does not exist.

- [ ] **Step 3: Implement subject erasure**

Create `src/lib/shopify-privacy.ts` with this public boundary:

```ts
export async function eraseShopifySubjectByEmail(params: {
  scope: IdentityScope;
  email: string;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): Promise<{
  ordersCleared: number;
  digestsDeleted: number;
  suppressionsUpserted: number;
}>;
```

Before entering the transaction, first compute the combined non-secret key checks (thereby validating root independence), then compute all configured matching subject digests and the stable email suppression subject digest. Then implement one transaction in this exact order:

1. Lock the exact scoped `shopify_store` row `FOR UPDATE`; a missing/mismatched store fails before writes. This is the same lock acquired first by `commitShopifyEvidenceOrder`.
2. Validate the precomputed non-secret key checks against the locked `identity_crypto_policy` before subject lookup or write. Same-version/different-secret suppression input fails. Then read all matching-digest key versions retained in that store and fail before writes if any required matching secret is unavailable; mixed or mismatched policy/keyring state is not accepted automatically.
3. Resolve every Shopify order whose scoped matching digest equals one computed subject digest and load its nullable customer ID under the lock. Compute `shopify_customer_id` suppression HMACs in memory from those IDs; never retain the raw aliases beyond the transaction input.
4. Upsert the email suppression row and every discovered customer-alias suppression row with `ON CONFLICT DO NOTHING` **before** clearing identity. The email row is inserted even when no current order matches, so a later historical/new order cannot recreate the subject. Count only newly inserted rows.
5. With targeted SQL, set `shopify_customer_id = NULL` for the matched order IDs without invoking the production `updated_at` hook. Delete only those orders' `source_identity_hmac` rows; dependent run identity observations cascade while identity-free content observations remain.
6. Return safe counts. A repeated request is idempotent and retains the tombstone even when zero identity rows remain.

Do not log the supplied/normalized email, raw customer ID, either HMAC digest, either key, or database parameters containing them. Add an injected transaction/executor overload in Plan 3 only for the cross-source store→connection transaction; Plan 1's public path owns its transaction and store lock.

- [ ] **Step 4: Implement the future Klaviyo-uninstall identity hook**

Add:

```ts
export type ShopifyPrivacyExecutor = Pick<typeof db, "execute" | "delete">;

async function clearPilotIdentityWithExecutor(
  scope: IdentityScope,
  executor: ShopifyPrivacyExecutor,
): Promise<{ ordersCleared: number; digestsDeleted: number }> {
    const cleared = await executor.execute<{ id: string }>(sql`
      update shopify_order
      set shopify_customer_id = null
      where organization_id = ${scope.organizationId}
        and store_id = ${scope.storeId}
        and shopify_customer_id is not null
      returning id
    `);
    const deleted = await executor
      .delete(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, scope.organizationId),
          eq(sourceIdentityHmacs.storeId, scope.storeId),
          eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
        ),
      )
      .returning({ id: sourceIdentityHmacs.id });
    return {
      ordersCleared: cleared.rows.length,
      digestsDeleted: deleted.length,
    };
}

export async function clearPilotShopifyIdentityForStore(
  scope: IdentityScope,
  executor?: ShopifyPrivacyExecutor,
): Promise<{ ordersCleared: number; digestsDeleted: number }> {
  if (executor) return clearPilotIdentityWithExecutor(scope, executor);
  return db.transaction(async (tx) => {
    await lockScopedShopifyStore(scope, tx);
    return clearPilotIdentityWithExecutor(scope, tx);
  });
}
```

The executor form requires its caller to already hold the scoped Shopify store lock; Plan 2 initially does so before cleanup, and Plan 3 strengthens uninstall to store→connection order before calling it. The no-executor form opens its own transaction and takes that store lock. Both forms intentionally retain `identity_erasure_suppression`, `shopify_order`, `shopify_refund`, and `shopify_order_line`; uninstall cannot revoke a subject's erasure. The targeted SQL updates are intentional: using `.update(shopifyOrders)` would invoke the schema's `$onUpdate` hook and mutate the production `updated_at` column. Add `updated_at` and suppression rows to every privacy before/after snapshot and assert the timestamp remains identical and tombstones remain after uninstall cleanup.

- [ ] **Step 5: Make workspace deletion explicitly delete Shopify stores**

Import `shopifyStores` in `src/lib/trpc/routers/organization.ts`:

```ts
import { shopifyStores } from "@/schema/shopify";
```

Immediately before clearing active sessions, add:

```ts
await tx
  .delete(shopifyStores)
  .where(eq(shopifyStores.organizationId, input.organizationId));
```

The store cascade deletes Shopify orders, refunds, lines, identity rows, and evidence runs. The organization FK ensures direct organization deletion has the same behavior.

- [ ] **Step 6: Run privacy, organization RBAC, and evidence tests**

Run: `bun run test -- src/lib/shopify-privacy.integration.test.ts src/lib/trpc/routers/organization.test.ts src/lib/shopify-evidence.integration.test.ts`

Expected: PASS. RBAC remains owner-only; privacy deletion remains store-scoped and retains commerce during uninstall cleanup.

- [ ] **Step 7: Commit privacy deletion**

```bash
git add src/lib/shopify-privacy.ts src/lib/shopify-privacy.integration.test.ts src/lib/trpc/routers/organization.ts
git commit -m "feat(privacy): erase Shopify pilot identity safely"
```

## Task 10: Prove monetary reconciliation is unchanged

**Files:**
- Create: `src/lib/shopify-evidence-reconciliation.integration.test.ts`
- Read only: `src/lib/attribution-queries.ts:253-375,554-595`
- Read only: `src/lib/shopify-ingest.ts:549-680,753-875`

- [ ] **Step 1: Write the before/after reconciliation test**

Create `src/lib/shopify-evidence-reconciliation.integration.test.ts` with the disposable migration-0053 fixture. Seed:

- three orders in different production buckets;
- one pending order;
- two refunds on different days;
- one Meta-verified order and one verification-pending order;
- fixed bucket rule versions.

Define this exact reader:

```ts
async function readReconciliationSnapshot(scope: {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const [bucketTotals, metaVerified, [base]] = await Promise.all([
    getBucketTotals(scope),
    getMetaVerified(scope),
    testDb!.execute(sql`
      SELECT
        count(DISTINCT o.id)::int AS order_count,
        coalesce(sum(o.net_sales), 0)::text AS gross,
        coalesce((
          SELECT sum(r.amount)
          FROM shopify_refund AS r
          WHERE r.organization_id = ${scope.organizationId}
            AND r.store_id = ${scope.storeId}
        ), 0)::text AS refunded,
        array_agg(DISTINCT o.bucket_rule_version ORDER BY o.bucket_rule_version) AS rule_versions,
        array_agg(
          o.id || ':' || o.updated_at::text
          ORDER BY o.id
        ) AS production_row_timestamps,
        count(*) FILTER (WHERE o.meta_verified)::int AS meta_verified_count,
        count(*) FILTER (WHERE o.verification_pending)::int AS verification_pending_count
      FROM shopify_order AS o
      WHERE o.organization_id = ${scope.organizationId}
        AND o.store_id = ${scope.storeId}
    `),
  ]);
  return { bucketTotals, metaVerified, base };
}
```

Add the test:

```ts
it("keeps Shopify money and attribution byte-for-byte unchanged", async () => {
  const before = await readReconciliationSnapshot(SCOPE);

  await replaceCompleteShopifyLineSet(SCOPE, COMPLETE_LINES);
  await persistShopifyIdentityEvidence(
    SCOPE,
    "gid://shopify/Order/1",
    AVAILABLE_IDENTITY,
  );
  await replaceCompleteShopifyLineSet(SCOPE, COMPLETE_LINES);

  const afterReplay = await readReconciliationSnapshot(SCOPE);
  expect(afterReplay).toEqual(before);

  await eraseShopifySubjectByEmail({
    scope: SCOPE,
    email: "person@example.com",
    keyring: KEYRING,
    suppressionKey: SUPPRESSION_KEY,
  });
  const afterErasure = await readReconciliationSnapshot(SCOPE);
  expect(afterErasure).toEqual(before);

  await clearPilotShopifyIdentityForStore(SCOPE);
  const afterUninstallCleanup = await readReconciliationSnapshot(SCOPE);
  expect(afterUninstallCleanup).toEqual(before);
});
```

- [ ] **Step 2: Run the reconciliation test**

Run: `bun run test -- src/lib/shopify-evidence-reconciliation.integration.test.ts`

Expected: PASS. Any difference in order count, Net sales, refund totals, bucket totals/rules, Meta verification, or production `shopify_order.updated_at` timestamps fails the plan gate.

- [ ] **Step 3: Run the complete focused Plan 1 suite**

Run:

```bash
bun run test -- \
  src/lib/shopify-ingest.test.ts \
  src/lib/shopify-store.integration.test.ts \
  src/lib/evidence-window.test.ts \
  src/lib/identity-hmac.test.ts \
  src/lib/shopify-evidence-admin.test.ts \
  src/lib/shopify-evidence.integration.test.ts \
  src/lib/shopify-evidence-runner.test.ts \
  src/lib/shopify-privacy.integration.test.ts \
  src/lib/shopify-evidence-reconciliation.integration.test.ts \
  src/lib/trpc/routers/organization.test.ts
```

Expected: exit code 0 with no skipped database-backed test when `DATABASE_URL` is configured.

- [ ] **Step 4: Commit the reconciliation gate**

```bash
git add src/lib/shopify-evidence-reconciliation.integration.test.ts
git commit -m "test(attribution): prove evidence preserves reconciliation"
```

## Task 11: Final verification and Plan 2 handoff

**Files:**
- Verify only: all files listed in this plan

- [ ] **Step 1: Run the full repository test suite**

Run: `bun run test`

Expected: exit code 0.

- [ ] **Step 2: Run lint**

Run: `bun run lint`

Expected: exit code 0 with no `lucide-react` import and no new lint suppression.

- [ ] **Step 3: Run the production build**

Run: `bun run build`

Expected: exit code 0.

- [ ] **Step 4: Check formatting and migration state**

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: no uncommitted product-code changes. The working tree may contain only separately coordinated plan documents that are intentionally not part of the implementation commits.

- [ ] **Step 5: Audit the evidence-to-money boundary**

Run:

```bash
rg -n "netSales|shopifyRefunds|bucketRuleVersion|metaVerified|verificationPending|customerJourney|cancelledAt|orderSourceName" \
  src/lib/shopify-evidence-admin.ts \
  src/lib/shopify-evidence-store.ts \
  src/lib/shopify-evidence-runner.ts \
  src/lib/shopify-privacy.ts \
  trigger/shopify-evidence-sync.ts
```

Expected: no output except test fixture names outside these production paths. Evidence production code may update only `shopifyCustomerId`, `shopifyOrderLines`, `sourceIdentityHmacs`, append-only `identityMatchingKeyBindings`, `identityCryptoPolicies`, `identityErasureSuppressions`, `shopifyEvidenceSyncRuns`, `shopifyEvidenceRunObservations`, and `shopifyEvidenceRunIdentityObservations`.

- [ ] **Step 6: Verify Plan 3 migration ownership is documented**

Confirm `src/schema/shopify-evidence.ts` exports `sourceIdentityHmacs` with only `shopify_order` support and that no nullable unreferenced Klaviyo source column was added. Record this handoff in the Plan 3 implementation notes:

```text
Plan 3 extends source_identity_hmac after klaviyo_event exists: make
shopify_order_id nullable, add nullable klaviyo_connection_id and
klaviyo_event_id, add klaviyo_event to source_identity_kind, replace the
Shopify-only check with an exactly-one-source check, add a same-scope event FK
cascade, and replace the Shopify-only unique constraint with partial unique
indexes for (shopify_order_id, key_version) and
(klaviyo_connection_id, klaviyo_event_id, key_version) while retaining the
scoped row-ID keys and Shopify identity-observation cascades. The Plan 1 uninstall helper must retain its
source_kind='shopify_order' filter after that extension; Klaviyo digest cleanup
comes from deleting the connection/event rows.
Plan 3 also extends identity_erasure_suppression_kind with klaviyo_profile_id,
keeps every stored alias HMAC-only, checks tombstones in both scheduled writers,
and preserves tombstones across connection uninstall/reinstall. It adds the
connection current_only/dual key-version gate that becomes authoritative for
all ordinary identity writes after migration 0055.
```

- [ ] **Step 7: Confirm commit hygiene**

Run: `git status --short`

Expected: no uncommitted Plan 1 implementation files. If verification exposed a defect, return to the task that owns that file, repeat its focused test and commit steps, then rerun Task 11 from Step 1. Do not create an empty verification commit.

## Plan 1 completion gate

- [ ] Store-domain ownership conflicts fail closed and cannot reassign organizations.
- [ ] The production monetary Shopify query still excludes line items and protected identity.
- [ ] Line pages are complete before transactional replacement; incomplete pages preserve prior lines.
- [ ] Retryable line failures escape to Trigger.dev and replay from the last committed scoped cursor; deterministic invalid line sets terminate partial without raw error persistence.
- [ ] Protected identity denial never blocks line ingestion.
- [ ] Each committed order atomically publishes identity-free content observation lineage plus an optional exact current-HMAC-row link; erasure/uninstall removes identity links without removing non-identity snapshots.
- [ ] Subject erasure inserts stable store-scoped HMAC-only email/customer suppressions before deletion; replay and concurrent scheduled evidence writes cannot recreate identity, while uninstall preserves tombstones.
- [ ] The store-owned lifetime matching-key registry rejects historical same-label secret drift before remote identity calls or writes; per-store active matching/suppression checks remain valid, and only Plan 3 rotation may transition the active matching pair.
- [ ] Evidence identity writes, erasure, and uninstall do not change `shopify_order.updated_at` or any monetary/attribution field.
- [ ] Checkpoint and finish mutations require organization, store, run ID, and `running` status and reject cross-scope or terminal-run rewrites.
- [ ] Plaintext email is never persisted, returned, snapshotted, or logged.
- [ ] Equal emails produce different digests across organizations/stores and coexist by key version only during rotation.
- [ ] Organization/store deletion cascades evidence and suppression rows; subject erasure and future Klaviyo uninstall clear pilot Shopify identity while retaining commerce truth as specified.
- [ ] Evidence tasks use an explicit organization/store/domain binding and a separate Trigger queue/run table.
- [ ] Order count, Net sales, refunds, bucket totals/rule versions, and Meta-verification totals are exactly unchanged after evidence replay and privacy cleanup.
- [ ] Migration 0053, focused tests, full tests, lint, build, and `git diff --check` all pass.
