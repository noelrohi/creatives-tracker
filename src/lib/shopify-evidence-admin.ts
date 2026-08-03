import "server-only";

import {
  computeErasureSuppressionDigests,
  computeIdentityCryptoKeyChecks,
  computeIdentityDigests,
  type ErasureSuppressionDigest,
  type ErasureSuppressionKey,
  type IdentityCryptoKeyChecks,
  type IdentityHmacKeyring,
  type IdentityScope,
  type VersionedIdentityDigest,
} from "@/lib/identity-hmac";

export interface ShopifyGraphql {
  <T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export type NormalizedShopifyOrderLine = {
  shopifyLineItemId: string;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  sku: string | null;
  productTitle: string;
  variantTitle: string | null;
  quantity: number;
  sourcePosition: number;
};

export type CompleteShopifyLineSet = {
  completeness: "complete";
  shopifyOrderId: string;
  orderUpdatedAt: Date;
  lines: NormalizedShopifyOrderLine[];
};

export type NormalizedShopifyIdentityEvidence =
  | {
      status: "available";
      shopifyCustomerId: string | null;
      digests: VersionedIdentityDigest[];
      suppressionCandidates: ErasureSuppressionDigest[];
      keyChecks: IdentityCryptoKeyChecks;
      evaluatedKeyVersions: string[];
    }
  | {
      status: "unavailable";
      reason: "protected_identity_unavailable";
    };

export type ShopifyEvidenceCapabilities = {
  orderScope: "available" | "unavailable";
  historicalOrders: "available" | "unavailable";
  identityScope: "declared" | "missing";
  scopes: string[];
};

export class IncompleteShopifyLineSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteShopifyLineSetError";
  }
}

export class RetryableShopifyEvidenceRequestError extends Error {
  constructor() {
    super("Shopify evidence request failed");
    this.name = "RetryableShopifyEvidenceRequestError";
  }
}

/**
 * Deterministic invalid source sets are terminal. Remote transport/API failures
 * escape so a task can retry from its last committed order cursor.
 */
export function isRetryableShopifyLineFailure(error: unknown): boolean {
  return !(error instanceof IncompleteShopifyLineSetError);
}

const ORDER_LINE_PAGE_QUERY = `
  query ShopifyEvidenceOrderLines($orderId: ID!, $cursor: String) {
    node(id: $orderId) {
      ... on Order {
        id
        updatedAt
        lineItems(first: 250, after: $cursor) {
          nodes {
            id
            product { id }
            variant { id }
            sku
            title
            variantTitle
            quantity
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const ORDER_IDENTITY_QUERY = `
  query ShopifyEvidenceOrderIdentity($orderId: ID!) {
    node(id: $orderId) {
      ... on Order {
        id
        email
        customer { id }
      }
    }
  }
`;

const ACCESS_SCOPES_QUERY = `
  query ShopifyEvidenceAccessScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidLineSet(message: string): never {
  throw new IncompleteShopifyLineSetError(message);
}

function parseNullableId(value: unknown): string | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return invalidLineSet("Shopify line page was invalid or duplicated");
  }
  return value.id;
}

async function requestShopifyEvidence<T>(
  graphql: ShopifyGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  try {
    return await graphql<T>(query, variables);
  } catch {
    throw new RetryableShopifyEvidenceRequestError();
  }
}

export async function fetchCompleteShopifyOrderLines(
  graphql: ShopifyGraphql,
  shopifyOrderId: string,
): Promise<CompleteShopifyLineSet> {
  const lines: NormalizedShopifyOrderLine[] = [];
  const seenCursors = new Set<string>();
  const seenLineIds = new Set<string>();
  let cursor: string | null = null;
  let orderUpdatedAt: Date | null = null;

  while (true) {
    const data = await requestShopifyEvidence<unknown>(
      graphql,
      ORDER_LINE_PAGE_QUERY,
      {
        orderId: shopifyOrderId,
        cursor,
      },
    );
    if (!isRecord(data)) {
      return invalidLineSet("Shopify order response was invalid");
    }

    const node = data.node;
    if (!isRecord(node) || node.id !== shopifyOrderId) {
      return invalidLineSet("Shopify order was missing or changed identity");
    }
    if (typeof node.updatedAt !== "string") {
      return invalidLineSet("Shopify order returned an invalid updatedAt");
    }
    const updatedAt = new Date(node.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      return invalidLineSet("Shopify order returned an invalid updatedAt");
    }
    orderUpdatedAt ??= updatedAt;
    if (orderUpdatedAt.getTime() !== updatedAt.getTime()) {
      return invalidLineSet("Shopify order changed during line pagination");
    }

    const lineItems = node.lineItems;
    if (!isRecord(lineItems) || !Array.isArray(lineItems.nodes)) {
      return invalidLineSet("Shopify line page was invalid or duplicated");
    }

    for (const lineNode of lineItems.nodes) {
      if (
        !isRecord(lineNode) ||
        typeof lineNode.id !== "string" ||
        lineNode.id.length === 0 ||
        seenLineIds.has(lineNode.id) ||
        !Number.isInteger(lineNode.quantity) ||
        (lineNode.quantity as number) <= 0 ||
        (lineNode.sku !== null && typeof lineNode.sku !== "string") ||
        typeof lineNode.title !== "string" ||
        (lineNode.variantTitle !== null &&
          typeof lineNode.variantTitle !== "string")
      ) {
        return invalidLineSet("Shopify line page was invalid or duplicated");
      }

      const shopifyProductId = parseNullableId(lineNode.product);
      const shopifyVariantId = parseNullableId(lineNode.variant);
      seenLineIds.add(lineNode.id);
      lines.push({
        shopifyLineItemId: lineNode.id,
        shopifyProductId,
        shopifyVariantId,
        sku: lineNode.sku?.trim() || null,
        productTitle: lineNode.title,
        variantTitle: lineNode.variantTitle,
        quantity: lineNode.quantity as number,
        sourcePosition: lines.length,
      });
    }

    const pageInfo = lineItems.pageInfo;
    if (
      !isRecord(pageInfo) ||
      typeof pageInfo.hasNextPage !== "boolean" ||
      (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
    ) {
      return invalidLineSet("Shopify line page was invalid or duplicated");
    }
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor || seenCursors.has(pageInfo.endCursor as string)) {
      return invalidLineSet("Shopify line cursor did not advance");
    }
    seenCursors.add(pageInfo.endCursor as string);
    cursor = pageInfo.endCursor as string;
  }

  if (!orderUpdatedAt) {
    return invalidLineSet("Shopify order returned no snapshot timestamp");
  }
  return {
    completeness: "complete",
    shopifyOrderId,
    orderUpdatedAt,
    lines,
  };
}

function unavailableCapabilities(): ShopifyEvidenceCapabilities {
  return {
    orderScope: "unavailable",
    historicalOrders: "unavailable",
    identityScope: "missing",
    scopes: [],
  };
}

const ACCESS_DENIED_CODES = new Set([
  "ACCESS_DENIED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
]);

function isAccessDeniedCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return ACCESS_DENIED_CODES.has(normalized);
}

function isAccessDeniedStatusText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "unauthorized" || normalized === "forbidden";
}

function isAnchoredAccessDeniedMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^(?:access denied\b|unauthori[sz]ed\b|forbidden\b|shopify graphql error:\s*(?:access denied\b|unauthori[sz]ed\b|forbidden\b)|shopify admin api returned\s+(?:401|403)(?:\s|$))/i.test(
    value.trimStart(),
  );
}

function isAccessDeniedError(error: unknown): boolean {
  try {
    if (!isRecord(error)) return false;

    const status = error.status;
    if (
      status === 401 ||
      status === 403 ||
      status === "401" ||
      status === "403"
    ) {
      return true;
    }
    if (
      isAccessDeniedCode(error.code) ||
      isAccessDeniedStatusText(error.statusText) ||
      isAnchoredAccessDeniedMessage(error.message)
    ) {
      return true;
    }

    if (!Array.isArray(error.errors)) return false;
    return error.errors.some((providerError) => {
      if (!isRecord(providerError)) return false;
      if (isAnchoredAccessDeniedMessage(providerError.message)) {
        return true;
      }
      if (!isRecord(providerError.extensions)) return false;
      return isAccessDeniedCode(providerError.extensions.code);
    });
  } catch {
    return false;
  }
}

export async function probeShopifyEvidenceCapabilities(
  graphql: ShopifyGraphql,
): Promise<ShopifyEvidenceCapabilities> {
  let data: unknown;
  try {
    data = await graphql<unknown>(ACCESS_SCOPES_QUERY);
  } catch (error) {
    if (isAccessDeniedError(error)) return unavailableCapabilities();
    throw new RetryableShopifyEvidenceRequestError();
  }

  if (!isRecord(data) || !isRecord(data.currentAppInstallation)) {
    return unavailableCapabilities();
  }
  const accessScopes = data.currentAppInstallation.accessScopes;
  if (!Array.isArray(accessScopes)) {
    return unavailableCapabilities();
  }

  const scopes: string[] = [];
  for (const scope of accessScopes) {
    if (!isRecord(scope) || typeof scope.handle !== "string") {
      return unavailableCapabilities();
    }
    scopes.push(scope.handle);
  }
  const granted = new Set(scopes);
  return {
    orderScope: granted.has("read_orders") ? "available" : "unavailable",
    historicalOrders: granted.has("read_all_orders")
      ? "available"
      : "unavailable",
    identityScope: granted.has("read_customers") ? "declared" : "missing",
    scopes,
  };
}

const PROTECTED_IDENTITY_UNAVAILABLE = {
  status: "unavailable",
  reason: "protected_identity_unavailable",
} as const;

type ShopifyIdentityEvidenceInput = {
  graphql: ShopifyGraphql;
  shopifyOrderId: string;
  scope: IdentityScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
};

function invalidIdentityEvidenceInput(): never {
  throw new Error("Invalid Shopify identity evidence input");
}

function copySecret(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) return invalidIdentityEvidenceInput();
  return Uint8Array.from(value);
}

function snapshotIdentityEvidenceInput(
  params: unknown,
): ShopifyIdentityEvidenceInput {
  if (
    !isRecord(params) ||
    typeof params.graphql !== "function" ||
    typeof params.shopifyOrderId !== "string" ||
    params.shopifyOrderId.length === 0 ||
    !isRecord(params.scope) ||
    typeof params.scope.organizationId !== "string" ||
    typeof params.scope.storeId !== "string" ||
    !isRecord(params.keyring) ||
    !isRecord(params.keyring.current) ||
    typeof params.keyring.current.version !== "string" ||
    !isRecord(params.suppressionKey) ||
    typeof params.suppressionKey.version !== "string"
  ) {
    return invalidIdentityEvidenceInput();
  }

  const previous = params.keyring.previous;
  if (
    previous !== undefined &&
    (!isRecord(previous) || typeof previous.version !== "string")
  ) {
    return invalidIdentityEvidenceInput();
  }

  return {
    graphql: params.graphql as ShopifyGraphql,
    shopifyOrderId: params.shopifyOrderId,
    scope: {
      organizationId: params.scope.organizationId,
      storeId: params.scope.storeId,
    },
    keyring: {
      current: {
        version: params.keyring.current.version,
        secret: copySecret(params.keyring.current.secret),
      },
      ...(isRecord(previous)
        ? {
            previous: {
              version: previous.version as string,
              secret: copySecret(previous.secret),
            },
          }
        : {}),
    },
    suppressionKey: {
      version: params.suppressionKey.version,
      secret: copySecret(params.suppressionKey.secret),
    },
  };
}

export async function fetchShopifyIdentityEvidence(
  params: ShopifyIdentityEvidenceInput,
): Promise<NormalizedShopifyIdentityEvidence> {
  const input = snapshotIdentityEvidenceInput(params);
  const keyChecks = computeIdentityCryptoKeyChecks({
    scope: input.scope,
    keyring: input.keyring,
    suppressionKey: input.suppressionKey,
  });

  try {
    const data = await input.graphql<unknown>(ORDER_IDENTITY_QUERY, {
      orderId: input.shopifyOrderId,
    });
    if (!isRecord(data) || !isRecord(data.node)) {
      return PROTECTED_IDENTITY_UNAVAILABLE;
    }

    const node = data.node;
    if (
      node.id !== input.shopifyOrderId ||
      (node.email !== null && typeof node.email !== "string") ||
      (node.customer !== null &&
        (!isRecord(node.customer) ||
          typeof node.customer.id !== "string" ||
          node.customer.id.length === 0))
    ) {
      return PROTECTED_IDENTITY_UNAVAILABLE;
    }

    const shopifyCustomerId = isRecord(node.customer)
      ? (node.customer.id as string)
      : null;
    const email = node.email as string | null;
    const evaluatedKeyVersions = [
      input.keyring.current.version,
      ...(input.keyring.previous ? [input.keyring.previous.version] : []),
    ];

    return {
      status: "available",
      shopifyCustomerId,
      digests:
        email !== null
          ? computeIdentityDigests({
              scope: input.scope,
              email,
              keyring: input.keyring,
            })
          : [],
      suppressionCandidates: computeErasureSuppressionDigests({
        scope: input.scope,
        key: input.suppressionKey,
        email,
        shopifyCustomerId,
      }),
      keyChecks,
      evaluatedKeyVersions,
    };
  } catch {
    return PROTECTED_IDENTITY_UNAVAILABLE;
  }
}
