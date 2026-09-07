import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  request: vi.fn(),
  loadConnection: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/api-keys", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api-keys")>(),
  authenticateApiKey: mocks.authenticateApiKey,
}));
vi.mock("@/lib/klaviyo/source-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/klaviyo/source-store")>(),
  getPilotConnectionForOrganization: mocks.loadConnection,
}));
vi.mock("@/lib/klaviyo/read-transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/klaviyo/read-transport")>(),
  KlaviyoReadTransport: class { request = mocks.request; },
}));

import { callOpenApiProcedure, generateOpenApiDocument } from "../openapi";
import { appRouter } from "./_app";
import { EnvironmentKlaviyoCredentialProvider } from "@/lib/klaviyo/credential-provider";
import { KlaviyoReadError } from "@/lib/klaviyo/read-transport";

const window = { since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" };
const names = ["campaigns", "metrics", "events", "campaignValues"] as const;

function request(name: string, params: URLSearchParams = new URLSearchParams(), method = "GET", token = "ask_fixture_read") {
  return callOpenApiProcedure(new Request(
    `https://adsolute.test/api/openapi/klaviyoReads/${name}?${params}`,
    { method, headers: { authorization: `Bearer ${token}`, "x-adsolute-organization-id": "forged-org" } },
  ), "klaviyoReads", name);
}

function inputFor(name: typeof names[number]): URLSearchParams {
  if (name === "events") return new URLSearchParams({ ...window, metricIds: "Metric1,Metric2" });
  if (name === "campaignValues") return new URLSearchParams({ ...window, conversionMetricId: "Metric1" });
  return new URLSearchParams();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  vi.stubEnv("ADSOLUTE_WORKER_SECRET", "");
  mocks.authenticateApiKey.mockReset().mockImplementation(async (key: string) => {
    if (key === "ask_fixture_read") return { apiKeyId: "key1", organizationId: "org1", scopes: ["read"] };
    if (key === "ask_fixture_write") return { apiKeyId: "key2", organizationId: "org1", scopes: ["write"] };
    if (key === "ask_fixture_other") return { apiKeyId: "key3", organizationId: "org2", scopes: ["read"] };
    return null;
  });
  mocks.request.mockReset().mockResolvedValue({ data: [], links: { next: null } });
  mocks.loadConnection.mockReset().mockImplementation(async (organizationId: string) => ({
    organizationId, storeId: `${organizationId}-store`, connectionId: `${organizationId}-connection`,
    shopDomain: "fixture.myshopify.com", storeTimezone: "America/New_York", accountTimezone: "America/New_York",
    klaviyoAccountId: "Account1", credentialReference: "reviv_environment", status: "ready",
    initialSourceFrom: null, initialSourceTo: null,
  }));
  vi.spyOn(EnvironmentKlaviyoCredentialProvider.prototype, "getPilotBinding").mockResolvedValue({
    expectedAccountId: "Account1", shopDomain: "fixture.myshopify.com", allowedUrlHosts: [],
  });
  vi.spyOn(EnvironmentKlaviyoCredentialProvider.prototype, "resolve").mockResolvedValue({
    privateApiKey: "pk_synthetic_only", reference: "reviv_environment", expectedAccountId: "Account1", allowedUrlHosts: [],
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Klaviyo reads through the actual OpenAPI adapter", () => {
  it.each(names)("requires authentication for %s before provider work", async (name) => {
    const response = await request(name, inputFor(name), "GET", "invalid");
    expect(response.status).toBe(401);
    expect(mocks.loadConnection).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(names)("requires read scope for %s before provider work", async (name) => {
    const response = await request(name, inputFor(name), "GET", "ask_fixture_write");
    expect(response.status).toBe(403);
    expect(mocks.loadConnection).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("reads a declared metric page without parameters and ignores forged org headers", async () => {
    mocks.request.mockResolvedValue({ data: [{ type: "metric", id: "Metric1", attributes: { name: "Placed Order", private_canary: "DROP_ME" } }], links: { next: null } });
    const response = await request("metrics");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ metrics: [{ metricId: "Metric1", name: "Placed Order" }], nextContinuation: null });
    expect(mocks.loadConnection).toHaveBeenCalledWith("org1", expect.any(EnvironmentKlaviyoCredentialProvider));
  });

  it("returns reviewed campaign/message fields through HTTP", async () => {
    mocks.request.mockResolvedValue({
      data: [{ type: "campaign", id: "Campaign1", attributes: {
        name: "September launch", status: "Sent", archived: false,
        created_at: window.since, updated_at: window.until, scheduled_at: null, send_time: window.until,
      }, relationships: { "campaign-messages": { data: [{ type: "campaign-message", id: "Message1" }] } } }],
      included: [{ type: "campaign-message", id: "Message1", attributes: {
        created_at: window.since, updated_at: window.until,
        definition: { channel: "email", content: { subject: "Launch", preview_text: "Preview", body: "DROP_PRIVATE_BODY" } },
      } }], links: { next: null },
    });
    const response = await request("campaigns");
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.campaigns[0]).toMatchObject({ campaignId: "Campaign1", archived: false, sendTime: window.until });
    expect(page.messages[0]).toMatchObject({ messageId: "Message1", campaignId: "Campaign1", subject: "Launch", previewText: "Preview" });
    expect(JSON.stringify(page)).not.toContain("DROP_PRIVATE_BODY");
    expect(page.nextContinuation).toEqual(expect.any(String));
  });

  it("reads campaign values with explicit timezone and incomplete-report metadata", async () => {
    mocks.request.mockResolvedValue({ data: { type: "campaign-values-report", attributes: { results: [{
      groupings: { campaign_id: "Campaign1", campaign_message_id: "Message1", send_channel: "email", private_group: "DROP_PRIVATE" },
      statistics: { recipients: 100, delivered: 98, delivery_rate: 0.98, conversion_value: 120.5 },
    }] } } });
    const response = await request("campaignValues", inputFor("campaignValues"));
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toMatchObject({
      accountTimezone: "America/New_York", requestedWindow: window,
      providerWindow: { start: "2026-08-31T20:00:00Z", end: "2026-09-01T19:59:59Z" },
      completeness: "unverified", nextContinuation: null,
    });
    expect(page.rows[0]).toMatchObject({ campaignId: "Campaign1", campaignMessageId: "Message1", conversionMetricId: "Metric1", deliveryRate: 0.98, conversionValue: 120.5, opensUnique: null });
    expect(JSON.stringify(page)).not.toContain("DROP_PRIVATE");
    expect(mocks.request.mock.calls[0][0].body.data.attributes.statistics).toHaveLength(17);
  });

  it("returns unavailable for missing connections without provider work", async () => {
    mocks.loadConnection.mockResolvedValue(null);
    const response = await request("metrics");
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ code: "PRECONDITION_FAILED", message: "Klaviyo read connection is unavailable" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["comma", "repeated"])("decodes %s metricIds, and continues to the next metric without leaking the old filter", async (encoding) => {
    const params = new URLSearchParams(window);
    if (encoding === "comma") params.set("metricIds", "Metric1,Metric2");
    else { params.append("metricIds", "Metric1"); params.append("metricIds", "Metric2"); }
    const first = await request("events", params);
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.events).toEqual([]);
    expect(page.nextContinuation).toEqual(expect.any(String));
    expect(mocks.request.mock.calls[0][0].params.get("filter")).toContain("Metric1");
    params.set("continuation", page.nextContinuation);
    const second = await request("events", params);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ events: [], nextContinuation: null });
    expect(mocks.request.mock.calls[1][0].params.get("filter")).toContain("Metric2");
  });

  it("rejects cross-org continuation before provider work", async () => {
    const first = await request("campaigns");
    const page = await first.json();
    expect(first.status).toBe(200);
    mocks.request.mockClear();
    const response = await request("campaigns", new URLSearchParams({ continuation: page.nextContinuation }), "GET", "ask_fixture_other");
    expect(response.status).toBe(400);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    new URLSearchParams({ ...window, metricIds: "Metric1,Metric1" }),
    new URLSearchParams({ ...window, metricIds: "Metric1", privateApiKey: "pk_injected" }),
    new URLSearchParams({ ...window, metricIds: "Metric1", organizationId: "another-org" }),
    new URLSearchParams({ ...window, metricIds: "Metric1", since: "invalid" }),
  ])("rejects malformed and undeclared inputs", async (params) => {
    const response = await request("events", params);
    expect(response.status).toBe(400);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("returns safe HTTP rate-limit guidance and sanitizes provider errors", async () => {
    mocks.request.mockRejectedValueOnce(new KlaviyoReadError("rate_limited", 120_000));
    const limited = await request("metrics");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "TOO_MANY_REQUESTS", message: expect.stringContaining("120 seconds") });
    mocks.request.mockRejectedValueOnce(new Error("pk_SECRET raw email@example.test"));
    const failed = await request("metrics");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ code: "INTERNAL_SERVER_ERROR", message: "Klaviyo read failed" });
  });

  it("rejects snapshot time windows", async () => {
    const response = await request("campaigns", new URLSearchParams(window));
    expect(response.status).toBe(400);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not expose POST or existing admin-only Klaviyo operations", async () => {
    expect((await request("campaigns", undefined, "POST")).status).toBe(405);
    for (const procedure of ["health", "startDiscovery", "approveProbe", "uninstall", "orderInspector"]) {
      const response = await callOpenApiProcedure(new Request(`https://adsolute.test/api/openapi/klaviyo/${procedure}`), "klaviyo", procedure);
      expect(response.status).toBe(404);
    }
    const caller = appRouter.createCaller({
      principalType: "apiKey", session: null, userId: null, organizationId: "org1", orgRole: null,
      apiKeyId: "key1", apiKeyScopes: ["*"],
    });
    await expect(caller.klaviyo.health()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.klaviyo.uninstall()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("documents four typed read operations and array query encoding", () => {
    const document = generateOpenApiDocument("https://adsolute.test");
    for (const name of names) {
      const path = document.paths[`/api/openapi/klaviyoReads/${name}`];
      expect(Object.keys(path)).toEqual(["get"]);
      expect(path.get).toMatchObject({ operationId: `klaviyoReads.${name}`, security: [{ bearerAuth: [] }, { sessionCookie: [] }] });
    }
    expect(document.paths["/api/openapi/klaviyoReads/events"].get).toMatchObject({ parameters: expect.arrayContaining([
      expect.objectContaining({ name: "metricIds", required: true, style: "form", explode: true, schema: expect.objectContaining({ type: "array" }) }),
    ]) });
  });
});
