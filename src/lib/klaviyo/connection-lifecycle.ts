import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { clearPilotShopifyIdentityForStore } from "@/lib/shopify-privacy";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoConnections } from "@/schema/klaviyo";
import {
  identityPilotUninstallReceipts,
  identityPilotUninstallRetiredKeys,
  klaviyoIdentityRotationRuns,
} from "@/schema/klaviyo-match";
import { shopifyStores } from "@/schema/shopify";
import {
  identityCryptoPolicies,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";

type TransactionWork = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionWork>[0];

type LifecycleDependencies = {
  transaction: (work: (tx: Transaction) => Promise<void>) => Promise<void>;
  lockStore: (
    scope: Pick<KlaviyoConnectionScope, "organizationId" | "storeId">,
    tx: Transaction,
  ) => Promise<boolean>;
  loadConnection: (
    scope: KlaviyoConnectionScope,
    tx: Transaction,
  ) => Promise<KlaviyoConnectionScope | null>;
  clearIdentity: (
    scope: Pick<KlaviyoConnectionScope, "organizationId" | "storeId">,
    tx: Transaction,
  ) => Promise<{ ordersCleared: number; digestsDeleted: number }>;
  deleteConnection: (
    scope: KlaviyoConnectionScope,
    tx: Transaction,
  ) => Promise<number>;
  /**
   * Dual-policy normalization + store-owned receipt/retirement children,
   * written after identity clearing and before the connection cascade.
   * Optional so unit fixtures with fake transactions can omit it.
   */
  normalizeIdentityAndWriteReceipt?: (
    scope: KlaviyoConnectionScope,
    cleared: { ordersCleared: number; digestsDeleted: number },
    tx: Transaction,
  ) => Promise<void>;
};

async function defaultNormalizeIdentityAndWriteReceipt(
  scope: KlaviyoConnectionScope,
  cleared: { ordersCleared: number; digestsDeleted: number },
  tx: Transaction,
): Promise<void> {
  const [gate] = await tx
    .select({
      mode: klaviyoConnections.identityWriteMode,
      currentVersion: klaviyoConnections.identityCurrentKeyVersion,
      currentCheck: klaviyoConnections.identityCurrentKeyCheck,
      previousVersion: klaviyoConnections.identityPreviousKeyVersion,
    })
    .from(klaviyoConnections)
    .where(
      and(
        eq(klaviyoConnections.organizationId, scope.organizationId),
        eq(klaviyoConnections.storeId, scope.storeId),
        eq(klaviyoConnections.id, scope.connectionId),
      ),
    )
    .limit(1);
  const [policy] = await tx
    .select({
      matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
      matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
      matchingPreviousVersion: identityCryptoPolicies.matchingPreviousVersion,
    })
    .from(identityCryptoPolicies)
    .where(
      and(
        eq(identityCryptoPolicies.organizationId, scope.organizationId),
        eq(identityCryptoPolicies.storeId, scope.storeId),
      ),
    )
    .for("update");
  // Without a bootstrapped gate/policy there is no identity authority to
  // retire; the cascade alone is complete.
  if (!gate || gate.currentVersion === null || !policy) return;

  const retiredLabels = new Set<string>();
  if (policy.matchingPreviousVersion !== null) {
    // A dual store policy must match the deleting connection's gate.
    if (
      gate.mode !== "dual" ||
      gate.previousVersion !== policy.matchingPreviousVersion ||
      gate.currentVersion !== policy.matchingCurrentVersion
    ) {
      throw new Error("Klaviyo uninstall found a mismatched dual identity policy");
    }
    retiredLabels.add(policy.matchingPreviousVersion);
    // Clear all pilot matching identity from both source families, then
    // normalize the policy to current-only at the bound dual current pair.
    await tx
      .delete(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, scope.organizationId),
          eq(sourceIdentityHmacs.storeId, scope.storeId),
        ),
      );
    await tx
      .update(identityCryptoPolicies)
      .set({
        matchingPreviousVersion: null,
        matchingPreviousKeyCheck: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, scope.organizationId),
          eq(identityCryptoPolicies.storeId, scope.storeId),
        ),
      );
  }
  // Copy every completed rotation's previous label that the cascade removes.
  const completedRotations = await tx
    .select({ previousKeyVersion: klaviyoIdentityRotationRuns.previousKeyVersion })
    .from(klaviyoIdentityRotationRuns)
    .where(
      and(
        eq(klaviyoIdentityRotationRuns.organizationId, scope.organizationId),
        eq(klaviyoIdentityRotationRuns.storeId, scope.storeId),
        eq(klaviyoIdentityRotationRuns.connectionId, scope.connectionId),
        inArray(klaviyoIdentityRotationRuns.state, ["complete"]),
      ),
    );
  for (const rotation of completedRotations) {
    retiredLabels.add(rotation.previousKeyVersion);
  }
  // The resulting current label is never a retirement child.
  retiredLabels.delete(gate.currentVersion);

  const [receipt] = await tx
    .insert(identityPilotUninstallReceipts)
    .values({
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      formerConnectionId: scope.connectionId,
      priorMode: gate.mode,
      resultingCurrentKeyVersion: gate.currentVersion,
      resultingCurrentKeyCheck: gate.currentCheck!,
      clearedShopifyIdentityRows: cleared.digestsDeleted,
      clearedKlaviyoIdentityRows: 0,
      status: "complete",
      completedAt: new Date(),
    })
    .returning({ id: identityPilotUninstallReceipts.id });
  if (retiredLabels.size > 0) {
    await tx.insert(identityPilotUninstallRetiredKeys).values(
      [...retiredLabels].map((retiredKeyVersion) => ({
        organizationId: scope.organizationId,
        storeId: scope.storeId,
        receiptId: receipt.id,
        resultingCurrentKeyVersion: gate.currentVersion!,
        retiredKeyVersion,
      })),
    );
  }
}

const defaultDependencies: LifecycleDependencies = {
  transaction: async (work) => db.transaction(work),
  lockStore: async (scope, tx) => {
    const [row] = await tx
      .select({ id: shopifyStores.id })
      .from(shopifyStores)
      .where(
        and(
          eq(shopifyStores.organizationId, scope.organizationId),
          eq(shopifyStores.id, scope.storeId),
        ),
      )
      .for("update");
    return Boolean(row);
  },
  loadConnection: async (scope, tx) => {
    const [row] = await tx
      .select({
        organizationId: klaviyoConnections.organizationId,
        storeId: klaviyoConnections.storeId,
        connectionId: klaviyoConnections.id,
      })
      .from(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, scope.organizationId),
          eq(klaviyoConnections.storeId, scope.storeId),
          eq(klaviyoConnections.id, scope.connectionId),
        ),
      )
      .for("update");
    return row ?? null;
  },
  clearIdentity: async (scope, tx) =>
    clearPilotShopifyIdentityForStore(scope, tx),
  normalizeIdentityAndWriteReceipt: defaultNormalizeIdentityAndWriteReceipt,
  deleteConnection: async (scope, tx) => {
    const deleted = await tx
      .delete(klaviyoConnections)
      .where(
        and(
          eq(klaviyoConnections.organizationId, scope.organizationId),
          eq(klaviyoConnections.storeId, scope.storeId),
          eq(klaviyoConnections.id, scope.connectionId),
        ),
      )
      .returning({ id: klaviyoConnections.id });
    return deleted.length;
  },
};

/**
 * Fixed store→connection lock order shared with Plan 1 erasure and reused
 * by Plan 3. The connection delete cascades every Plan 2 Klaviyo row;
 * Shopify commerce evidence, crypto policy, and erasure tombstones survive
 * so a reinstall or replay cannot undo a subject erasure.
 */
export async function uninstallKlaviyoConnection(
  scope: KlaviyoConnectionScope,
  dependencies: LifecycleDependencies = defaultDependencies,
) {
  let shopifyIdentity = { ordersCleared: 0, digestsDeleted: 0 };
  await dependencies.transaction(async (tx) => {
    const storeLocked = await dependencies.lockStore(
      { organizationId: scope.organizationId, storeId: scope.storeId },
      tx,
    );
    if (!storeLocked) throw new Error("Shopify store not found in this scope");
    const connection = await dependencies.loadConnection(scope, tx);
    if (!connection) {
      throw new Error("Klaviyo connection not found in this scope");
    }
    shopifyIdentity = await dependencies.clearIdentity(
      { organizationId: scope.organizationId, storeId: scope.storeId },
      tx,
    );
    await dependencies.normalizeIdentityAndWriteReceipt?.(
      scope,
      shopifyIdentity,
      tx,
    );
    const deleted = await dependencies.deleteConnection(scope, tx);
    if (deleted !== 1) {
      throw new Error("Klaviyo connection uninstall conflicted");
    }
  });
  return { shopifyIdentity };
}
