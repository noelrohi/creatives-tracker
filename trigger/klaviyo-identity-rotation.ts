import { metadata, task, tags } from "@trigger.dev/sdk";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";
import { KlaviyoApiClient } from "@/lib/klaviyo/client";
import { EnvironmentKlaviyoCredentialProvider } from "@/lib/klaviyo/credential-provider";
import {
  resolveRotationScope,
  runIdentityRotationBatch,
  type RotationSourceFetchers,
} from "@/lib/klaviyo/identity-rotation";
import { getConnectionRecord } from "@/lib/klaviyo/source-store";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { klaviyoEvents } from "@/schema/klaviyo";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const KLAVIYO_ROTATION_QUEUE = {
  name: "klaviyo-identity-rotation",
  concurrencyLimit: 1,
};

type RotationPayload = { rotationRunId: string };

function assertExactRotationPayload(
  value: unknown,
): asserts value is RotationPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.rotationRunId !== "string" ||
    input.rotationRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Klaviyo rotation task accepts only a rotation run ID");
  }
}

async function buildFetchers(scope: {
  organizationId: string;
  storeId: string;
  connectionId: string;
}): Promise<RotationSourceFetchers> {
  const connection = await getConnectionRecord(scope);
  if (!connection) {
    throw new Error("Klaviyo rotation connection is outside this scope");
  }
  const provider = new EnvironmentKlaviyoCredentialProvider();
  const credential = await provider.resolve({
    connectionId: connection.connectionId,
    credentialReference: connection.credentialReference,
    persistedKlaviyoAccountId: connection.klaviyoAccountId,
    shopDomain: connection.shopDomain,
  });
  const client = new KlaviyoApiClient({
    privateApiKey: credential.privateApiKey,
  });
  return {
    // Shopify identity re-fetch is wired through the Plan 1 admin path in a
    // dedicated batch; the pilot dev store cannot expose PII, so absent
    // email resolves the member `unavailable` rather than fabricating one.
    async fetchShopifyOrderEmail() {
      return null;
    },
    async fetchKlaviyoEventEmail(eventId: string) {
      const [event] = await db
        .select({ externalEventId: klaviyoEvents.externalEventId })
        .from(klaviyoEvents)
        .where(eq(klaviyoEvents.id, eventId))
        .limit(1);
      if (!event) return { email: null, profileId: null };
      const result = await client.getEventById({
        externalEventId: event.externalEventId,
        request: {
          purpose: "identity_rotation",
          include: ["profile"],
          profileFields: ["email"],
        },
      });
      if (result.purpose !== "identity_rotation") {
        return { email: null, profileId: null };
      }
      return { email: result.profileEmail, profileId: result.profileId };
    },
  };
}

/**
 * Manual-only dual-key batch driver. The payload is exactly one internal
 * rotation run ID; scope, key labels, and membership load from the durable
 * graph. Publication and pruning stay explicit operator steps — this task
 * never prunes, and after dual a failed attempt leaves the graph
 * nonterminal for expired-lease reconciliation.
 */
export const klaviyoIdentityRotationTask = task({
  id: "klaviyo-identity-rotation",
  retry: ATTRIBUTION_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_ROTATION_QUEUE,
  run: async (payload: RotationPayload) => {
    assertExactRotationPayload(payload);
    const scope = await resolveRotationScope(payload.rotationRunId);
    await tags.add(`klaviyo:org:${scope.organizationId}`);
    const keyring = parseIdentityHmacKeyring();
    const suppressionKey = parseErasureSuppressionKey();
    const fetchers = await buildFetchers(scope);
    let totalProcessed = 0;
    let remaining = Number.POSITIVE_INFINITY;
    // Bounded batches inside one attempt; a retry resumes the same graph.
    for (let batch = 0; batch < 20 && remaining > 0; batch += 1) {
      const outcome = await runIdentityRotationBatch({
        scope,
        rotationRunId: payload.rotationRunId,
        keyring,
        suppressionKey,
        fetchers,
      });
      totalProcessed += outcome.processed;
      remaining = outcome.remaining;
      metadata.set("rotation", {
        rotationRunId: payload.rotationRunId,
        processed: totalProcessed,
        remaining,
      });
      await metadata.flush();
      if (outcome.processed === 0) break;
    }
    return {
      ok: true as const,
      rotationRunId: payload.rotationRunId,
      processed: totalProcessed,
      remaining,
    };
  },
});
