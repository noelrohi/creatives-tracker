import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { landingPages, landingPageVersions } from "@/schema/landing-page";

export const landingPageRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.select().from(landingPages).where(eq(landingPages.organizationId, ctx.organizationId)).orderBy(desc(landingPages.createdAt));
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [page] = await db
        .select()
        .from(landingPages)
        .where(and(eq(landingPages.id, input.id), eq(landingPages.organizationId, ctx.organizationId)));
      if (!page) throw new Error("Landing page not found");

      const versions = await db
        .select()
        .from(landingPageVersions)
        .where(and(eq(landingPageVersions.landingPageId, input.id), eq(landingPageVersions.organizationId, ctx.organizationId)))
        .orderBy(desc(landingPageVersions.version));

      return { ...page, versions };
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().optional(),
        url: z.string().optional(),
      }).optional(),
    )
    .mutation(async ({ input, ctx }) => {
      const [page] = await db
        .insert(landingPages)
        .values({
          name: input?.name || "Untitled Landing Page",
          url: input?.url || "",
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
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
        createdBy: ctx.session.user.id,
        organizationId: ctx.organizationId,
      });

      return page;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        url: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [page] = await db
        .update(landingPages)
        .set(data)
        .where(and(eq(landingPages.id, id), eq(landingPages.organizationId, ctx.organizationId)))
        .returning();
      return page;
    }),

  duplicate: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(landingPages)
        .where(and(eq(landingPages.id, input.id), eq(landingPages.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Landing page not found");
      const [duplicate] = await db
        .insert(landingPages)
        .values({
          name: `Copy of ${source.name}`,
          url: source.url,
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
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
        createdBy: ctx.session.user.id,
        organizationId: ctx.organizationId,
      });
      return duplicate;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db.delete(landingPages).where(and(eq(landingPages.id, input.id), eq(landingPages.organizationId, ctx.organizationId)));
    }),

  createVersion: protectedProcedure
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
    .mutation(async ({ input, ctx }) => {
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
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return version;
    }),

  duplicateVersion: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(landingPageVersions)
        .where(
          and(
            eq(landingPageVersions.id, input.id),
            eq(landingPageVersions.organizationId, ctx.organizationId),
          ),
        );
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
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  listVersions: protectedProcedure
    .input(z.object({ landingPageId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select()
        .from(landingPageVersions)
        .where(and(eq(landingPageVersions.landingPageId, input.landingPageId), eq(landingPageVersions.organizationId, ctx.organizationId)))
        .orderBy(desc(landingPageVersions.version));
    }),

  updateVersion: protectedProcedure
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
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [version] = await db
        .update(landingPageVersions)
        .set(data)
        .where(
          and(
            eq(landingPageVersions.id, id),
            eq(landingPageVersions.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      return version;
    }),

  deleteVersion: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(landingPageVersions)
        .where(
          and(
            eq(landingPageVersions.id, input.id),
            eq(landingPageVersions.organizationId, ctx.organizationId),
          ),
        );
    }),
});
