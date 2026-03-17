import { initTRPC, TRPCError } from "@trpc/server";
import { auth } from "@/lib/auth";
import type { Session } from "@/lib/auth";

export async function createContext(opts: { req: Request }) {
  const session = await auth.api.getSession({ headers: opts.req.headers });
  return { session };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: { session: ctx.session as Session },
  });
});
