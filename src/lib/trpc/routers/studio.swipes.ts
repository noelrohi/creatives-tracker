import { z } from "zod";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { del } from "@vercel/blob";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { studioSuggestions, studioSwipes, studioTaxonomyValues } from "@/schema/studio";
import { buildRebrandPrompt } from "@/lib/studio-prompt";
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

export const studioSwipeProcedures = {
  swipes: studioProcedure
    .input(
      z.object({
        includeArchived: z.boolean().default(false),
        angleId: z.string().optional(),
        visualStyleId: z.string().optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(studioSwipes.organizationId, ctx.organizationId)];
      if (!input?.includeArchived) conditions.push(isNull(studioSwipes.archivedAt));
      if (input?.angleId) conditions.push(eq(studioSwipes.angleId, input.angleId));
      if (input?.visualStyleId) {
        conditions.push(eq(studioSwipes.visualStyleId, input.visualStyleId));
      }
      const [rows, taxonomy] = await Promise.all([
        db.select().from(studioSwipes).where(and(...conditions)).orderBy(desc(studioSwipes.createdAt)),
        db
          .select()
          .from(studioTaxonomyValues)
          .where(eq(studioTaxonomyValues.organizationId, ctx.organizationId)),
      ]);
      const byId = new Map(taxonomy.map((value) => [value.id, value]));
      return rows.map((swipe) => ({
        ...swipe,
        angle: swipe.angleId ? byId.get(swipe.angleId) ?? null : null,
        visualStyle: swipe.visualStyleId
          ? byId.get(swipe.visualStyleId) ?? null
          : null,
      }));
    }),

  createSwipe: studioWriteProcedure
    .input(
      z.object({
        imageUrl: persistedSwipeImageUrlSchema,
        sourceUrl: z.string().url().optional().or(z.literal("")),
        brandName: z.string().trim().max(100).optional(),
        angleId: z.string().optional(),
        visualStyleId: z.string().optional(),
        whyItWorks: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await Promise.all([
        requireTaxonomyValue(ctx.organizationId, input.angleId, "angle"),
        requireTaxonomyValue(
          ctx.organizationId,
          input.visualStyleId,
          "visual_style",
        ),
      ]);
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
        if (existing) return { swipe: existing, duplicate: true as const };
      }
      const [swipe] = await db
        .insert(studioSwipes)
        .values({
          organizationId: ctx.organizationId,
          imageUrl: input.imageUrl,
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
        if (existing) return { swipe: existing, duplicate: true as const };
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
      return { swipe, duplicate: false as const };
    }),

  updateSwipe: studioWriteProcedure
    .input(
      z.object({
        id: z.string(),
        sourceUrl: z.string().url().nullable().optional().or(z.literal("")),
        brandName: z.string().trim().max(100).nullable().optional(),
        angleId: z.string().nullable().optional(),
        visualStyleId: z.string().nullable().optional(),
        whyItWorks: z.string().trim().max(1000).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, sourceUrl, ...values } = input;
      await Promise.all([
        requireTaxonomyValue(ctx.organizationId, values.angleId, "angle"),
        requireTaxonomyValue(
          ctx.organizationId,
          values.visualStyleId,
          "visual_style",
        ),
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
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
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
    .input(z.object({ id: z.string() }))
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
      const prompt = buildRebrandPrompt({ brief: input.brief, elements: swipe.elements });
      if (input.mode === "generate_now") {
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
