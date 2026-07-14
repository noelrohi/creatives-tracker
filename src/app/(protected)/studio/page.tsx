"use client";

import { Suspense, useEffect, useState } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { StudioComposer } from "./studio-composer";
import { StudioStarters } from "./studio-starters";
import { StudioFeed } from "./studio-feed";
import type {
  AwarenessLevel,
  ComposerReference,
  Generation,
  GenerationPrefill,
  Starter,
  StudioFormat,
} from "./studio-types";

function appendReference(
  reference: ComposerReference,
  setReferences: React.Dispatch<React.SetStateAction<ComposerReference[]>>,
) {
  setReferences((previous) =>
    previous.some((item) => item.url === reference.url)
      ? previous
      : [...previous, reference].slice(0, 4),
  );
}

function StudioPageContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [remixId, setRemixId] = useQueryState("remix", parseAsString);
  const [suggestionId, setSuggestionId] = useQueryState(
    "suggestion",
    parseAsString,
  );
  const [referenceUrl, setReferenceUrl] = useQueryState("ref", parseAsString);
  const [brief, setBrief] = useState("");
  const [angle, setAngle] = useState<string | undefined>();
  const [persona, setPersona] = useState<string | undefined>();
  const [awarenessLevel, setAwarenessLevel] = useState<AwarenessLevel | undefined>();
  const [count, setCount] = useState(3);
  const [format, setFormat] = useState<StudioFormat>("square");
  // Seeded from the ?ref= entry point (e.g. "use as reference" on the detail page).
  const [references, setReferences] = useState<ComposerReference[]>(() =>
    referenceUrl ? [{ url: referenceUrl, label: "Reference" }] : [],
  );
  const [sourceCreativeId, setSourceCreativeId] = useState<string | undefined>();
  const [sessions, setSessions] = useState<Generation[]>([]);
  const [focusToken, setFocusToken] = useState<number>();

  const historyQuery = useQuery({
    ...trpc.studio.generations.queryOptions(),
    enabled: sessions.length > 0,
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (generation) => generation.status === "generating",
      )
        ? 4000
        : false,
  });

  const generate = useMutation(
    trpc.studio.generate.mutationOptions({
      onSuccess: (data, variables) => {
        setSessions((previous) => [
          ...previous.filter((session) => session.runId !== data.runId),
          {
            generationId: data.generationId,
            runId: data.runId,
            accessToken: data.publicAccessToken,
            brief: variables.brief,
            angle: variables.angle,
            persona: variables.persona,
            awarenessLevel: variables.awarenessLevel,
            referenceImageUrls: variables.referenceImageUrls,
            count: variables.count ?? 3,
            format: (variables.format ?? "square") as StudioFormat,
            sourceCreativeId: variables.sourceCreativeId,
          },
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  useEffect(() => {
    if (referenceUrl) void setReferenceUrl(null);
  }, [referenceUrl, setReferenceUrl]);

  useEffect(() => {
    if (!remixId) return;
    let cancelled = false;
    void queryClient
      .fetchQuery(trpc.studio.remixSource.queryOptions({ creativeId: remixId }))
      .then((source) => {
        if (cancelled) return;
        if (source.assetUrl) {
          appendReference(
            { url: source.assetUrl, label: source.name },
            setReferences,
          );
        }
        setAngle(source.angle ?? undefined);
        setPersona(source.persona ?? undefined);
        setAwarenessLevel(source.awarenessLevel ?? undefined);
        setSourceCreativeId(source.id);
        setFocusToken((token) => (token ?? 0) + 1);
        void setRemixId(null);
      })
      .catch(() => {
        if (!cancelled) void setRemixId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [remixId, queryClient, trpc, setRemixId]);

  useEffect(() => {
    if (!suggestionId) return;
    let cancelled = false;
    void queryClient
      .fetchQuery(trpc.studio.suggestionPrefill.queryOptions({ variantId: suggestionId }))
      .then((suggestion) => {
        if (cancelled) return;
        setBrief(suggestion.brief);
        setAngle(suggestion.angle ?? undefined);
        setPersona(suggestion.persona ?? undefined);
        setAwarenessLevel(suggestion.awarenessLevel ?? undefined);
        setReferences(
          suggestion.imageUrl
            ? [
                {
                  url: suggestion.imageUrl,
                  label: "Winning ad",
                  description: "Reference",
                },
              ]
            : [],
        );
        setSourceCreativeId(suggestion.creativeId ?? undefined);
        setFocusToken((token) => (token ?? 0) + 1);
        void setSuggestionId(null);
      })
      .catch(() => {
        if (!cancelled) void setSuggestionId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [suggestionId, queryClient, trpc, setSuggestionId]);

  function submit() {
    const trimmed = brief.trim();
    if (!trimmed || generate.isPending) return;
    generate.mutate(
      {
        brief: trimmed,
        angle,
        persona,
        awarenessLevel,
        count,
        format,
        referenceImageUrls:
          references.length > 0
            ? references.map((reference) => reference.url)
            : undefined,
        sourceCreativeId,
      },
      {
        onSuccess: () => {
          setBrief("");
          setAngle(undefined);
          setPersona(undefined);
          setAwarenessLevel(undefined);
          setReferences([]);
          setSourceCreativeId(undefined);
        },
      },
    );
  }

  function applyStarter(starter: Starter) {
    setBrief(starter.brief);
    setAngle(starter.angle);
    setPersona(starter.persona);
    setAwarenessLevel(starter.awarenessLevel);
    setSourceCreativeId(starter.creativeId);
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
    setFocusToken((token) => (token ?? 0) + 1);
  }

  function removeReference(url: string) {
    setReferences((previous) =>
      previous.filter((reference) => reference.url !== url),
    );
    setSourceCreativeId(undefined);
  }

  function prefill(generation: GenerationPrefill) {
    setBrief(generation.brief);
    setAngle(generation.angle ?? undefined);
    setPersona(generation.persona ?? undefined);
    setAwarenessLevel(generation.awarenessLevel ?? undefined);
    setCount(generation.count);
    setFormat(generation.format);
    setReferences(
      (generation.referenceImageUrls ?? []).map((url) => ({
        url,
        label: "Reference",
      })),
    );
    setSourceCreativeId(generation.sourceCreativeId ?? undefined);
    setFocusToken((token) => (token ?? 0) + 1);
  }

  function retryLive(generation: Generation) {
    if (generate.isPending) return;
    generate.mutate({
      brief: generation.brief,
      angle: generation.angle,
      persona: generation.persona,
      awarenessLevel: generation.awarenessLevel,
      count: generation.count,
      format: generation.format,
      referenceImageUrls: generation.referenceImageUrls,
      sourceCreativeId: generation.sourceCreativeId,
    });
  }

  function useReference(url: string) {
    appendReference({ url, label: "Reference" }, setReferences);
    setSourceCreativeId(undefined);
    setFocusToken((token) => (token ?? 0) + 1);
  }

  // The create tab only shows runs from the current session (live cards that
  // swap to DB-backed cards as they finish); full history lives in /studio/library.
  const sessionRunIds = new Set(sessions.map((session) => session.runId));
  const history = (historyQuery.data ?? []).filter(
    (generation) =>
      generation.runId != null && sessionRunIds.has(generation.runId),
  );
  const hasFeed = sessions.length > 0;
  const composer = (
    <StudioComposer
      value={brief}
      onChange={setBrief}
      onSubmit={submit}
      pending={generate.isPending}
      count={count}
      onCountChange={setCount}
      format={format}
      onFormatChange={setFormat}
      references={references}
      onAddReference={(reference) => {
        appendReference(reference, setReferences);
        setSourceCreativeId(undefined);
      }}
      onRemoveReference={removeReference}
      focusToken={focusToken}
      autoFocus={!hasFeed}
    />
  );

  if (!hasFeed) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          What are we <span className="text-primary">launching</span> today?
        </h1>
        {composer}
        <StudioStarters onPick={applyStarter} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      <StudioFeed
        history={history}
        sessions={sessions}
        onRedo={prefill}
        onRetryLive={retryLive}
        onUseReference={useReference}
        retryDisabled={generate.isPending}
      />
      <div className="shrink-0 pt-2">{composer}</div>
    </div>
  );
}

export default function StudioPage() {
  return (
    <Suspense>
      <StudioPageContent />
    </Suspense>
  );
}
