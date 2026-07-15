import { z } from "zod";
import type { TRPCRouterRecord } from "@trpc/server";
import { db } from "@/db";
import { studioBrandProfiles } from "@/schema/studio";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import {
  openApiMutationMeta,
  openApiQueryMeta,
} from "../openapi-meta";
import {
  remoteImageUrlSchema,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

const brandProfileOutputSchema = z.object({
  brandName: z.string(),
  productDescription: z.string(),
  offer: z.string().nullable(),
  productImageUrl: z.string().nullable(),
  productNotes: z.string().nullable(),
  prohibitedClaims: z.array(z.string()),
  requiredDisclaimers: z.array(z.string()),
});

export const studioBrandProcedures = {
  brandProfile: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "brandProfile",
        "Get the brand profile",
        "Get the organization brand and product context used by Studio. Prohibited claims and required disclaimers are enforced when generations are created.",
      ),
    )
    .output(brandProfileOutputSchema.nullable())
    .query(({ ctx }) => getStudioBrandProfile(ctx.organizationId)),

  saveBrandProfile: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "saveBrandProfile",
        "Save the brand profile",
        "Create or replace the organization brand and product context. Prohibited claims and required disclaimers supplied here are enforced at generation time.",
      ),
    )
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
    .output(z.object({ ok: z.literal(true) }))
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
