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

  it("snapshots every event input value exactly once before query construction", async () => {
    const reads = {
      metricId: 0,
      from: 0,
      to: 0,
      cursor: 0,
      includeAttributions: 0,
      includeProfileEmail: 0,
    };
    const input = {
      get metricId() {
        reads.metricId += 1;
        return reads.metricId === 1 ? "metric-stable" : "metric-mutated";
      },
      get from() {
        reads.from += 1;
        return reads.from === 1
          ? new Date("2026-05-01T00:00:00.000Z")
          : new Date("invalid");
      },
      get to() {
        reads.to += 1;
        return reads.to === 1
          ? new Date("2026-07-30T00:00:00.000Z")
          : new Date("invalid");
      },
      get cursor() {
        reads.cursor += 1;
        return reads.cursor === 1 ? "cursor-stable" : null;
      },
      get includeAttributions() {
        reads.includeAttributions += 1;
        return true;
      },
      get includeProfileEmail() {
        reads.includeProfileEmail += 1;
        return reads.includeProfileEmail === 1;
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successfulPage());
    const client = clientWith(fetchMock);

    await client.listEvents(input);

    expect(reads).toEqual({
      metricId: 1,
      from: 1,
      to: 1,
      cursor: 1,
      includeAttributions: 1,
      includeProfileEmail: 1,
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("include")).toBe(
      "profile,metric,attributions",
    );
    expect(url.searchParams.get("fields[profile]")).toBe("email");
    expect(url.searchParams.get("page[cursor]")).toBe("cursor-stable");
    expect(url.searchParams.get("filter")).toContain(
      'equals(metric_id,"metric-stable")',
    );
  });

  it("copies each event date before a later getter can mutate it", async () => {
    const mutableFrom = new Date("2026-05-01T00:00:00.000Z");
    const input = {
      metricId: "metric-stable",
      get from() {
        return mutableFrom;
      },
      get to() {
        mutableFrom.setUTCFullYear(2030);
        return new Date("2026-07-30T00:00:00.000Z");
      },
      cursor: null,
      includeAttributions: true,
      includeProfileEmail: false,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successfulPage());
    const client = clientWith(fetchMock);

    await client.listEvents(input);

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("filter")).toContain(
      "greater-or-equal(datetime,2026-05-01T00:00:00.000Z)",
    );
  });

  it.each([
    [new Date("invalid"), new Date("2026-07-30T00:00:00.000Z")],
    [new Date("2026-05-01T00:00:00.000Z"), new Date("invalid")],
    [
      new Date("2026-07-30T00:00:00.000Z"),
      new Date("2026-07-30T00:00:00.000Z"),
    ],
    [
      new Date("2026-07-31T00:00:00.000Z"),
      new Date("2026-07-30T00:00:00.000Z"),
    ],
  ])("rejects an invalid or empty half-open event window before fetch", async (from, to) => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = clientWith(fetchMock);

    const error = await client
      .listEvents({
        metricId: "metric-1",
        from,
        to,
        cursor: null,
        includeAttributions: true,
        includeProfileEmail: false,
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(error).toMatchObject({ status: null, retryable: false });
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo event request has an invalid half-open window",
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(error).toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 61_000,
    });
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo API retry delay exceeds client limit",
    );
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
    expect(String(error)).not.toContain("user@example.com");
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes a final 429 delay for durable runner rescheduling", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("retry-1", {
        status: 429,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response("retry-2", {
        status: 429,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response("retry-3", {
        status: 429,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response("body_secret=pk_secret", {
        status: 429,
        headers: { "retry-after": "7" },
      }));
    const client = clientWith(fetchMock, { sleep });

    const error = await client.listMetrics(null).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(error).toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 7_000,
    });
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo API request failed (429)",
    );
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
    expect(sleep.mock.calls).toEqual([[0], [0], [0]]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    [
      "fragment",
      "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=cursor#fragment",
    ],
    [
      "empty fragment",
      "https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=cursor#",
    ],
    [
      "dot-segment path",
      "https://a.klaviyo.com/api/ignored/../metrics?page%5Bcursor%5D=cursor",
    ],
    [
      "encoded dot-segment path",
      "https://a.klaviyo.com/api/%2e/metrics?page%5Bcursor%5D=cursor",
    ],
  ])("rejects a %s pagination link with one fixed safe error", async (_, next) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successfulPage(next.includes("#") ? next : `${next}&body_secret=pk_secret`),
    );
    const client = clientWith(fetchMock);

    const error = await client.listMetrics(null).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo returned an invalid pagination link",
    );
    expect(String(error)).not.toContain(PRIVATE_API_KEY);
  });

  it("rejects an oversized pagination cursor with the fixed safe error", async () => {
    const oversizedCursor = "x".repeat(4_097);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successfulPage(
        `https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=${oversizedCursor}`,
      ),
    );
    const client = clientWith(fetchMock);

    const error = await client.listMetrics(null).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo returned an invalid pagination link",
    );
    expect(String(error)).not.toContain(oversizedCursor);
  });

  it("rejects an oversized persisted cursor before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = clientWith(fetchMock);

    const error = await client
      .listMetrics("x".repeat(4_097))
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(KlaviyoApiError);
    expect(String(error)).toBe(
      "KlaviyoApiError: Klaviyo request cursor is invalid",
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(error).toMatchObject({
      status: 403,
      retryable: false,
      retryAfterMs: null,
    });
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

  it("discards a retry response body before requesting again", async () => {
    const retryResponse = new Response("provider-private-body", {
      status: 503,
    });
    const cancel = vi.spyOn(retryResponse.body!, "cancel");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(successfulPage());
    const client = clientWith(fetchMock);

    await client.listAccounts();

    expect(cancel).toHaveBeenCalledOnce();
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

describe("getEventById", () => {
  function singleEventResponse(id: string, includeProfile: boolean) {
    return new Response(
      JSON.stringify({
        data: {
          type: "event",
          id,
          attributes: { datetime: "2026-07-20T10:00:00.000Z" },
        },
        included: includeProfile
          ? [
              {
                type: "profile",
                id: "profile-1",
                attributes: { email: "subject@example.com" },
              },
            ]
          : [],
      }),
      { status: 200, headers: { "content-type": "application/vnd.api+json" } },
    );
  }

  it("sparse-includes profile email only for identity rotation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(singleEventResponse("event-1", true));
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });
    const result = await client.getEventById({
      externalEventId: "event-1",
      request: {
        purpose: "identity_rotation",
        include: ["profile"],
        profileFields: ["email"],
      },
    });
    expect(result).toMatchObject({
      purpose: "identity_rotation",
      profileId: "profile-1",
      profileEmail: "subject@example.com",
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/events/event-1");
    expect(url.searchParams.get("include")).toBe("profile");
    expect(url.searchParams.get("fields[profile]")).toBe("email");
  });

  it("never includes profile email for claim purposes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(singleEventResponse("event-1", false));
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });
    const result = await client.getEventById({
      externalEventId: "event-1",
      request: { purpose: "attribution_claim", include: ["metric", "attributions"] },
    });
    expect(result.purpose).toBe("attribution_claim");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("include")).toBe("metric,attributions");
    expect(url.searchParams.has("fields[profile]")).toBe(false);
  });

  it("rejects altered includes and mismatched returned IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(singleEventResponse("event-OTHER", false));
    const client = new KlaviyoApiClient({
      privateApiKey: "pk_secret",
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });
    await expect(
      client.getEventById({
        externalEventId: "event-1",
        request: {
          purpose: "identity_rotation",
          include: ["profile", "metric"],
          profileFields: ["email"],
        } as never,
      }),
    ).rejects.toThrow("single-event request is invalid");
    await expect(
      client.getEventById({
        externalEventId: "event-1",
        request: { purpose: "referenced_interaction", include: ["metric"] },
      }),
    ).rejects.toThrow("different event than requested");
    await expect(
      client.getEventById({
        externalEventId: "event/../1",
        request: { purpose: "referenced_interaction", include: ["metric"] },
      }),
    ).rejects.toThrow("single-event request is invalid");
  });
});

describe("dimension traversal client", () => {
  it("pins the campaigns revision and filters one explicit channel", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ type: "campaign", id: "campaign-1", attributes: { name: "Sale" } }],
        links: { next: null },
      }),
    );
    const client = clientWith(fetchMock);

    const page = await client.listCampaigns({ channel: "email", cursor: null });

    const [request, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(request);
    expect(url.pathname).toBe("/api/campaigns");
    expect(url.searchParams.get("filter")).toBe(
      "equals(messages.channel,'email')",
    );
    expect(new Headers(init.headers).get("revision")).toBe(
      KLAVIYO_API_REVISIONS.campaigns,
    );
    expect(page.apiRevision).toBe(KLAVIYO_API_REVISIONS.campaigns);
    expect(page.data[0].id).toBe("campaign-1");
  });

  it("covers both campaign channels and rejects any other channel", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [], links: { next: null } }));
    const client = clientWith(fetchMock);

    await client.listCampaigns({ channel: "sms", cursor: null });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("filter")).toBe(
      "equals(messages.channel,'sms')",
    );
    await expect(
      client.listCampaigns({
        channel: "push" as unknown as "email",
        cursor: null,
      }),
    ).rejects.toThrow("invalid channel");
  });

  it("paginates campaigns by validated same-path cursor", async () => {
    const nextLink =
      "https://a.klaviyo.com/api/campaigns?page%5Bcursor%5D=cursor-2";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ data: [], links: { next: nextLink } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [], links: { next: null } }));
    const client = clientWith(fetchMock);

    const first = await client.listCampaigns({ channel: "email", cursor: null });
    expect(first.nextCursor).toBe("cursor-2");
    const second = await client.listCampaigns({
      channel: "email",
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBeNull();
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("page[cursor]")).toBe("cursor-2");
  });

  it("traverses campaign messages under one validated campaign path", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          {
            type: "campaign-message",
            id: "message-1",
            attributes: { label: "Message A", channel: "email" },
          },
        ],
        links: { next: null },
      }),
    );
    const client = clientWith(fetchMock);

    const page = await client.listCampaignMessages({
      campaignId: "campaign-1",
      cursor: null,
    });
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe(
      "/api/campaigns/campaign-1/campaign-messages",
    );
    expect(page.data[0].attributes?.label).toBe("Message A");
    await expect(
      client.listCampaignMessages({ campaignId: "../events", cursor: null }),
    ).rejects.toThrow("invalid identifier");
  });

  it("walks flow to action to message with the pinned flows revision", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ type: "flow", id: "flow-1", attributes: { name: "Welcome" } }],
          links: { next: null },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ type: "flow-action", id: "action-1", attributes: {} }],
          links: { next: null },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              type: "flow-message",
              id: "flow-message-1",
              attributes: { name: "Welcome Email" },
            },
          ],
          links: { next: null },
        }),
      );
    const client = clientWith(fetchMock);

    await client.listFlows({ cursor: null });
    await client.listFlowActions({ flowId: "flow-1", cursor: null });
    const messages = await client.listFlowMessages({
      actionId: "action-1",
      cursor: null,
    });
    expect(new URL(fetchMock.mock.calls[1][0] as string).pathname).toBe(
      "/api/flows/flow-1/flow-actions",
    );
    expect(new URL(fetchMock.mock.calls[2][0] as string).pathname).toBe(
      "/api/flow-actions/action-1/flow-messages",
    );
    for (const call of fetchMock.mock.calls) {
      expect(new Headers((call[1] as RequestInit).headers).get("revision")).toBe(
        KLAVIYO_API_REVISIONS.flows,
      );
    }
    expect(messages.data[0].id).toBe("flow-message-1");
  });

  it("pages account tracking settings and forbids an object ID there", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          {
            type: "tracking-setting",
            id: "tracking-1",
            attributes: { utm_source: "klaviyo", auto_add_parameters: true },
          },
        ],
        links: { next: null },
      }),
    );
    const client = clientWith(fetchMock);

    const page = await client.getTrackingSettings({
      scope: "account",
      externalId: null,
      cursor: null,
    });
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe(
      "/api/tracking-settings",
    );
    expect(
      new Headers(
        (fetchMock.mock.calls[0][1] as RequestInit).headers,
      ).get("revision"),
    ).toBe(KLAVIYO_API_REVISIONS.trackingSettings);
    expect(page.data[0].attributes?.utm_source).toBe("klaviyo");
    await expect(
      client.getTrackingSettings({
        scope: "account",
        externalId: "message-1",
        cursor: null,
      }),
    ).rejects.toThrow("cannot carry an object ID");
  });

  it("fetches message-scope tracking as a single resource without cursors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          type: "campaign-message",
          id: "message-1",
          attributes: { label: "A", tracking_options: [] },
        },
      }),
    );
    const client = clientWith(fetchMock);

    const page = await client.getTrackingSettings({
      scope: "campaign_message",
      externalId: "message-1",
      cursor: null,
    });
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe(
      "/api/campaign-messages/message-1",
    );
    expect(page.data).toHaveLength(1);
    await expect(
      client.getTrackingSettings({
        scope: "flow_message",
        externalId: "message-1",
        cursor: "cursor-1",
      }),
    ).rejects.toThrow("message tracking request is invalid");
  });

  it("retries dimension rate limits with the shared bounded policy", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({}, 429, { "retry-after": "1" }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [], links: { next: null } }));
    const client = clientWith(fetchMock);

    const page = await client.listFlows({ cursor: null });
    expect(page.data).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed dimension collections fail-closed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ type: "campaign" }] }));
    const client = clientWith(fetchMock);

    await expect(
      client.listCampaigns({ channel: "email", cursor: null }),
    ).rejects.toThrow("response was invalid");
  });
});

describe("queryValuesReport", () => {
  const request = {
    connectionId: "connection-a",
    kind: "campaign" as const,
    conversionMetricRowId: "metric-row-1",
    conversionExternalMetricId: "metric-ext-1",
    timeframe: {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    statistics: ["conversions" as const],
    grouping: ["campaign_id" as const, "send_date" as const],
    apiRevision: "2026-07-15",
    asOf: "2026-08-05T00:00:00.000Z",
  };

  it("POSTs only the external conversion metric ID on the reports revision", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          type: "campaign-values-report",
          id: "report-1",
          attributes: { results: [] },
        },
      }),
    );
    const client = clientWith(fetchMock);

    const page = await client.queryValuesReport({ request, pageCursor: null });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/campaign-values-reports");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("revision")).toBe(
      KLAVIYO_API_REVISIONS.reports,
    );
    const body = JSON.parse(init.body as string);
    expect(body.data.attributes.conversion_metric_id).toBe("metric-ext-1");
    expect(JSON.stringify(body)).not.toContain("metric-row-1");
    expect(page.data).toHaveLength(1);
  });

  it("rejects malformed report requests before any provider call", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = clientWith(fetchMock);
    await expect(
      client.queryValuesReport({
        request: { ...request, statistics: [] },
        pageCursor: null,
      }),
    ).rejects.toThrow("report request is invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
