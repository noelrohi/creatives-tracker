import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSnapshotTestDatabase, seedSnapshotTestConnection, SNAPSHOT_TEST_KEYS as keys, SNAPSHOT_TEST_NOW as now, SNAPSHOT_TEST_SCOPE as scope } from "./snapshot-test-harness";
import { computeErasureSuppressionDigests } from "@/lib/identity-hmac";
import { klaviyoSnapshotContents as contents, klaviyoSnapshotRecords as records, klaviyoSnapshotRuns as runs } from "@/schema/klaviyo-snapshot";
import { identityErasureSuppressions } from "@/schema/shopify-evidence";
import { KLAVIYO_SNAPSHOT_REPORT_WARNINGS, KLAVIYO_SNAPSHOT_MAX_PAGES_PER_RUN, KLAVIYO_SNAPSHOT_MAX_RECORDS_PER_RUN, KLAVIYO_SNAPSHOT_MAX_RUN_BYTES, KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS, snapshotReportProviderWindow, type KlaviyoSnapshotResolvedScope, type KlaviyoStagedSnapshotRecord } from "./snapshot-contracts";

const enabled = process.env.SNAPSHOT_TEST_DATABASE === "1";
describe.skipIf(!enabled)("snapshot lifecycle on real PostgreSQL (generated snapshot migration)", () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotTestDatabase>>;
  let store: typeof import("./snapshot-store");
  let locks: typeof import("./source-store");
  beforeAll(async () => {
    fixture = await createSnapshotTestDatabase();
    vi.doMock("@/db", () => ({ db: fixture.db }));
    store = await import("./snapshot-store");
    locks = await import("./source-store");
  }, 60_000);
  afterAll(async () => { vi.doUnmock("@/db"); await fixture?.close(); });
  beforeEach(async () => { await fixture.reset(); await seedSnapshotTestConnection(fixture.pool); });

  const later = (ms: number) => new Date(now.getTime() + ms);
  const eventScope: KlaviyoSnapshotResolvedScope = { dataset: "events", metricIds: ["MetricA"], since: "2026-09-01T00:00:00Z", until: "2026-09-07T00:00:00Z" };
  const metric = (id = "A", name: string | null = "Placed Order"): KlaviyoStagedSnapshotRecord => ({ resourceKind: "metric", providerIdentity: id, orderingKey: id, content: { metricId: id, name } });
  const event = (id = "E1", email = "snapshot-only@example.test", profileId: string | null = "Profile1"): KlaviyoStagedSnapshotRecord => {
    const digests = profileId ? computeErasureSuppressionDigests({ scope, key: keys.suppressionKey, email, klaviyoProfileId: profileId }) : [];
    const datetime = "2026-09-03T08:01:02.123Z";
    return { resourceKind: "event", providerIdentity: id, orderingKey: JSON.stringify([datetime, id]), profileId, metricId: "MetricA", eventDatetime: datetime,
      content: { eventId: id, metricId: "MetricA", metricName: "Arbitrary custom metric", datetime, profileId, profileExternalId: profileId ? "opaque-not-customer" : null, value: 0.17, uuid: null, orderId: "123", currency: "USD" },
      ...(profileId ? { identity: { keyVersion: keys.suppressionKey.version, emailDigest: digests.find(d => d.kind === "email")!.digest, profileDigest: digests.find(d => d.kind === "klaviyo_profile_id")!.digest } } : {}),
    };
  };
  async function prepare(resolvedScope: KlaviyoSnapshotResolvedScope = { dataset: "metrics" }, at = now) {
    const result = await store.prepareSnapshotRun({ scope, dataset: resolvedScope.dataset, resolvedScope, triggerType: "manual", now: at });
    if (!result.snapshotRunId) throw new Error("Expected run");
    return (await store.loadSnapshotRun(result.snapshotRunId)).row;
  }
  async function page(run: Awaited<ReturnType<typeof prepare>>, rows: KlaviyoStagedSnapshotRecord[], continuation: string | null = null, at = now) {
    const checkpoint = run.checkpoint!;
    return store.commitSnapshotPage({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, expectedCheckpoint: checkpoint,
      nextCheckpoint: { ...checkpoint, page: checkpoint.page + 1, continuation }, records: rows, privacyKeys: keys, now: at });
  }
  async function publish(run: Awaited<ReturnType<typeof prepare>>, at = now) {
    return store.publishSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, providerCompleteness: "complete", warnings: [], suppressionKey: keys.suppressionKey, privacyKeys: keys, now: at });
  }
  async function rows(id: string, limit = 100, after: { resourceKind: "metric"; orderingKey: string } | null = null) {
    return store.querySnapshotRecords({ snapshotRunId: id, limit, after });
  }
  async function tombstone(email: string, profileId?: string) {
    const digests = computeErasureSuppressionDigests({ scope, key: keys.suppressionKey, email, klaviyoProfileId: profileId });
    await locks.withKlaviyoStoreConnectionLock(scope, async tx => {
      await tx.insert(identityErasureSuppressions).values(digests.map(d => ({ ...d, organizationId: scope.organizationId, storeId: scope.storeId }))).onConflictDoNothing();
    });
  }
  async function count(table: "klaviyo_snapshot_content" | "klaviyo_snapshot_record" | "klaviyo_snapshot_profile_suppression") {
    return Number((await fixture.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  }

  it("applies all generated FKs, rejects cross-tenant connections and cross-dataset definitions", async () => {
    const run = await prepare();
    await expect(fixture.pool.query("UPDATE klaviyo_snapshot_run SET organization_id='another-org' WHERE id=$1", [run.id])).rejects.toMatchObject({ code: "23503" });
    const definition = await store.configureSnapshotDefinition({ scope, dataset: "campaigns", dailyEnabled: true, now });
    await expect(fixture.pool.query("UPDATE klaviyo_snapshot_run SET definition_id=$1 WHERE id=$2", [definition.id, run.id])).rejects.toMatchObject({ code: "23503" });
    const constraint = await fixture.pool.query("SELECT conname FROM pg_constraint WHERE conname LIKE 'klaviyo_snapshot_%' AND contype='f'");
    expect(constraint.rowCount).toBe(8);
  });
  it("enforces content kind and tenant composite foreign keys", async () => {
    const a = await prepare(); await page(a, [metric()]);
    const [record] = await fixture.db.select().from(records);
    await expect(fixture.pool.query("UPDATE klaviyo_snapshot_record SET resource_kind='campaign' WHERE id=$1", [record.id])).rejects.toMatchObject({ code: "23503" });
    const other = { organizationId: "other-org", storeId: "other-store", connectionId: "other-connection" };
    await seedSnapshotTestConnection(fixture.pool, other);
    await expect(fixture.pool.query("UPDATE klaviyo_snapshot_content SET organization_id=$1,shopify_store_id=$2,connection_id=$3 WHERE id=$4", [other.organizationId, other.storeId, other.connectionId, record.contentId])).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects SQL NULL loopholes in definitions", async () => {
    const definition = await store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["MetricA"], dailyEnabled: true, now });
    await expect(fixture.pool.query("UPDATE klaviyo_snapshot_definition SET rolling_days=NULL WHERE id=$1", [definition.id])).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.pool.query("UPDATE klaviyo_snapshot_definition SET selected_metric_ids=NULL WHERE id=$1", [definition.id])).rejects.toMatchObject({ code: "23514" });
  });
  it("validates configuration and canonicalizes metric sets without mutating the definition on one-off refresh", async () => {
    await expect(store.configureSnapshotDefinition({ scope, dataset: "events", dailyEnabled: true, now })).rejects.toThrow();
    await expect(store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["A", "A"], dailyEnabled: true, now })).rejects.toThrow();
    await expect(store.configureSnapshotDefinition({ scope, dataset: "metrics", dailyEnabled: true, window: { mode: "rolling_days", rollingDays: 7 }, now })).rejects.toThrow();
    await expect(store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["A"], dailyEnabled: true, window: { mode: "fixed", from: new Date("invalid"), to: now }, now })).rejects.toThrow();
    const definition = await store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["B", "A"], dailyEnabled: true, now });
    expect(definition.selectedMetricIds).toEqual(["A", "B"]);
    const result = await store.requestSnapshotRefresh({ scope, dataset: "events", oneOff: { metricIds: ["MetricA"], since: eventScope.dataset === "events" ? eventScope.since : "", until: "2026-09-07T00:00:00Z" }, now });
    expect(result.kind).toBe("started");
    expect((await store.listSnapshotDefinitions(scope))[0]).toEqual(definition);
  });
  it("allows manual catalogs without silently enabling daily work", async () => {
    const result = await store.requestSnapshotRefresh({ scope, dataset: "metrics", now });
    expect(result.kind).toBe("started");
    expect(await store.listSnapshotDefinitions(scope)).toEqual([]);
  });
  it("anchors recurring windows once in the connection timezone, including DST", async () => {
    const anchor = new Date("2026-03-09T12:00:00Z");
    const definition = await store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["MetricA"], dailyEnabled: true, window: { mode: "rolling_days", rollingDays: 2 }, now: anchor });
    expect(store.resolveDefinitionSnapshotScope(definition, anchor)).toEqual({ dataset: "events", metricIds: ["MetricA"], since: "2026-03-08T05:00:00.000Z", until: anchor.toISOString() });
    const result = await store.requestSnapshotRefresh({ scope, dataset: "events", now: anchor });
    const run = (await store.loadSnapshotRun(result.snapshotRunId!)).row;
    await page(run, [], null, new Date(anchor.getTime() + 60_000));
    expect((await store.loadSnapshotRun(run.id)).row.resolvedScope).toEqual(run.resolvedScope);
    expect(run.anchorAt).toEqual(anchor);
    expect(run.accountId).toBe(`${scope.connectionId}-account`);
  });
  it("reuses canonical scopes and skips fresh fixed-scope daily work", async () => {
    const a = await prepare(eventScope);
    const b = await prepare({ ...eventScope, dataset: "events", metricIds: ["MetricA"], since: "2026-09-01T02:00:00+02:00", until: "2026-09-07T00:00:00Z" });
    expect(a.id).toBe(b.id);
    await page(a, []); await publish(a);
    expect(await store.prepareSnapshotRun({ scope, dataset: "events", resolvedScope: eventScope, triggerType: "daily", now: later(1) })).toMatchObject({ kind: "fresh" });
  });
  it("never exposes staging or failed pages; successful empty is published", async () => {
    const run = await prepare(); await page(run, [metric()], "more");
    expect(await rows(run.id)).toEqual([]);
    await expect(publish(run)).rejects.toThrow("not complete");
    await store.failSnapshotRun({ scope, snapshotRunId: run.id, code: "failed", now });
    expect(await rows(run.id)).toEqual([]);
    const empty = await prepare(undefined, later(1)); await page(empty, [], null, later(1));
    expect(await publish(empty, later(1))).toMatchObject({ published: true, recordCount: 0 });
    expect((await store.getSnapshotSyncStatus(scope)).datasets.find(d => d.dataset === "metrics")?.current[0].recordCount).toBe(0);
  });
  it("atomically commits page/checkpoint; exact final-page retry does not double count", async () => {
    const run = await prepare();
    expect(await page(run, [metric(), metric()])).toEqual({ committed: true, inserted: 1, suppressed: 0 });
    expect(await page(run, [metric()])).toEqual({ committed: false, reason: "checkpoint_moved" });
    const updated = (await store.loadSnapshotRun(run.id)).row;
    expect(updated.pageCount).toBe(1); expect(updated.recordCount).toBe(1);
    expect(await count("klaviyo_snapshot_content")).toBe(1);
  });
  it("overlapping pages preserve identical identities but roll back changed duplicate payloads without orphan content", async () => {
    const run = await prepare(); await page(run, [metric()], "more");
    const next = (await store.loadSnapshotRun(run.id)).row;
    await expect(page(next, [metric("A", "changed")])).rejects.toThrow("conflicting duplicate");
    expect((await store.loadSnapshotRun(run.id)).row.checkpoint).toEqual(next.checkpoint);
    expect(await count("klaviyo_snapshot_content")).toBe(1);
    expect(await page(next, [metric(), metric("B", null)])).toMatchObject({ inserted: 1 });
    await publish(next);
    expect((await rows(run.id)).map(r => r.content)).toEqual([metric().content, metric("B", null).content]);
  });
  it("deduplicates campaigns repeated across channel/archive pages and rejects changing observations", async () => {
    const run = await prepare({ dataset: "campaigns" });
    const content = { campaignId: "C", name: "Shared campaign", status: "Draft", archived: false,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), scheduledAt: null, sendTime: null };
    const campaign: KlaviyoStagedSnapshotRecord = { resourceKind: "campaign", providerIdentity: "C", orderingKey: "C", content };
    await page(run, [campaign], "emailCursor");
    const second = (await store.loadSnapshotRun(run.id)).row;
    expect(await page(second, [campaign], "smsCursor")).toMatchObject({ inserted: 0 });
    const third = (await store.loadSnapshotRun(run.id)).row;
    await expect(page(third, [{ ...campaign, content: { ...content, name: "Changed during collection" } }]))
      .rejects.toThrow("conflicting duplicate");
    expect((await store.loadSnapshotRun(run.id)).row).toMatchObject({ checkpoint: third.checkpoint, recordCount: 1 });
    expect(await count("klaviyo_snapshot_content")).toBe(1);
    expect(await rows(run.id)).toEqual([]);
    await store.failSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, code: "failed", now });
    expect((await store.loadSnapshotRun(run.id)).row.state).toBe("failed");
  });
  it("simultaneous page retries have one commit", async () => {
    const run = await prepare();
    const result = await Promise.all([page(run, [metric()]), page(run, [metric()])]);
    expect(result.filter(r => r.committed)).toHaveLength(1);
    expect(await count("klaviyo_snapshot_record")).toBe(1);
  });
  it("rejects stale leases, reaps expired runs, and cannot fail a successor run", async () => {
    const old = await prepare();
    const expired = later(store.KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS);
    await expect(page(old, [], null, expired)).rejects.toThrow("lease expired");
    const successor = await prepare(undefined, expired);
    expect(successor.id).not.toBe(old.id);
    expect(await store.failSnapshotRun({ scope, snapshotRunId: old.id, leaseToken: old.leaseToken, code: "failed", now: expired })).toEqual({ changed: false });
    expect((await store.loadSnapshotRun(successor.id)).row.state).toBe("running");
    await expect(page(old, [], null, expired)).rejects.toThrow("not active");
  });
  it("fences same-run lease takeover and old worker failure; bounded handoff releases ownership", async () => {
    const run = await prepare();
    const a = await store.claimSnapshotLease({ scope, snapshotRunId: run.id, owner: "task-a", now });
    expect(a).toBeTruthy();
    expect(await store.claimSnapshotLease({ scope, snapshotRunId: run.id, owner: "task-b", now })).toBeNull();
    const expired = later(store.KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS);
    const b = await store.claimSnapshotLease({ scope, snapshotRunId: run.id, owner: "task-b", now: expired });
    expect(b).toBeTruthy(); expect(b).not.toBe(a);
    await expect(page({ ...run, leaseToken: a! }, [], null, expired)).rejects.toThrow("not active");
    expect(await store.failSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: a!, code: "failed", now: expired })).toEqual({ changed: false });
    expect(await store.failSnapshotRun({ scope, snapshotRunId: run.id, code: "failed", now: expired })).toEqual({ changed: false });
    await store.releaseSnapshotLease({ scope, snapshotRunId: run.id, leaseToken: b! });
    expect(await store.claimSnapshotLease({ scope, snapshotRunId: run.id, owner: "task-c", now: expired })).toBeTruthy();
  });
  it("configuration changes prevent publication and preserve prior good history", async () => {
    const old = await prepare(); await page(old, [metric()]); await publish(old);
    await store.configureSnapshotDefinition({ scope, dataset: "metrics", dailyEnabled: true, now });
    const prepared = await store.requestSnapshotRefresh({ scope, dataset: "metrics", now: later(1) });
    const run = (await store.loadSnapshotRun(prepared.snapshotRunId!)).row;
    await page(run, [metric("B")], null, later(1));
    await store.configureSnapshotDefinition({ scope, dataset: "metrics", dailyEnabled: false, now: later(2) });
    expect(await publish(run, later(2))).toEqual({ published: false, reason: "superseded" });
    expect((await store.loadSnapshotRun(old.id)).row.isCurrent).toBe(1);
    expect((await store.loadSnapshotRun(run.id)).row.state).toBe("failed");
  });
  it("atomic current swaps retain pinned keyset history and shared content", async () => {
    const old = await prepare(); await page(old, [metric("A"), metric("B"), metric("C")]); await publish(old);
    expect((await rows(old.id, 1))[0].providerIdentity).toBe("A");
    const next = await prepare(undefined, later(1)); await page(next, [metric("A"), metric("D")], null, later(1));
    const results = await Promise.allSettled([publish(next, later(1)), publish(next, later(1))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await rows(old.id, 10, { resourceKind: "metric", orderingKey: "A" })).map(r => r.providerIdentity)).toEqual(["B", "C"]);
    expect(await count("klaviyo_snapshot_content")).toBe(4);
    const published = await fixture.db.select().from(runs).where(eq(runs.state, "published"));
    expect(published.filter(r => r.isCurrent)).toHaveLength(1);
    expect(published).toHaveLength(2);
    expect((await store.listSnapshotRunSummaries({ scope, dataset: "metrics", limit: 10, cursor: null })).items).toHaveLength(2);
  });
  it("rolls back the current-pointer swap when publication fails inside PostgreSQL", async () => {
    const old = await prepare(); await page(old, [metric()]); await publish(old);
    const next = await prepare(undefined, later(1)); await page(next, [metric("B")], null, later(1));
    await fixture.pool.query(`CREATE FUNCTION snapshot_test_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'published' AND OLD.state = 'running' THEN RAISE EXCEPTION 'synthetic publication failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER snapshot_test_fail_publish BEFORE UPDATE ON klaviyo_snapshot_run FOR EACH ROW EXECUTE FUNCTION snapshot_test_fail_publish()`);
    try {
      await expect(publish(next, later(1))).rejects.toThrow();
      expect((await store.loadSnapshotRun(old.id)).row.isCurrent).toBe(1);
      expect((await store.loadSnapshotRun(next.id)).row).toMatchObject({ state: "running", isCurrent: 0 });
    } finally {
      await fixture.pool.query("DROP TRIGGER snapshot_test_fail_publish ON klaviyo_snapshot_run; DROP FUNCTION snapshot_test_fail_publish()");
    }
    expect(await publish(next, later(1))).toMatchObject({ published: true });
  });
  it("privacy gates reject missing identity and same-version wrong key material without accepting content", async () => {
    const run = await prepare(eventScope);
    const unresolved = event(); delete unresolved.identity;
    await expect(page(run, [unresolved])).rejects.toThrow();
    const wrong = { ...keys, suppressionKey: { ...keys.suppressionKey, secret: Buffer.alloc(32, 99) } };
    await expect(store.commitSnapshotPage({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, expectedCheckpoint: run.checkpoint!, nextCheckpoint: { ...run.checkpoint!, page: 1 }, records: [event()], privacyKeys: wrong, now })).rejects.toThrow();
    expect((await store.loadSnapshotRun(run.id)).row.state).toBe("failed");
    expect(await count("klaviyo_snapshot_content")).toBe(0);
  });
  it("deduplicates private associations and stores no plaintext email in payloads/checkpoints", async () => {
    const run = await prepare(eventScope);
    const events = Array.from({ length: 200 }, (_, index) => event(`E${String(index).padStart(3, "0")}`));
    expect(await page(run, events)).toEqual({ committed: true, inserted: 200, suppressed: 0 });
    await publish(run);
    expect(await count("klaviyo_snapshot_profile_suppression")).toBe(1);
    expect(await count("klaviyo_snapshot_record")).toBe(200);
    const dump = await fixture.pool.query("SELECT row_to_json(t) FROM klaviyo_snapshot_content t UNION ALL SELECT row_to_json(t) FROM klaviyo_snapshot_run t UNION ALL SELECT row_to_json(t) FROM klaviyo_snapshot_profile_suppression t");
    expect(JSON.stringify(dump.rows)).not.toContain("snapshot-only@example.test");
    expect((await rows(run.id))[0].content).toEqual(events[0].content);
  });
  it("email erasure before the first collection prevents persistence and a later changed-email replay", async () => {
    await tombstone("snapshot-only@example.test");
    const run = await prepare(eventScope);
    expect(await page(run, [event()])).toEqual({ committed: true, inserted: 0, suppressed: 1 });
    await publish(run);
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    expect(await count("klaviyo_snapshot_profile_suppression")).toBe(0);
    const changedEmail = await prepare(eventScope, later(1));
    expect(await page(changedEmail, [event("E2", "changed@example.test")], null, later(1)))
      .toEqual({ committed: true, inserted: 0, suppressed: 1 });
    await publish(changedEmail, later(1));
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    expect(await count("klaviyo_snapshot_profile_suppression")).toBe(0);
  });
  it("pre-ingestion email erasure binds a durable profile tombstone before an email change", async () => {
    await tombstone("snapshot-only@example.test");
    const a = await prepare(eventScope);
    expect(await page(a, [event(), event("E2", "changed@example.test")])).toMatchObject({ inserted: 0, suppressed: 2 });
    await publish(a);
    expect((await fixture.pool.query("SELECT kind FROM identity_erasure_suppression ORDER BY kind")).rows)
      .toEqual([{ kind: "email" }, { kind: "klaviyo_profile_id" }]);
    const b = await prepare(eventScope, later(1));
    expect(await page(b, [event("E3", "changed@example.test")], null, later(1))).toMatchObject({ inserted: 0, suppressed: 1 });
    await publish(b, later(1));
    expect(await count("klaviyo_snapshot_record")).toBe(0);
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    expect(await count("klaviyo_snapshot_profile_suppression")).toBe(0);
  });
  it("a newly identified erased profile scrubs existing history, staging, private associations and canonical events", async () => {
    const historical = await prepare(eventScope); await page(historical, [event("old", "previous@example.test")]); await publish(historical);
    const staged = await prepare(eventScope, later(1)); await page(staged, [event("staged", "previous@example.test")], "more", later(1));
    await fixture.pool.query(`INSERT INTO klaviyo_metric(id,organization_id,shopify_store_id,connection_id,external_metric_id,name,canonical_kind,ingestion_enabled,api_revision)
      VALUES ('canonical-metric',$1,$2,$3,'MetricA','Placed Order','placed_order',1,'2026-07-15')`, [scope.organizationId, scope.storeId, scope.connectionId]);
    await fixture.pool.query(`INSERT INTO klaviyo_event(id,organization_id,shopify_store_id,connection_id,metric_id,external_event_id,occurred_at,profile_id,attribution_relationship_ids,redacted_properties,key_type_fingerprint,warnings,product_evidence_completeness,source_checksum,api_revision)
      VALUES ('canonical-event',$1,$2,$3,'canonical-metric','canonical-event',now(),'Profile1','[]','{}','[]','[]','unavailable','synthetic','2026-07-15')`, [scope.organizationId, scope.storeId, scope.connectionId]);
    await tombstone("snapshot-only@example.test");
    const resumed = (await store.loadSnapshotRun(staged.id)).row;
    expect(await page(resumed, [event("newly-linked")], null, later(2))).toMatchObject({ inserted: 0, suppressed: 1 });
    for (const id of [historical.id, staged.id]) {
      expect((await store.loadSnapshotRun(id)).row).toMatchObject({ privacyAdjusted: 1, privacyRemovedCount: 1, recordCount: 0 });
    }
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    expect(await count("klaviyo_snapshot_profile_suppression")).toBe(0);
    expect((await fixture.pool.query("SELECT id FROM klaviyo_event")).rows).toEqual([]);
    await publish(resumed, later(2));
  });
  it("publication rechecks tombstones, erases historical/shared/staging content and marks counts once", async () => {
    const old = await prepare(eventScope); await page(old, [event()]); await publish(old);
    const next = await prepare(eventScope, later(1)); await page(next, [event()], null, later(1));
    expect(await count("klaviyo_snapshot_content")).toBe(1);
    await tombstone("snapshot-only@example.test");
    expect(await publish(next, later(2))).toMatchObject({ published: true, recordCount: 0, removedForPrivacy: 2 });
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    for (const id of [old.id, next.id]) {
      const row = (await store.loadSnapshotRun(id)).row;
      expect(row).toMatchObject({ privacyAdjusted: 1, recordCount: 0, privacyRemovedCount: 1 });
    }
  });
  it("retains changed-email associations, erases orphan content, and blocks replay with a new email", async () => {
    const a = await prepare(eventScope); await page(a, [event()]); await publish(a);
    const b = await prepare(eventScope, later(1)); await page(b, [event("E1", "new@example.test")], null, later(1)); await publish(b, later(1));
    expect(await count("klaviyo_snapshot_profile_suppression")).toBe(2);
    await fixture.db.insert(contents).values({ ...scope, resourceKind: "event", contentDigest: "f".repeat(64), content: event("orphan").content });
    await tombstone("snapshot-only@example.test", "Profile1");
    const erased = await locks.withKlaviyoStoreConnectionLock(scope, tx => store.eraseSnapshotProfileEvidence({ scope, profileIds: ["Profile1"], tx, now: later(2) }));
    expect(erased).toMatchObject({ recordsDeleted: 2, contentsDeleted: 2 });
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    const replay = await prepare(eventScope, later(3));
    expect(await page(replay, [event("E3", "third@example.test")], null, later(3))).toMatchObject({ inserted: 0, suppressed: 1 });
  });
  it("policy drift before publication fails closed without replacing good snapshots", async () => {
    const old = await prepare(eventScope); await page(old, []); await publish(old);
    const next = await prepare(eventScope, later(1)); await page(next, [event()], null, later(1));
    await fixture.pool.query("UPDATE identity_crypto_policy SET suppression_key_check='wrong'");
    await expect(publish(next, later(2))).rejects.toThrow();
    expect((await store.loadSnapshotRun(next.id)).row.state).toBe("failed");
    expect((await store.loadSnapshotRun(old.id)).row.isCurrent).toBe(1);
  });
  it("erasure and replay serialize under store→connection locks", async () => {
    const run = await prepare(eventScope); await page(run, [event()], "next");
    const next = (await store.loadSnapshotRun(run.id)).row;
    await Promise.all([
      locks.withKlaviyoStoreConnectionLock(scope, async tx => {
        const digests = computeErasureSuppressionDigests({ scope, key: keys.suppressionKey, email: "snapshot-only@example.test", klaviyoProfileId: "Profile1" });
        await tx.insert(identityErasureSuppressions).values(digests.map(d => ({ ...d, organizationId: scope.organizationId, storeId: scope.storeId })));
        await store.eraseSnapshotProfileEvidence({ scope, profileIds: ["Profile1"], tx, now });
      }),
      page(next, [event("E2")]),
    ]);
    await publish(next);
    expect(await count("klaviyo_snapshot_record")).toBe(0);
    expect(await count("klaviyo_snapshot_content")).toBe(0);
  });
  it("rejects records outside exact event scope or inconsistent privacy indexes", async () => {
    const run = await prepare(eventScope);
    await expect(page(run, [{ ...event(), profileId: "wrong" }])).rejects.toThrow();
    const outside = event(); outside.content.datetime = "2026-09-07T00:00:00Z"; outside.eventDatetime = String(outside.content.datetime); outside.orderingKey = JSON.stringify([new Date(outside.eventDatetime).toISOString(), outside.providerIdentity]);
    await expect(page(run, [outside])).rejects.toThrow("outside requested scope");
    expect(await count("klaviyo_snapshot_record")).toBe(0);
  });
  it("persists all 17 report statistics, exact wall windows and unverified completeness, never aggregate totals", async () => {
    const reportScope = { dataset: "campaign_values" as const, conversionMetricId: "Conversion1", since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" };
    const run = await prepare(reportScope);
    const providerWindow = snapshotReportProviderWindow(reportScope, "America/New_York");
    const stats = ["recipients", "delivered", "deliveryRate", "opensUnique", "openRate", "clicksUnique", "clickRate", "conversions", "conversionRate", "conversionValue", "revenuePerRecipient", "bounced", "bounceRate", "unsubscribes", "unsubscribeRate", "spamComplaints", "spamComplaintRate"];
    const content = { campaignId: "C", campaignMessageId: "M", sendChannel: "email", conversionMetricId: "Conversion1", timeframeStart: providerWindow.start, timeframeEnd: providerWindow.end, ...Object.fromEntries(stats.map((key, i) => [key, i === 0 ? 0 : i === 1 ? null : i / 100])) };
    await expect(page(run, [{ resourceKind: "campaign_value_row", providerIdentity: JSON.stringify(["C", "M", "email"]), orderingKey: JSON.stringify(["C", "M", "email"]), content }])).rejects.toThrow("metadata");
    await store.commitSnapshotPage({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, expectedCheckpoint: run.checkpoint!, nextCheckpoint: { ...run.checkpoint!, page: 1 }, records: [{ resourceKind: "campaign_value_row", providerIdentity: JSON.stringify(["C", "M", "email"]), orderingKey: JSON.stringify(["C", "M", "email"]), content }], reportMetadata: { providerWindow, accountTimezone: "America/New_York", warnings: [...KLAVIYO_SNAPSHOT_REPORT_WARNINGS.slice(0, 3)] }, now });
    await expect(publish(run)).rejects.toThrow("cannot certify");
    await store.publishSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, providerCompleteness: "unverified", warnings: [...KLAVIYO_SNAPSHOT_REPORT_WARNINGS.slice(0, 3)], suppressionKey: null, now });
    expect((await rows(run.id))[0].content).toEqual(content);
    expect((await store.loadSnapshotRun(run.id)).row).toMatchObject({ providerCompleteness: "unverified", providerWindowStart: providerWindow.start, providerWindowEnd: providerWindow.end });
  });
  it("round-trips complete campaign and message contracts together", async () => {
    const run = await prepare({ dataset: "campaigns" });
    const campaign = { campaignId: "C", name: "Campaign", status: "Draft", archived: false, createdAt: now.toISOString(), updatedAt: now.toISOString(), scheduledAt: null, sendTime: null };
    const message = { messageId: "M", campaignId: "C", channel: "email", subject: "Subject", previewText: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    await page(run, [{ resourceKind: "campaign", providerIdentity: "C", orderingKey: "C", content: campaign }, { resourceKind: "campaign_message", providerIdentity: "M", orderingKey: "M", content: message }]); await publish(run);
    expect((await rows(run.id)).map(row => row.content)).toEqual([campaign, message]);
  });
  it.each([
    ["page_count", KLAVIYO_SNAPSHOT_MAX_PAGES_PER_RUN],
    ["record_count", KLAVIYO_SNAPSHOT_MAX_RECORDS_PER_RUN],
    ["bytes_staged", KLAVIYO_SNAPSHOT_MAX_RUN_BYTES],
  ] as const)("durably fails a run at the %s bound without changing its checkpoint", async (column, value) => {
    const run = await prepare();
    await fixture.pool.query(`UPDATE klaviyo_snapshot_run SET ${column}=$1${column === "page_count" ? ",checkpoint=jsonb_set(jsonb_set(checkpoint,'{page}',to_jsonb($1::int)),'{continuation}','\"more\"'::jsonb)" : ""} WHERE id=$2`, [value, run.id]);
    const loaded = (await store.loadSnapshotRun(run.id)).row;
    await expect(page(loaded, [metric()])).rejects.toThrow();
    expect((await store.loadSnapshotRun(run.id)).row).toMatchObject({ state: "failed", checkpoint: loaded.checkpoint });
    expect(await count("klaviyo_snapshot_content")).toBe(0);
  });
  it("caps runtime even if a worker is still heartbeating", async () => {
    const run = await prepare();
    await fixture.pool.query("UPDATE klaviyo_snapshot_run SET started_at=$1 WHERE id=$2", [new Date(now.getTime() - KLAVIYO_SNAPSHOT_MAX_RUN_DURATION_MS - 1).toISOString(), run.id]);
    await expect(page(run, [metric()])).rejects.toThrow();
    expect((await store.loadSnapshotRun(run.id)).row.state).toBe("failed");
  });
  it("rejects publication by a worker whose final page lease has expired", async () => {
    const run = await prepare(); await page(run, []);
    await expect(publish(run, later(store.KLAVIYO_SNAPSHOT_RUN_STALE_AFTER_MS))).rejects.toThrow("lease expired");
    expect((await store.loadSnapshotRun(run.id)).row.isCurrent).toBe(0);
  });
  it("same task retry rotates its fence and equal-time sequential publications remain valid", async () => {
    const run = await prepare();
    const first = await store.claimSnapshotLease({ scope, snapshotRunId: run.id, owner: "retry-task", now });
    const second = await store.claimSnapshotLease({ scope, snapshotRunId: run.id, owner: "retry-task", now });
    expect(first).not.toBe(second);
    expect(await store.failSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: first!, code: "failed", now })).toEqual({ changed: false });
    const claimed = { ...run, leaseToken: second! }; await page(claimed, []); await publish(claimed);
    const next = await prepare(); await page(next, [metric()]);
    expect(await publish(next)).toMatchObject({ published: true });
  });
  it("rejects preparation/publication after the connection binding changes", async () => {
    const run = await prepare(); await page(run, []);
    await fixture.pool.query("UPDATE klaviyo_connection SET klaviyo_account_id='rebound' WHERE id=$1", [scope.connectionId]);
    await expect(publish(run)).rejects.toThrow("binding changed");
    await fixture.pool.query("UPDATE klaviyo_connection SET status='disabled' WHERE id=$1", [scope.connectionId]);
    await expect(prepare()).rejects.toThrow("not ready");
  });
  it("rejects preparation with a stale configuration version and isolates daily definition failures", async () => {
    const definition = await store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["MetricA"], dailyEnabled: true, now });
    await store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["MetricA"], dailyEnabled: false, now });
    await expect(store.prepareSnapshotRun({ scope, dataset: "events", resolvedScope: eventScope, definitionId: definition.id, configurationVersion: definition.configurationVersion, triggerType: "daily", now })).rejects.toThrow("configuration changed");
    await store.configureSnapshotDefinition({ scope, dataset: "metrics", dailyEnabled: true, now });
    const result = await store.prepareDailySnapshotRuns({ scope, now });
    expect(result.map(r => r.dataset)).toEqual(["metrics"]);
    expect(result[0]).toMatchObject({ kind: "started" });
  });
  it.each(["events", "campaign_values", "metrics"] as const)("daily %s occurrences reuse exact scopes and terminal runs while manual refresh remains independent", async dataset => {
    const scheduled = new Date("2026-09-07T20:30:00Z");
    const invoked = new Date(scheduled.getTime() + 5000);
    const configure = () => store.configureSnapshotDefinition({ scope, dataset, dailyEnabled: true, now: invoked,
      ...(dataset === "events" ? { eventsMetricIds: ["MetricA"] } : dataset === "campaign_values" ? { conversionMetricId: "MetricA" } : {}),
    });
    await configure();
    const [first, retry] = await Promise.all([
      store.prepareDailySnapshotRuns({ scope, now: invoked }),
      store.prepareDailySnapshotRuns({ scope, now: new Date(invoked.getTime() + 1000) }),
    ]);
    expect(first[0].snapshotRunId).toBe(retry[0].snapshotRunId);
    const run = (await store.loadSnapshotRun(first[0].snapshotRunId!)).row;
    expect(run.anchorAt).toEqual(scheduled);
    if ("until" in run.resolvedScope) expect(run.resolvedScope.until).toBe(scheduled.toISOString());
    await store.failSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, code: "failed", now: invoked });
    expect((await store.prepareDailySnapshotRuns({ scope, now: new Date(invoked.getTime() + 2000) }))[0])
      .toMatchObject({ kind: "reused", snapshotRunId: run.id });
    const manual = await store.requestSnapshotRefresh({ scope, dataset, now: invoked });
    expect(manual.kind).toBe("started"); expect(manual.snapshotRunId).not.toBe(run.id);
    await store.failSnapshotRun({ scope, snapshotRunId: manual.snapshotRunId!, code: "failed", now: invoked });
    const nextDay = await store.prepareDailySnapshotRuns({ scope, now: new Date(invoked.getTime() + 86400000) });
    expect(nextDay[0].kind).toBe("started"); expect(nextDay[0].snapshotRunId).not.toBe(run.id);
    await configure();
    const newVersion = await store.prepareDailySnapshotRuns({ scope, now: invoked });
    expect(newVersion[0].kind).toBe("started"); expect(newVersion[0].snapshotRunId).not.toBe(run.id);
  });
  it.each(["events", "campaign_values"] as const)("completed daily %s snapshots are reused rather than collecting a moving until", async dataset => {
    const invoked = new Date("2026-09-07T20:30:05Z");
    await store.configureSnapshotDefinition({ scope, dataset, dailyEnabled: true, now: invoked,
      ...(dataset === "events" ? { eventsMetricIds: ["MetricA"] } : { conversionMetricId: "MetricA" }) });
    const [prepared] = await store.prepareDailySnapshotRuns({ scope, now: invoked });
    const run = (await store.loadSnapshotRun(prepared.snapshotRunId!)).row;
    if (run.resolvedScope.dataset === "campaign_values") {
      const warnings = [...KLAVIYO_SNAPSHOT_REPORT_WARNINGS.slice(0, 3)];
      await store.commitSnapshotPage({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken,
        expectedCheckpoint: run.checkpoint!, nextCheckpoint: { ...run.checkpoint!, page: 1 }, records: [], now: invoked,
        reportMetadata: { providerWindow: snapshotReportProviderWindow(run.resolvedScope, run.timezone!), accountTimezone: run.timezone!, warnings } });
      await store.publishSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken,
        providerCompleteness: "unverified", warnings, suppressionKey: null, now: invoked });
    } else {
      await page(run, [], null, invoked); await publish(run, invoked);
    }
    const [retry] = await store.prepareDailySnapshotRuns({ scope, now: new Date(invoked.getTime() + 30_000) });
    expect(retry).toMatchObject({ kind: "reused", snapshotRunId: run.id });
    expect((await fixture.pool.query("SELECT count(*) FROM klaviyo_snapshot_run")).rows[0].count).toBe("1");
  });
  it("a refresh after reconfiguration supersedes the obsolete live run immediately", async () => {
    await store.configureSnapshotDefinition({ scope, dataset: "metrics", dailyEnabled: true, now });
    const old = await store.requestSnapshotRefresh({ scope, dataset: "metrics", now });
    await store.configureSnapshotDefinition({ scope, dataset: "metrics", dailyEnabled: false, now: later(1) });
    const next = await store.requestSnapshotRefresh({ scope, dataset: "metrics", now: later(1) });
    expect(next.kind).toBe("started"); expect(next.snapshotRunId).not.toBe(old.snapshotRunId);
    expect((await store.loadSnapshotRun(old.snapshotRunId!)).row).toMatchObject({ state: "failed", errorCode: "KLAVIYO_SNAPSHOT_SUPERSEDED" });
  });
  it("rejects known-uncollectable report pagination and arbitrary warnings before storing content", async () => {
    const reportScope = { dataset: "campaign_values" as const, conversionMetricId: "M1", since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" };
    const run = await prepare(reportScope);
    const commit = (warning: string) => store.commitSnapshotPage({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken,
      expectedCheckpoint: run.checkpoint!, nextCheckpoint: { ...run.checkpoint!, page: 1 }, records: [],
      reportMetadata: { providerWindow: snapshotReportProviderWindow(reportScope, "America/New_York"), accountTimezone: "America/New_York",
        warnings: [...KLAVIYO_SNAPSHOT_REPORT_WARNINGS.slice(0, 3), warning] }, now });
    await expect(commit("Provider indicated possible additional data using undocumented pagination metadata; it cannot be followed safely by this reader.")).rejects.toThrow();
    await expect(commit("provider error body with secret")).rejects.toThrow();
    expect((await store.loadSnapshotRun(run.id)).row.pageCount).toBe(0);
    expect(await count("klaviyo_snapshot_content")).toBe(0);
  });
  it("rejects invalid page transitions, ordering collisions and raw extra record fields transactionally", async () => {
    const run = await prepare();
    await expect(store.commitSnapshotPage({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, expectedCheckpoint: run.checkpoint!, nextCheckpoint: { ...run.checkpoint!, page: 2 }, records: [], now })).rejects.toThrow("transition");
    await expect(page(run, [metric(), { ...metric("B"), orderingKey: "A" }])).rejects.toThrow();
    await expect(page(run, [{ ...metric(), content: { ...metric().content, rawEmail: "must-not-persist@example.test" } }])).rejects.toThrow();
    expect(await count("klaviyo_snapshot_content")).toBe(0);
    expect((await store.loadSnapshotRun(run.id)).row.pageCount).toBe(0);
  });
  it("missing publication keys and unverifiable external-only profiles fail closed", async () => {
    const run = await prepare(eventScope);
    const external = event("E1", "irrelevant@example.test", null); external.content.profileExternalId = "opaque";
    await expect(page(run, [external])).rejects.toThrow();
    await page(run, []);
    await expect(store.publishSnapshotRun({ scope, snapshotRunId: run.id, leaseToken: run.leaseToken, providerCompleteness: "complete", warnings: [], suppressionKey: keys.suppressionKey, now })).rejects.toThrow();
    expect((await store.loadSnapshotRun(run.id)).row.state).toBe("failed");
  });
  it("cross-tenant history is absent and privacy erasure cannot affect another connection", async () => {
    const run = await prepare(eventScope); await page(run, [event()]); await publish(run);
    const other = { organizationId: "other-org", storeId: "other-store", connectionId: "other-connection" };
    await seedSnapshotTestConnection(fixture.pool, other);
    expect((await store.listSnapshotRunSummaries({ scope: other, limit: 10, cursor: null })).items).toEqual([]);
    const result = await locks.withKlaviyoStoreConnectionLock(other, tx => store.eraseSnapshotProfileEvidence({ scope: other, profileIds: ["Profile1"], tx, now }));
    expect(result.recordsDeleted).toBe(0);
    expect(await rows(run.id)).toHaveLength(1);
  });
  it("uninstall cascades snapshot tables but preserves store evidence and tombstones", async () => {
    await store.configureSnapshotDefinition({ scope, dataset: "events", eventsMetricIds: ["MetricA"], dailyEnabled: true, now });
    const run = await prepare(eventScope); await page(run, [event()]); await publish(run);
    await tombstone("different@example.test");
    await fixture.pool.query("INSERT INTO shopify_order (id,organization_id,store_id,shopify_order_id,order_created_at,order_day,net_sales) VALUES ('commerce',$1,$2,'123',now(),current_date,17.5)", [scope.organizationId, scope.storeId]);
    await fixture.pool.query("DELETE FROM klaviyo_connection WHERE id=$1", [scope.connectionId]);
    expect(Number((await fixture.pool.query("SELECT count(*) FROM shopify_order")).rows[0].count)).toBe(1);
    for (const table of ["klaviyo_snapshot_definition", "klaviyo_snapshot_run", "klaviyo_snapshot_record", "klaviyo_snapshot_content", "klaviyo_snapshot_profile_suppression"]) {
      expect(Number((await fixture.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)).toBe(0);
    }
    expect(Number((await fixture.pool.query("SELECT count(*) FROM identity_erasure_suppression")).rows[0].count)).toBe(1);
    expect(Number((await fixture.pool.query("SELECT count(*) FROM shopify_store")).rows[0].count)).toBe(1);
  });
});
