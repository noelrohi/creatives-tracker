import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { router, publicProcedure } from "../init";
import { db } from "@/db";
import { todo } from "@/schema/todo";

export const todoRouter = router({
  list: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(({ input }) => {
      return db.select().from(todo).where(eq(todo.userId, input.userId));
    }),

  create: publicProcedure
    .input(z.object({ title: z.string().min(1), userId: z.string() }))
    .mutation(({ input }) => {
      return db.insert(todo).values(input).returning();
    }),

  toggle: publicProcedure
    .input(z.object({ id: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      const [existing] = await db
        .select({ completed: todo.completed })
        .from(todo)
        .where(and(eq(todo.id, input.id), eq(todo.userId, input.userId)));
      if (!existing) throw new Error("Todo not found");
      return db
        .update(todo)
        .set({ completed: !existing.completed })
        .where(eq(todo.id, input.id))
        .returning();
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string(), userId: z.string() }))
    .mutation(({ input }) => {
      return db
        .delete(todo)
        .where(and(eq(todo.id, input.id), eq(todo.userId, input.userId)))
        .returning();
    }),
});
