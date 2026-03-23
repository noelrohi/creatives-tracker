import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { db } from "@/db";
import { campaigns } from "@/schema/campaign";

export const campaignRouter = router({
  list: baseProcedure.query(async () => {
    return db
      .select()
      .from(campaigns)
      .orderBy(desc(campaigns.createdAt));
  }),

  getById: baseProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, input.id));
      if (!campaign) throw new Error("Campaign not found");
      return campaign;
    }),

  create: baseProcedure
    .input(z.object({ name: z.string().optional(), metaId: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      const [campaign] = await db
        .insert(campaigns)
        .values({
          name: input?.name ?? "Untitled Campaign",
          metaId: input?.metaId,
        })
        .returning();
      return campaign;
    }),

  update: baseProcedure
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
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [campaign] = await db
        .update(campaigns)
        .set(data)
        .where(eq(campaigns.id, id))
        .returning();
      return campaign;
    }),

  duplicate: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, input.id));
      if (!source) throw new Error("Campaign not found");
      const [duplicate] = await db
        .insert(campaigns)
        .values({
          name: `Copy of ${source.name}`,
          objective: source.objective,
          status: source.status,
          notes: source.notes,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: baseProcedure
    .input(
      z.object({
        rows: z.array(
          z.object({
            name: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const results: { id: string; name: string }[] = [];
      for (const row of input.rows) {
        // Skip if campaign with same name already exists
        const [existing] = await db
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(eq(campaigns.name, row.name));
        if (existing) {
          results.push({ id: existing.id, name: row.name });
          continue;
        }
        const [campaign] = await db
          .insert(campaigns)
          .values({
            name: row.name,
          })
          .returning();
        results.push({ id: campaign.id, name: campaign.name });
      }
      return results;
    }),

  delete: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(campaigns)
        .where(eq(campaigns.id, input.id));
    }),
});
