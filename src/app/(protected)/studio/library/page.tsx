"use client";

import { Suspense, useMemo, useState } from "react";
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
  TrendingDown,
  TrendingUp,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { buildAdName } from "@/lib/studio-ad-name";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

type Generation = RouterOutputs["studio"]["generations"][number];
type Variant = Generation["variants"][number];
type LinkCandidate = RouterOutputs["studio"]["linkCandidates"][number];
type PublishTarget = { variant: Variant; generation: Generation };

function formatRoas(value: number | null) {
  return value == null ? "—" : `${value.toFixed(2)}x`;
}

function formatSpend(value: number | null) {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(value);
}

async function copyText(value: string, success: string) {
  await navigator.clipboard.writeText(value);
  toast.success(success);
}

function CopyPackage({ variant }: { variant: Variant }) {
  const pkg = variant.copyPackage;
  if (!pkg) return null;
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
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
              <p className="line-clamp-3 whitespace-pre-wrap">{value || "—"}</p>
            </div>
            {value ? (
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={`Copy ${label}`}
                onClick={() => void copyText(value, `${label} copied`)}
              >
                <Copy />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function CandidateRow({
  candidate,
  selected,
  onSelect,
}: {
  candidate: LinkCandidate;
  selected: boolean;
  onSelect: () => void;
}) {
  const reason = candidate.matchReason === "template"
    ? "name match"
    : candidate.matchReason === "angle"
      ? "angle"
      : null;
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors hover:bg-muted/60",
        selected && "border-foreground/30 bg-muted",
      )}
      onClick={onSelect}
    >
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
        {candidate.assetUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={candidate.assetUrl} alt="" className="size-full object-cover" />
        ) : (
          <ImageOff className="text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium">{candidate.name}</p>
          {reason ? <Badge variant="secondary" className="shrink-0 text-[9px]">{reason}</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatRoas(candidate.roas)} ROAS · {formatSpend(candidate.spend)} spend
        </p>
      </div>
      <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border", selected && "border-foreground bg-foreground text-background")}>
        {selected ? <Check className="size-3" /> : null}
      </span>
    </button>
  );
}

function PublishDialog({
  target,
  brandName,
  onClose,
  onPublished,
}: {
  target: PublishTarget | null;
  brandName?: string | null;
  onClose: () => void;
  onPublished: () => void;
}) {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const close = () => {
    setSearch("");
    setSelectedId(null);
    onClose();
  };
  const variantId = target?.variant.id ?? "";
  const candidates = useQuery({
    ...trpc.studio.linkCandidates.queryOptions({
      variantId,
      search: search.trim() || undefined,
    }),
    enabled: target != null,
  });
  const publish = useMutation(
    trpc.studio.publishAndLink.mutationOptions({
      onSuccess: (_result, variables) => {
        toast.success(variables.creativeId ? "Published and linked" : "Published without linking");
        close();
        onPublished();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const adName = target
    ? buildAdName({
        brandName,
        angle: target.generation.angle,
        variantId: target.variant.id,
      })
    : "";
  const rows = candidates.data ?? [];
  const bestMatches = search ? [] : rows.slice(0, 3);
  const bestIds = new Set(bestMatches.map((candidate) => candidate.id));
  const otherCandidates = search
    ? rows
    : rows.filter((candidate) => !bestIds.has(candidate.id));

  return (
    <Dialog open={target != null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Which ad did this ship as?</DialogTitle>
          <DialogDescription>
            Confirm the synced Meta creative so this image can teach Studio from real results.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2">
          <code className="min-w-0 flex-1 truncate px-1 text-xs font-medium">{adName}</code>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => void copyText(adName, "Ad name copied")}
          >
            <Copy /> Copy name
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            maxLength={80}
            className="pl-9"
            placeholder="Search synced creatives…"
            onChange={(event) => {
              setSearch(event.target.value);
              setSelectedId(null);
            }}
          />
        </div>
        <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
          {candidates.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No synced creatives found.
            </p>
          ) : (
            <>
              {bestMatches.length > 0 ? (
                <section className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Best matches</p>
                  {bestMatches.map((candidate) => (
                    <CandidateRow key={candidate.id} candidate={candidate} selected={selectedId === candidate.id} onSelect={() => setSelectedId(candidate.id)} />
                  ))}
                </section>
              ) : null}
              {otherCandidates.length > 0 ? (
                <section className="space-y-1.5">
                  {!search ? <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">All synced creatives</p> : null}
                  {otherCandidates.map((candidate) => (
                    <CandidateRow key={candidate.id} candidate={candidate} selected={selectedId === candidate.id} onSelect={() => setSelectedId(candidate.id)} />
                  ))}
                </section>
              ) : null}
            </>
          )}
        </div>
        <DialogFooter className="gap-2 sm:items-end sm:justify-between">
          <div className="sm:max-w-64">
            <Button
              variant="ghost"
              className="h-auto px-0 text-xs text-muted-foreground hover:bg-transparent"
              disabled={publish.isPending}
              onClick={() => publish.mutate({ variantId, creativeId: null })}
            >
              Publish without linking
            </Button>
            <p className="text-[10px] leading-4 text-amber-700 dark:text-amber-400">
              Unlinked images never teach the generator what wins in market.
            </p>
          </div>
          <Button
            disabled={!selectedId || publish.isPending}
            onClick={() => publish.mutate({ variantId, creativeId: selectedId })}
          >
            {publish.isPending ? <Loader2 className="animate-spin" /> : <Check />}
            Publish & link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VariantCard({
  variant,
  adName,
  pending,
  onMark,
  onPublish,
  onRetry,
}: {
  variant: Variant;
  adName: string;
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
              : variant.moderationReason === "claims"
                ? "Blocked: copy conflicts with the brand's claims rules"
                : "Generation failed"}
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => onRetry(Boolean(variant.moderationReason))}>
          <RefreshCw /> {variant.moderationReason ? "Retry without image" : "Retry"}
        </Button>
        {variant.moderationReason ? <p className="text-[10px] text-muted-foreground">Uses the written spec only</p> : null}
      </div>
    );
  }
  const linked = Boolean(variant.linkedCreativeId);
  return (
    <article className="space-y-2 break-inside-avoid">
      <div className={cn("relative overflow-hidden rounded-xl border bg-muted ring-2 ring-transparent", variant.mark === "good" && "ring-emerald-500", variant.mark === "bad" && "opacity-45 ring-red-400")}>
        {variant.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={variant.imageUrl} alt="Generated static ad" className="h-auto w-full" />
        ) : null}
        {linked ? (
          <Badge className="absolute right-2 top-2 border-emerald-700 bg-emerald-600 text-white">
            {variant.linkedCreative?.roas == null ? "Live" : `${variant.linkedCreative.roas.toFixed(2)}x live`}
          </Badge>
        ) : variant.publishedAt ? (
          <Badge variant="outline" className="absolute right-2 top-2 border-amber-500 bg-background/90 text-amber-700 dark:text-amber-400">Not linked</Badge>
        ) : null}
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant={variant.mark === "good" ? "default" : "outline"} className="h-7 flex-1 text-xs" disabled={pending} onClick={() => onMark(variant.mark === "good" ? null : "good")}><Check /> Good</Button>
        <Button size="sm" variant={variant.mark === "bad" ? "destructive" : "outline"} className="h-7 flex-1 text-xs" disabled={pending} onClick={() => onMark(variant.mark === "bad" ? null : "bad")}><X /> Bad</Button>
      </div>
      {variant.mark === "good" && !variant.publishedAt ? (
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => void copyText(adName, "Ad name copied")}><Copy /> Copy ad name</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={pending} onClick={onPublish}>Mark as published</Button>
        </div>
      ) : null}
      {variant.publishedAt && !linked ? (
        <Button size="sm" variant="outline" className="h-7 w-full border-amber-500/50 text-xs text-amber-700 dark:text-amber-400" disabled={pending} onClick={onPublish}>
          Link to see results
        </Button>
      ) : null}
      <CopyPackage variant={variant} />
    </article>
  );
}

function ProvenInMarket() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const market = useQuery(trpc.studio.marketTopVariants.queryOptions());
  const [queued, setQueued] = useState<Set<string>>(() => new Set());
  const extend = useMutation(
    trpc.studio.extendVariant.mutationOptions({
      onSuccess: (_result, variables) => {
        setQueued((current) => new Set(current).add(variables.variantId));
        toast.success("Queued 3 variants from the proven winner");
        void client.invalidateQueries({ queryKey: trpc.studio.generations.queryKey() });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const rows = market.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="mb-5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Proven in market</h2>
          <p className="text-xs text-muted-foreground">Linked Studio images with real ad results.</p>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map((row) => {
          const isQueued = queued.has(row.variantId);
          const isPending = extend.isPending && extend.variables?.variantId === row.variantId;
          return (
            <article key={row.variantId} className="flex items-center gap-3 rounded-lg border bg-background p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={row.imageUrl} alt="" className="size-14 shrink-0 rounded-md border object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{row.creativeName}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1 font-semibold text-foreground">
                    {formatRoas(row.roas)}
                    {row.trend === "rising" ? <TrendingUp className="text-emerald-600" /> : row.trend === "declining" ? <TrendingDown className="text-red-500" /> : null}
                  </span>
                  <span>{row.purchases ?? 0} purchases</span>
                </div>
              </div>
              <Button
                size="sm"
                variant={isQueued ? "secondary" : "outline"}
                className="h-auto max-w-32 shrink-0 whitespace-normal py-1.5 text-[10px] leading-4"
                disabled={isQueued || isPending}
                onClick={() => extend.mutate({ variantId: row.variantId })}
              >
                {isPending ? <Loader2 className="animate-spin" /> : null}
                {isQueued ? "Queued · 3 variants" : "Make 3 more like this"}
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function StudioLibraryContent() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [markFilter, setMarkFilter] = useQueryState("mark", parseAsString.withDefault("all"));
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null);
  const query = useQuery({ ...trpc.studio.generations.queryOptions(), refetchInterval: (state) => (state.state.data ?? []).some((generation) => generation.status === "generating") ? 4000 : false });
  const brand = useQuery(trpc.studio.brandProfile.queryOptions());
  const key = trpc.studio.generations.queryKey();
  const invalidate = () => client.invalidateQueries({ queryKey: key });
  const invalidateSignal = () => {
    void invalidate();
    void client.invalidateQueries({ queryKey: trpc.studio.marketTopVariants.queryKey() });
  };
  const mark = useMutation(trpc.studio.setVariantMark.mutationOptions({ onSuccess: () => void invalidate(), onError: (error) => toast.error(error.message) }));
  const retry = useMutation(trpc.studio.retryVariant.mutationOptions({ onSuccess: () => { toast.success("Regenerating image"); void invalidate(); }, onError: (error) => toast.error(error.message) }));
  const generations = useMemo(() => query.data ?? [], [query.data]);
  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return generations.flatMap((generation) => {
      if (needle && !generation.brief.toLowerCase().includes(needle) && !(generation.angle ?? "").toLowerCase().includes(needle)) return [];
      return generation.variants.flatMap((variant) => {
        if (markFilter !== "all" && (markFilter === "unreviewed" ? variant.mark != null : variant.mark !== markFilter)) return [];
        return [{ variant, generation }];
      });
    });
  }, [generations, markFilter, search]);
  const readyCount = generations.reduce((count, generation) => count + generation.variants.filter((variant) => variant.status === "ready").length, 0);
  const goodCount = generations.reduce((count, generation) => count + generation.variants.filter((variant) => variant.mark === "good").length, 0);
  return (
    <div className="mx-auto w-full max-w-5xl pb-8">
      <header className="flex items-center justify-between gap-3 py-4"><div><h1 className="text-xl font-semibold">Library</h1><p className="text-sm text-muted-foreground">{readyCount} images · {goodCount} Good</p></div><Button asChild size="sm"><Link href="/studio?compose=new"><Plus /> Start from scratch</Link></Button></header>
      <ProvenInMarket />
      <div className="mb-4 flex flex-wrap items-center gap-2"><div className="relative min-w-52 flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" placeholder="Search briefs…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>{["all", "good", "bad", "unreviewed"].map((value) => <Button key={value} size="sm" variant={markFilter === value ? "secondary" : "outline"} className="capitalize" onClick={() => setMarkFilter(value)}>{value === "all" ? "All images" : value}</Button>)}</div>
      {query.isLoading ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{[1,2,3,4].map((i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}</div> : generations.length === 0 ? <Empty className="border py-10"><EmptyHeader><EmptyMedia variant="icon"><ImageOff /></EmptyMedia><EmptyTitle>No images yet</EmptyTitle><EmptyDescription>Approve a suggestion on Home or start from scratch.</EmptyDescription></EmptyHeader></Empty> : items.length === 0 ? <Empty className="border py-10"><EmptyHeader><EmptyTitle>No images match</EmptyTitle><EmptyDescription>Try a different search or mark filter.</EmptyDescription></EmptyHeader></Empty> : <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 [&>*]:mb-5">{items.map(({ variant, generation }) => <VariantCard key={variant.id} variant={variant} adName={buildAdName({ brandName: brand.data?.brandName, angle: generation.angle, variantId: variant.id })} pending={(mark.isPending && mark.variables?.variantId === variant.id) || (retry.isPending && retry.variables?.variantId === variant.id)} onMark={(next) => mark.mutate({ variantId: variant.id, mark: next })} onPublish={() => setPublishTarget({ variant, generation })} onRetry={(withoutReferenceImage) => retry.mutate({ variantId: variant.id, withoutReferenceImage })} />)}</div>}
      <PublishDialog target={publishTarget} brandName={brand.data?.brandName} onClose={() => setPublishTarget(null)} onPublished={invalidateSignal} />
    </div>
  );
}

export default function StudioLibraryPage() { return <Suspense><StudioLibraryContent /></Suspense>; }
