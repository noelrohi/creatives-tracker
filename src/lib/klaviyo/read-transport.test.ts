import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KlaviyoReadError,
  KlaviyoReadTransport,
  type KlaviyoReadInput,
  type KlaviyoReadRequester,
} from "./read-transport";

const SECRET = "pk_transport_test_secret";
const MAX_BYTES = 16 * 1024 * 1024;
const json = (value: unknown = { data: [] }) => new Response(JSON.stringify(value));

function setup(fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json())) {
  let time = Date.UTC(2026, 8, 7);
  const sleep = vi.fn(async (ms: number) => { time += ms; });
  const transport = new KlaviyoReadTransport({
    privateApiKey: SECRET, fetchImpl, sleep, random: () => 0, now: () => time,
  });
  return { transport, fetchImpl, sleep, advance: (ms: number) => { time += ms; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("KlaviyoReadTransport", () => {
  it.each([
    ["campaigns", "/api/campaigns", "GET"],
    ["metrics", "/api/metrics", "GET"],
    ["events", "/api/events", "GET"],
    ["campaignValues", "/api/campaign-values-reports", "POST"],
  ] as const)("pins %s to its read endpoint", async (resource, path, method) => {
    const { transport, fetchImpl } = setup();
    const requester: KlaviyoReadRequester = transport;
    const body = resource === "campaignValues" ? { data: { type: "campaign-values-report" } } : undefined;
    await expect(requester.request({ resource, params: new URLSearchParams("page%5Bcursor%5D=abc"), body }))
      .resolves.toEqual({ data: [] });
    const [target, options] = fetchImpl.mock.calls[0];
    const url = new URL(String(target));
    expect(url.origin).toBe("https://a.klaviyo.com");
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get("page[cursor]")).toBe("abc");
    expect(String(target)).not.toContain(SECRET);
    expect(options).toMatchObject({ method, redirect: "error", credentials: "omit", cache: "no-store" });
    expect(options?.headers).toEqual({
      accept: "application/vnd.api+json", authorization: `Klaviyo-API-Key ${SECRET}`,
      revision: "2026-07-15", ...(body ? { "content-type": "application/vnd.api+json" } : {}),
    });
    expect(options?.body).toBe(body ? JSON.stringify(body) : undefined);
    expect(inspect(transport)).not.toContain(SECRET);
  });

  it("returns JSON unchanged without following pagination", async () => {
    const data = { data: [], links: { next: "https://evil.example/next" } };
    const { transport, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(json(data)));
    await expect(transport.request({ resource: "events" })).resolves.toEqual(data);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["https://evil.example", "toString", "__proto__"])("rejects unsupported resource %s", async (resource) => {
    const { transport, fetchImpl } = setup();
    await expect(transport.request({ resource } as KlaviyoReadInput)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects GET bodies and nonserializable POST input without leaking exceptions", async () => {
    const { transport, fetchImpl } = setup();
    for (const input of [
      { resource: "events", body: {} },
      { resource: "campaignValues", body: { toJSON() { throw new Error(SECRET); } } },
      { resource: "campaignValues", body: BigInt(1) },
    ] as KlaviyoReadInput[]) {
      const error = await transport.request(input).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(inspect(error)).not.toContain(SECRET);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["", " ", "pk_bad\r\nheader"])("rejects invalid credentials safely", (privateApiKey) => {
    expect(() => new KlaviyoReadTransport({ privateApiKey })).toThrow(KlaviyoReadError);
  });

  it("rejects advertised oversized bodies without reading and cancels them", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(MAX_BYTES + 1) },
    });
    const { transport } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(cancel).toHaveBeenCalled();
  });

  it.each([undefined, "1"])("counts streamed bytes despite content-length %s", async (length) => {
    const cancel = vi.fn();
    let sent = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(++sent === 1 ? MAX_BYTES : 1).fill(32)); },
      cancel,
    }), { headers: length ? { "content-length": length } : undefined });
    const { transport, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(cancel).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 16 MiB and decodes split multibyte characters", async () => {
    const text = '"' + "é" + " ".repeat(MAX_BYTES - 4) + '"';
    const bytes = new TextEncoder().encode(text);
    expect(bytes.length).toBe(MAX_BYTES);
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    } }));
    const { transport } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(transport.request({ resource: "events" })).resolves.toBe(JSON.parse(text));
  });

  it.each(["stream", "json", "utf8"])("sanitizes invalid %s responses without retry", async (kind) => {
    const response = kind === "stream" ? new Response(new ReadableStream({ pull(controller) {
      controller.error(new Error(SECRET));
    } })) : new Response(kind === "json" ? SECRET : new Uint8Array([0xff]));
    const { transport, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    const error = await transport.request({ resource: "metrics" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(inspect(error)).not.toContain(SECRET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 307, 308, 401, 403, 400, 429, 503])("sanitizes HTTP %s failures", async (status) => {
    const { transport, fetchImpl } = setup(vi.fn<typeof fetch>().mockImplementation(async () => new Response(SECRET, { status })));
    const error = await transport.request({ resource: "events" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(KlaviyoReadError);
    expect(error).toMatchObject({ code: status === 429 ? "rate_limited" : status === 503 ? "unavailable"
      : status === 401 || status === 403 ? "credential_rejected" : "invalid_response" });
    expect(inspect(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(fetchImpl).toHaveBeenCalledTimes(status === 429 || status === 503 ? 4 : 1);
  });

  it("rejects an already redirected response from injected fetch", async () => {
    const response = json();
    Object.defineProperty(response, "redirected", { value: true });
    const { transport, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries network errors with bounded exponential jitter and hides their cause", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(SECRET));
    const sleep = vi.fn(async () => undefined);
    const transport = new KlaviyoReadTransport({ privateApiKey: SECRET, fetchImpl, sleep, random: () => 0.5 });
    const error = await transport.request({ resource: "metrics" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(inspect(error)).not.toContain(SECRET);
    expect(sleep.mock.calls).toEqual([[625], [1125], [2125]]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each(["2.5", "Mon, 07 Sep 2026 00:00:03 GMT"])("honors Retry-After %s", async (guidance) => {
    const { transport, fetchImpl, sleep } = setup(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": guidance } }))
      .mockResolvedValueOnce(json()));
    await transport.request({ resource: "campaignValues", body: {} });
    expect(sleep).toHaveBeenCalledWith(guidance === "2.5" ? 2500 : 3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])("returns long provider guidance for %s without retrying early", async (status) => {
    const { transport, fetchImpl, sleep } = setup(vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status, headers: { "retry-after": "30" } }),
    ));
    await expect(transport.request({ resource: "campaignValues" })).rejects.toMatchObject({
      code: status === 429 ? "rate_limited" : "unavailable", retryAfterMs: 30_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["nonsense", "0", "-1"])("uses backoff for absent or shorter guidance (%s)", async (guidance) => {
    const { transport, sleep } = setup(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "retry-after": guidance } }))
      .mockResolvedValueOnce(json()));
    await transport.request({ resource: "metrics" });
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("does not turn overflowing Retry-After into an early retry", async () => {
    const { transport, fetchImpl, sleep } = setup(vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 429, headers: { "retry-after": "9".repeat(400) } }),
    ));
    await expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({
      code: "rate_limited", retryAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a success received after the total deadline", async () => {
    const { transport, fetchImpl, advance } = setup();
    fetchImpl.mockImplementation(async () => { advance(25_000); return json(); });
    await expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accounts for elapsed fetch time when deciding whether guidance fits", async () => {
    const { transport, fetchImpl, sleep, advance } = setup();
    fetchImpl.mockImplementation(async () => {
      advance(9000);
      return new Response(null, { status: 429, headers: { "retry-after": "17" } });
    });
    await expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 17000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not launch another attempt after a sleep exhausts the total deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    let time = 0;
    const transport = new KlaviyoReadTransport({ privateApiKey: SECRET, fetchImpl, now: () => time,
      sleep: async () => { time = 25_000; }, random: () => 0 });
    await expect(transport.request({ resource: "events" })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "body"])("bounds stalled %s even when abort is ignored", async (kind) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => kind === "fetch"
      ? new Promise<Response>(() => undefined)
      : new Response(new ReadableStream({ cancel })));
    const transport = new KlaviyoReadTransport({ privateApiKey: SECRET, fetchImpl, random: () => 0 });
    const assertion = expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "limit_exceeded" });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchImpl.mock.calls) expect(options?.signal?.aborted).toBe(true);
    if (kind === "body") expect(cancel).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled injected sleep", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(SECRET));
    const transport = new KlaviyoReadTransport({ privateApiKey: SECRET, fetchImpl,
      sleep: () => new Promise(() => undefined), random: () => 0 });
    const assertion = expect(transport.request({ resource: "metrics" })).rejects.toMatchObject({ code: "limit_exceeded" });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
