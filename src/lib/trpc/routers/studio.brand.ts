import { z } from "zod";
import type { TRPCRouterRecord } from "@trpc/server";
import { db } from "@/db";
import { studioBrandProfiles } from "@/schema/studio";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import {
  remoteImageUrlSchema,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

export const studioBrandProcedures = {
  brandProfile: studioProcedure.query(({ ctx }) =>
    getStudioBrandProfile(ctx.organizationId),
  ),

  saveBrandProfile: studioWriteProcedure
    .input(
      z.object({
        brandName: z.string().trim().min(1),
        productDescription: z.string().trim().min(1),
        offer: z.string().trim().max(500).optional(),
        productImageUrl: remoteImageUrlSchema.nullish(),
        productNotes: z.string().trim().max(1000).optional(),
        prohibitedClaims: z.array(z.string().trim().min(1)),
        requiredDisclaimers: z.array(z.string().trim().min(1)),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const values = {
        brandName: input.brandName,
        productDescription: input.productDescription,
        offer: input.offer || null,
        productImageUrl: input.productImageUrl ?? null,
        productNotes: input.productNotes || null,
        prohibitedClaims: input.prohibitedClaims,
        requiredDisclaimers: input.requiredDisclaimers,
      };
      await db
        .insert(studioBrandProfiles)
        .values({ organizationId: ctx.organizationId, ...values })
        .onConflictDoUpdate({
          target: studioBrandProfiles.organizationId,
          set: { ...values, updatedAt: new Date() },
        });
      return { ok: true };
    }),
} satisfies TRPCRouterRecord;
