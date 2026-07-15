import { z } from "zod";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { studioTaxonomyValues } from "@/schema/studio";
import { studioSlug } from "@/lib/studio-taxonomy";
import {
  seedTaxonomy,
  studioProcedure,
  studioWriteProcedure,
  taxonomyKindSchema,
} from "./studio.shared";

export const studioTaxonomyProcedures = {
  taxonomies: studioProcedure.query(async ({ ctx }) => {
    await seedTaxonomy(ctx.organizationId);
    return db
      .select()
      .from(studioTaxonomyValues)
      .where(eq(studioTaxonomyValues.organizationId, ctx.organizationId))
      .orderBy(asc(studioTaxonomyValues.kind), asc(studioTaxonomyValues.name));
  }),

  addTaxonomyValue: studioWriteProcedure
    .input(
      z.object({
        kind: taxonomyKindSchema,
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .refine((name) => studioSlug(name).length > 0, "Use letters or numbers"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [value] = await db
        .insert(studioTaxonomyValues)
        .values({
          organizationId: ctx.organizationId,
          kind: input.kind,
          name: input.name,
          slug: studioSlug(input.name),
        })
        .onConflictDoUpdate({
          target: [
            studioTaxonomyValues.organizationId,
            studioTaxonomyValues.kind,
            studioTaxonomyValues.slug,
          ],
          set: { name: input.name, archivedAt: null, updatedAt: new Date() },
        })
        .returning();
      return value;
    }),

  archiveTaxonomyValue: studioWriteProcedure
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const [value] = await db
        .update(studioTaxonomyValues)
        .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
        .where(
          and(
            eq(studioTaxonomyValues.id, input.id),
            eq(studioTaxonomyValues.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!value) throw new TRPCError({ code: "NOT_FOUND", message: "Tag value not found" });
      return value;
    }),
} satisfies TRPCRouterRecord;
