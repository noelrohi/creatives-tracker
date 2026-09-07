import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createSnapshotTestDatabase, seedSnapshotTestConnection } from "./snapshot-test-harness";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeSnapshotScope, snapshotScopeFingerprint, type KlaviyoSnapshotResolvedScope, type KlaviyoSnapshotResourceKind } from "./snapshot-contracts";

const state = vi.hoisted(() => ({ db: undefined as unknown, forbidden: vi.fn(() => { throw new Error("GET reached provider/credentials/Trigger"); }) }));
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/klaviyo/credential-provider", async (original) => ({
  ...await original<typeof import("@/lib/klaviyo/credential-provider")>(),
  EnvironmentKlaviyoCredentialProvider: class { resolve = state.forbidden; getPilotBinding = state.forbidden; },
}));
vi.mock("@/lib/klaviyo/read-transport", async (original) => ({
  ...await original<typeof import("@/lib/klaviyo/read-transport")>(), KlaviyoReadTransport: class { request = state.forbidden; },
}));
vi.mock("@trigger.dev/sdk", async (original) => ({
  ...await original<typeof import("@trigger.dev/sdk")>(), tasks: { trigger: state.forbidden, batchTrigger: state.forbidden },
}));
import { callOpenApiProcedure } from "@/lib/trpc/openapi";
import { readSnapshot } from "./snapshot-reads";

// The shared harness validates explicit opt-in and a localhost snapshot_* URL.
const suite = process.env.SNAPSHOT_TEST_DATABASE === "1" ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createSnapshotTestDatabase>>;
let pool: Pool;
const window = { since: "2026-09-01T00:00:00.000Z", until: "2026-09-02T00:00:00.000Z" };
const campaign = { campaignId: "C1", name: "Launch", status: "Sent", archived: false, createdAt: window.since, updatedAt: window.until, scheduledAt: null, sendTime: window.until };
const message = { messageId: "Msg1", campaignId: "C1", channel: "email", subject: "Subject", previewText: null, createdAt: window.since, updatedAt: window.until };
const metric = { metricId: "M1", name: null };
const event = { eventId: "E1", metricId: "M1", metricName: "Placed Order", datetime: window.since, profileId: "P1", profileExternalId: "external", value: 12.25, uuid: "uuid", orderId: "provider-order", currency: "USD" };
const values = { campaignId: "C1", campaignMessageId: "Msg1", sendChannel: "email", conversionMetricId: "M1", timeframeStart: window.since, timeframeEnd: window.until,
  recipients: 100, delivered: 98, deliveryRate: 0.98, opensUnique: null, openRate: null, clicksUnique: 0, clickRate: 0,
  conversions: 2, conversionRate: 0.02, conversionValue: 12.25, revenuePerRecipient: 0.1225, bounced: 2, bounceRate: 0.02,
  unsubscribes: 0, unsubscribeRate: 0, spamComplaints: null, spamComplaintRate: null };
type Row = [KlaviyoSnapshotResourceKind, Record<string, unknown>];
async function seed(scope: KlaviyoSnapshotResolvedScope, records: Row[] = [], options: { state?: string; publishedAt?: Date; privacy?: boolean } = {}) {
  const id = randomUUID();
  const canonical = canonicalizeSnapshotScope(scope);
  const fingerprint = snapshotScopeFingerprint(canonical);
  const status = options.state ?? "published";
  if (status === "published") await pool.query("UPDATE klaviyo_snapshot_run SET is_current=0 WHERE connection_id='connection' AND scope_fingerprint=$1", [fingerprint]);
  const publishedAt = options.publishedAt ?? new Date();
  await pool.query(`INSERT INTO klaviyo_snapshot_run
    (id, organization_id, shopify_store_id, connection_id, account_id, dataset, scope_fingerprint, resolved_scope,
     configuration_version, trigger_type, state, is_current, lease_token, api_revision, started_at, finished_at, published_at,
     provider_completeness, record_count, requested_from, requested_to, provider_window_start, provider_window_end, timezone,
     privacy_adjusted, privacy_adjusted_at, privacy_removed_count, warnings, error_code, anchor_at, checkpoint)
    VALUES ($1,'org','store','connection','connection-account',$2,$3,$4,1,'manual',$5,$6,'lease','2026-07-15',$7,$7,$8,
      $9,$10,$11::text::timestamp,$12::text::timestamp,$11::text,$12::text,'UTC',$13,$14,$15,$16,$17,$7,$18)`,
    [id, scope.dataset, fingerprint, JSON.stringify(canonical), status, status === "published" ? 1 : 0,
      publishedAt.toISOString(), status === "published" ? publishedAt.toISOString() : null, scope.dataset === "campaign_values" ? "unverified" : "complete", records.length,
      "since" in canonical ? canonical.since : null, "until" in canonical ? canonical.until : null,
      options.privacy ? 1 : 0, options.privacy ? publishedAt.toISOString() : null, options.privacy ? 1 : 0,
      JSON.stringify(scope.dataset === "campaign_values" ? ["provider_completeness_unverified"] : []), status === "failed" ? "KLAVIYO_SNAPSHOT_FAILED" : null,
      status === "running" ? JSON.stringify({ dataset: scope.dataset, continuation: null, page: 0 }) : null]);
  for (const [index, [kind, content]] of records.entries()) {
    const contentId = randomUUID();
    const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    const saved = await pool.query(`INSERT INTO klaviyo_snapshot_content
      (id,organization_id,shopify_store_id,connection_id,resource_kind,content_digest,content)
      VALUES ($1,'org','store','connection',$2,$3,$4)
      ON CONFLICT (connection_id,resource_kind,content_digest) DO UPDATE SET content_digest=EXCLUDED.content_digest RETURNING id`, [contentId, kind, digest, JSON.stringify(content)]);
    await pool.query(`INSERT INTO klaviyo_snapshot_record
      (id,organization_id,shopify_store_id,connection_id,snapshot_run_id,content_id,resource_kind,provider_identity,ordering_key,profile_id,metric_id,event_datetime)
      VALUES ($1,'org','store','connection',$2,$3,$4,$5,$5,$6,$7,$8)`, [randomUUID(), id, saved.rows[0].id, kind, String(index).padStart(6, "0"),
        kind === "event" ? content.profileId : null, kind === "event" ? content.metricId : null, kind === "event" ? content.datetime : null]);
  }
  return id;
}
async function request(name: string, params: Record<string, string> = {}, key = "ask_read") {
  const response = await callOpenApiProcedure(new Request(`https://adsolute.test/api/openapi/klaviyoReads/${name}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${key}.synthetic`, "x-adsolute-organization-id": "forged" },
  }), "klaviyoReads", name);
  return { status: response.status, body: await response.json() };
}
suite("Postgres snapshot reads through actual OpenAPI", () => {
  beforeAll(async () => {
    database = await createSnapshotTestDatabase();
    pool = database.pool;
    state.db = database.db;
  }, 60_000);
  afterAll(async () => {
    await database?.close();
  });
  beforeEach(async () => {
    state.forbidden.mockClear();
    await database.reset();
    await seedSnapshotTestConnection(pool, { organizationId: "org", storeId: "store", connectionId: "connection" }, "UTC");
    await seedSnapshotTestConnection(pool, { organizationId: "other", storeId: "other-store", connectionId: "other-connection" }, "UTC");
    await pool.query("UPDATE klaviyo_connection SET status='degraded' WHERE id='connection'");
    for (const prefix of ["ask_read", "ask_other", "ask_write"]) {
      await pool.query("INSERT INTO api_key (id,name,prefix,secret_hash,organization_id,scopes) VALUES ($1,'Synthetic',$1,$2,$3,$4)",
        [prefix, createHash("sha256").update(`${prefix}.synthetic`).digest("hex"), prefix === "ask_other" ? "other" : "org", [prefix === "ask_write" ? "write" : "read"]]);
    }
  });
  it("round-trips all five complete reviewed contracts without credentials/provider/Trigger", async () => {
    await seed({ dataset: "campaigns" }, [["campaign", campaign], ["campaign_message", message]]);
    await seed({ dataset: "metrics" }, [["metric", metric]]);
    await seed({ dataset: "events", metricIds: ["M1"], ...window }, [["event", event]]);
    await seed({ dataset: "campaign_values", conversionMetricId: "M1", ...window }, [["campaign_value_row", values]]);
    const campaigns = await request("campaigns"); expect(campaigns.status).toBe(200);
    expect(campaigns.body.campaigns).toEqual([campaign]); expect(campaigns.body.messages).toEqual([message]);
    expect((await request("metrics")).body.metrics).toEqual([metric]);
    expect((await request("events", { ...window, metricIds: "M1" })).body.events).toEqual([event]);
    const reports = await request("campaignValues", { ...window, conversionMetricId: "M1" });
    expect(reports.status).toBe(200); expect(reports.body.rows).toEqual([values]);
    expect(reports.body.snapshot).toMatchObject({ providerCompleteness: "unverified", requestedWindow: window, timezone: "UTC" });
    expect(state.forbidden).not.toHaveBeenCalled();
  });
  it("enforces migrated snapshot and record organization/connection foreign keys", async () => {
    const id = await seed({ dataset: "metrics" }, [["metric", metric]]);
    await expect(pool.query("UPDATE klaviyo_snapshot_run SET organization_id='other' WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("UPDATE klaviyo_snapshot_record SET connection_id='other-connection' WHERE snapshot_run_id=$1", [id]))
      .rejects.toMatchObject({ code: "23503" });
    expect((await request("metrics")).body.metrics).toEqual([metric]);
  });
  it("distinguishes missing scope, missing connection, missing history and valid empty", async () => {
    expect((await request("metrics")).body.reason).toBe("not_synced");
    expect((await request("events", { ...window, metricIds: "M1" })).body).toMatchObject({ reason: "scope_not_synced", requiredSyncRequest: { dataset: "events", metricIds: ["M1"], ...window } });
    await seed({ dataset: "metrics" });
    expect((await request("metrics")).body).toMatchObject({ state: "available", metrics: [], nextContinuation: null });
    expect((await request("metrics", { snapshotId: "missing" })).body.reason).toBe("snapshot_not_found");
    await pool.query("DELETE FROM klaviyo_connection WHERE id='connection'");
    expect((await request("metrics")).body.reason).toBe("not_configured");
  });
  it("pins keyset history across publication and never substitutes missing pinned history", async () => {
    const id = await seed({ dataset: "metrics" }, Array.from({ length: 201 }, (_, i) => ["metric", { metricId: `M${i}`, name: null }]));
    const first = (await request("metrics")).body;
    expect(first.metrics).toHaveLength(200); expect(first.nextContinuation).toBeTypeOf("string");
    const newer = await seed({ dataset: "metrics" }, [["metric", { metricId: "New", name: "New" }]]);
    expect((await request("metrics")).body.snapshot.snapshotId).toBe(newer);
    const second = (await request("metrics", { continuation: first.nextContinuation })).body;
    expect(second.snapshot.snapshotId).toBe(id); expect(second.metrics).toEqual([{ metricId: "M200", name: null }]); expect(second.nextContinuation).toBeNull();
    expect((await request("metrics", { snapshotId: id })).body.snapshot.snapshotId).toBe(id);
    expect((await request("metrics", { continuation: first.nextContinuation, snapshotId: newer })).status).toBe(400);
    expect((await request("metrics", { continuation: first.nextContinuation }, "ask_other")).body.reason).toBe("snapshot_not_found");
    expect((await request("metrics", { snapshotId: id }, "ask_other")).body.reason).toBe("snapshot_not_found");
    expect((await request("campaigns", { continuation: first.nextContinuation })).status).toBe(400);
    await pool.query("DELETE FROM klaviyo_snapshot_run WHERE id=$1", [id]);
    expect((await request("metrics", { continuation: first.nextContinuation })).body.reason).toBe("snapshot_not_found");
  });
  it("canonicalizes metric order/instants and requires an exact window even for explicit history", async () => {
    const scope = { dataset: "events" as const, metricIds: ["M1", "M2"], ...window };
    const id = await seed(scope, Array.from({ length: 201 }, (_, i) => ["event", { ...event, eventId: `E${i}` }]));
    const first = (await request("events", { ...window, metricIds: "M2,M1", since: "2026-08-31T20:00:00-04:00" })).body;
    expect(first.snapshot.snapshotId).toBe(id);
    const continued = await request("events", { ...window, metricIds: "M1,M2", continuation: first.nextContinuation });
    expect(continued.body.events).toEqual([{ ...event, eventId: "E200" }]);
    expect((await request("events", { ...window, metricIds: "M1", continuation: first.nextContinuation })).status).toBe(400);
    expect((await request("events", { ...window, until: "2026-09-03T00:00:00Z", metricIds: "M1,M2", continuation: first.nextContinuation })).status).toBe(400);
    expect((await request("events", { ...window, metricIds: "M1" })).body.reason).toBe("scope_not_synced");
    expect((await request("events", { ...window, metricIds: "M1,M2", until: "2026-09-03T00:00:00Z", snapshotId: id })).body.reason).toBe("snapshot_not_found");
    expect((await request("events", { ...window, metricIds: "M1,M2", until: "2026-09-03T00:00:00Z" })).body.reason).toBe("scope_not_synced");
  });
  it.each(["running", "failed"])("serves stale privacy-adjusted history while latest refresh is %s", async (status) => {
    const id = await seed({ dataset: "metrics" }, [], { publishedAt: new Date(Date.now() - 25 * 3600_000), privacy: true });
    await seed({ dataset: "metrics" }, [], { state: status });
    const response = await request("metrics");
    expect(response.body.snapshot).toMatchObject({ snapshotId: id, freshness: "stale", recordCount: 0, privacy: { adjusted: true, removedRecords: 1 }, latestRefresh: { status } });
  });
  it("does not expose disabled, rebound or uninstalled connection history", async () => {
    const id = await seed({ dataset: "metrics" }, [["metric", metric]]);
    await pool.query("UPDATE klaviyo_connection SET klaviyo_account_id='Rebound' WHERE id='connection'");
    expect((await request("metrics", { snapshotId: id })).body.reason).toBe("snapshot_not_found");
    await pool.query("UPDATE klaviyo_connection SET status='disabled' WHERE id='connection'");
    expect((await request("metrics", { snapshotId: id })).body.reason).toBe("not_configured");
    await pool.query("DELETE FROM klaviyo_connection WHERE id='connection'");
    expect((await request("metrics", { snapshotId: id })).body.reason).toBe("not_configured");
  });
  it("does not arbitrarily select an account when the stored org binding is ambiguous", async () => {
    await seed({ dataset: "metrics" }, [["metric", metric]]);
    await seedSnapshotTestConnection(pool, { organizationId: "org", storeId: "second-store", connectionId: "second-connection" }, "UTC");
    expect((await request("metrics")).body.reason).toBe("not_configured");
  });
  it.each(["disabled", "unbound"])("rejects a %s binding alongside another ready binding", async (inaccessible) => {
    const id = await seed({ dataset: "metrics" }, [["metric", metric]]);
    await pool.query("UPDATE klaviyo_connection SET status='ready' WHERE id='connection'");
    await seedSnapshotTestConnection(pool, { organizationId: "org", storeId: "second-store", connectionId: "second-connection" }, "UTC");
    await pool.query(inaccessible === "disabled"
      ? "UPDATE klaviyo_connection SET status='disabled' WHERE id='second-connection'"
      : "UPDATE klaviyo_connection SET klaviyo_account_id=NULL WHERE id='second-connection'");
    const requests: Record<string, string>[] = [{}, { snapshotId: id }];
    for (const params of requests) {
      const response = await request("metrics", params);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ state: "not_available", reason: "not_configured" });
      expect(response.body).not.toHaveProperty("metrics");
    }
    expect(state.forbidden).not.toHaveBeenCalled();
  });
  it("enforces real HTTP auth boundaries before reading DB", async () => {
    await seed({ dataset: "metrics" }, [["metric", metric]]);
    expect((await request("metrics", {}, "invalid")).status).toBe(401);
    expect((await request("metrics", {}, "ask_write")).status).toBe(403);
    expect((await request("metrics", {}, "ask_other")).body.reason).toBe("not_synced");
    expect(state.forbidden).not.toHaveBeenCalled();
  });
  it("sanitizes unexpected database errors", async () => {
    const original = state.db;
    state.db = { transaction: () => { throw new Error("private database contents"); } };
    try { await expect(readSnapshot("org", { dataset: "metrics" })).rejects.toMatchObject({ message: "Klaviyo snapshot read failed" }); }
    finally { state.db = original; }
  });
});
