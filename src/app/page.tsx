"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Check, Plus, Loader2 } from "lucide-react";

const USER_ID_KEY = "todo-user-id";

export default function Home() {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  if (!userId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">
            Sign in to manage your todos.
          </p>
          <Button asChild>
            <a href="/sign-in">Sign In</a>
          </Button>
        </div>
      </div>
    );
  }

  return <TodoList userId={userId} />;
}

function TodoList({ userId }: { userId: string }) {
  const [title, setTitle] = useState("");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const todosQuery = useQuery(trpc.todo.list.queryOptions({ userId }));

  const createMutation = useMutation({
    ...trpc.todo.create.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries(trpc.todo.list.queryFilter({ userId }));
      setTitle("");
    },
  });

  const toggleMutation = useMutation({
    ...trpc.todo.toggle.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries(trpc.todo.list.queryFilter({ userId }));
    },
  });

  const deleteMutation = useMutation({
    ...trpc.todo.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries(trpc.todo.list.queryFilter({ userId }));
    },
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Todos</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          createMutation.mutate({ title: title.trim(), userId });
        }}
        className="flex gap-2"
      >
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a todo..."
          disabled={createMutation.isPending}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!title.trim() || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Plus />
          )}
        </Button>
      </form>

      {todosQuery.isLoading && (
        <div className="text-muted-foreground flex justify-center py-8">
          <Loader2 className="animate-spin" />
        </div>
      )}

      {todosQuery.data && todosQuery.data.length === 0 && (
        <p className="text-muted-foreground py-8 text-center text-sm">
          No todos yet. Add one above.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {todosQuery.data?.map((todo) => (
          <li
            key={todo.id}
            className="border-border flex items-center gap-3 rounded-lg border px-3 py-2"
          >
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => toggleMutation.mutate({ id: todo.id, userId })}
              disabled={toggleMutation.isPending}
            >
              <Check
                className={
                  todo.completed
                    ? "text-primary"
                    : "text-muted-foreground/30"
                }
              />
            </Button>
            <span
              className={`flex-1 text-sm ${todo.completed ? "text-muted-foreground line-through" : ""}`}
            >
              {todo.title}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => deleteMutation.mutate({ id: todo.id, userId })}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="text-muted-foreground" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
