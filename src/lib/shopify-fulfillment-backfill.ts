import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";
import { fetchOrdersByIds, getShopifyShopDomain, type ShopifyOrderNode } from "./shopify-admin";
import { hydrateRefundLineItems, ingestOrderNodes } from "./shopify-ingest";

export const fulfillmentBackfillInputSchema = z.object({
  organizationId: z.string().min(1),
  storeId: z.string().min(1),
  afterId: z.string().min(1).optional(),
  batchSize: z.number().int().min(1).max(100).default(50),
  maxBatches: z.number().int().min(1).max(100).default(10),
});
type Input = z.infer<typeof fulfillmentBackfillInputSchema>;
type Store = { id: string; organizationId: string; shopDomain: string; ianaTimezone: string };
type Candidate = { id: string; shopifyOrderId: string };
export type BackfillProgress = { scanned: number; fetched: number; missingFromSource: number; afterId: string | null };
type Dependencies = {
  configuredDomain(): string;
  store(input: Input): Promise<Store | undefined>;
  candidates(input: Input): Promise<Candidate[]>;
  fetch(ids: string[]): Promise<ShopifyOrderNode[]>;
  ingest(input: { organizationId: string; store: Store; orders: ShopifyOrderNode[] }): Promise<unknown>;
};
const defaults: Dependencies = {
  configuredDomain: getShopifyShopDomain,
  async store(input) {
    const [store] = await db.select({ id: shopifyStores.id, organizationId: shopifyStores.organizationId, shopDomain: shopifyStores.shopDomain, ianaTimezone: shopifyStores.ianaTimezone }).from(shopifyStores)
      .where(and(eq(shopifyStores.organizationId, input.organizationId), eq(shopifyStores.id, input.storeId)));
    return store;
  },
  candidates(input) {
    return db.select({ id: shopifyOrders.id, shopifyOrderId: shopifyOrders.shopifyOrderId }).from(shopifyOrders)
      .where(and(eq(shopifyOrders.organizationId, input.organizationId), eq(shopifyOrders.storeId, input.storeId),
        or(isNull(shopifyOrders.fulfillmentStatusObservedAt), isNull(shopifyOrders.fulfillmentStatus)),
        input.afterId ? gt(shopifyOrders.id, input.afterId) : undefined))
      .orderBy(asc(shopifyOrders.id)).limit(input.batchSize + 1);
  },
  fetch: fetchOrdersByIds,
  async ingest(input) {
    const { orders } = await hydrateRefundLineItems(input.orders);
    return ingestOrderNodes({ ...input, orders });
  },
};

/** Explicit operator job only. Missing source nodes stay unknown and do not stall the cursor. */
export async function backfillFulfillmentStatuses(
  payload: z.input<typeof fulfillmentBackfillInputSchema>,
  dependencies: Dependencies = defaults,
  onProgress: (progress: BackfillProgress) => void = () => {},
) {
  const input = fulfillmentBackfillInputSchema.parse(payload);
  const store = await dependencies.store(input);
  if (!store || store.organizationId !== input.organizationId || store.id !== input.storeId
    || store.shopDomain.toLowerCase() !== dependencies.configuredDomain().trim().toLowerCase()) {
    throw new Error("Shopify fulfillment backfill store does not match organization and configured shop");
  }
  const progress: BackfillProgress = { scanned: 0, fetched: 0, missingFromSource: 0, afterId: input.afterId ?? null };
  let hasMore = false;
  for (let batch = 0; batch < input.maxBatches; batch++) {
    const candidates = await dependencies.candidates({ ...input, afterId: progress.afterId ?? undefined });
    hasMore = candidates.length > input.batchSize;
    const page = candidates.slice(0, input.batchSize);
    if (!page.length) break;
    const requested = new Set(page.map((row) => row.shopifyOrderId));
    const fetched = await dependencies.fetch([...requested]);
    if (fetched.some((order) => !requested.has(order.id))) {
      throw new Error("Shopify returned an order outside the scoped backfill batch");
    }
    const orders = [...new Map(fetched.map((order) => [order.id, order])).values()];
    if (orders.length) await dependencies.ingest({ organizationId: input.organizationId, store, orders });
    progress.scanned += page.length;
    progress.fetched += orders.length;
    progress.missingFromSource += requested.size - orders.length;
    progress.afterId = page.at(-1)!.id;
    onProgress({ ...progress });
    if (!hasMore) break;
  }
  return { ...progress, hasMore, nextCursor: hasMore ? progress.afterId : null, coverage: "unknown" as const };
}
