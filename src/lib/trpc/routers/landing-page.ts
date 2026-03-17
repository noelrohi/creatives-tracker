import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { landingPages, landingPageVersions } from "@/schema/landing-page";

export const landingPageRouter = router({
  list: protectedProcedure.query(async () => {
    return db.select().from(landingPages).orderBy(desc(landingPages.createdAt));
  }),

  getById: protectedProcedure
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

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        url: z.string().url(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [page] = await db
        .insert(landingPages)
        .values({ ...input, createdBy: ctx.session.user.id })
        .returning();
      return page;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        url: z.string().url().optional(),
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

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(landingPages).where(eq(landingPages.id, input.id));
    }),

  createVersion: protectedProcedure
    .input(
      z.object({
        landingPageId: z.string(),
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
        })
        .returning();
      return version;
    }),

  listVersions: protectedProcedure
    .input(z.object({ landingPageId: z.string() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(landingPageVersions)
        .where(eq(landingPageVersions.landingPageId, input.landingPageId))
        .orderBy(desc(landingPageVersions.version));
    }),
});
