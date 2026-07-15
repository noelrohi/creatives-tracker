import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteImage } from "./remote-image";

const originalFetch = globalThis.fetch;

function mockFetch(fetchMock: typeof fetch) {
  globalThis.fetch = fetchMock;
}

describe("fetchRemoteImage", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    "http://127.0.0.1/image.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/image.png",
  ])("rejects private address %s", async (url) => {
    const fetchMock = vi.fn();
    mockFetch(fetchMock as typeof fetch);

    await expect(fetchRemoteImage(url)).rejects.toThrow(
      "private or reserved address",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates redirect destinations before following them", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal.png" },
      }),
    );
    mockFetch(fetchMock as typeof fetch);

    await expect(fetchRemoteImage("https://8.8.8.8/image.png")).rejects.toThrow(
      "private or reserved address",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized responses before buffering them", async () => {
    mockFetch(
      vi.fn(async () =>
        new Response(new Uint8Array([1]), {
          headers: {
            "content-type": "image/png",
            "content-length": String(11 * 1024 * 1024),
          },
        })) as typeof fetch,
    );

    await expect(fetchRemoteImage("https://8.8.8.8/image.png")).rejects.toThrow(
      "10 MB limit",
    );
  });

  it("rejects non-image responses", async () => {
    mockFetch(
      vi.fn(async () =>
        new Response("not an image", {
          headers: { "content-type": "text/plain" },
        })) as typeof fetch,
    );

    await expect(fetchRemoteImage("https://8.8.8.8/image.png")).rejects.toThrow(
      "did not return an image",
    );
  });
});
