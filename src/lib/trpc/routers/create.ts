import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { performanceLogs } from "@/schema/performance-log";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import type { generateStaticAdsTask } from "../../../../trigger/generate-static-ads";

const awarenessLevels = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

const awarenessLevelSchema = z.enum(awarenessLevels);

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

export const createRouter = router({
  generate: orgWriteProcedure
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
      const handle = await tasks.trigger<typeof generateStaticAdsTask>(
        "generate-static-ads",
        {
          organizationId: ctx.organizationId,
          brief: input.brief,
          angle: input.angle,
          persona: input.persona,
          awarenessLevel: input.awarenessLevel ?? null,
          count: input.count,
          referenceImageUrls: input.referenceImageUrls,
        },
      );

      const publicAccessToken = await triggerAuth.createPublicToken({
        scopes: {
          read: {
            runs: [handle.id],
          },
        },
        expirationTime: "1h",
      });

      return { runId: handle.id, publicAccessToken };
    }),

  winningAngles: orgProcedure.query(async ({ ctx }) => {
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
          awarenessLevel,
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

  topByPurchases: orgProcedure.query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId);

    return rows
      .map((row) => ({
        creativeId: row.creativeId,
        name: row.name,
        angle: row.angle,
        persona: row.persona,
        awarenessLevel: row.awarenessLevel,
        assetUrl: row.assetUrl,
        purchases: toNumber(row.purchases),
        purchaseValue: toNumber(row.purchaseValue),
        roas: toNumber(row.roas),
      }))
      .filter((row) => row.purchases > 0 || row.purchaseValue > 0)
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 8);
  }),

  save: orgWriteProcedure
    .input(
      z.object({
        name: z.string().optional(),
        assetUrl: z.string().url(),
        angle: z.string().optional(),
        persona: z.string().optional(),
        awarenessLevel: awarenessLevelSchema.optional(),
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

      return creative;
    }),
});
