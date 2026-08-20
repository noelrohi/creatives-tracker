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
const { findings } = await import("@/schema/finding");
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
  // The checks endpoint evaluates the series rules live, so it reads the same
  // Meta and Shopify tables the sweep does. Only the columns those two queries
  // touch are here — `getMetaClaims` filters to base rows, and `getMetaVerified`
  // joins refunds onto Meta-verified orders.
  `CREATE TYPE "attribution_bucket" AS ENUM (
     'meta', 'google', 'klaviyo', 'tiktok', 'ai',
     'organic_direct', 'unattributed', 'untracked'
   )`,
  `CREATE TABLE performance_log (
     id text PRIMARY KEY,
     ad_id text NOT NULL,
     organization_id text,
     spend numeric,
     purchase_value numeric,
     purchase_value_7d_click numeric,
     purchase_value_1d_view numeric,
     country text,
     platform text,
     placement text,
     device text,
     age text,
     gender text,
     date_start date NOT NULL,
     date_end date NOT NULL,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE shopify_order (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     shopify_order_id text NOT NULL,
     order_created_at timestamp NOT NULL DEFAULT now(),
     order_day date NOT NULL,
     net_sales numeric NOT NULL,
     bucket "attribution_bucket",
     meta_verified boolean NOT NULL DEFAULT false,
     verification_pending boolean NOT NULL DEFAULT false,
     journey_ready boolean NOT NULL DEFAULT false,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE shopify_refund (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     store_id text NOT NULL,
     order_id text NOT NULL,
     shopify_refund_id text NOT NULL,
     refund_day date NOT NULL,
     amount numeric NOT NULL,
     kind text NOT NULL DEFAULT 'refund',
     created_at timestamp NOT NULL DEFAULT now()
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
      "shopify_refund",
      "shopify_order",
      "performance_log",
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
  /** Same reason as `stampSweep`: the Date has to go through Drizzle's mapping. */
  async function insertFinding(id: string, firedAt: Date) {
    await testDb?.insert(findings).values({
      id,
      organizationId: ORG,
      storeId: STORE,
      type: "sync_failure",
      firedAt,
      payload: {},
    });
  }

  async function stampSweep(at: Date, storeId: string = STORE) {
    await testDb
      ?.update(shopifyStores)
      .set({ findingsEvaluatedAt: at })
      .where(eq(shopifyStores.id, storeId));
  }

  /**
   * The window this floor exists for: deployed, not yet swept again, and
   * carrying findings from a sweep that predates the column. Without it those
   * statuses arrive undated in exactly the window the new field is most
   * trusted.
   */
  it("dates rules that ran before the column existed", async () => {
    await insertFinding("finding-old", SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.rulesLastRanAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  it("prefers the stamp over the floor once a sweep has written one", async () => {
    const newer = new Date("2026-08-20T19:30:00.000Z");
    await insertFinding("finding-old", SWEPT_AT);
    await stampSweep(newer);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.rulesLastRanAt?.toISOString()).toBe(newer.toISOString());
  });

  it("reports no timestamp for a store that has genuinely never been swept", async () => {
    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.rulesLastRanAt).toBeNull();
    expect(result.checks).toHaveLength(8);
  });

  it("reports when the rules last ran once a sweep has run", async () => {
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.rulesLastRanAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  /**
   * The case this field exists for. An open sync_failure keeps reporting
   * needs_look long after the connector recovered, because nothing re-evaluates
   * it until the next sweep. The status is not wrong — the finding behind it is
   * old — and the timestamp is what lets a reader tell.
   */
  it("reports a needs_look alongside rules that ran hours earlier", async () => {
    await insertFinding("finding-1", SWEPT_AT);
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
    expect(result.rulesLastRanAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  /**
   * Review catch: the timestamp dates the rules, not the statuses. A status is
   * re-derived per request from unresolved findings, active mutes and live
   * connector health, so it moves with no sweep in between. Pinned so the field
   * is never read as "as of T, these were flagged" — freezing the statuses to
   * make the two clocks agree would break `sync_failure` reflecting live
   * connector health, which is the point of it.
   */
  it("moves a status without moving the timestamp", async () => {
    await insertFinding("finding-resolvable", SWEPT_AT);
    await stampSweep(SWEPT_AT);

    const before = await getTodaysChecks({ organizationId: ORG, storeId: STORE });
    expect(
      before.checks.find((check) => check.type === "sync_failure")?.status,
    ).toBe("needs_look");

    await testDb?.execute(sql`
      UPDATE finding SET resolved_at = now(), resolution = 'handled'
      WHERE id = 'finding-resolvable'
    `);

    const after = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(
      after.checks.find((check) => check.type === "sync_failure")?.status,
    ).toBe("ok");
    expect(after.rulesLastRanAt?.toISOString()).toBe(
      before.rulesLastRanAt?.toISOString(),
    );
  });

  it("carries the timestamp through the pre-first-sync answer too", async () => {
    await testDb?.execute(sql`DELETE FROM shopify_sync_run`);
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.checks.every((check) => check.status === "waiting_for_data")).toBe(true);
    expect(result.rulesLastRanAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  it("reads the timestamp of the store it was asked about", async () => {
    await testDb?.execute(sql`
      INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
      VALUES ('other-store', ${ORG}, 'other.myshopify.com', 'UTC')
    `);
    await stampSweep(new Date("2020-01-01T00:00:00.000Z"), "other-store");
    await stampSweep(SWEPT_AT);

    const result = await getTodaysChecks({ organizationId: ORG, storeId: STORE });

    expect(result.rulesLastRanAt?.toISOString()).toBe(SWEPT_AT.toISOString());
  });

  /**
   * The defect these cover: `waiting_for_data` used to be read off the Meta
   * connector's age, which answers a different question than the one the field
   * claims to answer. A sync three hours old still leaves yesterday unreported,
   * and the endpoint said `ok` — indistinguishable, to anything quoting it,
   * from a rule that looked and found nothing wrong.
   */
  describe("waiting_for_data follows what the rules could compute", () => {
    // 11:00 in Asia/Bangkok, so the evaluation day is 2026-08-19 and the ROAS
    // window runs 2026-08-13..2026-08-19 with overclaim's inside it at the end.
    const NOW = new Date("2026-08-20T04:00:00Z");
    const ROAS_WINDOW = [
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ];

    /** A day Meta has reported. Row count, not the amount, is what says so. */
    async function metaReported(day: string, spend = "100.00") {
      await testDb?.execute(sql`
        INSERT INTO performance_log (id, ad_id, organization_id, spend, purchase_value_7d_click, date_start, date_end)
        VALUES (${`pl-${day}-${spend}`}, 'ad-1', ${ORG}, ${spend}, '50.00', ${day}, ${day})
      `);
    }

    async function reportDays(days: string[]) {
      for (const day of days) await metaReported(day);
    }

    async function checkFor(type: string) {
      const result = await getTodaysChecks({
        organizationId: ORG,
        storeId: STORE,
        now: NOW,
      });
      return result.checks.find((check) => check.type === type);
    }

    it("says ok when every day in the window is reported", async () => {
      await reportDays(ROAS_WINDOW);

      expect(await checkFor("roas_below_target")).toEqual({
        type: "roas_below_target",
        status: "ok",
        uncomputableDays: [],
        periodStart: "2026-08-13",
        periodEnd: "2026-08-19",
      });
    });

    /**
     * The case the old proxy got backwards. Nothing here is stale — there is no
     * Meta connector at all, so `health.meta.stale` cannot be what answers this
     * — and the rule still cannot judge a window whose newest day is absent.
     */
    it("waits when Meta has not reported the newest day", async () => {
      await reportDays(ROAS_WINDOW.slice(0, -1));

      expect(await checkFor("roas_below_target")).toEqual({
        type: "roas_below_target",
        status: "waiting_for_data",
        uncomputableDays: ["2026-08-19"],
        periodStart: "2026-08-13",
        periodEnd: "2026-08-19",
      });
    });

    it("names every missing day, not just the newest", async () => {
      await reportDays(["2026-08-13", "2026-08-15", "2026-08-16", "2026-08-17"]);

      const check = await checkFor("roas_below_target");

      expect(check?.uncomputableDays).toEqual([
        "2026-08-14",
        "2026-08-18",
        "2026-08-19",
      ]);
    });

    /**
     * The two rules read different windows, so a hole outside the shorter one
     * is not the shorter rule's problem. A consumer that assumed one window for
     * every check would report a gap the overclaim rule never had.
     */
    it("keeps each rule to its own window", async () => {
      await reportDays(ROAS_WINDOW.filter((day) => day !== "2026-08-14"));

      expect((await checkFor("roas_below_target"))?.uncomputableDays).toEqual([
        "2026-08-14",
      ]);
      expect(await checkFor("meta_overclaim")).toEqual({
        type: "meta_overclaim",
        status: "ok",
        uncomputableDays: [],
        periodStart: "2026-08-17",
        periodEnd: "2026-08-19",
      });
    });

    /**
     * A reported day with no spend has no ratio, so ROAS cannot judge it — but
     * overclaim can, and does. Collapsing the two holes into one predicate
     * would leave overclaim findings standing through every quiet weekend.
     */
    it("splits a zero-spend day between the two rules", async () => {
      await reportDays(ROAS_WINDOW.filter((day) => day !== "2026-08-19"));
      await metaReported("2026-08-19", "0");

      expect((await checkFor("roas_below_target"))?.uncomputableDays).toEqual([
        "2026-08-19",
      ]);
      expect((await checkFor("meta_overclaim"))?.status).toBe("ok");
    });

    /**
     * The inverse of the defect, and the reason the connector's age had to go:
     * a connector that has not run in days can still have every day the window
     * needs, and the rule that judged them fine should say so.
     */
    it("does not wait on a stale connector whose window is complete", async () => {
      await reportDays(ROAS_WINDOW);
      await testDb?.execute(sql`
        INSERT INTO ad_account (id, name, meta_account_id, meta_access_token, organization_id)
        VALUES ('acct-1', 'Stale', 'act_1', 'token', ${ORG})
      `);
      await testDb?.execute(sql`
        INSERT INTO account_sync_run (id, organization_id, account_id, result, finished_at)
        VALUES ('acct-run-1', ${ORG}, 'acct-1', 'success', ${new Date("2026-08-10T00:00:00Z")})
      `);

      expect((await checkFor("roas_below_target"))?.status).toBe("ok");
      // The rules that judge an aggregate keep the proxy, so the same stale
      // connector still moves them. Coarse, but it is all they have.
      expect((await checkFor("untagged_spend"))?.status).toBe(
        "waiting_for_data",
      );
    });

    /**
     * Absent and empty are different answers and a consumer must not collapse
     * them: absent is "this rule cannot tell you which days it was missing".
     */
    it("omits the day fields on rules that judge an aggregate", async () => {
      await reportDays(ROAS_WINDOW);

      const check = await checkFor("untagged_spend");

      expect(check).toEqual({ type: "untagged_spend", status: "ok" });
      expect(check).not.toHaveProperty("uncomputableDays");
      expect(check).not.toHaveProperty("periodEnd");
    });

    /** An open finding is a judgement already reached; it outranks the window. */
    it("reports needs_look over waiting even with a hole in the window", async () => {
      await reportDays(ROAS_WINDOW.slice(0, -1));
      await testDb?.insert(findings).values({
        id: "finding-roas",
        organizationId: ORG,
        storeId: STORE,
        type: "roas_below_target",
        firedAt: SWEPT_AT,
        payload: {},
      });

      expect((await checkFor("roas_below_target"))?.status).toBe("needs_look");
    });
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
