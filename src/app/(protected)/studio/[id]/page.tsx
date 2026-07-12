"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Download,
  ImageOff,
  Loader2,
  Save,
} from "lucide-react";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type GenerationDetail = RouterOutputs["studio"]["generation"];
type Variant = GenerationDetail["variants"][number];

function VariantCard({
  variant,
  generation,
  saved,
  saving,
  onSave,
}: {
  variant: Variant;
  generation: GenerationDetail["generation"];
  saved: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  if (variant.status === "ready" && variant.imageUrl) {
    return (
      <div className="group relative aspect-[4/5] overflow-hidden rounded-xl border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={variant.imageUrl}
          alt={generation.angle ?? "Generated static ad"}
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
          <Button asChild size="sm" variant="secondary" className="h-7 text-xs">
            <a href={variant.imageUrl} download target="_blank" rel="noreferrer">
              <Download className="size-3" />
            </a>
          </Button>
        </div>
      </div>
    );
  }
  if (variant.status === "failed") {
    return (
      <div className="flex aspect-[4/5] items-center justify-center rounded-xl border bg-muted text-muted-foreground">
        <ImageOff className="size-5" />
      </div>
    );
  }
  return (
    <div className="flex aspect-[4/5] items-center justify-center rounded-xl border bg-muted">
      <span className="shimmer text-xs font-medium">
        {variant.status === "generating" ? "Creating…" : "Queued"}
      </span>
    </div>
  );
}

export default function StudioGenerationPage() {
  const params = useParams<{ id: string }>();
  const trpc = useTRPC();
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery({
    ...trpc.studio.generation.queryOptions({ id: params.id }),
    refetchInterval: (query) =>
      query.state.data?.generation.status === "generating" ? 3000 : false,
  });

  const saveMutation = useMutation(
    trpc.studio.save.mutationOptions({
      onSuccess: (_data, variables) => {
        if (variables.variantId) {
          setSavedIds((prev) => new Set(prev).add(variables.variantId as string));
        }
        toast.success("Saved to Creatives");
        void refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl py-4">
        <Skeleton className="mb-4 h-8 w-56" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[4/5] w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center py-16 text-center">
        <p className="text-sm font-medium">Generation not found</p>
        <Button asChild size="sm" variant="outline" className="mt-4">
          <Link href="/studio/library">
            <ArrowLeft className="size-4" /> Back to Library
          </Link>
        </Button>
      </div>
    );
  }

  const { generation, variants } = data;
  const meta = [
    generation.angle,
    generation.persona,
    generation.awarenessLevel?.replace(/_/g, " "),
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto w-full max-w-4xl py-4">
      <Button asChild size="sm" variant="ghost" className="mb-3 -ml-2 text-muted-foreground">
        <Link href="/studio/library">
          <ArrowLeft className="size-4" /> Library
        </Link>
      </Button>

      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{generation.brief}</h1>
          {meta.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {meta.map((m) => (
                <Badge key={m} variant="outline" className="capitalize">
                  {m}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        {generation.status === "generating" ? (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <Loader2 className="size-3 animate-spin" /> Generating
          </Badge>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 pb-6 sm:grid-cols-3">
        {variants.map((variant) => (
          <VariantCard
            key={variant.id}
            variant={variant}
            generation={generation}
            saved={savedIds.has(variant.id) || variant.savedCreativeId != null}
            saving={saveMutation.isPending}
            onSave={() =>
              variant.imageUrl &&
              saveMutation.mutate({
                assetUrl: variant.imageUrl,
                variantId: variant.id,
                angle: generation.angle ?? undefined,
                persona: generation.persona ?? undefined,
                awarenessLevel: generation.awarenessLevel ?? undefined,
              })
            }
          />
        ))}
      </div>
    </div>
  );
}
