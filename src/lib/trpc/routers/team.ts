import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { teams } from "@/schema/team";

const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  notes: z.string().nullable(),
  organizationId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const teamRouter = router({
  list: orgProcedure
    .meta(openApiQueryMeta("team", "list"))
    .output(z.array(teamSchema))
    .query(async ({ ctx }) => {
      return db
        .select()
        .from(teams)
        .where(eq(teams.organizationId, ctx.organizationId))
        .orderBy(desc(teams.createdAt));
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("team", "getById"))
    .input(z.object({ id: z.string() }))
    .output(teamSchema)
    .query(async ({ input, ctx }) => {
      const [team] = await db
        .select()
        .from(teams)
        .where(
          and(
            eq(teams.id, input.id),
            eq(teams.organizationId, ctx.organizationId),
          ),
        );
      if (!team) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
      }
      return team;
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("team", "create"))
    .input(
      z.object({
        name: z.string().min(1),
        notes: z.string().optional(),
      }),
    )
    .output(teamSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const [team] = await db
          .insert(teams)
          .values({ ...input, organizationId: ctx.organizationId })
          .returning();
        return team;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;

        if (code === "23505") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A team with this name already exists.",
          });
        }

        throw error;
      }
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("team", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .output(teamSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      try {
        const [team] = await db
          .update(teams)
          .set(data)
          .where(
            and(
              eq(teams.id, id),
              eq(teams.organizationId, ctx.organizationId),
            ),
          )
          .returning();
        if (!team) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
        }
        return team;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;

        if (code === "23505") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A team with this name already exists.",
          });
        }

        throw error;
      }
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("team", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(teams)
        .where(
          and(
            eq(teams.id, input.id),
            eq(teams.organizationId, ctx.organizationId),
          ),
        );
    }),
});
