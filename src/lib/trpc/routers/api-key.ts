import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { apiKeys } from "@/schema/api-key";
import { member } from "@/schema/auth";
import { generateApiKey } from "@/lib/api-keys";

const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["*"]),
  expiresAt: z.string().datetime().optional(),
});

async function assertOrgAdmin(userId: string, organizationId: string) {
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only organization admins can manage API keys",
    });
  }
}

async function requireOrgAdminSession(ctx: {
  principalType: "session" | "apiKey" | "anonymous";
  userId: string | null;
  organizationId: string | null;
}) {
  if (ctx.principalType !== "session" || !ctx.userId || !ctx.organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API key management requires an authenticated organization admin session",
    });
  }

  await assertOrgAdmin(ctx.userId, ctx.organizationId);
}

export const apiKeyRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("apiKey", "list"))
    .query(async ({ ctx }) => {
      await requireOrgAdminSession(ctx);

      return db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
          createdByUserId: apiKeys.createdByUserId,
        })
        .from(apiKeys)
        .where(eq(apiKeys.organizationId, ctx.organizationId))
        .orderBy(desc(apiKeys.createdAt));
    }),

  create: orgProcedure
    .meta(openApiMutationMeta("apiKey", "create"))
    .input(createApiKeyInput)
    .mutation(async ({ input, ctx }) => {
      await requireOrgAdminSession(ctx);

      const generated = generateApiKey();
      const [created] = await db
        .insert(apiKeys)
        .values({
          name: input.name,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          organizationId: ctx.organizationId,
          createdByUserId: ctx.userId,
          scopes: input.scopes,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          expiresAt: apiKeys.expiresAt,
          createdAt: apiKeys.createdAt,
        });

      return {
        ...created,
        key: generated.key,
      };
    }),

  revoke: orgProcedure
    .meta(openApiMutationMeta("apiKey", "revoke"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireOrgAdminSession(ctx);

      const [revoked] = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, input.id),
            eq(apiKeys.organizationId, ctx.organizationId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({
          id: apiKeys.id,
          revokedAt: apiKeys.revokedAt,
        });

      if (!revoked) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      return revoked;
    }),

  delete: orgProcedure
    .meta(openApiMutationMeta("apiKey", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireOrgAdminSession(ctx);

      const [deleted] = await db
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.id, input.id),
            eq(apiKeys.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: apiKeys.id });

      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      return deleted;
    }),
});
