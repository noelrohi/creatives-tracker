import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { auth } from "@/lib/auth";
import type { Session } from "@/lib/auth";

export async function createContext(opts: { req: Request }) {
  const session = await auth.api.getSession({ headers: opts.req.headers });
  return { session };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Requires auth but does NOT require an active organization
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: { session: ctx.session as Session },
  });
});

// Requires auth AND an active organization — use for all data queries
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const orgId = ctx.session.session.activeOrganizationId;
  if (!orgId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No active organization. Please create or join a workspace.",
    });
  }

  return next({
    ctx: {
      session: ctx.session as Session,
      organizationId: orgId,
    },
  });
});
