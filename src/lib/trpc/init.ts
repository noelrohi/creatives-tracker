import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { OpenApiMeta } from "./openapi-meta";

export async function createContext() {
  return {};
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().meta<OpenApiMeta>().create({
  transformer: superjson,
});

export const router = t.router;
export const baseProcedure = t.procedure;
