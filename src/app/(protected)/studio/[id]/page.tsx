"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  ImagePlus,
  Loader2,
  RotateCw,
  Star,
} from "@/components/icons";
import { studioAspectRatio, type StudioFormat } from "@/lib/studio-prompt";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

type GenerationDetail = RouterOutputs["studio"]["generation"];
type Variant = GenerationDetail["variants"][number];

function RealtimeUpdates({
  runId,
  accessToken,
  onUpdate,
}: {
  runId: string;
  accessToken: string;
  onUpdate: () => unknown;
}) {
  const { run } = useRealtimeRun(runId, { accessToken });

  useEffect(() => {
    if (run?.metadata !== undefined || run?.status !== undefined) void onUpdate();
  }, [run?.metadata, run?.status, onUpdate]);

  return null;
}

function VariantCell({
  variant,
  aspectRatio,
  selected,
  retryPending,
  retrying,
  onToggle,
  onOpen,
  onRetry,
}: {
  variant: Variant;
  aspectRatio: string;
  selected: boolean;
  retryPending: boolean;
  retrying: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRetry: () => void;
}) {
  if (variant.status === "ready" && variant.imageUrl) {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border bg-muted transition-shadow",
          selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
        style={{ aspectRatio }}
      >
        <button
          type="button"
          className="absolute inset-0 cursor-zoom-in"
          onClick={onOpen}
          aria-label="View image"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={variant.imageUrl}
            alt="Generated static ad"
            className="size-full object-cover"
          />
        </button>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label="Select image"
          className="absolute left-2 top-2 z-10 size-5 rounded-md border-white/80 bg-black/25 shadow-sm backdrop-blur-sm data-checked:border-primary"
        />
        {variant.starredAt ? (
          <span className="absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Star className="size-3.5" />
          </span>
        ) : null}
      </div>
    );
  }

  if (variant.status === "failed") {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-xl border bg-muted text-muted-foreground",
        )}
        style={{ aspectRatio }}
      >
        <ImageOff className="size-5" />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={retryPending}
          onClick={onRetry}
        >
          <RotateCw className={cn("size-3", retrying && "animate-spin")} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-xl border bg-muted",
      )}
      style={{ aspectRatio }}
    >
      <span className="shimmer text-xs font-medium">
        {variant.status === "generating" ? "Creating…" : "Queued"}
      </span>
    </div>
  );
}

export default function StudioGenerationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const trpc = useTRPC();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    ...trpc.studio.generation.queryOptions({ id: params.id }),
    refetchInterval: (query) => {
      if (query.state.data?.generation.status !== "generating") return false;
      return query.state.data.realtime ? 15000 : 3000;
    },
  });

  const retryGenerationMutation = useMutation(
    trpc.studio.retry.mutationOptions({
      onSuccess: () => {
        toast.success("Generation restarted");
        void refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const retryVariantMutation = useMutation(
    trpc.studio.retryVariant.mutationOptions({
      onSuccess: () => {
        toast.success("Regenerating image…");
        void refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const starSelectedMutation = useMutation(
    trpc.studio.setStarred.mutationOptions({
      onSuccess: ({ updatedCount }) => {
        toast.success(`Starred ${updatedCount}`);
        setSelectedIds(new Set());
        void refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const toggleStarMutation = useMutation(
    trpc.studio.setStarred.mutationOptions({
      onSuccess: (_result, variables) => {
        toast.success(variables.starred ? "Starred" : "Unstarred");
        void refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const readyVariants = useMemo(
    () =>
      (data?.variants ?? []).filter(
        (variant) => variant.status === "ready" && variant.imageUrl,
      ),
    [data?.variants],
  );
  const lightboxIndex = readyVariants.findIndex((v) => v.id === lightboxId);
  const lightboxVariant = lightboxIndex >= 0 ? readyVariants[lightboxIndex] : null;

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl py-4">
        <Skeleton className="mb-2 h-6 w-72" />
        <Skeleton className="mb-4 h-4 w-52" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-center py-16 text-center">
        <p className="text-sm font-medium">Generation not found</p>
        <Button asChild size="sm" variant="outline" className="mt-4">
          <Link href="/studio/library">
            <ArrowLeft className="size-4" /> Back to Library
          </Link>
        </Button>
      </div>
    );
  }

  const { generation, variants, realtime, source } = data;
  const aspectRatio = studioAspectRatio(generation.format as StudioFormat);
  const readyCount = readyVariants.length;
  const meta = [
    generation.angle,
    generation.persona,
    generation.awarenessLevel?.replace(/_/g, " "),
    new Date(generation.createdAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  ]
    .filter(Boolean)
    .join(" · ");

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const stepLightbox = (direction: -1 | 1) => {
    if (readyVariants.length === 0 || lightboxIndex < 0) return;
    const next =
      (lightboxIndex + direction + readyVariants.length) % readyVariants.length;
    setLightboxId(readyVariants[next].id);
    setPromptOpen(false);
  };

  return (
    <div className="mx-auto w-full max-w-5xl py-4">
      {realtime ? (
        <RealtimeUpdates
          runId={realtime.runId}
          accessToken={realtime.publicAccessToken}
          onUpdate={refetch}
        />
      ) : null}

      <Button
        asChild
        size="sm"
        variant="ghost"
        className="mb-3 -ml-2 text-muted-foreground"
      >
        <Link href="/studio/library">
          <ArrowLeft className="size-4" /> Library
        </Link>
      </Button>

      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{generation.brief}</h1>
          <p className="mt-1 truncate text-sm capitalize text-muted-foreground">{meta}</p>
          {source ? (
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">Remixed from {source.name}</span>
              {source.roas != null ? (
                <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
                  {source.roas.toFixed(1)}× ROAS
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
        {generation.status === "generating" ? (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <Loader2 className="size-3 animate-spin" /> {readyCount} of {generation.count}
          </Badge>
        ) : generation.status === "failed" ? (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={retryGenerationMutation.isPending}
            onClick={() => retryGenerationMutation.mutate({ id: generation.id })}
          >
            <RotateCw
              className={cn("size-4", retryGenerationMutation.isPending && "animate-spin")}
            />
            {retryGenerationMutation.isPending ? "Retrying…" : "Retry"}
          </Button>
        ) : (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <CheckCircle2 className="size-3 text-primary" /> {readyCount} of{" "}
            {generation.count} ready
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 pb-6 sm:grid-cols-3 lg:grid-cols-4">
        {variants.map((variant) => (
          <VariantCell
            key={variant.id}
            variant={variant}
            aspectRatio={aspectRatio}
            selected={selectedIds.has(variant.id)}
            retryPending={retryVariantMutation.isPending}
            retrying={
              retryVariantMutation.isPending &&
              retryVariantMutation.variables?.variantId === variant.id
            }
            onToggle={() => toggleSelected(variant.id)}
            onOpen={() => {
              setLightboxId(variant.id);
              setPromptOpen(false);
            }}
            onRetry={() => retryVariantMutation.mutate({ variantId: variant.id })}
          />
        ))}
      </div>

      {selectedIds.size > 0 ? (
        <div className="sticky bottom-6 z-30 mx-auto flex w-fit items-center gap-2 rounded-full border bg-primary py-1.5 pl-4 pr-1.5 text-primary-foreground shadow-lg">
          <span className="text-xs font-medium tabular-nums">
            {selectedIds.size} selected
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 rounded-full text-xs"
            disabled={starSelectedMutation.isPending}
            onClick={() =>
              starSelectedMutation.mutate({
                variantIds: Array.from(selectedIds),
                starred: true,
              })
            }
          >
            {starSelectedMutation.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Star className="size-3" />
            )}
            Star selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-full text-xs hover:bg-primary-foreground/10 hover:text-primary-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <Dialog
        open={lightboxVariant != null}
        onOpenChange={(open) => {
          if (!open) {
            setLightboxId(null);
            setPromptOpen(false);
          }
        }}
      >
        <DialogContent
          className="gap-3 p-3 sm:max-w-md"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") stepLightbox(-1);
            if (event.key === "ArrowRight") stepLightbox(1);
          }}
        >
          <DialogTitle className="sr-only">{generation.brief}</DialogTitle>
          {lightboxVariant?.imageUrl ? (
            <>
              <div className="overflow-hidden rounded-lg border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={lightboxVariant.imageUrl}
                  alt="Generated static ad"
                  className="max-h-[70vh] w-full object-contain"
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant={lightboxVariant.starredAt ? "secondary" : "default"}
                  disabled={toggleStarMutation.isPending}
                  onClick={() =>
                    toggleStarMutation.mutate({
                      variantIds: [lightboxVariant.id],
                      starred: !lightboxVariant.starredAt,
                    })
                  }
                >
                  {toggleStarMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Star className="size-4" />
                  )}
                  {lightboxVariant.starredAt ? "Starred" : "Star"}
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a
                    href={lightboxVariant.imageUrl}
                    download
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Download className="size-4" /> Download
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    router.push(
                      `/studio?ref=${encodeURIComponent(lightboxVariant.imageUrl as string)}`,
                    )
                  }
                >
                  <ImagePlus className="size-4" /> Use as reference
                </Button>
                {readyVariants.length > 1 ? (
                  <div className="ml-auto flex items-center gap-1">
                    <span className="mr-1 text-xs tabular-nums text-muted-foreground">
                      {lightboxIndex + 1} / {readyVariants.length}
                    </span>
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-7"
                      onClick={() => stepLightbox(-1)}
                      aria-label="Previous image"
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-7"
                      onClick={() => stepLightbox(1)}
                      aria-label="Next image"
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
              {lightboxVariant.prompt ? (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    aria-expanded={promptOpen}
                    onClick={() => setPromptOpen((open) => !open)}
                  >
                    Prompt
                  </Button>
                  {promptOpen ? (
                    <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                      {lightboxVariant.prompt}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
