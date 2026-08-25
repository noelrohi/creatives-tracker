import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure, orgAdminProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";

const publicAdAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  metaAccountId: z.string(),
  defaultFacebookPageId: z.string().nullable(),
  defaultInstagramActorId: z.string().nullable(),
  notes: z.string().nullable(),
  isDisabled: z.boolean(),
  lastImportedAt: z.date().nullable(),
  dataDateEnd: z.string().nullable(),
  timezone: z.string().nullable(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  hasMetaAccessToken: z.boolean(),
});

function sanitizeAccount(account: typeof adAccounts.$inferSelect) {
  return publicAdAccountSchema.parse({
    id: account.id,
    name: account.name,
    metaAccountId: account.metaAccountId,
    defaultFacebookPageId: account.defaultFacebookPageId,
    defaultInstagramActorId: account.defaultInstagramActorId,
    notes: account.notes,
    isDisabled: account.isDisabled,
    lastImportedAt: account.lastImportedAt,
    dataDateEnd: account.dataDateEnd,
    timezone: account.timezone,
    organizationId: account.organizationId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasMetaAccessToken: Boolean(account.metaAccessToken),
  });
}

export const adAccountRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("adAccount", "list"))
    .input(z.object({ includeDisabled: z.boolean().default(false) }).optional())
    .output(z.array(publicAdAccountSchema))
    .query(async ({ input, ctx }) => {
      const accounts = await db
        .select()
        .from(adAccounts)
        .where(
          input?.includeDisabled
            ? eq(adAccounts.organizationId, ctx.organizationId)
            : and(
                eq(adAccounts.organizationId, ctx.organizationId),
                eq(adAccounts.isDisabled, false),
              ),
        )
        .orderBy(desc(adAccounts.createdAt));
      return accounts.map(sanitizeAccount);
    }),

  getById: orgAdminProcedure
    .meta(openApiQueryMeta("adAccount", "getById"))
    .input(z.object({ id: z.string() }))
    .output(publicAdAccountSchema)
    .query(async ({ input, ctx }) => {
      const [account] = await db
        .select()
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.id, input.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        );
      if (!account) throw new Error("Account not found");
      return sanitizeAccount(account);
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("adAccount", "create"))
    .input(
      z.object({
        name: z.string().min(1),
        metaAccountId: z.string().min(1),
        metaAccessToken: z.string().optional(),
        defaultFacebookPageId: z.string().trim().min(1).optional(),
        defaultInstagramActorId: z.string().trim().min(1).optional(),
        notes: z.string().optional(),
      }),
    )
    .output(publicAdAccountSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const [account] = await db
          .insert(adAccounts)
          .values({ ...input, organizationId: ctx.organizationId })
          .returning();
        return sanitizeAccount(account);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;
        const constraint =
          typeof error === "object" && error !== null && "constraint" in error
            ? String(error.constraint)
            : undefined;

        if (
          code === "23505" &&
          constraint === "ad_account_meta_account_id_unique"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This Meta account is already connected.",
          });
        }

        throw error;
      }
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("adAccount", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        metaAccountId: z.string().min(1).optional(),
        metaAccessToken: z.string().nullable().optional(),
        defaultFacebookPageId: z.string().trim().min(1).nullable().optional(),
        defaultInstagramActorId: z.string().trim().min(1).nullable().optional(),
        notes: z.string().nullable().optional(),
        isDisabled: z.boolean().optional(),
      }),
    )
    .output(publicAdAccountSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [account] = await db
        .update(adAccounts)
        .set(data)
        .where(
          and(
            eq(adAccounts.id, id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      return sanitizeAccount(account);
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("adAccount", "delete"))
    .input(z.object({ id: z.string() }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(adAccounts)
        .where(
          and(
            eq(adAccounts.id, input.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        );
    }),
});
