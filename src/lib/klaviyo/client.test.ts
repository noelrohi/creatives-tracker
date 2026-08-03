import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KLAVIYO_API_REVISIONS,
  KlaviyoApiClient,
  KlaviyoApiError,
} from "@/lib/klaviyo/client";

const PRIVATE_API_KEY = "pk_secret";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/vnd.api+json",
      ...headers,
    },
  });
}

function successfulPage(next: unknown = null) {
  return jsonResponse({ data: [], links: { next } });
}

function clientWith(fetchImpl: typeof fetch, overrides: {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
} = {}) {
  return new KlaviyoApiClient({
    privateApiKey: PRIVATE_API_KEY,
    fetchImpl,
    sleep: overrides.sleep ?? (async () => undefined),
    random: overrides.random ?? (() => 0),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("KlaviyoApiClient", () => {
  it("uses the Accounts revision and private-key header", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [],
        links: { self: "https://a.klaviyo.com/api/accounts" },
      }),
    );
    const client = clientWith(fetchMock);

    await client.listAccounts();

    const [request, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(request).toBe("https://a.klaviyo.com/api/accounts");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("accept")).toBe(
      "application/vnd.api+json",
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Klaviyo-API-Key ${PRIVATE_API_KEY}`,
    );
    expect(new Headers(init.headers).get("revision")).toBe(
      KLAVIYO_API_REVISIONS.accounts,
    );
  });

  it("requests only sparse profile email for event identity", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successfulPage());
    const client = clientWith(fetchMock);

    await client.listEvents({
      metricId: "metric-1",
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
      cursor: null,
      includeAttributions: true,
      includeProfileEmail: true,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("include")).toBe(
      "profile,metric,attributions",
    );
    expect(url.searchParams.get("fields[profile]")).toBe("email");
    expect(url.searchParams.get("page[size]")).toBe("200");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("revision")).toBe(
      KLAVIYO_API_REVISIONS.events,
    );
  });

  it("omits profile email from Plan 2 source pages that do not hash identity", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successfulPage());
    const client = clientWith(fetchMock);

    await client.listEvents({
      metricId: "metric-1",
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
      cursor: null,
      includeAttributions: true,
      includeProfileEmail: false,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("include")).toBe("metric,attributions");
    expect(url.searchParams.has("fields[profile]")).toBe(false);
  });

  it("quotes the metric ID but leaves ISO datetime filter literals unquoted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successfulPage());
    const client = clientWith(fetchMock);

    await client.listEvents({
      metricId: "metric-\"quoted",
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
      cursor: null,
      includeAttributions: false,
      includeProfileEmail: false,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("filter")).toBe(
      "and(equals(metric_id,\"metric-\\\"quoted\")," +
        "greater-or-equal(datetime,2026-05-01T00:00:00.000Z)," +
        "less-than(datetime,2026-07-30T00:00:00.000Z))",
    );
  });

  it("omits unsupported page size from Metrics and sends only an opaque cursor", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successfulPage());
    const client = clientWith(fetchMock);

    await client.listMetrics("opaque-token");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/metrics");
    expect([...url.searchParams.entries()]).toEqual([
      ["page[cursor]", "opaque-token"],
    ]);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("revision")).toBe(
      KLAVIYO_API_REVISIONS.metrics,
    );
  });

  it("honors Retry-After and returns only the opaque next cursor", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [] }, 429, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(
        successfulPage(
          "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=opaque-token",
        ),
      );
    const client = clientWith(fetchMock, { sleep });

    await expect(client.listMetrics(null)).resolves.toMatchObject({
      nextCursor: "opaque-token",
      apiRevision: KLAVIYO_API_REVISIONS.metrics,
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("hands a Retry-After above 60 seconds to the outer retry boundary", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("key=pk_secret&email=user@example.com", {
        status: 429,
        headers: { "retry-after": "61" },
      }),
    );
    const client = clientWith(fetchMock, { sleep });

    const error = await client.listMetrics(null).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo API retry delay exceeds client limit",
    );
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
    expect(String(error)).not.toContain("user@example.com");
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a pagination link on another host", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successfulPage(
        "https://evil.example/api/metrics?page%5Bcursor%5D=secret-token",
      ),
    );
    const client = clientWith(fetchMock);

    const error = await client.listMetrics(null).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(error).toMatchObject({
      message: "Klaviyo returned an invalid pagination link",
      status: null,
      retryable: false,
    });
    expect(String(error)).not.toContain("evil.example");
    expect(String(error)).not.toContain("secret-token");
  });

  it.each([
    ["malformed", "not a URL"],
    [
      "non-HTTPS",
      "http://a.klaviyo.com/api/metrics?page%5Bcursor%5D=cursor",
    ],
    [
      "userinfo",
      "https://user:password@a.klaviyo.com/api/metrics?page%5Bcursor%5D=cursor",
    ],
    [
      "wrong endpoint",
      "https://a.klaviyo.com/api/events?page%5Bcursor%5D=cursor",
    ],
    [
      "empty cursor",
      "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=",
    ],
    [
      "whitespace cursor",
      "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=+++",
    ],
    [
      "duplicate cursor",
      "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=one&page%5Bcursor%5D=two",
    ],
  ])("rejects a %s pagination link with one fixed safe error", async (_, next) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successfulPage(`${next}&body_secret=pk_secret`),
    );
    const client = clientWith(fetchMock);

    const error = await client.listMetrics(null).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo returned an invalid pagination link",
    );
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
  });

  it("accepts the expected pagination path with a trailing slash", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successfulPage(
        "https://a.klaviyo.com/api/metrics/?page%5Bcursor%5D=opaque-token",
      ),
    );
    const client = clientWith(fetchMock);

    await expect(client.listMetrics(null)).resolves.toMatchObject({
      nextCursor: "opaque-token",
    });
  });

  it("rebuilds the next request and ignores every link parameter except cursor", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successfulPage(
          "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=opaque-token" +
            "&page%5Bsize%5D=999&filter=unsafe&revision=old",
        ),
      )
      .mockResolvedValueOnce(successfulPage());
    const client = clientWith(fetchMock);

    const firstPage = await client.listMetrics(null);
    await client.listMetrics(firstPage.nextCursor);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const nextRequest = new URL(fetchMock.mock.calls[1][0] as string);
    expect([...nextRequest.searchParams.entries()]).toEqual([
      ["page[cursor]", "opaque-token"],
    ]);
  });

  it("throws a sanitized error without response content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("email=user@example.com&key=pk_secret", { status: 403 }),
    );
    const client = clientWith(fetchMock);

    const error = await client.listAccounts().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo API request failed (403)",
    );
    expect(error).toMatchObject({ status: 403, retryable: false });
    expect(String(error)).not.toContain("user@example.com");
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
  });

  it.each([
    [
      "malformed JSON",
      "{body_secret=pk_secret",
      "Klaviyo API response was invalid",
    ],
    ["null body", "null", "Klaviyo API response was invalid"],
    ["array body", "[]", "Klaviyo API response was invalid"],
    [
      "missing collection",
      '{"body_secret":"pk_secret"}',
      "Klaviyo API response did not contain a resource collection",
    ],
    [
      "non-array collection",
      '{"data":{"body_secret":"pk_secret"}}',
      "Klaviyo API response did not contain a resource collection",
    ],
    [
      "non-array included",
      '{"data":[],"included":{"body_secret":"pk_secret"}}',
      "Klaviyo API response was invalid",
    ],
    [
      "non-object links",
      '{"data":[],"links":["pk_secret"]}',
      "Klaviyo API response was invalid",
    ],
    [
      "non-string next link",
      '{"data":[],"links":{"next":{"body_secret":"pk_secret"}}}',
      "Klaviyo returned an invalid pagination link",
    ],
  ])("sanitizes a %s response failure", async (_, rawBody, expectedMessage) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(rawBody, {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      }),
    );
    const client = clientWith(fetchMock);

    const error = await client.listAccounts().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe(`KlaviyoApiError: ${expectedMessage}`);
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
    expect(String(error)).not.toContain("body_secret");
  });

  it("retries transient network and server failures with bounded backoff", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("pk_secret network detail"))
      .mockResolvedValueOnce(new Response("server secret", { status: 503 }))
      .mockResolvedValueOnce(successfulPage());
    const client = clientWith(fetchMock, { sleep, random: () => 0 });

    await expect(client.listAccounts()).resolves.toMatchObject({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
  });

  it("sanitizes exhausted network failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("pk_secret network detail"));
    const client = clientWith(fetchMock);

    const error = await client.listAccounts().catch((value: unknown) => value);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(error).toMatchObject({ status: null, retryable: true });
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo API network request failed",
    );
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
  });

  it("conceals and reuses the one private-key snapshot it validates", async () => {
    let keyReads = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successfulPage());
    const options = {
      get privateApiKey() {
        keyReads += 1;
        return keyReads === 1 ? "pk_initial_secret" : "pk_mutated_secret";
      },
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    };

    const client = new KlaviyoApiClient(options);
    await client.listAccounts();
    await client.listAccounts();

    expect(keyReads).toBe(1);
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("authorization"),
      ),
    ).toEqual([
      "Klaviyo-API-Key pk_initial_secret",
      "Klaviyo-API-Key pk_initial_secret",
    ]);
    expect(Object.keys(client)).not.toContain("options");
    expect(JSON.stringify(client)).not.toContain("pk_initial_secret");
    expect(inspect(client, { showHidden: true })).not.toContain(
      "pk_initial_secret",
    );
  });

  it("rejects an empty private-key snapshot without retaining options", () => {
    expect(
      () =>
        new KlaviyoApiClient({
          privateApiKey: "   ",
          fetchImpl: vi.fn<typeof fetch>(),
        }),
    ).toThrow("Klaviyo private API key is required");
  });
});
