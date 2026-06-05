import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { campaigns } from "@/schema/campaign";

async function assertAccountBelongsToOrg(
  accountId: string,
  organizationId: string,
) {
  const [account] = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.id, accountId),
        eq(adAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!account) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Ad account does not exist in this organization",
    });
  }
}

export const campaignRouter = router({
  list: orgProcedure.meta(openApiQueryMeta("campaign", "list")).query(async ({ ctx }) => {
    return db
      .select()
      .from(campaigns)
      .where(eq(campaigns.organizationId, ctx.organizationId))
      .orderBy(desc(campaigns.createdAt));
  }),

  getById: orgProcedure
    .meta(openApiQueryMeta("campaign", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        );
      if (!campaign) throw new Error("Campaign not found");
      return campaign;
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("campaign", "create"))
    .input(z.object({
      name: z.string().optional(),
      metaId: z.string().optional(),
      accountId: z.string().optional(),
    }).optional())
    .mutation(async ({ input, ctx }) => {
      if (input?.accountId) {
        await assertAccountBelongsToOrg(input.accountId, ctx.organizationId);
      }

      const [campaign] = await db
        .insert(campaigns)
        .values({
          name: input?.name ?? "Untitled Campaign",
          metaId: input?.metaId,
          accountId: input?.accountId,
          organizationId: ctx.organizationId,
        })
        .returning();
      return campaign;
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("campaign", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        objective: z
          .enum(["conversions", "traffic", "engagement", "awareness", "leads", "app_installs"])
          .nullable()
          .optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        metaId: z.string().nullable().optional(),
        accountId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      if (data.accountId) {
        await assertAccountBelongsToOrg(data.accountId, ctx.organizationId);
      }

      const [campaign] = await db
        .update(campaigns)
        .set(data)
        .where(
          and(
            eq(campaigns.id, id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      return campaign;
    }),

  duplicate: orgWriteProcedure
    .meta(openApiMutationMeta("campaign", "duplicate"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        );
      if (!source) throw new Error("Campaign not found");
      const [duplicate] = await db
        .insert(campaigns)
        .values({
          name: `Copy of ${source.name}`,
          objective: source.objective,
          status: source.status,
          accountId: source.accountId,
          notes: source.notes,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: orgWriteProcedure
    .meta(openApiMutationMeta("campaign", "bulkImport"))
    .input(
      z.object({
        rows: z.array(
          z.object({
            name: z.string(),
            accountId: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const results: { id: string; name: string }[] = [];
      const accountIds = Array.from(new Set(input.rows.map((row) => row.accountId).filter((value): value is string => Boolean(value))));
      for (const accountId of accountIds) {
        await assertAccountBelongsToOrg(accountId, ctx.organizationId);
      }

      for (const row of input.rows) {
        const [existing] = await db
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(
            and(
              eq(campaigns.name, row.name),
              eq(campaigns.organizationId, ctx.organizationId),
            ),
          );
        if (existing) {
          if (row.accountId) {
            await db
              .update(campaigns)
              .set({ accountId: row.accountId })
              .where(
                and(
                  eq(campaigns.id, existing.id),
                  eq(campaigns.organizationId, ctx.organizationId),
                ),
              );
          }
          results.push({ id: existing.id, name: row.name });
          continue;
        }
        const [campaign] = await db
          .insert(campaigns)
          .values({
            name: row.name,
            accountId: row.accountId,
            organizationId: ctx.organizationId,
          })
          .returning();
        results.push({ id: campaign.id, name: campaign.name });
      }
      return results;
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("campaign", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(campaigns)
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        );
    }),
});
