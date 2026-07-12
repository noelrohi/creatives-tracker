"use client";

import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { StudioComposer } from "./studio-composer";
import { StudioStarters } from "./studio-starters";
import { StudioFeed } from "./studio-feed";
import type {
  AwarenessLevel,
  ComposerReference,
  Generation,
  Starter,
} from "./studio-types";

export default function StudioPage() {
  const trpc = useTRPC();
  const [brief, setBrief] = useState("");
  const [angle, setAngle] = useState<string | undefined>(undefined);
  const [persona, setPersona] = useState<string | undefined>(undefined);
  const [awarenessLevel, setAwarenessLevel] = useState<AwarenessLevel | undefined>(
    undefined,
  );
  const [count, setCount] = useState(3);
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);

  const generate = useMutation(
    trpc.studio.generate.mutationOptions({
      onSuccess: (data, variables) => {
        setGenerations((prev) => [
          ...prev,
          {
            runId: data.runId,
            accessToken: data.publicAccessToken,
            brief: variables.brief,
            angle: variables.angle,
            persona: variables.persona,
            awarenessLevel: variables.awarenessLevel,
            referenceImageUrls: variables.referenceImageUrls,
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
    generate.mutate(
      {
        brief: trimmed,
        angle,
        persona,
        awarenessLevel,
        count,
        referenceImageUrls:
          references.length > 0 ? references.map((ref) => ref.url) : undefined,
      },
      {
        onSuccess: () => {
          setBrief("");
          setAngle(undefined);
          setPersona(undefined);
          setAwarenessLevel(undefined);
          setReferences([]);
        },
      },
    );
  }, [brief, angle, persona, awarenessLevel, count, references, generate]);

  const applyStarter = useCallback((starter: Starter) => {
    setBrief(starter.brief);
    setAngle(starter.angle);
    setPersona(starter.persona);
    setAwarenessLevel(starter.awarenessLevel);
    setReferences(
      starter.imageUrl
        ? [
            {
              url: starter.imageUrl,
              label: "Winning ad",
              description: "Reference",
            },
          ]
        : [],
    );
  }, []);

  const addReference = useCallback((reference: ComposerReference) => {
    setReferences((prev) =>
      prev.some((ref) => ref.url === reference.url)
        ? prev
        : [...prev, reference].slice(0, 4),
    );
  }, []);

  const removeReference = useCallback((url: string) => {
    setReferences((prev) => prev.filter((ref) => ref.url !== url));
  }, []);

  const redo = useCallback(
    (generation: Generation) => {
      if (generate.isPending) return;
      generate.mutate({
        brief: generation.brief,
        angle: generation.angle,
        persona: generation.persona,
        awarenessLevel: generation.awarenessLevel,
        referenceImageUrls: generation.referenceImageUrls,
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
        <StudioComposer
          value={brief}
          onChange={setBrief}
          onSubmit={submit}
          pending={generate.isPending}
          count={count}
          onCountChange={setCount}
          references={references}
          onAddReference={addReference}
          onRemoveReference={removeReference}
          autoFocus
        />
        <StudioStarters onPick={applyStarter} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      <StudioFeed
        generations={generations}
        onRedo={redo}
        redoDisabled={generate.isPending}
      />
      <div className="shrink-0 pt-2">
        <StudioComposer
          value={brief}
          onChange={setBrief}
          onSubmit={submit}
          pending={generate.isPending}
          count={count}
          onCountChange={setCount}
          references={references}
          onAddReference={addReference}
          onRemoveReference={removeReference}
        />
      </div>
    </div>
  );
}
