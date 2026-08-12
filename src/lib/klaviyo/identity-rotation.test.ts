import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";
import {
  MATCH_SCOPE,
  applyMatchFixture,
  resolveConnectionString,
  seedMatchWorld,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_rotation_test";
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
const rotation = await import("@/lib/klaviyo/identity-rotation");
const service = await import("@/lib/klaviyo/match-service");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
const SECRET_OLD = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
const SECRET_NEW = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";
const SECRET_S = "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M";
const SECRET_WRONG = "RERERERERERERERERERERERERERERERERERERERERERERA";

const oldKeyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: SECRET_OLD,
  IDENTITY_HMAC_KEY_VERSION: "v1",
});
const rotationKeyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: SECRET_NEW,
  IDENTITY_HMAC_KEY_VERSION: "v2",
  IDENTITY_HMAC_PREVIOUS_SECRET: SECRET_OLD,
  IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
});
const newKeyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: SECRET_NEW,
  IDENTITY_HMAC_KEY_VERSION: "v2",
});
const suppressionKey = parseErasureSuppressionKey({
  IDENTITY_ERASURE_HMAC_SECRET: SECRET_S,
  IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
} as unknown as NodeJS.ProcessEnv);

const SUBJECT_EMAIL = "subject@example.com";

const fetchers = {
  fetchShopifyOrderEmail: vi.fn(
    async (): Promise<string | null> => SUBJECT_EMAIL,
  ),
  fetchKlaviyoEventEmail: vi.fn(
    async (): Promise<{ email: string | null; profileId: string | null }> => ({
      email: SUBJECT_EMAIL,
      profileId: "profile-subject",
    }),
  ),
};

async function bootstrapAndSeedOldDigests(): Promise<void> {
  await store.initializeIdentityWriteGate({
    scope,
    keyring: oldKeyring,
    suppressionKey,
  });
  const { computeIdentityDigests } = await import("@/lib/identity-hmac");
  const [digest] = computeIdentityDigests({
    scope: { organizationId: scope.organizationId, storeId: scope.storeId },
    email: SUBJECT_EMAIL,
    keyring: oldKeyring,
  });
  await testPool!.query(
    `INSERT INTO source_identity_hmac
       (id, organization_id, store_id, source_kind, shopify_order_id,
        key_version, digest, rotation_state)
     VALUES ('hmac-order-v1', 'org-a', 'store-a', 'shopify_order', 'order-a',
       $1, $2, 'active')`,
    [digest.keyVersion, digest.digest],
  );
  await testPool!.query(
    `INSERT INTO source_identity_hmac
       (id, organization_id, store_id, source_kind, klaviyo_connection_id,
        klaviyo_event_id, key_version, digest, rotation_state)
     VALUES ('hmac-event-v1', 'org-a', 'store-a', 'klaviyo_event',
       'connection-a', 'event-a', $1, $2, 'active')`,
    [digest.keyVersion, digest.digest],
  );
}

describeIfDb("Klaviyo identity rotation on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await applyMatchFixture(testPool!);
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
    vi.clearAllMocks();
    fetchers.fetchShopifyOrderEmail.mockResolvedValue(SUBJECT_EMAIL);
    fetchers.fetchKlaviyoEventEmail.mockResolvedValue({
      email: SUBJECT_EMAIL,
      profileId: "profile-subject",
    });
    await testPool!.query(
      `TRUNCATE identity_pilot_uninstall_receipt, klaviyo_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
    await bootstrapAndSeedOldDigests();
  });

  it("prepares dual atomically, snapshots members, and reuses the live graph", async () => {
    const prepared = await rotation.prepareIdentityRotation({
      scope,
      keyring: rotationKeyring,
      suppressionKey,
    });
    expect(prepared.reused).toBe(false);

    const state = await testPool!.query(
      `SELECT
         (SELECT identity_write_mode FROM klaviyo_connection
           WHERE id = 'connection-a') AS gate_mode,
         (SELECT identity_current_key_version FROM klaviyo_connection
           WHERE id = 'connection-a') AS gate_current,
         (SELECT matching_current_version FROM identity_crypto_policy
           WHERE store_id = 'store-a') AS policy_current,
         (SELECT matching_previous_version FROM identity_crypto_policy
           WHERE store_id = 'store-a') AS policy_previous,
         (SELECT count(*)::int FROM klaviyo_identity_rotation_source
           WHERE rotation_id = $1) AS members`,
      [prepared.rotationRunId],
    );
    expect(state.rows[0]).toEqual({
      gate_mode: "dual",
      gate_current: "v2",
      policy_current: "v2",
      policy_previous: "v1",
      members: 2,
    });

    const replay = await rotation.prepareIdentityRotation({
      scope,
      keyring: rotationKeyring,
      suppressionKey,
    });
    expect(replay).toEqual({
      rotationRunId: prepared.rotationRunId,
      reused: true,
      fingerprint: prepared.fingerprint,
    });

    // A different key pair is rejected while the graph is live.
    const differentKeyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: SECRET_WRONG,
      IDENTITY_HMAC_KEY_VERSION: "v3",
      IDENTITY_HMAC_PREVIOUS_SECRET: SECRET_OLD,
      IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
    });
    await expect(
      rotation.prepareIdentityRotation({
        scope,
        keyring: differentKeyring,
        suppressionKey,
      }),
    ).rejects.toThrow("rotation failed validation");
  });

  it("rejects preparation without a bootstrapped matching gate", async () => {
    await testPool!.query(
      `UPDATE klaviyo_connection
          SET identity_write_mode = 'current_only',
              identity_current_key_version = NULL,
              identity_current_key_check = NULL
        WHERE id = 'connection-a'`,
    );
    await expect(
      rotation.prepareIdentityRotation({
        scope,
        keyring: rotationKeyring,
        suppressionKey,
      }),
    ).rejects.toThrow("rotation failed validation");
  });

  it("completes members with dual digests and prunes atomically", async () => {
    const prepared = await rotation.prepareIdentityRotation({
      scope,
      keyring: rotationKeyring,
      suppressionKey,
    });
    const batch = await rotation.runIdentityRotationBatch({
      scope,
      rotationRunId: prepared.rotationRunId,
      keyring: rotationKeyring,
      suppressionKey,
      fetchers,
    });
    expect(batch).toEqual({ processed: 2, remaining: 0 });
    const dualRows = await testPool!.query(
      `SELECT key_version, count(*)::int AS count FROM source_identity_hmac
        GROUP BY key_version ORDER BY key_version`,
    );
    expect(dualRows.rows).toEqual([
      { key_version: "v1", count: 2 },
      { key_version: "v2", count: 2 },
    ]);

    // Publish the rotation's fresh match run (gate current = v2).
    const published = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    const pruned = await rotation.pruneIdentityRotation({
      scope,
      rotationRunId: prepared.rotationRunId,
      publishedMatchRunId: published.runId,
    });
    expect(pruned.prunedDigestRows).toBe(2);
    const after = await testPool!.query(
      `SELECT
         (SELECT identity_write_mode FROM klaviyo_connection
           WHERE id = 'connection-a') AS gate_mode,
         (SELECT identity_current_key_version FROM klaviyo_connection
           WHERE id = 'connection-a') AS gate_current,
         (SELECT matching_previous_version FROM identity_crypto_policy
           WHERE store_id = 'store-a') AS policy_previous,
         (SELECT count(*)::int FROM source_identity_hmac
           WHERE key_version = 'v1') AS old_rows,
         (SELECT state FROM klaviyo_identity_rotation_run
           WHERE id = $1) AS rotation_state,
         (SELECT count(*)::int FROM identity_matching_key_binding
           WHERE store_id = 'store-a') AS lifetime_bindings`,
      [prepared.rotationRunId],
    );
    expect(after.rows[0]).toEqual({
      gate_mode: "current_only",
      gate_current: "v2",
      policy_previous: null,
      old_rows: 0,
      rotation_state: "complete",
      lifetime_bindings: 2,
    });
  });

  it("blocks pruning while a member is unavailable", async () => {
    const prepared = await rotation.prepareIdentityRotation({
      scope,
      keyring: rotationKeyring,
      suppressionKey,
    });
    fetchers.fetchShopifyOrderEmail.mockResolvedValue(null);
    await rotation.runIdentityRotationBatch({
      scope,
      rotationRunId: prepared.rotationRunId,
      keyring: rotationKeyring,
      suppressionKey,
      fetchers,
    });
    const published = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    await expect(
      rotation.pruneIdentityRotation({
        scope,
        rotationRunId: prepared.rotationRunId,
        publishedMatchRunId: published.runId,
      }),
    ).rejects.toThrow("rotation failed validation");
    const graph = await testPool!.query(
      `SELECT state FROM klaviyo_identity_rotation_run WHERE id = $1`,
      [prepared.rotationRunId],
    );
    expect(graph.rows[0].state).toBe("dual_write");
  });

  it("aborts rollback-safe after dual and readiness gates the cutback", async () => {
    const prepared = await rotation.prepareIdentityRotation({
      scope,
      keyring: rotationKeyring,
      suppressionKey,
    });
    await rotation.runIdentityRotationBatch({
      scope,
      rotationRunId: prepared.rotationRunId,
      keyring: rotationKeyring,
      suppressionKey,
      fetchers,
    });
    const aborted = await rotation.abortIdentityRotation({
      scope,
      rotationRunId: prepared.rotationRunId,
    });
    expect(aborted).toEqual({ requiresEnvironmentCutback: true });
    const state = await testPool!.query(
      `SELECT
         (SELECT identity_write_mode FROM klaviyo_connection
           WHERE id = 'connection-a') AS gate_mode,
         (SELECT identity_current_key_version FROM klaviyo_connection
           WHERE id = 'connection-a') AS gate_current,
         (SELECT count(*)::int FROM source_identity_hmac
           WHERE key_version = 'v2') AS new_rows,
         (SELECT state FROM klaviyo_identity_rotation_run WHERE id = $1) AS rotation_state`,
      [prepared.rotationRunId],
    );
    expect(state.rows[0]).toEqual({
      gate_mode: "current_only",
      gate_current: "v1",
      new_rows: 0,
      rotation_state: "aborted",
    });

    // Readiness proves the old key after correct cutback and rejects the new.
    await expect(
      rotation.verifyIdentityWriterReadiness({
        scope,
        keyring: oldKeyring,
        suppressionKey,
      }),
    ).resolves.toEqual({ ready: true });
    await expect(
      rotation.verifyIdentityWriterReadiness({
        scope,
        keyring: newKeyring,
        suppressionKey,
      }),
    ).resolves.toEqual({ ready: false });
  });

  it("rejects rebinding a historical label to a different secret across graphs", async () => {
    const prepared = await rotation.prepareIdentityRotation({
      scope,
      keyring: rotationKeyring,
      suppressionKey,
    });
    await rotation.runIdentityRotationBatch({
      scope,
      rotationRunId: prepared.rotationRunId,
      keyring: rotationKeyring,
      suppressionKey,
      fetchers,
    });
    const published = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    await rotation.pruneIdentityRotation({
      scope,
      rotationRunId: prepared.rotationRunId,
      publishedMatchRunId: published.runId,
    });

    // v2/checkB -> v1/checkDifferent must fail against the lifetime registry.
    const rebindKeyring: IdentityHmacKeyring = {
      current: parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: SECRET_WRONG,
        IDENTITY_HMAC_KEY_VERSION: "v1",
      }).current,
      previous: newKeyring.current,
    };
    await expect(
      rotation.prepareIdentityRotation({
        scope,
        keyring: rebindKeyring,
        suppressionKey,
      }),
    ).rejects.toThrow("rotation failed validation");
  });
});
