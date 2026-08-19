# Google Ads Aggregate Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Google Ads aggregate pilot from `docs/superpowers/specs/2026-08-13-google-ads-aggregate-pilot-design.md`: env-credential provider, GAQL REST client, `google_ads_*` schema, discovery + campaign-fact sync via Trigger.dev, a gclid probe over stored Shopify journeys, and an admin-only lab page at `/attribution/google-ads`.

**Architecture:** Mirrors the Klaviyo pilot's boundaries file-for-file: credential provider → hand-rolled client → normalizer → store → runner → Trigger tasks → tRPC router → lab page. Google numbers are claims in their own tables; Shopify truth columns are never written. The probe consumes only stored data and needs no Google credentials.

**Tech Stack:** Next.js 16 / React 19, Drizzle + PostgreSQL, Trigger.dev v4 tasks, tRPC 11 (`orgAdminProcedure`), Vitest (`bun run test`, `bun run test:components`).

**Branch:** `feat/google-ads-pilot` (already created, spec committed).

---

## Spec deviation recorded here (Task 1 amends the spec)

The spec's probe section promises a "first-visit vs last-visit" split. The stored `shopify_order.customerJourney` is Shopify's `customerJourneySummary` and contains **only** `lastVisit` (`landingPage`, `referrerUrl`, `utmParameters`, …) — no `moments`, no `firstVisit` (see `src/lib/shopify-admin.ts:107-117`). The probe therefore reports click-ID presence on the **last visit only**, plus explicit `journeyMissing` counts. Task 1 amends the spec so it stays truthful.

## Conventions the code must follow (read once before starting)

- Icons from `@/components/icons` — `lucide-react` is blocked by lint.
- New primary keys: `text("id").primaryKey().$defaultFn(() => crypto.randomUUID())`.
- `bun run db:push` is disabled: generate with `bun run db:generate`, apply with `bun run db:migrate`, verify with `node scripts/check-migrations.mjs`.
- Server-only modules start with `import "server-only";`.
- Provider payloads/bodies are never logged or persisted — sanitized error codes/messages only.
- Unit tests live beside sources (`*.test.ts`); DB tests are `*.integration.test.ts`; component tests are `*.component.test.tsx` run by `bun run test:components`.

## File structure (what gets created/modified)

```
src/lib/google-ads/
  types.ts                       shared scope/checkpoint/summary types
  credential-provider.ts (+test) env-only provider boundary
  client.ts (+test)              OAuth refresh + GAQL search + retry/backoff
  facts.ts (+test)               GAQL query builder + row normalizer + day helpers
  sync-store.ts (+integration)   connection ensure/lookup, sync runs, fact upserts
  discovery.ts (+test)           customer-resource validation → connection ready/degraded
  facts-runner.ts (+test)        chunked backfill/incremental batch engine
  click-id-extractor.ts (+test)  gclid/wbraid/gbraid detection, in-memory only
  gclid-probe.ts (+integration)  order scan, tally, durable report
  queries.ts (+test)             lab reads: health, runs, facts, google-bucket reference
src/schema/google-ads.ts         4 tables (+ relations), migration 0060
src/lib/trpc/routers/google-ads.ts (+test)  admin router; composed in _app.ts
trigger/google-ads-sync.ts       discovery task, self-chaining facts batch, nightly schedule
trigger/gclid-probe.ts           probe task
src/components/blocks/attribution/
  privileged-access-gate.tsx     extracted shared gate (klaviyo gate re-exports)
  google-ads/lab-link.tsx (+component test)
  google-ads/google-ads-lab.tsx  minimal lab client component
src/app/(protected)/attribution/google-ads/page.tsx
src/app/(protected)/attribution/page.tsx        add <GoogleAdsLabLink />
scripts/google-ads-mint-refresh-token.mjs        one-time OAuth consent helper
.env.example                                     new GOOGLE_ADS_* block
docs/superpowers/plans/2026-08-13-google-ads-sandbox-runbook.md  manual sandbox steps
```

---

### Task 1: Amend the spec's probe section to match stored journey data

**Files:**
- Modify: `docs/superpowers/specs/2026-08-13-google-ads-aggregate-pilot-design.md`

- [ ] **Step 1: Edit the probe bullets**

In section 6 (Phase 0) replace the tally bullet

```
  - First-visit vs last-visit click-ID presence, and orders with multiple distinct click IDs.
```

with

```
  - Orders whose stored journey is missing or not ready (`customerJourney` null or
    `lastVisit` absent), and orders carrying more than one click-ID kind. The stored
    journey is Shopify's `customerJourneySummary` (last visit only — no moments/first
    visit), so click-ID presence is measured on the last visit's landing/referrer URLs.
```

In section 8 (`gclid_probe_report`) replace `first-visit vs last-visit presence; multi-click-ID orders.` with `journey-missing counts; multi-kind orders.`

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-13-google-ads-aggregate-pilot-design.md
git commit -m "docs: scope gclid probe to stored lastVisit journey data"
```

---

### Task 2: Credential provider + env example

**Files:**
- Create: `src/lib/google-ads/credential-provider.ts`
- Create: `src/lib/google-ads/credential-provider.test.ts`
- Modify: `.env.example` (append block)

- [ ] **Step 1: Write the failing test**

`src/lib/google-ads/credential-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EnvironmentGoogleAdsCredentialProvider,
  GOOGLE_ADS_CREDENTIAL_REFERENCE,
} from "@/lib/google-ads/credential-provider";

const FULL_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_ADS_OAUTH_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123-456-7890",
  GOOGLE_ADS_CUSTOMER_ID: "098-765-4321",
  GOOGLE_ADS_REVIV_SHOP_DOMAIN: "Reviv.myshopify.com",
};

describe("EnvironmentGoogleAdsCredentialProvider", () => {
  it("resolves a credential with normalized digit-only customer IDs", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    const credential = await provider.resolve({
      credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
      persistedGoogleCustomerId: null,
    });
    expect(credential.customerId).toBe("0987654321");
    expect(credential.loginCustomerId).toBe("1234567890");
    expect(credential.developerToken).toBe("dev-token");
    expect(credential.reference).toBe("reviv_environment");
  });

  it("exposes the pilot binding with a lowercased shop domain", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    const binding = await provider.getPilotBinding();
    expect(binding.shopDomain).toBe("reviv.myshopify.com");
    expect(binding.customerId).toBe("0987654321");
  });

  it("rejects a persisted customer ID that differs from the environment", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    await expect(
      provider.resolve({
        credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
        persistedGoogleCustomerId: "1111111111",
      }),
    ).rejects.toThrow(/binding does not match/);
  });

  it.each(Object.keys(FULL_ENV))("fails closed when %s is missing", async (name) => {
    const environment = { ...FULL_ENV, [name]: "  " };
    const provider = new EnvironmentGoogleAdsCredentialProvider(environment);
    await expect(provider.getPilotBinding()).rejects.toThrow(/is required/);
  });

  it("rejects an unsupported credential reference", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    await expect(
      provider.resolve({
        // @ts-expect-error deliberate bad reference
        credentialReference: "something_else",
        persistedGoogleCustomerId: null,
      }),
    ).rejects.toThrow(/Unsupported/);
  });

  it("rejects a customer ID that is not 10 digits", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider({
      ...FULL_ENV,
      GOOGLE_ADS_CUSTOMER_ID: "12ab",
    });
    await expect(provider.getPilotBinding()).rejects.toThrow(/10 digits/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/google-ads/credential-provider.test.ts`
Expected: FAIL — cannot resolve `@/lib/google-ads/credential-provider`.

- [ ] **Step 3: Implement**

`src/lib/google-ads/credential-provider.ts`:

```ts
import "server-only";

export const GOOGLE_ADS_CREDENTIAL_REFERENCE = "reviv_environment" as const;

export type GoogleAdsCredentialRequest = {
  credentialReference: typeof GOOGLE_ADS_CREDENTIAL_REFERENCE;
  persistedGoogleCustomerId: string | null;
};

export type RevivGoogleAdsBinding = {
  /** Client ad account, digits only. */
  customerId: string;
  /** Manager (MCC) account, digits only. */
  loginCustomerId: string;
  shopDomain: string;
};

export type ResolvedGoogleAdsCredential = {
  developerToken: string;
  oauthClientId: string;
  oauthClientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId: string;
  reference: typeof GOOGLE_ADS_CREDENTIAL_REFERENCE;
};

export interface GoogleAdsCredentialProvider {
  getPilotBinding(): Promise<RevivGoogleAdsBinding>;
  resolve(
    request: GoogleAdsCredentialRequest,
  ): Promise<ResolvedGoogleAdsCredential>;
}

type GoogleAdsEnvironment = {
  [name: string]: string | undefined;
};

const EXACT_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function required(environment: GoogleAdsEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Accepts "123-456-7890" or "1234567890"; canonical form is digits only. */
function normalizeCustomerId(value: string, name: string): string {
  const digits = value.replaceAll("-", "");
  if (!/^\d{10}$/.test(digits)) {
    throw new Error(`${name} must contain a Google Ads customer ID of 10 digits`);
  }
  return digits;
}

function normalizeShopDomain(value: string): string {
  const hostname = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!EXACT_HOSTNAME_PATTERN.test(hostname)) {
    throw new Error("GOOGLE_ADS_REVIV_SHOP_DOMAIN must contain an exact hostname");
  }
  return hostname.toLowerCase();
}

export class EnvironmentGoogleAdsCredentialProvider
  implements GoogleAdsCredentialProvider
{
  readonly #environment: GoogleAdsEnvironment;

  constructor(environment: GoogleAdsEnvironment = process.env) {
    this.#environment = environment;
  }

  #readConfiguration(): {
    binding: RevivGoogleAdsBinding;
    secrets: Pick<
      ResolvedGoogleAdsCredential,
      "developerToken" | "oauthClientId" | "oauthClientSecret" | "refreshToken"
    >;
  } {
    const environment = this.#environment;
    return {
      binding: {
        customerId: normalizeCustomerId(
          required(environment, "GOOGLE_ADS_CUSTOMER_ID"),
          "GOOGLE_ADS_CUSTOMER_ID",
        ),
        loginCustomerId: normalizeCustomerId(
          required(environment, "GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
          "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
        ),
        shopDomain: normalizeShopDomain(
          required(environment, "GOOGLE_ADS_REVIV_SHOP_DOMAIN"),
        ),
      },
      secrets: {
        developerToken: required(environment, "GOOGLE_ADS_DEVELOPER_TOKEN"),
        oauthClientId: required(environment, "GOOGLE_ADS_OAUTH_CLIENT_ID"),
        oauthClientSecret: required(environment, "GOOGLE_ADS_OAUTH_CLIENT_SECRET"),
        refreshToken: required(environment, "GOOGLE_ADS_REFRESH_TOKEN"),
      },
    };
  }

  async getPilotBinding(): Promise<RevivGoogleAdsBinding> {
    // Validates the full set (including secrets) so a half-configured
    // environment fails before any connection bootstrap can write.
    return this.#readConfiguration().binding;
  }

  async resolve(
    request: GoogleAdsCredentialRequest,
  ): Promise<ResolvedGoogleAdsCredential> {
    if (request.credentialReference !== GOOGLE_ADS_CREDENTIAL_REFERENCE) {
      throw new Error("Unsupported Google Ads credential reference");
    }
    const { binding, secrets } = this.#readConfiguration();
    if (
      request.persistedGoogleCustomerId !== null &&
      request.persistedGoogleCustomerId !== binding.customerId
    ) {
      throw new Error(
        "Google Ads connection binding does not match the configured account",
      );
    }
    return {
      ...secrets,
      customerId: binding.customerId,
      loginCustomerId: binding.loginCustomerId,
      reference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/lib/google-ads/credential-provider.test.ts`
Expected: PASS (all 6+ cases).

- [ ] **Step 5: Append the env block**

Append to `.env.example` (check the file exists first with `ls .env.example`; if the repo uses a different example-env filename, append to that one):

```bash
# --- Google Ads pilot (server/worker only — NEVER expose client-side) ---
# Developer token from the (test) manager account. Unapproved tokens work
# against TEST accounts only; Basic access is required for production data.
GOOGLE_ADS_DEVELOPER_TOKEN=""
# OAuth client (Google Cloud project) used for the one-time consent flow.
GOOGLE_ADS_OAUTH_CLIENT_ID=""
GOOGLE_ADS_OAUTH_CLIENT_SECRET=""
# Mint with: node scripts/google-ads-mint-refresh-token.mjs
GOOGLE_ADS_REFRESH_TOKEN=""
# Manager (MCC) account ID, with or without dashes.
GOOGLE_ADS_LOGIN_CUSTOMER_ID=""
# Client ad account ID the pilot syncs, with or without dashes.
GOOGLE_ADS_CUSTOMER_ID=""
# Shopify shop domain the pilot connection binds to (Reviv).
GOOGLE_ADS_REVIV_SHOP_DOMAIN=""
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/google-ads/credential-provider.ts src/lib/google-ads/credential-provider.test.ts .env.example
git commit -m "feat: add Google Ads environment credential provider"
```

---

### Task 3: Shared types + schema + migration

**Files:**
- Create: `src/lib/google-ads/types.ts`
- Create: `src/schema/google-ads.ts`
- Generated: `drizzle/0060_*.sql` + meta (via `bun run db:generate`)

- [ ] **Step 1: Write the types**

`src/lib/google-ads/types.ts`:

```ts
export type GoogleAdsScope = {
  organizationId: string;
  storeId: string;
  connectionId: string;
};

export type ClickIdKind = "gclid" | "wbraid" | "gbraid";

export type GclidProbeBucketCell = {
  orders: number;
  withClickId: number;
};

export type GclidProbeParamFingerprint = {
  /** Literal key when allowlisted, otherwise `sha256:<12 hex chars>`. */
  key: string;
  hashed: boolean;
  count: number;
};

export type GclidProbeSummary = {
  ordersScanned: number;
  ordersWithAnyClickId: number;
  byKind: Record<ClickIdKind, number>;
  /** Keyed by production bucket name; unbucketed orders land in "pending". */
  byBucket: Record<string, GclidProbeBucketCell>;
  /** customerJourney null, not ready, or lastVisit absent. */
  journeyMissing: number;
  /** URLs present but unparseable even by the query-string fallback. */
  parseFailures: number;
  /** Orders carrying more than one click-ID kind. */
  multiKindOrders: number;
  paramKeyFingerprints: GclidProbeParamFingerprint[];
};
```

- [ ] **Step 2: Write the schema**

`src/schema/google-ads.ts`:

```ts
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
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
import type { GclidProbeSummary } from "@/lib/google-ads/types";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const googleAdsConnections = pgTable(
  "google_ads_connection",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    storeId: text("shopify_store_id").notNull(),
    googleCustomerId: text("google_customer_id"),
    descriptiveName: text("descriptive_name"),
    currencyCode: text("currency_code"),
    timezone: text("timezone"),
    status: text("status").notNull().default("pending"),
    authenticationMode: text("authentication_mode")
      .notNull()
      .default("environment"),
    credentialReference: text("credential_reference")
      .notNull()
      .default("reviv_environment"),
    lastDiscoverySyncedAt: timestamp("last_discovery_synced_at"),
    lastFactsSyncedAt: timestamp("last_facts_synced_at"),
    backfillCompletedAt: timestamp("backfill_completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("google_ads_connection_org_store_uniq").on(
      table.organizationId,
      table.storeId,
    ),
    unique("google_ads_connection_scope_id_uniq").on(
      table.organizationId,
      table.storeId,
      table.id,
    ),
    uniqueIndex("google_ads_connection_active_customer_uidx")
      .on(table.googleCustomerId)
      .where(
        sql`${table.googleCustomerId} is not null and ${table.status} <> 'disabled'`,
      ),
    foreignKey({
      name: "google_ads_connection_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    check(
      "google_ads_connection_status_check",
      sql`${table.status} in ('pending', 'ready', 'degraded', 'disabled')`,
    ),
    check(
      "google_ads_connection_auth_mode_check",
      sql`${table.authenticationMode} = 'environment'`,
    ),
    check(
      "google_ads_connection_credential_ref_check",
      sql`${table.credentialReference} = 'reviv_environment'`,
    ),
  ],
);

export const googleAdsSyncRuns = pgTable(
  "google_ads_sync_run",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    operation: text("operation").notNull(),
    /** Inclusive account-timezone day range; null for discovery runs. */
    windowFromDay: date("window_from_day"),
    windowToDay: date("window_to_day"),
    /** Last fully committed account-timezone day. */
    checkpointDay: date("checkpoint_day"),
    status: text("status").notNull().default("running"),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsUpserted: integer("rows_upserted").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    apiVersion: text("api_version").notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "google_ads_sync_run_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        googleAdsConnections.organizationId,
        googleAdsConnections.storeId,
        googleAdsConnections.id,
      ],
    }).onDelete("cascade"),
    index("google_ads_sync_run_connection_idx").on(
      table.connectionId,
      table.startedAt,
    ),
    check(
      "google_ads_sync_run_operation_check",
      sql`${table.operation} in ('discovery', 'facts')`,
    ),
    check(
      "google_ads_sync_run_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "google_ads_sync_run_window_check",
      sql`(${table.operation} = 'discovery' and ${table.windowFromDay} is null and ${table.windowToDay} is null)
        or (${table.operation} = 'facts' and ${table.windowFromDay} is not null and ${table.windowToDay} is not null
          and ${table.windowFromDay} <= ${table.windowToDay})`,
    ),
  ],
);

export const googleAdsCampaignFacts = pgTable(
  "google_ads_campaign_fact",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    connectionId: text("connection_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    campaignName: text("campaign_name").notNull(),
    campaignStatus: text("campaign_status"),
    channelType: text("channel_type"),
    /** Google reporting day in the ad account's timezone. */
    factDate: date("fact_date").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    impressions: bigint("impressions", { mode: "number" }).notNull(),
    clicks: bigint("clicks", { mode: "number" }).notNull(),
    conversions: numeric("conversions").notNull(),
    conversionsValue: numeric("conversions_value").notNull(),
    currencyCode: text("currency_code"),
    apiVersion: text("api_version").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "google_ads_campaign_fact_scope_fk",
      columns: [table.organizationId, table.storeId, table.connectionId],
      foreignColumns: [
        googleAdsConnections.organizationId,
        googleAdsConnections.storeId,
        googleAdsConnections.id,
      ],
    }).onDelete("cascade"),
    unique("google_ads_campaign_fact_day_uniq").on(
      table.connectionId,
      table.campaignId,
      table.factDate,
    ),
    index("google_ads_campaign_fact_date_idx").on(
      table.connectionId,
      table.factDate,
    ),
    check(
      "google_ads_campaign_fact_nonnegative_check",
      sql`${table.costMicros} >= 0 and ${table.impressions} >= 0 and ${table.clicks} >= 0`,
    ),
  ],
);

export const gclidProbeReports = pgTable(
  "gclid_probe_report",
  {
    id: id(),
    organizationId: text("organization_id").notNull(),
    storeId: text("shopify_store_id").notNull(),
    /** Nullable: Phase 0 runs before any Google Ads connection exists. */
    connectionId: text("connection_id").references(
      () => googleAdsConnections.id,
      { onDelete: "set null" },
    ),
    /** Inclusive store-day window scanned. */
    windowFromDay: date("window_from_day").notNull(),
    windowToDay: date("window_to_day").notNull(),
    status: text("status").notNull().default("running"),
    ordersScanned: integer("orders_scanned").notNull().default(0),
    summary: jsonb("summary").$type<GclidProbeSummary | null>(),
    /** sha256 of the canonical summary JSON; immutable once completed. */
    checksum: text("checksum"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "gclid_probe_report_org_store_fk",
      columns: [table.organizationId, table.storeId],
      foreignColumns: [shopifyStores.organizationId, shopifyStores.id],
    }).onDelete("cascade"),
    index("gclid_probe_report_store_idx").on(table.storeId, table.createdAt),
    check(
      "gclid_probe_report_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "gclid_probe_report_window_check",
      sql`${table.windowFromDay} <= ${table.windowToDay}`,
    ),
  ],
);

export const googleAdsConnectionRelations = relations(
  googleAdsConnections,
  ({ many }) => ({
    syncRuns: many(googleAdsSyncRuns),
    campaignFacts: many(googleAdsCampaignFacts),
  }),
);

export const googleAdsSyncRunRelations = relations(
  googleAdsSyncRuns,
  ({ one }) => ({
    connection: one(googleAdsConnections, {
      fields: [googleAdsSyncRuns.connectionId],
      references: [googleAdsConnections.id],
    }),
  }),
);

export const googleAdsCampaignFactRelations = relations(
  googleAdsCampaignFacts,
  ({ one }) => ({
    connection: one(googleAdsConnections, {
      fields: [googleAdsCampaignFacts.connectionId],
      references: [googleAdsConnections.id],
    }),
  }),
);
```

- [ ] **Step 3: Generate and verify the migration**

Run: `bun run db:generate`
Expected: a new `drizzle/0060_*.sql` plus `drizzle/meta/0060_snapshot.json` and a `_journal.json` entry (0059 is currently the latest).

Run: `node scripts/check-migrations.mjs`
Expected: passes.

Inspect the generated SQL: it must contain the four `CREATE TABLE` statements, the partial unique index on `google_customer_id`, and all checks. It must not touch any existing table.

- [ ] **Step 4: Apply locally**

Run: `bun run db:migrate`
Expected: migration applies cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-ads/types.ts src/schema/google-ads.ts drizzle/
git commit -m "feat: add google_ads_* schema and gclid probe report table"
```

---

### Task 4: GAQL REST client

**Files:**
- Create: `src/lib/google-ads/client.ts`
- Create: `src/lib/google-ads/client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/google-ads/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  GoogleAdsApiError,
  GoogleAdsClient,
  GOOGLE_ADS_API_VERSION,
} from "@/lib/google-ads/client";
import type { ResolvedGoogleAdsCredential } from "@/lib/google-ads/credential-provider";

const CREDENTIAL: ResolvedGoogleAdsCredential = {
  developerToken: "dev-token",
  oauthClientId: "cid",
  oauthClientSecret: "secret",
  refreshToken: "refresh",
  customerId: "1234567890",
  loginCustomerId: "0987654321",
  reference: "reviv_environment",
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenResponse() {
  return jsonResponse(200, { access_token: "at-1", expires_in: 3600 });
}

function makeClient(fetchImpl: typeof fetch) {
  return new GoogleAdsClient({
    credential: CREDENTIAL,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });
}

describe("GoogleAdsClient", () => {
  it("refreshes a token once and searches with pinned version and headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.includes("oauth2.googleapis.com")) return tokenResponse();
      return jsonResponse(200, {
        results: [{ campaign: { id: "1" } }],
        nextPageToken: "tok-2",
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.results).toHaveLength(1);
    expect(page.nextPageToken).toBe("tok-2");

    await client.search({ query: "SELECT campaign.id FROM campaign", pageToken: "tok-2" });
    const tokenCalls = calls.filter((call) => call.url.includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);

    const searchCall = calls.find((call) => call.url.includes("googleads"));
    expect(searchCall?.url).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:search`,
    );
    const headers = new Headers(searchCall?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer at-1");
    expect(headers.get("developer-token")).toBe("dev-token");
    expect(headers.get("login-customer-id")).toBe("0987654321");
  });

  it("retries retryable statuses and succeeds", async () => {
    let searchAttempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      searchAttempts += 1;
      if (searchAttempts < 3) return jsonResponse(500, { error: {} });
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.results).toEqual([]);
    expect(searchAttempts).toBe(3);
  });

  it("fails fast on a 400 without leaking the body", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(400, { error: { message: "secret detail" } });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const failure = await client
      .search({ query: "bad" })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(GoogleAdsApiError);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(false);
    expect(apiError.status).toBe(400);
    expect(apiError.message).not.toContain("secret detail");
  });

  it("throws a retryable error after exhausting attempts on 429", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(429, {}, { "retry-after": "1" });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const failure = await client
      .search({ query: "SELECT campaign.id FROM campaign" })
      .then(() => null, (error: unknown) => error);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(true);
    expect(apiError.status).toBe(429);
  });

  it("treats a token endpoint rejection as terminal", async () => {
    const fetchImpl = (async () =>
      jsonResponse(400, { error: "invalid_grant" })) as typeof fetch;
    const client = makeClient(fetchImpl);
    const failure = await client
      .search({ query: "SELECT campaign.id FROM campaign" })
      .then(() => null, (error: unknown) => error);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(false);
    expect(apiError.message).toMatch(/token/i);
    expect(apiError.message).not.toContain("invalid_grant");
  });

  it("rejects a malformed results payload", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(200, { results: "not-an-array" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.search({ query: "SELECT campaign.id FROM campaign" }),
    ).rejects.toThrow(/malformed/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/google-ads/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/google-ads/client.ts`:

```ts
import "server-only";

import type { ResolvedGoogleAdsCredential } from "@/lib/google-ads/credential-provider";

/**
 * Pinned per the spec: one named version constant recorded on every row and
 * run. Verify against the current release during sandbox bring-up and bump
 * here only (Task 15 of the sandbox runbook).
 */
export const GOOGLE_ADS_API_VERSION = "v21";

const GOOGLE_ADS_ORIGIN = "https://googleads.googleapis.com";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 60_000;
/** A stalled-open connection never rejects on its own; abort converts it into a retryable failure. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh slightly early so an in-flight request never carries an expired token. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

export type GoogleAdsSearchRow = Record<string, unknown>;

export type GoogleAdsSearchPage = {
  results: GoogleAdsSearchRow[];
  nextPageToken: string | null;
  apiVersion: string;
};

type ClientOptions = {
  credential: ResolvedGoogleAdsCredential;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // Body disposal is best-effort and must never surface provider content.
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class GoogleAdsClient {
  readonly #credential: ResolvedGoogleAdsCredential;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;
  #tokenRefresh: Promise<string> | null = null;

  constructor(options: ClientOptions) {
    this.#credential = options.credential;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async #fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch {
      throw new GoogleAdsApiError("Google Ads request failed to complete", null, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async #getAccessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt) {
      return this.#accessToken;
    }
    // Single-flight: concurrent callers share one refresh.
    this.#tokenRefresh ??= this.#refreshAccessToken().finally(() => {
      this.#tokenRefresh = null;
    });
    return this.#tokenRefresh;
  }

  async #refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.#credential.oauthClientId,
      client_secret: this.#credential.oauthClientSecret,
      refresh_token: this.#credential.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await this.#fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      discardResponseBody(response);
      // invalid_grant / invalid_client are configuration failures; retrying
      // cannot fix them and 5xx from the token endpoint is rare enough to
      // surface rather than mask.
      throw new GoogleAdsApiError(
        "Google Ads OAuth token refresh was rejected",
        response.status,
        false,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GoogleAdsApiError("Google Ads OAuth token response was malformed", null, false);
    }
    const record = payload as { access_token?: unknown; expires_in?: unknown };
    if (typeof record.access_token !== "string" || typeof record.expires_in !== "number") {
      throw new GoogleAdsApiError("Google Ads OAuth token response was malformed", null, false);
    }
    this.#accessToken = record.access_token;
    this.#accessTokenExpiresAt =
      Date.now() + record.expires_in * 1_000 - TOKEN_EXPIRY_SLACK_MS;
    return this.#accessToken;
  }

  /** Runs one GAQL search page against the pilot customer account. */
  async search(params: {
    query: string;
    pageToken?: string | null;
  }): Promise<GoogleAdsSearchPage> {
    const url = `${GOOGLE_ADS_ORIGIN}/${GOOGLE_ADS_API_VERSION}/customers/${this.#credential.customerId}/googleAds:search`;
    let lastError: GoogleAdsApiError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const token = await this.#getAccessToken();
      let response: Response;
      try {
        response = await this.#fetchWithTimeout(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "developer-token": this.#credential.developerToken,
            "login-customer-id": this.#credential.loginCustomerId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: params.query,
            ...(params.pageToken ? { pageToken: params.pageToken } : {}),
          }),
        });
      } catch (error) {
        lastError =
          error instanceof GoogleAdsApiError
            ? error
            : new GoogleAdsApiError("Google Ads request failed to complete", null, true);
        if (!lastError.retryable) throw lastError;
        await this.#backoff(attempt, null);
        continue;
      }

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        discardResponseBody(response);
        const retryable = isRetryableStatus(response.status);
        lastError = new GoogleAdsApiError(
          `Google Ads search was rejected (HTTP ${response.status})`,
          response.status,
          retryable,
          retryAfterMs,
        );
        if (!retryable) throw lastError;
        await this.#backoff(attempt, retryAfterMs);
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new GoogleAdsApiError("Google Ads search response was malformed", null, false);
      }
      const record = payload as { results?: unknown; nextPageToken?: unknown };
      const results = record.results ?? [];
      if (
        !Array.isArray(results) ||
        results.some((row) => typeof row !== "object" || row === null || Array.isArray(row)) ||
        (record.nextPageToken !== undefined && typeof record.nextPageToken !== "string")
      ) {
        throw new GoogleAdsApiError("Google Ads search response was malformed", null, false);
      }
      return {
        results: results as GoogleAdsSearchRow[],
        nextPageToken:
          typeof record.nextPageToken === "string" && record.nextPageToken.length > 0
            ? record.nextPageToken
            : null,
        apiVersion: GOOGLE_ADS_API_VERSION,
      };
    }

    throw lastError ??
      new GoogleAdsApiError("Google Ads search failed after retries", null, true);
  }

  async #backoff(attempt: number, retryAfterMs: number | null): Promise<void> {
    if (attempt >= MAX_ATTEMPTS) return;
    const base = Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    const jitter = base * 0.25 * this.#random();
    const delay = Math.min(
      Math.max(retryAfterMs ?? 0, base + jitter),
      MAX_RETRY_DELAY_MS,
    );
    await this.#sleep(delay);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/lib/google-ads/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-ads/client.ts src/lib/google-ads/client.test.ts
git commit -m "feat: add Google Ads GAQL REST client with retry discipline"
```

---

### Task 5: Facts query builder + normalizer + day helpers

**Files:**
- Create: `src/lib/google-ads/facts.ts`
- Create: `src/lib/google-ads/facts.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/google-ads/facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  accountDay,
  addDays,
  buildCampaignFactsQuery,
  buildCustomerQuery,
  normalizeCampaignFactRow,
} from "@/lib/google-ads/facts";

describe("day helpers", () => {
  it("formats a date in the account timezone", () => {
    // 2026-08-13T02:00Z is still 2026-08-12 in Los Angeles.
    const instant = new Date("2026-08-13T02:00:00Z");
    expect(accountDay(instant, "America/Los_Angeles")).toBe("2026-08-12");
    expect(accountDay(instant, "UTC")).toBe("2026-08-13");
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDays("2026-08-13", -90)).toBe("2026-05-15");
  });
});

describe("buildCampaignFactsQuery", () => {
  it("builds an inclusive BETWEEN query", () => {
    const query = buildCampaignFactsQuery("2026-08-01", "2026-08-14");
    expect(query).toContain("FROM campaign");
    expect(query).toContain("segments.date BETWEEN '2026-08-01' AND '2026-08-14'");
  });

  it("rejects malformed day strings", () => {
    expect(() => buildCampaignFactsQuery("2026-8-1", "2026-08-14")).toThrow(/day/);
    expect(() => buildCampaignFactsQuery("2026-08-01'; DROP", "2026-08-14")).toThrow(/day/);
  });
});

describe("buildCustomerQuery", () => {
  it("selects the discovery fields", () => {
    const query = buildCustomerQuery();
    for (const field of [
      "customer.id",
      "customer.descriptive_name",
      "customer.currency_code",
      "customer.time_zone",
      "customer.manager",
    ]) {
      expect(query).toContain(field);
    }
  });
});

describe("normalizeCampaignFactRow", () => {
  const ROW = {
    campaign: {
      id: "222",
      name: "Brand Search",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
    },
    segments: { date: "2026-08-01" },
    metrics: {
      costMicros: "1234500",
      impressions: "100",
      clicks: "7",
      conversions: 1.5,
      conversionsValue: 210.75,
    },
  };

  it("normalizes REST Int64 strings and doubles", () => {
    const fact = normalizeCampaignFactRow(ROW);
    expect(fact).toEqual({
      campaignId: "222",
      campaignName: "Brand Search",
      campaignStatus: "ENABLED",
      channelType: "SEARCH",
      factDate: "2026-08-01",
      costMicros: 1234500,
      impressions: 100,
      clicks: 7,
      conversions: "1.5",
      conversionsValue: "210.75",
    });
  });

  it("defaults absent metrics to zero", () => {
    const fact = normalizeCampaignFactRow({
      campaign: { id: "1", name: "X" },
      segments: { date: "2026-08-01" },
      metrics: {},
    });
    expect(fact?.costMicros).toBe(0);
    expect(fact?.conversions).toBe("0");
  });

  it("returns null for a row without campaign id or date", () => {
    expect(
      normalizeCampaignFactRow({ segments: { date: "2026-08-01" }, metrics: {} }),
    ).toBeNull();
    expect(
      normalizeCampaignFactRow({ campaign: { id: "1", name: "X" }, metrics: {} }),
    ).toBeNull();
  });

  it("rejects negative or non-finite metric values", () => {
    expect(
      normalizeCampaignFactRow({
        ...ROW,
        metrics: { ...ROW.metrics, costMicros: "-5" },
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/google-ads/facts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/google-ads/facts.ts`:

```ts
import "server-only";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type NormalizedCampaignFact = {
  campaignId: string;
  campaignName: string;
  campaignStatus: string | null;
  channelType: string | null;
  factDate: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  /** Kept as strings for numeric columns; Google reports fractional conversions. */
  conversions: string;
  conversionsValue: string;
};

export function assertDay(value: string): string {
  if (!DAY_PATTERN.test(value)) {
    throw new Error("Google Ads window day must be YYYY-MM-DD");
  }
  return value;
}

/** YYYY-MM-DD for an instant in the given IANA timezone. */
export function accountDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function addDays(day: string, delta: number): string {
  assertDay(day);
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, dayOfMonth + delta));
  return utc.toISOString().slice(0, 10);
}

export function buildCampaignFactsQuery(fromDay: string, toDay: string): string {
  assertDay(fromDay);
  assertDay(toDay);
  return (
    "SELECT campaign.id, campaign.name, campaign.status, " +
    "campaign.advertising_channel_type, segments.date, metrics.cost_micros, " +
    "metrics.impressions, metrics.clicks, metrics.conversions, " +
    "metrics.conversions_value FROM campaign " +
    `WHERE segments.date BETWEEN '${fromDay}' AND '${toDay}' ` +
    "ORDER BY segments.date"
  );
}

export function buildCustomerQuery(): string {
  return (
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, " +
    "customer.time_zone, customer.manager FROM customer"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** REST returns Int64 metrics as strings and doubles as numbers; absent means zero. */
function countMetric(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const parsed =
    typeof value === "string" && /^-?\d+$/.test(value)
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

function decimalMetric(value: unknown): string | null {
  if (value === undefined || value === null) return "0";
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return String(parsed);
}

/** Returns null for rows this pilot cannot represent; callers count them as failures. */
export function normalizeCampaignFactRow(
  row: Record<string, unknown>,
): NormalizedCampaignFact | null {
  const campaign = isRecord(row.campaign) ? row.campaign : null;
  const segments = isRecord(row.segments) ? row.segments : null;
  const metrics = isRecord(row.metrics) ? row.metrics : {};

  const campaignId =
    campaign && (typeof campaign.id === "string" || typeof campaign.id === "number")
      ? String(campaign.id)
      : null;
  const factDate =
    segments && typeof segments.date === "string" && DAY_PATTERN.test(segments.date)
      ? segments.date
      : null;
  if (!campaignId || !factDate) return null;

  const costMicros = countMetric(metrics.costMicros);
  const impressions = countMetric(metrics.impressions);
  const clicks = countMetric(metrics.clicks);
  const conversions = decimalMetric(metrics.conversions);
  const conversionsValue = decimalMetric(metrics.conversionsValue);
  if (
    costMicros === null ||
    impressions === null ||
    clicks === null ||
    conversions === null ||
    conversionsValue === null
  ) {
    return null;
  }

  return {
    campaignId,
    campaignName:
      campaign && typeof campaign.name === "string" && campaign.name.length > 0
        ? campaign.name
        : campaignId,
    campaignStatus:
      campaign && typeof campaign.status === "string" ? campaign.status : null,
    channelType:
      campaign && typeof campaign.advertisingChannelType === "string"
        ? campaign.advertisingChannelType
        : null,
    factDate,
    costMicros,
    impressions,
    clicks,
    conversions,
    conversionsValue,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/lib/google-ads/facts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-ads/facts.ts src/lib/google-ads/facts.test.ts
git commit -m "feat: add Google Ads facts query builder and row normalizer"
```

---

### Task 6: Sync store (connection, runs, fact upserts)

**Files:**
- Create: `src/lib/google-ads/sync-store.ts`
- Create: `src/lib/google-ads/sync-store.integration.test.ts`

- [ ] **Step 1: Implement the store**

`src/lib/google-ads/sync-store.ts`:

```ts
import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  googleAdsCampaignFacts,
  googleAdsConnections,
  googleAdsSyncRuns,
} from "@/schema/google-ads";
import { shopifyStores } from "@/schema/shopify";
import {
  EnvironmentGoogleAdsCredentialProvider,
  type GoogleAdsCredentialProvider,
} from "@/lib/google-ads/credential-provider";
import type { NormalizedCampaignFact } from "@/lib/google-ads/facts";
import type { GoogleAdsScope } from "@/lib/google-ads/types";

export type ConnectionRecord = typeof googleAdsConnections.$inferSelect;
export type SyncRunRecord = typeof googleAdsSyncRuns.$inferSelect;

export type SanitizedSyncError = { code: string; message: string };

/**
 * Resolves the pilot store from the provider's server-side shop-domain
 * binding and returns (creating if absent) its single pending connection.
 * Never accepts caller-supplied scope.
 */
export async function ensurePilotGoogleAdsConnection(
  provider: GoogleAdsCredentialProvider = new EnvironmentGoogleAdsCredentialProvider(),
): Promise<ConnectionRecord> {
  const binding = await provider.getPilotBinding();
  const [store] = await db
    .select({ id: shopifyStores.id, organizationId: shopifyStores.organizationId })
    .from(shopifyStores)
    .where(eq(shopifyStores.shopDomain, binding.shopDomain))
    .limit(1);
  if (!store) {
    throw new Error("Configured Google Ads shop domain has no Shopify store");
  }
  const existing = await getPilotGoogleAdsConnectionForOrganization(
    store.organizationId,
  );
  if (existing) return existing;
  const [created] = await db
    .insert(googleAdsConnections)
    .values({ organizationId: store.organizationId, storeId: store.id })
    .onConflictDoNothing({
      target: [googleAdsConnections.organizationId, googleAdsConnections.storeId],
    })
    .returning();
  if (created) return created;
  const raced = await getPilotGoogleAdsConnectionForOrganization(store.organizationId);
  if (!raced) throw new Error("Google Ads connection bootstrap raced and lost");
  return raced;
}

export async function getPilotGoogleAdsConnectionForOrganization(
  organizationId: string,
): Promise<ConnectionRecord | null> {
  const [connection] = await db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.organizationId, organizationId))
    .limit(1);
  return connection ?? null;
}

export function connectionScope(connection: ConnectionRecord): GoogleAdsScope {
  return {
    organizationId: connection.organizationId,
    storeId: connection.storeId,
    connectionId: connection.id,
  };
}

export async function createGoogleAdsSyncRun(params: {
  scope: GoogleAdsScope;
  operation: "discovery" | "facts";
  windowFromDay?: string;
  windowToDay?: string;
  apiVersion: string;
}): Promise<SyncRunRecord> {
  const [run] = await db
    .insert(googleAdsSyncRuns)
    .values({
      organizationId: params.scope.organizationId,
      storeId: params.scope.storeId,
      connectionId: params.scope.connectionId,
      operation: params.operation,
      windowFromDay: params.windowFromDay ?? null,
      windowToDay: params.windowToDay ?? null,
      apiVersion: params.apiVersion,
    })
    .returning();
  return run;
}

/** Loads a run plus its scope for a durable task; throws if the ID is unknown. */
export async function resolveGoogleAdsSyncRun(
  syncRunId: string,
): Promise<{ run: SyncRunRecord; scope: GoogleAdsScope }> {
  const [run] = await db
    .select()
    .from(googleAdsSyncRuns)
    .where(eq(googleAdsSyncRuns.id, syncRunId))
    .limit(1);
  if (!run) throw new Error("Google Ads sync run does not exist");
  return {
    run,
    scope: {
      organizationId: run.organizationId,
      storeId: run.storeId,
      connectionId: run.connectionId,
    },
  };
}

/**
 * One transaction per chunk: upsert the chunk's facts, advance the
 * checkpoint, and bump counters. A retried chunk re-upserts harmlessly.
 */
export async function commitCampaignFactsChunk(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  facts: NormalizedCampaignFact[];
  checkpointDay: string;
  rowsRead: number;
  failureCount: number;
  apiVersion: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (params.facts.length > 0) {
      await tx
        .insert(googleAdsCampaignFacts)
        .values(
          params.facts.map((fact) => ({
            organizationId: params.scope.organizationId,
            storeId: params.scope.storeId,
            connectionId: params.scope.connectionId,
            campaignId: fact.campaignId,
            campaignName: fact.campaignName,
            campaignStatus: fact.campaignStatus,
            channelType: fact.channelType,
            factDate: fact.factDate,
            costMicros: fact.costMicros,
            impressions: fact.impressions,
            clicks: fact.clicks,
            conversions: fact.conversions,
            conversionsValue: fact.conversionsValue,
            apiVersion: params.apiVersion,
            fetchedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [
            googleAdsCampaignFacts.connectionId,
            googleAdsCampaignFacts.campaignId,
            googleAdsCampaignFacts.factDate,
          ],
          set: {
            campaignName: sqlExcluded("campaign_name"),
            campaignStatus: sqlExcluded("campaign_status"),
            channelType: sqlExcluded("channel_type"),
            costMicros: sqlExcluded("cost_micros"),
            impressions: sqlExcluded("impressions"),
            clicks: sqlExcluded("clicks"),
            conversions: sqlExcluded("conversions"),
            conversionsValue: sqlExcluded("conversions_value"),
            apiVersion: sqlExcluded("api_version"),
            fetchedAt: sqlExcluded("fetched_at"),
          },
        });
    }
    const [current] = await tx
      .select({
        rowsRead: googleAdsSyncRuns.rowsRead,
        rowsUpserted: googleAdsSyncRuns.rowsUpserted,
        failureCount: googleAdsSyncRuns.failureCount,
      })
      .from(googleAdsSyncRuns)
      .where(eq(googleAdsSyncRuns.id, params.syncRunId))
      .limit(1);
    if (!current) throw new Error("Google Ads sync run vanished mid-chunk");
    await tx
      .update(googleAdsSyncRuns)
      .set({
        checkpointDay: params.checkpointDay,
        rowsRead: current.rowsRead + params.rowsRead,
        rowsUpserted: current.rowsUpserted + params.facts.length,
        failureCount: current.failureCount + params.failureCount,
      })
      .where(eq(googleAdsSyncRuns.id, params.syncRunId));
  });
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

export async function completeGoogleAdsSyncRun(params: {
  scope: GoogleAdsScope;
  syncRunId: string;
  operation: "discovery" | "facts";
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(googleAdsSyncRuns)
      .set({ status: "completed", finishedAt: now })
      .where(
        and(
          eq(googleAdsSyncRuns.id, params.syncRunId),
          eq(googleAdsSyncRuns.status, "running"),
        ),
      );
    if (params.operation === "facts") {
      const [connection] = await tx
        .select({ backfillCompletedAt: googleAdsConnections.backfillCompletedAt })
        .from(googleAdsConnections)
        .where(eq(googleAdsConnections.id, params.scope.connectionId))
        .limit(1);
      await tx
        .update(googleAdsConnections)
        .set({
          lastFactsSyncedAt: now,
          // The first completed facts run IS the backfill: incremental runs
          // are only scheduled once this stamp exists.
          backfillCompletedAt: connection?.backfillCompletedAt ?? now,
        })
        .where(eq(googleAdsConnections.id, params.scope.connectionId));
    }
  });
}

export async function failGoogleAdsSyncRun(params: {
  syncRunId: string;
  error: SanitizedSyncError;
}): Promise<void> {
  await db
    .update(googleAdsSyncRuns)
    .set({
      status: "failed",
      errorCode: params.error.code,
      errorMessage: params.error.message,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(googleAdsSyncRuns.id, params.syncRunId),
        eq(googleAdsSyncRuns.status, "running"),
      ),
    );
}

export async function listGoogleAdsSyncRuns(
  connectionId: string,
  limit = 20,
): Promise<SyncRunRecord[]> {
  return db
    .select()
    .from(googleAdsSyncRuns)
    .where(eq(googleAdsSyncRuns.connectionId, connectionId))
    .orderBy(desc(googleAdsSyncRuns.startedAt))
    .limit(limit);
}
```

- [ ] **Step 2: Write the integration test**

`src/lib/google-ads/sync-store.integration.test.ts` — copy the ephemeral-database setup block (the `resolveConnectionString` / `withDatabase` helpers, pool creation, migration application, and `beforeAll`/`afterAll` wiring, plus the org/store seeding helpers) from `src/lib/klaviyo/dimension-repository.integration.test.ts`, adjusting names. Then add:

```ts
import {
  commitCampaignFactsChunk,
  completeGoogleAdsSyncRun,
  createGoogleAdsSyncRun,
  ensurePilotGoogleAdsConnection,
  failGoogleAdsSyncRun,
  resolveGoogleAdsSyncRun,
} from "@/lib/google-ads/sync-store";
import type { GoogleAdsCredentialProvider } from "@/lib/google-ads/credential-provider";

// In the seeded fixture: one organization + one shopify store whose
// shopDomain matches the fake provider binding below.
function fakeProvider(shopDomain: string): GoogleAdsCredentialProvider {
  return {
    getPilotBinding: async () => ({
      customerId: "1234567890",
      loginCustomerId: "0987654321",
      shopDomain,
    }),
    resolve: async () => {
      throw new Error("not needed");
    },
  };
}

describe("google ads sync store", () => {
  it("bootstraps one pending connection idempotently", async () => {
    const first = await ensurePilotGoogleAdsConnection(fakeProvider(SEEDED_SHOP_DOMAIN));
    const second = await ensurePilotGoogleAdsConnection(fakeProvider(SEEDED_SHOP_DOMAIN));
    expect(first.id).toBe(second.id);
    expect(first.status).toBe("pending");
  });

  it("commits a facts chunk atomically and restates on re-upsert", async () => {
    const connection = await ensurePilotGoogleAdsConnection(fakeProvider(SEEDED_SHOP_DOMAIN));
    const run = await createGoogleAdsSyncRun({
      scope: connectionScopeOf(connection),
      operation: "facts",
      windowFromDay: "2026-08-01",
      windowToDay: "2026-08-14",
      apiVersion: "v21",
    });
    const fact = {
      campaignId: "222",
      campaignName: "Brand",
      campaignStatus: "ENABLED",
      channelType: "SEARCH",
      factDate: "2026-08-01",
      costMicros: 1000,
      impressions: 10,
      clicks: 1,
      conversions: "1",
      conversionsValue: "100",
    };
    await commitCampaignFactsChunk({
      scope: connectionScopeOf(connection),
      syncRunId: run.id,
      facts: [fact],
      checkpointDay: "2026-08-01",
      rowsRead: 1,
      failureCount: 0,
      apiVersion: "v21",
    });
    // Restatement: same key, new conversion value replaces in place.
    await commitCampaignFactsChunk({
      scope: connectionScopeOf(connection),
      syncRunId: run.id,
      facts: [{ ...fact, conversionsValue: "150" }],
      checkpointDay: "2026-08-01",
      rowsRead: 1,
      failureCount: 0,
      apiVersion: "v21",
    });
    const facts = await database
      .select()
      .from(googleAdsCampaignFacts)
      .where(eq(googleAdsCampaignFacts.connectionId, connection.id));
    expect(facts).toHaveLength(1);
    expect(facts[0].conversionsValue).toBe("150");
    const { run: reloaded } = await resolveGoogleAdsSyncRun(run.id);
    expect(reloaded.checkpointDay).toBe("2026-08-01");
    expect(reloaded.rowsRead).toBe(2);
  });

  it("stamps backfillCompletedAt only on the first completed facts run", async () => {
    const connection = await ensurePilotGoogleAdsConnection(fakeProvider(SEEDED_SHOP_DOMAIN));
    const scope = connectionScopeOf(connection);
    const first = await createGoogleAdsSyncRun({
      scope, operation: "facts",
      windowFromDay: "2026-08-01", windowToDay: "2026-08-02", apiVersion: "v21",
    });
    await completeGoogleAdsSyncRun({ scope, syncRunId: first.id, operation: "facts" });
    const afterFirst = await reloadConnection(connection.id);
    expect(afterFirst.backfillCompletedAt).not.toBeNull();
    const stamp = afterFirst.backfillCompletedAt;
    const second = await createGoogleAdsSyncRun({
      scope, operation: "facts",
      windowFromDay: "2026-08-02", windowToDay: "2026-08-03", apiVersion: "v21",
    });
    await completeGoogleAdsSyncRun({ scope, syncRunId: second.id, operation: "facts" });
    const afterSecond = await reloadConnection(connection.id);
    expect(afterSecond.backfillCompletedAt).toEqual(stamp);
  });

  it("marks a run failed with the sanitized error only", async () => {
    const connection = await ensurePilotGoogleAdsConnection(fakeProvider(SEEDED_SHOP_DOMAIN));
    const run = await createGoogleAdsSyncRun({
      scope: connectionScopeOf(connection),
      operation: "discovery",
      apiVersion: "v21",
    });
    await failGoogleAdsSyncRun({
      syncRunId: run.id,
      error: { code: "provider_rejected", message: "Google Ads search was rejected (HTTP 403)" },
    });
    const { run: reloaded } = await resolveGoogleAdsSyncRun(run.id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.errorCode).toBe("provider_rejected");
  });
});
```

`SEEDED_SHOP_DOMAIN`, `connectionScopeOf` (wraps `connectionScope`), `reloadConnection`, and `database` come from the copied harness/seed section — implement them there.

- [ ] **Step 3: Run**

Run: `bun run test src/lib/google-ads/sync-store.integration.test.ts`
Expected: PASS (requires the local `DATABASE_URL` like the existing Klaviyo integration suites; run one of those first if the harness misbehaves to confirm the environment, e.g. `bun run test src/lib/klaviyo/dimension-repository.integration.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/google-ads/sync-store.ts src/lib/google-ads/sync-store.integration.test.ts
git commit -m "feat: add Google Ads connection and sync-run store"
```

---

### Task 7: Discovery

**Files:**
- Create: `src/lib/google-ads/discovery.ts`
- Create: `src/lib/google-ads/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/google-ads/discovery.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { evaluateDiscoveryRow } from "@/lib/google-ads/discovery";

describe("evaluateDiscoveryRow", () => {
  const GOOD = {
    customer: {
      id: "1234567890",
      descriptiveName: "Reviv Ads",
      currencyCode: "USD",
      timeZone: "America/New_York",
      manager: false,
    },
  };

  it("accepts a matching non-manager customer", () => {
    const result = evaluateDiscoveryRow(GOOD, "1234567890");
    expect(result).toEqual({
      ok: true,
      customer: {
        googleCustomerId: "1234567890",
        descriptiveName: "Reviv Ads",
        currencyCode: "USD",
        timezone: "America/New_York",
      },
    });
  });

  it("rejects a manager account", () => {
    const result = evaluateDiscoveryRow(
      { customer: { ...GOOD.customer, manager: true } },
      "1234567890",
    );
    expect(result).toEqual({ ok: false, code: "manager_account" });
  });

  it("rejects a customer ID mismatch", () => {
    const result = evaluateDiscoveryRow(GOOD, "1111111111");
    expect(result).toEqual({ ok: false, code: "customer_mismatch" });
  });

  it("rejects a malformed row", () => {
    expect(evaluateDiscoveryRow({}, "1234567890")).toEqual({
      ok: false,
      code: "malformed_customer",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/google-ads/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/google-ads/discovery.ts`:

```ts
import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections } from "@/schema/google-ads";
import {
  GoogleAdsClient,
  GOOGLE_ADS_API_VERSION,
  GoogleAdsApiError,
} from "@/lib/google-ads/client";
import {
  EnvironmentGoogleAdsCredentialProvider,
  GOOGLE_ADS_CREDENTIAL_REFERENCE,
  type GoogleAdsCredentialProvider,
} from "@/lib/google-ads/credential-provider";
import { buildCustomerQuery } from "@/lib/google-ads/facts";
import {
  completeGoogleAdsSyncRun,
  failGoogleAdsSyncRun,
  resolveGoogleAdsSyncRun,
  type SanitizedSyncError,
} from "@/lib/google-ads/sync-store";

export type DiscoveredCustomer = {
  googleCustomerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timezone: string | null;
};

export type DiscoveryEvaluation =
  | { ok: true; customer: DiscoveredCustomer }
  | { ok: false; code: "malformed_customer" | "manager_account" | "customer_mismatch" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function evaluateDiscoveryRow(
  row: Record<string, unknown>,
  expectedCustomerId: string,
): DiscoveryEvaluation {
  const customer = isRecord(row.customer) ? row.customer : null;
  const rawId =
    customer && (typeof customer.id === "string" || typeof customer.id === "number")
      ? String(customer.id)
      : null;
  if (!customer || !rawId) return { ok: false, code: "malformed_customer" };
  if (customer.manager === true) return { ok: false, code: "manager_account" };
  if (rawId !== expectedCustomerId) return { ok: false, code: "customer_mismatch" };
  return {
    ok: true,
    customer: {
      googleCustomerId: rawId,
      descriptiveName:
        typeof customer.descriptiveName === "string" ? customer.descriptiveName : null,
      currencyCode:
        typeof customer.currencyCode === "string" ? customer.currencyCode : null,
      timezone: typeof customer.timeZone === "string" ? customer.timeZone : null,
    },
  };
}

export function sanitizeGoogleAdsError(error: unknown): SanitizedSyncError {
  if (error instanceof GoogleAdsApiError) {
    return {
      code: error.retryable ? "provider_unavailable" : "provider_rejected",
      message: error.message,
    };
  }
  return { code: "internal_error", message: "Google Ads sync failed unexpectedly" };
}

/**
 * Discovery: validate the configured customer account and mark the pilot
 * connection ready (or degraded on a deterministic mismatch). A retryable
 * provider failure escapes so the durable task retries it.
 */
export async function runGoogleAdsDiscovery(params: {
  syncRunId: string;
  provider?: GoogleAdsCredentialProvider;
  clientFactory?: (
    credential: Awaited<ReturnType<GoogleAdsCredentialProvider["resolve"]>>,
  ) => Pick<GoogleAdsClient, "search">;
}): Promise<{ status: "ready" | "degraded"; code?: string }> {
  const { run, scope } = await resolveGoogleAdsSyncRun(params.syncRunId);
  if (run.operation !== "discovery") {
    throw new Error("Google Ads discovery run has the wrong operation");
  }
  const provider = params.provider ?? new EnvironmentGoogleAdsCredentialProvider();
  const [connection] = await db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.id, scope.connectionId))
    .limit(1);
  if (!connection) throw new Error("Google Ads connection does not exist");

  const credential = await provider.resolve({
    credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
    persistedGoogleCustomerId: connection.googleCustomerId,
  });
  const client =
    params.clientFactory?.(credential) ?? new GoogleAdsClient({ credential });

  let evaluation: DiscoveryEvaluation;
  try {
    const page = await client.search({ query: buildCustomerQuery() });
    evaluation = page.results[0]
      ? evaluateDiscoveryRow(page.results[0], credential.customerId)
      : { ok: false, code: "malformed_customer" };
  } catch (error) {
    if (error instanceof GoogleAdsApiError && error.retryable) throw error;
    await failGoogleAdsSyncRun({
      syncRunId: params.syncRunId,
      error: sanitizeGoogleAdsError(error),
    });
    await db
      .update(googleAdsConnections)
      .set({ status: "degraded" })
      .where(eq(googleAdsConnections.id, scope.connectionId));
    return { status: "degraded", code: sanitizeGoogleAdsError(error).code };
  }

  if (!evaluation.ok) {
    await failGoogleAdsSyncRun({
      syncRunId: params.syncRunId,
      error: { code: evaluation.code, message: `Google Ads discovery rejected: ${evaluation.code}` },
    });
    await db
      .update(googleAdsConnections)
      .set({ status: "degraded" })
      .where(eq(googleAdsConnections.id, scope.connectionId));
    return { status: "degraded", code: evaluation.code };
  }

  await db
    .update(googleAdsConnections)
    .set({
      googleCustomerId: evaluation.customer.googleCustomerId,
      descriptiveName: evaluation.customer.descriptiveName,
      currencyCode: evaluation.customer.currencyCode,
      timezone: evaluation.customer.timezone,
      status: "ready",
      lastDiscoverySyncedAt: new Date(),
    })
    .where(eq(googleAdsConnections.id, scope.connectionId));
  await completeGoogleAdsSyncRun({
    scope,
    syncRunId: params.syncRunId,
    operation: "discovery",
  });
  return { status: "ready" };
}
```

- [ ] **Step 4: Run**

Run: `bun run test src/lib/google-ads/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-ads/discovery.ts src/lib/google-ads/discovery.test.ts
git commit -m "feat: add Google Ads discovery with fail-closed validation"
```

---

### Task 8: Facts runner (chunked batch engine)

**Files:**
- Create: `src/lib/google-ads/facts-runner.ts`
- Create: `src/lib/google-ads/facts-runner.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/google-ads/facts-runner.test.ts` (pure chunk math — the DB paths are covered by Task 6's integration tests and the runner delegates to those functions):

```ts
import { describe, expect, it } from "vitest";
import { nextChunk } from "@/lib/google-ads/facts-runner";

describe("nextChunk", () => {
  it("starts at the window start when there is no checkpoint", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-08-13", checkpointDay: null }),
    ).toEqual({ fromDay: "2026-05-01", toDay: "2026-05-14", done: false });
  });

  it("resumes after the checkpoint and clamps to the window end", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-05-20", checkpointDay: "2026-05-14" }),
    ).toEqual({ fromDay: "2026-05-15", toDay: "2026-05-20", done: true });
  });

  it("reports completion when the checkpoint reached the end", () => {
    expect(
      nextChunk({ windowFromDay: "2026-05-01", windowToDay: "2026-05-20", checkpointDay: "2026-05-20" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/google-ads/facts-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/google-ads/facts-runner.ts`:

```ts
import "server-only";

import {
  GoogleAdsClient,
  GOOGLE_ADS_API_VERSION,
  type GoogleAdsSearchPage,
} from "@/lib/google-ads/client";
import {
  EnvironmentGoogleAdsCredentialProvider,
  GOOGLE_ADS_CREDENTIAL_REFERENCE,
  type GoogleAdsCredentialProvider,
} from "@/lib/google-ads/credential-provider";
import {
  addDays,
  buildCampaignFactsQuery,
  normalizeCampaignFactRow,
  type NormalizedCampaignFact,
} from "@/lib/google-ads/facts";
import {
  commitCampaignFactsChunk,
  completeGoogleAdsSyncRun,
  createGoogleAdsSyncRun,
  getPilotGoogleAdsConnectionForOrganization,
  connectionScope,
  resolveGoogleAdsSyncRun,
  type SyncRunRecord,
} from "@/lib/google-ads/sync-store";

/** ≤14 account-days per batch invocation keeps each run far inside maxDuration. */
const CHUNK_DAYS = 14;

export type FactsChunk = { fromDay: string; toDay: string; done: boolean };

export function nextChunk(run: {
  windowFromDay: string;
  windowToDay: string;
  checkpointDay: string | null;
}): FactsChunk | null {
  const fromDay = run.checkpointDay
    ? addDays(run.checkpointDay, 1)
    : run.windowFromDay;
  if (fromDay > run.windowToDay) return null;
  const candidateTo = addDays(fromDay, CHUNK_DAYS - 1);
  const toDay = candidateTo < run.windowToDay ? candidateTo : run.windowToDay;
  return { fromDay, toDay, done: toDay === run.windowToDay };
}

/**
 * Creates a facts run for an inclusive account-day window. The caller
 * (tRPC mutation or nightly schedule) then triggers the batch task.
 */
export async function prepareGoogleAdsFactsRun(params: {
  organizationId: string;
  windowFromDay: string;
  windowToDay: string;
}): Promise<SyncRunRecord> {
  const connection = await getPilotGoogleAdsConnectionForOrganization(
    params.organizationId,
  );
  if (!connection) throw new Error("Google Ads pilot connection is not configured");
  if (connection.status !== "ready") {
    throw new Error("Google Ads connection is not ready; run discovery first");
  }
  return createGoogleAdsSyncRun({
    scope: connectionScope(connection),
    operation: "facts",
    windowFromDay: params.windowFromDay,
    windowToDay: params.windowToDay,
    apiVersion: GOOGLE_ADS_API_VERSION,
  });
}

/**
 * Processes ONE chunk (≤14 days, all its pages) and commits it atomically.
 * Returns done=false when the task should self-chain for the next chunk.
 */
export async function processGoogleAdsFactsBatch(params: {
  syncRunId: string;
  provider?: GoogleAdsCredentialProvider;
  clientFactory?: (
    credential: Awaited<ReturnType<GoogleAdsCredentialProvider["resolve"]>>,
  ) => Pick<GoogleAdsClient, "search">;
}): Promise<{ done: boolean; chunk: FactsChunk | null; rowsRead: number }> {
  const { run, scope } = await resolveGoogleAdsSyncRun(params.syncRunId);
  if (run.operation !== "facts" || !run.windowFromDay || !run.windowToDay) {
    throw new Error("Google Ads facts run is malformed");
  }
  if (run.status !== "running") {
    return { done: true, chunk: null, rowsRead: 0 };
  }
  const chunk = nextChunk({
    windowFromDay: run.windowFromDay,
    windowToDay: run.windowToDay,
    checkpointDay: run.checkpointDay,
  });
  if (!chunk) {
    await completeGoogleAdsSyncRun({ scope, syncRunId: run.id, operation: "facts" });
    return { done: true, chunk: null, rowsRead: 0 };
  }

  const provider = params.provider ?? new EnvironmentGoogleAdsCredentialProvider();
  const credential = await provider.resolve({
    credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
    persistedGoogleCustomerId: null,
  });
  const client =
    params.clientFactory?.(credential) ?? new GoogleAdsClient({ credential });

  const query = buildCampaignFactsQuery(chunk.fromDay, chunk.toDay);
  const facts: NormalizedCampaignFact[] = [];
  let rowsRead = 0;
  let failureCount = 0;
  let pageToken: string | null = null;
  do {
    const page: GoogleAdsSearchPage = await client.search({ query, pageToken });
    for (const row of page.results) {
      rowsRead += 1;
      const fact = normalizeCampaignFactRow(row);
      if (fact) facts.push(fact);
      else failureCount += 1;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await commitCampaignFactsChunk({
    scope,
    syncRunId: run.id,
    facts,
    checkpointDay: chunk.toDay,
    rowsRead,
    failureCount,
    apiVersion: GOOGLE_ADS_API_VERSION,
  });
  if (chunk.done) {
    await completeGoogleAdsSyncRun({ scope, syncRunId: run.id, operation: "facts" });
  }
  return { done: chunk.done, chunk, rowsRead };
}
```

- [ ] **Step 4: Run**

Run: `bun run test src/lib/google-ads/facts-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-ads/facts-runner.ts src/lib/google-ads/facts-runner.test.ts
git commit -m "feat: add chunked Google Ads facts batch runner"
```

---

### Task 9: Click-ID extractor

**Files:**
- Create: `src/lib/google-ads/click-id-extractor.ts`
- Create: `src/lib/google-ads/click-id-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/google-ads/click-id-extractor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractClickIdObservation } from "@/lib/google-ads/click-id-extractor";

function journey(landingPage: string | null, referrerUrl: string | null = null) {
  return { ready: true, lastVisit: { landingPage, referrerUrl } };
}

describe("extractClickIdObservation", () => {
  it("finds a gclid on the landing page", () => {
    const observation = extractClickIdObservation(
      journey("https://shop.example.com/products/x?utm_source=google&gclid=Cj0abc"),
    );
    expect(observation.kinds).toEqual(["gclid"]);
    expect(observation.journeyMissing).toBe(false);
    expect(observation.paramKeys).toContain("gclid");
    expect(observation.paramKeys).toContain("utm_source");
  });

  it("finds wbraid and gbraid and never returns values", () => {
    const observation = extractClickIdObservation(
      journey("https://shop.example.com/?wbraid=W1&gbraid=G1"),
    );
    expect(observation.kinds).toEqual(["gbraid", "wbraid"]);
    expect(JSON.stringify(observation)).not.toContain("W1");
  });

  it("checks the referrer when the landing page has none", () => {
    const observation = extractClickIdObservation(
      journey("https://shop.example.com/", "https://shop.example.com/?gclid=Cj0z"),
    );
    expect(observation.kinds).toEqual(["gclid"]);
  });

  it("falls back to query-string parsing for a relative landing page", () => {
    const observation = extractClickIdObservation(journey("/products/x?gclid=Cj0rel"));
    expect(observation.kinds).toEqual(["gclid"]);
    expect(observation.parseFailed).toBe(false);
  });

  it("reports a missing journey", () => {
    expect(extractClickIdObservation(null).journeyMissing).toBe(true);
    expect(extractClickIdObservation({}).journeyMissing).toBe(true);
    expect(extractClickIdObservation({ lastVisit: null }).journeyMissing).toBe(true);
  });

  it("treats an unparseable URL as a parse failure, not a crash", () => {
    const observation = extractClickIdObservation(journey("http://exa mple.com/%zz?"));
    expect(observation.parseFailed).toBe(true);
    expect(observation.kinds).toEqual([]);
  });

  it("ignores non-string URL fields", () => {
    const observation = extractClickIdObservation({
      lastVisit: { landingPage: 42, referrerUrl: {} },
    });
    expect(observation.journeyMissing).toBe(false);
    expect(observation.kinds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/lib/google-ads/click-id-extractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/google-ads/click-id-extractor.ts`:

```ts
import type { ClickIdKind } from "@/lib/google-ads/types";

export type ClickIdObservation = {
  /** Sorted, deduplicated kinds observed across landing page + referrer. */
  kinds: ClickIdKind[];
  /** customerJourney null / lastVisit absent — nothing to inspect. */
  journeyMissing: boolean;
  /** At least one URL string present but unparseable even via fallback. */
  parseFailed: boolean;
  /** Query parameter KEYS observed (never values), for shape fingerprinting. */
  paramKeys: string[];
};

const CLICK_ID_KINDS: readonly ClickIdKind[] = ["gclid", "wbraid", "gbraid"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract query param keys from an absolute or relative URL, values discarded. */
function queryKeys(url: string): string[] | null {
  try {
    return [...new URL(url).searchParams.keys()];
  } catch {
    // Relative or otherwise non-absolute: fall back to the raw query string.
    const queryStart = url.indexOf("?");
    if (queryStart < 0) return [];
    try {
      return [...new URLSearchParams(url.slice(queryStart + 1)).keys()];
    } catch {
      return null;
    }
  }
}

/**
 * Inspects the stored Shopify journey (customerJourneySummary shape: last
 * visit only) entirely in memory. Returns key presence only — click-ID
 * values never leave this function.
 */
export function extractClickIdObservation(
  customerJourney: Record<string, unknown> | null,
): ClickIdObservation {
  const lastVisit =
    customerJourney && isRecord(customerJourney.lastVisit)
      ? customerJourney.lastVisit
      : null;
  if (!lastVisit) {
    return { kinds: [], journeyMissing: true, parseFailed: false, paramKeys: [] };
  }

  const urls = [lastVisit.landingPage, lastVisit.referrerUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const keys = new Set<string>();
  let parseFailed = false;
  for (const url of urls) {
    const extracted = queryKeys(url);
    if (extracted === null) {
      parseFailed = true;
      continue;
    }
    for (const key of extracted) keys.add(key.toLowerCase());
  }

  const kinds = CLICK_ID_KINDS.filter((kind) => keys.has(kind)).sort();
  return {
    kinds,
    journeyMissing: false,
    parseFailed,
    paramKeys: [...keys].sort(),
  };
}
```

- [ ] **Step 4: Run**

Run: `bun run test src/lib/google-ads/click-id-extractor.test.ts`
Expected: PASS. Note the wbraid/gbraid test expects `["gbraid", "wbraid"]` because kinds are sorted alphabetically.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-ads/click-id-extractor.ts src/lib/google-ads/click-id-extractor.test.ts
git commit -m "feat: add in-memory click-ID extractor for stored journeys"
```

---

### Task 10: gclid probe (scan, tally, durable report)

**Files:**
- Create: `src/lib/google-ads/gclid-probe.ts`
- Create: `src/lib/google-ads/gclid-probe.integration.test.ts`

- [ ] **Step 1: Implement the probe**

`src/lib/google-ads/gclid-probe.ts`:

```ts
import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { gclidProbeReports } from "@/schema/google-ads";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";
import { extractClickIdObservation } from "@/lib/google-ads/click-id-extractor";
import {
  EnvironmentGoogleAdsCredentialProvider,
  type GoogleAdsCredentialProvider,
} from "@/lib/google-ads/credential-provider";
import { addDays } from "@/lib/google-ads/facts";
import type {
  ClickIdKind,
  GclidProbeParamFingerprint,
  GclidProbeSummary,
} from "@/lib/google-ads/types";

const SCAN_BATCH_SIZE = 500;
const PROBE_WINDOW_DAYS = 90;
const MAX_FINGERPRINT_KEYS = 50;
/** Keys that may appear literally in the fingerprint; everything else is hashed. */
const FINGERPRINT_KEY_ALLOWLIST = new Set([
  "gclid", "wbraid", "gbraid", "gad_source", "srsltid",
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id",
  "fbclid", "msclkid", "ttclid", "irclickid",
]);

export type ProbeReportRecord = typeof gclidProbeReports.$inferSelect;

/**
 * Creates the durable running report row for the trailing 90 store-days.
 * Store scope resolves server-side from the environment shop-domain binding.
 */
export async function prepareGclidProbeRun(
  provider: GoogleAdsCredentialProvider = new EnvironmentGoogleAdsCredentialProvider(),
  now: Date = new Date(),
): Promise<ProbeReportRecord> {
  const binding = await provider.getPilotBinding();
  const [store] = await db
    .select({ id: shopifyStores.id, organizationId: shopifyStores.organizationId })
    .from(shopifyStores)
    .where(eq(shopifyStores.shopDomain, binding.shopDomain))
    .limit(1);
  if (!store) throw new Error("Configured Google Ads shop domain has no Shopify store");
  const toDay = now.toISOString().slice(0, 10);
  const fromDay = addDays(toDay, -(PROBE_WINDOW_DAYS - 1));
  const [report] = await db
    .insert(gclidProbeReports)
    .values({
      organizationId: store.organizationId,
      storeId: store.id,
      windowFromDay: fromDay,
      windowToDay: toDay,
    })
    .returning();
  return report;
}

export async function failGclidProbeReport(params: {
  probeReportId: string;
  code: string;
  message: string;
}): Promise<void> {
  await db
    .update(gclidProbeReports)
    .set({
      status: "failed",
      errorCode: params.code,
      errorMessage: params.message,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(gclidProbeReports.id, params.probeReportId),
        eq(gclidProbeReports.status, "running"),
      ),
    );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintKey(key: string): { key: string; hashed: boolean } {
  if (FINGERPRINT_KEY_ALLOWLIST.has(key)) return { key, hashed: false };
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return { key: `sha256:${digest}`, hashed: true };
}

/** Scans the report's window and publishes the aggregate summary. */
export async function runGclidProbe(params: {
  probeReportId: string;
}): Promise<GclidProbeSummary> {
  const [report] = await db
    .select()
    .from(gclidProbeReports)
    .where(eq(gclidProbeReports.id, params.probeReportId))
    .limit(1);
  if (!report) throw new Error("gclid probe report does not exist");
  if (report.status !== "running") {
    throw new Error("gclid probe report is not running");
  }

  const byKind: Record<ClickIdKind, number> = { gclid: 0, wbraid: 0, gbraid: 0 };
  const byBucket = new Map<string, { orders: number; withClickId: number }>();
  const keyCounts = new Map<string, number>();
  let ordersScanned = 0;
  let ordersWithAnyClickId = 0;
  let journeyMissing = 0;
  let parseFailures = 0;
  let multiKindOrders = 0;

  let cursor: string | null = null;
  for (;;) {
    const batch: Array<{
      id: string;
      bucket: string | null;
      customerJourney: Record<string, unknown> | null;
    }> = await db
      .select({
        id: shopifyOrders.id,
        bucket: shopifyOrders.bucket,
        customerJourney: shopifyOrders.customerJourney,
      })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, report.organizationId),
          eq(shopifyOrders.storeId, report.storeId),
          gte(shopifyOrders.orderDay, report.windowFromDay),
          lte(shopifyOrders.orderDay, report.windowToDay),
          cursor ? gt(shopifyOrders.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(shopifyOrders.id))
      .limit(SCAN_BATCH_SIZE);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const order of batch) {
      ordersScanned += 1;
      const observation = extractClickIdObservation(order.customerJourney);
      const bucket = order.bucket ?? "pending";
      const cell = byBucket.get(bucket) ?? { orders: 0, withClickId: 0 };
      cell.orders += 1;
      if (observation.journeyMissing) journeyMissing += 1;
      if (observation.parseFailed) parseFailures += 1;
      if (observation.kinds.length > 0) {
        ordersWithAnyClickId += 1;
        cell.withClickId += 1;
        for (const kind of observation.kinds) byKind[kind] += 1;
        if (observation.kinds.length > 1) multiKindOrders += 1;
      }
      byBucket.set(bucket, cell);
      for (const key of observation.paramKeys) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const paramKeyFingerprints: GclidProbeParamFingerprint[] = [...keyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FINGERPRINT_KEYS)
    .map(([key, count]) => ({ ...fingerprintKey(key), count }));

  const summary: GclidProbeSummary = {
    ordersScanned,
    ordersWithAnyClickId,
    byKind,
    byBucket: Object.fromEntries(byBucket),
    journeyMissing,
    parseFailures,
    multiKindOrders,
    paramKeyFingerprints,
  };
  const checksum = createHash("sha256").update(canonicalJson(summary)).digest("hex");

  await db
    .update(gclidProbeReports)
    .set({
      status: "completed",
      ordersScanned,
      summary,
      checksum,
      finishedAt: new Date(),
    })
    .where(eq(gclidProbeReports.id, params.probeReportId));
  return summary;
}
```

- [ ] **Step 2: Write the integration test**

`src/lib/google-ads/gclid-probe.integration.test.ts` — same copied harness as Task 6. Seed one org/store and four orders inside the window (set `orderDay` inside the trailing 90 days, `netSales: "10"`, required timestamps):

1. `bucket: "google"`, journey `{ ready: true, lastVisit: { landingPage: "https://shop.example.com/?gclid=abc123" } }`
2. `bucket: "google"`, journey `{ ready: true, lastVisit: { landingPage: "https://shop.example.com/" } }`
3. `bucket: "organic"`, journey `{ ready: true, lastVisit: { landingPage: "https://shop.example.com/?wbraid=w1&gbraid=g1" } }`
4. `bucket: null`, journey `null`

Test body:

```ts
describe("gclid probe", () => {
  it("tallies the bucket matrix and publishes an immutable summary", async () => {
    const report = await prepareGclidProbeRun(fakeProvider(SEEDED_SHOP_DOMAIN), FIXED_NOW);
    const summary = await runGclidProbe({ probeReportId: report.id });

    expect(summary.ordersScanned).toBe(4);
    expect(summary.ordersWithAnyClickId).toBe(2);
    expect(summary.byKind).toEqual({ gclid: 1, wbraid: 1, gbraid: 1 });
    expect(summary.byBucket.google).toEqual({ orders: 2, withClickId: 1 });
    expect(summary.byBucket.organic).toEqual({ orders: 1, withClickId: 1 });
    expect(summary.byBucket.pending).toEqual({ orders: 1, withClickId: 0 });
    expect(summary.journeyMissing).toBe(1);
    expect(summary.multiKindOrders).toBe(1);
    // No raw click-ID values anywhere in the persisted report.
    const [persisted] = await database
      .select()
      .from(gclidProbeReports)
      .where(eq(gclidProbeReports.id, report.id));
    expect(persisted.status).toBe("completed");
    expect(persisted.checksum).toHaveLength(64);
    expect(JSON.stringify(persisted.summary)).not.toContain("abc123");
  });

  it("marks a report failed with a sanitized reason", async () => {
    const report = await prepareGclidProbeRun(fakeProvider(SEEDED_SHOP_DOMAIN), FIXED_NOW);
    await failGclidProbeReport({
      probeReportId: report.id,
      code: "internal_error",
      message: "probe failed unexpectedly",
    });
    const [persisted] = await database
      .select()
      .from(gclidProbeReports)
      .where(eq(gclidProbeReports.id, report.id));
    expect(persisted.status).toBe("failed");
  });
});
```

`fakeProvider` is the same helper shape as Task 6 (only `getPilotBinding` used). `FIXED_NOW` is a `new Date("...")` inside the seeded orders' window.

- [ ] **Step 3: Run**

Run: `bun run test src/lib/google-ads/gclid-probe.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/google-ads/gclid-probe.ts src/lib/google-ads/gclid-probe.integration.test.ts
git commit -m "feat: add gclid probe over stored Shopify journeys"
```

---

### Task 11: Trigger.dev tasks + nightly schedule

**Files:**
- Create: `trigger/google-ads-sync.ts`
- Create: `trigger/gclid-probe.ts`

No unit tests for the task wrappers (matching `trigger/klaviyo-source-sync.ts`, which is also glue-only); the engines they call are tested in Tasks 6–10. Verify with `bun run build` type-checking.

- [ ] **Step 1: Implement the sync tasks**

`trigger/google-ads-sync.ts`:

```ts
import { createHash } from "node:crypto";
import { idempotencyKeys, metadata, schedules, tags, task, tasks } from "@trigger.dev/sdk";
import { runGoogleAdsDiscovery, sanitizeGoogleAdsError } from "@/lib/google-ads/discovery";
import { GOOGLE_ADS_API_VERSION } from "@/lib/google-ads/client";
import { accountDay, addDays } from "@/lib/google-ads/facts";
import {
  prepareGoogleAdsFactsRun,
  processGoogleAdsFactsBatch,
} from "@/lib/google-ads/facts-runner";
import {
  failGoogleAdsSyncRun,
  getPilotGoogleAdsConnectionForOrganization,
  resolveGoogleAdsSyncRun,
} from "@/lib/google-ads/sync-store";
import { EnvironmentGoogleAdsCredentialProvider } from "@/lib/google-ads/credential-provider";
import { db } from "@/db";
import { googleAdsConnections } from "@/schema/google-ads";
import { isNotNull, and, eq } from "drizzle-orm";
import { KLAVIYO_TASK_RETRY } from "./retry";

const GOOGLE_ADS_QUEUE = { name: "google-ads-sync", concurrencyLimit: 1 };
/** Nightly incremental re-fetches this many trailing days so restated conversions converge. */
const INCREMENTAL_TRAILING_DAYS = 30;

type SyncRunPayload = { syncRunId: string };

function assertExactSyncRunPayload(
  value: unknown,
): asserts value is SyncRunPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.syncRunId !== "string" ||
    input.syncRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Google Ads task accepts only a sync run ID");
  }
}

function orgTag(organizationId: string) {
  return `google-ads:org:${organizationId}`;
}

async function finalizeExhaustedRun(value: unknown) {
  assertExactSyncRunPayload(value);
  await failGoogleAdsSyncRun({
    syncRunId: value.syncRunId,
    error: { code: "retry_exhausted", message: "Google Ads task retries were exhausted" },
  });
}

export const googleAdsDiscoveryTask = task({
  id: "google-ads-discovery",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: GOOGLE_ADS_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedRun(payload);
  },
  run: async (payload: SyncRunPayload) => {
    assertExactSyncRunPayload(payload);
    const { scope } = await resolveGoogleAdsSyncRun(payload.syncRunId);
    await tags.add(orgTag(scope.organizationId));
    metadata.set("status", "discovering");
    const result = await runGoogleAdsDiscovery({ syncRunId: payload.syncRunId });
    metadata.set("status", result.status);
    return result;
  },
});

export const googleAdsFactsBatchTask = task({
  id: "google-ads-facts-batch",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: GOOGLE_ADS_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedRun(payload);
  },
  run: async (payload: SyncRunPayload) => {
    assertExactSyncRunPayload(payload);
    const { scope } = await resolveGoogleAdsSyncRun(payload.syncRunId);
    await tags.add(orgTag(scope.organizationId));
    const result = await processGoogleAdsFactsBatch({ syncRunId: payload.syncRunId });
    metadata.set("rowsRead", result.rowsRead);
    if (!result.done) {
      const checkpoint = createHash("sha256")
        .update(JSON.stringify(result.chunk))
        .digest("hex");
      const idempotencyKey = await idempotencyKeys.create(
        `google-ads-facts:${payload.syncRunId}:${checkpoint}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof googleAdsFactsBatchTask>(
        "google-ads-facts-batch",
        { syncRunId: payload.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return result;
  },
});

/**
 * Nightly incremental: only connections whose backfill completed. Re-fetches
 * the trailing window ending yesterday in the ad account's timezone.
 */
export const googleAdsNightlySchedule = schedules.task({
  id: "google-ads-nightly",
  cron: "45 4 * * *",
  run: async () => {
    const connections = await db
      .select()
      .from(googleAdsConnections)
      .where(
        and(
          eq(googleAdsConnections.status, "ready"),
          isNotNull(googleAdsConnections.backfillCompletedAt),
        ),
      );
    for (const connection of connections) {
      const timezone = connection.timezone ?? "UTC";
      const yesterday = addDays(accountDay(new Date(), timezone), -1);
      const run = await prepareGoogleAdsFactsRun({
        organizationId: connection.organizationId,
        windowFromDay: addDays(yesterday, -(INCREMENTAL_TRAILING_DAYS - 1)),
        windowToDay: yesterday,
      });
      await tasks.trigger<typeof googleAdsFactsBatchTask>(
        "google-ads-facts-batch",
        { syncRunId: run.id },
      );
    }
    return { connectionsScheduled: connections.length };
  },
});

// Re-exported so the tRPC router can compute the same backfill window shape.
export { GOOGLE_ADS_API_VERSION, sanitizeGoogleAdsError };
export const _internal = { getPilotGoogleAdsConnectionForOrganization, EnvironmentGoogleAdsCredentialProvider };
```

Remove the final `_internal` export line and the re-export line if nothing ends up importing them in Task 12 — check before committing (the router imports from `@/lib/google-ads/*` directly, so these should NOT be needed; delete them).

- [ ] **Step 2: Implement the probe task**

`trigger/gclid-probe.ts`:

```ts
import { metadata, tags, task } from "@trigger.dev/sdk";
import {
  failGclidProbeReport,
  runGclidProbe,
} from "@/lib/google-ads/gclid-probe";
import { KLAVIYO_TASK_RETRY } from "./retry";

type ProbePayload = { probeReportId: string };

function assertExactProbePayload(value: unknown): asserts value is ProbePayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.probeReportId !== "string" ||
    input.probeReportId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("gclid probe task accepts only a probe report ID");
  }
}

export const gclidProbeTask = task({
  id: "gclid-probe",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: { name: "gclid-probe", concurrencyLimit: 1 },
  onFailure: async ({ payload }) => {
    assertExactProbePayload(payload);
    await failGclidProbeReport({
      probeReportId: payload.probeReportId,
      code: "retry_exhausted",
      message: "gclid probe retries were exhausted",
    });
  },
  run: async (payload: ProbePayload) => {
    assertExactProbePayload(payload);
    metadata.set("status", "scanning");
    const summary = await runGclidProbe({ probeReportId: payload.probeReportId });
    await tags.add(`gclid-probe:orders:${summary.ordersScanned}`);
    metadata.set("status", "completed");
    return {
      ordersScanned: summary.ordersScanned,
      ordersWithAnyClickId: summary.ordersWithAnyClickId,
    };
  },
});
```

Note: `KLAVIYO_TASK_RETRY` in `trigger/retry.ts` is the repo's shared durable-task retry config. If its name is Klaviyo-specific only by history, do NOT rename it in this task (that would touch Klaviyo call sites); reuse it as-is.

- [ ] **Step 3: Type-check**

Run: `bun run build`
Expected: compiles. (Trigger tasks are exercised end-to-end during sandbox bring-up, Task 15.)

- [ ] **Step 4: Commit**

```bash
git add trigger/google-ads-sync.ts trigger/gclid-probe.ts
git commit -m "feat: add Google Ads sync and gclid probe Trigger.dev tasks"
```

---

### Task 12: Lab queries + tRPC router

**Files:**
- Create: `src/lib/google-ads/queries.ts`
- Create: `src/lib/trpc/routers/google-ads.ts`
- Modify: `src/lib/trpc/routers/_app.ts` (compose `googleAds`)
- Create: `src/lib/trpc/routers/google-ads.test.ts`

- [ ] **Step 1: Implement queries**

`src/lib/google-ads/queries.ts`:

```ts
import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gclidProbeReports, googleAdsCampaignFacts } from "@/schema/google-ads";
import { shopifyOrders } from "@/schema/shopify";

export type CampaignFactsSummaryRow = {
  campaignId: string;
  campaignName: string;
  channelType: string | null;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionsValue: number;
};

/** Aggregates stored facts per campaign over an inclusive account-day range. */
export async function listCampaignFactsSummary(params: {
  connectionId: string;
  fromDay: string;
  toDay: string;
}): Promise<CampaignFactsSummaryRow[]> {
  const rows = await db
    .select({
      campaignId: googleAdsCampaignFacts.campaignId,
      campaignName: sql<string>`max(${googleAdsCampaignFacts.campaignName})`,
      channelType: sql<string | null>`max(${googleAdsCampaignFacts.channelType})`,
      costMicros: sql<string>`coalesce(sum(${googleAdsCampaignFacts.costMicros}), 0)`,
      impressions: sql<string>`coalesce(sum(${googleAdsCampaignFacts.impressions}), 0)`,
      clicks: sql<string>`coalesce(sum(${googleAdsCampaignFacts.clicks}), 0)`,
      conversions: sql<string>`coalesce(sum(${googleAdsCampaignFacts.conversions}), 0)`,
      conversionsValue: sql<string>`coalesce(sum(${googleAdsCampaignFacts.conversionsValue}), 0)`,
    })
    .from(googleAdsCampaignFacts)
    .where(
      and(
        eq(googleAdsCampaignFacts.connectionId, params.connectionId),
        gte(googleAdsCampaignFacts.factDate, params.fromDay),
        lte(googleAdsCampaignFacts.factDate, params.toDay),
      ),
    )
    .groupBy(googleAdsCampaignFacts.campaignId)
    .orderBy(sql`sum(${googleAdsCampaignFacts.costMicros}) desc`);
  return rows.map((row) => ({
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    channelType: row.channelType,
    costMicros: Number(row.costMicros),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    conversions: Number(row.conversions),
    conversionsValue: Number(row.conversionsValue),
  }));
}

/**
 * The captioned reference beside the "Google says" table: our google-bucket
 * Shopify Net sales over the same inclusive store-day range. Different
 * measurement system — the lab labels it as non-reconciling context.
 */
export async function getGoogleBucketNetSales(params: {
  organizationId: string;
  storeId: string;
  fromDay: string;
  toDay: string;
}): Promise<{ netSales: number; orderCount: number }> {
  const [row] = await db
    .select({
      netSales: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      orderCount: sql<string>`count(*)`,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, params.organizationId),
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.bucket, "google"),
        gte(shopifyOrders.orderDay, params.fromDay),
        lte(shopifyOrders.orderDay, params.toDay),
      ),
    );
  return { netSales: Number(row.netSales), orderCount: Number(row.orderCount) };
}

export async function getLatestGclidProbeReport(params: {
  organizationId: string;
  storeId: string;
}) {
  const [report] = await db
    .select()
    .from(gclidProbeReports)
    .where(
      and(
        eq(gclidProbeReports.organizationId, params.organizationId),
        eq(gclidProbeReports.storeId, params.storeId),
      ),
    )
    .orderBy(desc(gclidProbeReports.createdAt))
    .limit(1);
  return report ?? null;
}
```

- [ ] **Step 2: Implement the router**

`src/lib/trpc/routers/google-ads.ts`:

```ts
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { tasks } from "@trigger.dev/sdk";
import { router, orgAdminProcedure } from "../init";
import { GOOGLE_ADS_API_VERSION } from "@/lib/google-ads/client";
import { accountDay, addDays } from "@/lib/google-ads/facts";
import { prepareGoogleAdsFactsRun } from "@/lib/google-ads/facts-runner";
import { prepareGclidProbeRun } from "@/lib/google-ads/gclid-probe";
import {
  getGoogleBucketNetSales,
  getLatestGclidProbeReport,
  listCampaignFactsSummary,
} from "@/lib/google-ads/queries";
import {
  connectionScope,
  createGoogleAdsSyncRun,
  ensurePilotGoogleAdsConnection,
  getPilotGoogleAdsConnectionForOrganization,
  listGoogleAdsSyncRuns,
  type ConnectionRecord,
} from "@/lib/google-ads/sync-store";

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const BACKFILL_DAYS = 90;

async function requirePilotConnection(
  organizationId: string,
): Promise<ConnectionRecord> {
  const connection = await getPilotGoogleAdsConnectionForOrganization(organizationId);
  if (!connection) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Google Ads pilot connection is not configured",
    });
  }
  return connection;
}

export const googleAdsRouter = router({
  health: orgAdminProcedure.query(async ({ ctx }) => {
    const connection = await getPilotGoogleAdsConnectionForOrganization(
      ctx.organizationId,
    );
    if (!connection) return { connection: null, syncRuns: [] };
    const syncRuns = await listGoogleAdsSyncRuns(connection.id);
    return {
      connection: {
        id: connection.id,
        status: connection.status,
        googleCustomerId: connection.googleCustomerId,
        descriptiveName: connection.descriptiveName,
        currencyCode: connection.currencyCode,
        timezone: connection.timezone,
        lastDiscoverySyncedAt: connection.lastDiscoverySyncedAt,
        lastFactsSyncedAt: connection.lastFactsSyncedAt,
        backfillCompletedAt: connection.backfillCompletedAt,
      },
      syncRuns,
    };
  }),

  probeReport: orgAdminProcedure.query(async ({ ctx }) => {
    const connection = await getPilotGoogleAdsConnectionForOrganization(
      ctx.organizationId,
    );
    if (!connection) return null;
    return getLatestGclidProbeReport({
      organizationId: connection.organizationId,
      storeId: connection.storeId,
    });
  }),

  campaignFacts: orgAdminProcedure
    .input(z.object({ fromDay: daySchema, toDay: daySchema }))
    .query(async ({ input, ctx }) => {
      if (input.fromDay > input.toDay) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid day range" });
      }
      const connection = await requirePilotConnection(ctx.organizationId);
      const [campaigns, reference] = await Promise.all([
        listCampaignFactsSummary({
          connectionId: connection.id,
          fromDay: input.fromDay,
          toDay: input.toDay,
        }),
        getGoogleBucketNetSales({
          organizationId: connection.organizationId,
          storeId: connection.storeId,
          fromDay: input.fromDay,
          toDay: input.toDay,
        }),
      ]);
      return { campaigns, googleBucketReference: reference, currencyCode: connection.currencyCode };
    }),

  startDiscovery: orgAdminProcedure.mutation(async ({ ctx }) => {
    // Bootstrap resolves the store server-side from the environment binding;
    // reject a session organization that does not own that store.
    const connection = await ensurePilotGoogleAdsConnection();
    if (connection.organizationId !== ctx.organizationId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Google Ads pilot is configured for a different organization",
      });
    }
    const run = await createGoogleAdsSyncRun({
      scope: connectionScope(connection),
      operation: "discovery",
      apiVersion: GOOGLE_ADS_API_VERSION,
    });
    await tasks.trigger("google-ads-discovery", { syncRunId: run.id });
    return { syncRunId: run.id };
  }),

  startFactsSync: orgAdminProcedure.mutation(async ({ ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    const timezone = connection.timezone ?? "UTC";
    const yesterday = addDays(accountDay(new Date(), timezone), -1);
    const run = await prepareGoogleAdsFactsRun({
      organizationId: ctx.organizationId,
      windowFromDay: addDays(yesterday, -(BACKFILL_DAYS - 1)),
      windowToDay: yesterday,
    });
    await tasks.trigger("google-ads-facts-batch", { syncRunId: run.id });
    return { syncRunId: run.id };
  }),

  runProbe: orgAdminProcedure.mutation(async ({ ctx }) => {
    const report = await prepareGclidProbeRun();
    if (report.organizationId !== ctx.organizationId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Google Ads pilot is configured for a different organization",
      });
    }
    await tasks.trigger("gclid-probe", { probeReportId: report.id });
    return { probeReportId: report.id };
  }),
});
```

Note: `runProbe`'s forbidden path leaves an orphaned running report row for the *configured* store; that store's own admins still see it. Acceptable for the pilot (mirrors the fail-closed shape used elsewhere) — do not add cross-org cleanup logic.

Check how `ctx.organizationId` is exposed by `orgAdminProcedure` — open `src/lib/trpc/init.ts` and mirror whatever context field the Klaviyo router uses (it may be `ctx.organization.id` or similar; `src/lib/trpc/routers/klaviyo.ts` line ~108 is the reference). Adjust the property name accordingly everywhere in this file.

- [ ] **Step 3: Compose the router**

In `src/lib/trpc/routers/_app.ts`, add the import and entry exactly as `klaviyoRouter` is wired:

```ts
import { googleAdsRouter } from "./google-ads";
// inside the appRouter router({ ... }) map:
  googleAds: googleAdsRouter,
```

- [ ] **Step 4: Router test**

`src/lib/trpc/routers/google-ads.test.ts` — mirror the structure of `src/lib/trpc/routers/klaviyo.test.ts` (same caller/mocking conventions; read it first). Cover at minimum:

- `campaignFacts` rejects `fromDay > toDay` with BAD_REQUEST.
- `health` returns `{ connection: null, syncRuns: [] }` when unconfigured.
- `startDiscovery` throws FORBIDDEN when the bootstrap connection belongs to a different organization (mock `ensurePilotGoogleAdsConnection`).

- [ ] **Step 5: Run**

Run: `bun run test src/lib/trpc/routers/google-ads.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/google-ads/queries.ts src/lib/trpc/routers/google-ads.ts src/lib/trpc/routers/_app.ts src/lib/trpc/routers/google-ads.test.ts
git commit -m "feat: add googleAds tRPC router and lab queries"
```

---

### Task 13: Lab page UI

**Files:**
- Create: `src/components/blocks/attribution/privileged-access-gate.tsx`
- Modify: `src/components/blocks/attribution/klaviyo/klaviyo-access-gate.tsx` (re-export)
- Create: `src/components/blocks/attribution/google-ads/lab-link.tsx`
- Create: `src/components/blocks/attribution/google-ads/lab-link.component.test.tsx`
- Create: `src/components/blocks/attribution/google-ads/google-ads-lab.tsx`
- Create: `src/app/(protected)/attribution/google-ads/page.tsx`
- Modify: `src/app/(protected)/attribution/page.tsx` (~line 315: add `<GoogleAdsLabLink role={role} />`)

- [ ] **Step 1: Extract the shared gate**

`src/components/blocks/attribution/privileged-access-gate.tsx` — move the body of `klaviyo-access-gate.tsx` here verbatim, renaming the export to `PrivilegedAccessGate` (keep the `"use client"` directive and the doc comment). Then replace the entire contents of `src/components/blocks/attribution/klaviyo/klaviyo-access-gate.tsx` with:

```tsx
export { PrivilegedAccessGate as KlaviyoAccessGate } from "../privileged-access-gate";
```

Run: `bun run test:components`
Expected: existing Klaviyo component tests still pass.

- [ ] **Step 2: Lab link + component test**

`src/components/blocks/attribution/google-ads/lab-link.tsx` (same shape as the Klaviyo lab link; `Search` is already the google bucket icon in `src/components/blocks/attribution/buckets.ts`):

```tsx
"use client";

import Link from "next/link";
import { Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { isPrivilegedOrgRole } from "@/lib/organization-access";

/**
 * Privileged navigation only: hiding the link is UX, while every
 * `orgAdminProcedure` remains the security boundary for data and actions.
 */
export function GoogleAdsLabLink({ role }: { role: string | null }) {
  if (
    !isPrivilegedOrgRole(role as Parameters<typeof isPrivilegedOrgRole>[0])
  ) {
    return null;
  }
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/attribution/google-ads">
        <Search className="size-4" />
        Google Ads Lab
      </Link>
    </Button>
  );
}
```

`src/components/blocks/attribution/google-ads/lab-link.component.test.tsx` — copy `src/components/blocks/attribution/klaviyo/lab-link.component.test.tsx` and adjust: link name `"Google Ads Lab"`, href `/attribution/google-ads`, component `GoogleAdsLabLink`.

Run: `bun run test:components`
Expected: PASS including the new test.

- [ ] **Step 3: Lab component**

`src/components/blocks/attribution/google-ads/google-ads-lab.tsx`:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { useTRPC } from "@/lib/trpc/client";

const RANGES = [7, 30, 90] as const;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMoney(value: number, currency: string | null): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function GoogleAdsLab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [rangeDays, setRangeDays] = useState<(typeof RANGES)[number]>(30);
  const toDay = isoDay(new Date());
  const fromDay = isoDay(new Date(Date.now() - (rangeDays - 1) * 86_400_000));

  const health = useQuery(trpc.googleAds.health.queryOptions());
  const probe = useQuery(trpc.googleAds.probeReport.queryOptions());
  const facts = useQuery(
    trpc.googleAds.campaignFacts.queryOptions(
      { fromDay, toDay },
      { enabled: health.data?.connection != null },
    ),
  );

  const invalidateAll = () => queryClient.invalidateQueries();
  const mutationOptions = {
    onSuccess: () => {
      toast.success("Queued");
      void invalidateAll();
    },
    onError: (error: unknown) => toast.error(getUserFacingErrorMessage(error)),
  };
  const startDiscovery = useMutation(
    trpc.googleAds.startDiscovery.mutationOptions(mutationOptions),
  );
  const startFactsSync = useMutation(
    trpc.googleAds.startFactsSync.mutationOptions(mutationOptions),
  );
  const runProbe = useMutation(trpc.googleAds.runProbe.mutationOptions(mutationOptions));

  const connection = health.data?.connection ?? null;
  const summary = probe.data?.status === "completed" ? probe.data.summary : null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="ghost">
            <Link href="/attribution">
              <ArrowLeft className="size-4" />
              Attribution
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Google Ads Lab</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={runProbe.isPending}
            onClick={() => runProbe.mutate()}
          >
            Run gclid probe
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={startDiscovery.isPending}
            onClick={() => startDiscovery.mutate()}
          >
            Run discovery
          </Button>
          <Button
            size="sm"
            disabled={startFactsSync.isPending || connection?.status !== "ready"}
            onClick={() => startFactsSync.mutate()}
          >
            Sync facts
          </Button>
        </div>
      </div>

      <section className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 font-medium">Connection</h2>
        {connection ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{connection.status}</dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd>
              {connection.descriptiveName ?? "—"} ({connection.googleCustomerId ?? "—"})
            </dd>
            <dt className="text-muted-foreground">Timezone / currency</dt>
            <dd>
              {connection.timezone ?? "—"} · {connection.currencyCode ?? "—"}
            </dd>
            <dt className="text-muted-foreground">Last facts sync</dt>
            <dd>
              {connection.lastFactsSyncedAt
                ? new Date(connection.lastFactsSyncedAt).toLocaleString()
                : "never"}
            </dd>
          </dl>
        ) : (
          <p className="text-muted-foreground">
            No connection yet — run discovery once the environment credentials are set.
          </p>
        )}
      </section>

      <section className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 font-medium">gclid probe</h2>
        {summary ? (
          <div className="space-y-3">
            <p>
              {summary.ordersWithAnyClickId} of {summary.ordersScanned} orders carry a
              Google click ID · {summary.journeyMissing} without a stored journey ·{" "}
              {summary.multiKindOrders} with multiple kinds
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-4">Bucket</th>
                    <th className="py-1 pr-4">Orders</th>
                    <th className="py-1 pr-4">With click ID</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.byBucket).map(([bucket, cell]) => (
                    <tr key={bucket} className="border-t">
                      <td className="py-1 pr-4">{bucket}</td>
                      <td className="py-1 pr-4">{cell.orders}</td>
                      <td className="py-1 pr-4">{cell.withClickId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">
            {probe.data?.status === "running"
              ? "Probe running…"
              : probe.data?.status === "failed"
                ? `Probe failed: ${probe.data.errorCode ?? "unknown"}`
                : "No probe report yet."}
          </p>
        )}
      </section>

      <section className="rounded-lg border p-4 text-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Google says · campaigns</h2>
          <div className="flex gap-1">
            {RANGES.map((days) => (
              <Button
                key={days}
                size="sm"
                variant={rangeDays === days ? "default" : "ghost"}
                onClick={() => setRangeDays(days)}
              >
                {days}d
              </Button>
            ))}
          </div>
        </div>
        {facts.data ? (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-4">Campaign</th>
                    <th className="py-1 pr-4">Spend</th>
                    <th className="py-1 pr-4">Impr.</th>
                    <th className="py-1 pr-4">Clicks</th>
                    <th className="py-1 pr-4">Conv.</th>
                    <th className="py-1 pr-4">Conv. value</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.data.campaigns.map((campaign) => (
                    <tr key={campaign.campaignId} className="border-t">
                      <td className="py-1 pr-4">{campaign.campaignName}</td>
                      <td className="py-1 pr-4">
                        {formatMoney(campaign.costMicros / 1_000_000, facts.data.currencyCode)}
                      </td>
                      <td className="py-1 pr-4">{campaign.impressions.toLocaleString()}</td>
                      <td className="py-1 pr-4">{campaign.clicks.toLocaleString()}</td>
                      <td className="py-1 pr-4">{campaign.conversions.toLocaleString()}</td>
                      <td className="py-1 pr-4">
                        {formatMoney(campaign.conversionsValue, facts.data.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground">
              Reference: our google-bucket Shopify Net sales for the same range is{" "}
              {formatMoney(facts.data.googleBucketReference.netSales, null)} across{" "}
              {facts.data.googleBucketReference.orderCount} orders. Different measurement
              systems — these numbers are not expected to reconcile.
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">
            {connection ? "No facts yet — run a sync." : "Connect first."}
          </p>
        )}
      </section>
    </div>
  );
}
```

If `getUserFacingErrorMessage` or the `queryOptions`/`mutationOptions` pattern differs from what `klaviyo-playground.tsx` actually uses, mirror the playground exactly — it is the canonical example of this app's tRPC + TanStack Query wiring.

- [ ] **Step 4: Route + header link**

`src/app/(protected)/attribution/google-ads/page.tsx`:

```tsx
import { PrivilegedAccessGate } from "@/components/blocks/attribution/privileged-access-gate";
import { GoogleAdsLab } from "@/components/blocks/attribution/google-ads/google-ads-lab";

export default function GoogleAdsLabPage() {
  return (
    <PrivilegedAccessGate>
      <GoogleAdsLab />
    </PrivilegedAccessGate>
  );
}
```

In `src/app/(protected)/attribution/page.tsx`, next to the existing `<KlaviyoLabLink role={role} />` (~line 315), add:

```tsx
<GoogleAdsLabLink role={role} />
```

with the matching import at the top:

```tsx
import { GoogleAdsLabLink } from "@/components/blocks/attribution/google-ads/lab-link";
```

- [ ] **Step 5: Verify**

Run: `bun run test:components`
Expected: PASS.

Run: `bun run build`
Expected: compiles.

Run: `bun run lint`
Expected: clean (in particular: no `lucide-react` import slipped in).

- [ ] **Step 6: Commit**

```bash
git add src/components/blocks/attribution/privileged-access-gate.tsx src/components/blocks/attribution/klaviyo/klaviyo-access-gate.tsx src/components/blocks/attribution/google-ads/ "src/app/(protected)/attribution/google-ads/" "src/app/(protected)/attribution/page.tsx"
git commit -m "feat: add Google Ads Lab page and attribution header link"
```

---

### Task 14: Refresh-token mint script + sandbox runbook

**Files:**
- Create: `scripts/google-ads-mint-refresh-token.mjs`
- Create: `docs/superpowers/plans/2026-08-13-google-ads-sandbox-runbook.md`

- [ ] **Step 1: Mint script**

`scripts/google-ads-mint-refresh-token.mjs`:

```js
#!/usr/bin/env node
/**
 * One-time OAuth consent helper for the Google Ads pilot.
 *
 * Usage:
 *   GOOGLE_ADS_OAUTH_CLIENT_ID=... GOOGLE_ADS_OAUTH_CLIENT_SECRET=... \
 *     node scripts/google-ads-mint-refresh-token.mjs
 *
 * Starts a loopback listener, prints the consent URL, exchanges the code,
 * and prints the refresh token to paste into GOOGLE_ADS_REFRESH_TOKEN.
 * The OAuth client must have http://127.0.0.1:53682 as an authorized
 * redirect URI (Desktop-app clients accept loopback automatically).
 */
import http from "node:http";
import crypto from "node:crypto";

const clientId = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_ADS_OAUTH_CLIENT_ID and GOOGLE_ADS_OAUTH_CLIENT_SECRET");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/adwords";
const state = crypto.randomBytes(16).toString("hex");

const consentUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consentUrl.searchParams.set("client_id", clientId);
consentUrl.searchParams.set("redirect_uri", REDIRECT_URI);
consentUrl.searchParams.set("response_type", "code");
consentUrl.searchParams.set("scope", SCOPE);
consentUrl.searchParams.set("access_type", "offline");
consentUrl.searchParams.set("prompt", "consent");
consentUrl.searchParams.set("state", state);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", REDIRECT_URI);
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    response.writeHead(400).end("Missing code or state mismatch.");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Consent received — return to the terminal. You can close this tab.");
  server.close();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const payload = await tokenResponse.json();
  if (!tokenResponse.ok || !payload.refresh_token) {
    console.error("Token exchange failed:", tokenResponse.status, payload.error ?? "");
    process.exit(1);
  }
  console.log("\nGOOGLE_ADS_REFRESH_TOKEN:\n");
  console.log(payload.refresh_token);
  console.log("\nPaste it into the server/worker environment. Never commit it.");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL in a browser logged into the Google account");
  console.log("that has access to the (test) manager account:\n");
  console.log(consentUrl.toString());
});
```

- [ ] **Step 2: Sandbox runbook**

`docs/superpowers/plans/2026-08-13-google-ads-sandbox-runbook.md`:

```markdown
# Google Ads sandbox bring-up runbook (manual steps)

Phase 1 of the pilot spec. Everything here is console clicking + one script;
no app code changes. Do these once, in order.

## 1. Google Cloud project + OAuth client
1. Create a Google Cloud project (any name, e.g. `adsolute-google-ads-pilot`).
2. APIs & Services → enable **Google Ads API**.
3. OAuth consent screen: internal (or external/testing with the pilot Google
   account added as a test user), scope `https://www.googleapis.com/auth/adwords`.
4. Credentials → Create OAuth client ID → **Desktop app**. Record the client
   ID/secret as `GOOGLE_ADS_OAUTH_CLIENT_ID` / `GOOGLE_ADS_OAUTH_CLIENT_SECRET`.

## 2. Test manager + test client accounts
1. While logged into a Google account for the pilot, create a **test manager
   account**: https://developers.google.com/google-ads/api/docs/best-practices/test-accounts
   (the test-account creation link on that page). Record its ID as
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
2. Inside the test manager, create a **test client account**. Record its ID as
   `GOOGLE_ADS_CUSTOMER_ID`.
3. In the test client account, create 2–3 campaigns (any type; paused is
   fine). Test accounts serve no ads — the campaigns exist so GAQL responses
   are structurally real.

## 3. Developer token
1. In the **production** manager account UI (a test manager has no token
   page): Tools → API Center → apply for a developer token. The token starts
   in "test account only" access — that is exactly what the sandbox needs.
2. Record it as `GOOGLE_ADS_DEVELOPER_TOKEN`.
3. Submit the **Basic access** application in the same API Center now; the
   review is the long pole before Phase 2 (real Reviv data).

## 4. Refresh token
Run `node scripts/google-ads-mint-refresh-token.mjs` with the client ID and
secret in the environment; complete consent with the Google account that owns
the test manager. Paste the printed value into `GOOGLE_ADS_REFRESH_TOKEN`.

## 5. Environment
Fill every `GOOGLE_ADS_*` variable from `.env.example` in the local + worker
environments. `GOOGLE_ADS_REVIV_SHOP_DOMAIN` must equal the Reviv store's
`shop_domain` row value exactly.

## 6. Verify the API version pin
Check the current Google Ads API version at
https://developers.google.com/google-ads/api/docs/release-notes and set
`GOOGLE_ADS_API_VERSION` in `src/lib/google-ads/client.ts` to the newest
non-sunset version before first sync (the constant ships as "v21").

## 7. End-to-end sandbox pass (definition of done for Phase 1)
1. `bun run trigger:dev` + `bun dev`.
2. As an org admin, open `/attribution/google-ads`.
3. Run gclid probe → report completes with real coverage numbers (no Google
   credentials involved).
4. Run discovery → connection becomes `ready` with the test account's
   name/timezone/currency (or `degraded` with a reason code if misconfigured).
5. Sync facts → the 90-day backfill completes; campaign rows appear (zero
   metrics is expected for test accounts); `backfill_completed_at` is set.
6. Kill the facts task mid-run once and confirm the next batch resumes from
   the checkpoint instead of restarting at day one.

## Phase 2 swap (after Basic access approval)
Replace `GOOGLE_ADS_LOGIN_CUSTOMER_ID` / `GOOGLE_ADS_CUSTOMER_ID` with the
real manager + Reviv account IDs, re-mint the refresh token with the real
account's Google login, run discovery, then the 90-day backfill. The nightly
schedule picks the connection up automatically once the backfill completes.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/google-ads-mint-refresh-token.mjs docs/superpowers/plans/2026-08-13-google-ads-sandbox-runbook.md
git commit -m "feat: add OAuth mint script and sandbox bring-up runbook"
```

---

### Task 15: Full verification

- [ ] **Step 1: Full test suites**

Run: `bun run test`
Expected: PASS — all new unit + integration tests, no existing regressions.

Run: `bun run test:components`
Expected: PASS.

- [ ] **Step 2: Lint + build + migrations**

Run: `bun run lint`
Expected: clean.

Run: `bun run build`
Expected: compiles.

Run: `node scripts/check-migrations.mjs`
Expected: passes.

- [ ] **Step 3: Invariant spot-check**

Grep to prove the truth-model invariant held:

Run: `grep -rn "update(shopifyOrders)\|update(shopifyStores)" src/lib/google-ads/ trigger/google-ads-sync.ts trigger/gclid-probe.ts`
Expected: no matches — the pilot never writes Shopify truth.

- [ ] **Step 4: Commit any stragglers and push**

```bash
git status --short
git add -A && git commit -m "chore: google ads pilot verification fixes" # only if anything changed
git push -u origin feat/google-ads-pilot
```

---

## Self-review (performed while writing)

- **Spec coverage:** credential provider §7.1 → Task 2; client §7.2 → Task 4; schema §8 → Task 3; discovery + facts sync §9 → Tasks 7–8, 11; probe §6/§8 → Tasks 9–10 (with the lastVisit amendment in Task 1); lab + router §10 → Tasks 12–13; privacy §11 → enforced in Tasks 4, 9, 10 (sanitized errors, key-only fingerprints, no raw click IDs) and spot-checked in Task 15; error handling §12 → Tasks 4, 6, 7, 11; testing §13 → every task + Task 15; sandbox Phase 1 §6 → Task 14. Phase 2 (real creds) and Phase 3 (panel spec) are operational/follow-up, not code in this plan.
- **Known intentional deviations:** probe reports lastVisit-only coverage (spec amended in Task 1); sandbox-contract recorded-response tests from spec §13 are folded into the client unit tests (Task 4) plus the live sandbox pass (runbook §7) rather than a separate recorded-fixture suite — real recorded responses don't exist until sandbox bring-up.
- **Type consistency:** `GoogleAdsScope`/`ConnectionRecord`/`SyncRunRecord` defined in Tasks 3/6 and imported everywhere else; `NormalizedCampaignFact` (Task 5) is the payload of `commitCampaignFactsChunk` (Task 6) and `processGoogleAdsFactsBatch` (Task 8); `GclidProbeSummary` (Task 3) is produced by Task 10 and rendered by Task 13.
- **Open items the implementer must resolve in place (flagged in their tasks):** the exact `ctx` organization field name (Task 12, from `init.ts`), the integration-test harness copy (Tasks 6/10), the klaviyo-playground tRPC hook idiom (Task 13), and the current Google Ads API version (runbook §6).
```
