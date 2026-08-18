import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";
import { normalizeEventPage } from "@/lib/klaviyo/event-normalizer";
import {
  initialEventCheckpoint,
  orderCoreSourceContract,
  type NormalizedKlaviyoEvent,
} from "@/lib/klaviyo/types";

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

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function migrationStatements(fileName: string): string[] {
  return readFileSync(path.resolve(process.cwd(), "drizzle", fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const FIXTURE_DDL = [
  `CREATE TABLE organization (
     id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
     logo text, created_at timestamp NOT NULL, metadata text
   )`,
  `CREATE TABLE shopify_store (
     id text PRIMARY KEY, organization_id text NOT NULL,
     shop_domain text NOT NULL UNIQUE, access_token text,
     iana_timezone text NOT NULL, currency text, last_synced_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL
   )`,
  `CREATE TYPE attribution_bucket AS ENUM (
     'meta', 'google', 'klaviyo', 'tiktok', 'ai',
     'organic_direct', 'unattributed', 'untracked'
   )`,
  `CREATE TABLE shopify_order (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     shopify_order_id text NOT NULL, order_name text,
     order_created_at timestamp NOT NULL, order_updated_at timestamp,
     order_day date NOT NULL, net_sales numeric NOT NULL,
     taxes_included boolean, customer_journey jsonb,
     journey_ready boolean DEFAULT false NOT NULL, pending_since timestamp,
     last_click_utm_source text, last_click_utm_medium text,
     last_click_utm_campaign text, bucket attribution_bucket,
     bucket_rule_version integer, meta_verified boolean DEFAULT false NOT NULL,
     meta_campaign_id text, verification_pending boolean DEFAULT false NOT NULL,
     cancelled_at timestamp, cancel_reason text, order_source_name text,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_order_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_order_store_order_uniq UNIQUE (store_id, shopify_order_id)
   )`,
  `CREATE TABLE shopify_refund (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     order_id text NOT NULL, shopify_refund_id text NOT NULL,
     refund_day date NOT NULL, amount numeric NOT NULL,
     kind text DEFAULT 'refund' NOT NULL, refund_created_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_refund_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_order_id_shopify_order_id_fk
       FOREIGN KEY (order_id) REFERENCES shopify_order(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_store_refund_uniq UNIQUE (store_id, shopify_refund_id)
   )`,
  `CREATE TABLE shopify_sync_run (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     trigger_type text NOT NULL, phase text NOT NULL, date_from date, date_to date,
     result text, orders_synced integer, error text,
     requested_at timestamp DEFAULT now() NOT NULL, finished_at timestamp, meta jsonb,
     CONSTRAINT shopify_sync_run_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
  `CREATE TYPE finding_type AS ENUM (
     'meta_overclaim', 'unattributed_spike', 'broken_utm_template',
     'sync_failure', 'roas_below_target'
   )`,
  `CREATE TABLE finding (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text,
     type finding_type NOT NULL, fired_at timestamp DEFAULT now() NOT NULL,
     payload jsonb NOT NULL, created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT finding_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
];

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_privacy_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 6,
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const store = await import("@/lib/klaviyo/source-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = {
  organizationId: "org-a",
  storeId: "store-a",
  connectionId: "connection-a",
};

const SECRET_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
const SECRET_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";
const SECRET_S = "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M";
const keyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: SECRET_A,
  IDENTITY_HMAC_KEY_VERSION: "v1",
});
const wrongSecretKeyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: SECRET_B,
  IDENTITY_HMAC_KEY_VERSION: "v1",
});
const suppressionKey = parseErasureSuppressionKey({
  IDENTITY_ERASURE_HMAC_SECRET: SECRET_S,
  IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
} as unknown as NodeJS.ProcessEnv);

const contract = orderCoreSourceContract();
const checkpoint0 = initialEventCheckpoint();

function identityEvent(
  externalEventId: string,
  email: string,
): NormalizedKlaviyoEvent {
  const [event] = normalizeEventPage({
    metricRowId: "metric-row-placed",
    externalMetricId: "metric-external-placed",
    metricKind: "placed_order",
    apiRevision: "2026-07-15",
    merchantHosts: new Set(["a.example.com"]),
    approvedAliases: {
      orderId: "OrderId",
      uniqueEventId: "$event_id",
      productId: null,
      variantId: null,
      sku: null,
      productName: null,
      variantName: null,
      quantity: null,
      value: null,
      currency: null,
      items: null,
    },
    page: {
      data: [
        {
          type: "event",
          id: externalEventId,
          attributes: {
            datetime: "2026-07-20T10:00:00.000Z",
            uuid: `uuid-${externalEventId}`,
            event_properties: {
              OrderId: "gid://shopify/Order/1001",
              $event_id: `provider-${externalEventId}`,
            },
          },
          relationships: {
            profile: { data: { type: "profile", id: "profile-subject" } },
            metric: {
              data: { type: "metric", id: "metric-external-placed" },
            },
          },
        },
      ],
      included: [
        {
          type: "profile",
          id: "profile-subject",
          attributes: { email },
        },
      ],
      nextCursor: null,
      apiRevision: "2026-07-15",
    },
    identity: { scope, identityKeyring: keyring, suppressionKey },
  });
  return event;
}

async function seedBase(): Promise<void> {
  await testPool!.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-a', 'Org A', 'org-a', now())`,
  );
  await testPool!.query(
    `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
     VALUES ('store-a', 'org-a', 'a.example.com', 'America/New_York')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_connection (id, organization_id, shopify_store_id, klaviyo_account_id)
     VALUES ('connection-a', 'org-a', 'store-a', 'account-a')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_metric
       (id, organization_id, shopify_store_id, connection_id, external_metric_id,
        name, canonical_kind, ingestion_enabled, api_revision) VALUES
       ('metric-row-placed', 'org-a', 'store-a', 'connection-a',
        'metric-external-placed', 'Placed Order', 'placed_order', 1, '2026-07-15'),
       ('metric-row-product', 'org-a', 'store-a', 'connection-a',
        'metric-external-product', 'Ordered Product', 'ordered_product', 1, '2026-07-15')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status, checkpoint, request_parameters)
     VALUES ('run-events', 'org-a', 'store-a', 'connection-a', 'events',
       'manual', 'running', $1, $2)`,
    [checkpoint0, contract],
  );
}

describeIfDb("Klaviyo privacy match closure on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    // A DROP DATABASE ... WITH (FORCE) from a leftover or concurrent run kills
    // idle clients, which surfaces as a pool-level error; without a listener
    // that crashes the worker even when every assertion passed.
    adminPool.on("error", () => {});
    testPool?.on("error", () => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    for (const statement of FIXTURE_DDL) await testPool!.query(statement);
    for (const migration of [
      "0055_klaviyo_shopify_evidence.sql",
      "0056_klaviyo_source_core.sql",
      "0057_klaviyo_advisory_matching.sql",
      "0058_klaviyo_claims_reporting.sql",
    ]) {
      for (const statement of migrationStatements(migration)) {
        await testPool!.query(statement);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`,
      );
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE identity_pilot_uninstall_receipt, klaviyo_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedBase();
  });

  it("bootstraps the gate from zero state and replays as a no-op", async () => {
    await expect(
      store.initializeIdentityWriteGate({ scope, keyring, suppressionKey }),
    ).resolves.toEqual({ initialized: true });
    const gate = await testPool!.query(
      `SELECT identity_write_mode, identity_current_key_version
         FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    expect(gate.rows[0]).toEqual({
      identity_write_mode: "current_only",
      identity_current_key_version: "v1",
    });
    const policy = await testPool!.query(
      `SELECT matching_current_version, suppression_version
         FROM identity_crypto_policy WHERE store_id = 'store-a'`,
    );
    expect(policy.rows[0]).toEqual({
      matching_current_version: "v1",
      suppression_version: "e1",
    });
    await expect(
      store.initializeIdentityWriteGate({ scope, keyring, suppressionKey }),
    ).resolves.toEqual({ initialized: false });
  });

  it("fails bootstrap on same-label different secret or retained rows without policy", async () => {
    await store.initializeIdentityWriteGate({ scope, keyring, suppressionKey });
    await expect(
      store.initializeIdentityWriteGate({
        scope,
        keyring: wrongSecretKeyring,
        suppressionKey,
      }),
    ).rejects.toThrow("bootstrap failed");

    await testPool!.query(
      `TRUNCATE klaviyo_connection, shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedBase();
    await testPool!.query(
      `INSERT INTO shopify_order
         (id, organization_id, store_id, shopify_order_id, order_created_at,
          order_day, net_sales)
       VALUES ('order-r', 'org-a', 'store-a', 'shopify-r', now(), current_date, 10)`,
    );
    await testPool!.query(
      `INSERT INTO source_identity_hmac
         (id, organization_id, store_id, source_kind, shopify_order_id,
          key_version, digest, rotation_state)
       VALUES ('hmac-old', 'org-a', 'store-a', 'shopify_order', 'order-r',
         'v0', 'digest-old', 'active')`,
    );
    await expect(
      store.initializeIdentityWriteGate({ scope, keyring, suppressionKey }),
    ).rejects.toThrow("bootstrap failed");
  });

  it("persists gate-authorized digests with immutable row and link semantics", async () => {
    await store.initializeIdentityWriteGate({ scope, keyring, suppressionKey });
    const event = identityEvent("event-identity", "subject@example.com");
    const first = await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-events",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: { ...checkpoint0, cursor: "cursor-2", page: 1 },
      events: [event],
      rowsRead: 1,
    });
    expect(first).toMatchObject({ committed: true, inserted: 1, suppressed: 0 });

    const digests = await testPool!.query(
      `SELECT id, key_version, digest FROM source_identity_hmac
        WHERE source_kind = 'klaviyo_event'`,
    );
    expect(digests.rows).toHaveLength(1);
    const rowId = digests.rows[0].id as string;
    expect(digests.rows[0].key_version).toBe("v1");
    const link = await testPool!.query(
      `SELECT identity_hmac_id FROM klaviyo_event_run_identity_observation`,
    );
    expect(link.rows).toEqual([{ identity_hmac_id: rowId }]);

    // Identical replay from the advanced checkpoint reuses the row ID.
    const replay = await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-events",
      sourceContract: contract,
      expectedCheckpoint: { ...checkpoint0, cursor: "cursor-2", page: 1 },
      nextCheckpoint: null,
      events: [event],
      rowsRead: 1,
    });
    expect(replay.committed).toBe(true);
    const afterReplay = await testPool!.query(
      `SELECT id FROM source_identity_hmac WHERE source_kind = 'klaviyo_event'`,
    );
    expect(afterReplay.rows).toEqual([{ id: rowId }]);
    expect(JSON.stringify(digests.rows)).not.toContain("subject@example.com");
  });

  it("replaces changed identity digests after cascading the old run observation", async () => {
    await store.initializeIdentityWriteGate({ scope, keyring, suppressionKey });
    const event = identityEvent("event-changed-digest", "subject@example.com");
    const next = { ...checkpoint0, cursor: "cursor-2", page: 1 };
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-events",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: next,
      events: [event],
      rowsRead: 1,
    });
    const before = await testPool!.query(
      `SELECT h.id, o.identity_hmac_id
         FROM source_identity_hmac h
         JOIN klaviyo_event_run_identity_observation o
           ON o.identity_hmac_id = h.id
        WHERE h.source_kind = 'klaviyo_event'`,
    );
    expect(before.rows).toHaveLength(1);

    const changed = {
      ...event,
      identityDigests: event.identityDigests.map((digest) => ({
        ...digest,
        digest: `${digest.digest}-changed`,
      })),
    };
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-events",
      sourceContract: contract,
      expectedCheckpoint: next,
      nextCheckpoint: null,
      events: [changed],
      rowsRead: 1,
    });

    const after = await testPool!.query(
      `SELECT h.id, o.identity_hmac_id
         FROM source_identity_hmac h
         JOIN klaviyo_event_run_identity_observation o
           ON o.identity_hmac_id = h.id
        WHERE h.source_kind = 'klaviyo_event'`,
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].id).not.toBe(before.rows[0].id);
    expect(after.rows[0].identity_hmac_id).toBe(after.rows[0].id);
  });

  it("suppresses a tombstoned subject, closes incident order results, and recounts", async () => {
    await store.initializeIdentityWriteGate({ scope, keyring, suppressionKey });
    const event = identityEvent("event-erase", "subject@example.com");
    await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-events",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: { ...checkpoint0, cursor: "cursor-2", page: 1 },
      events: [event],
      rowsRead: 1,
    });
    const [{ id: eventRowId }] = (
      await testPool!.query(`SELECT id FROM klaviyo_event`)
    ).rows as Array<{ id: string }>;

    // Seed a published run + candidate + current order result for the event.
    await testPool!.query(
      `INSERT INTO shopify_order
         (id, organization_id, store_id, shopify_order_id, order_created_at,
          order_day, net_sales)
       VALUES ('order-m', 'org-a', 'store-a', 'shopify-m', now(), current_date, 10)`,
    );
    await testPool!.query(
      `UPDATE klaviyo_sync_run SET status = 'success', finished_at = now()
        WHERE id = 'run-events'`,
    );
    await testPool!.query(
      `INSERT INTO shopify_evidence_sync_run
         (id, start_trigger_run_id, organization_id, store_id, mode,
          store_timezone, anchor_store_day, requested_from, requested_to, status)
       VALUES ('evidence-run-a', 'trigger-a', 'org-a', 'store-a', 'initial_90d',
         'America/New_York', '2026-08-05', now() - interval '90 day', now(), 'success')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_match_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
          invocation_fingerprint, status, event_window_from, event_window_to,
          shopify_window_from, shopify_window_to, klaviyo_source_checksum,
          shopify_evidence_checksum, rule_checksum, config_checksum,
          expected_order_count, expected_event_count, result_order_count,
          result_event_count, candidate_count, started_at, completed_at, published_at)
       VALUES ('match-run-a', 'org-a', 'store-a', 'connection-a', 'run-events',
         'evidence-run-a', 'klaviyo-v1', 'scope-a', 'invocation-a', 'published',
         now() - interval '90 day', now(), now() - interval '90 day', now(),
         'c1', 'c2', 'c3', 'c4', 1, 1, 1, 1, 1, now(), now(), now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-a', 'org-a', 'store-a', 'connection-a', 'match-run-a',
         $1, 'order-m', 'deterministic', 'order_id', '{}', '{}', '{}', 10, 1, '[]')`,
      [eventRowId],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_order_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          order_id, status, selected_candidate_id, selected_class,
          selected_event_id, product_status, reason_codes, matcher_version,
          published_at)
       VALUES ('order-result-a', 'org-a', 'store-a', 'connection-a',
         'match-run-a', 'order-m', 'confirmed', 'cand-a', 'deterministic',
         $1, 'unavailable', '[]', 'klaviyo-v1', now())`,
      [eventRowId],
    );

    // Tombstone the subject, then replay ingestion with a fresh run.
    const suppressionCandidate = event.erasureSuppressionCandidates.find(
      (candidate) => candidate.kind === "email",
    )!;
    await testPool!.query(
      `INSERT INTO identity_erasure_suppression
         (id, organization_id, store_id, kind, key_version, digest)
       VALUES ('suppression-subject', 'org-a', 'store-a', 'email', $1, $2)`,
      [suppressionCandidate.keyVersion, suppressionCandidate.digest],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters)
       VALUES ('run-replay', 'org-a', 'store-a', 'connection-a', 'events',
         'manual', 'running', $1, $2)`,
      [checkpoint0, contract],
    );
    const result = await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-replay",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [identityEvent("event-erase", "subject@example.com")],
      rowsRead: 1,
    });
    expect(result).toMatchObject({ committed: true, inserted: 0, suppressed: 1 });

    const state = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM klaviyo_event) AS events,
         (SELECT count(*)::int FROM source_identity_hmac
           WHERE source_kind = 'klaviyo_event') AS digests,
         (SELECT events_suppressed FROM klaviyo_sync_run WHERE id = 'run-replay') AS suppressed,
         (SELECT supersession_reason FROM klaviyo_order_match_result
           WHERE id = 'order-result-a') AS order_reason,
         (SELECT superseded_at IS NOT NULL FROM klaviyo_match_run
           WHERE id = 'match-run-a') AS run_superseded`,
    );
    expect(state.rows[0]).toEqual({
      events: 0,
      digests: 0,
      suppressed: 1,
      order_reason: "privacy_erasure",
      run_superseded: true,
    });

    // Replay again: still suppressed, still nothing resurrected.
    await testPool!.query(
      `UPDATE klaviyo_sync_run SET status = 'success', finished_at = now()
        WHERE id = 'run-replay'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters)
       VALUES ('run-replay-2', 'org-a', 'store-a', 'connection-a', 'events',
         'manual', 'running', $1, $2)`,
      [checkpoint0, contract],
    );
    const replay = await store.commitKlaviyoEventPage({
      scope,
      syncRunId: "run-replay-2",
      sourceContract: contract,
      expectedCheckpoint: checkpoint0,
      nextCheckpoint: null,
      events: [identityEvent("event-erase", "subject@example.com")],
      rowsRead: 1,
    });
    expect(replay).toMatchObject({ committed: true, inserted: 0, suppressed: 1 });
    const events = await testPool!.query(`SELECT count(*)::int AS c FROM klaviyo_event`);
    expect(events.rows[0].c).toBe(0);
  });

  it("fails closed for identity-bearing pages when the gate is uninitialized", async () => {
    const event = identityEvent("event-nogate", "subject@example.com");
    await expect(
      store.commitKlaviyoEventPage({
        scope,
        syncRunId: "run-events",
        sourceContract: contract,
        expectedCheckpoint: checkpoint0,
        nextCheckpoint: null,
        events: [event],
        rowsRead: 1,
      }),
    ).rejects.toThrow("identity write gate is not initialized");
    const counts = await testPool!.query(
      `SELECT (SELECT count(*)::int FROM klaviyo_event) AS events,
              (SELECT count(*)::int FROM source_identity_hmac) AS digests`,
    );
    expect(counts.rows[0]).toEqual({ events: 0, digests: 0 });
  });
});
