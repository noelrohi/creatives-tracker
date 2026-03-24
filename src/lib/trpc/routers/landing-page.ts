import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { landingPages, landingPageVersions } from "@/schema/landing-page";

export const landingPageRouter = router({
  list: baseProcedure
    .meta(openApiQueryMeta("landingPage", "list"))
    .query(async () => {
    return db.select().from(landingPages).orderBy(desc(landingPages.createdAt));
  }),

  getById: baseProcedure
    .meta(openApiQueryMeta("landingPage", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [page] = await db
        .select()
        .from(landingPages)
        .where(eq(landingPages.id, input.id));
      if (!page) throw new Error("Landing page not found");

      const versions = await db
        .select()
        .from(landingPageVersions)
        .where(eq(landingPageVersions.landingPageId, input.id))
        .orderBy(desc(landingPageVersions.version));

      return { ...page, versions };
    }),

  create: baseProcedure
    .meta(openApiMutationMeta("landingPage", "create"))
    .input(
      z.object({
        name: z.string().optional(),
        url: z.string().optional(),
      }).optional(),
    )
    .mutation(async ({ input }) => {
      const [page] = await db
        .insert(landingPages)
        .values({
          name: input?.name || "Untitled Landing Page",
          url: input?.url || "",
        })
        .returning();

      // Auto-create v1
      await db.insert(landingPageVersions).values({
        landingPageId: page.id,
        version: 1,
        url: input?.url || "",
        pageType: "product_page",
        heroCopy: "",
        benefits: [],
        socialProofType: [],
        funnelPosition: "cold_traffic_entry",
      });

      return page;
    }),

  update: baseProcedure
    .meta(openApiMutationMeta("landingPage", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        url: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [page] = await db
        .update(landingPages)
        .set(data)
        .where(eq(landingPages.id, id))
        .returning();
      return page;
    }),

  duplicate: baseProcedure
    .meta(openApiMutationMeta("landingPage", "duplicate"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(landingPages)
        .where(eq(landingPages.id, input.id));
      if (!source) throw new Error("Landing page not found");
      const [duplicate] = await db
        .insert(landingPages)
        .values({
          name: `Copy of ${source.name}`,
          url: source.url,
        })
        .returning();
      // Auto-create v1 for the duplicate (per spec: no version duplication)
      await db.insert(landingPageVersions).values({
        landingPageId: duplicate.id,
        version: 1,
        url: source.url,
        pageType: "product_page",
        heroCopy: "",
        benefits: [],
        socialProofType: [],
        funnelPosition: "cold_traffic_entry",
      });
      return duplicate;
    }),

  delete: baseProcedure
    .meta(openApiMutationMeta("landingPage", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(landingPages).where(eq(landingPages.id, input.id));
    }),

  createVersion: baseProcedure
    .meta(openApiMutationMeta("landingPage", "createVersion"))
    .input(
      z.object({
        landingPageId: z.string(),
        url: z.string().optional(),
        screenshotUrl: z.string().optional(),
        pageType: z.enum([
          "product_page",
          "advertorial",
          "listicle",
          "quiz",
          "other",
        ]),
        heroCopy: z.string().min(1),
        benefits: z.array(z.string()),
        socialProofType: z.array(z.string()),
        funnelPosition: z.enum(["cold_traffic_entry", "retarget", "upsell"]),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Get the next version number
      const [latest] = await db
        .select({ version: landingPageVersions.version })
        .from(landingPageVersions)
        .where(
          eq(landingPageVersions.landingPageId, input.landingPageId),
        )
        .orderBy(desc(landingPageVersions.version))
        .limit(1);

      const nextVersion = (latest?.version ?? 0) + 1;

      const [version] = await db
        .insert(landingPageVersions)
        .values({
          ...input,
          version: nextVersion,
        })
        .returning();
      return version;
    }),

  duplicateVersion: baseProcedure
    .meta(openApiMutationMeta("landingPage", "duplicateVersion"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(landingPageVersions)
        .where(eq(landingPageVersions.id, input.id));
      if (!source) throw new Error("Version not found");

      const [latest] = await db
        .select({ version: landingPageVersions.version })
        .from(landingPageVersions)
        .where(eq(landingPageVersions.landingPageId, source.landingPageId))
        .orderBy(desc(landingPageVersions.version))
        .limit(1);

      const nextVersion = (latest?.version ?? 0) + 1;

      const [duplicate] = await db
        .insert(landingPageVersions)
        .values({
          landingPageId: source.landingPageId,
          version: nextVersion,
          url: source.url,
          screenshotUrl: source.screenshotUrl,
          pageType: source.pageType,
          heroCopy: source.heroCopy,
          benefits: source.benefits,
          socialProofType: source.socialProofType,
          funnelPosition: source.funnelPosition,
          notes: source.notes,
        })
        .returning();
      return duplicate;
    }),

  listVersions: baseProcedure
    .meta(openApiQueryMeta("landingPage", "listVersions"))
    .input(z.object({ landingPageId: z.string() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(landingPageVersions)
        .where(eq(landingPageVersions.landingPageId, input.landingPageId))
        .orderBy(desc(landingPageVersions.version));
    }),

  updateVersion: baseProcedure
    .meta(openApiMutationMeta("landingPage", "updateVersion"))
    .input(
      z.object({
        id: z.string(),
        url: z.string().nullable().optional(),
        screenshotUrl: z.string().nullable().optional(),
        pageType: z
          .enum(["product_page", "advertorial", "listicle", "quiz", "other"])
          .optional(),
        heroCopy: z.string().min(1).optional(),
        benefits: z.array(z.string()).optional(),
        socialProofType: z.array(z.string()).optional(),
        funnelPosition: z
          .enum(["cold_traffic_entry", "retarget", "upsell"])
          .optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [version] = await db
        .update(landingPageVersions)
        .set(data)
        .where(eq(landingPageVersions.id, id))
        .returning();
      return version;
    }),

  deleteVersion: baseProcedure
    .meta(openApiMutationMeta("landingPage", "deleteVersion"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(landingPageVersions)
        .where(eq(landingPageVersions.id, input.id));
    }),
});
