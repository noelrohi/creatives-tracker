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
import { studioProcedure } from "./studio.shared";

export const studioWinnerProcedures = {
  winningAngles: studioProcedure.query(async ({ ctx }) => {
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

  remixSource: studioProcedure
    .input(z.object({ creativeId: z.string() }))
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
