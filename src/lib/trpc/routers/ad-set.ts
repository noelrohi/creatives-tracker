import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import { adAccounts } from "@/schema/account";

const pgAggregateStringSchema = z.preprocess((value) => value, z.string());

const adSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  campaignId: z.string(),
  accountId: z.string().nullable(),
  costCap: z.string().nullable(),
  dailyBudget: z.string().nullable(),
  targetingMethod: z.array(z.string()).nullable(),
  geos: z.array(z.string()).nullable(),
  placements: z.array(z.string()).nullable(),
  demographics: z.string().nullable(),
  scheduleStart: z.date().nullable(),
  scheduleEnd: z.date().nullable(),
  metaId: z.string().nullable(),
  organizationId: z.string().nullable(),
  status: z.enum(["active", "paused", "archived"]),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const adSetDetailsSchema = adSetSchema
  .omit({ organizationId: true, accountId: true })
  .extend({
    campaignName: z.string().nullable(),
    accountId: z.string().nullable(),
    accountName: z.string().nullable(),
    accountMetaAccountId: z.string().nullable(),
  });

const adSetListItemSchema = adSetDetailsSchema.extend({
  adCount: pgAggregateStringSchema,
});

const adSetCampaignListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string().nullable(),
  metaId: z.string().nullable(),
  costCap: z.string().nullable(),
  dailyBudget: z.string().nullable(),
  status: z.enum(["active", "paused", "archived"]),
  notes: z.string().nullable(),
  createdAt: z.date(),
  adCount: pgAggregateStringSchema,
});

const adSetImportResultSchema = z.object({
  id: z.string(),
  name: z.string(),
});

async function assertCampaignBelongsToOrg(
  campaignId: string,
  organizationId: string,
) {
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!campaign) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Campaign does not exist in this organization",
    });
  }
}

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

async function assertWritableReferencesBelongToOrg(input: {
  campaignId?: string;
  accountId?: string | null;
  organizationId: string;
}) {
  if (input.campaignId !== undefined) {
    await assertCampaignBelongsToOrg(input.campaignId, input.organizationId);
  }

  if (input.accountId) {
    await assertAccountBelongsToOrg(input.accountId, input.organizationId);
  }
}

export const adSetRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("adSet", "list"))
    .output(z.array(adSetListItemSchema))
    .query(async ({ ctx }) => {
      const rows = await db
        .select({
          id: adSets.id,
          name: adSets.name,
          campaignId: adSets.campaignId,
          campaignName: campaigns.name,
          accountId: adAccounts.id,
          accountName: adAccounts.name,
          accountMetaAccountId: adAccounts.metaAccountId,
          metaId: adSets.metaId,
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
        .leftJoin(
          campaigns,
          and(
            eq(adSets.campaignId, campaigns.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          adAccounts,
          and(
            eq(adSets.accountId, adAccounts.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        )
        .where(eq(adSets.organizationId, ctx.organizationId))
        .orderBy(desc(adSets.createdAt));
      return rows;
    }),

  listByCampaign: orgProcedure
    .meta(openApiQueryMeta("adSet", "listByCampaign"))
    .input(z.object({ campaignId: z.string() }))
    .output(z.array(adSetCampaignListItemSchema))
    .query(async ({ input, ctx }) => {
      const rows = await db
        .select({
          id: adSets.id,
          name: adSets.name,
          accountId: adAccounts.id,
          metaId: adSets.metaId,
          costCap: adSets.costCap,
          dailyBudget: adSets.dailyBudget,
          status: adSets.status,
          notes: adSets.notes,
          createdAt: adSets.createdAt,
          adCount: sql<number>`(SELECT count(*) FROM ad WHERE ad.ad_set_id = ${adSets.id})`.as("ad_count"),
        })
        .from(adSets)
        .leftJoin(
          adAccounts,
          and(
            eq(adSets.accountId, adAccounts.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        )
        .where(and(eq(adSets.campaignId, input.campaignId), eq(adSets.organizationId, ctx.organizationId)))
        .orderBy(desc(adSets.createdAt));
      return rows;
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("adSet", "getById"))
    .input(z.object({ id: z.string() }))
    .output(adSetDetailsSchema)
    .query(async ({ input, ctx }) => {
      const [adSet] = await db
        .select({
          id: adSets.id,
          name: adSets.name,
          campaignId: adSets.campaignId,
          campaignName: campaigns.name,
          accountId: adAccounts.id,
          accountName: adAccounts.name,
          accountMetaAccountId: adAccounts.metaAccountId,
          metaId: adSets.metaId,
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
        .leftJoin(
          campaigns,
          and(
            eq(adSets.campaignId, campaigns.id),
            eq(campaigns.organizationId, ctx.organizationId),
          ),
        )
        .leftJoin(
          adAccounts,
          and(
            eq(adSets.accountId, adAccounts.id),
            eq(adAccounts.organizationId, ctx.organizationId),
          ),
        )
        .where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
      if (!adSet) throw new Error("Ad set not found");
      return adSet;
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("adSet", "create"))
    .input(
      z.object({
        name: z.string().optional(),
        campaignId: z.string(),
        accountId: z.string().optional(),
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
    .output(adSetSchema)
    .mutation(async ({ input, ctx }) => {
      await assertWritableReferencesBelongToOrg({
        campaignId: input.campaignId,
        accountId: input.accountId,
        organizationId: ctx.organizationId,
      });

      const [adSet] = await db
        .insert(adSets)
        .values({
          name: input.name ?? "Untitled Ad Set",
          metaId: input.metaId,
          campaignId: input.campaignId,
          accountId: input.accountId,
          costCap: input.costCap,
          dailyBudget: input.dailyBudget,
          targetingMethod: input.targetingMethod,
          geos: input.geos,
          placements: input.placements,
          demographics: input.demographics,
          scheduleStart: input.scheduleStart ? new Date(input.scheduleStart) : undefined,
          scheduleEnd: input.scheduleEnd ? new Date(input.scheduleEnd) : undefined,
          organizationId: ctx.organizationId,
        })
        .returning();
      return adSet;
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("adSet", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        campaignId: z.string().optional(),
        accountId: z.string().nullable().optional(),
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
    .output(adSetSchema)
    .mutation(async ({ input, ctx }) => {
      await assertWritableReferencesBelongToOrg({
        campaignId: input.campaignId,
        accountId: input.accountId,
        organizationId: ctx.organizationId,
      });

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
        .where(and(eq(adSets.id, id), eq(adSets.organizationId, ctx.organizationId)))
        .returning();
      if (!adSet) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Ad set does not exist in this organization",
        });
      }
      return adSet;
    }),

  duplicate: orgWriteProcedure
    .meta(openApiMutationMeta("adSet", "duplicate"))
    .input(z.object({ id: z.string() }))
    .output(adSetSchema)
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(adSets)
        .where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Ad set not found");
      await assertCampaignBelongsToOrg(source.campaignId, ctx.organizationId);
      if (source.accountId) {
        await assertAccountBelongsToOrg(source.accountId, ctx.organizationId);
      }

      const [duplicate] = await db
        .insert(adSets)
        .values({
          name: `Copy of ${source.name}`,
          campaignId: source.campaignId,
          accountId: source.accountId,
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
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: orgWriteProcedure
    .meta(openApiMutationMeta("adSet", "bulkImport"))
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
    .output(z.array(adSetImportResultSchema))
    .mutation(async ({ input, ctx }) => {
      await assertCampaignBelongsToOrg(input.campaignId, ctx.organizationId);

      const results: { id: string; name: string }[] = [];
      for (const row of input.rows) {
        const [existing] = await db
          .select({ id: adSets.id })
          .from(adSets)
          .where(
            and(
              eq(adSets.name, row.name),
              eq(adSets.campaignId, input.campaignId),
              eq(adSets.organizationId, ctx.organizationId),
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
            organizationId: ctx.organizationId,
          })
          .returning();
        results.push({ id: adSet.id, name: adSet.name });
      }
      return results;
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("adSet", "delete"))
    .input(z.object({ id: z.string() }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(adSets)
        .where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
    }),
});
