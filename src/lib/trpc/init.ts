import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { headers } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { authenticateApiKey, getBearerToken } from "@/lib/api-keys";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { getOrganizationRole } from "@/lib/server/organization-role";
import { db } from "@/db";
import { member } from "@/schema/auth";
import type { OpenApiMeta } from "./openapi-meta";

type ContextOptions = {
  req?: Request;
  headers?: Headers;
};

async function resolveHeaders(options?: ContextOptions) {
  if (options?.headers) {
    return options.headers;
  }

  if (options?.req) {
    return options.req.headers;
  }

  return headers();
}

export async function createContext(options?: ContextOptions) {
  const requestHeaders = await resolveHeaders(options);
  const bearerToken = getBearerToken(requestHeaders.get("authorization"));
  const workerSecret = process.env.ADSOLUTE_WORKER_SECRET;

  if (bearerToken) {
    if (workerSecret && bearerToken === workerSecret) {
      return {
        session: null,
        principalType: "worker" as const,
        userId: null,
        organizationId: requestHeaders.get("x-adsolute-organization-id"),
        orgRole: null,
        apiKeyId: null,
        apiKeyScopes: [] as string[],
      };
    }

    const apiKeyPrincipal = await authenticateApiKey(bearerToken);

    if (!apiKeyPrincipal) {
      return {
        session: null,
        principalType: "anonymous" as const,
        userId: null,
        organizationId: null,
        orgRole: null,
        apiKeyId: null,
        apiKeyScopes: [] as string[],
      };
    }

    return {
      session: null,
      principalType: "apiKey" as const,
      userId: null,
      organizationId: apiKeyPrincipal.organizationId,
      orgRole: null,
      apiKeyId: apiKeyPrincipal.apiKeyId,
      apiKeyScopes: apiKeyPrincipal.scopes,
    };
  }

  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  let organizationId = session?.session?.activeOrganizationId ?? null;

  if (session && organizationId) {
    try {
      const activeMember = await auth.api.getActiveMember({
        headers: requestHeaders,
      });
      organizationId = activeMember?.organizationId ?? null;
    } catch {
      organizationId = null;
    }
  }

  const orgRole =
    session?.user?.id && organizationId
      ? await getOrganizationRole(session.user.id, organizationId)
      : null;

  return {
    session,
    principalType: session ? "session" as const : "anonymous" as const,
    userId: session?.user?.id ?? null,
    organizationId,
    orgRole,
    apiKeyId: null,
    apiKeyScopes: [] as string[],
  };
}

// Context for MCP requests: the access token identifies a user, and the org
// is resolved the same way the session-create hook picks a default — oldest
// membership first. MCP acts as the user, so orgRole gates writes like a
// session would.
export async function createMcpContext(userId: string) {
  const [membership] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);

  const organizationId = membership?.organizationId ?? null;
  const orgRole = organizationId
    ? await getOrganizationRole(userId, organizationId)
    : null;

  return {
    session: null,
    principalType: "mcp" as const,
    userId,
    organizationId,
    orgRole,
    apiKeyId: null,
    apiKeyScopes: [] as string[],
  };
}

type Context =
  | Awaited<ReturnType<typeof createContext>>
  | Awaited<ReturnType<typeof createMcpContext>>;

const t = initTRPC.context<Context>().meta<OpenApiMeta>().create({
  transformer: superjson,
});

const isAuthenticated = t.middleware(async ({ ctx, next }) => {
  if (
    !ctx.session &&
    !ctx.apiKeyId &&
    ctx.principalType !== "worker" &&
    ctx.principalType !== "mcp"
  ) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId!,
      orgRole: ctx.orgRole,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

function apiKeyHasScope(scopes: string[] | null | undefined, scope: string) {
  const effectiveScopes = scopes?.length ? scopes : ["*"];
  return effectiveScopes.includes("*") || effectiveScopes.includes(scope);
}

function requireApiKeyScope(
  apiKeyId: string | null,
  scopes: string[] | null | undefined,
  scope: "read" | "write",
) {
  if (apiKeyId && !apiKeyHasScope(scopes, scope)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `API key is missing required "${scope}" scope`,
    });
  }
}

const hasOrganization = t.middleware(async ({ ctx, next }) => {
  if (
    !ctx.session &&
    !ctx.apiKeyId &&
    ctx.principalType !== "worker" &&
    ctx.principalType !== "mcp"
  ) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (!ctx.organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No active organization selected",
    });
  }

  requireApiKeyScope(ctx.apiKeyId, ctx.apiKeyScopes, "read");

  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId,
      orgRole: ctx.orgRole,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

const hasWriteAccess = t.middleware(async ({ ctx, next }) => {
  if (
    !ctx.session &&
    !ctx.apiKeyId &&
    ctx.principalType !== "worker" &&
    ctx.principalType !== "mcp"
  ) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (!ctx.organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No active organization selected",
    });
  }

  requireApiKeyScope(ctx.apiKeyId, ctx.apiKeyScopes, "write");

  if (ctx.principalType === "apiKey" || ctx.principalType === "worker") {
    return next({
      ctx: {
        ...ctx,
        apiKeyId: ctx.apiKeyId,
        apiKeyScopes: ctx.apiKeyScopes,
        organizationId: ctx.organizationId,
        orgRole: ctx.orgRole,
        principalType: ctx.principalType,
        session: ctx.session,
        userId: ctx.userId,
      },
    });
  }

  if (!isPrivilegedOrgRole(ctx.orgRole)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only organization admins can modify data",
    });
  }

  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId,
      orgRole: ctx.orgRole,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

const hasWorkerAccess = t.middleware(async ({ ctx, next }) => {
  if (ctx.principalType !== "worker") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This action requires internal worker authentication",
    });
  }

  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId,
      orgRole: ctx.orgRole,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

const hasOrgAdminSession = t.middleware(async ({ ctx, next }) => {
  if (ctx.principalType !== "session" || !ctx.userId || !ctx.organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This action requires an authenticated organization admin session",
    });
  }

  if (!isPrivilegedOrgRole(ctx.orgRole)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only organization admins can access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId,
      orgRole: ctx.orgRole,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

const hasOrgOwnerSession = t.middleware(async ({ ctx, next }) => {
  if (ctx.principalType !== "session" || !ctx.userId || !ctx.organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This action requires an authenticated organization owner session",
    });
  }

  if (ctx.orgRole !== "owner") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only organization owners can access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId,
      orgRole: ctx.orgRole,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure;
export const organizationRequired = hasOrganization;
export const writeAccessRequired = hasWriteAccess;
export const protectedProcedure = t.procedure.use(isAuthenticated);
export const orgProcedure = t.procedure.use(hasOrganization);
export const orgWriteProcedure = t.procedure.use(hasWriteAccess);
export const orgAdminProcedure = t.procedure.use(hasOrgAdminSession);
export const orgOwnerProcedure = t.procedure.use(hasOrgOwnerSession);
export const internalWorkerProcedure = t.procedure.use(hasWorkerAccess);
