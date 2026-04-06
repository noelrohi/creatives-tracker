import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { abTests, abTestVariants } from "@/schema/ab-test";
import { adCreatives } from "@/schema/ad-creative";
import { adSets } from "@/schema/ad-set";
import { ads } from "@/schema/ad";
import { apiKeys } from "@/schema/api-key";
import { member, organization, session } from "@/schema/auth";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";
import { entityTags, tags } from "@/schema/tag";
import { protectedProcedure, router } from "../init";

export const organizationRouter = router({
  delete: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.principalType !== "session" || !ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Organization deletion requires an authenticated owner session",
        });
      }

      const userId = ctx.userId;

      const [membership] = await db
        .select({ role: member.role })
        .from(member)
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, input.organizationId),
          ),
        )
        .limit(1);

      if (!membership || membership.role !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only organization owners can delete a workspace",
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
