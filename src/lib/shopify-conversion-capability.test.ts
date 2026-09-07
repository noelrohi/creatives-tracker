import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getShopifyShopDomain: vi.fn(), shopifyGraphql: vi.fn() }));
vi.mock("./shopify-admin", async (importOriginal) => ({ ...await importOriginal<typeof import("./shopify-admin")>(), ...mocks }));
import { ShopifyGraphqlError } from "./shopify-admin";
import { conversionAvailabilitySchema, getShopifyConversionAvailability } from "./shopify-conversion-capability";
const store = { shopDomain: "example.myshopify.com" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getShopifyShopDomain.mockReturnValue(store.shopDomain);
});
describe("Shopify conversion capability", () => {
  it.each([
    { scopes: ["read_orders", "read_all_orders"], blocker: "missing_read_reports", granted: false },
    { scopes: ["read_reports"], blocker: "session_semantics_unvalidated", granted: true },
  ])("blocks $blocker without estimating a rate", async ({ scopes, blocker, granted }) => {
    mocks.shopifyGraphql.mockResolvedValue({ shop: { myshopifyDomain: store.shopDomain }, currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) } });
    const result = conversionAvailabilitySchema.parse(await getShopifyConversionAvailability(store));
    expect(result).toMatchObject({ blocker, readReportsGranted: granted, numerator: null, denominator: null, rate: null });
    expect(mocks.shopifyGraphql).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("accessScopes { handle }"), undefined, { signal: expect.any(AbortSignal), retry: false });
    expect(mocks.shopifyGraphql.mock.calls[0][0]).not.toMatch(/shopifyqlQuery|orders/);
    expect(mocks.shopifyGraphql.mock.calls[0][0]).toContain("shop { myshopifyDomain }");
    expect(JSON.stringify(result)).not.toMatch(/accessScopes|read_all_orders|read_orders/);
  });
  it.each([{}, { currentAppInstallation: null }, { currentAppInstallation: { accessScopes: null } }])("rejects malformed scope data", async (data) => {
    mocks.shopifyGraphql.mockResolvedValue(data);
    expect(await getShopifyConversionAvailability(store)).toMatchObject({ blocker: "capability_check_failed", rate: null });
  });
  it("aborts a stalled capability request after five seconds", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      mocks.shopifyGraphql.mockImplementation((_query, _variables, { signal }) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private transport details")), { once: true }));
      });
      const result = getShopifyConversionAvailability(store);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requestSignal?.aborted).toBe(true);
      expect(await result).toMatchObject({ blocker: "capability_check_timed_out", numerator: null, denominator: null, rate: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not disclose reporting capability from a different source shop", async () => {
    mocks.shopifyGraphql.mockResolvedValue({ shop: { myshopifyDomain: "other.myshopify.com" }, currentAppInstallation: { accessScopes: [{ handle: "read_reports" }] } });
    expect(await getShopifyConversionAvailability(store)).toMatchObject({ blocker: "configured_store_mismatch", readReportsGranted: null, numerator: null, denominator: null, rate: null });
  });
  it("requires source shop identity even when scopes are valid", async () => {
    mocks.shopifyGraphql.mockResolvedValue({ currentAppInstallation: { accessScopes: [{ handle: "read_reports" }] } });
    expect(await getShopifyConversionAvailability(store)).toMatchObject({ blocker: "capability_check_failed", readReportsGranted: null });
  });
  it("identifies structured access denial without disclosing the source message", async () => {
    mocks.shopifyGraphql.mockRejectedValue(new ShopifyGraphqlError("private denial details", [{ message: "private details", extensions: { code: "ACCESS_DENIED" } }]));
    const result = await getShopifyConversionAvailability(store);
    expect(result).toMatchObject({ blocker: "access_denied", numerator: null, denominator: null, rate: null });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("sanitizes transport errors", async () => {
    mocks.shopifyGraphql.mockRejectedValue(new Error("ACCESS_DENIED secret-token customer-data"));
    const result = await getShopifyConversionAvailability(store);
    expect(result.blocker).toBe("capability_check_failed");
    expect(JSON.stringify(result)).not.toMatch(/secret-token|customer-data|ACCESS_DENIED/);
  });
  it.each(["other.myshopify.com", "example.myshopify.com/evil", "https://example.myshopify.com"])("never probes an unmatched or unsafe configured domain %s", async (domain) => {
    mocks.getShopifyShopDomain.mockReturnValue(domain);
    expect(await getShopifyConversionAvailability(store)).toMatchObject({ blocker: "configured_store_mismatch" });
    expect(mocks.shopifyGraphql).not.toHaveBeenCalled();
  });
  it("sanitizes missing server configuration", async () => {
    mocks.getShopifyShopDomain.mockImplementation(() => { throw new Error("private configuration"); });
    expect(await getShopifyConversionAvailability(store)).toMatchObject({ blocker: "capability_check_failed" });
    expect(mocks.shopifyGraphql).not.toHaveBeenCalled();
  });
});
