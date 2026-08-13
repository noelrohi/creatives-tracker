import { describe, expect, it, vi } from "vitest";
import {
  GoogleAdsApiError,
  GoogleAdsClient,
  GOOGLE_ADS_API_VERSION,
} from "@/lib/google-ads/client";
import type { ResolvedGoogleAdsCredential } from "@/lib/google-ads/credential-provider";

const CREDENTIAL: ResolvedGoogleAdsCredential = {
  developerToken: "dev-token",
  oauthClientId: "cid",
  oauthClientSecret: "secret",
  refreshToken: "refresh",
  customerId: "1234567890",
  loginCustomerId: "0987654321",
  reference: "reviv_environment",
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenResponse() {
  return jsonResponse(200, { access_token: "at-1", expires_in: 3600 });
}

function makeClient(fetchImpl: typeof fetch) {
  return new GoogleAdsClient({
    credential: CREDENTIAL,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });
}

describe("GoogleAdsClient", () => {
  it("refreshes a token once and searches with pinned version and headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.includes("oauth2.googleapis.com")) return tokenResponse();
      return jsonResponse(200, {
        results: [{ campaign: { id: "1" } }],
        nextPageToken: "tok-2",
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.results).toHaveLength(1);
    expect(page.nextPageToken).toBe("tok-2");

    await client.search({ query: "SELECT campaign.id FROM campaign", pageToken: "tok-2" });
    const tokenCalls = calls.filter((call) => call.url.includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);

    const searchCall = calls.find((call) => call.url.includes("googleads"));
    expect(searchCall?.url).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:search`,
    );
    const headers = new Headers(searchCall?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer at-1");
    expect(headers.get("developer-token")).toBe("dev-token");
    expect(headers.get("login-customer-id")).toBe("0987654321");
  });

  it("retries retryable statuses and succeeds", async () => {
    let searchAttempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      searchAttempts += 1;
      if (searchAttempts < 3) return jsonResponse(500, { error: {} });
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.results).toEqual([]);
    expect(searchAttempts).toBe(3);
  });

  it("fails fast on a 400 without leaking the body", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(400, { error: { message: "secret detail" } });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const failure = await client
      .search({ query: "bad" })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(GoogleAdsApiError);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(false);
    expect(apiError.status).toBe(400);
    expect(apiError.message).not.toContain("secret detail");
  });

  it("throws a retryable error after exhausting attempts on 429", async () => {
    let searchAttempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      searchAttempts += 1;
      return jsonResponse(429, {}, { "retry-after": "1" });
    }) as typeof fetch;

    const client = new GoogleAdsClient({
      credential: CREDENTIAL,
      fetchImpl,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      random: () => 0,
    });
    const failure = await client
      .search({ query: "SELECT campaign.id FROM campaign" })
      .then(() => null, (error: unknown) => error);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(true);
    expect(apiError.status).toBe(429);
    expect(searchAttempts).toBe(4);
    // retry-after: "1" (1000ms) never exceeds later bases, so with
    // random()=0 each sleep is exactly the unjittered base: 1000, 2000, 4000.
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("throws immediately when retry-after exceeds the client's retry cap", async () => {
    let searchAttempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      searchAttempts += 1;
      return jsonResponse(429, {}, { "retry-after": "3600" });
    }) as typeof fetch;

    const client = new GoogleAdsClient({
      credential: CREDENTIAL,
      fetchImpl,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      random: () => 0,
    });
    const failure = await client
      .search({ query: "SELECT campaign.id FROM campaign" })
      .then(() => null, (error: unknown) => error);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(true);
    expect(apiError.status).toBe(429);
    expect(apiError.retryAfterMs).toBe(3_600_000);
    expect(searchAttempts).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("shares a single in-flight token refresh across concurrent searches", async () => {
    let tokenFetches = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) {
        tokenFetches += 1;
        return tokenResponse();
      }
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    await Promise.all([
      client.search({ query: "SELECT campaign.id FROM campaign" }),
      client.search({ query: "SELECT campaign.id FROM campaign" }),
      client.search({ query: "SELECT campaign.id FROM campaign" }),
    ]);

    expect(tokenFetches).toBe(1);
  });

  it("retries a token endpoint transport failure and succeeds", async () => {
    let tokenAttempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) {
        tokenAttempts += 1;
        if (tokenAttempts === 1) throw new Error("ECONNRESET");
        return tokenResponse();
      }
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.results).toEqual([]);
    expect(tokenAttempts).toBe(2);
  });

  it("retries once after a 401 with a forced token refresh", async () => {
    let tokenFetches = 0;
    let searchAttempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) {
        tokenFetches += 1;
        return tokenResponse();
      }
      searchAttempts += 1;
      if (searchAttempts === 1) return jsonResponse(401, {});
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.results).toEqual([]);
    expect(tokenFetches).toBe(2);
  });

  it("fails non-retryably after two consecutive 401s", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(401, {});
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const failure = await client
      .search({ query: "SELECT campaign.id FROM campaign" })
      .then(() => null, (error: unknown) => error);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(false);
    expect(apiError.status).toBe(401);
  });

  it("rejects a token response with a non-positive expires_in", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) {
        return jsonResponse(200, { access_token: "at-1", expires_in: 0 });
      }
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    await expect(
      client.search({ query: "SELECT campaign.id FROM campaign" }),
    ).rejects.toThrow(/malformed/i);
  });

  it("treats a null nextPageToken as end of pages", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(200, { results: [], nextPageToken: null });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const page = await client.search({ query: "SELECT campaign.id FROM campaign" });
    expect(page.nextPageToken).toBeNull();
  });

  it("treats a token endpoint rejection as terminal", async () => {
    const fetchImpl = (async () =>
      jsonResponse(400, { error: "invalid_grant" })) as typeof fetch;
    const client = makeClient(fetchImpl);
    const failure = await client
      .search({ query: "SELECT campaign.id FROM campaign" })
      .then(() => null, (error: unknown) => error);
    const apiError = failure as GoogleAdsApiError;
    expect(apiError.retryable).toBe(false);
    expect(apiError.message).toMatch(/token/i);
    expect(apiError.message).not.toContain("invalid_grant");
  });

  it("rejects a malformed results payload", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return jsonResponse(200, { results: "not-an-array" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.search({ query: "SELECT campaign.id FROM campaign" }),
    ).rejects.toThrow(/malformed/i);
  });
});
