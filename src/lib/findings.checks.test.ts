/**
 * `findings.checks` reports statuses frozen by the last sweep, so the sweep's
 * timestamp is part of the answer rather than decoration: without it a
 * recovered outage still reads as a live one. The statuses come out of real
 * rows, so these run against a throwaway Postgres built from a fixture schema,
 * following the pattern in ad-creative.portfolio.test.ts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_findings_checks_test";

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const testPool = baseConnectionString
  ? new Pool({ connectionString: withDatabase(baseConnectionString, TEST_DATABASE) })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("server-only", () => ({}));

const { getTodaysChecks } = await import("./findings");
const { shopifyStores } = await import("@/schema/shopify");
const { eq } = await import("drizzle-orm");

const ORG = "org_findings_checks_test";
const STORE = "store_findings_checks_test";
const SWEPT_AT = new Date("2026-08-19T19:30:26.695Z");

const FIXTURE_DDL = [
  `CREATE TYPE "finding_type" AS ENUM (
     'meta_overclaim', 'unattributed_spike', 'broken_utm_template', 'sync_failure',
     'roas_below_target', 'ad_lp_funnel_mismatch', 'untagged_spend', 'utm_template_drift'
   )`,
  `CREATE TYPE "finding_resolution" AS ENUM ('handled', 'retired')`,
  `CREATE TABLE shopify_store (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     shop_domain text NOT NULL,
     iana_timezone text NOT NULL,
     currency text,
     access_token text,
     last_synced_at timestamp,
     findings_evaluated_at timestamp,
     created_at timestamp NOT NULL DEFAULT now(),
     updated_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE shopify_sync_run (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     phase text NOT NULL,
     result text,
     requested_at timestamp NOT NULL DEFAULT now(),
     finished_at timestamp,
     orders_synced integer,
     meta jsonb
   )`,
  `CREATE TABLE finding (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     type "finding_type" NOT NULL,
     fired_at timestamp NOT NULL DEFAULT now(),
     period_start date,
     period_end date,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     resolved_at timestamp,
     resolution "finding_resolution",
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE finding_mute (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     type "finding_type" NOT NULL,
     muted_until timestamp NOT NULL,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE ad_account (
     id text PRIMARY KEY,
     name text NOT NULL,
     meta_account_id text NOT NULL UNIQUE,
     meta_access_token text,
     is_disabled boolean NOT NULL DEFAULT false,
     organization_id text
   )`,
  `CREATE TABLE account_sync_run (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     account_id text NOT NULL REFERENCES ad_account(id) ON DELETE CASCADE,
     trigger_type text NOT NULL DEFAULT 'manual',
     date_from date NOT NULL DEFAULT '2026-08-01',
     date_to date NOT NULL DEFAULT '2026-08-19',
     result text,
     requested_at timestamp NOT NULL DEFAULT now(),
     finished_at timestamp
   )`,
];

const describeWithDb = testDb ? describe : describe.skip;

describeWithDb("findings checks report when they were taken", () => {
  beforeAll(async () => {
    if (!baseConnectionString || !testDb) return;
    const adminPool = new Pool({ connectionString: baseConnectionString });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await adminPool.end();

    for (const statement of FIXTURE_DDL) {
      await testDb.execute(sql.raw(statement));
    }
  });

  afterAll(async () => {
    await testPool?.end();
  });

  beforeEach(async () => {
    if (!testDb) return;
    for (const table of [
      "finding",
      "finding_mute",
      "account_sync_run",
      "ad_account",
      "shopify_sync_run",
      "shopify_store",
    ]) {
      await testDb.execute(sql.raw(`DELETE FROM ${table}`));
    }

    await testDb.execute(sql`
      INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone, currency)
      VALUES (${STORE}, ${ORG}, 'checks-test.myshopify.com', 'Asia/Bangkok', 'USD')
    `);
    await testDb.execute(sql`
      INSERT INTO shopify_sync_run (id, organization_id, store_id, phase, result, finished_at)
      VALUES ('run-1', ${ORG}, ${STORE}, 'backfill', 'success', now())
    `);
  });

  /**
   * Written through Drizzle rather than raw SQL on purpose: the column is
   * `timestamp` without a zone, so only the driver's own mapping — the one the
   * sweep writes through — round-trips a Date unchanged.
   */
  async function stampSweep(at: Date, storeId: string = STORE) {
    await testDb
      ?.update(shopifyStores)
      .set({ findingsEvaluatedAt: at })
      .where(eq(shopifyStores.id, storeId));
  }

  it("reports no timestamp before a store has ever been swept", async () => {
    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.evaluatedAt).toBeNull();
    expect(result.checks).toHaveLength(8);
  });

  it("reports the sweep's timestamp once one has run", async () => {
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.evaluatedAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  /**
   * The case this field exists for. An open sync_failure keeps reporting
   * needs_look long after the connector recovered, because nothing re-evaluates
   * it until the next sweep. The status is not wrong — it is old — and only the
   * timestamp says so.
   */
  it("dates a stale needs_look rather than presenting it as current", async () => {
    await testDb?.execute(sql`
      INSERT INTO finding (id, organization_id, store_id, type, fired_at, payload)
      VALUES ('finding-1', ${ORG}, ${STORE}, 'sync_failure', ${SWEPT_AT}, '{}'::jsonb)
    `);
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({
      organizationId: ORG,
      storeId: STORE,
      now: new Date("2026-08-20T03:30:00.000Z"),
    });

    expect(
      result.checks.find((check) => check.type === "sync_failure")?.status,
    ).toBe("needs_look");
    // Eight hours older than `now` — the caller can see the reading is stale.
    expect(result.evaluatedAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  it("carries the timestamp through the pre-first-sync answer too", async () => {
    await testDb?.execute(sql`DELETE FROM shopify_sync_run`);
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.checks.every((check) => check.status === "waiting_for_data")).toBe(true);
    expect(result.evaluatedAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  it("reads the timestamp of the store it was asked about", async () => {
    await testDb?.execute(sql`
      INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
      VALUES ('other-store', ${ORG}, 'other.myshopify.com', 'UTC')
    `);
    await stampSweep(new Date("2020-01-01T00:00:00.000Z"), "other-store");
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.evaluatedAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });
});

describe("the sweep stamps the store it swept", () => {
  /**
   * `evaluateFindingsForStore` needs most of the schema to run, so the write is
   * guarded at the source rather than behaviourally: the stamp must survive
   * next to the retire pass, and must be the store's own row.
   */
  it("writes findingsEvaluatedAt at the end of a run", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/findings.ts"),
      "utf8",
    );
    const sweep = source.slice(source.indexOf("export async function evaluateFindingsForStore"));

    expect(sweep).toContain("findingsEvaluatedAt: now");
    expect(sweep).toContain("eq(shopifyStores.id, params.storeId)");
  });
});
