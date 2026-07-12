"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CirclePlus, ImageOff, Loader2, Save } from "@/components/icons";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

type GenerationSummary = RouterOutputs["studio"]["generations"][number];

function StatusBadge({ status, ready, total }: { status: string; ready: number; total: number }) {
  if (status === "generating") {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1">
        <Loader2 className="size-3 animate-spin" />
        {ready} of {total}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="shrink-0 text-destructive">
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="shrink-0 gap-1">
      <CheckCircle2 className="size-3 text-primary" />
      {ready} ready
    </Badge>
  );
}

function VariantThumb({
  variant,
}: {
  variant: GenerationSummary["variants"][number];
}) {
  if (variant.status === "ready" && variant.imageUrl) {
    return (
      <div className="relative aspect-[4/5] overflow-hidden rounded-md border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={variant.imageUrl} alt="" className="size-full object-cover" />
        {variant.savedCreativeId ? (
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Save className="size-2.5" />
          </span>
        ) : null}
      </div>
    );
  }
  if (variant.status === "failed") {
    return (
      <div className="flex aspect-[4/5] items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <ImageOff className="size-4" />
      </div>
    );
  }
  return (
    <div className="flex aspect-[4/5] items-center justify-center rounded-md border bg-muted">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

function GenerationCard({ generation }: { generation: GenerationSummary }) {
  const ready = generation.variants.filter((v) => v.status === "ready").length;
  const created = new Date(generation.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <Link
      href={`/studio/${generation.id}`}
      className="group block rounded-xl border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{generation.brief}</p>
          <p className="truncate text-xs text-muted-foreground">
            {generation.angle ? `${generation.angle} · ` : ""}
            {created}
          </p>
        </div>
        <StatusBadge status={generation.status} ready={ready} total={generation.count} />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {generation.variants.slice(0, 4).map((variant) => (
          <VariantThumb key={variant.id} variant={variant} />
        ))}
      </div>
    </Link>
  );
}

export default function StudioLibraryPage() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery({
    ...trpc.studio.generations.queryOptions(),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((g) => g.status === "generating") ? 4000 : false,
  });

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
      <div className="flex items-center justify-between gap-3 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            Everything you&apos;ve generated in Image Studio.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/studio">
            <CirclePlus className="size-4" /> New
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <Empty className="flex-none border py-10">
          <EmptyHeader>
            <EmptyTitle>No generations yet</EmptyTitle>
            <EmptyDescription>
              <Link href="/studio">Create your first</Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3 pb-6 sm:grid-cols-2">
          {data.map((generation) => (
            <GenerationCard key={generation.id} generation={generation} />
          ))}
        </div>
      )}
    </div>
  );
}
