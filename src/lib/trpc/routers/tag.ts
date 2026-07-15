import { z } from "zod";
import { eq, and, ilike, desc } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { tags, entityTags } from "@/schema/tag";

const entityTypeSchema = z.enum([
  "ad_creative",
  "campaign",
  "ad_set",
  "ad",
]);

const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
});

export const tagRouter = router({
  search: orgProcedure
    .meta(openApiQueryMeta("tag", "search"))
    .input(z.object({ query: z.string().optional() }).optional())
    .output(z.array(tagSchema))
    .query(async ({ input, ctx }) => {
      if (input?.query) {
        return db
          .select()
          .from(tags)
          .where(and(ilike(tags.name, `%${input.query}%`), eq(tags.organizationId, ctx.organizationId)))
          .orderBy(desc(tags.createdAt))
          .limit(20);
      }
      return db
        .select()
        .from(tags)
        .where(eq(tags.organizationId, ctx.organizationId))
        .orderBy(desc(tags.createdAt))
        .limit(50);
    }),

  listForEntity: orgProcedure
    .meta(openApiQueryMeta("tag", "listForEntity"))
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string(),
      }),
    )
    .output(z.array(tagSchema))
    .query(async ({ input, ctx }) => {
      const rows = await db
        .select({ tag: tags, entityTag: entityTags })
        .from(entityTags)
        .innerJoin(tags, eq(entityTags.tagId, tags.id))
        .where(
          and(
            eq(entityTags.entityType, input.entityType),
            eq(entityTags.entityId, input.entityId),
            eq(entityTags.organizationId, ctx.organizationId),
          ),
        );
      return rows.map((r) => r.tag);
    }),

  attach: orgWriteProcedure
    .meta(openApiMutationMeta("tag", "attach"))
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string(),
        tagName: z.string().min(1),
        tagColor: z.string().optional(),
      }),
    )
    .output(tagSchema)
    .mutation(async ({ input, ctx }) => {
      // Find or create tag
      let [tag] = await db
        .select()
        .from(tags)
        .where(and(eq(tags.name, input.tagName), eq(tags.organizationId, ctx.organizationId)));

      if (!tag) {
        [tag] = await db
          .insert(tags)
          .values({
            name: input.tagName,
            color: input.tagColor,
            organizationId: ctx.organizationId,
          })
          .returning();
      }

      // Check if already attached
      const [existing] = await db
        .select()
        .from(entityTags)
        .where(
          and(
            eq(entityTags.entityType, input.entityType),
            eq(entityTags.entityId, input.entityId),
            eq(entityTags.tagId, tag.id),
            eq(entityTags.organizationId, ctx.organizationId),
          ),
        );

      if (!existing) {
        await db.insert(entityTags).values({
          entityType: input.entityType,
          entityId: input.entityId,
          tagId: tag.id,
          organizationId: ctx.organizationId,
        });
      }

      return tag;
    }),

  detach: orgWriteProcedure
    .meta(openApiMutationMeta("tag", "detach"))
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string(),
        tagId: z.string(),
      }),
    )
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(entityTags)
        .where(
          and(
            eq(entityTags.entityType, input.entityType),
            eq(entityTags.entityId, input.entityId),
            eq(entityTags.tagId, input.tagId),
            eq(entityTags.organizationId, ctx.organizationId),
          ),
        );
    }),
});
