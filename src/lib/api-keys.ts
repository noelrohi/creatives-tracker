import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/schema/api-key";

const API_KEY_PREFIX_BYTES = 6;
const API_KEY_SECRET_BYTES = 24;

export type ApiKeyPrincipal = {
  apiKeyId: string;
  organizationId: string;
  scopes: string[];
};

export function hashApiKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function generateApiKey() {
  const prefix = `ask_${randomBytes(API_KEY_PREFIX_BYTES).toString("hex")}`;
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString("base64url");
  const key = `${prefix}.${secret}`;

  return {
    key,
    prefix,
    secretHash: hashApiKey(key),
  };
}

export function getApiKeyPrefix(value: string) {
  const separatorIndex = value.indexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  return value.slice(0, separatorIndex);
}

function verifyApiKey(providedKey: string, storedHash: string) {
  const providedHash = Buffer.from(hashApiKey(providedKey), "hex");
  const expectedHash = Buffer.from(storedHash, "hex");

  if (providedHash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(providedHash, expectedHash);
}

export async function authenticateApiKey(rawApiKey: string): Promise<ApiKeyPrincipal | null> {
  const prefix = getApiKeyPrefix(rawApiKey);
  if (!prefix) {
    return null;
  }

  const [record] = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId,
      scopes: apiKeys.scopes,
      secretHash: apiKeys.secretHash,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.prefix, prefix),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);

  if (!record || !verifyApiKey(rawApiKey, record.secretHash)) {
    return null;
  }

  return {
    apiKeyId: record.id,
    organizationId: record.organizationId,
    scopes: record.scopes ?? ["*"],
  };
}

export function getBearerToken(headerValue: string | null) {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(" ", 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token.trim() || null;
}
