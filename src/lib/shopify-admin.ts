/**
 * Shopify Admin GraphQL client (v1: env-credentialed, single store).
 *
 * Secrets come from SHOPIFY_SHOP_DOMAIN / SHOPIFY_ACCESS_TOKEN and are never logged.
 */

export const SHOPIFY_API_VERSION = "2026-07";

const MAX_THROTTLE_RETRIES = 4;
const BULK_POLL_INTERVAL_MS = 5000;
const BULK_POLL_MAX_ATTEMPTS = 240; // ~20 minutes

export type ShopifyMoneySet = {
  shopMoney?: { amount?: string | null } | null;
} | null;

export type ShopifyRefundLineItem = {
  subtotalSet?: ShopifyMoneySet;
  totalTaxSet?: ShopifyMoneySet;
};

export type ShopifyRefund = {
  id: string;
  createdAt?: string | null;
  refundLineItems?: { nodes?: ShopifyRefundLineItem[] | null } | null;
};

export type ShopifyUtmParameters = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
} | null;

export type ShopifyLastVisit = {
  source?: string | null;
  sourceType?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: ShopifyUtmParameters;
  occurredAt?: string | null;
} | null;

export type ShopifyCustomerJourneySummary = {
  ready?: boolean | null;
  lastVisit?: ShopifyLastVisit;
} | null;

export type ShopifyOrderNode = {
  id: string;
  name?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  cancelledAt?: string | null;
  test?: boolean | null;
  taxesIncluded?: boolean | null;
  displayFinancialStatus?: string | null;
  sourceName?: string | null;
  subtotalPriceSet?: ShopifyMoneySet;
  currentSubtotalPriceSet?: ShopifyMoneySet;
  totalTaxSet?: ShopifyMoneySet;
  currentTotalTaxSet?: ShopifyMoneySet;
  refunds?: ShopifyRefund[] | null;
  customerJourneySummary?: ShopifyCustomerJourneySummary;
};

export type ShopifyShopInfo = {
  name: string;
  ianaTimezone: string;
  currencyCode: string | null;
};

/**
 * Protected customer data (customer, email, shippingAddress) is deliberately
 * NOT requested. Shared by the bulk and the paginated queries.
 */
const REFUND_FIELDS = `
  refunds {
    id
    createdAt
    refundLineItems(first: 50) {
      nodes {
        subtotalSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
      }
    }
  }
`;

const ORDER_CORE_FIELDS = `
  id
  name
  createdAt
  updatedAt
  cancelledAt
  test
  taxesIncluded
  displayFinancialStatus
  sourceName
  subtotalPriceSet { shopMoney { amount } }
  currentSubtotalPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  customerJourneySummary {
    ready
    lastVisit {
      source
      sourceType
      referrerUrl
      landingPage
      utmParameters { source medium campaign content term }
      occurredAt
    }
  }
`;

export const ORDER_FIELDS = `${ORDER_CORE_FIELDS}${REFUND_FIELDS}`;

/** Same order shape minus refund line items, for a Bulk API that rejects the depth. */
export const ORDER_FIELDS_WITHOUT_REFUND_LINE_ITEMS = `${ORDER_CORE_FIELDS}
  refunds { id createdAt }
`;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function getShopifyShopDomain() {
  return requireEnv("SHOPIFY_SHOP_DOMAIN");
}

function shopifyEndpoint() {
  return `https://${getShopifyShopDomain()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GraphqlError = {
  message?: string;
  extensions?: { code?: string } | null;
};

function isThrottled(errors: GraphqlError[] | undefined) {
  return (errors ?? []).some(
    (error) =>
      error.extensions?.code === "THROTTLED" ||
      /throttle/i.test(error.message ?? ""),
  );
}

function formatErrors(errors: GraphqlError[]) {
  return errors
    .map((error) => error.message ?? error.extensions?.code ?? "unknown error")
    .join("; ");
}

export class ShopifyGraphqlError extends Error {
  readonly errors: GraphqlError[];

  constructor(message: string, errors: GraphqlError[] = []) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.errors = errors;
  }
}

export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const endpoint = shopifyEndpoint();
  const accessToken = requireEnv("SHOPIFY_ACCESS_TOKEN");

  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_THROTTLE_RETRIES) {
        throw new ShopifyGraphqlError(
          `Shopify Admin API returned ${response.status} ${response.statusText}`,
        );
      }
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ShopifyGraphqlError(
        `Shopify Admin API returned ${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: GraphqlError[];
    };

    if (payload.errors?.length) {
      if (isThrottled(payload.errors) && attempt < MAX_THROTTLE_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ShopifyGraphqlError(
        `Shopify GraphQL error: ${formatErrors(payload.errors)}`,
        payload.errors,
      );
    }

    if (!payload.data) {
      throw new ShopifyGraphqlError("Shopify GraphQL response had no data");
    }

    return payload.data;
  }

  throw new ShopifyGraphqlError("Shopify GraphQL request exhausted retries");
}

export async function fetchShopInfo(): Promise<ShopifyShopInfo> {
  const data = await shopifyGraphql<{
    shop: { name: string; ianaTimezone: string; currencyCode: string | null };
  }>(`query ShopInfo { shop { name ianaTimezone currencyCode } }`);

  return {
    name: data.shop.name,
    ianaTimezone: data.shop.ianaTimezone,
    currencyCode: data.shop.currencyCode ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Bulk operations                                                     */
/* ------------------------------------------------------------------ */

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "CANCELING"
  | "EXPIRED";

export type BulkOperation = {
  id: string;
  status: BulkOperationStatus;
  errorCode?: string | null;
  objectCount?: string | null;
  url?: string | null;
  partialDataUrl?: string | null;
};

function bulkOrdersQuery(orderFields: string, filter: string) {
  return `
    {
      orders(query: ${JSON.stringify(filter)}, sortKey: UPDATED_AT) {
        edges {
          node {
            ${orderFields}
          }
        }
      }
    }
  `;
}

const BULK_RUN_MUTATION = `
  mutation BulkOrders($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Starts a bulk orders export. Falls back to a query without nested
 * refundLineItems if the Bulk API rejects that depth; callers then hydrate
 * refund line items through the paginated query.
 */
export async function startBulkOrdersOperation(filter: string): Promise<{
  bulkOperationId: string;
  includesRefundLineItems: boolean;
}> {
  const attempts: Array<{ fields: string; includesRefundLineItems: boolean }> = [
    { fields: ORDER_FIELDS, includesRefundLineItems: true },
    {
      fields: ORDER_FIELDS_WITHOUT_REFUND_LINE_ITEMS,
      includesRefundLineItems: false,
    },
  ];

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      const data = await shopifyGraphql<{
        bulkOperationRunQuery: {
          bulkOperation: { id: string; status: BulkOperationStatus } | null;
          userErrors: Array<{ field?: string[] | null; message: string }>;
        };
      }>(BULK_RUN_MUTATION, {
        query: bulkOrdersQuery(attempt.fields, filter),
      });

      const result = data.bulkOperationRunQuery;
      if (result.userErrors.length > 0 || !result.bulkOperation) {
        throw new ShopifyGraphqlError(
          `bulkOperationRunQuery failed: ${result.userErrors
            .map((error) => error.message)
            .join("; ")}`,
        );
      }

      return {
        bulkOperationId: result.bulkOperation.id,
        includesRefundLineItems: attempt.includesRefundLineItems,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("bulkOperationRunQuery failed");
}

export async function pollBulkOperation(id: string): Promise<BulkOperation> {
  const data = await shopifyGraphql<{ node: BulkOperation | null }>(
    `
      query BulkOperationStatus($id: ID!) {
        node(id: $id) {
          ... on BulkOperation {
            id
            status
            errorCode
            objectCount
            url
            partialDataUrl
          }
        }
      }
    `,
    { id },
  );

  if (!data.node) throw new ShopifyGraphqlError(`Bulk operation ${id} not found`);
  return data.node;
}

export async function waitForBulkOperation(
  id: string,
  onProgress?: (operation: BulkOperation, attempt: number) => void,
): Promise<BulkOperation> {
  for (let attempt = 0; attempt < BULK_POLL_MAX_ATTEMPTS; attempt += 1) {
    const operation = await pollBulkOperation(id);
    onProgress?.(operation, attempt + 1);

    if (operation.status === "COMPLETED") return operation;
    if (
      operation.status === "FAILED" ||
      operation.status === "CANCELED" ||
      operation.status === "EXPIRED"
    ) {
      throw new ShopifyGraphqlError(
        `Bulk operation ${id} ended as ${operation.status}${
          operation.errorCode ? ` (${operation.errorCode})` : ""
        }`,
      );
    }

    await sleep(BULK_POLL_INTERVAL_MS);
  }

  throw new ShopifyGraphqlError(`Bulk operation ${id} timed out while polling`);
}

/** Parses a JSONL body into objects, tolerating blank trailing lines. */
export function parseJsonl<T = Record<string, unknown>>(body: string): T[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export async function downloadBulkJsonl(
  url: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ShopifyGraphqlError(
      `Failed to download bulk result: ${response.status} ${response.statusText}`,
    );
  }
  return parseJsonl(await response.text());
}

/* ------------------------------------------------------------------ */
/* Paginated queries (incremental sync + hydration)                    */
/* ------------------------------------------------------------------ */

const ORDERS_PAGE_QUERY = `
  query OrdersPage($cursor: String, $q: String) {
    orders(first: 250, after: $cursor, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${ORDER_FIELDS}
      }
    }
  }
`;

export async function fetchOrdersPage(params: {
  query: string;
  cursor?: string | null;
}): Promise<{
  orders: ShopifyOrderNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const data = await shopifyGraphql<{
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ShopifyOrderNode[];
    };
  }>(ORDERS_PAGE_QUERY, { cursor: params.cursor ?? null, q: params.query });

  return {
    orders: data.orders.nodes,
    hasNextPage: data.orders.pageInfo.hasNextPage,
    endCursor: data.orders.pageInfo.endCursor,
  };
}

/** Walks every page of an `updated_at` style orders query. */
export async function fetchAllOrders(
  query: string,
  onPage?: (orders: ShopifyOrderNode[], page: number) => Promise<void> | void,
): Promise<ShopifyOrderNode[]> {
  const collected: ShopifyOrderNode[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    page += 1;
    const result = await fetchOrdersPage({ query, cursor });
    if (onPage) await onPage(result.orders, page);
    else collected.push(...result.orders);

    if (!result.hasNextPage || !result.endCursor) break;
    cursor = result.endCursor;
  }

  return collected;
}

const ORDERS_BY_ID_QUERY = `
  query OrdersByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        ${ORDER_FIELDS}
      }
    }
  }
`;

/** Re-fetches specific orders by GID (journey re-poll, refund hydration). */
export async function fetchOrdersByIds(
  ids: string[],
  batchSize = 50,
): Promise<ShopifyOrderNode[]> {
  const orders: ShopifyOrderNode[] = [];

  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    const data = await shopifyGraphql<{
      nodes: Array<ShopifyOrderNode | null>;
    }>(ORDERS_BY_ID_QUERY, { ids: batch });

    for (const node of data.nodes) {
      if (node?.id) orders.push(node);
    }
  }

  return orders;
}
