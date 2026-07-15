"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseAsString, useQueryState } from "nuqs";
import { toast } from "sonner";
import {
  Check,
  Copy,
  ImageOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

type Generation = RouterOutputs["studio"]["generations"][number];
type Variant = Generation["variants"][number];

function CopyPackage({ variant }: { variant: Variant }) {
  const pkg = variant.copyPackage;
  if (!pkg) return null;
  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }
  return (
    <details className="rounded-lg border bg-card text-xs">
      <summary className="cursor-pointer list-none px-2.5 py-2 font-medium [&::-webkit-details-marker]:hidden">
        Copy · {pkg.name}
      </summary>
      <div className="space-y-2 border-t p-2.5">
        {[
          ["Primary text", pkg.primaryText],
          ["Headline", pkg.headline],
          ["Description", pkg.description],
        ].map(([label, value]) => (
          <div key={label} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="line-clamp-3 whitespace-pre-wrap">{value || "—"}</p>
            </div>
            {value ? (
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Copy ${label}`} onClick={() => void copy(label, value)}><Copy /></Button>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function VariantCard({
  variant,
  pending,
  onMark,
  onPublish,
  onRetry,
}: {
  variant: Variant;
  pending: boolean;
  onMark: (mark: "good" | "bad" | null) => void;
  onPublish: () => void;
  onRetry: (withoutImage: boolean) => void;
}) {
  if (variant.status === "pending" || variant.status === "generating") {
    return <div className="flex aspect-square animate-pulse items-center justify-center rounded-xl border bg-muted"><Loader2 className="animate-spin text-muted-foreground" /></div>;
  }
  if (variant.status === "failed") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 p-4 text-center">
        <ImageOff className="text-muted-foreground" />
        <p className={cn("text-xs font-medium", variant.moderationReason && "text-destructive")}>
          {variant.moderationReason === "likeness"
            ? "Blocked: the reference shows a real person's likeness"
            : variant.moderationReason === "logo"
              ? "Blocked: the reference contains protected branding"
              : "Generation failed"}
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => onRetry(Boolean(variant.moderationReason))}>
          <RefreshCw /> {variant.moderationReason ? "Retry without image" : "Retry"}
        </Button>
        {variant.moderationReason ? <p className="text-[10px] text-muted-foreground">Uses the written spec only</p> : null}
      </div>
    );
  }
  return (
    <article className="space-y-2 break-inside-avoid">
      <div className={cn("relative overflow-hidden rounded-xl border bg-muted ring-2 ring-transparent", variant.mark === "good" && "ring-emerald-500", variant.mark === "bad" && "opacity-45 ring-red-400")}>
        {variant.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={variant.imageUrl} alt="Generated static ad" className="h-auto w-full" />
        ) : null}
        {variant.publishedAt ? <Badge className="absolute right-2 top-2 bg-emerald-600">Published</Badge> : null}
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant={variant.mark === "good" ? "default" : "outline"} className="h-7 flex-1 text-xs" disabled={pending} onClick={() => onMark(variant.mark === "good" ? null : "good")}><Check /> Good</Button>
        <Button size="sm" variant={variant.mark === "bad" ? "destructive" : "outline"} className="h-7 flex-1 text-xs" disabled={pending} onClick={() => onMark(variant.mark === "bad" ? null : "bad")}><X /> Bad</Button>
      </div>
      {variant.mark === "good" && !variant.publishedAt ? <Button size="sm" variant="ghost" className="h-7 w-full text-xs text-muted-foreground" disabled={pending} onClick={onPublish}>Mark as published</Button> : null}
      <CopyPackage variant={variant} />
    </article>
  );
}

function StudioLibraryContent() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [markFilter, setMarkFilter] = useQueryState("mark", parseAsString.withDefault("all"));
  const query = useQuery({ ...trpc.studio.generations.queryOptions(), refetchInterval: (state) => (state.state.data ?? []).some((generation) => generation.status === "generating") ? 4000 : false });
  const key = trpc.studio.generations.queryKey();
  const invalidate = () => client.invalidateQueries({ queryKey: key });
  const mark = useMutation(trpc.studio.setVariantMark.mutationOptions({ onSuccess: () => void invalidate(), onError: (error) => toast.error(error.message) }));
  const publish = useMutation(trpc.studio.setVariantPublished.mutationOptions({ onSuccess: () => void invalidate(), onError: (error) => toast.error(error.message) }));
  const retry = useMutation(trpc.studio.retryVariant.mutationOptions({ onSuccess: () => { toast.success("Regenerating image"); void invalidate(); }, onError: (error) => toast.error(error.message) }));
  const generations = useMemo(() => query.data ?? [], [query.data]);
  const variants = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return generations.flatMap((generation) => {
      if (needle && !generation.brief.toLowerCase().includes(needle) && !(generation.angle ?? "").toLowerCase().includes(needle)) return [];
      return generation.variants.filter((variant) => {
        if (markFilter === "all") return true;
        if (markFilter === "unreviewed") return variant.mark == null;
        return variant.mark === markFilter;
      });
    });
  }, [generations, markFilter, search]);
  const readyCount = generations.reduce((count, generation) => count + generation.variants.filter((variant) => variant.status === "ready").length, 0);
  const goodCount = generations.reduce((count, generation) => count + generation.variants.filter((variant) => variant.mark === "good").length, 0);
  return (
    <div className="mx-auto w-full max-w-5xl pb-8">
      <header className="flex items-center justify-between gap-3 py-4"><div><h1 className="text-xl font-semibold">Library</h1><p className="text-sm text-muted-foreground">{readyCount} images · {goodCount} Good</p></div><Button asChild size="sm"><Link href="/studio?compose=new"><Plus /> Start from scratch</Link></Button></header>
      <div className="mb-4 flex flex-wrap items-center gap-2"><div className="relative min-w-52 flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" placeholder="Search briefs…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>{["all", "good", "bad", "unreviewed"].map((value) => <Button key={value} size="sm" variant={markFilter === value ? "secondary" : "outline"} className="capitalize" onClick={() => setMarkFilter(value)}>{value === "all" ? "All images" : value}</Button>)}</div>
      {query.isLoading ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{[1,2,3,4].map((i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}</div> : generations.length === 0 ? <Empty className="border py-10"><EmptyHeader><EmptyMedia variant="icon"><ImageOff /></EmptyMedia><EmptyTitle>No images yet</EmptyTitle><EmptyDescription>Approve a suggestion on Home or start from scratch.</EmptyDescription></EmptyHeader></Empty> : variants.length === 0 ? <Empty className="border py-10"><EmptyHeader><EmptyTitle>No images match</EmptyTitle><EmptyDescription>Try a different search or mark filter.</EmptyDescription></EmptyHeader></Empty> : <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 [&>*]:mb-5">{variants.map((variant) => <VariantCard key={variant.id} variant={variant} pending={(mark.isPending && mark.variables?.variantId === variant.id) || (publish.isPending && publish.variables?.variantId === variant.id) || (retry.isPending && retry.variables?.variantId === variant.id)} onMark={(next) => mark.mutate({ variantId: variant.id, mark: next })} onPublish={() => publish.mutate({ variantId: variant.id, published: true })} onRetry={(withoutReferenceImage) => retry.mutate({ variantId: variant.id, withoutReferenceImage })} />)}</div>}
    </div>
  );
}

export default function StudioLibraryPage() { return <Suspense><StudioLibraryContent /></Suspense>; }
