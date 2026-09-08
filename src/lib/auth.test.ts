import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/auth");
vi.mock("@/db", () => ({ db: {} }));
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

describe("OAuth client key origins", () => {
  afterEach(() => vi.unstubAllEnvs());

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
});
