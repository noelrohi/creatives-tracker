import { z } from "zod";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { studioCopyPackages, studioTaxonomyValues } from "@/schema/studio";
import { studioSlug } from "@/lib/studio-taxonomy";
import {
  openApiMutationMeta,
  openApiQueryMeta,
} from "../openapi-meta";
import {
  requireTaxonomyValue,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

const copyPackageOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  angleId: z.string().nullable(),
  primaryText: z.string(),
  headline: z.string(),
  description: z.string(),
  sourceCreativeId: z.string().nullable(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const studioPackageProcedures = {
  copyPackages: studioProcedure
    .meta(
      openApiQueryMeta(
        "studio",
        "copyPackages",
        "List copy packages",
        "List reusable copy packages for the organization, newest first. Archived packages are omitted unless explicitly requested.",
      ),
    )
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .output(z.array(copyPackageOutputSchema))
    .query(async ({ input, ctx }) => {
      const conditions = [eq(studioCopyPackages.organizationId, ctx.organizationId)];
      if (!input?.includeArchived) conditions.push(isNull(studioCopyPackages.archivedAt));
      return db
        .select()
        .from(studioCopyPackages)
        .where(and(...conditions))
        .orderBy(desc(studioCopyPackages.createdAt));
    }),

  createCopyPackage: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "createCopyPackage",
        "Create a copy package",
        "Create a reusable primary-text, headline, and description package, optionally associated with an active angle.",
      ),
    )
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        angleId: z.string().nullable().optional(),
        primaryText: z.string().min(1),
        headline: z.string().min(1),
        description: z.string(),
      }),
    )
    .output(copyPackageOutputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireTaxonomyValue(ctx.organizationId, input.angleId, "angle");
      const [pkg] = await db
        .insert(studioCopyPackages)
        .values({ organizationId: ctx.organizationId, ...input })
        .returning();
      return pkg;
    }),

  updateCopyPackage: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "updateCopyPackage",
        "Update a copy package",
        "Update, archive, or restore an organization copy package. Any supplied angle must be an active angle taxonomy value.",
      ),
    )
    .input(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(120).optional(),
        angleId: z.string().nullable().optional(),
        primaryText: z.string().min(1).optional(),
        headline: z.string().min(1).optional(),
        description: z.string().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .output(copyPackageOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, archived, ...values } = input;
      await requireTaxonomyValue(ctx.organizationId, values.angleId, "angle");
      const [pkg] = await db
        .update(studioCopyPackages)
        .set({
          ...values,
          archivedAt: archived === undefined ? undefined : archived ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioCopyPackages.id, id),
            eq(studioCopyPackages.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!pkg) throw new TRPCError({ code: "NOT_FOUND", message: "Copy package not found" });
      return pkg;
    }),

  createCopyPackageFromCreative: studioWriteProcedure
    .meta(
      openApiMutationMeta(
        "studio",
        "createCopyPackageFromCreative",
        "Create a package from a creative",
        "Create a reusable copy package from an organization creative and its latest synced ad copy. The creative angle is reused or added to the angle taxonomy when no angle is supplied.",
      ),
    )
    .input(
      z.object({
        creativeId: z.string(),
        name: z.string().trim().min(1).max(120).optional(),
        angleId: z.string().nullable().optional(),
        primaryText: z.string().trim().min(1).optional(),
        headline: z.string().trim().min(1).optional(),
        description: z.string().optional(),
      }),
    )
    .output(copyPackageOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          angle: adCreatives.angle,
          caption: ads.caption,
        })
        .from(adCreatives)
        .leftJoin(
          ads,
          and(
            eq(ads.adCreativeId, adCreatives.id),
            eq(ads.organizationId, ctx.organizationId),
          ),
        )
        .where(
          and(
            eq(adCreatives.id, input.creativeId),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(desc(ads.updatedAt))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Creative not found" });
      await requireTaxonomyValue(ctx.organizationId, input.angleId, "angle");
      let angleId = input.angleId ?? null;
      if (!angleId && row.angle?.trim()) {
        const [angle] = await db
          .select({ id: studioTaxonomyValues.id })
          .from(studioTaxonomyValues)
          .where(
            and(
              eq(studioTaxonomyValues.organizationId, ctx.organizationId),
              eq(studioTaxonomyValues.kind, "angle"),
              eq(studioTaxonomyValues.slug, studioSlug(row.angle)),
            ),
          )
          .limit(1);
        if (angle) {
          angleId = angle.id;
        } else {
          const [createdAngle] = await db
            .insert(studioTaxonomyValues)
            .values({
              organizationId: ctx.organizationId,
              kind: "angle",
              name: row.angle.trim(),
              slug: studioSlug(row.angle),
            })
            .onConflictDoUpdate({
              target: [
                studioTaxonomyValues.organizationId,
                studioTaxonomyValues.kind,
                studioTaxonomyValues.slug,
              ],
              set: { name: row.angle.trim(), updatedAt: new Date() },
            })
            .returning({ id: studioTaxonomyValues.id });
          angleId = createdAngle?.id ?? null;
        }
      }
      const primaryText = input.primaryText ?? row.caption?.trim();
      if (!primaryText) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This creative has no synced primary text to save",
        });
      }
      const [pkg] = await db
        .insert(studioCopyPackages)
        .values({
          organizationId: ctx.organizationId,
          name: input.name ?? row.name,
          angleId,
          primaryText,
          headline: input.headline ?? row.name,
          description: input.description ?? "",
          sourceCreativeId: row.id,
        })
        .returning();
      return pkg;
    }),
} satisfies TRPCRouterRecord;
