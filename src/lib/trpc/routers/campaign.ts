import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { campaigns } from "@/schema/campaign";

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
    .input(z.object({ name: z.string().optional(), metaId: z.string().optional() }).optional())
    .mutation(async ({ input, ctx }) => {
      const [campaign] = await db
        .insert(campaigns)
        .values({
          name: input?.name ?? "Untitled Campaign",
          metaId: input?.metaId,
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
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
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
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const results: { id: string; name: string }[] = [];
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
          results.push({ id: existing.id, name: row.name });
          continue;
        }
        const [campaign] = await db
          .insert(campaigns)
          .values({
            name: row.name,
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
