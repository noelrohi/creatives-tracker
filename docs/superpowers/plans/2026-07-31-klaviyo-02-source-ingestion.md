# Klaviyo Source Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Reviv-bound Klaviyo connection that discovers the correct account and Shopify metrics, persists a privacy-safe live probe, approves deterministic join rules, and idempotently ingests the approved 90-day `Placed Order` and `Ordered Product` source core.

**Architecture:** Server-only code resolves one allowlisted environment credential through a connection-scoped provider, then calls a small Klaviyo JSON:API client with pinned endpoint revisions and bounded retries. Discovery, probe, redaction, and source persistence live under `src/lib/klaviyo/`; thin Trigger.dev tasks call those services, while an owner/admin-only tRPC router starts work and reviews probe/rule records. All source rows carry organization, Shopify store, and Klaviyo connection scope, and no raw response, plaintext email, unrestricted URL, or matching conclusion is stored in this plan.

**Tech Stack:** TypeScript, Next.js 16, tRPC 11, Drizzle ORM, PostgreSQL, Trigger.dev 4, Zod 4, Vitest 4, Bun.

---

## Dependencies and boundaries

- Execute `docs/superpowers/plans/2026-07-31-klaviyo-01-shopify-evidence-foundation.md` first.
- Plan 1 owns migration `drizzle/0053_klaviyo_shopify_evidence.sql` and exports:
  - `shopifyOrderLines`, `sourceIdentityHmacs`, and `shopifyEvidenceSyncRuns` from `src/schema/shopify-evidence.ts`;
  - `IdentityHmacKey`, `IdentityHmacKeyring`, `IdentityScope`, `VersionedIdentityDigest`, `normalizeIdentityEmail`, `parseIdentityHmacKeyring`, `deriveTenantIdentityKey`, `digestIdentityEmail`, and `computeIdentityDigests` from `src/lib/identity-hmac.ts`.
  - `HalfOpenWindow` and `inclusiveStoreDaysToHalfOpenUtc` from `src/lib/evidence-window.ts`.
  - `clearPilotShopifyIdentityForStore(scope, executor?)` and `ShopifyPrivacyExecutor` from `src/lib/shopify-privacy.ts`; it returns `{ ordersCleared, digestsDeleted }`, and the injected executor lets Plan 2 clear pilot Shopify identity inside the same transaction that deletes the Klaviyo connection.
- `source_identity_hmac` remains Shopify-only in this plan. Plan 3 adds its Klaviyo-event foreign key and persists Klaviyo identity digests when advisory matching is introduced. The probe may compute Klaviyo email digests in memory for aggregate coverage, but it never persists those digests or plaintext email.
- Parse the Plan 1 identity keyring before connection bootstrap, discovery, probe, or any event request. Missing/invalid HMAC configuration fails before a database write or remote call even though Plan 2 does not persist Klaviyo digests.
- Plan 2 owns migration `drizzle/0054_klaviyo_source_core.sql`, generated only after Plan 1 migration metadata is present.
- Plan 2 does not create match candidates/results, product comparisons, attribution claims, journeys, report facts, or UI pages.
- Every repository/service entry point below bootstrap/task resolution accepts the roadmap contract. The only exceptions are `ensurePilotConnection(organizationId)`, which resolves the configured Reviv store inside that organization, and internal task resolvers that turn a globally unique `connectionId`/`syncRunId` into this full scope before invoking services:

```ts
export type KlaviyoConnectionScope = {
  organizationId: string;
  storeId: string;
  connectionId: string;
};

export type { HalfOpenWindow } from "@/lib/evidence-window";
```

## File map

| Path | Responsibility |
| --- | --- |
| `.env.example` | Document the server/worker-only Klaviyo credential and explicit Reviv binding. |
| `src/lib/klaviyo/types.ts` | Stable Plan 2 scope, metric, checkpoint, and normalized-source types; re-export Plan 1's shared window type. |
| `src/lib/klaviyo/credential-provider.ts` | Resolve only the named Reviv environment credential plus public binding/URL-host configuration and fail closed on account/store disagreement. |
| `src/lib/klaviyo/client.ts` | Klaviyo JSON:API transport, revisions, pagination, retry handling, and sanitized errors. |
| `src/schema/klaviyo.ts` | Connection, metrics, probe, scoped event aliases, join rules, sync runs, source events, and source products. |
| `src/lib/klaviyo/source-store.ts` | Tenant-scoped bootstrap/persistence, approved-alias loading, and transactional discovery/page/checkpoint writes. |
| `src/lib/klaviyo/redaction.ts` | Allowlisted scalar/URL normalization plus bounded key/type fingerprints. |
| `src/lib/klaviyo/event-normalizer.ts` | Convert one compound Events API page into typed source rows before persistence or logging. |
| `src/lib/klaviyo/discovery.ts` | Verify the account and uniquely resolve Shopify-native metrics. |
| `src/lib/klaviyo/probe.ts` | Sample 20–50 orders, measure identifiers/products/attributions, and persist only aggregate redacted evidence. |
| `src/lib/klaviyo/join-rules.ts` | Review probe reports and approve/reject canonicalization rules transactionally. |
| `src/lib/klaviyo/connection-lifecycle.ts` | Uninstall a connection and clear pilot identity without deleting Shopify commerce evidence. |
| `src/lib/klaviyo/source-runner.ts` | Start/resume bounded event runs and advance opaque checkpoints. |
| `trigger/klaviyo-source-sync.ts` | Thin discovery, probe, backfill, batch-continuation, and incremental Trigger.dev tasks. |
| `src/lib/trpc/routers/klaviyo.ts` | Owner/admin pilot mutations and connection/probe/rule reads. |
| `src/lib/trpc/routers/_app.ts` | Mount the `klaviyo` router. |

### Task 1: Define shared Klaviyo source types

**Files:**
- Create: `src/lib/klaviyo/types.ts`
- Test: `src/lib/klaviyo/types.test.ts`

- [ ] **Step 1: Write the failing type/runtime boundary test**

```ts
// src/lib/klaviyo/types.test.ts
import { describe, expect, it } from "vitest";
import {
  KLAVIYO_ORDER_CORE_KINDS,
  assertExactOrderCoreRequestParameters,
  assertOrderCoreSourceContract,
  assertHalfOpenWindow,
  initialEventCheckpoint,
  orderCoreSourceContract,
} from "@/lib/klaviyo/types";

describe("Klaviyo source types", () => {
  it("keeps the order-core metric order deterministic", () => {
    expect(KLAVIYO_ORDER_CORE_KINDS).toEqual([
      "placed_order",
      "ordered_product",
    ]);
    expect(initialEventCheckpoint()).toEqual({
      ...orderCoreSourceContract(),
      metricIndex: 0,
      cursor: null,
      page: 0,
    });
  });

  it("accepts only a non-empty half-open window", () => {
    expect(() =>
      assertHalfOpenWindow({
        from: new Date("2026-05-01T00:00:00.000Z"),
        to: new Date("2026-07-30T00:00:00.000Z"),
      }),
    ).not.toThrow();
    expect(() =>
      assertHalfOpenWindow({
        from: new Date("2026-07-30T00:00:00.000Z"),
        to: new Date("2026-07-30T00:00:00.000Z"),
      }),
    ).toThrow("from must be before to");
  });

  it("pins the immutable order-core run contract", () => {
    expect(orderCoreSourceContract()).toEqual({
      sourceMode: "order_core",
      metricKinds: ["placed_order", "ordered_product"],
    });
    expect(() =>
      assertOrderCoreSourceContract({
        sourceMode: "journey",
        metricKinds: ["placed_order"],
      }),
    ).toThrow("invalid source contract");
    expect(() =>
      assertExactOrderCoreRequestParameters({
        ...orderCoreSourceContract(),
        unsafeExtra: true,
      }),
    ).toThrow("not immutable order core");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- src/lib/klaviyo/types.test.ts`

Expected: FAIL with `Failed to resolve import "@/lib/klaviyo/types"`.

- [ ] **Step 3: Implement the shared contracts**

```ts
// src/lib/klaviyo/types.ts
import {
  inclusiveStoreDaysToHalfOpenUtc,
  type HalfOpenWindow,
} from "@/lib/evidence-window";

export { inclusiveStoreDaysToHalfOpenUtc };
export type { HalfOpenWindow };

export const KLAVIYO_ORDER_CORE_KINDS = [
  "placed_order",
  "ordered_product",
] as const;

export const KLAVIYO_ALLOWED_METRIC_KINDS = [
  ...KLAVIYO_ORDER_CORE_KINDS,
  "clicked_email",
  "clicked_sms",
  "active_on_site",
  "viewed_product",
  "added_to_cart",
  "checkout_started",
] as const;

export type KlaviyoMetricKind =
  (typeof KLAVIYO_ALLOWED_METRIC_KINDS)[number];

export const KLAVIYO_EVENT_ALIAS_FIELDS = [
  "orderId",
  "uniqueEventId",
  "productId",
  "variantId",
  "sku",
  "productName",
  "variantName",
  "quantity",
  "value",
  "currency",
  "items",
] as const;

export type KlaviyoEventAliasField =
  (typeof KLAVIYO_EVENT_ALIAS_FIELDS)[number];

export type KlaviyoEventAliasRegistry = Record<
  KlaviyoEventAliasField,
  string | null
>;

export type OrderCoreSourceContract = {
  sourceMode: "order_core";
  metricKinds: ["placed_order", "ordered_product"];
};

export function orderCoreSourceContract(): OrderCoreSourceContract {
  return {
    sourceMode: "order_core",
    metricKinds: ["placed_order", "ordered_product"],
  };
}

export function assertOrderCoreSourceContract(
  value: unknown,
): asserts value is OrderCoreSourceContract {
  const candidate = value as Partial<OrderCoreSourceContract> | null;
  if (
    candidate?.sourceMode !== "order_core" ||
    JSON.stringify(candidate.metricKinds) !==
      JSON.stringify(KLAVIYO_ORDER_CORE_KINDS)
  ) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
}

export function assertExactOrderCoreRequestParameters(
  value: unknown,
): asserts value is OrderCoreSourceContract {
  assertOrderCoreSourceContract(value);
  if (
    JSON.stringify(Object.keys(value as object).sort()) !==
    JSON.stringify(["metricKinds", "sourceMode"])
  ) {
    throw new Error("Klaviyo event run request parameters are not immutable order core");
  }
}

export type EnabledOrderCoreMetric = {
  metricRowId: string;
  externalMetricId: string;
  metricKind: (typeof KLAVIYO_ORDER_CORE_KINDS)[number];
  approvedAliases: KlaviyoEventAliasRegistry;
};

export type KlaviyoConnectionScope = {
  organizationId: string;
  storeId: string;
  connectionId: string;
};

export function assertHalfOpenWindow(window: HalfOpenWindow): void {
  if (
    Number.isNaN(window.from.getTime()) ||
    Number.isNaN(window.to.getTime())
  ) {
    throw new Error("Klaviyo window must contain valid dates");
  }
  if (window.from.getTime() >= window.to.getTime()) {
    throw new Error("Klaviyo window from must be before to");
  }
}

export type KlaviyoEventCheckpoint = OrderCoreSourceContract & {
  metricIndex: number;
  cursor: string | null;
  page: number;
};

export type ProductEvidenceCompleteness =
  | "complete"
  | "incomplete"
  | "unavailable";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null";

export type PropertyFingerprintEntry = {
  key: string;
  keyKind: "approved" | "sha256";
  type: JsonType;
};

export type RedactedProbeExample = {
  metricKind: (typeof KLAVIYO_ORDER_CORE_KINDS)[number];
  occurredOnUtc: string;
  fingerprint: PropertyFingerprintEntry[];
  warnings: string[];
};

export type RedactedEventEvidence = {
  values: Record<string, JsonValue>;
  fingerprint: PropertyFingerprintEntry[];
  warnings: string[];
  truncated: boolean;
};

export type NormalizedKlaviyoProduct = {
  sourceOrdinal: number;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  productName: string | null;
  variantName: string | null;
  quantity: number | null;
};

export type NormalizedKlaviyoEvent = {
  externalEventId: string;
  eventUuid: string | null;
  metricId: string;
  metricKind: KlaviyoMetricKind;
  occurredAt: Date;
  profileId: string | null;
  explicitOrderIdCandidate: string | null;
  providerUniqueIdCandidate: string | null;
  providerValue: string | null;
  providerCurrency: string | null;
  attributionRelationshipIds: string[];
  evidence: RedactedEventEvidence;
  products: NormalizedKlaviyoProduct[];
  productEvidenceCompleteness: ProductEvidenceCompleteness;
  sourceChecksum: string;
  apiRevision: string;
};

export function initialEventCheckpoint(): KlaviyoEventCheckpoint {
  return {
    ...orderCoreSourceContract(),
    metricIndex: 0,
    cursor: null,
    page: 0,
  };
}

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- src/lib/klaviyo/types.test.ts`

Expected: PASS with 3 tests.

- [ ] **Step 5: Commit the contracts**

```bash
git add src/lib/klaviyo/types.ts src/lib/klaviyo/types.test.ts
git commit -m "feat(klaviyo): define source ingestion contracts"
```

### Task 2: Add the Reviv credential provider

**Files:**
- Create: `src/lib/klaviyo/credential-provider.ts`
- Test: `src/lib/klaviyo/credential-provider.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing credential-boundary tests**

```ts
// src/lib/klaviyo/credential-provider.test.ts
import { describe, expect, it } from "vitest";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialRequest,
} from "@/lib/klaviyo/credential-provider";

const request: KlaviyoCredentialRequest = {
  connectionId: "connection-1",
  credentialReference: "reviv_environment",
  persistedKlaviyoAccountId: null,
  shopDomain: "reviv.example.myshopify.com",
};

describe("EnvironmentKlaviyoCredentialProvider", () => {
  it("allows a pending connection and returns the expected account binding", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider({
      KLAVIYO_PRIVATE_API_KEY: "pk_test_secret",
      KLAVIYO_REVIV_ACCOUNT_ID: "account-reviv",
      KLAVIYO_REVIV_SHOP_DOMAIN: "Reviv.Example.MyShopify.com/",
      KLAVIYO_REVIV_ALLOWED_URL_HOSTS: "www.reviv.example,links.reviv.example",
    });

    await expect(provider.resolve(request)).resolves.toEqual({
      privateApiKey: "pk_test_secret",
      reference: "reviv_environment",
      expectedAccountId: "account-reviv",
      allowedUrlHosts: [
        "links.reviv.example",
        "reviv.example.myshopify.com",
        "www.reviv.example",
      ],
    });
  });

  it("fails before returning a key when the store binding differs", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider({
      KLAVIYO_PRIVATE_API_KEY: "pk_test_secret",
      KLAVIYO_REVIV_ACCOUNT_ID: "account-reviv",
      KLAVIYO_REVIV_SHOP_DOMAIN: "other.myshopify.com",
      KLAVIYO_REVIV_ALLOWED_URL_HOSTS: "www.reviv.example",
    });

    await expect(provider.resolve(request)).rejects.toThrow(
      "Klaviyo connection binding does not match the configured Reviv store",
    );
  });

  it("fails when a previously discovered account differs from the binding", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider({
      KLAVIYO_PRIVATE_API_KEY: "pk_test_secret",
      KLAVIYO_REVIV_ACCOUNT_ID: "account-reviv",
      KLAVIYO_REVIV_SHOP_DOMAIN: "reviv.example.myshopify.com",
      KLAVIYO_REVIV_ALLOWED_URL_HOSTS: "www.reviv.example",
    });

    await expect(
      provider.resolve({
        ...request,
        persistedKlaviyoAccountId: "another-account",
      }),
    ).rejects.toThrow(
      "Klaviyo connection binding does not match the configured Reviv store",
    );
  });

  it("never accepts an arbitrary credential reference", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider({
      KLAVIYO_PRIVATE_API_KEY: "pk_test_secret",
      KLAVIYO_REVIV_ACCOUNT_ID: "account-reviv",
      KLAVIYO_REVIV_SHOP_DOMAIN: "reviv.example.myshopify.com",
      KLAVIYO_REVIV_ALLOWED_URL_HOSTS: "www.reviv.example",
    });

    await expect(
      provider.resolve({
        ...request,
        credentialReference: "user_supplied_name" as "reviv_environment",
      }),
    ).rejects.toThrow("Unsupported Klaviyo credential reference");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/credential-provider.test.ts`

Expected: FAIL with `Failed to resolve import "@/lib/klaviyo/credential-provider"`.

- [ ] **Step 3: Implement the environment provider**

```ts
// src/lib/klaviyo/credential-provider.ts
import "server-only";

export const KLAVIYO_CREDENTIAL_REFERENCE = "reviv_environment" as const;

export type KlaviyoCredentialRequest = {
  connectionId: string;
  credentialReference: typeof KLAVIYO_CREDENTIAL_REFERENCE;
  persistedKlaviyoAccountId: string | null;
  shopDomain: string;
};

export type RevivKlaviyoBinding = {
  expectedAccountId: string;
  shopDomain: string;
  allowedUrlHosts: string[];
};

export type ResolvedKlaviyoCredential = {
  privateApiKey: string;
  reference: typeof KLAVIYO_CREDENTIAL_REFERENCE;
} & Pick<RevivKlaviyoBinding, "expectedAccountId" | "allowedUrlHosts">;

export interface KlaviyoCredentialProvider {
  getPilotBinding(): Promise<RevivKlaviyoBinding>;
  resolve(
    request: KlaviyoCredentialRequest,
  ): Promise<ResolvedKlaviyoCredential>;
}

type KlaviyoEnvironment = Partial<
  Record<
    | "KLAVIYO_PRIVATE_API_KEY"
    | "KLAVIYO_REVIV_ACCOUNT_ID"
    | "KLAVIYO_REVIV_SHOP_DOMAIN"
    | "KLAVIYO_REVIV_ALLOWED_URL_HOSTS",
    string
  >
>;

function required(environment: KlaviyoEnvironment, name: keyof KlaviyoEnvironment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeShopDomain(value: string) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function parseAllowedUrlHosts(value: string, shopDomain: string): string[] {
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  hosts.push(shopDomain);
  for (const host of hosts) {
    if (
      host.includes("://") ||
      host.includes("/") ||
      host.includes("@") ||
      host.includes("*")
    ) {
      throw new Error("KLAVIYO_REVIV_ALLOWED_URL_HOSTS must contain exact hostnames");
    }
  }
  return [...new Set(hosts)].sort();
}

export class EnvironmentKlaviyoCredentialProvider
  implements KlaviyoCredentialProvider
{
  constructor(private readonly environment: KlaviyoEnvironment = process.env) {}

  async getPilotBinding(): Promise<RevivKlaviyoBinding> {
    // Validate the key now so bootstrap cannot write a pending row with a
    // missing credential, but never return the key from this public binding.
    required(this.environment, "KLAVIYO_PRIVATE_API_KEY");
    const shopDomain = normalizeShopDomain(
      required(this.environment, "KLAVIYO_REVIV_SHOP_DOMAIN"),
    );
    return {
      expectedAccountId: required(this.environment, "KLAVIYO_REVIV_ACCOUNT_ID"),
      shopDomain,
      allowedUrlHosts: parseAllowedUrlHosts(
        required(this.environment, "KLAVIYO_REVIV_ALLOWED_URL_HOSTS"),
        shopDomain,
      ),
    };
  }

  async resolve(
    request: KlaviyoCredentialRequest,
  ): Promise<ResolvedKlaviyoCredential> {
    if (request.credentialReference !== KLAVIYO_CREDENTIAL_REFERENCE) {
      throw new Error("Unsupported Klaviyo credential reference");
    }

    const binding = await this.getPilotBinding();

    if (
      (request.persistedKlaviyoAccountId !== null &&
        request.persistedKlaviyoAccountId !== binding.expectedAccountId) ||
      normalizeShopDomain(request.shopDomain) !== binding.shopDomain
    ) {
      throw new Error(
        "Klaviyo connection binding does not match the configured Reviv store",
      );
    }

    return {
      privateApiKey: required(this.environment, "KLAVIYO_PRIVATE_API_KEY"),
      reference: KLAVIYO_CREDENTIAL_REFERENCE,
      expectedAccountId: binding.expectedAccountId,
      allowedUrlHosts: binding.allowedUrlHosts,
    };
  }
}
```

- [ ] **Step 4: Document the binding without adding client-visible variables**

Append exactly this block to `.env.example`:

```dotenv

# Klaviyo Reviv evidence pilot (server/worker only)
KLAVIYO_PRIVATE_API_KEY=
KLAVIYO_REVIV_ACCOUNT_ID=
KLAVIYO_REVIV_SHOP_DOMAIN=
# Comma-separated exact HTTPS hostnames; no schemes, paths, ports, or wildcards.
KLAVIYO_REVIV_ALLOWED_URL_HOSTS=
```

- [ ] **Step 5: Run focused tests and lint**

Run: `bun run test -- src/lib/klaviyo/credential-provider.test.ts && bun run lint -- src/lib/klaviyo/credential-provider.ts src/lib/klaviyo/credential-provider.test.ts`

Expected: PASS with 4 tests and ESLint exit code 0.

- [ ] **Step 6: Commit the credential boundary**

```bash
git add .env.example src/lib/klaviyo/credential-provider.ts src/lib/klaviyo/credential-provider.test.ts
git commit -m "feat(klaviyo): add Reviv credential provider"
```

### Task 3: Add the pinned Klaviyo JSON:API client

**Files:**
- Create: `src/lib/klaviyo/client.ts`
- Test: `src/lib/klaviyo/client.test.ts`

- [ ] **Step 1: Write failing transport tests**

```ts
// src/lib/klaviyo/client.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KLAVIYO_API_REVISIONS,
  KlaviyoApiClient,
  KlaviyoApiError,
} from "@/lib/klaviyo/client";

afterEach(() => vi.restoreAllMocks());

describe("KlaviyoApiClient", () => {
  it("uses the Accounts revision and private-key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [], links: { self: "https://a.klaviyo.com/api/accounts" } }),
        { status: 200, headers: { "content-type": "application/vnd.api+json" } },
      ),
    );
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });

    await client.listAccounts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Klaviyo-API-Key pk_secret",
    );
    expect(new Headers(init.headers).get("revision")).toBe(
      KLAVIYO_API_REVISIONS.accounts,
    );
  });

  it("requests only sparse profile email for event identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], links: { self: "x", next: null } }), {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      }),
    );
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });

    await client.listEvents({
      metricId: "metric-1",
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
      cursor: null,
      includeAttributions: true,
      includeProfileEmail: true,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("include")).toBe("profile,metric,attributions");
    expect(url.searchParams.get("fields[profile]")).toBe("email");
    expect(url.searchParams.get("page[size]")).toBe("200");
  });

  it("omits profile email from Plan 2 source pages that do not hash identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], links: { next: null } }), {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      }),
    );
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });

    await client.listEvents({
      metricId: "metric-1",
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
      cursor: null,
      includeAttributions: true,
      includeProfileEmail: false,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("include")).toBe("metric,attributions");
    expect(url.searchParams.has("fields[profile]")).toBe(false);
  });

  it("honors Retry-After and returns only the opaque next cursor", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [] }), {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [],
            links: {
              self: "https://a.klaviyo.com/api/metrics",
              next: "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=opaque-token",
            },
          }),
          { status: 200, headers: { "content-type": "application/vnd.api+json" } },
        ),
      );
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep,
      random: () => 0,
    });

    await expect(client.listMetrics(null)).resolves.toMatchObject({
      nextCursor: "opaque-token",
    });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("rejects a pagination link on another host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [],
          links: { next: "https://evil.example/api/metrics?page%5Bcursor%5D=secret" },
        }),
        { status: 200, headers: { "content-type": "application/vnd.api+json" } },
      ),
    );
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });

    await expect(client.listMetrics(null)).rejects.toMatchObject({
      message: "Klaviyo returned an invalid pagination link",
    });
  });

  it("throws a sanitized error without response content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("email=user@example.com&key=pk_secret", { status: 403 }),
    );
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });

    const error = await client.listAccounts().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe("KlaviyoApiError: Klaviyo API request failed (403)");
    expect(String(error)).not.toContain("user@example.com");
    expect(String(error)).not.toContain("pk_secret");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/client.test.ts`

Expected: FAIL with `Failed to resolve import "@/lib/klaviyo/client"`.

- [ ] **Step 3: Implement the client transport and public methods**

Create `src/lib/klaviyo/client.ts` with these exported contracts and behavior:

```ts
import "server-only";
import type { HalfOpenWindow } from "@/lib/klaviyo/types";

const KLAVIYO_ORIGIN = "https://a.klaviyo.com";
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 60_000;

export const KLAVIYO_API_REVISIONS = {
  accounts: "2026-07-15",
  metrics: "2026-07-15",
  events: "2026-07-15",
} as const;

export type KlaviyoResource = {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};

export type KlaviyoCompoundPage = {
  data: KlaviyoResource[];
  included: KlaviyoResource[];
  nextCursor: string | null;
  apiRevision: string;
};

export class KlaviyoApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "KlaviyoApiError";
  }
}

type ClientOptions = {
  privateApiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

type RequestOptions = {
  path: string;
  revision: string;
  params?: URLSearchParams;
};

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function nextCursor(next: unknown): string | null {
  if (next === null || next === undefined) return null;
  if (typeof next !== "string") {
    throw new KlaviyoApiError(
      "Klaviyo returned an invalid pagination link",
      null,
      false,
    );
  }
  const url = new URL(next);
  if (url.protocol !== "https:" || url.origin !== KLAVIYO_ORIGIN) {
    throw new KlaviyoApiError(
      "Klaviyo returned an invalid pagination link",
      null,
      false,
    );
  }
  const cursor = url.searchParams.get("page[cursor]");
  if (!cursor) {
    throw new KlaviyoApiError(
      "Klaviyo returned an invalid pagination link",
      null,
      false,
    );
  }
  return cursor;
}

function eventFilter(metricId: string, window: HalfOpenWindow) {
  const from = JSON.stringify(window.from.toISOString());
  const to = JSON.stringify(window.to.toISOString());
  const metric = JSON.stringify(metricId);
  return `and(equals(metric_id,${metric}),greater-or-equal(datetime,${from}),less-than(datetime,${to}))`;
}

export class KlaviyoApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  private async request(options: RequestOptions): Promise<KlaviyoCompoundPage> {
    const url = new URL(options.path, KLAVIYO_ORIGIN);
    for (const [name, value] of options.params ?? new URLSearchParams()) {
      url.searchParams.set(name, value);
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            accept: "application/vnd.api+json",
            authorization: `Klaviyo-API-Key ${this.options.privateApiKey}`,
            revision: options.revision,
          },
        });
      } catch {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new KlaviyoApiError(
            "Klaviyo API network request failed",
            null,
            true,
          );
        }
        await this.sleep(500 * 2 ** attempt + Math.floor(this.random() * 250));
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        await this.sleep(
          Math.min(
            retryAfter ?? 500 * 2 ** attempt + Math.floor(this.random() * 250),
            MAX_RETRY_DELAY_MS,
          ),
        );
        continue;
      }
      if (!response.ok) {
        throw new KlaviyoApiError(
          `Klaviyo API request failed (${response.status})`,
          response.status,
          retryable,
        );
      }

      const body = (await response.json()) as {
        data?: KlaviyoResource[];
        included?: KlaviyoResource[];
        links?: { next?: unknown };
      };
      if (!Array.isArray(body.data)) {
        throw new KlaviyoApiError(
          "Klaviyo API response did not contain a resource collection",
          response.status,
          false,
        );
      }
      return {
        data: body.data,
        included: Array.isArray(body.included) ? body.included : [],
        nextCursor: nextCursor(body.links?.next),
        apiRevision: options.revision,
      };
    }

    throw new KlaviyoApiError(
      "Klaviyo API retry budget was exhausted",
      null,
      true,
    );
  }

  listAccounts() {
    return this.request({
      path: "/api/accounts",
      revision: KLAVIYO_API_REVISIONS.accounts,
    });
  }

  listMetrics(cursor: string | null) {
    const params = new URLSearchParams({ "page[size]": "100" });
    if (cursor) params.set("page[cursor]", cursor);
    return this.request({
      path: "/api/metrics",
      revision: KLAVIYO_API_REVISIONS.metrics,
      params,
    });
  }

  listEvents(input: {
    metricId: string;
    from: Date;
    to: Date;
    cursor: string | null;
    includeAttributions: boolean;
    includeProfileEmail: boolean;
  }) {
    const include = [
      ...(input.includeProfileEmail ? ["profile"] : []),
      "metric",
      ...(input.includeAttributions ? ["attributions"] : []),
    ].join(",");
    const params = new URLSearchParams({
      filter: eventFilter(input.metricId, { from: input.from, to: input.to }),
      include,
      "fields[event]": "id,datetime,event_properties,timestamp,uuid",
      "fields[metric]": "id,name,integration",
      "fields[attribution]": "id",
      "page[size]": "200",
      sort: "datetime",
    });
    if (input.includeProfileEmail) params.set("fields[profile]", "email");
    if (input.cursor) params.set("page[cursor]", input.cursor);
    return this.request({
      path: "/api/events",
      revision: KLAVIYO_API_REVISIONS.events,
      params,
    });
  }
}
```

- [ ] **Step 4: Run the client tests**

Run: `bun run test -- src/lib/klaviyo/client.test.ts`

Expected: PASS with 6 tests.

- [ ] **Step 5: Commit the client**

```bash
git add src/lib/klaviyo/client.ts src/lib/klaviyo/client.test.ts
git commit -m "feat(klaviyo): add pinned API client"
```

### Task 4: Add the connection, discovery, probe, and source schema

**Files:**
- Create: `src/schema/klaviyo.ts`
- Create: `src/lib/klaviyo/schema-contract.test.ts`
- Create: `drizzle/0054_klaviyo_source_core.sql`
- Create: `drizzle/meta/0054_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Write the failing schema contract test**

```ts
// src/lib/klaviyo/schema-contract.test.ts
import { describe, expect, it } from "vitest";
import {
  klaviyoConnections,
  klaviyoEventAliases,
  klaviyoEventRunObservations,
  klaviyoEvents,
  klaviyoEventProducts,
  klaviyoJoinRules,
  klaviyoMetrics,
  klaviyoProbeReports,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";

describe("Klaviyo source schema", () => {
  it("exports every Plan 2 table", () => {
    expect(klaviyoConnections).toBeDefined();
    expect(klaviyoEventAliases).toBeDefined();
    expect(klaviyoMetrics).toBeDefined();
    expect(klaviyoProbeReports).toBeDefined();
    expect(klaviyoJoinRules).toBeDefined();
    expect(klaviyoSyncRuns).toBeDefined();
    expect(klaviyoEvents).toBeDefined();
    expect(klaviyoEventRunObservations).toBeDefined();
    expect(klaviyoEventProducts).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `bun run test -- src/lib/klaviyo/schema-contract.test.ts`

Expected: FAIL with `Failed to resolve import "@/schema/klaviyo"`.

- [ ] **Step 3: Define the Drizzle tables and database constraints**

Create `src/schema/klaviyo.ts` with these columns and constraints:

```ts
import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { shopifyStores } from "./shopify";
import type {
  JsonValue,
  KlaviyoEventAliasField,
  KlaviyoEventCheckpoint,
  KlaviyoMetricKind,
  PropertyFingerprintEntry,
  RedactedProbeExample,
} from "@/lib/klaviyo/types";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const klaviyoConnections = pgTable(
  "klaviyo_connection",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    storeId: text("shopify_store_id").notNull(),
    klaviyoAccountId: text("klaviyo_account_id"),
    accountName: text("account_name"),
    timezone: text("timezone"),
    currency: text("currency"),
    status: text("status").notNull().default("pending"),
    authenticationMode: text("authentication_mode")
      .notNull()
      .default("environment"),
    credentialReference: text("credential_reference")
      .notNull()
      .default("reviv_environment"),
    lastDiscoverySyncedAt: timestamp("last_discovery_synced_at"),
    lastEventSyncedAt: timestamp("last_event_synced_at"),
    initialSourceFrom: timestamp("initial_source_from"),
    initialSourceTo: timestamp("initial_source_to"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("klaviyo_connection_org_store_uniq").on(
      table.organizationId,
      table.storeId,
    ),
    unique("klaviyo_connection_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    uniqueIndex("klaviyo_connection_active_account_uidx")
      .on(table.klaviyoAccountId)
      .where(
        sql`${table.klaviyoAccountId} is not null and ${table.status} <> 'disabled'`,
      ),
    foreignKey({
      name: "klaviyo_connection_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    check(
      "klaviyo_connection_status_check",
      sql`${table.status} in ('pending', 'ready', 'degraded', 'disabled')`,
    ),
    check(
      "klaviyo_connection_auth_mode_check",
      sql`${table.authenticationMode} = 'environment'`,
    ),
    check(
      "klaviyo_connection_credential_ref_check",
      sql`${table.credentialReference} = 'reviv_environment'`,
    ),
    check(
      "klaviyo_connection_initial_source_window_check",
      sql`(${table.initialSourceFrom} is null and ${table.initialSourceTo} is null)
        or (${table.initialSourceFrom} is not null and ${table.initialSourceTo} is not null
          and ${table.initialSourceFrom} < ${table.initialSourceTo})`,
    ),
  ],
);

export const klaviyoMetrics = pgTable(
  "klaviyo_metric",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    externalMetricId: text("external_metric_id").notNull(),
    name: text("name").notNull(),
    integrationName: text("integration_name"),
    integrationCategory: text("integration_category"),
    canonicalKind: text("canonical_kind").$type<KlaviyoMetricKind>(),
    ingestionEnabled: integer("ingestion_enabled").notNull().default(0),
    apiRevision: text("api_revision").notNull(),
    discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_metric_connection_external_uniq").on(
      table.connectionId,
      table.externalMetricId,
    ),
    unique("klaviyo_metric_connection_id_uniq").on(
      table.connectionId,
      table.id,
    ),
    uniqueIndex("klaviyo_metric_enabled_kind_uidx")
      .on(table.connectionId, table.canonicalKind)
      .where(
        sql`${table.canonicalKind} is not null and ${table.ingestionEnabled} = 1`,
      ),
    foreignKey({
      name: "klaviyo_metric_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    index("klaviyo_metric_scope_kind_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.canonicalKind,
    ),
  ],
);

export const klaviyoSyncRuns = pgTable(
  "klaviyo_sync_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    operation: text("operation").notNull(),
    triggerType: text("trigger_type").notNull(),
    requestParameters: jsonb("request_parameters")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default({}),
    requestedFrom: timestamp("requested_from"),
    requestedTo: timestamp("requested_to"),
    checkpoint: jsonb("checkpoint").$type<KlaviyoEventCheckpoint | null>(),
    apiRevision: text("api_revision"),
    status: text("status").notNull().default("running"),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsInserted: integer("rows_inserted").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    rowsIgnored: integer("rows_ignored").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_sync_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_sync_run_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    uniqueIndex("klaviyo_sync_run_one_running_discovery_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'discovery' and ${table.status} = 'running'`),
    uniqueIndex("klaviyo_sync_run_one_running_probe_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'probe' and ${table.status} = 'running'`),
    uniqueIndex("klaviyo_sync_run_one_running_events_uidx")
      .on(table.connectionId)
      .where(sql`${table.operation} = 'events' and ${table.status} = 'running'`),
    check(
      "klaviyo_sync_run_operation_check",
      sql`${table.operation} in ('discovery', 'probe', 'dimensions', 'events', 'reports')`,
    ),
    check(
      "klaviyo_sync_run_status_check",
      sql`${table.status} in ('running', 'success', 'partial', 'failed')`,
    ),
    index("klaviyo_sync_run_scope_started_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.startedAt,
    ),
  ],
);

export const klaviyoProbeReports = pgTable(
  "klaviyo_probe_report",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    syncRunId: text("sync_run_id")
      .notNull(),
    sampledFrom: timestamp("sampled_from").notNull(),
    sampledTo: timestamp("sampled_to").notNull(),
    sampledShopifyOrders: integer("sampled_shopify_orders").notNull(),
    sampledKlaviyoEvents: integer("sampled_klaviyo_events").notNull(),
    bindingOverlapCount: integer("binding_overlap_count").notNull(),
    keyTypeShapes: jsonb("key_type_shapes")
      .$type<PropertyFingerprintEntry[]>()
      .notNull(),
    identifierCoverage: jsonb("identifier_coverage")
      .$type<Record<string, number>>()
      .notNull(),
    collisionSummary: jsonb("collision_summary")
      .$type<Record<string, number>>()
      .notNull(),
    unmatchedSummary: jsonb("unmatched_summary")
      .$type<Record<string, number>>()
      .notNull(),
    unmatchedExamples: jsonb("unmatched_examples")
      .$type<RedactedProbeExample[]>()
      .notNull(),
    productCoverage: jsonb("product_coverage")
      .$type<Record<string, number>>()
      .notNull(),
    attributionCoverage: jsonb("attribution_coverage")
      .$type<Record<string, number>>()
      .notNull(),
    redactionVerified: integer("redaction_verified").notNull().default(0),
    status: text("status").notNull().default("pending"),
    reviewerId: text("reviewer_id"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at"),
    checksum: text("checksum").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "klaviyo_probe_report_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    unique("klaviyo_probe_report_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.id,
    ),
    foreignKey({
      name: "klaviyo_probe_report_run_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.syncRunId,
      ],
      foreignColumns: [
        klaviyoSyncRuns.organizationId,
        klaviyoSyncRuns.storeId,
        klaviyoSyncRuns.connectionId,
        klaviyoSyncRuns.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_probe_report_status_check",
      sql`${table.status} in ('pending', 'passed', 'failed')`,
    ),
    check(
      "klaviyo_probe_report_sample_size_check",
      sql`${table.sampledShopifyOrders} between 20 and 50`,
    ),
    check(
      "klaviyo_probe_report_overlap_check",
      sql`${table.bindingOverlapCount} >= 0`,
    ),
  ],
);

export const klaviyoEventAliases = pgTable(
  "klaviyo_event_alias",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    metricId: text("metric_id").notNull(),
    probeReportId: text("probe_report_id").notNull(),
    canonicalField: text("canonical_field")
      .$type<KlaviyoEventAliasField>()
      .notNull(),
    sourceProperty: text("source_property").notNull(),
    state: text("state").notNull().default("candidate"),
    observedPopulated: integer("observed_populated").notNull(),
    observedMalformed: integer("observed_malformed").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_alias_report_metric_field_uniq").on(
      table.probeReportId,
      table.metricId,
      table.canonicalField,
    ),
    unique("klaviyo_event_alias_report_metric_source_uniq").on(
      table.probeReportId,
      table.metricId,
      table.sourceProperty,
    ),
    uniqueIndex("klaviyo_event_alias_approved_metric_field_uniq")
      .on(table.connectionId, table.metricId, table.canonicalField)
      .where(sql`${table.state} = 'approved'`),
    uniqueIndex("klaviyo_event_alias_approved_metric_source_uniq")
      .on(table.connectionId, table.metricId, table.sourceProperty)
      .where(sql`${table.state} = 'approved'`),
    foreignKey({
      name: "klaviyo_event_alias_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_alias_metric_fk",
      columns: [table.connectionId, table.metricId],
      foreignColumns: [klaviyoMetrics.connectionId, klaviyoMetrics.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_alias_report_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.probeReportId,
      ],
      foreignColumns: [
        klaviyoProbeReports.organizationId,
        klaviyoProbeReports.storeId,
        klaviyoProbeReports.connectionId,
        klaviyoProbeReports.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_alias_field_check",
      sql`${table.canonicalField} in ('orderId', 'uniqueEventId', 'productId',
        'variantId', 'sku', 'productName', 'variantName', 'quantity', 'value',
        'currency', 'items')`,
    ),
    check(
      "klaviyo_event_alias_state_check",
      sql`${table.state} in ('candidate', 'approved', 'rejected', 'disabled')`,
    ),
    check(
      "klaviyo_event_alias_counts_check",
      sql`${table.observedPopulated} > 0 and ${table.observedMalformed} >= 0`,
    ),
  ],
);

export const klaviyoJoinRules = pgTable(
  "klaviyo_join_rule",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    probeReportId: text("probe_report_id")
      .notNull(),
    eventKind: text("event_kind").notNull(),
    sourceProperty: text("source_property").notNull(),
    targetNamespace: text("target_namespace").notNull(),
    canonicalizer: text("canonicalizer").notNull(),
    state: text("state").notNull().default("candidate"),
    observedPopulated: integer("observed_populated").notNull(),
    observedCollisions: integer("observed_collisions").notNull(),
    approverId: text("approver_id"),
    reviewNote: text("review_note"),
    approvedAt: timestamp("approved_at"),
    matcherVersion: text("matcher_version"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_join_rule_report_source_uniq").on(
      table.probeReportId,
      table.eventKind,
      table.sourceProperty,
      table.targetNamespace,
    ),
    uniqueIndex("klaviyo_join_rule_approved_source_uidx")
      .on(
        table.connectionId,
        table.eventKind,
        table.sourceProperty,
        table.targetNamespace,
      )
      .where(sql`${table.state} = 'approved'`),
    foreignKey({
      name: "klaviyo_join_rule_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_join_rule_report_scope_fk",
      columns: [
        table.organizationId,
        table.storeId,
        table.connectionId,
        table.probeReportId,
      ],
      foreignColumns: [
        klaviyoProbeReports.organizationId,
        klaviyoProbeReports.storeId,
        klaviyoProbeReports.connectionId,
        klaviyoProbeReports.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_join_rule_state_check",
      sql`${table.state} in ('candidate', 'approved', 'rejected', 'disabled')`,
    ),
    check(
      "klaviyo_join_rule_canonicalizer_check",
      sql`${table.canonicalizer} in ('shopify_order_gid', 'trimmed_exact')`,
    ),
  ],
);

export const klaviyoEvents = pgTable(
  "klaviyo_event",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    metricId: text("metric_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventUuid: text("event_uuid"),
    occurredAt: timestamp("occurred_at").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    profileId: text("profile_id"),
    explicitOrderIdCandidate: text("explicit_order_id_candidate"),
    providerUniqueIdCandidate: text("provider_unique_id_candidate"),
    providerValue: numeric("provider_value"),
    providerCurrency: text("provider_currency"),
    attributionRelationshipIds: jsonb("attribution_relationship_ids")
      .$type<string[]>()
      .notNull(),
    redactedProperties: jsonb("redacted_properties")
      .$type<Record<string, JsonValue>>()
      .notNull(),
    keyTypeFingerprint: jsonb("key_type_fingerprint")
      .$type<PropertyFingerprintEntry[]>()
      .notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull(),
    productEvidenceCompleteness: text("product_evidence_completeness")
      .notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    apiRevision: text("api_revision").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_connection_external_uniq").on(
      table.connectionId,
      table.externalEventId,
    ),
    unique("klaviyo_event_connection_id_uniq").on(
      table.connectionId,
      table.id,
    ),
    foreignKey({
      name: "klaviyo_event_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_product_completeness_check",
      sql`${table.productEvidenceCompleteness} in ('complete', 'incomplete', 'unavailable')`,
    ),
    foreignKey({
      name: "klaviyo_event_metric_fk",
      columns: [table.connectionId, table.metricId],
      foreignColumns: [klaviyoMetrics.connectionId, klaviyoMetrics.id],
    }).onDelete("cascade"),
    index("klaviyo_event_scope_metric_time_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.metricId,
      table.occurredAt,
    ),
    index("klaviyo_event_scope_profile_time_idx").on(
      table.organizationId,
      table.storeId,
      table.connectionId,
      table.profileId,
      table.occurredAt,
    ),
  ],
);

export const klaviyoEventProducts = pgTable(
  "klaviyo_event_product",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    eventId: text("event_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    productId: text("product_id"),
    variantId: text("variant_id"),
    sku: text("sku"),
    productName: text("product_name"),
    variantName: text("variant_name"),
    quantity: integer("quantity"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("klaviyo_event_product_ordinal_uniq").on(
      table.eventId,
      table.sourceOrdinal,
    ),
    foreignKey({
      name: "klaviyo_event_product_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        klaviyoConnections.organizationId,
        klaviyoConnections.storeId,
        klaviyoConnections.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "klaviyo_event_product_event_fk",
      columns: [table.connectionId, table.eventId],
      foreignColumns: [klaviyoEvents.connectionId, klaviyoEvents.id],
    }).onDelete("cascade"),
    check(
      "klaviyo_event_product_quantity_check",
      sql`${table.quantity} is null or ${table.quantity} > 0`,
    ),
    index("klaviyo_event_product_variant_idx").on(
      table.organizationId,
      table.storeId,
      table.variantId,
    ),
    index("klaviyo_event_product_product_idx").on(
      table.organizationId,
      table.storeId,
      table.productId,
    ),
    index("klaviyo_event_product_sku_idx").on(
      table.organizationId,
      table.storeId,
      table.sku,
    ),
  ],
);

export const klaviyoConnectionRelations = relations(
  klaviyoConnections,
  ({ many }) => ({
    metrics: many(klaviyoMetrics),
    eventAliases: many(klaviyoEventAliases),
    syncRuns: many(klaviyoSyncRuns),
    probeReports: many(klaviyoProbeReports),
    joinRules: many(klaviyoJoinRules),
    events: many(klaviyoEvents),
  }),
);

export const klaviyoEventRelations = relations(
  klaviyoEvents,
  ({ many }) => ({ products: many(klaviyoEventProducts) }),
);
```

Also define `klaviyo_event_run_observation` in this same source schema. It stores full organization/store/connection scope, `sync_run_id`, internal `event_id`, immutable `observed_source_checksum`, and `observed_at`; uniqueness is `(connection_id, sync_run_id, event_id)`. Composite foreign keys target the scoped sync-run and event unique keys and cascade from either parent. Service checks accept only an `events` run and require the observed checksum to equal the event version committed in that same transaction. Index `(connection_id, sync_run_id, event_id)` for exact-run reads. This is membership/lineage only: it contains no provider ID, property, profile, identity digest, product, value, or match conclusion.

- [ ] **Step 4: Run the schema test**

Run: `bun run test -- src/lib/klaviyo/schema-contract.test.ts`

Expected: PASS with 1 test.

- [ ] **Step 5: Generate migration 0054**

Run: `bun run db:generate --name klaviyo_source_core`

Expected: Drizzle creates `drizzle/0054_klaviyo_source_core.sql`, `drizzle/meta/0054_snapshot.json`, and appends index 54 to `drizzle/meta/_journal.json`. If the generated index is not `0054`, stop: Plan 1 migration metadata is missing or another migration was generated out of order.

- [ ] **Step 6: Inspect and apply the migration**

Run: `rg -n "CREATE TABLE|FOREIGN KEY|CREATE UNIQUE INDEX|CHECK" drizzle/0054_klaviyo_source_core.sql`

Expected: output names all nine Plan 2 tables, including `klaviyo_event_alias` and `klaviyo_event_run_observation`; the sync-run heartbeat; the connection initial-source-window check; the composite connection/run/report/alias/observation foreign keys; active-account plus one-running-discovery, one-running-probe, and one-running-event partial unique indexes; provider-ID uniqueness; exact-run event membership uniqueness; report-scoped alias and join-rule history uniqueness; approved-only alias and join-rule partial unique indexes; probe sample/overlap checks; event product-completeness check; status checks; and positive product quantity check.

Run: `bun run db:migrate`

Expected: exit code 0 with migration `0054_klaviyo_source_core` applied. Do not run `db:push`.

- [ ] **Step 7: Commit the schema and generated artifacts**

```bash
git add src/schema/klaviyo.ts src/lib/klaviyo/schema-contract.test.ts drizzle/0054_klaviyo_source_core.sql drizzle/meta/0054_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(klaviyo): add source core schema"
```

### Task 5: Implement connection-scoped persistence

**Files:**
- Create: `src/lib/klaviyo/source-store.ts`
- Test: `src/lib/klaviyo/source-store.test.ts`
- Test: `src/lib/klaviyo/source-store.integration.test.ts`

- [ ] **Step 1: Write failing unit tests for scope and checkpoint behavior**

```ts
// src/lib/klaviyo/source-store.test.ts
import { describe, expect, it } from "vitest";
import {
  safeSyncError,
  sameCheckpoint,
} from "@/lib/klaviyo/source-store";
import { orderCoreSourceContract } from "@/lib/klaviyo/types";

describe("Klaviyo source store helpers", () => {
  it("compares opaque checkpoints exactly", () => {
    expect(
      sameCheckpoint(
        { ...orderCoreSourceContract(), metricIndex: 0, cursor: "abc", page: 2 },
        { ...orderCoreSourceContract(), metricIndex: 0, cursor: "abc", page: 2 },
      ),
    ).toBe(true);
    expect(
      sameCheckpoint(
        { ...orderCoreSourceContract(), metricIndex: 0, cursor: "abc", page: 2 },
        { ...orderCoreSourceContract(), metricIndex: 1, cursor: null, page: 0 },
      ),
    ).toBe(false);
  });

  it("removes URLs, email addresses, and long provider content from errors", () => {
    expect(
      safeSyncError(
        "GET https://a.klaviyo.com/api/events?email=user@example.com failed with private payload",
      ),
    ).toEqual({
      code: "KLAVIYO_SYNC_FAILED",
      message: "Klaviyo sync failed; inspect the provider status and configured scopes",
    });
  });
});
```

In the same file, dependency-inject `ensurePilotConnection` and prove that an invalid/missing identity keyring or missing private key causes no insert, that the configured shop domain is resolved only inside the supplied organization, and that two calls return the same pending connection with `klaviyoAccountId: null`. No bootstrap test may mock or call Accounts; remote account verification belongs to discovery.

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/source-store.test.ts`

Expected: FAIL with `Failed to resolve import "@/lib/klaviyo/source-store"`.

- [ ] **Step 3: Implement the repository entry points**

Create `src/lib/klaviyo/source-store.ts` with these exports and rules:

```ts
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { parseIdentityHmacKeyring } from "@/lib/identity-hmac";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  klaviyoConnections,
  klaviyoEventAliases,
  klaviyoEventProducts,
  klaviyoEvents,
  klaviyoJoinRules,
  klaviyoMetrics,
  klaviyoProbeReports,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";
import { shopifyStores } from "@/schema/shopify";
import {
  KLAVIYO_ORDER_CORE_KINDS,
  assertExactOrderCoreRequestParameters,
  assertOrderCoreSourceContract,
} from "@/lib/klaviyo/types";
import type {
  HalfOpenWindow,
  EnabledOrderCoreMetric,
  JsonValue,
  KlaviyoConnectionScope,
  KlaviyoEventCheckpoint,
  KlaviyoMetricKind,
  OrderCoreSourceContract,
  NormalizedKlaviyoEvent,
  PropertyFingerprintEntry,
  RedactedProbeExample,
} from "@/lib/klaviyo/types";

export function sameCheckpoint(
  left: KlaviyoEventCheckpoint | null,
  right: KlaviyoEventCheckpoint | null,
) {
  if (left === null || right === null) return left === right;
  return (
    left.sourceMode === right.sourceMode &&
    left.metricKinds[0] === right.metricKinds[0] &&
    left.metricKinds[1] === right.metricKinds[1] &&
    left.metricIndex === right.metricIndex &&
    left.cursor === right.cursor &&
    left.page === right.page
  );
}

export function safeSyncError(_error: unknown) {
  return {
    code: "KLAVIYO_SYNC_FAILED",
    message: "Klaviyo sync failed; inspect the provider status and configured scopes",
  };
}

export type ConnectionRecord = KlaviyoConnectionScope & {
  shopDomain: string;
  storeTimezone: string;
  klaviyoAccountId: string | null;
  initialSourceFrom: Date | null;
  initialSourceTo: Date | null;
  credentialReference: "reviv_environment";
  status: "pending" | "ready" | "degraded" | "disabled";
};

export async function ensurePilotConnection(
  organizationId: string,
  dependencies: {
    credentialProvider: KlaviyoCredentialProvider;
    loadIdentityKeyring: typeof parseIdentityHmacKeyring;
  } = {
    credentialProvider: new EnvironmentKlaviyoCredentialProvider(),
    loadIdentityKeyring: parseIdentityHmacKeyring,
  },
): Promise<ConnectionRecord> {
  dependencies.loadIdentityKeyring();
  const binding = await dependencies.credentialProvider.getPilotBinding();
  return db.transaction(async (tx) => {
    const [store] = await tx
      .select({
        organizationId: shopifyStores.organizationId,
        storeId: shopifyStores.id,
        shopDomain: shopifyStores.shopDomain,
        storeTimezone: shopifyStores.ianaTimezone,
      })
      .from(shopifyStores)
      .where(
        and(
          eq(shopifyStores.organizationId, organizationId),
          eq(shopifyStores.shopDomain, binding.shopDomain),
        ),
      )
      .for("update");
    if (!store) {
      throw new Error("Configured Reviv Shopify store was not found in this organization");
    }

    await tx
      .insert(klaviyoConnections)
      .values({
        organizationId,
        storeId: store.storeId,
        status: "pending",
        authenticationMode: "environment",
        credentialReference: "reviv_environment",
      })
      .onConflictDoNothing({
        target: [klaviyoConnections.organizationId, klaviyoConnections.storeId],
      });

    const [connection] = await tx
      .select({
        organizationId: klaviyoConnections.organizationId,
        storeId: klaviyoConnections.storeId,
        connectionId: klaviyoConnections.id,
        shopDomain: shopifyStores.shopDomain,
        storeTimezone: shopifyStores.ianaTimezone,
        klaviyoAccountId: klaviyoConnections.klaviyoAccountId,
        initialSourceFrom: klaviyoConnections.initialSourceFrom,
        initialSourceTo: klaviyoConnections.initialSourceTo,
        credentialReference: klaviyoConnections.credentialReference,
        status: klaviyoConnections.status,
      })
      .from(klaviyoConnections)
      .innerJoin(shopifyStores, eq(shopifyStores.id, klaviyoConnections.storeId))
      .where(
        and(
          eq(klaviyoConnections.organizationId, organizationId),
          eq(klaviyoConnections.storeId, store.storeId),
        ),
      )
      .limit(1);
    if (!connection) throw new Error("Klaviyo connection bootstrap conflicted");
    if (
      connection.klaviyoAccountId !== null &&
      connection.klaviyoAccountId !== binding.expectedAccountId
    ) {
      throw new Error("Stored Klaviyo account does not match the Reviv binding");
    }
    return connection as ConnectionRecord;
  });
}

export async function getConnectionRecord(
  scope: KlaviyoConnectionScope,
): Promise<ConnectionRecord | null> {
  const [row] = await db
    .select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
      shopDomain: shopifyStores.shopDomain,
      storeTimezone: shopifyStores.ianaTimezone,
      klaviyoAccountId: klaviyoConnections.klaviyoAccountId,
      initialSourceFrom: klaviyoConnections.initialSourceFrom,
      initialSourceTo: klaviyoConnections.initialSourceTo,
      credentialReference: klaviyoConnections.credentialReference,
      status: klaviyoConnections.status,
    })
    .from(klaviyoConnections)
    .innerJoin(shopifyStores, eq(shopifyStores.id, klaviyoConnections.storeId))
    .where(
      and(
        eq(klaviyoConnections.organizationId, scope.organizationId),
        eq(klaviyoConnections.storeId, scope.storeId),
        eq(klaviyoConnections.id, scope.connectionId),
      ),
    )
    .limit(1);
  return (row as ConnectionRecord | undefined) ?? null;
}

export async function resolveTaskConnection(
  connectionId: string,
): Promise<ConnectionRecord> {
  const [scope] = await db
    .select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
    })
    .from(klaviyoConnections)
    .where(eq(klaviyoConnections.id, connectionId))
    .limit(1);
  if (!scope) throw new Error("Klaviyo connection not found");
  const connection = await getConnectionRecord(scope);
  if (!connection) throw new Error("Klaviyo connection scope is invalid");
  return connection;
}

export async function resolveTaskSyncRun(
  syncRunId: string,
): Promise<{ scope: KlaviyoConnectionScope; operation: string }> {
  const [run] = await db
    .select({
      organizationId: klaviyoSyncRuns.organizationId,
      storeId: klaviyoSyncRuns.storeId,
      connectionId: klaviyoSyncRuns.connectionId,
      operation: klaviyoSyncRuns.operation,
    })
    .from(klaviyoSyncRuns)
    .where(eq(klaviyoSyncRuns.id, syncRunId))
    .limit(1);
  if (!run) throw new Error("Klaviyo sync run not found");
  return {
    scope: {
      organizationId: run.organizationId,
      storeId: run.storeId,
      connectionId: run.connectionId,
    },
    operation: run.operation,
  };
}

export async function getPilotConnectionForOrganization(
  organizationId: string,
  credentialProvider: KlaviyoCredentialProvider =
    new EnvironmentKlaviyoCredentialProvider(),
): Promise<ConnectionRecord | null> {
  const binding = await credentialProvider.getPilotBinding();
  const [scope] = await db
    .select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
    })
    .from(klaviyoConnections)
    .innerJoin(shopifyStores, eq(shopifyStores.id, klaviyoConnections.storeId))
    .where(
      and(
        eq(klaviyoConnections.organizationId, organizationId),
        eq(shopifyStores.shopDomain, binding.shopDomain),
      ),
    )
    .limit(1);
  return scope ? getConnectionRecord(scope) : null;
}

export async function loadEnabledOrderCoreMetrics(
  scope: KlaviyoConnectionScope,
): Promise<[EnabledOrderCoreMetric, EnabledOrderCoreMetric]>;

export async function startKlaviyoSyncRun(input: {
  scope: KlaviyoConnectionScope;
  operation: "discovery" | "probe" | "events";
  triggerType: string;
  window?: HalfOpenWindow;
  checkpoint?: KlaviyoEventCheckpoint | null;
  apiRevision?: string | null;
  requestParameters?: Record<string, JsonValue>;
}) {
  const [run] = await db
    .insert(klaviyoSyncRuns)
    .values({
      organizationId: input.scope.organizationId,
      storeId: input.scope.storeId,
      connectionId: input.scope.connectionId,
      operation: input.operation,
      triggerType: input.triggerType,
      requestParameters: input.requestParameters ?? {},
      requestedFrom: input.window?.from ?? null,
      requestedTo: input.window?.to ?? null,
      checkpoint: input.checkpoint ?? null,
      apiRevision: input.apiRevision ?? null,
      status: "running",
    })
    .returning({ id: klaviyoSyncRuns.id });
  return run;
}

export async function commitKlaviyoDiscovery(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  expectedAccountId: string;
  account: {
    id: string;
    name: string | null;
    timezone: string | null;
    currency: string | null;
  };
  metrics: Array<{
    externalMetricId: string;
    name: string;
    integrationName: string | null;
    integrationCategory: string | null;
    canonicalKind: KlaviyoMetricKind | null;
    ingestionEnabled: boolean;
    apiRevision: string;
  }>;
}) {
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select({
        accountId: klaviyoConnections.klaviyoAccountId,
        status: klaviyoConnections.status,
      })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!connection) throw new Error("Klaviyo connection not found in this scope");
    if (
      input.account.id !== input.expectedAccountId ||
      (connection.accountId !== null && connection.accountId !== input.account.id)
    ) {
      throw new Error("Discovered Klaviyo account does not match the Reviv binding");
    }

    const [run] = await tx
      .select({ id: klaviyoSyncRuns.id })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.operation, "discovery"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo discovery run is not active in this scope");

    const enabledOrderMetrics = await tx
      .select({
        externalMetricId: klaviyoMetrics.externalMetricId,
        canonicalKind: klaviyoMetrics.canonicalKind,
      })
      .from(klaviyoMetrics)
      .where(
        and(
          eq(klaviyoMetrics.organizationId, input.scope.organizationId),
          eq(klaviyoMetrics.storeId, input.scope.storeId),
          eq(klaviyoMetrics.connectionId, input.scope.connectionId),
          eq(klaviyoMetrics.ingestionEnabled, 1),
          inArray(klaviyoMetrics.canonicalKind, [...KLAVIYO_ORDER_CORE_KINDS]),
        ),
      );
    const previousBindings = new Map(
      enabledOrderMetrics.map((metric) => [
        metric.canonicalKind,
        metric.externalMetricId,
      ] as const),
    );
    const nextBindings = new Map(
      input.metrics
        .filter(
          (metric) =>
            metric.ingestionEnabled &&
            metric.canonicalKind !== null &&
            KLAVIYO_ORDER_CORE_KINDS.includes(metric.canonicalKind as never),
        )
        .map(
          (metric) =>
            [metric.canonicalKind, metric.externalMetricId] as const,
        ),
    );
    if (nextBindings.size !== KLAVIYO_ORDER_CORE_KINDS.length) {
      throw new Error("Discovery did not provide the complete native order metric binding");
    }
    const nativeOrderBindingsChanged =
      previousBindings.size > 0 &&
      KLAVIYO_ORDER_CORE_KINDS.some(
        (kind) => previousBindings.get(kind) !== nextBindings.get(kind),
      );
    const discoveredAt = new Date();

    // Clear the prior enabled set before upserting the newly discovered set.
    // This keeps the enabled-kind partial unique index usable when Klaviyo
    // replaces an external metric ID.
    await tx
      .update(klaviyoMetrics)
      .set({ ingestionEnabled: 0, updatedAt: discoveredAt })
      .where(
        and(
          eq(klaviyoMetrics.organizationId, input.scope.organizationId),
          eq(klaviyoMetrics.storeId, input.scope.storeId),
          eq(klaviyoMetrics.connectionId, input.scope.connectionId),
          eq(klaviyoMetrics.ingestionEnabled, 1),
        ),
      );

    if (nativeOrderBindingsChanged) {
      await tx
        .update(klaviyoEventAliases)
        .set({ state: "disabled", updatedAt: discoveredAt })
        .where(
          and(
            eq(klaviyoEventAliases.organizationId, input.scope.organizationId),
            eq(klaviyoEventAliases.storeId, input.scope.storeId),
            eq(klaviyoEventAliases.connectionId, input.scope.connectionId),
            eq(klaviyoEventAliases.state, "approved"),
          ),
        );
      await tx
        .update(klaviyoJoinRules)
        .set({ state: "disabled", updatedAt: discoveredAt })
        .where(
          and(
            eq(klaviyoJoinRules.organizationId, input.scope.organizationId),
            eq(klaviyoJoinRules.storeId, input.scope.storeId),
            eq(klaviyoJoinRules.connectionId, input.scope.connectionId),
            eq(klaviyoJoinRules.state, "approved"),
          ),
        );
      await tx
        .update(klaviyoSyncRuns)
        .set({
          status: "failed",
          errorCode: "KLAVIYO_METRIC_BINDING_CHANGED",
          errorMessage:
            "Klaviyo native order metric binding changed; approve a new probe before source ingestion",
          failureCount: sql`${klaviyoSyncRuns.failureCount} + 1`,
          finishedAt: discoveredAt,
        })
        .where(
          and(
            eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
            eq(klaviyoSyncRuns.storeId, input.scope.storeId),
            eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
            eq(klaviyoSyncRuns.operation, "events"),
            eq(klaviyoSyncRuns.status, "running"),
          ),
        );
    }

    await tx
      .update(klaviyoConnections)
      .set({
        klaviyoAccountId: input.account.id,
        accountName: input.account.name,
        timezone: input.account.timezone,
        currency: input.account.currency,
        status: nativeOrderBindingsChanged ? "pending" : connection.status,
        lastDiscoverySyncedAt: discoveredAt,
        updatedAt: discoveredAt,
      })
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      );

    for (const metric of input.metrics) {
      await tx
        .insert(klaviyoMetrics)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          ...metric,
          ingestionEnabled: metric.ingestionEnabled ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [klaviyoMetrics.connectionId, klaviyoMetrics.externalMetricId],
          set: {
            name: metric.name,
            integrationName: metric.integrationName,
            integrationCategory: metric.integrationCategory,
            canonicalKind: metric.canonicalKind,
            ingestionEnabled: metric.ingestionEnabled ? 1 : 0,
            apiRevision: metric.apiRevision,
            updatedAt: discoveredAt,
          },
        });
    }

    const finishedDiscovery = await tx
      .update(klaviyoSyncRuns)
      .set({ status: "success", finishedAt: discoveredAt })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "discovery"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (finishedDiscovery.length !== 1) {
      throw new Error("Klaviyo discovery run is not active in this scope");
    }
  });
}

export async function commitKlaviyoEventPage(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  sourceContract: OrderCoreSourceContract;
  expectedCheckpoint: KlaviyoEventCheckpoint;
  nextCheckpoint: KlaviyoEventCheckpoint | null;
  events: NormalizedKlaviyoEvent[];
  rowsRead: number;
}) {
  return db.transaction(async (tx) => {
    assertExactOrderCoreRequestParameters(input.sourceContract);
    assertOrderCoreSourceContract(input.expectedCheckpoint);
    if (input.nextCheckpoint) {
      assertOrderCoreSourceContract(input.nextCheckpoint);
    }
    const expectedContract = {
      sourceMode: input.expectedCheckpoint.sourceMode,
      metricKinds: input.expectedCheckpoint.metricKinds,
    };
    if (
      JSON.stringify(expectedContract) !== JSON.stringify(input.sourceContract) ||
      (input.nextCheckpoint &&
        JSON.stringify({
          sourceMode: input.nextCheckpoint.sourceMode,
          metricKinds: input.nextCheckpoint.metricKinds,
        }) !== JSON.stringify(input.sourceContract))
    ) {
      throw new Error("Klaviyo event checkpoint source contract changed");
    }
    const [connection] = await tx
      .select({ id: klaviyoConnections.id })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.id, input.scope.connectionId),
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
        ),
      )
      .for("update");
    if (!connection) {
      throw new Error("Klaviyo connection is not active in this scope");
    }
    const [run] = await tx
      .select({
        checkpoint: klaviyoSyncRuns.checkpoint,
        requestParameters: klaviyoSyncRuns.requestParameters,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");

    if (!run) throw new Error("Klaviyo sync run is not active in this scope");
    assertExactOrderCoreRequestParameters(run.requestParameters);
    if (!sameCheckpoint(run.checkpoint, input.expectedCheckpoint)) {
      return { committed: false as const, inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;
    for (const event of input.events) {
      const [existing] = await tx
        .select({ id: klaviyoEvents.id, checksum: klaviyoEvents.sourceChecksum })
        .from(klaviyoEvents)
        .where(
          and(
            eq(klaviyoEvents.connectionId, input.scope.connectionId),
            eq(klaviyoEvents.externalEventId, event.externalEventId),
          ),
        )
        .limit(1);

      const [stored] = await tx
        .insert(klaviyoEvents)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          metricId: event.metricId,
          externalEventId: event.externalEventId,
          eventUuid: event.eventUuid,
          occurredAt: event.occurredAt,
          profileId: event.profileId,
          explicitOrderIdCandidate: event.explicitOrderIdCandidate,
          providerUniqueIdCandidate: event.providerUniqueIdCandidate,
          providerValue: event.providerValue,
          providerCurrency: event.providerCurrency,
          attributionRelationshipIds: event.attributionRelationshipIds,
          redactedProperties: event.evidence.values,
          keyTypeFingerprint: event.evidence.fingerprint,
          warnings: event.evidence.warnings,
          productEvidenceCompleteness: event.productEvidenceCompleteness,
          sourceChecksum: event.sourceChecksum,
          apiRevision: event.apiRevision,
        })
        .onConflictDoUpdate({
          target: [klaviyoEvents.connectionId, klaviyoEvents.externalEventId],
          set: {
            metricId: event.metricId,
            eventUuid: event.eventUuid,
            occurredAt: event.occurredAt,
            profileId: event.profileId,
            explicitOrderIdCandidate: event.explicitOrderIdCandidate,
            providerUniqueIdCandidate: event.providerUniqueIdCandidate,
            providerValue: event.providerValue,
            providerCurrency: event.providerCurrency,
            attributionRelationshipIds: event.attributionRelationshipIds,
            redactedProperties: event.evidence.values,
            keyTypeFingerprint: event.evidence.fingerprint,
            warnings: event.evidence.warnings,
            productEvidenceCompleteness: event.productEvidenceCompleteness,
            sourceChecksum: event.sourceChecksum,
            apiRevision: event.apiRevision,
            fetchedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning({ id: klaviyoEvents.id });

      if (event.productEvidenceCompleteness === "complete") {
        await tx
          .delete(klaviyoEventProducts)
          .where(
            and(
              eq(klaviyoEventProducts.connectionId, input.scope.connectionId),
              eq(klaviyoEventProducts.eventId, stored.id),
            ),
          );
        if (event.products.length > 0) {
          await tx.insert(klaviyoEventProducts).values(
            event.products.map((product) => ({
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              eventId: stored.id,
              ...product,
            })),
          );
        }
      }

      const insertedObservation = await tx
        .insert(klaviyoEventRunObservations)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          syncRunId: input.syncRunId,
          eventId: stored.id,
          observedSourceChecksum: event.sourceChecksum,
        })
        .onConflictDoNothing({
          target: [
            klaviyoEventRunObservations.connectionId,
            klaviyoEventRunObservations.syncRunId,
            klaviyoEventRunObservations.eventId,
          ],
        })
        .returning({ checksum: klaviyoEventRunObservations.observedSourceChecksum });
      if (insertedObservation.length === 0) {
        const [replayedObservation] = await tx
          .select({ checksum: klaviyoEventRunObservations.observedSourceChecksum })
          .from(klaviyoEventRunObservations)
          .where(
            and(
              eq(klaviyoEventRunObservations.connectionId, input.scope.connectionId),
              eq(klaviyoEventRunObservations.syncRunId, input.syncRunId),
              eq(klaviyoEventRunObservations.eventId, stored.id),
            ),
          );
        if (replayedObservation?.checksum !== event.sourceChecksum) {
          throw new Error("Klaviyo run observation changed during replay");
        }
      }

      if (!existing) inserted += 1;
      else if (existing.checksum !== event.sourceChecksum) updated += 1;
    }

    await tx
      .update(klaviyoSyncRuns)
      .set({
        checkpoint: input.nextCheckpoint,
        heartbeatAt: new Date(),
        rowsRead: sql`${klaviyoSyncRuns.rowsRead} + ${input.rowsRead}`,
        rowsInserted: sql`${klaviyoSyncRuns.rowsInserted} + ${inserted}`,
        rowsUpdated: sql`${klaviyoSyncRuns.rowsUpdated} + ${updated}`,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      );

    return { committed: true as const, inserted, updated };
  });
}

export async function finishKlaviyoSyncRun(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  operation: "discovery" | "probe" | "events";
  status: "success" | "partial" | "failed";
  error?: unknown;
}) {
  const safeError = input.error ? safeSyncError(input.error) : null;
  const finishedAt = new Date();
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: klaviyoConnections.id })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!connection) {
      throw new Error("Klaviyo sync run connection is not active in this scope");
    }

    const finished = await tx
      .update(klaviyoSyncRuns)
      .set({
        status: input.status,
        errorCode: safeError?.code ?? null,
        errorMessage: safeError?.message ?? null,
        failureCount: input.error ? 1 : 0,
        finishedAt,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (finished.length !== 1) {
      throw new Error("Klaviyo sync run is not active for this scoped operation");
    }

    if (input.operation === "events" && input.status === "success") {
      const refreshed = await tx
        .update(klaviyoConnections)
        .set({
          lastEventSyncedAt: finishedAt,
          updatedAt: finishedAt,
        })
        .where(
          and(
            eq(klaviyoConnections.organizationId, input.scope.organizationId),
            eq(klaviyoConnections.storeId, input.scope.storeId),
            eq(klaviyoConnections.id, input.scope.connectionId),
          ),
        )
        .returning({ id: klaviyoConnections.id });
      if (refreshed.length !== 1) {
        throw new Error("Klaviyo sync run connection is not active in this scope");
      }
    }
  });
}

export async function failKlaviyoSyncRunAfterRetryExhaustion(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  operation: "discovery" | "probe" | "dimensions" | "events" | "reports";
}): Promise<{ changed: boolean }> {
  const finishedAt = new Date();
  return db.transaction(async (tx) => {
    // Keep the same connection-then-run lock order as every other terminal path.
    const [connection] = await tx
      .select({ id: klaviyoConnections.id })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!connection) {
      throw new Error("Klaviyo sync run connection is outside this scope");
    }

    const [current] = await tx
      .select({
        id: klaviyoSyncRuns.id,
        status: klaviyoSyncRuns.status,
        checkpoint: klaviyoSyncRuns.checkpoint,
        rowsRead: klaviyoSyncRuns.rowsRead,
        rowsInserted: klaviyoSyncRuns.rowsInserted,
        rowsUpdated: klaviyoSyncRuns.rowsUpdated,
        failureCount: klaviyoSyncRuns.failureCount,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
        ),
      )
      .for("update");
    if (!current) throw new Error("Klaviyo sync run is outside this scoped operation");
    if (current.status !== "running") return { changed: false };

    // Preserve the locked checkpoint, committed source rows, and row counts.
    const failed = await tx
      .update(klaviyoSyncRuns)
      .set({
        status: "failed",
        errorCode: "KLAVIYO_RETRIES_EXHAUSTED",
        errorMessage: "Klaviyo task retries were exhausted",
        failureCount: current.failureCount + 1,
        finishedAt,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, current.id),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (failed.length !== 1) {
      throw new Error("Klaviyo retry-exhaustion finalization raced");
    }
    return { changed: true };
  });
}

export type ProbePersistence = {
  bindingOverlapCount: number;
  keyTypeShapes: PropertyFingerprintEntry[];
  identifierCoverage: Record<string, number>;
  collisionSummary: Record<string, number>;
  unmatchedSummary: Record<string, number>;
  unmatchedExamples: RedactedProbeExample[];
  productCoverage: Record<string, number>;
  attributionCoverage: Record<string, number>;
  redactionVerified: boolean;
};

export type KlaviyoHealth = {
  configured: boolean;
  store: {
    id: string;
    shopDomain: string;
    ianaTimezone: string;
    currency: string | null;
    todayInStoreTz: string;
  } | null;
  connection: {
    status: "pending" | "ready" | "degraded" | "disabled";
    accountName: string | null;
    timezone: string | null;
    currency: string | null;
    todayInAccountTz: string | null;
    lastDiscoverySyncedAt: Date | null;
    lastEventSyncedAt: Date | null;
  } | null;
};

export async function getKlaviyoHealthForOrganization(
  organizationId: string,
  now: Date = new Date(),
): Promise<KlaviyoHealth>;

export { klaviyoJoinRules, klaviyoProbeReports };
```

`commitKlaviyoEventPage` first locks the scoped `klaviyo_connection` row and then the exact running sync-run row before validating the checkpoint or changing any event, product, digest, observation, count, or heartbeat. This short connection-first lock is shared by every later identity-bearing event commit and Plan 3 match publication; no Klaviyo request runs inside it. Add a concurrency test proving match publication holding the same connection lock cannot interleave a source-page mutation between checksum validation and publication.

Implement `loadEnabledOrderCoreMetrics` with organization, store, and connection predicates on both `klaviyo_metric` and `klaviyo_event_alias`. Return exactly two entries in `KLAVIYO_ORDER_CORE_KINDS` order. Each entry must contain both the internal `metricRowId` (`klaviyo_metric.id`) and provider `externalMetricId`; build `approvedAliases` only from alias rows whose state is `approved`. Reject missing/duplicate kinds, duplicate canonical fields, an alias from another metric/scope, or an alias field outside `KLAVIYO_EVENT_ALIAS_FIELDS`. The Events API receives `externalMetricId`. `normalizeEventPage` receives that provider ID only to validate each raw metric relationship and receives `metricRowId` as the value assigned to normalized events; only `metricRowId` reaches the `klaviyo_event.metric_id` foreign key.

`finishKlaviyoSyncRun` is the sole generic terminal mutation. Every caller
supplies the expected operation. It must change exactly one scoped `running`
row; wrong scope, wrong operation, and a second finish all throw. A successful
`events` finish updates `klaviyo_connection.last_event_synced_at` in the same
transaction and with the same timestamp. Partial/failed event finishes and all
discovery/probe finishes leave event freshness unchanged.

`failKlaviyoSyncRunAfterRetryExhaustion` is the one specialized idempotent exception for Trigger.dev's terminal failure hook. It accepts only `discovery`, `probe`, `dimensions`, `events`, or `reports`, preserves the locked checkpoint/data/counts and prior freshness, writes only the fixed safe code/message above, releases the operation's running uniqueness guard by transitioning to `failed`, and returns `{ changed: false }` without rewriting any terminal run. It never accepts provider error text. Plan 4 reuses this exact finalizer for journey-mode event runs plus dimension/report wrappers.

Also export `KLAVIYO_RUN_STALE_AFTER_MS = 20 * 60 * 1000`, `renewKlaviyoSyncRunHeartbeat({ scope, syncRunId, operation, now }, executor?)`, and `failExpiredKlaviyoSyncRun({ scope, syncRunId, operation, now }, executor?)`. Renew locks the exact scoped running operation and changes only `heartbeatAt`; discovery remote-page boundaries and event page commits renew it, with event renewal occurring in the checkpoint transaction. The expired finalizer uses the same connection-then-run lock order, changes only a `running` row whose heartbeat is at least 20 minutes old, preserves checkpoint/source rows/counts/freshness, and writes fixed `KLAVIYO_LEASE_EXPIRED` text once. Both accept an injected transaction executor so discovery/probe/event preparation can reap and replace an expired same-operation run under its existing connection lock. Every bounded Trigger task has `maxDuration: 600`, leaving a full ten-minute safety margin before lease expiry.

Implement `getKlaviyoHealthForOrganization` as a safe read: it catches missing/invalid pilot environment binding and returns `configured: false` rather than throwing, returns the scoped Shopify store display context even before a connection row exists, never returns the expected account ID/credential reference/connection ID, and computes both `todayInStoreTz` and (when discovered) `todayInAccountTz` server-side with `deriveDayInTimezone`. If an organization has multiple stores and no valid configured-domain match, return `store: null` rather than guessing.

Also export `listKlaviyoSyncRuns({ scope, limit, cursor })` and `listKlaviyoProbeReview({ scope })` from this repository. Both accept full `KlaviyoConnectionScope`, include all three scope columns in every query, expose only sanitized sync errors and persisted redacted probe/rule fields, and return an opaque stable pagination cursor rather than accepting organization/store/connection input from the browser. `listKlaviyoSyncRuns` must never return the stored checkpoint/request-parameters JSON. It projects only `checkpointSummary: null | { sourceMode: "order_core" | "journey" | null; metricIndex: number | null; page: number | null }` after validating the closed contract; provider cursor strings are omitted entirely (not truncated or copied), and non-event operations use null source/metric fields plus a safe page only when their typed checkpoint defines one. Add a hostile fixture containing an email-like opaque provider cursor and assert neither it nor a hash/key fragment appears in serialized API output or logs.

- [ ] **Step 4: Add database-backed tests using the repository's disposable-Postgres pattern**

In `src/lib/klaviyo/source-store.integration.test.ts`, create database `adsolute_klaviyo_source_test`, create minimal `organization` and `shopify_store` prerequisites, execute `drizzle/0054_klaviyo_source_core.sql` statement-by-statement, and assert:

```ts
it("rejects a connection whose organization and store do not match", async () => {
  await expect(
    testPool!.query(
      `insert into klaviyo_connection
       (id, organization_id, shopify_store_id, klaviyo_account_id)
       values ('bad', 'org-b', 'store-a', 'account-bad')`,
    ),
  ).rejects.toThrow();
});

it("rejects one active account bound to two stores", async () => {
  await testPool!.query(
    `insert into klaviyo_connection
     (id, organization_id, shopify_store_id, klaviyo_account_id)
     values ('connection-a', 'org-a', 'store-a', 'account-one')`,
  );
  await expect(
    testPool!.query(
      `insert into klaviyo_connection
       (id, organization_id, shopify_store_id, klaviyo_account_id)
       values ('connection-b', 'org-b', 'store-b', 'account-one')`,
    ),
  ).rejects.toThrow();
});

it("cascades source rows when the connection is deleted", async () => {
  await testPool!.query(`delete from klaviyo_connection where id = 'connection-a'`);
  const result = await testPool!.query(
    `select count(*)::int as count from klaviyo_event where connection_id = 'connection-a'`,
  );
  expect(result.rows[0].count).toBe(0);
});

it("rejects a probe report whose sync run belongs to another connection", async () => {
  await expect(
    testPool!.query(
      `insert into klaviyo_probe_report
       (id, organization_id, shopify_store_id, connection_id, sync_run_id,
        sampled_from, sampled_to, sampled_shopify_orders,
        sampled_klaviyo_events, binding_overlap_count, key_type_shapes,
        identifier_coverage, collision_summary, unmatched_summary,
        unmatched_examples, product_coverage, attribution_coverage,
        redaction_verified, status, checksum)
       values
       ('probe-cross', 'org-a', 'store-a', 'connection-a', 'run-b',
        now() - interval '1 day', now(), 20, 20, 1, '[]', '{}', '{}', '{}',
        '[]', '{}', '{}', 1, 'pending', 'checksum-cross')`,
    ),
  ).rejects.toThrow();
});

it("rejects a join rule whose probe report belongs to another connection", async () => {
  await expect(
    testPool!.query(
      `insert into klaviyo_join_rule
       (id, organization_id, shopify_store_id, connection_id,
        probe_report_id, event_kind, source_property, target_namespace,
        canonicalizer, state, observed_populated, observed_collisions)
       values
       ('rule-cross', 'org-a', 'store-a', 'connection-a', 'probe-b',
        'placed_order', 'OrderId', 'shopify_order_gid',
        'shopify_order_gid', 'candidate', 20, 0)`,
    ),
  ).rejects.toThrow();
});

it("allows only one running event sync per connection", async () => {
  await testPool!.query(
    `insert into klaviyo_sync_run
     (id, organization_id, shopify_store_id, connection_id, operation,
      trigger_type, status)
     values ('run-a', 'org-a', 'store-a', 'connection-a',
      'events', 'manual_backfill', 'running')`,
  );
  await expect(
    testPool!.query(
      `insert into klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status)
       values ('run-b', 'org-a', 'store-a', 'connection-a',
        'events', 'manual_backfill', 'running')`,
    ),
  ).rejects.toThrow();
});

it("preserves complete product children on an incomplete event replay", async () => {
  await commitCompleteProductPage();
  await commitIncompleteReplayAtNextCheckpoint();
  expect(await readEventProductIds("event-a")).toEqual(["product-a"]);
  expect(await readEventProductCompleteness("event-a")).toBe("incomplete");
});
```

Also insert approved aliases for both metrics and assert `loadEnabledOrderCoreMetrics` returns `{ metricRowId, externalMetricId, metricKind, approvedAliases }` in canonical kind order. Seed deliberately different internal/external IDs and prove they are not swapped. Add rejection cases for a cross-connection alias/report/metric tuple and for a candidate (not approved) alias leaking into the runtime registry. Prove a new report's candidate may coexist with an older approved alias, two approved aliases for the same connection/metric/canonical field cannot coexist, and disabling the old row before promoting the new one preserves both historical rows. Extend the event-page commit test so missing or changed immutable source-mode/metric-kind parameters reject before source rows or checkpoints change. Assert every committed event also gets exactly one scoped observation for that sync run/checksum in the same transaction, identical page replay is a no-op, different-checksum replay for the same run/event throws and rolls back every source/checkpoint change, a rollback leaves neither event nor observation, and another run gets a distinct membership row. Update an event in a later run and prove the earlier observation retains its immutable old checksum while the current event row carries the new one. Race a page commit against Plan 3 publication and prove the scoped connection lock prevents an interleaved validation/write.

Add finish-run cases proving wrong scope, wrong operation, and a second finish
change zero rows and throw. Prove a successful event finish publishes run
success and `last_event_synced_at` atomically with one identical timestamp,
while partial/failed event finishes never advance freshness.

Add retry-exhaustion cases for both a `probe` and an `events` run. Prove the specialized finalizer requires the exact full scope and operation, locks and preserves the committed checkpoint/source rows/counts, increments failure count once, writes only `KLAVIYO_RETRIES_EXHAUSTED` plus its fixed safe message, leaves `last_event_synced_at` unchanged, releases the one-running-events index for a replacement run, and returns `{ changed: false }` without rewriting success/partial/failed rows on replay. Prove entry/page commits renew the heartbeat, an unexpired row cannot be reaped, an expired row becomes fixed-code failed once, and reaping plus replacement inside one connection-locked transaction cannot race the partial unique index.

Implement the four product fixture helpers in this test file using `commitKlaviyoEventPage` plus direct scoped reads. Seed two valid organizations, stores, connections, and scoped sync/probe parents before each rejection assertion. Also assert `ensurePilotConnection` is idempotent, leaves `klaviyo_account_id` null before discovery, and never reuses the configured store from another organization.

Use the `resolveConnectionString`, `withDatabase`, `describeIfDb`, `beforeAll`, and `afterAll` structure from `src/lib/trpc/routers/manager.test.ts`. Split the migration on `--> statement-breakpoint`; execute every non-empty statement with `testPool.query(statement)`.

- [ ] **Step 5: Run unit and database tests**

Run: `bun run test -- src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts`

Expected with `DATABASE_URL`: PASS for helper and constraint/cascade tests. Expected without `DATABASE_URL`: helper tests PASS and the integration suite reports SKIP with exit code 0. Before considering Plan 2 complete, rerun with the disposable PostgreSQL database available and obtain PASS.

- [ ] **Step 6: Commit persistence**

```bash
git add src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.test.ts src/lib/klaviyo/source-store.integration.test.ts
git commit -m "feat(klaviyo): add scoped source persistence"
```

### Task 6: Redact and normalize source events

**Files:**
- Create: `src/lib/klaviyo/redaction.ts`
- Test: `src/lib/klaviyo/redaction.test.ts`
- Create: `src/lib/klaviyo/event-normalizer.ts`
- Test: `src/lib/klaviyo/event-normalizer.test.ts`

- [ ] **Step 1: Write failing privacy tests**

```ts
// src/lib/klaviyo/redaction.test.ts
import { describe, expect, it } from "vitest";
import { redactEventProperties } from "@/lib/klaviyo/redaction";

describe("redactEventProperties", () => {
  it("retains approved values and hashes every unknown key", () => {
    const result = redactEventProperties(
      {
        ProductID: "product-1",
        email_address_for_debug: "user@example.com",
        ordinaryLookingUnknownKey: "secret-value",
      },
      new Set(["ProductID"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values).toEqual({ ProductID: "product-1" });
    expect(result.fingerprint).toEqual(
      expect.arrayContaining([
        { key: "ProductID", keyKind: "approved", type: "string" },
        expect.objectContaining({ keyKind: "sha256", type: "string" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("email_address_for_debug");
    expect(JSON.stringify(result)).not.toContain("user@example.com");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("keeps only an allowlisted HTTPS host and redacted path", () => {
    const result = redactEventProperties(
      {
        URL: "https://reviv.example.com/account/user@example.com?token=secret#fragment",
      },
      new Set(["URL"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values.URL).toBe("https://reviv.example.com/account/[redacted]");
  });

  it("redacts repeated sensitive path segments without stateful regex skips", () => {
    const result = redactEventProperties(
      {
        URL: "https://reviv.example.com/user@example.com/other@example.com",
        PagePath: "/orders/abcdefghijklmnopqrstuvwxyz0123456789?token=secret#x",
      },
      new Set(["URL", "PagePath"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values.URL).toBe(
      "https://reviv.example.com/[redacted]/[redacted]",
    );
    expect(result.values.PagePath).toBe("/orders/[redacted]");
    expect(JSON.stringify(result.values)).not.toContain("token");
  });

  it("redacts IDs after identity path labels but keeps benign product paths", () => {
    const result = redactEventProperties(
      {
        ProfileUrl: "https://reviv.example.com/profiles/12345",
        CustomerUrl: "https://reviv.example.com/customer/abc123",
        ProductUrl: "https://reviv.example.com/products/summer-dress",
      },
      new Set(["ProfileUrl", "CustomerUrl", "ProductUrl"]),
      new Set(["reviv.example.com"]),
    );
    expect(result.values.ProfileUrl).toBe(
      "https://reviv.example.com/profiles/[redacted]",
    );
    expect(result.values.CustomerUrl).toBe(
      "https://reviv.example.com/customer/[redacted]",
    );
    expect(result.values.ProductUrl).toBe(
      "https://reviv.example.com/products/summer-dress",
    );
    expect(JSON.stringify(result.values)).not.toContain("12345");
    expect(JSON.stringify(result.values)).not.toContain("abc123");
  });
});
```

```ts
// src/lib/klaviyo/event-normalizer.test.ts
import { describe, expect, it } from "vitest";
import { normalizeEventPage } from "@/lib/klaviyo/event-normalizer";

describe("normalizeEventPage", () => {
  it("normalizes a Placed Order without retaining included email", () => {
    const [event] = normalizeEventPage({
      metricRowId: "metric-row-1",
      externalMetricId: "metric-external-1",
      metricKind: "placed_order",
      apiRevision: "2026-07-15",
      merchantHosts: new Set(["reviv.example.com"]),
      approvedAliases: {
        orderId: "OrderId",
        uniqueEventId: "$event_id",
        productId: "ProductID",
        variantId: "VariantID",
        sku: "SKU",
        productName: null,
        variantName: null,
        quantity: "Quantity",
        value: null,
        currency: null,
        items: null,
      },
      page: {
        data: [
          {
            type: "event",
            id: "event-1",
            attributes: {
              datetime: "2026-07-20T10:00:00.000Z",
              uuid: "uuid-1",
              event_properties: {
                OrderId: "gid://shopify/Order/1001",
                $event_id: "provider-1",
                ProductID: "product-1",
                VariantID: "variant-1",
                SKU: "SKU-1",
                Quantity: 2,
              },
            },
            relationships: {
              profile: { data: { type: "profile", id: "profile-1" } },
              metric: { data: { type: "metric", id: "metric-external-1" } },
            },
          },
        ],
        included: [
          {
            type: "profile",
            id: "profile-1",
            attributes: { email: "person@example.com" },
          },
        ],
        nextCursor: null,
        apiRevision: "2026-07-15",
      },
    });

    expect(event).toMatchObject({
      externalEventId: "event-1",
      metricId: "metric-row-1",
      profileId: "profile-1",
      explicitOrderIdCandidate: "gid://shopify/Order/1001",
      providerUniqueIdCandidate: "provider-1",
      productEvidenceCompleteness: "complete",
      products: [
        expect.objectContaining({
          productId: "product-1",
          variantId: "variant-1",
          sku: "SKU-1",
          quantity: 2,
        }),
      ],
    });
    expect(JSON.stringify(event)).not.toContain("person@example.com");
  });
});
```

Add a second normalizer case whose event relationship contains a different
provider metric ID. It must throw before returning any normalized event:

```ts
it("rejects an event whose provider metric relationship differs");
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/redaction.test.ts src/lib/klaviyo/event-normalizer.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement bounded redaction**

In `src/lib/klaviyo/redaction.ts`, implement these exported limits and entry point:

```ts
import { createHash } from "node:crypto";
import type {
  JsonType,
  JsonValue,
  RedactedEventEvidence,
} from "@/lib/klaviyo/types";

export const REDACTED_PROPERTY_MAX_KEYS = 64;
export const REDACTED_PROPERTY_MAX_DEPTH = 3;
export const REDACTED_PROPERTY_MAX_BYTES = 16 * 1024;
export const FINGERPRINT_MAX_KEYS = 128;

const EMAIL_REPLACE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_DETECT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REPLACE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const PHONE_DETECT = /(?:\+?\d[\d\s().-]{7,}\d)/;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;
const IDENTITY_PATH_LABELS = new Set([
  "profile",
  "profiles",
  "customer",
  "customers",
  "person",
  "persons",
  "people",
  "user",
  "users",
  "identity",
  "identities",
]);

function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function boundedText(value: unknown) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(EMAIL_REPLACE, "[redacted]")
    .replace(PHONE_REPLACE, "[redacted]");
  return cleaned.slice(0, 512);
}

function safePathname(pathname: string) {
  let redactNextIdentitySegment = false;
  return pathname
    .split("/")
    .map((encodedSegment) => {
      let segment: string;
      try {
        segment = decodeURIComponent(encodedSegment);
      } catch {
        redactNextIdentitySegment = false;
        return "[redacted]";
      }
      if (redactNextIdentitySegment && segment.length > 0) {
        redactNextIdentitySegment = false;
        return "[redacted]";
      }
      if (IDENTITY_PATH_LABELS.has(segment.trim().toLowerCase())) {
        redactNextIdentitySegment = true;
        return segment.slice(0, 96);
      }
      return EMAIL_DETECT.test(segment) ||
        PHONE_DETECT.test(segment) ||
        OPAQUE_SEGMENT.test(segment)
        ? "[redacted]"
        : segment.slice(0, 96);
    })
    .join("/");
}

function safeUrl(value: unknown, merchantHosts: ReadonlySet<string>) {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    !merchantHosts.has(url.hostname.toLowerCase())
  ) {
    return null;
  }
  const path = safePathname(url.pathname);
  return `${url.origin}${path}`;
}

function safeRelativePath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const url = new URL(value, "https://redaction.invalid");
  return safePathname(url.pathname);
}

function approvedValue(
  key: string,
  value: unknown,
  merchantHosts: ReadonlySet<string>,
): JsonValue | undefined {
  if (/url|link|referrer/i.test(key)) {
    return safeUrl(value, merchantHosts) ?? undefined;
  }
  if (/path|page/i.test(key) || (typeof value === "string" && value.startsWith("/"))) {
    return safeRelativePath(value) ?? safeUrl(value, merchantHosts) ?? undefined;
  }
  if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return safeUrl(value, merchantHosts) ?? undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return boundedText(value) ?? undefined;
}

export function redactEventProperties(
  properties: Record<string, unknown>,
  approvedKeys: ReadonlySet<string>,
  merchantHosts: ReadonlySet<string>,
): RedactedEventEvidence {
  const values: Record<string, JsonValue> = {};
  const fingerprint: RedactedEventEvidence["fingerprint"] = [];
  const warnings: string[] = [];
  let truncated = false;

  for (const [index, key] of Object.keys(properties).sort().entries()) {
    if (index >= FINGERPRINT_MAX_KEYS) {
      truncated = true;
      break;
    }
    const approved = approvedKeys.has(key);
    fingerprint.push({
      key: approved ? key : hashKey(key),
      keyKind: approved ? "approved" : "sha256",
      type: jsonType(properties[key]),
    });
    if (!approved || Object.keys(values).length >= REDACTED_PROPERTY_MAX_KEYS) continue;
    const normalized = approvedValue(key, properties[key], merchantHosts);
    if (normalized !== undefined) values[key] = normalized;
  }

  while (Buffer.byteLength(JSON.stringify(values), "utf8") > REDACTED_PROPERTY_MAX_BYTES) {
    const lastKey = Object.keys(values).at(-1);
    if (!lastKey) break;
    delete values[lastKey];
    truncated = true;
  }
  if (truncated) warnings.push("redacted_evidence_truncated");
  return { values, fingerprint, warnings, truncated };
}
```

Identity-context path labels are not themselves sensitive, but their next
non-empty segment is always treated as a provider/customer identity ID and
replaced, regardless of length or character shape. This rule applies to both
absolute allowlisted URLs and relative paths. Product/category paths remain
readable unless their segments independently match another redaction rule.
Only this sanitized value may enter `redactedProperties`; no raw path or
fallback identity segment reaches the later inspector.

- [ ] **Step 4: Implement event normalization with an explicit alias registry**

Create `src/lib/klaviyo/event-normalizer.ts`. Re-export `KlaviyoEventAliasRegistry` from `@/lib/klaviyo/types` as `EventAliasRegistry` and export `normalizeEventPage`; do not declare a structurally similar local alias type. Parse only scalar approved aliases, map one product observation for an `Ordered Product` event or each explicitly structured item for a `Placed Order` event, validate positive integer quantity, hash the normalized record with stable sorted JSON, and never copy included profile attributes into the return value. Use `profile` relationship ID only. Retain a stable, de-duplicated list of at most 100 IDs from the event's `attributions` relationship; never retain attribution attributes or arbitrary included resources in this source stage, and add `attribution_relationship_truncated` to warnings if the provider exceeds the bound. Require every source event's `metric` relationship to equal `externalMetricId`; throw before returning a page when it is missing or differs. Set `NormalizedKlaviyoEvent.metricId` only from the internal `metricRowId`; never persist the provider ID in that foreign-key field. Also throw on a missing event ID or invalid/missing timestamp.

Set `productEvidenceCompleteness` to `complete` only when the expected product source was present and every item normalized without truncation or rejection. Set it to `incomplete` when an item collection is present but malformed/truncated, and `unavailable` when the event exposes no approved product source. Keep warnings for every downgrade. `commitKlaviyoEventPage` replaces child rows only for `complete`; incomplete/unavailable replays preserve the previous complete child set.

The function signature must be exactly:

```ts
export type EventAliasRegistry = KlaviyoEventAliasRegistry;

export function normalizeEventPage(input: {
  metricRowId: string;
  externalMetricId: string;
  metricKind: KlaviyoMetricKind;
  apiRevision: string;
  merchantHosts: ReadonlySet<string>;
  approvedAliases: EventAliasRegistry;
  page: KlaviyoCompoundPage;
}): NormalizedKlaviyoEvent[];
```

- [ ] **Step 5: Run privacy and normalizer tests**

Run: `bun run test -- src/lib/klaviyo/redaction.test.ts src/lib/klaviyo/event-normalizer.test.ts`

Expected: PASS; the serialized normalized event contains neither `person@example.com` nor unknown property values.

- [ ] **Step 6: Commit the privacy boundary**

```bash
git add src/lib/klaviyo/redaction.ts src/lib/klaviyo/redaction.test.ts src/lib/klaviyo/event-normalizer.ts src/lib/klaviyo/event-normalizer.test.ts
git commit -m "feat(klaviyo): redact and normalize source events"
```

### Task 7: Implement connection discovery

**Files:**
- Create: `src/lib/klaviyo/discovery.ts`
- Test: `src/lib/klaviyo/discovery.test.ts`
- Modify: `src/lib/klaviyo/source-store.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`

- [ ] **Step 1: Write failing discovery tests**

```ts
// src/lib/klaviyo/discovery.test.ts
import { describe, expect, it } from "vitest";
import {
  classifyMetric,
  requireUniqueNativeOrderMetrics,
} from "@/lib/klaviyo/discovery";

const shopifyMetric = (id: string, name: string) => ({
  id,
  name,
  integrationName: "Shopify",
  integrationCategory: "ecommerce",
});

describe("Klaviyo discovery", () => {
  it("does not accept a same-named custom metric", () => {
    expect(
      classifyMetric({
        id: "custom-1",
        name: "Placed Order",
        integrationName: "API",
        integrationCategory: "custom",
      }),
    ).toBeNull();
  });

  it("requires one Shopify-native metric of each order kind", () => {
    expect(
      requireUniqueNativeOrderMetrics([
        shopifyMetric("placed-1", "Placed Order"),
        shopifyMetric("ordered-1", "Ordered Product"),
      ]),
    ).toEqual({
      placed_order: "placed-1",
      ordered_product: "ordered-1",
    });
  });

  it("fails closed when a native order metric is duplicated", () => {
    expect(() =>
      requireUniqueNativeOrderMetrics([
        shopifyMetric("placed-1", "Placed Order"),
        shopifyMetric("placed-2", "Placed Order"),
        shopifyMetric("ordered-1", "Ordered Product"),
      ]),
    ).toThrow("Expected exactly one Shopify-native Placed Order metric");
  });

  it("verifies Accounts before binding a pending connection", async () => {
    const deps = makeDiscoveryDependencies({
      persistedAccountId: null,
      expectedAccountId: "account-reviv",
      returnedAccountIds: ["account-reviv"],
    });
    await runKlaviyoDiscovery({
      scope: deps.scope,
      syncRunId: deps.syncRunId,
      ...deps.services,
    });
    expect(deps.commitDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAccountId: "account-reviv" }),
    );
  });

  it("writes no account or metric rows when Accounts returns another account", async () => {
    const deps = makeDiscoveryDependencies({
      persistedAccountId: null,
      expectedAccountId: "account-reviv",
      returnedAccountIds: ["account-other"],
    });
    await expect(
      runKlaviyoDiscovery({
        scope: deps.scope,
        syncRunId: deps.syncRunId,
        ...deps.services,
      }),
    ).rejects.toThrow("Discovered Klaviyo account does not match the Reviv binding");
    expect(deps.commitDiscovery).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/discovery.test.ts`

Expected: FAIL because `@/lib/klaviyo/discovery` is missing.

- [ ] **Step 3: Implement discovery classification and orchestration**

In `src/lib/klaviyo/discovery.ts`, define exact-name mappings for all eight allowlisted metric kinds. Return a kind only when the integration name normalizes to `shopify` for `Placed Order` and `Ordered Product`; reject API/custom metrics with the same name. Export:

```ts
export type DiscoveredMetric = {
  id: string;
  name: string;
  integrationName: string | null;
  integrationCategory: string | null;
};

export function classifyMetric(metric: DiscoveredMetric): KlaviyoMetricKind | null;

export function requireUniqueNativeOrderMetrics(
  metrics: DiscoveredMetric[],
): { placed_order: string; ordered_product: string };

export async function runKlaviyoDiscovery(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  credentialProvider?: KlaviyoCredentialProvider;
  clientFactory?: (privateApiKey: string) => KlaviyoApiClient;
}): Promise<{
  scope: KlaviyoConnectionScope;
  accountId: string;
  metricCount: number;
  orderMetricIds: { placed_order: string; ordered_product: string };
}>;
```

`runKlaviyoDiscovery` must perform this order:

1. Parse `parseIdentityHmacKeyring()` before any database write or remote call.
2. Load the connection and Shopify domain using the full supplied scope.
3. Resolve the credential. A pending row may have `klaviyoAccountId: null`; the provider still checks the configured store and returns the environment's expected account ID. A non-null stored account must already equal that expected ID.
4. Resolve the already-prepared exact scoped `discovery` run by `syncRunId`, require it to be `running`, and renew its heartbeat. The runner never creates its own run.
5. Call Accounts and require exactly one account whose ID equals the provider's `expectedAccountId`.
6. Page all Metrics using only opaque cursors, renewing the same run's heartbeat between remote pages.
7. Require one native order metric of each kind.
8. Call `commitKlaviyoDiscovery` once to bind the verified account, reconcile and upsert all allowlisted metrics, and finish the run in one transaction. The active-account unique index makes a concurrent binding to another store fail closed and rolls back the entire discovery commit.
9. Let attempt-level errors escape while the prepared row remains `running`. Task 10's terminal hook writes only its fixed retry-exhaustion code; an expired-lease reconciler covers crash, cancellation, system failure, and a skipped hook. Never persist returned account/metric data from a failed stage or any caught provider error.

Inside the locked discovery commit, load the currently enabled native-order
bindings and compare their provider external IDs with the newly selected exact
`placed_order`/`ordered_product` bindings. Disable every currently enabled
metric in the scoped connection before upserting the newly discovered enabled
set, so a replaced external metric ID cannot collide with
`klaviyo_metric_enabled_kind_uidx` and metrics omitted from the new discovery
cannot remain active. A first discovery has no prior binding and is not treated
as a change. If either previously enabled native-order external ID changes,
atomically set the connection back to `pending` and change all currently
`approved` aliases and join rules in that connection to `disabled`. In the same
transaction, fail any scoped running event run with only the fixed
`KLAVIYO_METRIC_BINDING_CHANGED` code/message; this releases the one-running-run
constraint and makes an in-flight page commit fail its `running` guard. Source
ingestion remains blocked until a new probe is approved. If both native
bindings are unchanged, preserve connection readiness, approved aliases, and
the current event run. Keep old metric, alias, event, and probe rows for
auditability.

The commit sets account metadata and `lastDiscoverySyncedAt`; an initial
connection remains `pending` until probe approval. Add the dependency fixture
used above in `discovery.test.ts`; it must expose `scope`, injected
`syncRunId`, account/metric pages, `commitDiscovery`, and a keyring loader so the test also
proves a missing HMAC secret causes no client construction, commit, or remote
call. Test `prepareKlaviyoDiscoveryRun` separately to prove invalid key or
credential configuration causes no run insert.

Add `prepareKlaviyoDiscoveryRun({ scope, triggerType, now })` beside the probe preparation path. It parses the keyring and credential binding before writing, locks the scoped connection, fixed-code finalizes an expired running discovery row, reuses a live one, or inserts one running discovery row. The Plan 2 partial unique discovery index is the race backstop. Add operation-aware lease tests proving a live discovery cannot be duplicated, an expired row is finalized before replacement, each account/metric page renews the heartbeat, and committed account/metric data survives lease recovery.

Extend `src/lib/klaviyo/source-store.integration.test.ts` with discovery replay
cases. An unchanged native binding must preserve `ready` plus approved aliases.
A changed provider external ID must disable the stale enabled metrics before
upsert, enable exactly the two newly selected rows, set the connection to
`pending`, disable every previously approved alias and join rule, and
terminally fail any running event sync before it can commit another page. Also
prove an allowlisted metric omitted from the latest discovery is no longer
enabled.

- [ ] **Step 4: Run discovery tests**

Run: `bun run test -- src/lib/klaviyo/discovery.test.ts src/lib/klaviyo/source-store.integration.test.ts`

Expected: PASS with classification, pending-binding, mismatch, missing-secret,
unchanged-binding replay, and changed-binding invalidation tests.

- [ ] **Step 5: Commit discovery**

```bash
git add src/lib/klaviyo/discovery.ts src/lib/klaviyo/discovery.test.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.integration.test.ts
git commit -m "feat(klaviyo): discover account and native metrics"
```

### Task 8: Build the durable probe and review workflow

**Files:**
- Create: `src/lib/klaviyo/probe.ts`
- Test: `src/lib/klaviyo/probe.test.ts`
- Create: `src/lib/klaviyo/join-rules.ts`
- Test: `src/lib/klaviyo/join-rules.test.ts`
- Modify: `src/lib/klaviyo/source-store.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`

- [ ] **Step 1: Write failing probe tests**

```ts
// src/lib/klaviyo/probe.test.ts
import { describe, expect, it } from "vitest";
import { summarizeProbe } from "@/lib/klaviyo/probe";

describe("summarizeProbe", () => {
  it("reports coverage and collisions without retaining sampled values", () => {
    const report = summarizeProbe({
      sampledShopifyOrderIds: ["1001", "1002"],
      observations: [
        {
          metricKind: "placed_order",
          occurredAt: new Date("2026-07-20T10:00:00.000Z"),
          sourceProperty: "OrderId",
          sourceType: "string",
          normalizedValue: "1001",
          productComparable: true,
          attributionKinds: ["campaign", "message"],
          fingerprint: [],
          warnings: [],
        },
        {
          metricKind: "placed_order",
          occurredAt: new Date("2026-07-20T11:00:00.000Z"),
          sourceProperty: "OrderId",
          sourceType: "string",
          normalizedValue: "1001",
          productComparable: false,
          attributionKinds: [],
          fingerprint: [],
          warnings: [],
        },
      ],
      redactionVerified: true,
    });

    expect(report.identifierCoverage.OrderId).toBe(2);
    expect(report.collisionSummary.OrderId).toBe(1);
    expect(report.bindingOverlapCount).toBe(2);
    expect(report.productCoverage.comparable).toBe(1);
    expect(report.attributionCoverage.campaign).toBe(1);
    expect(report.attributionCoverage.message).toBe(1);
    expect(JSON.stringify(report)).not.toContain("1001");
  });
});
```

```ts
// src/lib/klaviyo/join-rules.test.ts
import { describe, expect, it } from "vitest";
import { assertRuleCanBeApproved } from "@/lib/klaviyo/join-rules";

describe("assertRuleCanBeApproved", () => {
  it("requires a passed probe and zero collisions", () => {
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "candidate",
        canonicalizer: "shopify_order_gid",
        observedPopulated: 20,
        observedCollisions: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "candidate",
        canonicalizer: "shopify_order_gid",
        observedPopulated: 20,
        observedCollisions: 1,
      }),
    ).toThrow("Join rules with observed collisions cannot be approved");
  });
});
```

- [ ] **Step 2: Run probe/rule tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/probe.test.ts src/lib/klaviyo/join-rules.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement probe aggregation and execution**

In `src/lib/klaviyo/probe.ts`, export:

```ts
export type ProbeObservation = {
  metricKind: "placed_order" | "ordered_product";
  occurredAt: Date;
  sourceProperty: string;
  sourceType: JsonType;
  normalizedValue: string | null;
  productComparable: boolean;
  attributionKinds: Array<
    "campaign" | "flow" | "message" | "variation" | "interaction_type"
  >;
  fingerprint: PropertyFingerprintEntry[];
  warnings: string[];
};

export function summarizeProbe(input: {
  sampledShopifyOrderIds: string[];
  observations: ProbeObservation[];
  redactionVerified: boolean;
}): ProbePersistence;

export async function prepareKlaviyoProbeRun(input: {
  scope: KlaviyoConnectionScope;
  sampleSize: number;
  triggerType: string;
}): Promise<{ syncRunId: string }>;

export async function runKlaviyoProbe(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
}): Promise<{ reportId: string; sampledOrders: number; candidateRules: number }>;
```

`prepareKlaviyoProbeRun` rejects sample sizes outside 20–50, parses the identity keyring and resolves the credential binding before writing, requires a scoped pending connection with a successfully verified account and exactly one enabled native metric for each order kind, then locks the connection, reconciles an expired running probe row, reuses only a still-live row with the identical `{ sampleSize }`, or creates a `probe` sync run whose safe `requestParameters` is exactly `{ sampleSize }`. `runKlaviyoProbe` revalidates the keyring/account/store binding, loads and locks that scoped running probe run, renews its heartbeat before the first remote request, and reads the sample size only from its persisted request parameters. Load exactly that many newest Shopify evidence-complete orders from Plan 1; fewer than 20 calls `finishKlaviyoSyncRun` with `operation: "probe"` and fails the run without a report. Fetch both metrics over the smallest enclosing half-open time window with `includeProfileEmail: true`, and inspect provider values only in memory.

It may call `computeIdentityDigests` for aggregate exact-email coverage, but must discard returned digests after counting and must not include them in `ProbePersistence`. Persist one immutable checksum over stable JSON, a `pending` report, candidate `klaviyo_event_alias` rows for recognized order/product/value/currency/item fields, and candidate join rules only for fields that map deterministically to a recognized Shopify ID namespace. Every alias stores the scoped internal metric row ID, probe report, canonical field, exact observed source property, populated/malformed counts, and `candidate` state; it never stores a sampled value. Candidate aliases and join rules are inserted under the new report-scoped history keys; a fresh probe never updates or overwrites a row from an older report. Reject ambiguous mappings instead of choosing one. `bindingOverlapCount` counts in-memory deterministic or diagnostic overlap with the sampled orders. `unmatchedExamples` stores at most ten entries containing only metric kind, UTC day, redacted key/type fingerprint, and warning codes—never source values, provider/profile IDs, or full timestamps. `attributionCoverage` counts campaign, flow, message, variation, and interaction-type relationships separately; `productCoverage` separates `placed_order` and `ordered_product` coverage. Set `redactionVerified` only after the serialized persistence object passes a denylist test for plaintext email, phones, URLs with queries/fragments, digests, profile IDs, and unknown values. Commit the report, candidate aliases, candidate rules, checkpoint/counts, and successful probe-run status in one transaction; a partial/failed probe preserves prior reports, aliases, and rules.

- [ ] **Step 4: Implement report review and rule approval**

In `src/lib/klaviyo/join-rules.ts`, implement:

```ts
const ALLOWED_CANONICALIZERS = new Set([
  "shopify_order_gid",
  "trimmed_exact",
] as const);

export function assertRuleCanBeApproved(input: {
  probeStatus: string;
  state: string;
  canonicalizer: string;
  observedPopulated: number;
  observedCollisions: number;
}) {
  if (input.probeStatus !== "passed") {
    throw new Error("Join rules require a passed probe report");
  }
  if (input.state !== "candidate") {
    throw new Error("Only candidate join rules can be approved");
  }
  if (!ALLOWED_CANONICALIZERS.has(input.canonicalizer as never)) {
    throw new Error("Join rule canonicalizer is not allowlisted");
  }
  if (input.observedPopulated <= 0) {
    throw new Error("Join rules require populated probe observations");
  }
  if (input.observedCollisions !== 0) {
    throw new Error("Join rules with observed collisions cannot be approved");
  }
}

export function assertProbeCanBeApproved(input: {
  status: string;
  sampledShopifyOrders: number;
  bindingOverlapCount: number;
  redactionVerified: boolean;
  enabledOrderMetricKinds: string[];
}): void;

export async function reviewProbeReport(input: {
  scope: KlaviyoConnectionScope;
  reportId: string;
  reviewerId: string;
  decision: "passed" | "failed";
  reviewNote: string;
}): Promise<void>;

export async function reviewJoinRule(input: {
  scope: KlaviyoConnectionScope;
  ruleId: string;
  reviewerId: string;
  decision: "approved" | "rejected";
  reviewNote: string;
}): Promise<void>;
```

Both mutations use one transaction and include organization, store, and connection scope in every lookup/update. `reviewProbeReport` locks the scoped connection row `FOR UPDATE` first and then locks the report row; every probe review uses that fixed lock order. A pass additionally requires the locked connection to remain `pending`, so two different pending reports cannot both win concurrent approval. `reviewJoinRule` locks the scoped connection first, then the candidate rule, then its passed report, always in that order. `assertProbeCanBeApproved` requires a pending report, 20–50 sampled Shopify orders, positive binding overlap, `redactionVerified`, exactly the enabled `placed_order`/`ordered_product` metric kinds, and an unambiguous candidate-alias set whose malformed count is zero before a reviewer may pass it. Passing a probe atomically disables previously approved aliases for the same connection/metric/canonical field, promotes that report's eligible candidate aliases to `approved`, and sets the connection `ready`; rejecting it marks only that report's aliases `rejected`, records the report `failed`, and does not regress a connection already made ready by another report. Historical disabled rows remain auditable. The approved-only partial unique indexes remain the database backstop even when application locking regresses. Alias approval authorizes parsing only and never confirms a Shopify join. Rule approval remains separate and additionally requires non-empty review text, a populated candidate, the same passed report, and zero collisions. Approval first disables any previously approved rule for the same connection/event-kind/source-property/target-namespace mapping, then promotes the new report-scoped candidate and records `matcherVersion: "klaviyo-v1"` in the same transaction. Rejection changes only the candidate. Rule review does not execute matching.

Extend `src/lib/klaviyo/source-store.integration.test.ts` with two eligible
pending reports for one connection and identical metric/canonical alias fields.
Run both `reviewProbeReport(... decision: "passed")` calls concurrently through
separate database clients. Assert exactly one fulfills, one rejects because the
locked connection is no longer pending, the connection is `ready`, and exactly
one alias is `approved` for each connection/metric/canonical field. Also prove a
direct second approved insert fails at the partial unique index.

Add one end-to-end persistence case for rebinding recovery: begin with a ready
connection plus old enabled native metrics and approved aliases/rules; commit
rediscovery with changed native external IDs; run and pass a fresh probe; then
approve its candidate rule. Assert old aliases/rules remain as `disabled`
history, the fresh report owns distinct candidate rows, exactly one new rule is
approved for the mapping, and runtime metric/alias loading uses only the new
metric rows. A direct second approved rule for that mapping must fail at the
approved-only partial unique index.

- [ ] **Step 5: Run probe and rule tests**

Run: `bun run test -- src/lib/klaviyo/probe.test.ts src/lib/klaviyo/join-rules.test.ts`

Expected: PASS with aggregate privacy and approval-gate assertions.

- [ ] **Step 6: Commit the probe gate**

```bash
git add src/lib/klaviyo/probe.ts src/lib/klaviyo/probe.test.ts src/lib/klaviyo/join-rules.ts src/lib/klaviyo/join-rules.test.ts src/lib/klaviyo/source-store.ts src/lib/klaviyo/source-store.integration.test.ts
git commit -m "feat(klaviyo): add durable probe approval gate"
```

### Task 9: Add resumable order-core ingestion

**Files:**
- Create: `src/lib/klaviyo/source-runner.ts`
- Test: `src/lib/klaviyo/source-runner.test.ts`

- [ ] **Step 1: Write failing checkpoint-transition tests**

```ts
// src/lib/klaviyo/source-runner.test.ts
import { describe, expect, it } from "vitest";
import { nextEventCheckpoint } from "@/lib/klaviyo/source-runner";
import { orderCoreSourceContract } from "@/lib/klaviyo/types";

const SOURCE_CONTRACT = orderCoreSourceContract();

describe("nextEventCheckpoint", () => {
  it("advances a page cursor inside the current metric", () => {
    expect(
      nextEventCheckpoint(
        { ...SOURCE_CONTRACT, metricIndex: 0, cursor: null, page: 0 },
        "cursor-2",
      ),
    ).toEqual({
      ...SOURCE_CONTRACT,
      metricIndex: 0,
      cursor: "cursor-2",
      page: 1,
    });
  });

  it("moves to Ordered Product when Placed Order pagination ends", () => {
    expect(
      nextEventCheckpoint(
        { ...SOURCE_CONTRACT, metricIndex: 0, cursor: "cursor-2", page: 1 },
        null,
      ),
    ).toEqual({
      ...SOURCE_CONTRACT,
      metricIndex: 1,
      cursor: null,
      page: 0,
    });
  });

  it("marks completion after Ordered Product pagination ends", () => {
    expect(
      nextEventCheckpoint(
        { ...SOURCE_CONTRACT, metricIndex: 1, cursor: "cursor-9", page: 4 },
        null,
      ),
    ).toBeNull();
  });

  it("finishes a resumed run whose terminal null checkpoint was committed", async () => {
    const deps = makeRunnerDependencies({ persistedCheckpoint: null });
    await expect(
      processOrderCoreBatch(
        { scope: deps.scope, syncRunId: "run-1", maxPages: 5 },
        deps.services,
      ),
    ).resolves.toMatchObject({ done: true, pagesProcessed: 0 });
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        syncRunId: "run-1",
        operation: "events",
        status: "success",
      }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/lib/klaviyo/source-runner.test.ts`

Expected: FAIL because `@/lib/klaviyo/source-runner` is missing.

- [ ] **Step 3: Implement bounded run orchestration**

In `src/lib/klaviyo/source-runner.ts`, export:

```ts
export function nextEventCheckpoint(
  current: KlaviyoEventCheckpoint,
  nextCursor: string | null,
): KlaviyoEventCheckpoint | null {
  assertOrderCoreSourceContract(current);
  if (nextCursor) {
    return { ...current, cursor: nextCursor, page: current.page + 1 };
  }
  if (current.metricIndex + 1 < KLAVIYO_ORDER_CORE_KINDS.length) {
    return {
      sourceMode: current.sourceMode,
      metricKinds: current.metricKinds,
      metricIndex: current.metricIndex + 1,
      cursor: null,
      page: 0,
    };
  }
  return null;
}

export async function startOrResumeOrderCoreSync(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenWindow;
  triggerType: "manual_backfill" | "scheduled";
}): Promise<{ syncRunId: string; resumed: boolean }>;

export async function processOrderCoreBatch(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  maxPages: number;
}): Promise<{
  done: boolean;
  pagesProcessed: number;
  eventsRead: number;
  checkpoint: KlaviyoEventCheckpoint | null;
}>;
```

`startOrResumeOrderCoreSync` must parse the identity keyring before a write or remote call, require a `ready` scoped connection backed by a passed probe, assert the window, and lock the connection while it finds/creates a run. On the first source run, derive the current Shopify store day from injected `now` plus the scoped store timezone, compute the local-midnight floor 89 calendar days earlier, and reject a window beginning before that floor or ending after the next local midnight. Persist that computed allowed floor/current exclusive bound—not a possibly shorter first request—to `klaviyo_connection.initial_source_from/initial_source_to`. Later replay/incremental runs reject `window.from < initial_source_from` while allowing `to` to move forward only through the current store-day exclusive bound; a short first run can therefore be extended back to the fixed approved floor. Under the connection lock, inspect the one running event row before comparing windows: atomically fail it through `failExpiredKlaviyoSyncRun(..., tx)` if its heartbeat lease expired; return it only when still live and its scope/window/exact source contract are identical; reject a still-live different window/mode. Otherwise persist immutable direct `requestParameters: orderCoreSourceContract()` and create the run at `initialEventCheckpoint()`, whose top-level `sourceMode` and `metricKinds` fields match those request parameters. The schema's partial unique index is the race-safe backstop.

`processOrderCoreBatch` must load the run through the supplied scope; validate its immutable request parameters and the checkpoint's direct `sourceMode`/`metricKinds`; renew the scoped event-run heartbeat before the first remote request; parse the identity keyring before that request; resolve and revalidate the credential/account/store binding; call `loadEnabledOrderCoreMetrics`; and fetch at most `maxPages`. Pass each metric's `externalMetricId` to `listEvents` and to `normalizeEventPage` solely for validating the raw event metric relationship. Pass its internal `metricRowId`, `metricKind`, and persisted `approvedAliases` to normalization; persistence receives only normalized rows whose `metricId` is that internal row ID. Never interchange these IDs or construct aliases in the runner. Plan 2 event ingestion calls `listEvents` with `includeProfileEmail: false` and `includeAttributions: true`; only the probe and Plan 3 identity re-fetch request sparse email. Pass the exact `allowedUrlHosts`, normalize before logs/writes, and call `commitKlaviyoEventPage` with the copied direct source contract. On the last provider page, atomically commit `nextCheckpoint: null`; then call `finishKlaviyoSyncRun` with `operation: "events"` so run success and `lastEventSyncedAt` publish in one transaction. A terminal-null continuation validates the run contract before finishing without a client/refetch. Failed/partial responses do not delete source rows or prior complete product children.

- [ ] **Step 4: Add runner tests with injected client/repository dependencies**

Add tests proving a replayed checkpoint returns `committed: false`, a two-metric run reaches `done: true`, and direct request parameters/checkpoint fields with a missing or changed order-core contract fail before fetch/write. Use deliberately different internal/external metric IDs and assert the API and normalizer relationship check receive the external ID, while the normalized/persisted event foreign key receives only the internal row ID plus approved aliases; a mismatched raw metric relationship fails before persistence, and candidate/cross-scope aliases never reach normalization. Prove `listEvents` requests attribution relationships without profile email, task entry and committed pages renew the heartbeat, a terminal-null resume performs no fetch, a first 90-store-day window succeeds, a 91-day/pre-floor or future window fails before run insert/remote call, the computed floor persists, a short first run can later extend to that fixed floor, same-window replay remains allowed, and an incremental cannot cross the floor. Also cover rejection of a live concurrent different window, atomic reaping/replacement of an expired different-window run, readiness/probe gating, missing HMAC before writes/calls, and redacted logs. Inject dependencies through an optional final argument:

```ts
type SourceRunnerDependencies = {
  createClient: (privateApiKey: string) => KlaviyoApiClient;
  credentialProvider: KlaviyoCredentialProvider;
  now: () => Date;
};
```

- [ ] **Step 5: Run runner and persistence tests**

Run: `bun run test -- src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.test.ts`

Expected: PASS with checkpoint, resume, readiness, and redacted-observability tests.

- [ ] **Step 6: Commit the resumable runner**

```bash
git add src/lib/klaviyo/source-runner.ts src/lib/klaviyo/source-runner.test.ts
git commit -m "feat(klaviyo): add resumable order source ingestion"
```

### Task 10: Add Trigger.dev discovery, probe, and source tasks

**Files:**
- Create: `trigger/klaviyo-source-sync.ts`
- Modify: `trigger/retry.ts`
- Modify: `src/lib/klaviyo/source-runner.test.ts`

- [ ] **Step 1: Export a Klaviyo-specific task retry policy**

Append to `trigger/retry.ts`:

```ts
export const KLAVIYO_TASK_RETRY = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 5000,
  maxTimeoutInMs: 60000,
};
```

- [ ] **Step 2: Add failing task-boundary and retry-exhaustion assertions**

Extend `src/lib/klaviyo/source-runner.test.ts` with a source-boundary read of `trigger/klaviyo-source-sync.ts`. Assert the discovery, probe, and order-core batch tasks all configure `onFailure` and `maxDuration: 600`, route their exact one-ID payload through `failKlaviyoSyncRunAfterRetryExhaustion`, and never pass the Trigger/provider error object into persistence; every task remains exported. Couple this with the Task 3 database cases to prove exhausted discovery/probe/event tasks become terminal `failed`, release their operation-specific running guard, preserve committed account/metric/checkpoint/source rows/freshness, skipped hooks converge through expired-lease reconciliation, and replayed hooks cannot overwrite a terminal run. Task 11's router tests own the separate initial-handoff assertions once those procedures exist.

Run: `bun run test -- src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.integration.test.ts`

Expected: FAIL because the Trigger file and terminal hooks do not exist yet.

- [ ] **Step 3: Add thin Trigger tasks**

Create `trigger/klaviyo-source-sync.ts` with these task IDs, queues, and payloads:

```ts
import { createHash } from "node:crypto";
import { idempotencyKeys, metadata, tags, task, tasks } from "@trigger.dev/sdk";
import { runKlaviyoDiscovery } from "@/lib/klaviyo/discovery";
import { runKlaviyoProbe } from "@/lib/klaviyo/probe";
import {
  processOrderCoreBatch,
} from "@/lib/klaviyo/source-runner";
import {
  failKlaviyoSyncRunAfterRetryExhaustion,
  resolveTaskSyncRun,
} from "@/lib/klaviyo/source-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const KLAVIYO_DISCOVERY_QUEUE = {
  name: "klaviyo-discovery",
  concurrencyLimit: 1,
};
const KLAVIYO_EVENTS_QUEUE = {
  name: "klaviyo-events",
  concurrencyLimit: 1,
};
const MAX_PAGES_PER_BATCH = 5;

type SourceBatchPayload = { syncRunId: string };

function assertExactSourceBatchPayload(
  value: unknown,
): asserts value is SourceBatchPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.syncRunId !== "string" ||
    input.syncRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Klaviyo source task accepts only a sync run ID");
  }
}

async function finalizeExhaustedSourceRun(
  value: unknown,
  expectedOperation: "discovery" | "probe" | "events",
) {
  assertExactSourceBatchPayload(value);
  const run = await resolveTaskSyncRun(value.syncRunId);
  if (run.operation !== expectedOperation) {
    throw new Error("Klaviyo failure payload references the wrong operation");
  }
  return failKlaviyoSyncRunAfterRetryExhaustion({
    scope: run.scope,
    syncRunId: value.syncRunId,
    operation: expectedOperation,
  });
}

function orgTag(organizationId: string) {
  return `klaviyo:org:${organizationId}`;
}

function checkpointFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export const klaviyoDiscoveryTask = task({
  id: "klaviyo-discovery",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_DISCOVERY_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedSourceRun(payload, "discovery");
  },
  run: async (payload: SourceBatchPayload) => {
    assertExactSourceBatchPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "discovery") {
      throw new Error("Klaviyo discovery payload does not reference a discovery run");
    }
    await tags.add(orgTag(run.scope.organizationId));
    metadata.set("status", "discovering");
    const result = await runKlaviyoDiscovery({
      scope: run.scope,
      syncRunId: payload.syncRunId,
    });
    metadata.set("status", "completed");
    return result;
  },
});

export const klaviyoProbeTask = task({
  id: "klaviyo-probe",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_DISCOVERY_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedSourceRun(payload, "probe");
  },
  run: async (payload: SourceBatchPayload) => {
    assertExactSourceBatchPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "probe") {
      throw new Error("Klaviyo probe payload does not reference a probe run");
    }
    await tags.add(orgTag(run.scope.organizationId));
    metadata.set("status", "probing");
    const result = await runKlaviyoProbe({
      scope: run.scope,
      syncRunId: payload.syncRunId,
    });
    metadata.set("status", "awaiting_review");
    return result;
  },
});

export const klaviyoOrderCoreBatchTask = task({
  id: "klaviyo-order-core-batch",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_EVENTS_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedSourceRun(payload, "events");
  },
  run: async (payload: SourceBatchPayload) => {
    assertExactSourceBatchPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "events") {
      throw new Error("Klaviyo batch payload does not reference an event run");
    }
    await tags.add(orgTag(run.scope.organizationId));
    const result = await processOrderCoreBatch({
      scope: run.scope,
      syncRunId: payload.syncRunId,
      maxPages: MAX_PAGES_PER_BATCH,
    });
    metadata.set("pagesProcessed", result.pagesProcessed);
    metadata.set("eventsRead", result.eventsRead);
    if (!result.done) {
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo-order-core:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof klaviyoOrderCoreBatchTask>(
        "klaviyo-order-core-batch",
        { syncRunId: payload.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return result;
  },
});
```

Attempt-level errors still rethrow while the row remains `running`; Trigger.dev calls `onFailure` only after `KLAVIYO_TASK_RETRY` is exhausted. The fixed finalizer code—not `error.message`—is the only stored failure detail. Discovery uses the same prepared-row, one-ID payload, hook, heartbeat lease, and expired-run reconciliation contract as probe; no service catches a provider error into persistence.

The continuation key hashes the validated persisted next checkpoint, so provider cursors never appear in task keys or logs. Its explicit `{ scope: "global" }` plus seven-day TTL deduplicates a replay of one committed page boundary even when a replacement parent/supervisor resumes it; a genuinely later checkpoint produces a different key. Add a source-boundary assertion for the exact key inputs, global scope, and TTL.

`startDiscovery`, `runProbe`, and `startOrderCoreSync` in the tRPC router first prepare/get their scoped running row, then create a stable initial-handoff idempotency key from the operation plus `syncRunId` using explicit global scope and trigger the one-ID child with an explicit seven-day TTL. `startOrderCoreSync` validates/converts the requested store-day range and calls `startOrResumeOrderCoreSync` with derived scope before that handoff. If the trigger call definitively or ambiguously throws, call the idempotent fixed-code retry-exhaustion finalizer for that exact discovery/probe/event row before returning a safe error; an ambiguously delivered child then observes a terminal row and performs no source write. A crash between row creation and the handoff is bounded by the heartbeat lease: the next operation start or Plan 4 supervisor reaps it only after expiry. Repeating the browser call for a live identical run reuses the same initial child key. Log only derived safe scope IDs, run ID, mode, and resumed flag.

Per Trigger.dev's lifecycle contract, task `onFailure` is best-effort for ordinary exhausted retries; it does not cover every crashed/system-failure/canceled/max-duration status, and hook errors do not alter the task result. Therefore every discovery/probe/event start reconciles an expired same-operation run before insert/resume, and Plan 4's supervisor does the same after a bounded poll. Tests simulate a skipped hook for each operation and prove lease expiry releases its running guard without deleting committed account/metric/checkpoint/source rows. Do not add the daily schedule yet. Plan 2 acceptance requires a successful manual backfill and verified freshness behavior before scheduling is enabled.

- [ ] **Step 4: Type-check and test the Trigger task graph**

Run: `bun run build`

Expected: Next.js type-check completes with exit code 0 and recognizes all three exported Trigger tasks; every task payload contains exactly one internal ID.

Run: `bun run test -- src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.integration.test.ts`

Expected with PostgreSQL: PASS, including exhausted discovery/probe/event retries, skipped-hook lease reconciliation, and terminal replay.

- [ ] **Step 5: Commit Trigger orchestration**

```bash
git add trigger/klaviyo-source-sync.ts trigger/retry.ts src/lib/klaviyo/source-runner.test.ts src/lib/klaviyo/source-store.integration.test.ts
git commit -m "feat(klaviyo): add source sync tasks"
```

### Task 11: Expose the stable owner/admin source API

**Files:**
- Create: `src/lib/trpc/routers/klaviyo.ts`
- Test: `src/lib/trpc/routers/klaviyo.test.ts`
- Modify: `src/lib/trpc/routers/_app.ts`

- [ ] **Step 1: Write failing stable-contract, RBAC, and date tests**

In `src/lib/trpc/routers/klaviyo.test.ts`, mock the source services and Trigger SDK, then cover these exact public procedures:

```ts
// Reads
health;
syncRuns;
probe;

// Actions
startDiscovery;
runProbe;
approveProbe;
rejectProbe;
approveJoinRule;
rejectJoinRule;
startOrderCoreSync;
```

Assert member, API-key, and worker callers are forbidden for every procedure. Assert owner/admin calls contain no browser-supplied `organizationId`, `storeId`, or `connectionId`. Add these behavior cases:

```ts
it("returns safe store health before a connection exists");
it("returns todayInStoreTz and discovered todayInAccountTz server-side");
it("startDiscovery prepares or resumes a discovery run before triggering by syncRunId");
it("runProbe persists sampleSize 20 through 50 before triggering by syncRunId");
it("splits probe and join-rule approval/rejection into stable mutations");
it("converts inclusive store days into one DST-correct half-open window");
it("rejects a 91-day or pre-approved-floor source request before triggering");
it("triggers an order batch with only syncRunId");
it("uses explicit global syncRunId idempotency keys for discovery probe and event handoffs");
it("terminally fails the prepared row after an ambiguous handoff error");
it("reuses a live identical handoff and reaps only an expired run");
```

For the DST case, mock the scoped store timezone as `America/New_York`, call `startOrderCoreSync({ dateFrom: "2026-03-08", dateTo: "2026-03-08" })`, and assert `startOrResumeOrderCoreSync` receives a 23-hour `[from,to)` window. Plan 1's helper tests separately cover the 25-hour fall-back day.

- [ ] **Step 2: Run the router test to verify it fails**

Run: `bun run test -- src/lib/trpc/routers/klaviyo.test.ts`

Expected: FAIL because `appRouter` has no `klaviyo` property.

- [ ] **Step 3: Implement the stable router without browser scope IDs**

Create `src/lib/trpc/routers/klaviyo.ts` with `orgAdminProcedure`. A private `requirePilotConnection(ctx.organizationId)` calls `getPilotConnectionForOrganization` and throws `TRPCError({ code: "NOT_FOUND" })` when absent. It returns the full scope used by every downstream query/service. A private `triggerPreparedSyncRun({ scope, syncRunId, operation, taskId })` creates the exact `klaviyo:${operation}:first:${syncRunId}` key through `idempotencyKeys.create(key, { scope: "global" })`, triggers only `{ syncRunId }` with `idempotencyKeyTTL: "7d"`, and returns the handle. If triggering throws, it calls `failKlaviyoSyncRunAfterRetryExhaustion` for that exact scoped row and then throws a fixed safe tRPC error; it never passes the caught error to persistence.

Implement these exact contracts:

```ts
health: orgAdminProcedure.query(({ ctx }) =>
  getKlaviyoHealthForOrganization(ctx.organizationId),
),

syncRuns: orgAdminProcedure
  .input(
    z.object({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().nullish(),
    }).optional(),
  )
  .query(async ({ input, ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    return listKlaviyoSyncRuns({
      scope: connection,
      limit: input?.limit ?? 20,
      cursor: input?.cursor ?? null,
    });
  }),

probe: orgAdminProcedure.query(async ({ ctx }) => {
  const connection = await getPilotConnectionForOrganization(ctx.organizationId);
  return connection
    ? listKlaviyoProbeReview({ scope: connection })
    : { reports: [], rules: [] };
}),

startDiscovery: orgAdminProcedure.mutation(async ({ ctx }) => {
  const connection = await ensurePilotConnection(ctx.organizationId);
  const run = await prepareKlaviyoDiscoveryRun({
    scope: connection,
    triggerType: "manual",
  });
  const handle = await triggerPreparedSyncRun({
    scope: connection,
    syncRunId: run.id,
    operation: "discovery",
    taskId: "klaviyo-discovery",
  });
  return { runId: handle.id, syncRunId: run.id };
}),

runProbe: orgAdminProcedure
  .input(z.object({ sampleSize: z.number().int().min(20).max(50) }))
  .mutation(async ({ input, ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    const run = await prepareKlaviyoProbeRun({
      scope: connection,
      sampleSize: input.sampleSize,
      triggerType: "manual",
    });
    const handle = await triggerPreparedSyncRun({
      scope: connection,
      syncRunId: run.syncRunId,
      operation: "probe",
      taskId: "klaviyo-probe",
    });
    return { runId: handle.id, syncRunId: run.syncRunId };
  }),
```

`approveProbe` and `rejectProbe` both accept exactly `{ reportId, reviewNote }`, derive the scope/reviewer from context, and call `reviewProbeReport` with `passed` or `failed`. `approveJoinRule` and `rejectJoinRule` both accept exactly `{ ruleId, reviewNote }` and call `reviewJoinRule` with `approved` or `rejected`. All IDs are non-empty strings and notes are trimmed `1..1000` characters; cross-scope IDs return `NOT_FOUND`.

Implement the final action exactly at the browser/task boundary:

```ts
startOrderCoreSync: orgAdminProcedure
  .input(
    z.object({
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  )
  .mutation(async ({ input, ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    const window = inclusiveStoreDaysToHalfOpenUtc({
      ...input,
      timeZone: connection.storeTimezone,
    });
    const run = await startOrResumeOrderCoreSync({
      scope: connection,
      window,
      triggerType: "manual_backfill",
    });
    const handle = await triggerPreparedSyncRun({
      scope: connection,
      syncRunId: run.syncRunId,
      operation: "events",
      taskId: "klaviyo-order-core-batch",
    });
    return {
      runId: handle.id,
      syncRunId: run.syncRunId,
      resumed: run.resumed,
    };
  }),
```

Import `inclusiveStoreDaysToHalfOpenUtc` from `@/lib/klaviyo/types`, never call `new Date(dateFrom)`, and never return credential references, expected/discovered account IDs, HMACs, profile IDs, unrestricted property JSON, or raw errors. `health` must work without a connection; it returns safe store context with `store.todayInStoreTz`, plus `connection.todayInAccountTz` after discovery.

- [ ] **Step 4: Mount the router**

Import `klaviyoRouter` in `src/lib/trpc/routers/_app.ts` and add `klaviyo: klaviyoRouter` to the app router.

- [ ] **Step 5: Run router and existing authorization tests**

Run: `bun run test -- src/lib/trpc/routers/klaviyo.test.ts src/lib/trpc/routers/api-key-scopes.test.ts src/lib/trpc/routers/organization.test.ts`

Expected: PASS; stable names compile, pre-connection health is safe, no browser/task payload carries tenant scope, DST conversion is correct, and member/API-key/worker callers are forbidden.

- [ ] **Step 6: Commit the admin surface**

```bash
git add src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts src/lib/trpc/routers/_app.ts
git commit -m "feat(klaviyo): expose source ingestion controls"
```

### Task 12: Add privacy-safe connection uninstall

**Files:**
- Create: `src/lib/klaviyo/connection-lifecycle.ts`
- Test: `src/lib/klaviyo/connection-lifecycle.test.ts`
- Modify: `src/lib/klaviyo/source-store.integration.test.ts`
- Modify: `src/lib/trpc/routers/klaviyo.ts`
- Modify: `src/lib/trpc/routers/klaviyo.test.ts`

- [ ] **Step 1: Write the failing lifecycle unit test**

```ts
// src/lib/klaviyo/connection-lifecycle.test.ts
import { describe, expect, it, vi } from "vitest";
import { uninstallKlaviyoConnection } from "@/lib/klaviyo/connection-lifecycle";

describe("uninstallKlaviyoConnection", () => {
  it("clears pilot Shopify identity and deletes the connection in one transaction", async () => {
    const calls: string[] = [];
    const transaction = vi.fn(async (work: (tx: object) => Promise<void>) => {
      calls.push("transaction:start");
      await work({});
      calls.push("transaction:commit");
    });
    const lockStore = vi.fn(async () => {
      calls.push("store:lock");
      return true;
    });
    const loadConnection = vi.fn(async () => {
      calls.push("connection:lock");
      return {
        organizationId: "org-1",
        storeId: "store-1",
        connectionId: "connection-1",
      };
    });
    const clearIdentity = vi.fn(async () => {
      calls.push("identity:clear");
      return { ordersCleared: 2, digestsDeleted: 2 };
    });
    const deleteConnection = vi.fn(async () => {
      calls.push("connection:delete");
      return 1;
    });

    await expect(
      uninstallKlaviyoConnection(
        {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "connection-1",
        },
        { transaction, lockStore, loadConnection, clearIdentity, deleteConnection },
      ),
    ).resolves.toEqual({
      shopifyIdentity: { ordersCleared: 2, digestsDeleted: 2 },
    });
    expect(calls).toEqual([
      "transaction:start",
      "store:lock",
      "connection:lock",
      "identity:clear",
      "connection:delete",
      "transaction:commit",
    ]);
  });

  it("fails without deleting anything when the scoped connection is absent", async () => {
    const deleteConnection = vi.fn();
    await expect(
      uninstallKlaviyoConnection(
        {
          organizationId: "org-1",
          storeId: "store-1",
          connectionId: "missing",
        },
        {
          transaction: async (work) => work({}),
          lockStore: async () => true,
          loadConnection: async () => null,
          clearIdentity: vi.fn(),
          deleteConnection,
        },
      ),
    ).rejects.toThrow("Klaviyo connection not found in this scope");
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("fails before connection or identity mutation when the scoped store is absent");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- src/lib/klaviyo/connection-lifecycle.test.ts`

Expected: FAIL with `Failed to resolve import "@/lib/klaviyo/connection-lifecycle"`.

- [ ] **Step 3: Implement atomic uninstall**

```ts
// src/lib/klaviyo/connection-lifecycle.ts
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clearPilotShopifyIdentityForStore } from "@/lib/shopify-privacy";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoConnections } from "@/schema/klaviyo";
import { shopifyStores } from "@/schema/shopify";

type TransactionWork = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionWork>[0];

type LifecycleDependencies = {
  transaction: (work: (tx: Transaction) => Promise<void>) => Promise<void>;
  lockStore: (
    scope: Pick<KlaviyoConnectionScope, "organizationId" | "storeId">,
    tx: Transaction,
  ) => Promise<boolean>;
  loadConnection: (
    scope: KlaviyoConnectionScope,
    tx: Transaction,
  ) => Promise<KlaviyoConnectionScope | null>;
  clearIdentity: (
    scope: Pick<KlaviyoConnectionScope, "organizationId" | "storeId">,
    tx: Transaction,
  ) => Promise<{ ordersCleared: number; digestsDeleted: number }>;
  deleteConnection: (
    scope: KlaviyoConnectionScope,
    tx: Transaction,
  ) => Promise<number>;
};

const defaultDependencies: LifecycleDependencies = {
  transaction: async (work) => db.transaction(work),
  lockStore: async (scope, tx) => {
    const [row] = await tx
      .select({ id: shopifyStores.id })
      .from(shopifyStores)
      .where(
        and(
          eq(shopifyStores.organizationId, scope.organizationId),
          eq(shopifyStores.id, scope.storeId),
        ),
      )
      .for("update");
    return Boolean(row);
  },
  loadConnection: async (scope, tx) => {
    const [row] = await tx
      .select({
        organizationId: klaviyoConnections.organizationId,
        storeId: klaviyoConnections.storeId,
        connectionId: klaviyoConnections.id,
      })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, scope.organizationId),
          eq(klaviyoConnections.storeId, scope.storeId),
          eq(klaviyoConnections.id, scope.connectionId),
        ),
      )
      .for("update");
    return row ?? null;
  },
  clearIdentity: async (scope, tx) =>
    clearPilotShopifyIdentityForStore(scope, tx),
  deleteConnection: async (scope, tx) => {
    const deleted = await tx
      .delete(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, scope.organizationId),
          eq(klaviyoConnections.storeId, scope.storeId),
          eq(klaviyoConnections.id, scope.connectionId),
        ),
      )
      .returning({ id: klaviyoConnections.id });
    return deleted.length;
  },
};

export async function uninstallKlaviyoConnection(
  scope: KlaviyoConnectionScope,
  dependencies: LifecycleDependencies = defaultDependencies,
) {
  let shopifyIdentity = { ordersCleared: 0, digestsDeleted: 0 };
  await dependencies.transaction(async (tx) => {
    const storeLocked = await dependencies.lockStore(
      { organizationId: scope.organizationId, storeId: scope.storeId },
      tx,
    );
    if (!storeLocked) throw new Error("Shopify store not found in this scope");
    const connection = await dependencies.loadConnection(scope, tx);
    if (!connection) {
      throw new Error("Klaviyo connection not found in this scope");
    }
    shopifyIdentity = await dependencies.clearIdentity(
      { organizationId: scope.organizationId, storeId: scope.storeId },
      tx,
    );
    const deleted = await dependencies.deleteConnection(scope, tx);
    if (deleted !== 1) throw new Error("Klaviyo connection uninstall conflicted");
  });
  return { shopifyIdentity };
}
```

The lifecycle test must assert the exact mutation order `lockStore → loadConnection(FOR UPDATE) → clearIdentity → deleteConnection`, rollback on any failure, and no remote work inside the transaction. This matches Plan 1 evidence/erasure locking and becomes the shared store→connection order for Plan 3.

Deleting `klaviyo_connection` relies on the Plan 2 cascade foreign keys to remove metrics, event aliases, runs, probe reports, rules, events, and event products. Plan 3 must attach Klaviyo event identity rows with a cascading connection/event foreign key so this same service also removes those future digests. `clearPilotShopifyIdentityForStore` removes only `source_kind='shopify_order'` digest rows; it must not delete `identity_crypto_policy`, `identity_erasure_suppression`, `shopify_order`, `shopify_order_line`, refunds, sync history, or monetary attribution fields. Preserving the stable suppression binding and tombstones ensures a later reinstall/source replay cannot undo a subject erasure.

- [ ] **Step 4: Add database integration assertions**

Extend `src/lib/klaviyo/source-store.integration.test.ts` with a fixture containing one connection, metric, event, event product, probe report, join rule, Shopify order, Shopify line, Shopify identity digest, its crypto policy, one HMAC-only erasure suppression, and Shopify monetary values. Call `uninstallKlaviyoConnection` against the disposable database executor and assert:

```ts
expect(await count("klaviyo_connection", "id", "connection-a")).toBe(0);
expect(await count("klaviyo_metric", "connection_id", "connection-a")).toBe(0);
expect(await count("klaviyo_event_alias", "connection_id", "connection-a")).toBe(0);
expect(await count("klaviyo_event", "connection_id", "connection-a")).toBe(0);
expect(await count("klaviyo_event_product", "connection_id", "connection-a")).toBe(0);
expect(await count("klaviyo_probe_report", "connection_id", "connection-a")).toBe(0);
expect(await count("klaviyo_join_rule", "connection_id", "connection-a")).toBe(0);
expect(await count("klaviyo_sync_run", "connection_id", "connection-a")).toBe(0);
expect(await count("source_identity_hmac", "shopify_order_id", "order-a")).toBe(0);
expect(await count("identity_erasure_suppression", "store_id", "store-a")).toBe(1);
expect(await count("identity_crypto_policy", "store_id", "store-a")).toBe(1);
expect(await count("shopify_order", "id", "order-a")).toBe(1);
expect(await count("shopify_order_line", "order_id", "order-a")).toBe(1);
```

Query `shopify_order.net_sales`, `bucket`, `bucket_rule_version`, and `meta_verified` after uninstall and assert they equal the values inserted before uninstall.

- [ ] **Step 5: Expose owner/admin uninstall**

Import `uninstallKlaviyoConnection` in `src/lib/trpc/routers/klaviyo.ts` and add:

```ts
uninstall: orgAdminProcedure
  .mutation(async ({ ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    return uninstallKlaviyoConnection(connection);
  }),
```

Extend `src/lib/trpc/routers/klaviyo.test.ts` to assert member, API-key, and worker callers receive `FORBIDDEN` for `klaviyo.uninstall`, while an owner reaches the mocked lifecycle service without supplying organization/store/connection IDs.

- [ ] **Step 6: Run lifecycle, integration, and router tests**

Run: `bun run test -- src/lib/klaviyo/connection-lifecycle.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/trpc/routers/klaviyo.test.ts`

Expected with PostgreSQL available: PASS; Klaviyo rows and Shopify identity are removed, while Shopify orders, lines, and monetary fields remain unchanged.

- [ ] **Step 7: Commit uninstall support**

```bash
git add src/lib/klaviyo/connection-lifecycle.ts src/lib/klaviyo/connection-lifecycle.test.ts src/lib/klaviyo/source-store.integration.test.ts src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts
git commit -m "feat(klaviyo): add privacy-safe connection uninstall"
```

### Task 13: Verify the Plan 2 stop/go gate

**Files:**
- Modify only files already named in Tasks 1–12 if verification exposes a defect.

- [ ] **Step 1: Run all focused Plan 2 tests**

Run:

```bash
bun run test -- \
  src/lib/klaviyo/types.test.ts \
  src/lib/klaviyo/credential-provider.test.ts \
  src/lib/klaviyo/client.test.ts \
  src/lib/klaviyo/schema-contract.test.ts \
  src/lib/klaviyo/source-store.test.ts \
  src/lib/klaviyo/source-store.integration.test.ts \
  src/lib/klaviyo/redaction.test.ts \
  src/lib/klaviyo/event-normalizer.test.ts \
  src/lib/klaviyo/discovery.test.ts \
  src/lib/klaviyo/probe.test.ts \
  src/lib/klaviyo/join-rules.test.ts \
  src/lib/klaviyo/source-runner.test.ts \
  src/lib/klaviyo/connection-lifecycle.test.ts \
  src/lib/trpc/routers/klaviyo.test.ts
```

Expected: all unit tests PASS. The PostgreSQL suite must PASS with `DATABASE_URL`; a skipped database suite is not sufficient for the stop/go gate.

- [ ] **Step 2: Run the repository verification suite**

Run:

```bash
bun run test
bun run lint
bun run build
git diff --check
```

Expected: all three Bun commands exit 0; `git diff --check` prints no output.

- [ ] **Step 3: Verify migration ownership and source isolation**

Run:

```bash
git status --short
rg -n "netSales|bucketRuleVersion|metaVerified|shopifyRefunds" src/lib/klaviyo src/schema/klaviyo.ts trigger/klaviyo-source-sync.ts
```

Expected: status contains only Plan 2 files and generated `0054` artifacts. The `rg` command returns no write-path references to Shopify money, refunds, production buckets, or Meta verification.

- [ ] **Step 4: Perform the Reviv manual gate**

Using the owner/admin procedures in order:

1. Call `startDiscovery()` with no scope IDs; confirm bootstrap creates/reuses the configured store's pending connection and discovery persists the Accounts ID only after it equals `KLAVIYO_REVIV_ACCOUNT_ID`.
2. Call `runProbe({ sampleSize })` with `20` through `50`; confirm the task payload contains only `syncRunId`.
3. Inspect the persisted report and redacted event evidence; confirm no plaintext email, full URL query, unapproved property value, or identity-context path ID such as `/profiles/12345` or `/customer/abc123` appears. Confirm benign product paths remain readable.
4. Call `approveProbe({ reportId, reviewNote })` only if Shopify-native `Placed Order` and `Ordered Product` metrics are unique, 20–50 Shopify orders were sampled, redaction is verified, the alias set is unambiguous/malformed-free, and the report demonstrates positive Reviv order overlap; confirm eligible aliases became approved atomically, otherwise call `rejectProbe` and confirm they became rejected.
5. Call `approveJoinRule` only for populated zero-collision deterministic rules; call `rejectJoinRule` for the rest.
6. Call `startOrderCoreSync({ dateFrom, dateTo })` for the inclusive 90 store-day range and confirm the router converts it once, persists the computed fixed floor/current exclusive bound, and writes matching direct `sourceMode`/`metricKinds` in request parameters and checkpoint.
7. Confirm a 91-day/pre-floor request is rejected, re-run the same window without duplicate rows, and verify provider metric IDs were used remotely and validated against every event relationship while internal metric row IDs alone were persisted. Confirm terminal event success and `lastEventSyncedAt` publish atomically and cannot be rewritten by a second finish.

Expected: the connection is `ready`, the probe is immutable and reviewed, replay is idempotent, and prior source data remains available after a deliberately failed retry.

- [ ] **Step 5: Record the final verification commit only if verification required fixes**

```bash
git add .env.example src/lib/klaviyo src/schema/klaviyo.ts src/lib/trpc/routers/klaviyo.ts src/lib/trpc/routers/klaviyo.test.ts src/lib/trpc/routers/_app.ts trigger/klaviyo-source-sync.ts trigger/retry.ts drizzle/0054_klaviyo_source_core.sql drizzle/meta/0054_snapshot.json drizzle/meta/_journal.json
git commit -m "fix(klaviyo): close source ingestion verification gaps"
```

If verification required no changes, do not create an empty commit.

## Plan 3 handoff

Plan 3 may begin only after the manual gate passes. It consumes `klaviyoConnections`, `klaviyoMetrics`, `klaviyoEventAliases`, `klaviyoEvents`, `klaviyoEventProducts`, `klaviyoEventRunObservations`, `klaviyoJoinRules`, scoped `getConnectionRecord`, `loadEnabledOrderCoreMetrics`, the immutable direct order-core request/checkpoint contract, and the roadmap scope/Plan 1 window contracts. Plan 3 owns migration `0055_klaviyo_advisory_matching.sql`; it adds nullable `klaviyo_connection_id` plus `klaviyo_event_id` to Plan 1's `source_identity_hmac`, enforces the same organization/store/connection event scope and exactly-one-source check, replaces source uniqueness with partial `(shopify_order_id, key_version)` and `(klaviyo_connection_id, klaviyo_event_id, key_version)` indexes, and computes ordinary Klaviyo HMACs only at or after `initial_source_from` (its manual rotation path later covers every retained digest-bearing source by ID). The Plan 2 connection/event cascade removes those rows on uninstall; `clearPilotShopifyIdentityForStore` remains filtered to Shopify-source digests. Plan 3 selects matcher input through one exact successful run's observation membership and rejects any observation whose checksum no longer equals the mutable event row. It then creates all advisory candidate/result/product-link records without adding a parallel source ingestion path.
