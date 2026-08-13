import { describe, expect, it } from "vitest";
import {
  EnvironmentGoogleAdsCredentialProvider,
  GOOGLE_ADS_CREDENTIAL_REFERENCE,
} from "@/lib/google-ads/credential-provider";

const FULL_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_ADS_OAUTH_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123-456-7890",
  GOOGLE_ADS_CUSTOMER_ID: "098-765-4321",
  GOOGLE_ADS_REVIV_SHOP_DOMAIN: "Reviv.myshopify.com",
};

describe("EnvironmentGoogleAdsCredentialProvider", () => {
  it("resolves a credential with normalized digit-only customer IDs", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    const credential = await provider.resolve({
      credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
      persistedGoogleCustomerId: null,
    });
    expect(credential.customerId).toBe("0987654321");
    expect(credential.loginCustomerId).toBe("1234567890");
    expect(credential.developerToken).toBe("dev-token");
    expect(credential.oauthClientSecret).toBe("client-secret");
    expect(credential.refreshToken).toBe("refresh-token");
    expect(credential.reference).toBe("reviv_environment");
  });

  it("exposes the pilot binding with a lowercased shop domain and no secrets", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    const binding = await provider.getPilotBinding();
    expect(binding.shopDomain).toBe("reviv.myshopify.com");
    expect(binding.customerId).toBe("0987654321");
    expect(Object.keys(binding).sort()).toEqual(
      ["customerId", "loginCustomerId", "shopDomain"].sort(),
    );
    const serialized = JSON.stringify(binding);
    expect(serialized).not.toContain("dev-token");
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("refresh-token");
  });

  it("rejects a persisted customer ID that differs from the environment", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    await expect(
      provider.resolve({
        credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
        persistedGoogleCustomerId: "1111111111",
      }),
    ).rejects.toThrow(/binding does not match/);
  });

  it.each(Object.keys(FULL_ENV))("fails closed when %s is missing", async (name) => {
    const environment = { ...FULL_ENV, [name]: "  " };
    const provider = new EnvironmentGoogleAdsCredentialProvider(environment);
    try {
      await provider.getPilotBinding();
      expect.unreachable("expected getPilotBinding to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/is required/);
      expect(message).not.toContain("dev-token");
      expect(message).not.toContain("client-secret");
      expect(message).not.toContain("refresh-token");
    }
  });

  it("rejects an unsupported credential reference", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    await expect(
      provider.resolve({
        // @ts-expect-error deliberate bad reference
        credentialReference: "something_else",
        persistedGoogleCustomerId: null,
      }),
    ).rejects.toThrow(/Unsupported/);
  });

  it("treats a malformed persisted customer ID as a binding mismatch", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    await expect(
      provider.resolve({
        credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
        persistedGoogleCustomerId: "not-a-number",
      }),
    ).rejects.toThrow(/binding does not match/);
  });

  it("resolves a dashed persisted customer ID that matches the environment", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider(FULL_ENV);
    const credential = await provider.resolve({
      credentialReference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
      persistedGoogleCustomerId: "098-765-4321",
    });
    expect(credential.customerId).toBe("0987654321");
  });

  it("rejects a customer ID that is not 10 digits", async () => {
    const provider = new EnvironmentGoogleAdsCredentialProvider({
      ...FULL_ENV,
      GOOGLE_ADS_CUSTOMER_ID: "12ab",
    });
    await expect(provider.getPilotBinding()).rejects.toThrow(/10 digits/);
  });
});
