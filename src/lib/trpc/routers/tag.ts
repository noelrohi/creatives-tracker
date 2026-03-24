import { z } from "zod";
import { eq, and, ilike, desc } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { tags, entityTags } from "@/schema/tag";

const entityTypeSchema = z.enum([
  "ad_creative",
  "landing_page",
  "campaign",
  "ad_set",
  "ad",
]);

export const tagRouter = router({
  search: baseProcedure
    .meta(openApiQueryMeta("tag", "search"))
    .input(z.object({ query: z.string().optional() }).optional())
    .query(async ({ input }) => {
      if (input?.query) {
        return db
          .select()
          .from(tags)
          .where(ilike(tags.name, `%${input.query}%`))
          .orderBy(desc(tags.createdAt))
          .limit(20);
      }
      return db
        .select()
        .from(tags)
        .orderBy(desc(tags.createdAt))
        .limit(50);
    }),

  listForEntity: baseProcedure
    .meta(openApiQueryMeta("tag", "listForEntity"))
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const rows = await db
        .select({ tag: tags, entityTag: entityTags })
        .from(entityTags)
        .innerJoin(tags, eq(entityTags.tagId, tags.id))
        .where(
          and(
            eq(entityTags.entityType, input.entityType),
            eq(entityTags.entityId, input.entityId),
          ),
        );
      return rows.map((r) => r.tag);
    }),

  attach: baseProcedure
    .meta(openApiMutationMeta("tag", "attach"))
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string(),
        tagName: z.string().min(1),
        tagColor: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Find or create tag
      let [tag] = await db
        .select()
        .from(tags)
        .where(eq(tags.name, input.tagName));

      if (!tag) {
        [tag] = await db
          .insert(tags)
          .values({
            name: input.tagName,
            color: input.tagColor,
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
          ),
        );

      if (!existing) {
        await db.insert(entityTags).values({
          entityType: input.entityType,
          entityId: input.entityId,
          tagId: tag.id,
        });
      }

      return tag;
    }),

  detach: baseProcedure
    .meta(openApiMutationMeta("tag", "detach"))
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string(),
        tagId: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      await db
        .delete(entityTags)
        .where(
          and(
            eq(entityTags.entityType, input.entityType),
            eq(entityTags.entityId, input.entityId),
            eq(entityTags.tagId, input.tagId),
          ),
        );
    }),
});
