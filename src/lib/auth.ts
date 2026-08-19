import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { fetchClientMetadataResource } from "@/lib/cimd-fetch";
import * as authSchema from "@/schema/auth";
import * as oauthSchema from "@/schema/oauth";

const baseUrl = (
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

// Canonical identifier of the MCP protected resource. Access tokens are
// audience-bound to this URL, so it must match what /api/mcp advertises.
export const mcpResource = `${baseUrl}/api/mcp`;

// RFC 8252 loopback port variance covers only IP literals, so Better Auth
// rejects `http://localhost:<random-port>/callback` even when the client
// registered `http://127.0.0.1/callback`. Claude Code (and other native MCP
// clients) redirect to localhost, so normalize it to 127.0.0.1 before
// validation. Must apply to every endpoint that receives redirect_uri, or
// the token exchange would compare a rewritten value against a raw one.
function normalizeLoopbackRedirectUri(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return url.toString();
    }
  } catch {}
  return value;
}

async function defaultOrganizationId(userId: string) {
  const [membership] = await db
    .select({ organizationId: authSchema.member.organizationId })
    .from(authSchema.member)
    .where(eq(authSchema.member.userId, userId))
    .orderBy(asc(authSchema.member.createdAt))
    .limit(1);
  return membership?.organizationId ?? null;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { ...authSchema, ...oauthSchema },
  }),
  emailAndPassword: { enabled: true },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/oauth2/")) {
        return;
      }
      if (ctx.query?.redirect_uri) {
        ctx.query.redirect_uri = normalizeLoopbackRedirectUri(
          ctx.query.redirect_uri,
        );
      }
      if (
        ctx.body &&
        typeof ctx.body === "object" &&
        "redirect_uri" in ctx.body
      ) {
        ctx.body.redirect_uri = normalizeLoopbackRedirectUri(
          ctx.body.redirect_uri,
        );
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          return {
            data: {
              ...session,
              activeOrganizationId:
                session.activeOrganizationId ??
                (await defaultOrganizationId(session.userId)),
            },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
    }),
    jwt(),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource: mcpResource,
      // Multi-org users pick the workspace an MCP token is scoped to; the
      // choice is stored as the consent/token referenceId and surfaced to
      // the resource server as an organization_id claim.
      postLogin: {
        page: "/select-workspace",
        shouldRedirect: async ({ user }) => {
          const memberships = await db
            .select({ organizationId: authSchema.member.organizationId })
            .from(authSchema.member)
            .where(eq(authSchema.member.userId, user.id))
            .limit(2);
          return memberships.length > 1;
        },
        consentReferenceId: async ({ user, session }) => {
          const activeOrganizationId = session.activeOrganizationId;
          if (typeof activeOrganizationId === "string") {
            return activeOrganizationId;
          }
          return (await defaultOrganizationId(user.id)) ?? undefined;
        },
      },
      customAccessTokenClaims: ({ referenceId }) =>
        referenceId ? { organization_id: referenceId } : {},
      // CIMD needs a public HTTPS client_id URL, which local MCP clients
      // (Inspector, Claude Code) can't provide — let them use dynamic client
      // registration outside production.
      ...(process.env.NODE_ENV !== "production"
        ? {
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
          }
        : {}),
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});
