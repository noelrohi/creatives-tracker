import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export type IdentityScope = { organizationId: string; storeId: string };
export type IdentityHmacKey = { version: string; secret: Uint8Array };
export type IdentityHmacKeyring = {
  current: IdentityHmacKey;
  previous?: IdentityHmacKey;
};
export type VersionedIdentityDigest = {
  keyVersion: string;
  digest: string;
  rotationState: "active" | "rotation_previous";
};
export type ErasureSuppressionKind = "email" | "shopify_customer_id";
export type ErasureSuppressionKey = {
  version: string;
  secret: Uint8Array;
};
export type ErasureSuppressionDigest = {
  kind: ErasureSuppressionKind;
  keyVersion: string;
  digest: string;
};
export type IdentityCryptoKeyChecks = {
  matching: Array<{ keyVersion: string; keyCheck: string }>;
  suppression: { keyVersion: string; keyCheck: string };
};

type IdentityHmacEnvironment = Record<string, string | undefined>;

const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MINIMUM_SECRET_BYTES = 32;

function parseKeyVersion(value: string | undefined, variableName: string): string {
  if (!value) {
    throw new Error(`${variableName} is required`);
  }
  if (!KEY_VERSION_PATTERN.test(value)) {
    throw new Error(`${variableName} is invalid`);
  }
  return value;
}

function parseSecret(value: string | undefined, variableName: string): Uint8Array {
  if (!value) {
    throw new Error(`${variableName} is required`);
  }
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error(`${variableName} must be valid base64url`);
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(`${variableName} must be valid base64url`);
  }
  if (decoded.byteLength < MINIMUM_SECRET_BYTES) {
    throw new Error(`${variableName} must decode to at least 32 bytes`);
  }
  return decoded;
}

function hmac(secret: Uint8Array, context: string): Buffer {
  return createHmac("sha256", secret).update(context, "utf8").digest();
}

function hmacBase64Url(secret: Uint8Array, context: string): string {
  return hmac(secret, context).toString("base64url");
}

function secretMaterialsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeIdentityScope(scope: IdentityScope): string {
  if (
    typeof scope !== "object" ||
    scope === null ||
    typeof scope.organizationId !== "string" ||
    typeof scope.storeId !== "string" ||
    scope.organizationId.includes("\0") ||
    scope.storeId.includes("\0") ||
    hasUnpairedUtf16Surrogate(scope.organizationId) ||
    hasUnpairedUtf16Surrogate(scope.storeId)
  ) {
    throw new Error("Invalid identity scope");
  }

  const organizationLength = Buffer.byteLength(scope.organizationId, "utf8");
  const storeLength = Buffer.byteLength(scope.storeId, "utf8");
  return `scope-v1:${organizationLength}:${scope.organizationId}:${storeLength}:${scope.storeId}`;
}

function validateIdentityHmacKey(
  key: unknown,
): asserts key is IdentityHmacKey {
  if (typeof key !== "object" || key === null) {
    throw new Error("Invalid identity HMAC key");
  }
  const candidate = key as Partial<IdentityHmacKey>;
  if (typeof candidate.version !== "string") {
    throw new Error("Invalid identity HMAC key");
  }
  if (!(candidate.secret instanceof Uint8Array)) {
    throw new Error("Invalid identity HMAC key");
  }
  if (
    !KEY_VERSION_PATTERN.test(candidate.version) ||
    candidate.secret.byteLength < MINIMUM_SECRET_BYTES
  ) {
    throw new Error("Invalid identity HMAC key");
  }
}

function validateErasureSuppressionKey(
  key: unknown,
): asserts key is ErasureSuppressionKey {
  if (typeof key !== "object" || key === null) {
    throw new Error("Invalid erasure suppression HMAC key");
  }
  const candidate = key as Partial<ErasureSuppressionKey>;
  if (typeof candidate.version !== "string") {
    throw new Error("Invalid erasure suppression HMAC key");
  }
  if (!(candidate.secret instanceof Uint8Array)) {
    throw new Error("Invalid erasure suppression HMAC key");
  }
  if (
    !KEY_VERSION_PATTERN.test(candidate.version) ||
    candidate.secret.byteLength < MINIMUM_SECRET_BYTES
  ) {
    throw new Error("Invalid erasure suppression HMAC key");
  }
}

function validateIdentityHmacKeyring(
  keyring: unknown,
): asserts keyring is IdentityHmacKeyring {
  if (typeof keyring !== "object" || keyring === null) {
    throw new Error("Invalid identity HMAC keyring");
  }
  const candidate = keyring as Partial<IdentityHmacKeyring>;
  validateIdentityHmacKey(candidate.current);
  if (candidate.previous === undefined) {
    return;
  }
  validateIdentityHmacKey(candidate.previous);
  if (candidate.current.version === candidate.previous.version) {
    throw new Error("Current and previous identity HMAC key versions must differ");
  }
  if (secretMaterialsEqual(candidate.current.secret, candidate.previous.secret)) {
    throw new Error(
      "Current and previous identity HMAC key material must differ",
    );
  }
}

function deriveErasureSuppressionTenantKey(
  key: ErasureSuppressionKey,
  scope: IdentityScope,
): Uint8Array {
  validateErasureSuppressionKey(key);
  return hmac(
    key.secret,
    `identity-erasure-tenant:${encodeIdentityScope(scope)}`,
  );
}

export function normalizeIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseIdentityHmacKeyring(
  env: IdentityHmacEnvironment = process.env,
): IdentityHmacKeyring {
  const current: IdentityHmacKey = {
    version: parseKeyVersion(
      env.IDENTITY_HMAC_KEY_VERSION,
      "IDENTITY_HMAC_KEY_VERSION",
    ),
    secret: parseSecret(env.IDENTITY_HMAC_SECRET, "IDENTITY_HMAC_SECRET"),
  };

  const previousSecret = env.IDENTITY_HMAC_PREVIOUS_SECRET;
  const previousVersion = env.IDENTITY_HMAC_PREVIOUS_KEY_VERSION;
  const hasPreviousSecret = Boolean(previousSecret);
  const hasPreviousVersion = Boolean(previousVersion);

  if (hasPreviousSecret !== hasPreviousVersion) {
    throw new Error(
      "IDENTITY_HMAC_PREVIOUS_SECRET and IDENTITY_HMAC_PREVIOUS_KEY_VERSION must be configured together",
    );
  }
  if (!hasPreviousSecret || !hasPreviousVersion) {
    const keyring = { current };
    validateIdentityHmacKeyring(keyring);
    return keyring;
  }

  const previous: IdentityHmacKey = {
    version: parseKeyVersion(
      previousVersion,
      "IDENTITY_HMAC_PREVIOUS_KEY_VERSION",
    ),
    secret: parseSecret(previousSecret, "IDENTITY_HMAC_PREVIOUS_SECRET"),
  };
  const keyring = { current, previous };
  validateIdentityHmacKeyring(keyring);
  return keyring;
}

export function deriveTenantIdentityKey(
  key: IdentityHmacKey,
  scope: IdentityScope,
): Uint8Array {
  validateIdentityHmacKey(key);
  return hmac(
    key.secret,
    `identity-tenant:${encodeIdentityScope(scope)}`,
  );
}

export function digestIdentityEmail({
  scope,
  email,
  key,
}: {
  scope: IdentityScope;
  email: string;
  key: IdentityHmacKey;
}): string {
  validateIdentityHmacKey(key);
  const normalizedEmail = normalizeIdentityEmail(email);
  const tenantKey = deriveTenantIdentityKey(key, scope);
  return hmacBase64Url(
    tenantKey,
    `email:${key.version}:${normalizedEmail}`,
  );
}

export function computeIdentityDigests({
  scope,
  email,
  keyring,
}: {
  scope: IdentityScope;
  email: string;
  keyring: IdentityHmacKeyring;
}): VersionedIdentityDigest[] {
  validateIdentityHmacKeyring(keyring);
  const current: VersionedIdentityDigest = {
    keyVersion: keyring.current.version,
    digest: digestIdentityEmail({ scope, email, key: keyring.current }),
    rotationState: "active",
  };
  if (!keyring.previous) {
    return [current];
  }

  return [
    current,
    {
      keyVersion: keyring.previous.version,
      digest: digestIdentityEmail({ scope, email, key: keyring.previous }),
      rotationState: "rotation_previous",
    },
  ];
}

export function parseErasureSuppressionKey(
  env: NodeJS.ProcessEnv = process.env,
): ErasureSuppressionKey {
  const secret = parseSecret(
    env.IDENTITY_ERASURE_HMAC_SECRET,
    "IDENTITY_ERASURE_HMAC_SECRET",
  );
  const version = parseKeyVersion(
    env.IDENTITY_ERASURE_HMAC_KEY_VERSION,
    "IDENTITY_ERASURE_HMAC_KEY_VERSION",
  );
  const key = { version, secret };
  validateErasureSuppressionKey(key);
  return key;
}

export function computeErasureSuppressionDigests({
  scope,
  key,
  email,
  shopifyCustomerId,
}: {
  scope: IdentityScope;
  key: ErasureSuppressionKey;
  email?: string | null;
  shopifyCustomerId?: string | null;
}): ErasureSuppressionDigest[] {
  const tenantKey = deriveErasureSuppressionTenantKey(key, scope);
  const digests: ErasureSuppressionDigest[] = [];

  if (email != null) {
    const normalizedEmail = normalizeIdentityEmail(email);
    digests.push({
      kind: "email",
      keyVersion: key.version,
      digest: hmacBase64Url(tenantKey, `email:${normalizedEmail}`),
    });
  }
  if (shopifyCustomerId != null) {
    digests.push({
      kind: "shopify_customer_id",
      keyVersion: key.version,
      digest: hmacBase64Url(
        tenantKey,
        `shopify-customer-id:${shopifyCustomerId}`,
      ),
    });
  }

  return digests;
}

export function computeIdentityCryptoKeyChecks({
  scope,
  keyring,
  suppressionKey,
}: {
  scope: IdentityScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): IdentityCryptoKeyChecks {
  validateIdentityHmacKeyring(keyring);
  validateErasureSuppressionKey(suppressionKey);
  const matchingKeys = keyring.previous
    ? [keyring.current, keyring.previous]
    : [keyring.current];
  if (
    matchingKeys.some((key) =>
      secretMaterialsEqual(key.secret, suppressionKey.secret),
    )
  ) {
    throw new Error("Identity HMAC root key material must be independent");
  }
  const matching = matchingKeys.map((key) => ({
    keyVersion: key.version,
    keyCheck: hmacBase64Url(
      deriveTenantIdentityKey(key, scope),
      `identity-key-binding:${key.version}`,
    ),
  }));
  const suppressionTenantKey = deriveErasureSuppressionTenantKey(
    suppressionKey,
    scope,
  );

  return {
    matching,
    suppression: {
      keyVersion: suppressionKey.version,
      keyCheck: hmacBase64Url(
        suppressionTenantKey,
        `erasure-key-binding:${suppressionKey.version}`,
      ),
    },
  };
}
