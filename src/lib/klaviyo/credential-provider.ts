import "server-only";

export const KLAVIYO_CREDENTIAL_REFERENCE = "reviv_environment" as const;

export type KlaviyoCredentialRequest = {
  connectionId: string;
  credentialReference: typeof KLAVIYO_CREDENTIAL_REFERENCE;
  persistedKlaviyoAccountId: string | null;
  shopDomain: string;
};

export type RevivKlaviyoBinding = {
  expectedAccountId: string;
  shopDomain: string;
  allowedUrlHosts: string[];
};

export type ResolvedKlaviyoCredential = {
  privateApiKey: string;
  reference: typeof KLAVIYO_CREDENTIAL_REFERENCE;
} & Pick<RevivKlaviyoBinding, "expectedAccountId" | "allowedUrlHosts">;

export interface KlaviyoCredentialProvider {
  getPilotBinding(): Promise<RevivKlaviyoBinding>;
  resolve(
    request: KlaviyoCredentialRequest,
  ): Promise<ResolvedKlaviyoCredential>;
}

type KlaviyoEnvironment = {
  [name: string]: string | undefined;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REVIV_ACCOUNT_ID?: string;
  KLAVIYO_REVIV_SHOP_DOMAIN?: string;
  KLAVIYO_REVIV_ALLOWED_URL_HOSTS?: string;
};

const EXACT_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function required(
  environment: KlaviyoEnvironment,
  name: keyof KlaviyoEnvironment,
) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim();
  const hostname = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (!EXACT_HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      "KLAVIYO_REVIV_SHOP_DOMAIN must contain an exact hostname",
    );
  }
  return hostname.toLowerCase();
}

function parseAllowedUrlHosts(value: string, shopDomain: string): string[] {
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  hosts.push(shopDomain);
  for (const host of hosts) {
    if (!EXACT_HOSTNAME_PATTERN.test(host)) {
      throw new Error(
        "KLAVIYO_REVIV_ALLOWED_URL_HOSTS must contain exact hostnames",
      );
    }
  }
  return [...new Set(hosts)].sort();
}

export class EnvironmentKlaviyoCredentialProvider
  implements KlaviyoCredentialProvider
{
  constructor(private readonly environment: KlaviyoEnvironment = process.env) {}

  async getPilotBinding(): Promise<RevivKlaviyoBinding> {
    // Validate the key before bootstrap can write, but keep it out of the
    // public binding and all validation errors.
    required(this.environment, "KLAVIYO_PRIVATE_API_KEY");
    const shopDomain = normalizeShopDomain(
      required(this.environment, "KLAVIYO_REVIV_SHOP_DOMAIN"),
    );
    return {
      expectedAccountId: required(
        this.environment,
        "KLAVIYO_REVIV_ACCOUNT_ID",
      ),
      shopDomain,
      allowedUrlHosts: parseAllowedUrlHosts(
        required(this.environment, "KLAVIYO_REVIV_ALLOWED_URL_HOSTS"),
        shopDomain,
      ),
    };
  }

  async resolve(
    request: KlaviyoCredentialRequest,
  ): Promise<ResolvedKlaviyoCredential> {
    if (request.credentialReference !== KLAVIYO_CREDENTIAL_REFERENCE) {
      throw new Error("Unsupported Klaviyo credential reference");
    }

    const binding = await this.getPilotBinding();
    let requestShopDomain: string | null = null;
    try {
      requestShopDomain = normalizeShopDomain(request.shopDomain);
    } catch {
      // Treat malformed persisted input as a binding mismatch. Do not reveal
      // which portion of the server-side binding failed comparison.
    }

    if (
      (request.persistedKlaviyoAccountId !== null &&
        request.persistedKlaviyoAccountId !== binding.expectedAccountId) ||
      requestShopDomain !== binding.shopDomain
    ) {
      throw new Error(
        "Klaviyo connection binding does not match the configured Reviv store",
      );
    }

    return {
      privateApiKey: required(this.environment, "KLAVIYO_PRIVATE_API_KEY"),
      reference: KLAVIYO_CREDENTIAL_REFERENCE,
      expectedAccountId: binding.expectedAccountId,
      allowedUrlHosts: binding.allowedUrlHosts,
    };
  }
}
