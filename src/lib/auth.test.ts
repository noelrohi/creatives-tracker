import { createHash } from "node:crypto";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/auth");
vi.mock("@/db", () => {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => [{ organizationId: "oauth-test-org" }],
  };
  return { db: { select: () => query } };
});
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    drizzleAdapter: () =>
      memoryAdapter({
        oauthResource: [],
        oauthClient: [],
        oauthClientResource: [],
        verification: [],
        session: [],
        user: [],
        account: [],
        oauthConsent: [],
        oauthAccessToken: [],
        oauthRefreshToken: [],
        jwks: [],
      }),
  };
});
vi.mock("@/lib/cimd-fetch", () => ({
  fetchClientMetadataResource: vi.fn(),
}));
vi.mock("@/lib/server/organization-role", () => ({
  getOrganizationRole: vi.fn(),
}));
vi.mock("@/lib/analytics-reporting-queries", () => ({}));
vi.mock("@/lib/trpc/routers/_app", async () => {
  const { router, orgProcedure } = await import("@/lib/trpc/init");
  return {
    appRouter: router({
      campaign: router({
        list: orgProcedure.query(({ ctx }) => ({ organizationId: ctx.organizationId })),
      }),
    }),
  };
});

import { fetchClientMetadataResource } from "@/lib/cimd-fetch";
import { getOrganizationRole } from "@/lib/server/organization-role";

const clientId =
  "https://connect.vercel.com/connectors/scl_3GjBbL39j6GkvWQY9KmQ";
const keyPath = "/7abcebe1-52b2-4120-91fb-a63f2ca4640c/jwks.json";

async function authorize(jwksOrigin: string) {
  vi.mocked(fetchClientMetadataResource).mockResolvedValue(
    Response.json({
      client_id: clientId,
      client_name: "revivbot-adsolute",
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["authorization_code", "client_credentials", "refresh_token"],
      redirect_uris: ["https://connect.vercel.com/callback"],
      jwks_uri: `${jwksOrigin}${keyPath}`,
    }),
  );
  const { auth } = await import("@/lib/auth");
  const url = new URL("http://localhost:3000/api/auth/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: "https://connect.vercel.com/callback",
    scope: "offline_access",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return auth.handler(new Request(url));
}

describe("OAuth CIMD clients", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-oauth-origin-regression-only");
    vi.mocked(getOrganizationRole).mockResolvedValue("member");
  });

  it.each(["https://kms.vercel.com", "https://connect.vercel.com"])(
    "accepts client keys from %s and proceeds to sign-in",
    async (origin) => {
      const response = await authorize(origin);
      expect(response.status).toBe(302);
      expect(
        new URL(response.headers.get("location")!, "http://localhost:3000")
          .pathname,
      ).toBe("/sign-in");
    },
  );

  it.each([
    "https://untrusted.example.com",
    "https://kms.vercel.com.attacker.example",
    "https://other.vercel.com",
    "https://kms.vercel.com:444",
  ])("rejects cross-origin keys from %s", async (origin) => {
    const response = await authorize(origin);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_client_metadata",
      error_description:
        "jwks_uri must belong to a trusted origin or the Client ID Metadata Document origin",
    });
  });

  it.each([false, true])("exchanges CIMD tokens and checks MCP access (resource supplied: %s)", async (withResource) => {
    // Captured from the clientId endpoint on 2026-09-08. No ETag,
    // Last-Modified, Age, Expires or Vary headers were returned.
    const metadataHeaders = {
      "cache-control": "private, max-age=0, must-revalidate",
      "content-type": "application/json; charset=utf-8",
      date: new Date().toUTCString(),
    };
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const key = {
      ...(await exportJWK(publicKey)),
      kid: "test-key",
      alg: "ES256",
    };
    const fetchResource = vi.mocked(fetchClientMetadataResource);
    fetchResource.mockReset();
    fetchResource.mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === clientId) {
        return Response.json({
          client_id: clientId,
          client_name: "revivbot-adsolute",
          token_endpoint_auth_method: "private_key_jwt",
          grant_types: ["authorization_code", "client_credentials", "refresh_token"],
          redirect_uris: ["https://connect.vercel.com/callback"],
          jwks_uri: `https://kms.vercel.com${keyPath}`,
        }, { headers: metadataHeaders });
      }
      if (url === `https://kms.vercel.com${keyPath}`) {
        return Response.json({ keys: [key] });
      }
      throw new Error(`Unexpected metadata fetch: ${url}`);
    });
    const { auth, mcpResource } = await import("@/lib/auth");
    const base = "http://localhost:3000/api/auth";
    const signup = await auth.handler(new Request(`${base}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test",
        email: "cimd@example.com",
        password: "test-password-123",
      }),
    }));
    expect(signup.status, await signup.clone().text()).toBe(200);
    const cookie = signup.headers.getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const verifier = "v".repeat(43);
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: "https://connect.vercel.com/callback",
      scope: "offline_access",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "regression-state",
      ...(withResource ? { resource: mcpResource } : {}),
    });
    const authorization = await auth.handler(new Request(`${base}/oauth2/authorize?${query}`, {
      headers: { cookie },
    }));
    expect(authorization.status).toBe(302);
    const consentUrl = new URL(authorization.headers.get("location")!, base);
    expect(consentUrl.pathname).toBe("/consent");

    // Allow the initial authorize fetch's default one-second interval to
    // elapse, as a user would while reading consent. Freeze Date.now from
    // here so consent -> token is deterministically inside that interval.
    const consentTime = Date.now() + 1100;
    vi.spyOn(Date, "now").mockReturnValue(consentTime);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: key.kid })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(`${base}/oauth2/token`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("consent-token-regression")
      .sign(privateKey);
    fetchResource.mockClear();
    const consent = await auth.handler(new Request(`${base}/oauth2/consent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentUrl.searchParams.toString(),
      }),
    }));
    const consentBody = await consent.json();
    expect(consent.status, JSON.stringify(consentBody)).toBe(200);
    const callback = new URL(consentBody.url);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(
      fetchResource.mock.calls.filter(([url]) => String(url) === clientId),
    ).toHaveLength(1);

    const token = await auth.handler(new Request(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code!,
        code_verifier: verifier,
        redirect_uri: "https://connect.vercel.com/callback",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        ...(withResource ? { resource: mcpResource } : {}),
      }),
    }));
    const tokenBody = await token.json();
    expect(token.status, JSON.stringify(tokenBody)).toBe(200);
    expect(tokenBody).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: "Bearer",
    });
    // One resolution in consent, then two in token: assertion verification
    // and grant-level validateClientCredentials (even when preVerified).
    expect(
      fetchResource.mock.calls.filter(([url]) => String(url) === clientId),
    ).toHaveLength(3);
    expect(fetchResource).toHaveBeenCalledWith(
      `https://kms.vercel.com${keyPath}`,
      expect.anything(),
    );

    // Only JWKS transport is redirected to the in-memory auth server;
    // signature, issuer, audience, expiry, and MCP validation are real.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== `${base}/jwks`) throw new Error(`Unexpected fetch: ${url}`);
      return auth.handler(new Request(url));
    }));
    const { POST } = await import("@/app/api/mcp/route");
    async function mcpRequest(accessToken: string, method: string, params = {}) {
      return POST(new Request(mcpResource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }));
    }
    async function listTools(accessToken: string) {
      const initialize = await mcpRequest(accessToken, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "revivbot-regression", version: "1" },
      });
      expect(initialize.status).toBe(200);
      const response = await mcpRequest(accessToken, "tools/list");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"name":"list_campaigns"');
    }

    if (!withResource) {
      expect(tokenBody.access_token.split(".")).toHaveLength(1);
      expect((await mcpRequest(tokenBody.access_token, "tools/list")).status).toBe(401);
      return;
    }
    const claims = decodeJwt(tokenBody.access_token);
    expect(claims).toMatchObject({ iss: base, aud: mcpResource, organization_id: "oauth-test-org" });
    await listTools(tokenBody.access_token);

    const refreshAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: key.kid })
      .setIssuer(clientId).setSubject(clientId).setAudience(`${base}/oauth2/token`)
      .setIssuedAt().setExpirationTime("5m").setJti("mcp-refresh-regression")
      .sign(privateKey);
    const refresh = await auth.handler(new Request(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
        client_id: clientId,
        resource: mcpResource,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: refreshAssertion,
      }),
    }));
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json();
    await listTools(refreshed.access_token);

    for (const payload of [
      { ...claims, aud: "https://other.example/api/mcp" },
      { ...claims, iss: "https://other.example/api/auth" },
      { ...claims, exp: Math.floor(Date.now() / 1000) - 60 },
    ]) {
      const { token: invalidToken } = await auth.api.signJWT({ body: { payload } });
      expect((await mcpRequest(invalidToken, "tools/list")).status).toBe(401);
    }
    expect((await mcpRequest("malformed", "tools/list")).status).toBe(401);

    const call = () => mcpRequest(refreshed.access_token, "tools/call", { name: "list_campaigns", arguments: {} });
    expect(await (await call()).text()).toContain("oauth-test-org");
    expect(getOrganizationRole).toHaveBeenCalledWith(claims.sub, "oauth-test-org");
    vi.mocked(getOrganizationRole).mockResolvedValue(null);
    const denied = await (await call()).text();
    expect(denied).toContain('"isError":true');
    expect(denied).not.toContain("oauth-test-org");
  });
});
