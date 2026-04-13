import { createCallerFactory } from "./init";
import { appRouter } from "./routers/_app";
import type { OrgRole } from "@/lib/organization-access";

const createCaller = createCallerFactory(appRouter);

type MockContextOptions = {
  role: OrgRole | null;
  userId?: string;
  organizationId?: string;
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
