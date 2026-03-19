import { z } from "zod";
import { eq, desc, and, ilike } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { campaignConfigs } from "@/schema/campaign-config";

export const campaignConfigRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(campaignConfigs)
      .where(eq(campaignConfigs.organizationId, ctx.organizationId))
      .orderBy(desc(campaignConfigs.createdAt));
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [config] = await db
        .select()
        .from(campaignConfigs)
        .where(and(eq(campaignConfigs.id, input.id), eq(campaignConfigs.organizationId, ctx.organizationId)));
      if (!config) throw new Error("Campaign config not found");
      return config;
    }),

  create: protectedProcedure
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(async ({ input, ctx }) => {
      const [config] = await db
        .insert(campaignConfigs)
        .values({
          name: input?.name ?? "Untitled Campaign",
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return config;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        objective: z
          .enum(["conversions", "traffic", "engagement", "awareness", "leads", "app_installs"])
          .nullable()
          .optional(),
        costCap: z.string().nullable().optional(),
        targetingMethod: z.array(z.string()).nullable().optional(),
        demographics: z.string().nullable().optional(),
        geos: z.array(z.string()).nullable().optional(),
        dailyBudget: z.string().nullable().optional(),
        placements: z.array(z.string()).nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [config] = await db
        .update(campaignConfigs)
        .set(data)
        .where(and(eq(campaignConfigs.id, id), eq(campaignConfigs.organizationId, ctx.organizationId)))
        .returning();
      return config;
    }),

  duplicate: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(campaignConfigs)
        .where(and(eq(campaignConfigs.id, input.id), eq(campaignConfigs.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Campaign config not found");
      const [duplicate] = await db
        .insert(campaignConfigs)
        .values({
          name: `Copy of ${source.name}`,
          objective: source.objective,
          costCap: source.costCap,
          targetingMethod: source.targetingMethod,
          demographics: source.demographics,
          geos: source.geos,
          dailyBudget: source.dailyBudget,
          placements: source.placements,
          notes: source.notes,
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: protectedProcedure
    .input(
      z.object({
        rows: z.array(
          z.object({
            name: z.string(),
            dailyBudget: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const results: { id: string; name: string }[] = [];
      for (const row of input.rows) {
        // Skip if campaign with same name already exists
        const [existing] = await db
          .select({ id: campaignConfigs.id })
          .from(campaignConfigs)
          .where(
            and(
              eq(campaignConfigs.name, row.name),
              eq(campaignConfigs.organizationId, ctx.organizationId),
            ),
          );
        if (existing) {
          results.push({ id: existing.id, name: row.name });
          continue;
        }
        const [campaign] = await db
          .insert(campaignConfigs)
          .values({
            name: row.name,
            dailyBudget: row.dailyBudget,
            createdBy: ctx.session.user.id,
            organizationId: ctx.organizationId,
          })
          .returning();
        results.push({ id: campaign.id, name: campaign.name });
      }
      return results;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(campaignConfigs)
        .where(and(eq(campaignConfigs.id, input.id), eq(campaignConfigs.organizationId, ctx.organizationId)));
    }),
});
