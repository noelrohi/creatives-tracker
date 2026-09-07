import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shopifyGraphql } from "./shopify-admin";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "synthetic.myshopify.com");
  vi.stubEnv("SHOPIFY_ACCESS_TOKEN", "synthetic-test-token");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bounded Shopify capability transport options", () => {
  it("passes abort through to fetch and stops a stalled request", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const result = shopifyGraphql("query { shop { myshopifyDomain } }", undefined, { signal: controller.signal, retry: false });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it.each([429, 500])("does not retry HTTP %s when retries are disabled", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(shopifyGraphql("query {}", undefined, { retry: false })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not retry GraphQL throttling when retries are disabled", async () => {
    fetchMock.mockResolvedValue(Response.json({ errors: [{ extensions: { code: "THROTTLED" } }] }));
    await expect(shopifyGraphql("query {}", undefined, { retry: false })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retains default retries for existing callers", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(Response.json({ data: { ok: true } }));
      const result = shopifyGraphql<{ ok: boolean }>("query {}");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
