import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { authenticateApiKey, getBearerToken } from "@/lib/api-keys";
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

  if (bearerToken) {
    const apiKeyPrincipal = await authenticateApiKey(bearerToken);

    if (!apiKeyPrincipal) {
      return {
        session: null,
        principalType: "anonymous" as const,
        userId: null,
        organizationId: null,
        apiKeyId: null,
        apiKeyScopes: [] as string[],
      };
    }

    return {
      session: null,
      principalType: "apiKey" as const,
      userId: null,
      organizationId: apiKeyPrincipal.organizationId,
      apiKeyId: apiKeyPrincipal.apiKeyId,
      apiKeyScopes: apiKeyPrincipal.scopes,
    };
  }

  const session = await auth.api.getSession({
    headers: requestHeaders,
  });
  return {
    session,
    principalType: session ? "session" as const : "anonymous" as const,
    userId: session?.user?.id ?? null,
    organizationId: session?.session?.activeOrganizationId ?? null,
    apiKeyId: null,
    apiKeyScopes: [] as string[],
  };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().meta<OpenApiMeta>().create({
  transformer: superjson,
});

const isAuthenticated = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session && !ctx.apiKeyId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId!,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

const hasOrganization = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session && !ctx.apiKeyId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (!ctx.organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No active organization selected",
    });
  }
  return next({
    ctx: {
      ...ctx,
      apiKeyId: ctx.apiKeyId,
      apiKeyScopes: ctx.apiKeyScopes,
      organizationId: ctx.organizationId,
      principalType: ctx.principalType,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

export const router = t.router;
export const baseProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(isAuthenticated);
export const orgProcedure = t.procedure.use(hasOrganization);
