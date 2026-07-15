import { z } from "zod";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { studioTaxonomyValues } from "@/schema/studio";
import { studioSlug } from "@/lib/studio-taxonomy";
import {
  openApiMutationMeta,
  openApiQueryMeta,
} from "../openapi-meta";
import {
  seedTaxonomy,
  studioProcedure,
  studioWriteProcedure,
  taxonomyKindSchema,
} from "./studio.shared";

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

export const studioTaxonomyProcedures = {
  taxonomies: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "taxonomies",
        "List taxonomy values",
        "List angle, visual_style, and hook_type values for the organization. Archived values remain available for historical records but are hidden from active pickers.",
      ),
    )
    .output(z.array(taxonomyValueOutputSchema))
    .query(async ({ ctx }) => {
    await seedTaxonomy(ctx.organizationId);
    return db
      .select()
      .from(studioTaxonomyValues)
      .where(eq(studioTaxonomyValues.organizationId, ctx.organizationId))
      .orderBy(asc(studioTaxonomyValues.kind), asc(studioTaxonomyValues.name));
  }),

  addTaxonomyValue: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "addTaxonomyValue",
        "Add a taxonomy value",
        "Add or restore an angle, visual_style, or hook_type value for use in Studio pickers.",
      ),
    )
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
    .output(taxonomyValueOutputSchema)
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
    .meta(
      openApiMutationMeta(
        "studio",
        "archiveTaxonomyValue",
        "Archive a taxonomy value",
        "Archive or restore a taxonomy value. Archiving hides it from active pickers while preserving references in historical Studio records.",
      ),
    )
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
    .output(taxonomyValueOutputSchema)
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
