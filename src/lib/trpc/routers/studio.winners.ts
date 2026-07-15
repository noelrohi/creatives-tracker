import { z } from "zod";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import type { AwarenessLevel } from "@/lib/awareness";
import {
  fetchCreativePerformanceRows,
  toNumber,
} from "@/lib/studio-performance";
import { openApiQueryMeta } from "../openapi-meta";
import { awarenessLevelSchema, studioProcedure } from "./studio.shared";

const winningAngleOutputSchema = z.object({
  angle: z.string(),
  awarenessLevel: awarenessLevelSchema.nullable(),
  adCount: z.number().int(),
  roas: z.number(),
  spend: z.number(),
  purchases: z.number(),
  assetUrl: z.string().nullable(),
});

const topCreativeOutputSchema = z.object({
  creativeId: z.string(),
  name: z.string(),
  angle: z.string().nullable(),
  persona: z.string().nullable(),
  awarenessLevel: awarenessLevelSchema.nullable(),
  assetUrl: z.string().nullable(),
  purchases: z.number(),
  purchaseValue: z.number(),
  roas: z.number(),
});

export const studioWinnerProcedures = {
  winningAngles: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "winningAngles",
        "List winning angles",
        "List read-only market signals aggregated by creative angle for remix and extend workflows. Results are ranked by blended ROAS; thin evidence below 10 purchases is demoted by the Studio UI.",
      ),
    )
    .output(z.array(winningAngleOutputSchema))
    .query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId, [
      sql`nullif(trim(${adCreatives.angle}), '') is not null`,
    ]);
    const byAngle = new Map<string, {
      angle: string;
      awarenessCounts: Map<string, number>;
      adCount: number;
      spend: number;
      purchases: number;
      purchaseValue: number;
      assetUrl: string | null;
      bestValue: number;
    }>();
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
      .map((group) => ({
        angle: group.angle,
        awarenessLevel: (Array.from(group.awarenessCounts.entries()).sort(
          (a, b) => b[1] - a[1],
        )[0]?.[0] ?? null) as AwarenessLevel | null,
        adCount: group.adCount,
        roas: group.spend > 0 ? group.purchaseValue / group.spend : 0,
        spend: group.spend,
        purchases: group.purchases,
        assetUrl: group.assetUrl,
      }))
      .filter((group) => group.spend > 0 || group.purchases > 0)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 8);
  }),

  topByPurchases: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "topByPurchases",
        "List top creatives",
        "List read-only market signals for creatives ranked by purchases for remix and extend workflows. The Studio UI demotes thin evidence below 10 purchases.",
      ),
    )
    .output(z.array(topCreativeOutputSchema))
    .query(async ({ ctx }) => {
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

  remixSource: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "remixSource",
        "Get a remix source",
        "Get the organization-owned creative fields needed to start a remix flow from a market winner. This is a read-only source lookup.",
      ),
    )
    .input(z.object({ creativeId: z.string() }))
    .output(
      z.object({
        id: z.string(),
        name: z.string(),
        assetUrl: z.string().nullable(),
        angle: z.string().nullable(),
        persona: z.string().nullable(),
        awarenessLevel: awarenessLevelSchema.nullable(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const [creative] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
        })
        .from(adCreatives)
        .where(
          and(
            eq(adCreatives.id, input.creativeId),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!creative) throw new TRPCError({ code: "NOT_FOUND", message: "Creative not found" });
      return creative;
    }),
} satisfies TRPCRouterRecord;
