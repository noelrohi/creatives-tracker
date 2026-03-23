import { initTRPC } from "@trpc/server";
import superjson from "superjson";

export async function createContext() {
  return {};
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const baseProcedure = t.procedure;
