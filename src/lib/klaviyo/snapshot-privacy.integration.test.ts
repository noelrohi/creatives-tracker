import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createSnapshotTestDatabase, seedSnapshotTestConnection, SNAPSHOT_TEST_KEYS, SNAPSHOT_TEST_NOW } from "./snapshot-test-harness";
import { computeErasureSuppressionDigests, computeIdentityDigests } from "@/lib/identity-hmac";
import type { KlaviyoStagedSnapshotRecord } from "./snapshot-contracts";

let harness: Awaited<ReturnType<typeof createSnapshotTestDatabase>>;
let pool: Pool;
vi.mock("@/db", () => ({ get db() { return harness.db; } }));
const { eraseShopifySubjectByEmail } = await import("@/lib/shopify-privacy");
const { commitSnapshotPage, publishSnapshotRun } = await import("./snapshot-store");
const scope = { organizationId: "org", storeId: "store", connectionId: "connection" };
const { keyring, suppressionKey } = SNAPSHOT_TEST_KEYS;
const now = SNAPSHOT_TEST_NOW;
const email = "synthetic-old@example.invalid";
const newEmail = "synthetic-new@example.invalid";
const erase = () => eraseShopifySubjectByEmail({ scope, email, keyring, suppressionKey });
const checkpoint = { dataset: "events" as const, page: 0, continuation: null };

const enabled = process.env.SNAPSHOT_TEST_DATABASE === "1";
describe.skipIf(!enabled)("snapshot privacy on real PostgreSQL", () => {
beforeAll(async () => {
  harness = await createSnapshotTestDatabase();
  pool = harness.pool;
  expect((await pool.query("show server_version")).rows[0].server_version).toMatch(/^16\./);
}, 120_000);
afterAll(async () => {
  await harness?.close();
});
beforeEach(async () => {
  await harness.reset();
  await seedSnapshotTestConnection(pool, scope, "UTC");
});
async function run(id: string) {
  await pool.query(`INSERT INTO klaviyo_snapshot_run(id,organization_id,shopify_store_id,connection_id,dataset,scope_fingerprint,resolved_scope,configuration_version,trigger_type,lease_token,checkpoint,api_revision,account_id,requested_from,requested_to,started_at,heartbeat_at,anchor_at) VALUES ($1,'org','store','connection','events',$1,'{"dataset":"events","metricIds":["metric"],"since":"2026-09-06T00:00:00Z","until":"2026-09-07T00:00:00Z"}',0,'manual','lease',$2,'2026-07-15','connection-account','2026-09-06','2026-09-07',$3,$3,$3)`, [id, checkpoint, now]);
}
function record(subjectEmail = email): KlaviyoStagedSnapshotRecord {
  const digests = computeErasureSuppressionDigests({ scope, key: suppressionKey, email: subjectEmail, klaviyoProfileId: "profile" });
  return { resourceKind: "event", providerIdentity: "event", orderingKey: JSON.stringify(["2026-09-06T12:00:00.000Z", "event"]), profileId: "profile", metricId: "metric", eventDatetime: "2026-09-06T12:00:00Z", content: { eventId: "event", metricId: "metric", metricName: null, datetime: "2026-09-06T12:00:00Z", profileId: "profile", profileExternalId: "not-a-shopify-link", value: null, uuid: null, orderId: null, currency: null }, identity: { keyVersion: suppressionKey.version, emailDigest: digests.find(d => d.kind === "email")!.digest, profileDigest: digests.find(d => d.kind === "klaviyo_profile_id")!.digest } };
}
const commit = (id: string, subjectEmail = email) => commitSnapshotPage({ scope, snapshotRunId: id, leaseToken: "lease", expectedCheckpoint: checkpoint, nextCheckpoint: { ...checkpoint, page: 1 }, records: [record(subjectEmail)], privacyKeys: { keyring, suppressionKey }, now });
const publish = (id: string) => publishSnapshotRun({ scope, snapshotRunId: id, leaseToken: "lease", suppressionKey, privacyKeys: { keyring, suppressionKey }, providerCompleteness: "complete", warnings: [], now });
async function assertErased() {
  for (const table of ["klaviyo_snapshot_record", "klaviyo_snapshot_content"]) expect((await pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
  const tombstones = (await pool.query("SELECT kind,digest FROM identity_erasure_suppression ORDER BY kind")).rows;
  expect(tombstones.map(r => r.kind)).toEqual(["email", "klaviyo_profile_id"]);
  expect(JSON.stringify(tombstones)).not.toContain(email);
  expect(JSON.stringify(tombstones)).not.toContain("profile\"");
}
it("erases staging and published shared history through the OLD email association", async () => {
  await run("published"); await commit("published"); await publish("published");
  await run("staging"); await commit("staging", newEmail);
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_content")).rowCount).toBe(1);
  const associations = (await pool.query("SELECT * FROM klaviyo_snapshot_profile_suppression")).rows;
  expect(associations).toHaveLength(2);
  expect(JSON.stringify(associations)).not.toContain(email);
  expect(JSON.stringify(associations)).not.toContain(newEmail);
  expect((await erase()).klaviyoEventsErased).toBe(0);
  await assertErased();
  expect((await pool.query("SELECT record_count,privacy_adjusted,privacy_removed_count FROM klaviyo_snapshot_run")).rows).toEqual(Array(2).fill({ record_count: 0, privacy_adjusted: 1, privacy_removed_count: 1 }));
  await publish("staging");
  await erase(); await assertErased();
  await run("replay"); expect(await commit("replay", newEmail)).toMatchObject({ inserted: 0, suppressed: 1 });
});
it.each([email, newEmail])("erases canonical evidence under %s and snapshot history together, retaining tombstones", async (canonicalEmail) => {
  await run("canonical"); await commit("canonical"); await publish("canonical");
  await pool.query(`INSERT INTO klaviyo_metric(id,organization_id,shopify_store_id,connection_id,external_metric_id,name,canonical_kind,ingestion_enabled,api_revision) VALUES ('metric','org','store','connection','metric','Placed Order','placed_order',1,'2026-07-15')`);
  await pool.query(`INSERT INTO klaviyo_event(id,organization_id,shopify_store_id,connection_id,metric_id,external_event_id,occurred_at,profile_id,attribution_relationship_ids,redacted_properties,key_type_fingerprint,warnings,product_evidence_completeness,source_checksum,api_revision) VALUES ('canonical-event','org','store','connection','metric','canonical-event',now(),'profile','[]','{}','[]','[]','unavailable','synthetic','2026-07-15')`);
  const [digest] = computeIdentityDigests({ scope, email: canonicalEmail, keyring });
  await pool.query(`INSERT INTO source_identity_hmac(id,organization_id,store_id,source_kind,klaviyo_connection_id,klaviyo_event_id,key_version,digest,rotation_state) VALUES ('hmac','org','store','klaviyo_event','connection','canonical-event',$1,$2,'active')`, [digest.keyVersion, digest.digest]);
  expect((await erase()).klaviyoEventsErased).toBe(1);
  await assertErased();
  expect((await pool.query("SELECT * FROM klaviyo_event")).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM source_identity_hmac")).rows).toEqual([]);
  expect((await erase()).suppressionsUpserted).toBe(0);
  await assertErased();
});
it("rejects customer-ID-only erasure without inferring an authoritative link from external_id", async () => {
  await run("unresolved-customer");
  await commit("unresolved-customer");
  await publish("unresolved-customer");
  const before = (await pool.query("SELECT * FROM klaviyo_snapshot_content")).rows;
  expect(before[0].content.profileExternalId).toBe("not-a-shopify-link");
  const customerOnlyRequest = { scope, keyring, suppressionKey, shopifyCustomerId: "not-a-shopify-link" };
  // The supported API requires email; a runtime customer-only request must
  // reject too, never acknowledge erasure or guess a link from external_id.
  // @ts-expect-error Customer-only erasure has no authoritative identity resolver.
  await expect(eraseShopifySubjectByEmail(customerOnlyRequest)).rejects.toThrow();
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_content")).rows).toEqual(before);
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_record")).rowCount).toBe(1);
  expect((await pool.query("SELECT * FROM identity_erasure_suppression")).rowCount).toBe(0);
});
it("honors an email tombstone created before the first snapshot", async () => {
  expect((await erase()).suppressionsUpserted).toBe(1);
  await run("future");
  expect(await commit("future")).toMatchObject({ inserted: 0, suppressed: 1 });
  await publish("future");
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_record")).rows).toEqual([]);
});
it("fails closed and rolls back if the snapshot schema is unavailable", async () => {
  await pool.query("ALTER TABLE klaviyo_snapshot_profile_suppression RENAME TO hidden_snapshot_associations");
  try {
    await expect(erase()).rejects.toThrow("shopify_subject_erasure_failed");
    expect((await pool.query("SELECT * FROM identity_erasure_suppression")).rows).toEqual([]);
  } finally {
    await pool.query("ALTER TABLE hidden_snapshot_associations RENAME TO klaviyo_snapshot_profile_suppression");
  }
});
it("rejects unresolvable private association versions instead of reporting partial erasure", async () => {
  await run("version"); await commit("version");
  await pool.query("UPDATE klaviyo_snapshot_profile_suppression SET key_version = 'retired'");
  await expect(erase()).rejects.toThrow("identity_crypto_policy_conflict");
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_record")).rowCount).toBe(1);
  expect((await pool.query("SELECT * FROM identity_erasure_suppression")).rowCount).toBe(0);
});
it("concurrent collector/erasure converges without resurrection", async () => {
  await run("race");
  await Promise.all([commit("race"), erase()]);
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_record")).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM klaviyo_snapshot_content")).rows).toEqual([]);
  await publish("race");
  await run("retry"); expect(await commit("retry")).toMatchObject({ inserted: 0, suppressed: 1 });
});
});
