import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentKlaviyoCredentialProvider } from "./credential-provider";
import { withKlaviyoReadContext, type KlaviyoReadContext } from "./read-service";
import { KlaviyoReadError } from "./read-transport";
import type { ConnectionRecord } from "./source-store";

vi.mock("@/db", () => ({ db: {} }));

const connection: ConnectionRecord = {
  organizationId: "org-1",
  storeId: "store-1",
  connectionId: "connection-1",
  shopDomain: "reviv.example.myshopify.com",
  storeTimezone: "America/New_York",
  accountTimezone: "America/Los_Angeles",
  klaviyoAccountId: "Account1",
  initialSourceFrom: null,
  initialSourceTo: null,
  credentialReference: "reviv_environment",
  status: "ready",
};

function fixture() {
  const client = { request: vi.fn() };
  return {
    client,
    loadConnection: vi.fn(async (): Promise<ConnectionRecord | null> => ({ ...connection })),
    credentialProvider: {
      getPilotBinding: vi.fn(),
      resolve: vi.fn(async () => ({
        privateApiKey: "pk_test_SECRET_CANARY",
        reference: "reviv_environment" as const,
        expectedAccountId: "Account1",
        allowedUrlHosts: [connection.shopDomain],
      })),
    },
    createClient: vi.fn(() => client),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Klaviyo OpenAPI read authority", () => {
  it("reports missing server configuration as unavailable without exposing configuration errors", async () => {
    vi.spyOn(EnvironmentKlaviyoCredentialProvider.prototype, "getPilotBinding")
      .mockRejectedValue(new Error("pk_test_SECRET_CANARY missing environment"));
    await expect(withKlaviyoReadContext("org-1", vi.fn())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED", message: "Klaviyo read connection is unavailable",
    });
  });
  it("loads only the authenticated org and resolves the persisted binding server-side", async () => {
    const dependencies = fixture();
    const work = vi.fn(async ({ scope }: KlaviyoReadContext) => ({ scope }));
    const result = await withKlaviyoReadContext("org-1", work, dependencies);
    expect(dependencies.loadConnection).toHaveBeenCalledWith("org-1");
    expect(dependencies.credentialProvider.resolve).toHaveBeenCalledWith({
      connectionId: "connection-1",
      credentialReference: "reviv_environment",
      persistedKlaviyoAccountId: "Account1",
      shopDomain: connection.shopDomain,
    });
    expect(dependencies.createClient).toHaveBeenCalledWith("pk_test_SECRET_CANARY");
    expect(result).toEqual({ scope: {
      organizationId: "org-1", connectionId: "connection-1", accountTimezone: "America/Los_Angeles",
    } });
    expect(JSON.stringify(result)).not.toContain("SECRET_CANARY");
  });

  it.each([
    null,
    { ...connection, organizationId: "another-org" },
    { ...connection, klaviyoAccountId: null },
    ...(["pending", "disabled", "degraded"] as const).map((status) => ({ ...connection, status })),
  ])("refuses missing, cross-org, unbound or unavailable connections before resolving secrets: %j", async (record) => {
    const dependencies = fixture();
    dependencies.loadConnection.mockResolvedValue(record);
    const work = vi.fn();
    await expect(withKlaviyoReadContext("org-1", work, dependencies)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED", message: "Klaviyo read connection is unavailable",
    });
    expect(dependencies.credentialProvider.resolve).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses an account mismatch before creating the provider client", async () => {
    const dependencies = fixture();
    dependencies.credentialProvider.resolve.mockResolvedValue({
      privateApiKey: "pk_test_SECRET_CANARY",
      reference: "reviv_environment",
      expectedAccountId: "Account2",
      allowedUrlHosts: [],
    });
    await expect(withKlaviyoReadContext("org-1", vi.fn(), dependencies)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(dependencies.createClient).not.toHaveBeenCalled();
  });

  it.each(["lookup", "credential", "reader"])("sanitizes unknown %s errors", async (stage) => {
    const dependencies = fixture();
    const error = new Error("pk_test_SECRET_CANARY provider raw email@example.test");
    const work = vi.fn(async () => { if (stage === "reader") throw error; return {}; });
    if (stage === "lookup") dependencies.loadConnection.mockRejectedValue(error);
    if (stage === "credential") dependencies.credentialProvider.resolve.mockRejectedValue(error);
    await expect(withKlaviyoReadContext("org-1", work, dependencies)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR", message: "Klaviyo read failed", cause: undefined,
    });
  });

  it.each([
    ["invalid_input", "BAD_REQUEST"],
    ["invalid_response", "BAD_GATEWAY"],
    ["credential_rejected", "PRECONDITION_FAILED"],
    ["unavailable", "PRECONDITION_FAILED"],
    ["limit_exceeded", "BAD_GATEWAY"],
    ["rate_limited", "TOO_MANY_REQUESTS"],
  ] as const)("maps %s to a safe %s", async (code, trpcCode) => {
    await expect(withKlaviyoReadContext("org-1", async () => {
      throw new KlaviyoReadError(code);
    }, fixture())).rejects.toMatchObject({ code: trpcCode });
  });

  it("preserves safe rate-limit retry guidance", async () => {
    await expect(withKlaviyoReadContext("org-1", async () => {
      throw new KlaviyoReadError("rate_limited", 120_500);
    }, fixture())).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS", message: "Klaviyo rate limit reached; retry after 121 seconds",
    });
  });
});
