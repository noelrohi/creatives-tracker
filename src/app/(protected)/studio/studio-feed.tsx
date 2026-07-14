"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { toast } from "sonner";
import {
  ArrowDown,
  Check,
  ImageOff,
  ImagePlus,
  Loader2,
  RotateCw,
  Star,
} from "@/components/icons";
import { studioAspectRatio } from "@/lib/studio-prompt";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import type {
  generateStaticAdsTask,
  GeneratedVariant,
} from "../../../../trigger/generate-static-ads";
import type {
  Generation,
  GenerationPrefill,
  GenerationSummary,
  StudioFormat,
} from "./studio-types";

function StatusChip({
  done,
  failedAll,
  readyCount,
  total,
}: {
  done: boolean;
  failedAll: boolean;
  readyCount: number;
  total: number;
}) {
  if (failedAll) {
    return (
      <Badge variant="outline" className="shrink-0 text-destructive">
        Failed
      </Badge>
    );
  }
  if (done) {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1">
        <Check className="size-3 text-primary" />
        {readyCount} ready
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="shrink-0 gap-1">
      <Loader2 className="size-3 animate-spin" />
      {readyCount} of {total} ready
    </Badge>
  );
}

function EmptyVariantTile({
  status,
  format,
}: {
  status: string;
  format: StudioFormat;
}) {
  if (status === "failed") {
    return (
      <div
        className="flex items-center justify-center rounded-lg border bg-muted text-muted-foreground"
        style={{ aspectRatio: studioAspectRatio(format) }}
      >
        <ImageOff className="size-5" />
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center overflow-hidden rounded-lg border bg-muted"
      style={{ aspectRatio: studioAspectRatio(format) }}
    >
      <span className="shimmer text-xs font-medium">
        {status === "generating" ? "Creating…" : "Queued"}
      </span>
    </div>
  );
}

function LiveVariantTile({
  variant,
  angle,
  format,
  onUseReference,
}: {
  variant: GeneratedVariant;
  angle?: string;
  format: StudioFormat;
  onUseReference: (url: string) => void;
}) {
  if (variant.status !== "ready" || !variant.url) {
    return <EmptyVariantTile status={variant.status} format={format} />;
  }

  return (
    <div
      className="group relative overflow-hidden rounded-lg border bg-muted"
      style={{ aspectRatio: studioAspectRatio(format) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={variant.url}
        alt={angle ?? "Generated static ad"}
        className="size-full object-cover"
      />
      <Button
        type="button"
        size="icon-sm"
        variant="secondary"
        aria-label="Use image as a reference"
        title="Use as reference"
        onClick={() => onUseReference(variant.url!)}
        className="absolute right-2 bottom-2 opacity-0 shadow-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <ImagePlus className="size-3.5" />
      </Button>
    </div>
  );
}

function StaticVariantTile({
  variant,
  angle,
  format,
  starring,
  onToggleStar,
  onUseReference,
}: {
  variant: GenerationSummary["variants"][number];
  angle?: string | null;
  format: StudioFormat;
  starring: boolean;
  onToggleStar: () => void;
  onUseReference: (url: string) => void;
}) {
  if (variant.status !== "ready" || !variant.imageUrl) {
    return <EmptyVariantTile status={variant.status} format={format} />;
  }

  const starred = variant.starredAt != null;
  return (
    <div
      className="group relative overflow-hidden rounded-lg border bg-muted"
      style={{ aspectRatio: studioAspectRatio(format) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={variant.imageUrl}
        alt={angle ?? "Generated static ad"}
        className="size-full object-cover"
      />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex justify-end gap-1.5 bg-gradient-to-t from-black/60 to-transparent p-2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
          starred ? "opacity-100" : "opacity-0",
        )}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          aria-label="Use image as a reference"
          title="Use as reference"
          onClick={() => onUseReference(variant.imageUrl!)}
        >
          <ImagePlus className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          disabled={starring}
          aria-label={starred ? "Remove star" : "Star image"}
          title={starred ? "Unstar" : "Star"}
          onClick={onToggleStar}
          className={cn(starred && "text-amber-500 [&_svg]:fill-current")}
        >
          {starring ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Star className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

type RealtimeMetadata = {
  status?: string;
  variants?: GeneratedVariant[];
  [key: `variant:${number}`]:
    | { index: number; status: GeneratedVariant["status"]; url?: string }
    | undefined;
};

function mergeRealtimeVariants(
  metadata: RealtimeMetadata,
  count: number,
): GeneratedVariant[] {
  const variants: GeneratedVariant[] = Array.from(
    { length: count },
    (_, index) => ({
      index,
      status: "pending" as const,
    }),
  );

  for (const variant of metadata.variants ?? []) {
    if (variant.index >= 0 && variant.index < count) variants[variant.index] = variant;
  }
  for (let index = 0; index < count; index += 1) {
    const incremental = metadata[`variant:${index}`];
    if (incremental) variants[index] = incremental;
  }
  return variants;
}

function LiveGenerationCard({
  generation,
  onRedo,
  onRetry,
  onUseReference,
  onDone,
  retryDisabled,
}: {
  generation: Generation;
  onRedo: (generation: GenerationPrefill) => void;
  onRetry: (generation: Generation) => void;
  onUseReference: (url: string) => void;
  onDone: () => void;
  retryDisabled: boolean;
}) {
  const { run } = useRealtimeRun<typeof generateStaticAdsTask>(generation.runId, {
    accessToken: generation.accessToken,
  });
  const notifiedDone = useRef(false);
  const meta = (run?.metadata ?? {}) as RealtimeMetadata;
  const variants = mergeRealtimeVariants(meta, generation.count);
  const readyCount = variants.filter((variant) => variant.status === "ready").length;
  const done =
    meta.status === "completed" ||
    meta.status === "failed" ||
    run?.status === "COMPLETED" ||
    run?.status === "FAILED";
  const failedAll = meta.status === "failed" || (done && readyCount === 0);

  useEffect(() => {
    if (!done || notifiedDone.current) return;
    notifiedDone.current = true;
    onDone();
  }, [done, onDone]);

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{generation.brief}</p>
          {generation.angle ? (
            <p className="truncate text-xs text-muted-foreground">
              {generation.angle}
            </p>
          ) : null}
        </div>
        <StatusChip
          done={done}
          failedAll={failedAll}
          readyCount={readyCount}
          total={generation.count}
        />
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {variants.map((variant) => (
          <LiveVariantTile
            key={variant.index}
            variant={variant}
            angle={generation.angle}
            format={generation.format}
            onUseReference={onUseReference}
          />
        ))}
      </div>

      {failedAll ? (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Couldn&apos;t generate this set.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={retryDisabled}
            onClick={() => onRetry(generation)}
          >
            <RotateCw className="size-3.5" /> Try again
          </Button>
        </div>
      ) : done ? (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => onRedo(generation)}
          >
            <RotateCw className="size-3.5" /> More like this
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StaticGenerationCard({
  generation,
  onRedo,
  onUseReference,
}: {
  generation: GenerationSummary;
  onRedo: (generation: GenerationPrefill) => void;
  onUseReference: (url: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.studio.generations.queryKey();
  const starMutation = useMutation(
    trpc.studio.setStarred.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
      onError: (error) => toast.error(error.message),
    }),
  );
  const retryMutation = useMutation(
    trpc.studio.retry.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
      onError: (error) => toast.error(error.message),
    }),
  );
  const readyCount = generation.variants.filter(
    (variant) => variant.status === "ready",
  ).length;
  const done = generation.status !== "generating";
  const failedAll = generation.status === "failed" || (done && readyCount === 0);
  const format = generation.format as StudioFormat;

  const prefill: GenerationPrefill = {
    brief: generation.brief,
    angle: generation.angle,
    persona: generation.persona,
    awarenessLevel: generation.awarenessLevel,
    referenceImageUrls:
      generation.referenceImageUrls ??
      (generation.source?.assetUrl ? [generation.source.assetUrl] : undefined),
    count: generation.count,
    format,
    sourceCreativeId: generation.sourceCreativeId,
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{generation.brief}</p>
          {generation.angle ? (
            <p className="truncate text-xs text-muted-foreground">
              {generation.angle}
            </p>
          ) : null}
        </div>
        <StatusChip
          done={done}
          failedAll={failedAll}
          readyCount={readyCount}
          total={generation.count}
        />
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {generation.variants.map((variant) => (
          <StaticVariantTile
            key={variant.id}
            variant={variant}
            angle={generation.angle}
            format={format}
            starring={
              starMutation.isPending &&
              starMutation.variables?.variantIds.includes(variant.id)
            }
            onToggleStar={() =>
              starMutation.mutate({
                variantIds: [variant.id],
                starred: variant.starredAt == null,
              })
            }
            onUseReference={onUseReference}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-end gap-1">
        {generation.status === "failed" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={retryMutation.isPending}
            onClick={() => retryMutation.mutate({ id: generation.id })}
          >
            {retryMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCw className="size-3.5" />
            )}
            Try again
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => onRedo(prefill)}
          >
            <RotateCw className="size-3.5" /> More like this
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link href={`/studio/${generation.id}`}>Open</Link>
        </Button>
      </div>
    </div>
  );
}

type FeedItem =
  | { kind: "live"; key: string; generation: Generation }
  | { kind: "static"; key: string; generation: GenerationSummary };

function buildFeedItems(
  history: GenerationSummary[],
  sessions: Generation[],
): FeedItem[] {
  const recentHistory = history.slice(0, 10).reverse();
  const liveByRunId = new Map(sessions.map((session) => [session.runId, session]));
  const renderedRuns = new Set<string>();
  const terminalRuns = new Set(
    history
      .filter((generation) => generation.status !== "generating")
      .flatMap((generation) => (generation.runId ? [generation.runId] : [])),
  );
  const items: FeedItem[] = recentHistory.map((generation) => {
    const session = generation.runId
      ? liveByRunId.get(generation.runId)
      : undefined;
    if (session && generation.status === "generating") {
      renderedRuns.add(session.runId);
      return { kind: "live", key: session.runId, generation: session };
    }
    if (generation.runId) renderedRuns.add(generation.runId);
    return { kind: "static", key: generation.id, generation };
  });

  for (const session of sessions) {
    if (!renderedRuns.has(session.runId) && !terminalRuns.has(session.runId)) {
      items.push({ kind: "live", key: session.runId, generation: session });
    }
  }
  return items;
}

export function StudioFeed({
  history,
  sessions,
  onRedo,
  onRetryLive,
  onUseReference,
  retryDisabled,
}: {
  history: GenerationSummary[];
  sessions: Generation[];
  onRedo: (generation: GenerationPrefill) => void;
  onRetryLive: (generation: Generation) => void;
  onUseReference: (url: string) => void;
  retryDisabled: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const items = buildFeedItems(history, sessions);
  const invalidateHistory = () =>
    void queryClient.invalidateQueries({
      queryKey: trpc.studio.generations.queryKey(),
    });

  return (
    <MessageScrollerProvider>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-4 py-4">
            {items.map((item, index) => (
              <MessageScrollerItem
                key={item.key}
                scrollAnchor={index === items.length - 1}
              >
                {item.kind === "live" ? (
                  <LiveGenerationCard
                    generation={item.generation}
                    onRedo={onRedo}
                    onRetry={onRetryLive}
                    onUseReference={onUseReference}
                    onDone={invalidateHistory}
                    retryDisabled={retryDisabled}
                  />
                ) : (
                  <StaticGenerationCard
                    generation={item.generation}
                    onRedo={onRedo}
                    onUseReference={onUseReference}
                  />
                )}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton>
          <ArrowDown className="size-4" />
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
