import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clearPilotShopifyIdentityForStore } from "@/lib/shopify-privacy";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoConnections } from "@/schema/klaviyo";
import { shopifyStores } from "@/schema/shopify";

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
};

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
    const deleted = await dependencies.deleteConnection(scope, tx);
    if (deleted !== 1) {
      throw new Error("Klaviyo connection uninstall conflicted");
    }
  });
  return { shopifyIdentity };
}
