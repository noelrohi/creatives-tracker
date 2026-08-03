import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { abTests, abTestVariants } from "@/schema/ab-test";
import { adCreatives } from "@/schema/ad-creative";
import { adSets } from "@/schema/ad-set";
import { ads } from "@/schema/ad";
import { apiKeys } from "@/schema/api-key";
import { organization, session } from "@/schema/auth";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";
import { shopifyStores } from "@/schema/shopify";
import { entityTags, tags } from "@/schema/tag";
import { orgOwnerProcedure, router } from "../init";

export const organizationRouter = router({
  delete: orgOwnerProcedure
    .input(
      z.object({
        organizationId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You can only delete the currently active organization as its owner",
        });
      }

      return db.transaction(async (tx) => {
        await tx
          .delete(performanceLogs)
          .where(eq(performanceLogs.organizationId, input.organizationId));
        await tx
          .delete(abTestVariants)
          .where(eq(abTestVariants.organizationId, input.organizationId));
        await tx
          .delete(abTests)
          .where(eq(abTests.organizationId, input.organizationId));
        await tx
          .delete(entityTags)
          .where(eq(entityTags.organizationId, input.organizationId));
        await tx.delete(tags).where(eq(tags.organizationId, input.organizationId));
        await tx.delete(ads).where(eq(ads.organizationId, input.organizationId));
        await tx
          .delete(adSets)
          .where(eq(adSets.organizationId, input.organizationId));
        await tx
          .delete(campaigns)
          .where(eq(campaigns.organizationId, input.organizationId));
        await tx
          .delete(adCreatives)
          .where(eq(adCreatives.organizationId, input.organizationId));
        await tx
          .delete(adAccounts)
          .where(eq(adAccounts.organizationId, input.organizationId));
        await tx
          .delete(apiKeys)
          .where(eq(apiKeys.organizationId, input.organizationId));
        await tx
          .delete(shopifyStores)
          .where(eq(shopifyStores.organizationId, input.organizationId));
        await tx
          .update(session)
          .set({ activeOrganizationId: null })
          .where(eq(session.activeOrganizationId, input.organizationId));

        const [deletedOrganization] = await tx
          .delete(organization)
          .where(eq(organization.id, input.organizationId))
          .returning({
            id: organization.id,
            name: organization.name,
          });

        if (!deletedOrganization) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workspace not found",
          });
        }

        return deletedOrganization;
      });
    }),
});
