import "server-only";

import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  computeErasureSuppressionDigests,
  computeIdentityCryptoKeyChecks,
  computeIdentityDigests,
  type ErasureSuppressionDigest,
  type ErasureSuppressionKey,
  type IdentityCryptoKeyChecks,
  type IdentityHmacKeyring,
  type IdentityScope,
} from "@/lib/identity-hmac";
import {
  identityCryptoPolicies,
  identityErasureSuppressions,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";

type ShopifyPrivacyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ShopifyPrivacyLockExecutor = Pick<
  ShopifyPrivacyTransaction,
  "select"
>;

export type ShopifyPrivacyExecutor = Pick<typeof db, "execute" | "delete">;

const SAFE_KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

class ShopifySubjectErasureSafeError extends Error {
  override readonly name = "ShopifySubjectErasureSafeError";
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBytes.length === rightBytes.length;
}

function cryptoPolicyConflict(): never {
  throw new ShopifySubjectErasureSafeError("identity_crypto_policy_conflict");
}

function storedKeyVersionUnavailable(keyVersion: string): never {
  if (!SAFE_KEY_VERSION_PATTERN.test(keyVersion)) {
    return cryptoPolicyConflict();
  }
  throw new ShopifySubjectErasureSafeError(
    `Identity HMAC secret is unavailable for stored key version ${keyVersion}`,
  );
}

async function lockScopedShopifyStore(
  scope: IdentityScope,
  executor: ShopifyPrivacyLockExecutor,
): Promise<void> {
  const [store] = await executor
    .select({ id: shopifyStores.id })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.organizationId, scope.organizationId),
        eq(shopifyStores.id, scope.storeId),
      ),
    )
    .limit(1)
    .for("update");
  if (!store) {
    throw new ShopifySubjectErasureSafeError(
      "Shopify privacy store is outside this scope",
    );
  }
}

function validateLockedCryptoPolicy(
  policy: {
    matchingCurrentVersion: string;
    matchingCurrentKeyCheck: string;
    matchingPreviousVersion: string | null;
    matchingPreviousKeyCheck: string | null;
    suppressionVersion: string;
    suppressionKeyCheck: string;
  } | undefined,
  keyChecks: IdentityCryptoKeyChecks,
): void {
  const current = keyChecks.matching[0];
  const previous = keyChecks.matching[1];
  if (
    !policy ||
    !current ||
    keyChecks.matching.length > 2 ||
    policy.matchingCurrentVersion !== current.keyVersion ||
    !constantTimeTextEqual(
      policy.matchingCurrentKeyCheck,
      current.keyCheck,
    ) ||
    policy.matchingPreviousVersion !== (previous?.keyVersion ?? null) ||
    (previous
      ? policy.matchingPreviousKeyCheck === null ||
        !constantTimeTextEqual(
          policy.matchingPreviousKeyCheck,
          previous.keyCheck,
        )
      : policy.matchingPreviousKeyCheck !== null) ||
    policy.suppressionVersion !== keyChecks.suppression.keyVersion ||
    !constantTimeTextEqual(
      policy.suppressionKeyCheck,
      keyChecks.suppression.keyCheck,
    )
  ) {
    return cryptoPolicyConflict();
  }
}

function uniqueSuppressions(
  suppressions: ErasureSuppressionDigest[],
): ErasureSuppressionDigest[] {
  const seen = new Set<string>();
  return suppressions.filter((suppression) => {
    const key = `${suppression.kind}\0${suppression.keyVersion}\0${suppression.digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function eraseShopifySubjectByEmail(params: {
  scope: IdentityScope;
  email: string;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): Promise<{
  ordersCleared: number;
  digestsDeleted: number;
  suppressionsUpserted: number;
}> {
  const scopeInput = params.scope;
  const keyringInput = params.keyring;
  const currentInput = keyringInput.current;
  const previousInput = keyringInput.previous;
  const suppressionInput = params.suppressionKey;
  const scope: IdentityScope = {
    organizationId: scopeInput.organizationId,
    storeId: scopeInput.storeId,
  };
  const email = params.email;
  const rawKeyring: IdentityHmacKeyring = {
    current: {
      version: currentInput.version,
      secret: currentInput.secret,
    },
    ...(previousInput
      ? {
          previous: {
            version: previousInput.version,
            secret: previousInput.secret,
          },
        }
      : {}),
  };
  const rawSuppressionKey: ErasureSuppressionKey = {
    version: suppressionInput.version,
    secret: suppressionInput.secret,
  };
  // Validate the untouched runtime structures before any array-like value can
  // be coerced by Uint8Array.from. This also checks matching/suppression root
  // independence before a transaction, lookup, or write is attempted.
  computeIdentityCryptoKeyChecks({
    scope,
    keyring: rawKeyring,
    suppressionKey: rawSuppressionKey,
  });
  const keyring: IdentityHmacKeyring = {
    current: {
      version: rawKeyring.current.version,
      secret: Uint8Array.from(rawKeyring.current.secret),
    },
    ...(rawKeyring.previous
      ? {
          previous: {
            version: rawKeyring.previous.version,
            secret: Uint8Array.from(rawKeyring.previous.secret),
          },
        }
      : {}),
  };
  const suppressionKey: ErasureSuppressionKey = {
    version: rawSuppressionKey.version,
    secret: Uint8Array.from(rawSuppressionKey.secret),
  };
  // Derive only from the validated, immutable snapshot used after awaits.
  const keyChecks = computeIdentityCryptoKeyChecks({
    scope,
    keyring,
    suppressionKey,
  });
  const subjectDigests = computeIdentityDigests({
    scope,
    email,
    keyring,
  });
  const [emailSuppression] = computeErasureSuppressionDigests({
    scope,
    key: suppressionKey,
    email,
  });
  if (!emailSuppression || emailSuppression.kind !== "email") {
    throw new Error("Shopify email erasure input is invalid");
  }

  try {
    return await db.transaction(async (tx) => {
      await lockScopedShopifyStore(scope, tx);

    const [policy] = await tx
      .select({
        matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
        matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
        matchingPreviousVersion: identityCryptoPolicies.matchingPreviousVersion,
        matchingPreviousKeyCheck: identityCryptoPolicies.matchingPreviousKeyCheck,
        suppressionVersion: identityCryptoPolicies.suppressionVersion,
        suppressionKeyCheck: identityCryptoPolicies.suppressionKeyCheck,
      })
      .from(identityCryptoPolicies)
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, scope.organizationId),
          eq(identityCryptoPolicies.storeId, scope.storeId),
        ),
      )
      .limit(1);
    validateLockedCryptoPolicy(policy, keyChecks);

    const storedVersions = await tx
      .selectDistinct({ keyVersion: sourceIdentityHmacs.keyVersion })
      .from(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, scope.organizationId),
          eq(sourceIdentityHmacs.storeId, scope.storeId),
          eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
        ),
      );
    const configuredVersions = new Set(
      subjectDigests.map((digest) => digest.keyVersion),
    );
    for (const stored of storedVersions) {
      if (!configuredVersions.has(stored.keyVersion)) {
        storedKeyVersionUnavailable(stored.keyVersion);
      }
    }

    const matchingPredicates = subjectDigests.map((digest) =>
      and(
        eq(sourceIdentityHmacs.keyVersion, digest.keyVersion),
        eq(sourceIdentityHmacs.digest, digest.digest),
      ),
    );
    const matches = matchingPredicates.length
      ? await tx
          .select({
            orderId: shopifyOrders.id,
            shopifyCustomerId: shopifyOrders.shopifyCustomerId,
          })
          .from(sourceIdentityHmacs)
          .innerJoin(
            shopifyOrders,
            and(
              eq(shopifyOrders.organizationId, sourceIdentityHmacs.organizationId),
              eq(shopifyOrders.storeId, sourceIdentityHmacs.storeId),
              eq(shopifyOrders.id, sourceIdentityHmacs.shopifyOrderId),
            ),
          )
          .where(
            and(
              eq(sourceIdentityHmacs.organizationId, scope.organizationId),
              eq(sourceIdentityHmacs.storeId, scope.storeId),
              eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
              sql`(${sql.join(matchingPredicates, sql` or `)})`,
            ),
          )
      : [];

    const matchedOrders = new Map<string, string | null>();
    for (const match of matches) {
      matchedOrders.set(match.orderId, match.shopifyCustomerId);
    }
    const aliasSuppressions = [...matchedOrders.values()].flatMap(
      (shopifyCustomerId) =>
        shopifyCustomerId === null
          ? []
          : computeErasureSuppressionDigests({
              scope,
              key: suppressionKey,
              shopifyCustomerId,
            }),
    );
    const suppressions = uniqueSuppressions([
      emailSuppression,
      ...aliasSuppressions,
    ]);
    const insertedSuppressions = await tx
      .insert(identityErasureSuppressions)
      .values(
        suppressions.map((suppression) => ({
          organizationId: scope.organizationId,
          storeId: scope.storeId,
          kind: suppression.kind,
          keyVersion: suppression.keyVersion,
          digest: suppression.digest,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: identityErasureSuppressions.id });

    const orderIds = [...matchedOrders.keys()];
    if (orderIds.length === 0) {
      return {
        ordersCleared: 0,
        digestsDeleted: 0,
        suppressionsUpserted: insertedSuppressions.length,
      };
    }

    const cleared = await tx.execute<{ id: string }>(sql`
      update shopify_order
      set shopify_customer_id = null
      where organization_id = ${scope.organizationId}
        and store_id = ${scope.storeId}
        and shopify_customer_id is not null
        and id in (${sql.join(
          orderIds.map((orderId) => sql`${orderId}`),
          sql`, `,
        )})
      returning id
    `);
    const deleted = await tx
      .delete(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, scope.organizationId),
          eq(sourceIdentityHmacs.storeId, scope.storeId),
          eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
          inArray(sourceIdentityHmacs.shopifyOrderId, orderIds),
        ),
      )
      .returning({ id: sourceIdentityHmacs.id });

      return {
        ordersCleared: cleared.rows.length,
        digestsDeleted: deleted.length,
        suppressionsUpserted: insertedSuppressions.length,
      };
    });
  } catch (error) {
    if (error instanceof ShopifySubjectErasureSafeError) throw error;
    throw new Error("shopify_subject_erasure_failed");
  }
}

async function clearPilotIdentityWithExecutor(
  scope: IdentityScope,
  executor: ShopifyPrivacyExecutor,
): Promise<{ ordersCleared: number; digestsDeleted: number }> {
  const cleared = await executor.execute<{ id: string }>(sql`
    update shopify_order
    set shopify_customer_id = null
    where organization_id = ${scope.organizationId}
      and store_id = ${scope.storeId}
      and shopify_customer_id is not null
    returning id
  `);
  const deleted = await executor
    .delete(sourceIdentityHmacs)
    .where(
      and(
        eq(sourceIdentityHmacs.organizationId, scope.organizationId),
        eq(sourceIdentityHmacs.storeId, scope.storeId),
        eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
      ),
    )
    .returning({ id: sourceIdentityHmacs.id });
  return {
    ordersCleared: cleared.rows.length,
    digestsDeleted: deleted.length,
  };
}

export async function clearPilotShopifyIdentityForStore(
  scope: IdentityScope,
  executor?: ShopifyPrivacyExecutor,
): Promise<{ ordersCleared: number; digestsDeleted: number }> {
  const scopeSnapshot: IdentityScope = {
    organizationId: scope.organizationId,
    storeId: scope.storeId,
  };
  if (executor) {
    return clearPilotIdentityWithExecutor(scopeSnapshot, executor);
  }
  return db.transaction(async (tx) => {
    await lockScopedShopifyStore(scopeSnapshot, tx);
    return clearPilotIdentityWithExecutor(scopeSnapshot, tx);
  });
}
