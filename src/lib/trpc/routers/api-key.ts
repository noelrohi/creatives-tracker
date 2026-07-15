import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgAdminProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { apiKeys } from "@/schema/api-key";
import { generateApiKey } from "@/lib/api-keys";

const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["*"]),
  expiresAt: z.string().datetime().optional(),
});

const apiKeyListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()).nullable(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
  createdByUserId: z.string().nullable(),
});

const createdApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()).nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
  key: z.string(),
});

const revokedApiKeySchema = z.object({
  id: z.string(),
  revokedAt: z.date().nullable(),
});

const deletedApiKeySchema = z.object({
  id: z.string(),
});

export const apiKeyRouter = router({
  list: orgAdminProcedure
    .meta(openApiQueryMeta("apiKey", "list"))
    .output(z.array(apiKeyListItemSchema))
    .query(async ({ ctx }) =>
      db
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
        .orderBy(desc(apiKeys.createdAt))),

  create: orgAdminProcedure
    .meta(openApiMutationMeta("apiKey", "create"))
    .input(createApiKeyInput)
    .output(createdApiKeySchema)
    .mutation(async ({ input, ctx }) => {
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

  revoke: orgAdminProcedure
    .meta(openApiMutationMeta("apiKey", "revoke"))
    .input(z.object({ id: z.string() }))
    .output(revokedApiKeySchema)
    .mutation(async ({ input, ctx }) => {
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

  delete: orgAdminProcedure
    .meta(openApiMutationMeta("apiKey", "delete"))
    .input(z.object({ id: z.string() }))
    .output(deletedApiKeySchema)
    .mutation(async ({ input, ctx }) => {
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
