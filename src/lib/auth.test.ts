import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/auth");
vi.mock("@/db", () => {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => [],
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

import { fetchClientMetadataResource } from "@/lib/cimd-fetch";

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
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-oauth-origin-regression-only");
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

  it("exchanges a code immediately after consent with Vercel's private metadata cache headers", async () => {
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
    const { auth } = await import("@/lib/auth");
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
  });
});
