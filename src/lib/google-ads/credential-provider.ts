import "server-only";

export const GOOGLE_ADS_CREDENTIAL_REFERENCE = "reviv_environment" as const;

export type GoogleAdsCredentialRequest = {
  credentialReference: typeof GOOGLE_ADS_CREDENTIAL_REFERENCE;
  persistedGoogleCustomerId: string | null;
};

export type RevivGoogleAdsBinding = {
  /** Client ad account, digits only. */
  customerId: string;
  /** Manager (MCC) account, digits only. */
  loginCustomerId: string;
  shopDomain: string;
};

export type ResolvedGoogleAdsCredential = {
  developerToken: string;
  oauthClientId: string;
  oauthClientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId: string;
  reference: typeof GOOGLE_ADS_CREDENTIAL_REFERENCE;
};

export interface GoogleAdsCredentialProvider {
  getPilotBinding(): Promise<RevivGoogleAdsBinding>;
  /**
   * Phase 0 contract: the gclid probe must run with NO Google Ads
   * credentials at all — only stored Shopify data plus this shop-domain
   * binding. Validates ONLY `GOOGLE_ADS_REVIV_SHOP_DOMAIN`; never touches
   * the customer IDs or OAuth secrets `getPilotBinding` requires.
   */
  getPilotShopDomain(): Promise<string>;
  resolve(
    request: GoogleAdsCredentialRequest,
  ): Promise<ResolvedGoogleAdsCredential>;
}

type GoogleAdsEnvironment = {
  [name: string]: string | undefined;
};

const EXACT_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function required(environment: GoogleAdsEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Accepts "123-456-7890" or "1234567890"; canonical form is digits only. */
function normalizeCustomerId(value: string, name: string): string {
  const digits = value.replaceAll("-", "");
  if (!/^\d{10}$/.test(digits)) {
    throw new Error(`${name} must contain a Google Ads customer ID of 10 digits`);
  }
  return digits;
}

function normalizeShopDomain(value: string): string {
  const hostname = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!EXACT_HOSTNAME_PATTERN.test(hostname)) {
    throw new Error("GOOGLE_ADS_REVIV_SHOP_DOMAIN must contain an exact hostname");
  }
  return hostname.toLowerCase();
}

export class EnvironmentGoogleAdsCredentialProvider
  implements GoogleAdsCredentialProvider
{
  readonly #environment: GoogleAdsEnvironment;

  constructor(environment: GoogleAdsEnvironment = process.env) {
    this.#environment = environment;
  }

  #readConfiguration(): {
    binding: RevivGoogleAdsBinding;
    secrets: Pick<
      ResolvedGoogleAdsCredential,
      "developerToken" | "oauthClientId" | "oauthClientSecret" | "refreshToken"
    >;
  } {
    const environment = this.#environment;
    return {
      binding: {
        customerId: normalizeCustomerId(
          required(environment, "GOOGLE_ADS_CUSTOMER_ID"),
          "GOOGLE_ADS_CUSTOMER_ID",
        ),
        loginCustomerId: normalizeCustomerId(
          required(environment, "GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
          "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
        ),
        shopDomain: normalizeShopDomain(
          required(environment, "GOOGLE_ADS_REVIV_SHOP_DOMAIN"),
        ),
      },
      secrets: {
        developerToken: required(environment, "GOOGLE_ADS_DEVELOPER_TOKEN"),
        oauthClientId: required(environment, "GOOGLE_ADS_OAUTH_CLIENT_ID"),
        oauthClientSecret: required(environment, "GOOGLE_ADS_OAUTH_CLIENT_SECRET"),
        refreshToken: required(environment, "GOOGLE_ADS_REFRESH_TOKEN"),
      },
    };
  }

  async getPilotBinding(): Promise<RevivGoogleAdsBinding> {
    // Validates the full set (including secrets) so a half-configured
    // environment fails before any connection bootstrap can write.
    return this.#readConfiguration().binding;
  }

  async getPilotShopDomain(): Promise<string> {
    // Deliberately independent of #readConfiguration(): that method also
    // requires the developer token and OAuth secrets, which Phase 0 (the
    // gclid probe) must never need. Reading only the shop-domain var here is
    // what lets the probe run with zero Google Ads credentials configured.
    return normalizeShopDomain(
      required(this.#environment, "GOOGLE_ADS_REVIV_SHOP_DOMAIN"),
    );
  }

  async resolve(
    request: GoogleAdsCredentialRequest,
  ): Promise<ResolvedGoogleAdsCredential> {
    if (request.credentialReference !== GOOGLE_ADS_CREDENTIAL_REFERENCE) {
      throw new Error("Unsupported Google Ads credential reference");
    }
    const { binding, secrets } = this.#readConfiguration();
    let persistedCustomerId: string | null = null;
    if (request.persistedGoogleCustomerId !== null) {
      try {
        persistedCustomerId = normalizeCustomerId(
          request.persistedGoogleCustomerId,
          "persistedGoogleCustomerId",
        );
      } catch {
        // Treat malformed persisted input as a binding mismatch. Do not
        // reveal which portion of the server-side binding failed comparison.
      }
    }
    if (
      request.persistedGoogleCustomerId !== null &&
      persistedCustomerId !== binding.customerId
    ) {
      throw new Error(
        "Google Ads connection binding does not match the configured account",
      );
    }
    return {
      ...secrets,
      customerId: binding.customerId,
      loginCustomerId: binding.loginCustomerId,
      reference: GOOGLE_ADS_CREDENTIAL_REFERENCE,
    };
  }
}
