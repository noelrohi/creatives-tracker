import { describe, expect, it } from "vitest";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialRequest,
} from "@/lib/klaviyo/credential-provider";

const request: KlaviyoCredentialRequest = {
  connectionId: "connection-1",
  credentialReference: "reviv_environment",
  persistedKlaviyoAccountId: null,
  shopDomain: "reviv.example.myshopify.com",
};

function environment(overrides: Record<string, string> = {}) {
  return {
    KLAVIYO_PRIVATE_API_KEY: "pk_test_secret",
    KLAVIYO_REVIV_ACCOUNT_ID: "account-reviv",
    KLAVIYO_REVIV_SHOP_DOMAIN: "reviv.example.myshopify.com",
    KLAVIYO_REVIV_ALLOWED_URL_HOSTS: "www.reviv.example",
    ...overrides,
  };
}

describe("EnvironmentKlaviyoCredentialProvider", () => {
  it("allows a pending connection and returns the expected account binding", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(
      environment({
        KLAVIYO_REVIV_SHOP_DOMAIN: "Reviv.Example.MyShopify.com/",
        KLAVIYO_REVIV_ALLOWED_URL_HOSTS:
          "www.reviv.example,links.reviv.example",
      }),
    );

    await expect(provider.resolve(request)).resolves.toEqual({
      privateApiKey: "pk_test_secret",
      reference: "reviv_environment",
      expectedAccountId: "account-reviv",
      allowedUrlHosts: [
        "links.reviv.example",
        "reviv.example.myshopify.com",
        "www.reviv.example",
      ],
    });
  });

  it("fails before returning a key when the store binding differs", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(
      environment({ KLAVIYO_REVIV_SHOP_DOMAIN: "other.myshopify.com" }),
    );

    await expect(provider.resolve(request)).rejects.toThrow(
      "Klaviyo connection binding does not match the configured Reviv store",
    );
  });

  it("fails when a previously discovered account differs from the binding", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(environment());

    await expect(
      provider.resolve({
        ...request,
        persistedKlaviyoAccountId: "another-account",
      }),
    ).rejects.toThrow(
      "Klaviyo connection binding does not match the configured Reviv store",
    );
  });

  it("never accepts an arbitrary credential reference", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(environment());

    await expect(
      provider.resolve({
        ...request,
        credentialReference: "user_supplied_name" as "reviv_environment",
      }),
    ).rejects.toThrow("Unsupported Klaviyo credential reference");
  });

  it("validates the key without exposing it from the public pilot binding", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(environment());

    const binding = await provider.getPilotBinding();

    expect(binding).toEqual({
      expectedAccountId: "account-reviv",
      shopDomain: "reviv.example.myshopify.com",
      allowedUrlHosts: [
        "reviv.example.myshopify.com",
        "www.reviv.example",
      ],
    });
    expect(JSON.stringify(binding)).not.toContain("pk_test_secret");
  });

  it.each([
    "https://www.reviv.example",
    "www.reviv.example/path",
    "www.reviv.example:443",
    "*.reviv.example",
    "user@www.reviv.example",
  ])("rejects non-host allowlist entry %s without leaking the key", async (host) => {
    const provider = new EnvironmentKlaviyoCredentialProvider(
      environment({ KLAVIYO_REVIV_ALLOWED_URL_HOSTS: host }),
    );

    const error = await provider.getPilotBinding().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("must contain exact hostnames");
    expect(String(error)).not.toContain("pk_test_secret");
  });

  it.each([
    "https://reviv.example.myshopify.com",
    "reviv.example.myshopify.com/path",
    "reviv.example.myshopify.com:443",
    "*.example.myshopify.com",
  ])("rejects a configured shop binding that is not an exact hostname: %s", async (domain) => {
    const provider = new EnvironmentKlaviyoCredentialProvider(
      environment({ KLAVIYO_REVIV_SHOP_DOMAIN: domain }),
    );

    const error = await provider.getPilotBinding().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("must contain an exact hostname");
    expect(String(error)).not.toContain("pk_test_secret");
  });

  it("normalizes the persisted store domain without weakening exact matching", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(environment());

    await expect(
      provider.resolve({
        ...request,
        shopDomain: " Reviv.Example.MyShopify.com/ ",
      }),
    ).resolves.toMatchObject({ expectedAccountId: "account-reviv" });
  });

  it("treats a malformed persisted store domain as a binding mismatch", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(environment());

    await expect(
      provider.resolve({
        ...request,
        shopDomain: "reviv.example.myshopify.com:443",
      }),
    ).rejects.toThrow(
      "Klaviyo connection binding does not match the configured Reviv store",
    );
  });

  it("fails closed when required configuration is missing", async () => {
    const provider = new EnvironmentKlaviyoCredentialProvider(
      environment({ KLAVIYO_PRIVATE_API_KEY: "  " }),
    );

    await expect(provider.getPilotBinding()).rejects.toThrow(
      "KLAVIYO_PRIVATE_API_KEY is required",
    );
  });
});
