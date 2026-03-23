import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { db } from "@/db";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import { ads } from "@/schema/ad";

export const adSetRouter = router({
  list: baseProcedure.query(async () => {
    const rows = await db
      .select({
        id: adSets.id,
        name: adSets.name,
        campaignId: adSets.campaignId,
        campaignName: campaigns.name,
        costCap: adSets.costCap,
        dailyBudget: adSets.dailyBudget,
        targetingMethod: adSets.targetingMethod,
        geos: adSets.geos,
        placements: adSets.placements,
        demographics: adSets.demographics,
        scheduleStart: adSets.scheduleStart,
        scheduleEnd: adSets.scheduleEnd,
        status: adSets.status,
        notes: adSets.notes,
        createdAt: adSets.createdAt,
        updatedAt: adSets.updatedAt,
        adCount: sql<number>`(SELECT count(*) FROM ad WHERE ad.ad_set_id = ${adSets.id})`.as("ad_count"),
      })
      .from(adSets)
      .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
      .orderBy(desc(adSets.createdAt));
    return rows;
  }),

  listByCampaign: baseProcedure
    .input(z.object({ campaignId: z.string() }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: adSets.id,
          name: adSets.name,
          costCap: adSets.costCap,
          dailyBudget: adSets.dailyBudget,
          status: adSets.status,
          notes: adSets.notes,
          createdAt: adSets.createdAt,
          adCount: sql<number>`(SELECT count(*) FROM ad WHERE ad.ad_set_id = ${adSets.id})`.as("ad_count"),
        })
        .from(adSets)
        .where(eq(adSets.campaignId, input.campaignId))
        .orderBy(desc(adSets.createdAt));
      return rows;
    }),

  getById: baseProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [adSet] = await db
        .select({
          id: adSets.id,
          name: adSets.name,
          campaignId: adSets.campaignId,
          campaignName: campaigns.name,
          costCap: adSets.costCap,
          dailyBudget: adSets.dailyBudget,
          targetingMethod: adSets.targetingMethod,
          geos: adSets.geos,
          placements: adSets.placements,
          demographics: adSets.demographics,
          scheduleStart: adSets.scheduleStart,
          scheduleEnd: adSets.scheduleEnd,
          status: adSets.status,
          notes: adSets.notes,
            createdAt: adSets.createdAt,
          updatedAt: adSets.updatedAt,
        })
        .from(adSets)
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .where(eq(adSets.id, input.id));
      if (!adSet) throw new Error("Ad set not found");
      return adSet;
    }),

  create: baseProcedure
    .input(
      z.object({
        name: z.string().optional(),
        campaignId: z.string(),
        costCap: z.string().optional(),
        dailyBudget: z.string().optional(),
        targetingMethod: z.array(z.string()).optional(),
        geos: z.array(z.string()).optional(),
        placements: z.array(z.string()).optional(),
        demographics: z.string().optional(),
        scheduleStart: z.string().datetime().optional(),
        scheduleEnd: z.string().datetime().optional(),
        metaId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const [adSet] = await db
        .insert(adSets)
        .values({
          name: input.name ?? "Untitled Ad Set",
          metaId: input.metaId,
          campaignId: input.campaignId,
          costCap: input.costCap,
          dailyBudget: input.dailyBudget,
          targetingMethod: input.targetingMethod,
          geos: input.geos,
          placements: input.placements,
          demographics: input.demographics,
          scheduleStart: input.scheduleStart ? new Date(input.scheduleStart) : undefined,
          scheduleEnd: input.scheduleEnd ? new Date(input.scheduleEnd) : undefined,
        })
        .returning();
      return adSet;
    }),

  update: baseProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        campaignId: z.string().optional(),
        costCap: z.string().nullable().optional(),
        dailyBudget: z.string().nullable().optional(),
        targetingMethod: z.array(z.string()).nullable().optional(),
        geos: z.array(z.string()).nullable().optional(),
        placements: z.array(z.string()).nullable().optional(),
        demographics: z.string().nullable().optional(),
        scheduleStart: z.string().datetime().nullable().optional(),
        scheduleEnd: z.string().datetime().nullable().optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        metaId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, scheduleStart, scheduleEnd, ...rest } = input;
      const data: Record<string, unknown> = { ...rest };
      if (scheduleStart !== undefined) {
        data.scheduleStart = scheduleStart ? new Date(scheduleStart) : null;
      }
      if (scheduleEnd !== undefined) {
        data.scheduleEnd = scheduleEnd ? new Date(scheduleEnd) : null;
      }
      const [adSet] = await db
        .update(adSets)
        .set(data)
        .where(eq(adSets.id, id))
        .returning();
      return adSet;
    }),

  duplicate: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(adSets)
        .where(eq(adSets.id, input.id));
      if (!source) throw new Error("Ad set not found");
      const [duplicate] = await db
        .insert(adSets)
        .values({
          name: `Copy of ${source.name}`,
          campaignId: source.campaignId,
          costCap: source.costCap,
          dailyBudget: source.dailyBudget,
          targetingMethod: source.targetingMethod,
          geos: source.geos,
          placements: source.placements,
          demographics: source.demographics,
          scheduleStart: source.scheduleStart,
          scheduleEnd: source.scheduleEnd,
          status: source.status,
          notes: source.notes,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: baseProcedure
    .input(
      z.object({
        campaignId: z.string(),
        rows: z.array(
          z.object({
            name: z.string(),
            dailyBudget: z.string().optional(),
            costCap: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const results: { id: string; name: string }[] = [];
      for (const row of input.rows) {
        const [existing] = await db
          .select({ id: adSets.id })
          .from(adSets)
          .where(
            and(
              eq(adSets.name, row.name),
              eq(adSets.campaignId, input.campaignId),
            ),
          );
        if (existing) {
          results.push({ id: existing.id, name: row.name });
          continue;
        }
        const [adSet] = await db
          .insert(adSets)
          .values({
            name: row.name,
            campaignId: input.campaignId,
            dailyBudget: row.dailyBudget,
            costCap: row.costCap,
          })
          .returning();
        results.push({ id: adSet.id, name: adSet.name });
      }
      return results;
    }),

  delete: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(adSets)
        .where(eq(adSets.id, input.id));
    }),
});
