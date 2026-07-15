import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import {
  studioCopyPackages,
  studioGenerations,
  studioVariants,
} from "@/schema/studio";
import { studioAdNameId, studioAdNameSlug } from "@/lib/studio-ad-name";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import { fetchStudioMarketTopVariants } from "@/lib/studio-market";
import {
  fetchCreativePerformanceRows,
  toNullableNumber,
} from "@/lib/studio-performance";
import {
  failStudioGeneration,
  finalizeStudioGenerationIfSettled,
} from "@/lib/studio-generation-status";
import {
  artDirectionFor,
  buildPrompt,
  type StudioFormat,
} from "@/lib/studio-prompt";
import type {
  generateStaticAdsTask,
  generateStaticAdVariantTask,
} from "../../../../trigger/generate-static-ads";
import {
  createStudioGeneration,
  extendStudioWinner,
  fetchSourceCreatives,
  generationInput,
  markSchema,
  reconcileStaleGenerations,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

export const studioGenerationProcedures = {
  generate: studioWriteProcedure.input(generationInput).mutation(async ({ input, ctx }) => {
    const generation = await createStudioGeneration(ctx.organizationId, input);
    const publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { runs: [generation.runId] } },
      expirationTime: "1h",
    });
    return { ...generation, publicAccessToken };
  }),

  retry: studioWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const generation = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(studioGenerations)
          .set({ status: "generating", runId: null, updatedAt: new Date() })
          .where(
            and(
              eq(studioGenerations.id, input.id),
              eq(studioGenerations.organizationId, ctx.organizationId),
              eq(studioGenerations.status, "failed"),
            ),
          )
          .returning();
        if (!claimed) return null;
        await tx
          .update(studioVariants)
          .set({
            status: "pending",
            imageUrl: null,
            prompt: null,
            mark: null,
            publishedAt: null,
            moderationReason: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studioVariants.generationId, claimed.id),
              eq(studioVariants.organizationId, ctx.organizationId),
            ),
          );
        return claimed;
      });
      if (!generation) {
        throw new TRPCError({ code: "CONFLICT", message: "Only failed generations can be retried" });
      }
      try {
        const handle = await tasks.trigger<typeof generateStaticAdsTask>(
          "generate-static-ads",
          {
            generationId: generation.id,
            organizationId: ctx.organizationId,
            brief: generation.brief,
            angle: generation.angle ?? undefined,
            persona: generation.persona ?? undefined,
            awarenessLevel: generation.awarenessLevel,
            count: generation.count,
            format: generation.format as StudioFormat,
            referenceImageUrls: generation.referenceImageUrls ?? undefined,
          },
        );
        await db
          .update(studioGenerations)
          .set({ runId: handle.id, updatedAt: new Date() })
          .where(eq(studioGenerations.id, generation.id));
        return { runId: handle.id };
      } catch (error) {
        await failStudioGeneration(generation.id, ctx.organizationId);
        throw error;
      }
    }),

  generations: studioProcedure.query(async ({ ctx }) => {
    const generations = await db
      .select()
      .from(studioGenerations)
      .where(eq(studioGenerations.organizationId, ctx.organizationId))
      .orderBy(desc(studioGenerations.createdAt))
      .limit(50);
    if (generations.length === 0) return [];
    const staleIds = await reconcileStaleGenerations(ctx.organizationId, generations);
    for (const generation of generations) {
      if (staleIds.includes(generation.id)) generation.status = "failed";
    }
    const generationIds = generations.map((generation) => generation.id);
    const [variants, packages] = await Promise.all([
      db
        .select()
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.organizationId, ctx.organizationId),
            inArray(studioVariants.generationId, generationIds),
          ),
        )
        .orderBy(asc(studioVariants.index)),
      db
        .select()
        .from(studioCopyPackages)
        .where(eq(studioCopyPackages.organizationId, ctx.organizationId)),
    ]);
    const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
    const linkedCreativeIds = Array.from(
      new Set(
        variants.flatMap((variant) =>
          variant.linkedCreativeId ? [variant.linkedCreativeId] : [],
        ),
      ),
    );
    const [sources, linkedCreatives, linkedPerformance] = await Promise.all([
      fetchSourceCreatives(
        ctx.organizationId,
        generations.flatMap((generation) =>
          generation.sourceCreativeId ? [generation.sourceCreativeId] : [],
        ),
      ),
      linkedCreativeIds.length
        ? db
            .select({ id: adCreatives.id, name: adCreatives.name })
            .from(adCreatives)
            .where(
              and(
                eq(adCreatives.organizationId, ctx.organizationId),
                inArray(adCreatives.id, linkedCreativeIds),
              ),
            )
        : [],
      linkedCreativeIds.length
        ? fetchCreativePerformanceRows(ctx.organizationId, [
            inArray(adCreatives.id, linkedCreativeIds),
          ])
        : [],
    ]);
    const linkedPerformanceById = new Map(
      linkedPerformance.map((row) => [
        row.creativeId,
        { roas: toNullableNumber(row.roas) },
      ]),
    );
    const linkedCreativeById = new Map(
      linkedCreatives.map((creative) => [
        creative.id,
        {
          ...creative,
          roas: linkedPerformanceById.get(creative.id)?.roas ?? null,
        },
      ]),
    );
    const variantsByGenerationId = new Map<string, typeof variants>();
    for (const variant of variants) {
      const current = variantsByGenerationId.get(variant.generationId) ?? [];
      current.push(variant);
      variantsByGenerationId.set(variant.generationId, current);
    }
    return generations.map((generation) => ({
      ...generation,
      source: generation.sourceCreativeId
        ? sources.get(generation.sourceCreativeId) ?? null
        : null,
      variants: (variantsByGenerationId.get(generation.id) ?? []).map((variant) => ({
        ...variant,
        copyPackage: variant.copyPackageId
          ? packageById.get(variant.copyPackageId) ?? null
          : null,
        linkedCreative: variant.linkedCreativeId
          ? linkedCreativeById.get(variant.linkedCreativeId) ?? null
          : null,
      })),
    }));
  }),

  marketTopVariants: studioProcedure.query(({ ctx }) =>
    fetchStudioMarketTopVariants(ctx.organizationId),
  ),

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
      if (!generation) throw new TRPCError({ code: "NOT_FOUND", message: "Generation not found" });
      const staleIds = await reconcileStaleGenerations(ctx.organizationId, [generation]);
      if (staleIds.includes(generation.id)) generation.status = "failed";
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
      const packageIds = variants.flatMap((variant) =>
        variant.copyPackageId ? [variant.copyPackageId] : [],
      );
      const linkedCreativeIds = Array.from(
        new Set(
          variants.flatMap((variant) =>
            variant.linkedCreativeId ? [variant.linkedCreativeId] : [],
          ),
        ),
      );
      const [packages, linkedCreatives, linkedPerformance, sources] = await Promise.all([
        packageIds.length
          ? db
              .select()
              .from(studioCopyPackages)
              .where(
                and(
                  eq(studioCopyPackages.organizationId, ctx.organizationId),
                  inArray(studioCopyPackages.id, packageIds),
                ),
              )
          : [],
        linkedCreativeIds.length
          ? db
              .select({
                id: adCreatives.id,
                name: adCreatives.name,
                assetUrl: adCreatives.assetUrl,
                format: adCreatives.format,
              })
              .from(adCreatives)
              .where(
                and(
                  eq(adCreatives.organizationId, ctx.organizationId),
                  inArray(adCreatives.id, linkedCreativeIds),
                ),
              )
          : [],
        linkedCreativeIds.length
          ? fetchCreativePerformanceRows(ctx.organizationId, [
              inArray(adCreatives.id, linkedCreativeIds),
            ])
          : [],
        fetchSourceCreatives(
          ctx.organizationId,
          generation.sourceCreativeId ? [generation.sourceCreativeId] : [],
        ),
      ]);
      const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
      const linkedRoasById = new Map(
        linkedPerformance.map((row) => [row.creativeId, toNullableNumber(row.roas)]),
      );
      const linkedCreativeById = new Map(
        linkedCreatives.map((creative) => [
          creative.id,
          { ...creative, roas: linkedRoasById.get(creative.id) ?? null },
        ]),
      );
      const realtime =
        generation.status === "generating" && generation.runId
          ? {
              runId: generation.runId,
              publicAccessToken: await triggerAuth.createPublicToken({
                scopes: { read: { runs: [generation.runId] } },
                expirationTime: "1h",
              }),
            }
          : null;
      return {
        generation,
        variants: variants.map((variant) => ({
          ...variant,
          copyPackage: variant.copyPackageId
            ? packageById.get(variant.copyPackageId) ?? null
            : null,
          linkedCreative: variant.linkedCreativeId
            ? linkedCreativeById.get(variant.linkedCreativeId) ?? null
            : null,
        })),
        realtime,
        source: generation.sourceCreativeId
          ? sources.get(generation.sourceCreativeId) ?? null
          : null,
      };
    }),

  linkCandidates: studioProcedure
    .input(
      z.object({
        variantId: z.string().optional(),
        search: z.string().trim().max(80).optional(),
        publishedAfter: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const [variant] = input.variantId
        ? await db
            .select({
              id: studioVariants.id,
              angle: studioGenerations.angle,
            })
            .from(studioVariants)
            .innerJoin(
              studioGenerations,
              eq(studioGenerations.id, studioVariants.generationId),
            )
            .where(
              and(
                eq(studioVariants.id, input.variantId),
                eq(studioVariants.organizationId, ctx.organizationId),
                eq(studioGenerations.organizationId, ctx.organizationId),
              ),
            )
            .limit(1)
        : [];
      if (input.variantId && !variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
      }

      const parsedPublishedAfter = input.publishedAfter
        ? new Date(input.publishedAfter)
        : null;
      const publishedAfter =
        parsedPublishedAfter && !Number.isNaN(parsedPublishedAfter.getTime())
          ? parsedPublishedAfter
          : null;
      const idSlice = input.variantId ? studioAdNameId(input.variantId) : null;
      const angleSlug = studioAdNameSlug(variant?.angle ?? "") || null;
      const conditions = [eq(adCreatives.organizationId, ctx.organizationId)];
      if (input.search) {
        conditions.push(
          or(
            idSlice ? ilike(adCreatives.name, `%${idSlice}%`) : undefined,
            angleSlug ? ilike(adCreatives.name, `%${angleSlug}%`) : undefined,
            ilike(adCreatives.name, `%${input.search}%`),
          )!,
        );
      }
      const creatives = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          format: adCreatives.format,
          createdAt: adCreatives.createdAt,
        })
        .from(adCreatives)
        .where(and(...conditions))
        .orderBy(
          sql`case
            when ${idSlice}::text is not null and ${adCreatives.name} ilike ${`%${idSlice ?? ""}%`} then 0
            when ${angleSlug}::text is not null and ${adCreatives.name} ilike ${`%${angleSlug ?? ""}%`} then 1
            when ${input.search ?? null}::text is not null and ${adCreatives.name} ilike ${`%${input.search ?? ""}%`} then 2
            else 3
          end`,
          ...(publishedAfter
            ? [
                sql`case when ${adCreatives.format} = 'static' and ${adCreatives.createdAt} >= ${publishedAfter} then 0 else 1 end`,
              ]
            : []),
          desc(adCreatives.createdAt),
        )
        .limit(30);
      if (creatives.length === 0) return [];

      const performance = await fetchCreativePerformanceRows(ctx.organizationId, [
        inArray(adCreatives.id, creatives.map((creative) => creative.id)),
      ]);
      const performanceById = new Map(
        performance.map((row) => [
          row.creativeId,
          {
            roas: toNullableNumber(row.roas),
            spend: toNullableNumber(row.spend),
          },
        ]),
      );
      const ranked = creatives.map((creative) => {
        const name = creative.name.toLowerCase();
        const matchReason = idSlice && name.includes(idSlice)
          ? "template" as const
          : angleSlug && name.includes(angleSlug)
            ? "angle" as const
            : input.search && name.includes(input.search.toLowerCase())
              ? "fuzzy" as const
              : "recent" as const;
        return {
          ...creative,
          matchReason,
          roas: performanceById.get(creative.id)?.roas ?? null,
          spend: performanceById.get(creative.id)?.spend ?? null,
        };
      });
      const rank = { template: 0, angle: 1, fuzzy: 2, recent: 3 } as const;
      return ranked.sort(
        (a, b) =>
          rank[a.matchReason] - rank[b.matchReason] ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    }),

  linkVariantToCreative: studioWriteProcedure
    .input(
      z.object({
        variantId: z.string(),
        creativeId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .select({ id: studioVariants.id, publishedAt: studioVariants.publishedAt })
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.id, input.variantId),
            eq(studioVariants.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
      }

      if (input.creativeId) {
        if (!variant.publishedAt) {
          throw new TRPCError({ code: "CONFLICT", message: "Publish the image first" });
        }
        const [creative] = await db
          .select({ id: adCreatives.id })
          .from(adCreatives)
          .where(
            and(
              eq(adCreatives.id, input.creativeId),
              eq(adCreatives.organizationId, ctx.organizationId),
            ),
          )
          .limit(1);
        if (!creative) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Creative not found" });
        }
      }

      await db
        .update(studioVariants)
        .set({ linkedCreativeId: input.creativeId, updatedAt: new Date() })
        .where(
          and(
            eq(studioVariants.id, variant.id),
            eq(studioVariants.organizationId, ctx.organizationId),
          ),
        );
      return { ok: true };
    }),

  publishAndLink: studioWriteProcedure
    .input(
      z.object({
        variantId: z.string(),
        creativeId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      db.transaction(async (tx) => {
        const [variant] = await tx
          .select({
            id: studioVariants.id,
            publishedAt: studioVariants.publishedAt,
          })
          .from(studioVariants)
          .where(
            and(
              eq(studioVariants.id, input.variantId),
              eq(studioVariants.organizationId, ctx.organizationId),
              eq(studioVariants.status, "ready"),
              eq(studioVariants.mark, "good"),
            ),
          )
          .for("update")
          .limit(1);
        if (!variant) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Only Good images can be published",
          });
        }
        if (input.creativeId) {
          const [creative] = await tx
            .select({ id: adCreatives.id })
            .from(adCreatives)
            .where(
              and(
                eq(adCreatives.id, input.creativeId),
                eq(adCreatives.organizationId, ctx.organizationId),
              ),
            )
            .limit(1);
          if (!creative) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Creative not found",
            });
          }
        }
        const [published] = await tx
          .update(studioVariants)
          .set({
            publishedAt: variant.publishedAt ?? new Date(),
            linkedCreativeId: input.creativeId ?? undefined,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studioVariants.id, variant.id),
              eq(studioVariants.organizationId, ctx.organizationId),
              eq(studioVariants.status, "ready"),
              eq(studioVariants.mark, "good"),
            ),
          )
          .returning({
            id: studioVariants.id,
            publishedAt: studioVariants.publishedAt,
            linkedCreativeId: studioVariants.linkedCreativeId,
          });
        if (!published) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Image changed while publishing",
          });
        }
        return published;
      }),
    ),

  extendVariant: studioWriteProcedure
    .input(z.object({ variantId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const generation = await extendStudioWinner(ctx.organizationId, input);
      return { generationId: generation.generationId };
    }),

  setVariantMark: studioWriteProcedure
    .input(z.object({ variantId: z.string(), mark: markSchema.nullable() }))
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .update(studioVariants)
        .set({
          mark: input.mark,
          publishedAt: input.mark === "good" ? undefined : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioVariants.id, input.variantId),
            eq(studioVariants.organizationId, ctx.organizationId),
            eq(studioVariants.status, "ready"),
          ),
        )
        .returning({
          id: studioVariants.id,
          mark: studioVariants.mark,
          publishedAt: studioVariants.publishedAt,
        });
      if (!variant) throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
      return variant;
    }),

  setVariantPublished: studioWriteProcedure
    .input(z.object({ variantId: z.string(), published: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .update(studioVariants)
        .set({ publishedAt: input.published ? new Date() : null, updatedAt: new Date() })
        .where(
          and(
            eq(studioVariants.id, input.variantId),
            eq(studioVariants.organizationId, ctx.organizationId),
            eq(studioVariants.status, "ready"),
            eq(studioVariants.mark, "good"),
          ),
        )
        .returning({ id: studioVariants.id, publishedAt: studioVariants.publishedAt });
      if (!variant) {
        throw new TRPCError({ code: "CONFLICT", message: "Only Good images can be published" });
      }
      return variant;
    }),

  retryVariant: studioWriteProcedure
    .input(z.object({ variantId: z.string(), withoutReferenceImage: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const claimed = await db.transaction(async (tx) => {
        const [variant] = await tx
          .select({
            id: studioVariants.id,
            index: studioVariants.index,
            generationId: studioVariants.generationId,
            status: studioVariants.status,
            moderationReason: studioVariants.moderationReason,
            prompt: studioVariants.prompt,
            brief: studioGenerations.brief,
            angle: studioGenerations.angle,
            persona: studioGenerations.persona,
            awarenessLevel: studioGenerations.awarenessLevel,
            count: studioGenerations.count,
            format: studioGenerations.format,
            referenceImageUrls: studioGenerations.referenceImageUrls,
          })
          .from(studioVariants)
          .innerJoin(studioGenerations, eq(studioGenerations.id, studioVariants.generationId))
          .where(
            and(
              eq(studioVariants.id, input.variantId),
              eq(studioVariants.organizationId, ctx.organizationId),
              eq(studioGenerations.organizationId, ctx.organizationId),
            ),
          )
          .for("update");
        if (!variant) throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found" });
        if (variant.status !== "failed") {
          throw new TRPCError({ code: "CONFLICT", message: "Only failed images can be retried" });
        }
        if (input.withoutReferenceImage && !variant.moderationReason) {
          throw new TRPCError({ code: "CONFLICT", message: "This image was not blocked by moderation" });
        }
        await tx
          .update(studioVariants)
          .set({
            status: "pending",
            imageUrl: null,
            prompt: null,
            mark: null,
            publishedAt: null,
            moderationReason: null,
            retryWithoutImageAt: input.withoutReferenceImage ? new Date() : undefined,
            updatedAt: new Date(),
          })
          .where(eq(studioVariants.id, variant.id));
        await tx
          .update(studioGenerations)
          .set({ status: "generating", updatedAt: new Date() })
          .where(eq(studioGenerations.id, variant.generationId));
        return variant;
      });
      const brand = await getStudioBrandProfile(ctx.organizationId);
      const layoutReferenceUrls = input.withoutReferenceImage
        ? []
        : claimed.referenceImageUrls ?? [];
      const retryReferenceImageUrls = input.withoutReferenceImage
        ? undefined
        : brand?.productImageUrl &&
            !layoutReferenceUrls.includes(brand.productImageUrl)
          ? [...layoutReferenceUrls, brand.productImageUrl]
          : claimed.referenceImageUrls ?? undefined;
      // Reuse the exact prompt the variant was generated with (the rewritten
      // one when the rewrite stage ran) so a retry stays consistent with its
      // siblings; fall back to the template prompt for pre-rewrite rows.
      const retryPrompt = claimed.prompt?.trim() || null;
      try {
        await tasks.trigger<typeof generateStaticAdVariantTask>(
          "generate-static-ad-variant",
          {
            generationId: claimed.generationId,
            organizationId: ctx.organizationId,
            variantIndex: claimed.index,
            basePrompt:
              retryPrompt ??
              buildPrompt({
                brief: claimed.brief,
                angle: claimed.angle,
                persona: claimed.persona,
                awarenessLevel: claimed.awarenessLevel,
                format: claimed.format as StudioFormat,
                brand,
              }),
            artDirection: retryPrompt
              ? null
              : artDirectionFor(
                  claimed.index,
                  claimed.count,
                  layoutReferenceUrls.length > 0,
                ),
            format: claimed.format as StudioFormat,
            referenceImageUrls: retryReferenceImageUrls,
            finalizeGeneration: true,
          },
        );
      } catch (error) {
        await db
          .update(studioVariants)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(studioVariants.id, claimed.id));
        await finalizeStudioGenerationIfSettled(claimed.generationId, ctx.organizationId);
        throw error;
      }
      return { ok: true };
    }),
} satisfies TRPCRouterRecord;
