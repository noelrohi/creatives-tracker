import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { accounts } from "@/schema/account";

export const accountRouter = router({
  list: baseProcedure.meta(openApiQueryMeta("account", "list")).query(async () => {
    return db
      .select()
      .from(accounts)
      .orderBy(desc(accounts.createdAt));
  }),

  getById: baseProcedure
    .meta(openApiQueryMeta("account", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, input.id));
      if (!account) throw new Error("Account not found");
      return account;
    }),

  create: baseProcedure
    .meta(openApiMutationMeta("account", "create"))
    .input(
      z.object({
        name: z.string().min(1),
        metaAccountId: z.string().min(1),
        metaAccessToken: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const [account] = await db
        .insert(accounts)
        .values(input)
        .returning();
      return account;
    }),

  update: baseProcedure
    .meta(openApiMutationMeta("account", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        metaAccountId: z.string().min(1).optional(),
        metaAccessToken: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [account] = await db
        .update(accounts)
        .set(data)
        .where(eq(accounts.id, id))
        .returning();
      return account;
    }),

  delete: baseProcedure
    .meta(openApiMutationMeta("account", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(accounts).where(eq(accounts.id, input.id));
    }),
});
