import { z } from "zod";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { del } from "@vercel/blob";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { studioSuggestions, studioSwipes, studioTaxonomyValues } from "@/schema/studio";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import { buildRebrandPrompt } from "@/lib/studio-prompt";
import {
  openApiMutationMeta,
  openApiQueryMeta,
} from "../openapi-meta";
import type { analyzeStudioSwipeTask } from "../../../../trigger/generate-studio-suggestions";
import {
  createStudioGeneration,
  normalizeOptionalUrl,
  persistedSwipeImageUrlSchema,
  requireCopyPackage,
  requireTaxonomyValue,
  studioFormatSchema,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

const suggestionElementOutputSchema = z.object({
  action: z.enum(["keep", "change"]),
  value: z.string().nullable().optional(),
});

// Core keys are optional on output: elements is a nullable jsonb column and
// legacy/partial analyses may predate the full slot set.
const suggestionElementsOutputSchema = z.object({
  headline: suggestionElementOutputSchema.nullable().optional(),
  heroImage: suggestionElementOutputSchema.nullable().optional(),
  background: suggestionElementOutputSchema.nullable().optional(),
  offer: suggestionElementOutputSchema.nullable().optional(),
  cta: suggestionElementOutputSchema.nullable().optional(),
  brandMarks: suggestionElementOutputSchema.nullable().optional(),
  product: suggestionElementOutputSchema.nullable().optional(),
  copy: suggestionElementOutputSchema.nullable().optional(),
  socialProof: suggestionElementOutputSchema.nullable().optional(),
  priceFraming: suggestionElementOutputSchema.nullable().optional(),
});

const taxonomyValueOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  kind: z.string(),
  name: z.string(),
  slug: z.string(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const swipeOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  imageUrl: z.string(),
  imageHash: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  brandName: z.string().nullable(),
  angleId: z.string().nullable(),
  hookTypeId: z.string().nullable(),
  visualStyleId: z.string().nullable(),
  whyItWorks: z.string().nullable(),
  elements: suggestionElementsOutputSchema.nullable(),
  addedBy: z.string().nullable(),
  archivedAt: z.date().nullable(),
  lastTriedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const duplicateImageOutputSchema = z.object({
  id: z.string(),
  brandName: z.string().nullable(),
  createdAt: z.date(),
});

export const studioSwipeProcedures = {
  swipes: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "swipes",
        "List saved swipes",
        "List saved swipe references with their message, concept, and hook-type taxonomy records. Filter by tags or search text; archived swipes are omitted unless requested.",
      ),
    )
    .input(
      z.object({
        includeArchived: z.boolean().default(false),
        angleIds: z.array(z.string()).optional(),
        visualStyleIds: z.array(z.string()).optional(),
        hookTypeIds: z.array(z.string()).optional(),
        q: z.string().trim().max(200).optional(),
      }).optional(),
    )
    .output(
      z.array(
        swipeOutputSchema.extend({
          angle: taxonomyValueOutputSchema.nullable(),
          hookType: taxonomyValueOutputSchema.nullable(),
          visualStyle: taxonomyValueOutputSchema.nullable(),
        }),
      ),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(studioSwipes.organizationId, ctx.organizationId)];
      if (!input?.includeArchived) conditions.push(isNull(studioSwipes.archivedAt));
      if (input?.angleIds?.length) {
        conditions.push(inArray(studioSwipes.angleId, input.angleIds));
      }
      if (input?.visualStyleIds?.length) {
        conditions.push(inArray(studioSwipes.visualStyleId, input.visualStyleIds));
      }
      if (input?.hookTypeIds?.length) {
        conditions.push(inArray(studioSwipes.hookTypeId, input.hookTypeIds));
      }
      const q = input?.q?.trim();
      let rank: ReturnType<typeof sql<number>> | undefined;
      if (q) {
        const contains = `%${q}%`;
        if (q.length < 3) {
          conditions.push(
            or(
              ilike(studioSwipes.brandName, contains),
              ilike(studioSwipes.whyItWorks, contains),
            )!,
          );
        } else {
          conditions.push(
            or(
              sql`${studioSwipes.brandName} % ${q}`,
              sql`${studioSwipes.whyItWorks} % ${q}`,
            )!,
          );
          rank = sql<number>`GREATEST(similarity(${studioSwipes.brandName}, ${q}), similarity(${studioSwipes.whyItWorks}, ${q}))`;
        }
      }
      const swipeQuery = db
        .select()
        .from(studioSwipes)
        .where(and(...conditions))
        .orderBy(...(rank ? [desc(rank), desc(studioSwipes.createdAt)] : [desc(studioSwipes.createdAt)]))
        .limit(60);
      const [rows, taxonomy] = await Promise.all([
        swipeQuery,
        db
          .select()
          .from(studioTaxonomyValues)
          .where(eq(studioTaxonomyValues.organizationId, ctx.organizationId)),
      ]);
      const byId = new Map(taxonomy.map((value) => [value.id, value]));
      return rows.map((swipe) => ({
        ...swipe,
        angle: swipe.angleId ? byId.get(swipe.angleId) ?? null : null,
        hookType: swipe.hookTypeId ? byId.get(swipe.hookTypeId) ?? null : null,
        visualStyle: swipe.visualStyleId
          ? byId.get(swipe.visualStyleId) ?? null
          : null,
      }));
    }),

  /**
   * Poll seam for freshly pasted swipes: analyze-studio-swipe fills
   * hookTypeId asynchronously, after createSwipe has already responded.
   */
  swipeAnalyses: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "swipeAnalyses",
        "Poll swipe analyses",
        "Poll hook-type assignments produced asynchronously by the vision analysis that runs after swipe creation.",
      ),
    )
    .input(z.object({ ids: z.array(z.string()).min(1).max(20) }))
    .output(
      z.array(
        z.object({ id: z.string(), hookTypeId: z.string().nullable() }),
      ),
    )
    .query(({ input, ctx }) =>
      db
        .select({ id: studioSwipes.id, hookTypeId: studioSwipes.hookTypeId })
        .from(studioSwipes)
        .where(
          and(
            eq(studioSwipes.organizationId, ctx.organizationId),
            inArray(studioSwipes.id, input.ids),
          ),
        ),
    ),

  createSwipe: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "createSwipe",
        "Save a swipe",
        "Save an uploaded swipe and automatically trigger vision analysis; tags are optional and can be added later. imageUrl must come from POST /api/upload, which returns { url, hash }; pass url as imageUrl and hash as imageHash. A matching sourceUrl hard-returns the existing swipe with duplicate true, while a matching imageHash only returns a duplicateImage warning.",
      ),
    )
    .input(
      z.object({
        imageUrl: persistedSwipeImageUrlSchema,
        imageHash: z.string().regex(/^[a-f\d]{64}$/i, "Invalid SHA-256 hash").optional(),
        sourceUrl: z.string().url().optional().or(z.literal("")),
        brandName: z.string().trim().max(100).optional(),
        angleId: z.string().optional(),
        visualStyleId: z.string().optional(),
        whyItWorks: z.string().trim().max(1000).optional(),
      }),
    )
    .output(
      z.object({
        swipe: swipeOutputSchema,
        duplicate: z.boolean(),
        duplicateImage: duplicateImageOutputSchema.nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await Promise.all([
        requireTaxonomyValue(ctx.organizationId, input.angleId, "message"),
        requireTaxonomyValue(
          ctx.organizationId,
          input.visualStyleId,
          "concept",
        ),
      ]);
      const [duplicateImage] = input.imageHash
        ? await db
            .select({
              id: studioSwipes.id,
              brandName: studioSwipes.brandName,
              createdAt: studioSwipes.createdAt,
            })
            .from(studioSwipes)
            .where(
              and(
                eq(studioSwipes.organizationId, ctx.organizationId),
                eq(studioSwipes.imageHash, input.imageHash.toLowerCase()),
                isNull(studioSwipes.archivedAt),
              ),
            )
            .limit(1)
        : [];
      const sourceUrl = normalizeOptionalUrl(input.sourceUrl);
      if (sourceUrl) {
        const [existing] = await db
          .select()
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, ctx.organizationId),
              eq(studioSwipes.sourceUrl, sourceUrl),
            ),
          )
          .limit(1);
        if (existing) {
          return {
            swipe: existing,
            duplicate: true as const,
            duplicateImage: duplicateImage ?? null,
          };
        }
      }
      const [swipe] = await db
        .insert(studioSwipes)
        .values({
          organizationId: ctx.organizationId,
          imageUrl: input.imageUrl,
          imageHash: input.imageHash?.toLowerCase(),
          sourceUrl,
          brandName: input.brandName || null,
          angleId: input.angleId ?? null,
          visualStyleId: input.visualStyleId ?? null,
          whyItWorks: input.whyItWorks || null,
          addedBy: ctx.userId,
        })
        .onConflictDoNothing({
          target: [studioSwipes.organizationId, studioSwipes.sourceUrl],
        })
        .returning();
      if (!swipe && sourceUrl) {
        const [existing] = await db
          .select()
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, ctx.organizationId),
              eq(studioSwipes.sourceUrl, sourceUrl),
            ),
          )
          .limit(1);
        if (existing) {
          return {
            swipe: existing,
            duplicate: true as const,
            duplicateImage: duplicateImage ?? null,
          };
        }
      }
      if (!swipe) {
        throw new TRPCError({ code: "CONFLICT", message: "Swipe could not be saved" });
      }
      await tasks
        .trigger<typeof analyzeStudioSwipeTask>("analyze-studio-swipe", {
          organizationId: ctx.organizationId,
          swipeId: swipe.id,
          imageUrl: swipe.imageUrl,
        })
        .catch(() => undefined);
      return {
        swipe,
        duplicate: false as const,
        duplicateImage: duplicateImage ?? null,
      };
    }),

  updateSwipe: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "updateSwipe",
        "Update a swipe",
        "Update swipe metadata and optional message, concept, or hook-type tags. Source URLs remain unique within the organization.",
      ),
    )
    .input(
      z.object({
        id: z.string(),
        sourceUrl: z.string().url().nullable().optional().or(z.literal("")),
        brandName: z.string().trim().max(100).nullable().optional(),
        angleId: z.string().nullable().optional(),
        hookTypeId: z.string().nullable().optional(),
        visualStyleId: z.string().nullable().optional(),
        whyItWorks: z.string().trim().max(1000).nullable().optional(),
      }),
    )
    .output(swipeOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, sourceUrl, ...values } = input;
      await Promise.all([
        requireTaxonomyValue(ctx.organizationId, values.angleId, "message"),
        requireTaxonomyValue(
          ctx.organizationId,
          values.visualStyleId,
          "concept",
        ),
        requireTaxonomyValue(ctx.organizationId, values.hookTypeId, "hook_type"),
      ]);
      const nextSourceUrl =
        sourceUrl === undefined ? undefined : normalizeOptionalUrl(sourceUrl);
      if (nextSourceUrl) {
        const [existing] = await db
          .select({ id: studioSwipes.id })
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, ctx.organizationId),
              eq(studioSwipes.sourceUrl, nextSourceUrl),
            ),
          )
          .limit(1);
        if (existing && existing.id !== id) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This source URL is already saved on another swipe",
          });
        }
      }
      const [swipe] = await db
        .update(studioSwipes)
        .set({
          ...values,
          sourceUrl: nextSourceUrl,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioSwipes.id, id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!swipe) throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
      return swipe;
    }),

  archiveSwipe: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "archiveSwipe",
        "Archive a swipe",
        "Archive or restore a swipe reference. Archived swipes are hidden from the default swipe list without deleting their history.",
      ),
    )
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
    .output(swipeOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const [swipe] = await db
        .update(studioSwipes)
        .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
        .where(
          and(
            eq(studioSwipes.id, input.id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!swipe) throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
      return swipe;
    }),

  deleteSwipe: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "deleteSwipe",
        "Delete a swipe",
        "Permanently delete an organization swipe and attempt to remove its uploaded blob when deletion succeeds.",
      ),
    )
    .input(z.object({ id: z.string() }))
    .output(z.object({ deleted: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const [existing] = await db
        .select({ imageUrl: studioSwipes.imageUrl })
        .from(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, input.id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      const deleted = await db
        .delete(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, input.id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: studioSwipes.id });
      if (deleted.length === 1 && existing?.imageUrl) {
        await del(existing.imageUrl).catch(() => undefined);
      }
      return { deleted: deleted.length === 1 };
    }),

  rebrandSwipe: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "rebrandSwipe",
        "Rebrand a swipe",
        "Rebrand an active swipe using its image and analyzed elements. Generate immediately to queue a generation, or save the idea as a proposed Studio suggestion for later action.",
      ),
    )
    .input(
      z.object({
        swipeId: z.string(),
        brief: z.string().trim().min(1),
        format: studioFormatSchema.default("square"),
        count: z.number().int().min(1).max(4).default(3),
        copyPackageId: z.string().nullable().optional(),
        mode: z.enum(["generate_now", "queue"]),
      }),
    )
    .output(
      z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("generate_now"),
          runId: z.string(),
          generationId: z.string(),
        }),
        z.object({
          mode: z.literal("queue"),
          suggestionId: z.string(),
        }),
      ]),
    )
    .mutation(async ({ input, ctx }) => {
      const [swipe] = await db
        .select()
        .from(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, input.swipeId),
            eq(studioSwipes.organizationId, ctx.organizationId),
            isNull(studioSwipes.archivedAt),
          ),
        )
        .limit(1);
      if (!swipe) throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
      await requireCopyPackage(ctx.organizationId, input.copyPackageId);
      if (input.mode === "generate_now") {
        const brand = await getStudioBrandProfile(ctx.organizationId);
        const prompt = buildRebrandPrompt({
          brief: input.brief,
          elements: swipe.elements,
          brand,
        });
        const generation = await createStudioGeneration(ctx.organizationId, {
          brief: prompt,
          count: input.count,
          format: input.format,
          referenceImageUrls: [swipe.imageUrl],
          swipeId: swipe.id,
          copyPackageId: input.copyPackageId,
        });
        await db
          .update(studioSwipes)
          .set({ lastTriedAt: new Date(), updatedAt: new Date() })
          .where(eq(studioSwipes.id, swipe.id));
        return { mode: input.mode, ...generation };
      }
      const [suggestion] = await db
        .insert(studioSuggestions)
        .values({
          organizationId: ctx.organizationId,
          swipeId: swipe.id,
          kind: "rebrand_swipe",
          title: `Rebrand${swipe.brandName ? `: ${swipe.brandName}` : " this swipe"}`,
          whyLine: swipe.whyItWorks || "Saved in your swipe file and not tried yet.",
          brief: input.brief,
          elements: swipe.elements,
          angleId: swipe.angleId,
          visualStyleId: swipe.visualStyleId,
          format: input.format,
          count: input.count,
          copyPackageId: input.copyPackageId,
          status: "proposed",
        })
        .returning();
      return { mode: input.mode, suggestionId: suggestion.id };
    }),
} satisfies TRPCRouterRecord;
