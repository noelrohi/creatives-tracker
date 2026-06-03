import { createCallerFactory } from "./init";
import { appRouter } from "./routers/_app";
import type { OrgRole } from "@/lib/organization-access";

const createCaller = createCallerFactory(appRouter);

type MockContextOptions = {
  role: OrgRole | null;
  userId?: string;
  organizationId?: string;
};

type ApiKeyContextOptions = {
  apiKeyId?: string;
  organizationId?: string;
  scopes?: string[];
};

/**
 * Create a tRPC caller with a mocked session context for the given org role.
 * Useful for testing RBAC middleware without a database.
 */
export function createMockCaller({
  role,
  userId = "test-user-id",
  organizationId = "test-org-id",
}: MockContextOptions) {
  return createCaller({
    session: {
      user: { id: userId },
      session: { id: "test-session", activeOrganizationId: organizationId },
    } as never,
    principalType: "session" as const,
    userId,
    organizationId,
    orgRole: role,
    apiKeyId: null,
    apiKeyScopes: [],
  });
}

/**
 * Create a tRPC caller with no authentication context.
 */
export function createUnauthenticatedCaller() {
  return createCaller({
    session: null,
    principalType: "anonymous" as const,
    userId: null,
    organizationId: null,
    orgRole: null,
    apiKeyId: null,
    apiKeyScopes: [],
  });
}

/**
 * Create a tRPC caller authenticated through an API key principal.
 * Useful for proving session-only procedures cannot be invoked by API keys.
 */
export function createApiKeyCaller({
  apiKeyId = "test-api-key-id",
  organizationId = "test-org-id",
  scopes = ["*"],
}: ApiKeyContextOptions = {}) {
  return createCaller({
    session: null,
    principalType: "apiKey" as const,
    userId: null,
    organizationId,
    orgRole: null,
    apiKeyId,
    apiKeyScopes: scopes,
  });
}

/**
 * Create a tRPC caller authenticated as the internal worker principal.
 */
export function createWorkerCaller({
  organizationId = "test-org-id",
}: { organizationId?: string } = {}) {
  return createCaller({
    session: null,
    principalType: "worker" as const,
    userId: null,
    organizationId,
    orgRole: null,
    apiKeyId: null,
    apiKeyScopes: [],
  });
}
