import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  computeIdentityCryptoKeyChecks,
  computeIdentityDigests,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";
import { recountMatchRunCurrentness } from "@/lib/klaviyo/match-currentness";
import { withKlaviyoStoreConnectionLock } from "@/lib/klaviyo/source-store";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { identityMatchingKeyBindings } from "@/schema/identity-registry";
import { klaviyoConnections } from "@/schema/klaviyo";
import {
  klaviyoEventMatchResults,
  klaviyoIdentityRotationRuns,
  klaviyoIdentityRotationSources,
  klaviyoMatchRuns,
  klaviyoOrderMatchResults,
} from "@/schema/klaviyo-match";
import {
  identityCryptoPolicies,
  identityErasureSuppressions,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";

/**
 * Controlled HMAC rotation over the durable database graph. The environment
 * keyring during rotation carries `current = new key` and `previous = old
 * active key`; preparation flips policy + gate to dual atomically, batches
 * re-derive the new-version digests for every retained source, and the
 * pruning transaction is the only destructive step.
 */

const SAFE_ROTATION_ERROR =
  "Klaviyo identity rotation failed validation; resolve key configuration manually";

function rotationFailure(): never {
  throw new Error(SAFE_ROTATION_ERROR);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function rotationFingerprint(input: {
  scope: KlaviyoConnectionScope;
  currentKeyVersion: string;
  previousKeyVersion: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope,
        currentKeyVersion: input.currentKeyVersion,
        previousKeyVersion: input.previousKeyVersion,
      }),
      "utf8",
    )
    .digest("base64url");
}

const NONTERMINAL_STATES = [
  "preparing",
  "dual_write",
  "republishing",
  "pruning",
] as const;

/**
 * Prepare (or reuse) the one live rotation graph: validate the bootstrapped
 * current-only gate equals the environment previous key, bind the new label
 * in the lifetime registry, snapshot the complete retained source set for
 * both source kinds, and flip policy + gate to dual — all in one
 * store→connection transaction.
 */
export async function prepareIdentityRotation(input: {
  scope: KlaviyoConnectionScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): Promise<{ rotationRunId: string; reused: boolean; fingerprint: string }> {
  const previous = input.keyring.previous;
  if (!previous) rotationFailure();
  if (
    previous.version === input.keyring.current.version ||
    Buffer.from(previous.secret).equals(Buffer.from(input.keyring.current.secret))
  ) {
    rotationFailure();
  }
  const identityScope = {
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
  };
  const checks = computeIdentityCryptoKeyChecks({
    scope: identityScope,
    keyring: input.keyring,
    suppressionKey: input.suppressionKey,
  });
  const newPair = checks.matching[0];
  const oldPair = checks.matching[1];
  if (!oldPair) rotationFailure();
  const fingerprint = rotationFingerprint({
    scope: input.scope,
    currentKeyVersion: newPair.keyVersion,
    previousKeyVersion: oldPair.keyVersion,
  });

  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [existing] = await tx
      .select({
        id: klaviyoIdentityRotationRuns.id,
        fingerprint: klaviyoIdentityRotationRuns.fingerprint,
        state: klaviyoIdentityRotationRuns.state,
      })
      .from(klaviyoIdentityRotationRuns)
      .where(
        and(
          eq(klaviyoIdentityRotationRuns.connectionId, input.scope.connectionId),
          inArray(klaviyoIdentityRotationRuns.state, [...NONTERMINAL_STATES]),
        ),
      )
      .for("update");
    if (existing) {
      // One live rotation per connection: identical scope/key pair reuses
      // the graph; a different fingerprint stays rejected while it lives.
      if (existing.fingerprint === fingerprint) {
        return { rotationRunId: existing.id, reused: true, fingerprint };
      }
      rotationFailure();
    }

    const [gate] = await tx
      .select({
        mode: klaviyoConnections.identityWriteMode,
        currentVersion: klaviyoConnections.identityCurrentKeyVersion,
        currentCheck: klaviyoConnections.identityCurrentKeyCheck,
      })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      )
      .limit(1);
    const [policy] = await tx
      .select({
        matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
        matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
        suppressionVersion: identityCryptoPolicies.suppressionVersion,
        suppressionKeyCheck: identityCryptoPolicies.suppressionKeyCheck,
      })
      .from(identityCryptoPolicies)
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, identityScope.organizationId),
          eq(identityCryptoPolicies.storeId, identityScope.storeId),
        ),
      )
      .for("update");
    // Preparation requires an explicitly bootstrapped current-only gate at
    // the environment PREVIOUS (old active) key, with matching store policy
    // and unchanged suppression binding.
    if (
      !gate ||
      !policy ||
      gate.mode !== "current_only" ||
      gate.currentVersion !== oldPair.keyVersion ||
      !constantTimeEqual(gate.currentCheck ?? "", oldPair.keyCheck) ||
      policy.matchingCurrentVersion !== oldPair.keyVersion ||
      !constantTimeEqual(policy.matchingCurrentKeyCheck, oldPair.keyCheck) ||
      policy.suppressionVersion !== checks.suppression.keyVersion ||
      !constantTimeEqual(policy.suppressionKeyCheck, checks.suppression.keyCheck)
    ) {
      rotationFailure();
    }

    // Lifetime registry: a never-seen label binds once; identical replay is
    // allowed; same-label/different-check fails even after prune/uninstall.
    const [binding] = await tx
      .select({ keyCheck: identityMatchingKeyBindings.keyCheck })
      .from(identityMatchingKeyBindings)
      .where(
        and(
          eq(identityMatchingKeyBindings.organizationId, identityScope.organizationId),
          eq(identityMatchingKeyBindings.storeId, identityScope.storeId),
          eq(identityMatchingKeyBindings.keyVersion, newPair.keyVersion),
        ),
      );
    if (binding) {
      if (!constantTimeEqual(binding.keyCheck, newPair.keyCheck)) {
        rotationFailure();
      }
    } else {
      await tx.insert(identityMatchingKeyBindings).values({
        organizationId: identityScope.organizationId,
        storeId: identityScope.storeId,
        keyVersion: newPair.keyVersion,
        keyCheck: newPair.keyCheck,
      });
    }

    const [rotation] = await tx
      .insert(klaviyoIdentityRotationRuns)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        fingerprint,
        currentKeyVersion: newPair.keyVersion,
        currentKeyCheck: newPair.keyCheck,
        previousKeyVersion: oldPair.keyVersion,
        previousKeyCheck: oldPair.keyCheck,
        state: "dual_write",
      })
      .returning({ id: klaviyoIdentityRotationRuns.id });

    // Snapshot the COMPLETE retained set of previous-version sources for
    // both kinds — not merely the current 90-day match window.
    const retained = await tx
      .select({
        sourceKind: sourceIdentityHmacs.sourceKind,
        shopifyOrderId: sourceIdentityHmacs.shopifyOrderId,
        klaviyoEventId: sourceIdentityHmacs.klaviyoEventId,
      })
      .from(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, identityScope.organizationId),
          eq(sourceIdentityHmacs.storeId, identityScope.storeId),
          eq(sourceIdentityHmacs.keyVersion, oldPair.keyVersion),
        ),
      );
    let pending = 0;
    for (const source of retained) {
      await tx.insert(klaviyoIdentityRotationSources).values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        rotationId: rotation.id,
        kind: source.sourceKind,
        shopifyOrderId: source.shopifyOrderId,
        klaviyoEventId: source.klaviyoEventId,
        status: "pending",
      });
      pending += 1;
    }
    await tx
      .update(klaviyoIdentityRotationRuns)
      .set({ sourcesPending: pending })
      .where(eq(klaviyoIdentityRotationRuns.id, rotation.id));

    // Atomic dual transition on BOTH policy and gate in this transaction.
    await tx
      .update(identityCryptoPolicies)
      .set({
        matchingCurrentVersion: newPair.keyVersion,
        matchingCurrentKeyCheck: newPair.keyCheck,
        matchingPreviousVersion: oldPair.keyVersion,
        matchingPreviousKeyCheck: oldPair.keyCheck,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, identityScope.organizationId),
          eq(identityCryptoPolicies.storeId, identityScope.storeId),
        ),
      );
    await tx
      .update(klaviyoConnections)
      .set({
        identityWriteMode: "dual",
        identityCurrentKeyVersion: newPair.keyVersion,
        identityCurrentKeyCheck: newPair.keyCheck,
        identityPreviousKeyVersion: oldPair.keyVersion,
        identityPreviousKeyCheck: oldPair.keyCheck,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      );

    return { rotationRunId: rotation.id, reused: false, fingerprint };
  });
}

/** Resolve a rotation run's authoritative scope from the durable graph. */
export async function resolveRotationScope(
  rotationRunId: string,
): Promise<KlaviyoConnectionScope> {
  const [run] = await db
    .select({
      organizationId: klaviyoIdentityRotationRuns.organizationId,
      storeId: klaviyoIdentityRotationRuns.storeId,
      connectionId: klaviyoIdentityRotationRuns.connectionId,
    })
    .from(klaviyoIdentityRotationRuns)
    .where(eq(klaviyoIdentityRotationRuns.id, rotationRunId))
    .limit(1);
  if (!run) rotationFailure();
  return run;
}

export type RotationSourceFetchers = {
  /** Plan 1's Shopify identity fetch by stored order ID; null when unavailable. */
  fetchShopifyOrderEmail(orderId: string): Promise<string | null>;
  /** Plan 2's pinned single-event fetch by stored event ID; null when unavailable. */
  fetchKlaviyoEventEmail(
    eventId: string,
  ): Promise<{ email: string | null; profileId: string | null }>;
};

/**
 * One bounded rotation batch: re-derive dual digests for pending members.
 * Updates only `source_identity_hmac` and rotation-source status; never
 * creates or replaces orders, lines, events, products, or observations.
 * Suppression hits attach the tombstone and become `suppressed`.
 */
export async function runIdentityRotationBatch(input: {
  scope: KlaviyoConnectionScope;
  rotationRunId: string;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
  fetchers: RotationSourceFetchers;
  maxSources?: number;
}): Promise<{ processed: number; remaining: number }> {
  const limit = Math.min(Math.max(input.maxSources ?? 25, 1), 100);
  const identityScope = {
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
  };

  const members = await db
    .select({
      id: klaviyoIdentityRotationSources.id,
      kind: klaviyoIdentityRotationSources.kind,
      shopifyOrderId: klaviyoIdentityRotationSources.shopifyOrderId,
      klaviyoEventId: klaviyoIdentityRotationSources.klaviyoEventId,
    })
    .from(klaviyoIdentityRotationSources)
    .where(
      and(
        eq(klaviyoIdentityRotationSources.rotationId, input.rotationRunId),
        eq(klaviyoIdentityRotationSources.status, "pending"),
      ),
    )
    .limit(limit);

  let processed = 0;
  for (const member of members) {
    // Fetch identity OUTSIDE the lock; commit under store→connection locks.
    let email: string | null = null;
    if (member.kind === "shopify_order" && member.shopifyOrderId !== null) {
      email = await input.fetchers.fetchShopifyOrderEmail(member.shopifyOrderId);
    } else if (member.kind === "klaviyo_event" && member.klaviyoEventId !== null) {
      const fetched = await input.fetchers.fetchKlaviyoEventEmail(
        member.klaviyoEventId,
      );
      email = fetched.email;
    }
    await withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
      // Revalidate the gate is still this rotation's dual pair at commit.
      const [gate] = await tx
        .select({
          mode: klaviyoConnections.identityWriteMode,
          currentVersion: klaviyoConnections.identityCurrentKeyVersion,
        })
        .from(klaviyoConnections)
        .where(
          and(
            eq(klaviyoConnections.organizationId, input.scope.organizationId),
            eq(klaviyoConnections.storeId, input.scope.storeId),
            eq(klaviyoConnections.id, input.scope.connectionId),
          ),
        )
        .limit(1);
      if (!gate || gate.mode !== "dual") rotationFailure();

      if (email === null) {
        await tx
          .update(klaviyoIdentityRotationSources)
          .set({ status: "unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(klaviyoIdentityRotationSources.id, member.id),
              eq(klaviyoIdentityRotationSources.status, "pending"),
            ),
          );
        return;
      }

      // Suppression check before identity persistence.
      const digests = computeIdentityDigests({
        scope: identityScope,
        email,
        keyring: input.keyring,
      });
      const [suppressionHit] = await tx
        .select({ id: identityErasureSuppressions.id })
        .from(identityErasureSuppressions)
        .where(
          and(
            eq(
              identityErasureSuppressions.organizationId,
              identityScope.organizationId,
            ),
            eq(identityErasureSuppressions.storeId, identityScope.storeId),
            eq(identityErasureSuppressions.kind, "email"),
          ),
        )
        .limit(1);
      if (suppressionHit) {
        await tx
          .update(klaviyoIdentityRotationSources)
          .set({
            status: "suppressed",
            suppressionId: suppressionHit.id,
            shopifyOrderId: null,
            klaviyoEventId: null,
            updatedAt: new Date(),
          })
          .where(eq(klaviyoIdentityRotationSources.id, member.id));
        return;
      }

      for (const digest of digests) {
        const sourceColumns =
          member.kind === "shopify_order"
            ? {
                sourceKind: "shopify_order" as const,
                shopifyOrderId: member.shopifyOrderId,
                klaviyoConnectionId: null,
                klaviyoEventId: null,
              }
            : {
                sourceKind: "klaviyo_event" as const,
                shopifyOrderId: null,
                klaviyoConnectionId: input.scope.connectionId,
                klaviyoEventId: member.klaviyoEventId,
              };
        const [existingRow] = await tx
          .select({
            id: sourceIdentityHmacs.id,
            digest: sourceIdentityHmacs.digest,
          })
          .from(sourceIdentityHmacs)
          .where(
            and(
              eq(sourceIdentityHmacs.organizationId, identityScope.organizationId),
              eq(sourceIdentityHmacs.storeId, identityScope.storeId),
              eq(sourceIdentityHmacs.keyVersion, digest.keyVersion),
              member.kind === "shopify_order"
                ? eq(sourceIdentityHmacs.shopifyOrderId, member.shopifyOrderId!)
                : eq(sourceIdentityHmacs.klaviyoEventId, member.klaviyoEventId!),
            ),
          );
        if (existingRow && existingRow.digest === digest.digest) continue;
        if (existingRow) {
          await tx
            .delete(sourceIdentityHmacs)
            .where(eq(sourceIdentityHmacs.id, existingRow.id));
        }
        await tx.insert(sourceIdentityHmacs).values({
          organizationId: identityScope.organizationId,
          storeId: identityScope.storeId,
          keyVersion: digest.keyVersion,
          digest: digest.digest,
          rotationState: "active",
          ...sourceColumns,
        });
      }
      await tx
        .update(klaviyoIdentityRotationSources)
        .set({ status: "complete", updatedAt: new Date() })
        .where(eq(klaviyoIdentityRotationSources.id, member.id));
    });
    processed += 1;
  }

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(klaviyoIdentityRotationSources)
    .where(
      and(
        eq(klaviyoIdentityRotationSources.rotationId, input.rotationRunId),
        eq(klaviyoIdentityRotationSources.status, "pending"),
      ),
    );
  return { processed, remaining: remaining?.count ?? 0 };
}

/**
 * The only destructive rotation step. Requires the graph's exact dual pair
 * on policy and gate, complete/tombstoned membership, global previous→
 * current digest coverage, and a current published match run bound to the
 * rotation attempt; then atomically cuts both policy and gate to
 * current-only(new), supersedes previous-label results, deletes only
 * previous-version digest rows, and finishes the rotation complete.
 */
export async function pruneIdentityRotation(input: {
  scope: KlaviyoConnectionScope;
  rotationRunId: string;
  publishedMatchRunId: string;
}): Promise<{ prunedDigestRows: number }> {
  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [rotation] = await tx
      .select({
        id: klaviyoIdentityRotationRuns.id,
        state: klaviyoIdentityRotationRuns.state,
        currentKeyVersion: klaviyoIdentityRotationRuns.currentKeyVersion,
        currentKeyCheck: klaviyoIdentityRotationRuns.currentKeyCheck,
        previousKeyVersion: klaviyoIdentityRotationRuns.previousKeyVersion,
        previousKeyCheck: klaviyoIdentityRotationRuns.previousKeyCheck,
      })
      .from(klaviyoIdentityRotationRuns)
      .where(
        and(
          eq(klaviyoIdentityRotationRuns.id, input.rotationRunId),
          eq(klaviyoIdentityRotationRuns.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!rotation || !["dual_write", "republishing", "pruning"].includes(rotation.state)) {
      rotationFailure();
    }

    const [gate] = await tx
      .select({
        mode: klaviyoConnections.identityWriteMode,
        currentVersion: klaviyoConnections.identityCurrentKeyVersion,
        previousVersion: klaviyoConnections.identityPreviousKeyVersion,
      })
      .from(klaviyoConnections)
      .where(eq(klaviyoConnections.id, input.scope.connectionId))
      .limit(1);
    const [policy] = await tx
      .select({
        matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
        matchingPreviousVersion: identityCryptoPolicies.matchingPreviousVersion,
      })
      .from(identityCryptoPolicies)
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, input.scope.organizationId),
          eq(identityCryptoPolicies.storeId, input.scope.storeId),
        ),
      )
      .for("update");
    if (
      !gate ||
      !policy ||
      gate.mode !== "dual" ||
      gate.currentVersion !== rotation.currentKeyVersion ||
      gate.previousVersion !== rotation.previousKeyVersion ||
      policy.matchingCurrentVersion !== rotation.currentKeyVersion ||
      policy.matchingPreviousVersion !== rotation.previousKeyVersion
    ) {
      rotationFailure();
    }

    // Membership must be fully resolved; `suppressed` needs its surviving
    // tombstone and an unavailable member still blocks pruning.
    const members = await tx
      .select({
        status: klaviyoIdentityRotationSources.status,
        suppressionId: klaviyoIdentityRotationSources.suppressionId,
      })
      .from(klaviyoIdentityRotationSources)
      .where(
        eq(klaviyoIdentityRotationSources.rotationId, input.rotationRunId),
      );
    for (const member of members) {
      if (member.status === "complete") continue;
      if (member.status === "suppressed" && member.suppressionId !== null) {
        const [tombstone] = await tx
          .select({ id: identityErasureSuppressions.id })
          .from(identityErasureSuppressions)
          .where(eq(identityErasureSuppressions.id, member.suppressionId))
          .limit(1);
        if (tombstone) continue;
      }
      rotationFailure();
    }

    // Global coverage proof: every retained previous-version source also
    // carries the current version.
    const uncovered = await tx
      .select({ id: sourceIdentityHmacs.id })
      .from(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, input.scope.organizationId),
          eq(sourceIdentityHmacs.storeId, input.scope.storeId),
          eq(sourceIdentityHmacs.keyVersion, rotation.previousKeyVersion),
          sql`not exists (
            select 1 from source_identity_hmac current_row
            where current_row.organization_id = ${input.scope.organizationId}
              and current_row.store_id = ${input.scope.storeId}
              and current_row.key_version = ${rotation.currentKeyVersion}
              and current_row.source_kind = ${sourceIdentityHmacs.sourceKind}
              and current_row.shopify_order_id is not distinct from ${sourceIdentityHmacs.shopifyOrderId}
              and current_row.klaviyo_event_id is not distinct from ${sourceIdentityHmacs.klaviyoEventId}
          )`,
        ),
      )
      .limit(1);
    if (uncovered.length > 0) rotationFailure();

    // The bound publication must still be current.
    const [publication] = await tx
      .select({
        id: klaviyoMatchRuns.id,
        status: klaviyoMatchRuns.status,
        supersededAt: klaviyoMatchRuns.supersededAt,
      })
      .from(klaviyoMatchRuns)
      .where(
        and(
          eq(klaviyoMatchRuns.id, input.publishedMatchRunId),
          eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
        ),
      )
      .limit(1);
    if (
      !publication ||
      publication.status !== "published" ||
      publication.supersededAt !== null
    ) {
      rotationFailure();
    }

    // Supersede older current results that retain the previous label
    // (published before this rotation's publication).
    const affectedRunIds = new Set<string>();
    const supersededEvents = await tx
      .update(klaviyoEventMatchResults)
      .set({
        supersededAt: sql`greatest(${klaviyoEventMatchResults.publishedAt}, now())`,
        supersessionReason: "rotation_key_retired",
      })
      .where(
        and(
          eq(klaviyoEventMatchResults.connectionId, input.scope.connectionId),
          ne(klaviyoEventMatchResults.runId, input.publishedMatchRunId),
          isNull(klaviyoEventMatchResults.supersededAt),
        ),
      )
      .returning({ runId: klaviyoEventMatchResults.runId });
    const supersededOrders = await tx
      .update(klaviyoOrderMatchResults)
      .set({
        supersededAt: sql`greatest(${klaviyoOrderMatchResults.publishedAt}, now())`,
        supersessionReason: "rotation_key_retired",
      })
      .where(
        and(
          eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
          ne(klaviyoOrderMatchResults.runId, input.publishedMatchRunId),
          isNull(klaviyoOrderMatchResults.supersededAt),
        ),
      )
      .returning({ runId: klaviyoOrderMatchResults.runId });
    for (const row of [...supersededEvents, ...supersededOrders]) {
      affectedRunIds.add(row.runId);
    }

    // Atomic cutover of BOTH policy and gate; delete only previous-version
    // digest rows, never a lifetime key-binding row.
    await tx
      .update(identityCryptoPolicies)
      .set({
        matchingPreviousVersion: null,
        matchingPreviousKeyCheck: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, input.scope.organizationId),
          eq(identityCryptoPolicies.storeId, input.scope.storeId),
        ),
      );
    await tx
      .update(klaviyoConnections)
      .set({
        identityWriteMode: "current_only",
        identityPreviousKeyVersion: null,
        identityPreviousKeyCheck: null,
        updatedAt: new Date(),
      })
      .where(eq(klaviyoConnections.id, input.scope.connectionId));
    const pruned = await tx
      .delete(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, input.scope.organizationId),
          eq(sourceIdentityHmacs.storeId, input.scope.storeId),
          eq(sourceIdentityHmacs.keyVersion, rotation.previousKeyVersion),
        ),
      )
      .returning({ id: sourceIdentityHmacs.id });

    await recountMatchRunCurrentness([...affectedRunIds], tx);
    await tx
      .update(klaviyoIdentityRotationRuns)
      .set({ state: "complete", finishedAt: new Date() })
      .where(eq(klaviyoIdentityRotationRuns.id, input.rotationRunId));
    return { prunedDigestRows: pruned.length };
  });
}

/**
 * Operator-only rollback: allowed after dual and before any new-key match
 * publication. Deletes only rollback-safe new-version rows, restores
 * policy + gate to current-only(old), and terminalizes the graph aborted.
 */
export async function abortIdentityRotation(input: {
  scope: KlaviyoConnectionScope;
  rotationRunId: string;
}): Promise<{ requiresEnvironmentCutback: true }> {
  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [rotation] = await tx
      .select({
        state: klaviyoIdentityRotationRuns.state,
        currentKeyVersion: klaviyoIdentityRotationRuns.currentKeyVersion,
        previousKeyVersion: klaviyoIdentityRotationRuns.previousKeyVersion,
        previousKeyCheck: klaviyoIdentityRotationRuns.previousKeyCheck,
      })
      .from(klaviyoIdentityRotationRuns)
      .where(
        and(
          eq(klaviyoIdentityRotationRuns.id, input.rotationRunId),
          eq(klaviyoIdentityRotationRuns.connectionId, input.scope.connectionId),
        ),
      )
      .for("update");
    if (!rotation || !["dual_write", "republishing"].includes(rotation.state)) {
      rotationFailure();
    }

    // Forbidden once any new-key publication exists.
    const [publication] = await tx
      .select({ id: klaviyoMatchRuns.id })
      .from(klaviyoMatchRuns)
      .where(
        and(
          eq(klaviyoMatchRuns.connectionId, input.scope.connectionId),
          eq(klaviyoMatchRuns.status, "published"),
          sql`${klaviyoMatchRuns.createdAt} > (
            select started_at from klaviyo_identity_rotation_run
            where id = ${input.rotationRunId}
          )`,
        ),
      )
      .limit(1);
    if (publication) rotationFailure();

    // Every new-version row must have its corresponding old-version row.
    const orphanNew = await tx
      .select({ id: sourceIdentityHmacs.id })
      .from(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, input.scope.organizationId),
          eq(sourceIdentityHmacs.storeId, input.scope.storeId),
          eq(sourceIdentityHmacs.keyVersion, rotation.currentKeyVersion),
          sql`not exists (
            select 1 from source_identity_hmac old_row
            where old_row.organization_id = ${input.scope.organizationId}
              and old_row.store_id = ${input.scope.storeId}
              and old_row.key_version = ${rotation.previousKeyVersion}
              and old_row.source_kind = ${sourceIdentityHmacs.sourceKind}
              and old_row.shopify_order_id is not distinct from ${sourceIdentityHmacs.shopifyOrderId}
              and old_row.klaviyo_event_id is not distinct from ${sourceIdentityHmacs.klaviyoEventId}
          )`,
        ),
      )
      .limit(1);
    if (orphanNew.length > 0) rotationFailure();

    await tx
      .delete(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, input.scope.organizationId),
          eq(sourceIdentityHmacs.storeId, input.scope.storeId),
          eq(sourceIdentityHmacs.keyVersion, rotation.currentKeyVersion),
        ),
      );
    await tx
      .update(identityCryptoPolicies)
      .set({
        matchingCurrentVersion: rotation.previousKeyVersion,
        matchingCurrentKeyCheck: rotation.previousKeyCheck,
        matchingPreviousVersion: null,
        matchingPreviousKeyCheck: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, input.scope.organizationId),
          eq(identityCryptoPolicies.storeId, input.scope.storeId),
        ),
      );
    await tx
      .update(klaviyoConnections)
      .set({
        identityWriteMode: "current_only",
        identityCurrentKeyVersion: rotation.previousKeyVersion,
        identityCurrentKeyCheck: rotation.previousKeyCheck,
        identityPreviousKeyVersion: null,
        identityPreviousKeyCheck: null,
        updatedAt: new Date(),
      })
      .where(eq(klaviyoConnections.id, input.scope.connectionId));
    await tx
      .update(klaviyoIdentityRotationRuns)
      .set({ state: "aborted", finishedAt: new Date() })
      .where(eq(klaviyoIdentityRotationRuns.id, input.rotationRunId));
    return { requiresEnvironmentCutback: true as const };
  });
}

/**
 * Operator readiness proof after abort/cutback: the ordinary environment
 * keyring must constant-time match the lifetime registry, store policy,
 * and connection gate before writers resume.
 */
export async function verifyIdentityWriterReadiness(input: {
  scope: KlaviyoConnectionScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): Promise<{ ready: boolean }> {
  const identityScope = {
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
  };
  const checks = computeIdentityCryptoKeyChecks({
    scope: identityScope,
    keyring: input.keyring,
    suppressionKey: input.suppressionKey,
  });
  const current = checks.matching[0];
  const [gate] = await db
    .select({
      mode: klaviyoConnections.identityWriteMode,
      currentVersion: klaviyoConnections.identityCurrentKeyVersion,
      currentCheck: klaviyoConnections.identityCurrentKeyCheck,
    })
    .from(klaviyoConnections)
    .where(eq(klaviyoConnections.id, input.scope.connectionId))
    .limit(1);
  const [policy] = await db
    .select({
      matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
      matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
    })
    .from(identityCryptoPolicies)
    .where(
      and(
        eq(identityCryptoPolicies.organizationId, identityScope.organizationId),
        eq(identityCryptoPolicies.storeId, identityScope.storeId),
      ),
    )
    .limit(1);
  const [binding] = await db
    .select({ keyCheck: identityMatchingKeyBindings.keyCheck })
    .from(identityMatchingKeyBindings)
    .where(
      and(
        eq(identityMatchingKeyBindings.organizationId, identityScope.organizationId),
        eq(identityMatchingKeyBindings.storeId, identityScope.storeId),
        eq(identityMatchingKeyBindings.keyVersion, current.keyVersion),
      ),
    )
    .limit(1);
  const ready =
    gate !== undefined &&
    policy !== undefined &&
    binding !== undefined &&
    gate.mode === "current_only" &&
    gate.currentVersion === current.keyVersion &&
    constantTimeEqual(gate.currentCheck ?? "", current.keyCheck) &&
    policy.matchingCurrentVersion === current.keyVersion &&
    constantTimeEqual(policy.matchingCurrentKeyCheck, current.keyCheck) &&
    constantTimeEqual(binding.keyCheck, current.keyCheck);
  return { ready };
}

