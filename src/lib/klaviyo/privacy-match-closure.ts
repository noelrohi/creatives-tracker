import "server-only";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { recountMatchRunCurrentness } from "@/lib/klaviyo/match-currentness";
import type { KlaviyoStoreTransaction } from "@/lib/klaviyo/source-store";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoEvents } from "@/schema/klaviyo";
import {
  klaviyoEventMatchResults,
  klaviyoIdentityRotationSources,
  klaviyoMatchCandidates,
  klaviyoOrderMatchResults,
} from "@/schema/klaviyo-match";

/**
 * Shared executor-only erasure for one suppressed Klaviyo event. The caller
 * holds the store→connection lock order and passes its transaction; this
 * helper never opens or nests one. Order of operations:
 *   1. attach the tombstone to every live rotation membership of the event;
 *   2. supersede every current incident order conclusion reachable through
 *      selected edges, candidate edges, and duplicate fan-in;
 *   3. delete the event (results/claims/products/digests/candidates cascade);
 *   4. recount currentness for every affected match run.
 * Idempotent when the event is already gone.
 */
export async function eraseSuppressedKlaviyoEventEvidence(input: {
  scope: KlaviyoConnectionScope;
  eventId: string;
  suppressionId: string;
  tx: KlaviyoStoreTransaction;
}): Promise<{ erased: boolean; affectedRunIds: string[] }> {
  const { scope, eventId, suppressionId, tx } = input;
  const scoped = and(
    eq(klaviyoEvents.organizationId, scope.organizationId),
    eq(klaviyoEvents.storeId, scope.storeId),
    eq(klaviyoEvents.connectionId, scope.connectionId),
    eq(klaviyoEvents.id, eventId),
  );
  const [event] = await tx
    .select({ id: klaviyoEvents.id })
    .from(klaviyoEvents)
    .where(scoped)
    .for("update");

  // Tombstone-proof live rotation memberships first, even when the event
  // row itself is already gone (replayed erasure).
  await tx
    .update(klaviyoIdentityRotationSources)
    .set({
      klaviyoEventId: null,
      suppressionId,
      status: "suppressed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(klaviyoIdentityRotationSources.organizationId, scope.organizationId),
        eq(klaviyoIdentityRotationSources.storeId, scope.storeId),
        eq(klaviyoIdentityRotationSources.connectionId, scope.connectionId),
        eq(klaviyoIdentityRotationSources.klaviyoEventId, eventId),
        inArray(klaviyoIdentityRotationSources.status, [
          "pending",
          "complete",
          "unavailable",
        ]),
      ),
    );

  if (!event) return { erased: false, affectedRunIds: [] };

  const affectedRunIds = new Set<string>();

  // Current event results for this event.
  const eventResults = await tx
    .select({ runId: klaviyoEventMatchResults.runId })
    .from(klaviyoEventMatchResults)
    .where(
      and(
        eq(klaviyoEventMatchResults.connectionId, scope.connectionId),
        eq(klaviyoEventMatchResults.eventId, eventId),
        isNull(klaviyoEventMatchResults.supersededAt),
      ),
    );
  for (const result of eventResults) affectedRunIds.add(result.runId);

  // Incident order conclusions: selected edge to this event, or any
  // candidate edge referencing it (covers duplicate fan-in).
  const candidateOrders = await tx
    .select({
      orderId: klaviyoMatchCandidates.orderId,
    })
    .from(klaviyoMatchCandidates)
    .where(
      and(
        eq(klaviyoMatchCandidates.connectionId, scope.connectionId),
        eq(klaviyoMatchCandidates.eventId, eventId),
      ),
    );
  const orderIds = [...new Set(candidateOrders.map((row) => row.orderId))];

  const incidentResults = await tx
    .select({
      id: klaviyoOrderMatchResults.id,
      runId: klaviyoOrderMatchResults.runId,
    })
    .from(klaviyoOrderMatchResults)
    .where(
      and(
        eq(klaviyoOrderMatchResults.connectionId, scope.connectionId),
        isNull(klaviyoOrderMatchResults.supersededAt),
        orderIds.length > 0
          ? or(
              eq(klaviyoOrderMatchResults.selectedEventId, eventId),
              inArray(klaviyoOrderMatchResults.orderId, orderIds),
            )
          : eq(klaviyoOrderMatchResults.selectedEventId, eventId),
      ),
    )
    .for("update");
  if (incidentResults.length > 0) {
    // Detach edges while superseding so the event/candidate cascade cannot
    // remove the surviving audit row.
    await tx
      .update(klaviyoOrderMatchResults)
      .set({
        // DB-clock supersession keeps published_at <= superseded_at under
        // host/container clock skew.
        supersededAt: sql`greatest(${klaviyoOrderMatchResults.publishedAt}, now())`,
        supersessionReason: "privacy_erasure",
        selectedCandidateId: null,
        selectedClass: null,
        selectedEventId: null,
      })
      .where(
        inArray(
          klaviyoOrderMatchResults.id,
          incidentResults.map((result) => result.id),
        ),
      );
    for (const result of incidentResults) affectedRunIds.add(result.runId);
  }

  // Delete the event; digests, identity observations, products, candidates,
  // event results, and product links cascade with it.
  await tx.delete(klaviyoEvents).where(scoped);

  await recountMatchRunCurrentness([...affectedRunIds], tx);
  return { erased: true, affectedRunIds: [...affectedRunIds] };
}
