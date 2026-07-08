"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { toast } from "sonner";
import { Loader2, RotateCw, Save, ImageOff, Check, ArrowDown } from "lucide-react";
import { useTRPC } from "@/lib/trpc/client";
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
import type { generateStaticAdsTask } from "../../../../trigger/generate-static-ads";
import type { Generation } from "./create-types";

type Variant = {
  index: number;
  status: "pending" | "generating" | "ready" | "failed";
  url?: string;
};

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

function VariantTile({
  variant,
  angle,
  saved,
  saving,
  onSave,
}: {
  variant: Variant;
  angle?: string;
  saved: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  if (variant.status === "ready" && variant.url) {
    return (
      <div className="group relative aspect-[4/5] overflow-hidden rounded-lg border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={variant.url}
          alt={angle ?? "Generated static ad"}
          className="size-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 flex gap-1.5 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={saved || saving}
            onClick={onSave}
          >
            {saved ? (
              <>
                <Check className="size-3" /> Saved
              </>
            ) : (
              <>
                <Save className="size-3" /> Save
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  if (variant.status === "failed") {
    return (
      <div className="flex aspect-[4/5] items-center justify-center rounded-lg border bg-muted text-muted-foreground">
        <ImageOff className="size-5" />
      </div>
    );
  }

  return (
    <div className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-lg border bg-muted">
      <span className="shimmer text-xs font-medium">
        {variant.status === "generating" ? "Creating…" : "Queued"}
      </span>
    </div>
  );
}

function GenerationCard({
  generation,
  onRedo,
}: {
  generation: Generation;
  onRedo: (generation: Generation) => void;
}) {
  const trpc = useTRPC();
  const { run } = useRealtimeRun<typeof generateStaticAdsTask>(generation.runId, {
    accessToken: generation.accessToken,
  });
  const [savedUrls, setSavedUrls] = useState<Set<string>>(new Set());

  const saveMutation = useMutation(
    trpc.create.save.mutationOptions({
      onSuccess: (_data, variables) => {
        setSavedUrls((prev) => new Set(prev).add(variables.assetUrl));
        toast.success("Saved to Creatives");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const meta = (run?.metadata ?? {}) as { status?: string; variants?: Variant[] };
  const variants: Variant[] =
    meta.variants && meta.variants.length > 0
      ? meta.variants
      : Array.from({ length: generation.count }, (_, index) => ({
          index,
          status: "pending" as const,
        }));

  const readyCount = variants.filter((v) => v.status === "ready").length;
  const total = variants.length;
  const done =
    meta.status === "completed" ||
    meta.status === "failed" ||
    run?.status === "COMPLETED" ||
    run?.status === "FAILED";
  const failedAll = meta.status === "failed" || (done && readyCount === 0);

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{generation.brief}</p>
          {generation.angle ? (
            <p className="truncate text-xs text-muted-foreground">{generation.angle}</p>
          ) : null}
        </div>
        <StatusChip
          done={done}
          failedAll={failedAll}
          readyCount={readyCount}
          total={total}
        />
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {variants.map((variant) => (
          <VariantTile
            key={variant.index}
            variant={variant}
            angle={generation.angle}
            saved={variant.url ? savedUrls.has(variant.url) : false}
            saving={saveMutation.isPending}
            onSave={() =>
              variant.url &&
              saveMutation.mutate({ assetUrl: variant.url, angle: generation.angle })
            }
          />
        ))}
      </div>

      {failedAll ? (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Couldn&apos;t generate this set.
          </p>
          <Button size="sm" variant="outline" onClick={() => onRedo(generation)}>
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

export function CreateFeed({
  generations,
  onRedo,
}: {
  generations: Generation[];
  onRedo: (generation: Generation) => void;
}) {
  return (
    <MessageScrollerProvider>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-4 py-4">
            {generations.map((generation, index) => (
              <MessageScrollerItem
                key={generation.runId}
                scrollAnchor={index === generations.length - 1}
              >
                <GenerationCard generation={generation} onRedo={onRedo} />
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
