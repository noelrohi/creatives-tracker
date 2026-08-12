import { TRPCError } from "@trpc/server";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  landingPageProvenance,
  type LandingPageProvenance,
} from "@/lib/landing-page";
import { ads } from "@/schema/ad";
import { funnelStageEnum } from "@/schema/enums";
import { landingPages } from "@/schema/landing-page";
import { shopifyOrders } from "@/schema/shopify";
import { orgProcedure, orgWriteProcedure, router } from "../init";

type LandingPageListItem = {
  id: string;
  normalizedUrl: string;
  family: string | null;
  provenance: LandingPageProvenance;
  firstSeenInAdsAt: Date | null;
  firstSeenInJourneysAt: Date | null;
  pageType: (typeof landingPages.$inferSelect)["pageType"];
  funnelStage: (typeof landingPages.$inferSelect)["funnelStage"];
  awarenessFit: (typeof landingPages.$inferSelect)["awarenessFit"];
  classificationStatus: (typeof landingPages.$inferSelect)["classificationStatus"];
  classificationSource: string | null;
  classificationConfidence: string | null;
  classifiedAt: Date | null;
  confirmedAt: Date | null;
  adCount: number;
  orderCount: number;
};

export const landingPageRouter = router({
  list: orgProcedure.query(
    async ({ ctx }): Promise<{ items: LandingPageListItem[] }> => {
      // ~150 pages per org, so the counts are two grouped scans merged in
      // memory rather than a correlated subquery per row.
      const [pages, adCounts, orderCounts] = await Promise.all([
        db
          .select()
          .from(landingPages)
          .where(eq(landingPages.organizationId, ctx.organizationId))
          .orderBy(landingPages.normalizedUrl),
        db
          .select({ landingPageId: ads.landingPageId, total: count() })
          .from(ads)
          .where(
            and(
              eq(ads.organizationId, ctx.organizationId),
              isNotNull(ads.landingPageId),
            ),
          )
          .groupBy(ads.landingPageId),
        db
          .select({ landingPageId: shopifyOrders.landingPageId, total: count() })
          .from(shopifyOrders)
          .where(
            and(
              eq(shopifyOrders.organizationId, ctx.organizationId),
              isNotNull(shopifyOrders.landingPageId),
            ),
          )
          .groupBy(shopifyOrders.landingPageId),
      ]);

      const adsByPage = new Map(
        adCounts.map((row) => [row.landingPageId, row.total]),
      );
      const ordersByPage = new Map(
        orderCounts.map((row) => [row.landingPageId, row.total]),
      );

      return {
        items: pages.map((page) => ({
          id: page.id,
          normalizedUrl: page.normalizedUrl,
          family: page.family,
          provenance: landingPageProvenance(page),
          firstSeenInAdsAt: page.firstSeenInAdsAt,
          firstSeenInJourneysAt: page.firstSeenInJourneysAt,
          pageType: page.pageType,
          funnelStage: page.funnelStage,
          awarenessFit: page.awarenessFit,
          classificationStatus: page.classificationStatus,
          classificationSource: page.classificationSource,
          classificationConfidence: page.classificationConfidence,
          classifiedAt: page.classifiedAt,
          confirmedAt: page.confirmedAt,
          adCount: adsByPage.get(page.id) ?? 0,
          orderCount: ordersByPage.get(page.id) ?? 0,
        })),
      };
    },
  ),

  /**
   * The mismatch drawer's answer (§9): "Yes" re-confirms the stage on record,
   * "No — it's colder" sends the corrected one. Either way the page becomes
   * human-owned and the AI stops overwriting it.
   */
  confirmStage: orgWriteProcedure
    .input(
      z.object({
        landingPageId: z.string(),
        funnelStage: z.enum(funnelStageEnum.enumValues),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [page] = await db
        .select({ id: landingPages.id })
        .from(landingPages)
        .where(
          and(
            eq(landingPages.id, input.landingPageId),
            eq(landingPages.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!page) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Landing page not found",
        });
      }

      const confirmedAt = new Date();
      await db
        .update(landingPages)
        .set({
          funnelStage: input.funnelStage,
          classificationStatus: "confirmed",
          classificationSource: "human",
          confirmedAt,
        })
        .where(eq(landingPages.id, page.id));

      return {
        landingPageId: page.id,
        funnelStage: input.funnelStage,
        confirmedAt,
      };
    }),
});
