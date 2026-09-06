import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillFulfillmentStatuses } from "./shopify-fulfillment-backfill";

const input = { organizationId: "org-a", storeId: "store-a", batchSize: 2, maxBatches: 1 };
const dependencies = {
  configuredDomain: vi.fn(() => "synthetic.myshopify.com"),
  store: vi.fn(async () => ({ id: "store-a", organizationId: "org-a", shopDomain: "synthetic.myshopify.com", ianaTimezone: "UTC" })),
  candidates: vi.fn(), fetch: vi.fn(), ingest: vi.fn(),
};
const candidates = ["a", "b", "c"].map((id) => ({ id, shopifyOrderId: `gid://shopify/Order/${id}` }));
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.store.mockResolvedValue({ id: "store-a", organizationId: "org-a", shopDomain: "synthetic.myshopify.com", ianaTimezone: "UTC" });
  dependencies.candidates.mockResolvedValue(candidates);
  dependencies.fetch.mockResolvedValue([{ id: candidates[0].shopifyOrderId, createdAt: "2026-01-01T00:00:00Z", displayFulfillmentStatus: "FULFILLED" }]);
  dependencies.ingest.mockResolvedValue(undefined);
});

describe("explicit fulfillment backfill", () => {
  it("bounds batches, advances past inaccessible IDs and reports continuation without claiming completeness", async () => {
    const progress = vi.fn();
    const result = await backfillFulfillmentStatuses(input, dependencies, progress);
    expect(dependencies.fetch).toHaveBeenCalledWith(candidates.slice(0, 2).map((row) => row.shopifyOrderId));
    expect(result).toEqual({ scanned: 2, fetched: 1, missingFromSource: 1, afterId: "b", hasMore: true, nextCursor: "b", coverage: "unknown" });
    expect(progress).toHaveBeenCalledWith({ scanned: 2, fetched: 1, missingFromSource: 1, afterId: "b" });
    expect(dependencies.ingest).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-a", store: expect.objectContaining({ id: "store-a" }) }));
  });

  it("resumes from an explicit cursor and stops on the final page", async () => {
    dependencies.candidates.mockResolvedValue([candidates[2]]);
    dependencies.fetch.mockResolvedValue([]);
    const result = await backfillFulfillmentStatuses({ ...input, afterId: "b", maxBatches: 10 }, dependencies);
    expect(dependencies.candidates).toHaveBeenCalledWith(expect.objectContaining({ ...input, maxBatches: 10, afterId: "b" }));
    expect(result).toMatchObject({ scanned: 1, missingFromSource: 1, hasMore: false, nextCursor: null });
    expect(dependencies.ingest).not.toHaveBeenCalled();
  });

  it("does not advance the reported cursor past a failed ingest", async () => {
    dependencies.ingest.mockRejectedValueOnce(new Error("write failed"));
    const progress = vi.fn();
    await expect(backfillFulfillmentStatuses(input, dependencies, progress)).rejects.toThrow("write failed");
    expect(progress).not.toHaveBeenCalled();
  });

  it.each([
    { organizationId: "other" }, { id: "other" }, { shopDomain: "other.myshopify.com" },
  ])("rejects binding mismatch before credential-backed fetching: %j", async (mismatch) => {
    dependencies.store.mockResolvedValue({ id: "store-a", organizationId: "org-a", shopDomain: "synthetic.myshopify.com", ianaTimezone: "UTC", ...mismatch });
    await expect(backfillFulfillmentStatuses(input, dependencies)).rejects.toThrow("does not match");
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.candidates).not.toHaveBeenCalled();
  });

  it("rejects returned orders outside the scoped ID batch", async () => {
    dependencies.fetch.mockResolvedValue([{ id: "unexpected", createdAt: "2026-01-01T00:00:00Z" }]);
    await expect(backfillFulfillmentStatuses(input, dependencies)).rejects.toThrow("outside the scoped");
    expect(dependencies.ingest).not.toHaveBeenCalled();
  });

  it("rejects oversized payloads before any store access", async () => {
    await expect(backfillFulfillmentStatuses({ ...input, batchSize: 101 }, dependencies)).rejects.toThrow();
    expect(dependencies.store).not.toHaveBeenCalled();
  });
});
