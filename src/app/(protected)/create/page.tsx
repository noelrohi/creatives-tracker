"use client";

import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { CreateComposer } from "./create-composer";
import { CreateStarters } from "./create-starters";
import { CreateFeed } from "./create-feed";
import type { AwarenessLevel, Generation, Starter } from "./create-types";

export default function CreatePage() {
  const trpc = useTRPC();
  const [brief, setBrief] = useState("");
  const [angle, setAngle] = useState<string | undefined>(undefined);
  const [persona, setPersona] = useState<string | undefined>(undefined);
  const [awarenessLevel, setAwarenessLevel] = useState<AwarenessLevel | undefined>(
    undefined,
  );
  const [count, setCount] = useState(3);
  const [generations, setGenerations] = useState<Generation[]>([]);

  const generate = useMutation(
    trpc.create.generate.mutationOptions({
      onSuccess: (data, variables) => {
        setGenerations((prev) => [
          ...prev,
          {
            runId: data.runId,
            accessToken: data.publicAccessToken,
            brief: variables.brief,
            angle: variables.angle,
            count: variables.count ?? count,
          },
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const submit = useCallback(() => {
    const trimmed = brief.trim();
    if (!trimmed || generate.isPending) return;
    generate.mutate({ brief: trimmed, angle, persona, awarenessLevel, count });
    setBrief("");
    setAngle(undefined);
    setPersona(undefined);
    setAwarenessLevel(undefined);
  }, [brief, angle, persona, awarenessLevel, count, generate]);

  const applyStarter = useCallback((starter: Starter) => {
    setBrief(starter.brief);
    setAngle(starter.angle);
    setPersona(starter.persona);
    setAwarenessLevel(starter.awarenessLevel);
  }, []);

  const redo = useCallback(
    (generation: Generation) => {
      generate.mutate({
        brief: generation.brief,
        angle: generation.angle,
        count: generation.count,
      });
    },
    [generate],
  );

  if (generations.length === 0) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          What are we <span className="text-primary">launching</span> today?
        </h1>
        <CreateComposer
          value={brief}
          onChange={setBrief}
          onSubmit={submit}
          pending={generate.isPending}
          count={count}
          onCountChange={setCount}
          activeAngle={angle}
          autoFocus
        />
        <CreateStarters onPick={applyStarter} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      <CreateFeed generations={generations} onRedo={redo} />
      <div className="shrink-0 pt-2">
        <CreateComposer
          value={brief}
          onChange={setBrief}
          onSubmit={submit}
          pending={generate.isPending}
          count={count}
          onCountChange={setCount}
          activeAngle={angle}
        />
      </div>
    </div>
  );
}
