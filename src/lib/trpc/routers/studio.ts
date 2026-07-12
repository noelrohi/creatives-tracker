import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { performanceLogs } from "@/schema/performance-log";
import { studioGenerations, studioVariants } from "@/schema/studio";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { AWARENESS_LEVELS, type AwarenessLevel } from "@/lib/awareness";
import { isImageStudioEnabled } from "@/lib/image-studio-enabled";
import type { generateStaticAdsTask } from "../../../../trigger/generate-static-ads";

const awarenessLevelSchema = z.enum(AWARENESS_LEVELS);

function requireImageStudioEnabled() {
  if (!isImageStudioEnabled()) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Image Studio is not enabled",
    });
  }
}

const studioProcedure = orgProcedure.use(async ({ next }) => {
  requireImageStudioEnabled();
  return next();
});

const studioWriteProcedure = orgWriteProcedure.use(async ({ next }) => {
  requireImageStudioEnabled();
  return next();
});

type CreativePerformanceRow = {
  creativeId: string;
  name: string;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  assetUrl: string | null;
  spend: string | null;
  purchases: number | null;
  purchaseValue: string | null;
  roas: string | null;
};

function toNumber(value: string | number | null | undefined) {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchCreativePerformanceRows(
  organizationId: string,
  extraConditions: SQL[] = [],
) {
  const basePl = basePerformanceLogFilter("performance_log");
  const conditions: SQL[] = [
    eq(adCreatives.organizationId, organizationId),
    eq(ads.organizationId, organizationId),
    basePl,
    ...extraConditions,
  ];

  return db
    .select({
      creativeId: adCreatives.id,
      name: adCreatives.name,
      angle: adCreatives.angle,
      persona: adCreatives.persona,
      awarenessLevel: adCreatives.awarenessLevel,
      assetUrl: adCreatives.assetUrl,
      spend: sql<string | null>`sum(${performanceLogs.spend})::text`,
      purchases: sql<number | null>`sum(${performanceLogs.conversions})::int`,
      purchaseValue: sql<string | null>`sum(${performanceLogs.purchaseValue})::text`,
      roas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
    })
    .from(adCreatives)
    .innerJoin(ads, eq(ads.adCreativeId, adCreatives.id))
    .innerJoin(performanceLogs, eq(performanceLogs.adId, ads.id))
    .where(and(...conditions))
    .groupBy(
      adCreatives.id,
      adCreatives.name,
      adCreatives.angle,
      adCreatives.persona,
      adCreatives.awarenessLevel,
      adCreatives.assetUrl,
    ) as Promise<CreativePerformanceRow[]>;
}

export const studioRouter = router({
  generate: studioWriteProcedure
    .input(
      z.object({
        brief: z.string().min(1),
        angle: z.string().optional(),
        persona: z.string().optional(),
        awarenessLevel: awarenessLevelSchema.optional(),
        count: z.number().int().min(1).max(4).default(3),
        referenceImageUrls: z.array(z.string().url()).max(4).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [generation] = await db
        .insert(studioGenerations)
        .values({
          organizationId: ctx.organizationId,
          brief: input.brief,
          angle: input.angle,
          persona: input.persona,
          awarenessLevel: input.awarenessLevel ?? null,
          count: input.count,
          referenceImageUrls: input.referenceImageUrls ?? null,
        })
        .returning();

      await db.insert(studioVariants).values(
        Array.from({ length: input.count }, (_, index) => ({
          generationId: generation.id,
          organizationId: ctx.organizationId,
          index,
          status: "pending",
        })),
      );

      const handle = await tasks.trigger<typeof generateStaticAdsTask>(
        "generate-static-ads",
        {
          generationId: generation.id,
          organizationId: ctx.organizationId,
          brief: input.brief,
          angle: input.angle,
          persona: input.persona,
          awarenessLevel: input.awarenessLevel ?? null,
          count: input.count,
          referenceImageUrls: input.referenceImageUrls,
        },
      );

      await db
        .update(studioGenerations)
        .set({ runId: handle.id, updatedAt: new Date() })
        .where(eq(studioGenerations.id, generation.id));

      const publicAccessToken = await triggerAuth.createPublicToken({
        scopes: {
          read: {
            runs: [handle.id],
          },
        },
        expirationTime: "1h",
      });

      return { runId: handle.id, publicAccessToken, generationId: generation.id };
    }),

  winningAngles: studioProcedure.query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId, [
      sql`nullif(trim(${adCreatives.angle}), '') is not null`,
    ]);

    const byAngle = new Map<
      string,
      {
        angle: string;
        awarenessCounts: Map<string, number>;
        adCount: number;
        spend: number;
        purchases: number;
        purchaseValue: number;
        assetUrl: string | null;
        bestValue: number;
      }
    >();

    for (const row of rows) {
      if (!row.angle?.trim()) continue;

      const angle = row.angle.trim();
      const current = byAngle.get(angle) ?? {
        angle,
        awarenessCounts: new Map<string, number>(),
        adCount: 0,
        spend: 0,
        purchases: 0,
        purchaseValue: 0,
        assetUrl: null,
        bestValue: -1,
      };

      current.adCount += 1;
      current.spend += toNumber(row.spend);
      current.purchases += toNumber(row.purchases);
      current.purchaseValue += toNumber(row.purchaseValue);

      // Keep the highest-value creative's image as the angle's representative thumbnail.
      const rowValue = toNumber(row.purchaseValue);
      if (row.assetUrl && rowValue > current.bestValue) {
        current.bestValue = rowValue;
        current.assetUrl = row.assetUrl;
      }

      if (row.awarenessLevel) {
        current.awarenessCounts.set(
          row.awarenessLevel,
          (current.awarenessCounts.get(row.awarenessLevel) ?? 0) + 1,
        );
      }

      byAngle.set(angle, current);
    }

    return Array.from(byAngle.values())
      .map((group) => {
        const awarenessLevel =
          Array.from(group.awarenessCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
          null;

        return {
          angle: group.angle,
          awarenessLevel: awarenessLevel as AwarenessLevel | null,
          adCount: group.adCount,
          roas: group.spend > 0 ? group.purchaseValue / group.spend : 0,
          spend: group.spend,
          purchases: group.purchases,
          assetUrl: group.assetUrl,
        };
      })
      .filter((group) => group.spend > 0 || group.purchases > 0)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 8);
  }),

  topByPurchases: studioProcedure.query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId);

    return rows
      .map((row) => ({
        creativeId: row.creativeId,
        name: row.name,
        angle: row.angle,
        persona: row.persona,
        awarenessLevel: row.awarenessLevel as AwarenessLevel | null,
        assetUrl: row.assetUrl,
        purchases: toNumber(row.purchases),
        purchaseValue: toNumber(row.purchaseValue),
        roas: toNumber(row.roas),
      }))
      .filter((row) => row.purchases > 0 || row.purchaseValue > 0)
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 8);
  }),

  generations: studioProcedure.query(async ({ ctx }) => {
    const generations = await db
      .select({
        id: studioGenerations.id,
        brief: studioGenerations.brief,
        angle: studioGenerations.angle,
        persona: studioGenerations.persona,
        awarenessLevel: studioGenerations.awarenessLevel,
        status: studioGenerations.status,
        count: studioGenerations.count,
        createdAt: studioGenerations.createdAt,
      })
      .from(studioGenerations)
      .where(eq(studioGenerations.organizationId, ctx.organizationId))
      .orderBy(desc(studioGenerations.createdAt))
      .limit(50);

    const generationIds = generations.map((generation) => generation.id);
    if (generationIds.length === 0) {
      return [];
    }

    const variants = await db
      .select({
        id: studioVariants.id,
        generationId: studioVariants.generationId,
        index: studioVariants.index,
        status: studioVariants.status,
        imageUrl: studioVariants.imageUrl,
        savedCreativeId: studioVariants.savedCreativeId,
      })
      .from(studioVariants)
      .where(
        and(
          eq(studioVariants.organizationId, ctx.organizationId),
          inArray(studioVariants.generationId, generationIds),
        ),
      )
      .orderBy(asc(studioVariants.index));

    const variantsByGenerationId = new Map<string, typeof variants>();
    for (const variant of variants) {
      const current = variantsByGenerationId.get(variant.generationId) ?? [];
      current.push(variant);
      variantsByGenerationId.set(variant.generationId, current);
    }

    return generations.map((generation) => ({
      ...generation,
      variants: (variantsByGenerationId.get(generation.id) ?? []).map((variant) => ({
        id: variant.id,
        index: variant.index,
        status: variant.status,
        imageUrl: variant.imageUrl,
        savedCreativeId: variant.savedCreativeId,
      })),
    }));
  }),

  generation: studioProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [generation] = await db
        .select()
        .from(studioGenerations)
        .where(
          and(
            eq(studioGenerations.id, input.id),
            eq(studioGenerations.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!generation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Generation not found" });
      }

      const variants = await db
        .select()
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.generationId, generation.id),
            eq(studioVariants.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(asc(studioVariants.index));

      const realtime =
        generation.status === "generating" && generation.runId
          ? {
              runId: generation.runId,
              publicAccessToken: await triggerAuth.createPublicToken({
                scopes: {
                  read: {
                    runs: [generation.runId],
                  },
                },
                expirationTime: "1h",
              }),
            }
          : null;

      return { generation, variants, realtime };
    }),

  save: studioWriteProcedure
    .input(
      z.object({
        name: z.string().optional(),
        assetUrl: z.string().url(),
        angle: z.string().optional(),
        persona: z.string().optional(),
        awarenessLevel: awarenessLevelSchema.optional(),
        variantId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [creative] = await db
        .insert(adCreatives)
        .values({
          name: input.name ?? "Generated static ad",
          assetUrl: input.assetUrl,
          format: "static",
          angle: input.angle,
          persona: input.persona,
          awarenessLevel: input.awarenessLevel,
          organizationId: ctx.organizationId,
        })
        .returning();

      if (input.variantId) {
        await db
          .update(studioVariants)
          .set({ savedCreativeId: creative.id, updatedAt: new Date() })
          .where(
            and(
              eq(studioVariants.id, input.variantId),
              eq(studioVariants.organizationId, ctx.organizationId),
            ),
          );
      }

      return creative;
    }),
});
