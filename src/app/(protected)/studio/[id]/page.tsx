"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ImageIcon,
  ImageOff,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { studioAspectRatio, type StudioFormat } from "@/lib/studio-prompt";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

type Detail = RouterOutputs["studio"]["generation"];
type Variant = Detail["variants"][number];
type LinkCandidate = RouterOutputs["studio"]["linkCandidates"][number];
type CreativeFormat = LinkCandidate["format"];

function RealtimeUpdates({ runId, accessToken, onUpdate }: { runId: string; accessToken: string; onUpdate: () => unknown }) {
  const { run } = useRealtimeRun(runId, { accessToken });
  useEffect(() => {
    if (run?.metadata !== undefined || run?.status !== undefined) void onUpdate();
  }, [run?.metadata, run?.status, onUpdate]);
  return null;
}

function formatRoas(roas: number | null) {
  return roas == null ? "—" : `${roas.toFixed(1)}x`;
}

// Whether the URL points at an actual video file — decides <video> vs <img>.
// Meta-synced video creatives store an image preview frame in assetUrl, so
// format alone must never switch the element type.
function isVideoFile(assetUrl: string | null) {
  return Boolean(assetUrl && /\.(mp4|mov|webm)(\?|$)/i.test(assetUrl));
}

// Whether the creative is a video ad — decides the "Video" label only.
function isVideoAsset(assetUrl: string | null, format?: CreativeFormat | null) {
  return format === "video" || isVideoFile(assetUrl);
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function CreativeThumbnail({
  assetUrl,
  className,
}: {
  assetUrl: string | null;
  className?: string;
}) {
  if (!assetUrl) {
    return (
      <span className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageIcon className="size-4" />
      </span>
    );
  }
  if (isVideoFile(assetUrl)) {
    return (
      <video
        src={assetUrl}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        className={cn("bg-muted object-cover", className)}
      />
    );
  }
  return <img src={assetUrl} alt="" className={cn("bg-muted object-cover", className)} />;
}

function CreativePreview({
  assetUrl,
  format,
  name,
}: {
  assetUrl: string | null;
  format?: CreativeFormat | null;
  name: string;
}) {
  if (!assetUrl) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ImageIcon className="size-8" />
      </div>
    );
  }
  if (isVideoFile(assetUrl)) {
    return (
      <video
        src={assetUrl}
        controls
        muted
        playsInline
        preload="metadata"
        aria-label={`Preview ${name}`}
        className="max-h-72 w-full rounded-md bg-muted object-contain"
      />
    );
  }
  return (
    <div className="space-y-1">
      <img
        src={assetUrl}
        alt={name}
        className="max-h-72 w-full rounded-md bg-muted object-contain"
      />
      {isVideoAsset(assetUrl, format) ? (
        <p className="text-[10px] text-muted-foreground">
          Video ad — showing its preview frame.
        </p>
      ) : null}
    </div>
  );
}

function CandidateRow({
  candidate,
  disabled,
  onSelect,
}: {
  candidate: LinkCandidate;
  disabled: boolean;
  onSelect: (candidateId: string) => void;
}) {
  const video = isVideoAsset(candidate.assetUrl, candidate.format);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
      disabled={disabled}
      onClick={() => onSelect(candidate.id)}
    >
      <CreativeThumbnail
        assetUrl={candidate.assetUrl}
        className="size-10 shrink-0 rounded-md border"
      />
      <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
      <span className="flex shrink-0 items-center gap-1">
        {video ? <Badge variant="outline" className="text-[10px]">Video</Badge> : null}
        <Badge variant="secondary" className="text-[10px]">
          {formatRoas(candidate.roas)}
        </Badge>
      </span>
    </button>
  );
}

function SourceTile({ source }: { source: NonNullable<Detail["source"]> }) {
  return (
    <div className="mt-2 flex w-fit max-w-xs items-center gap-2 rounded-lg border bg-muted/30 p-1.5">
      <CreativeThumbnail
        assetUrl={source.assetUrl}
        className="size-10 shrink-0 rounded-md border"
      />
      <div className="min-w-0">
        <span className="block text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          Source{source.format === "video" ? " · Video" : ""}
        </span>
        <span className="block truncate text-xs font-medium">{source.name}</span>
      </div>
      {source.roas != null ? (
        <Badge variant="secondary" className="ml-1 shrink-0 text-[10px]">
          {formatRoas(source.roas)}
        </Badge>
      ) : null}
    </div>
  );
}

function LiveCreativeLink({ variant, onChanged }: { variant: Variant; onChanged: () => unknown }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const publishedAfter = toIsoString(variant.publishedAt);
  const candidates = useQuery({
    ...trpc.studio.linkCandidates.queryOptions({
      search: search || undefined,
      publishedAfter,
    }),
    enabled: open,
  });
  const link = useMutation(trpc.studio.linkVariantToCreative.mutationOptions({
    onSuccess: (_result, variables) => {
      setOpen(false);
      setSearch("");
      toast.success(variables.creativeId ? "Live ad linked" : "Live ad unlinked");
      void onChanged();
    },
    onError: (error) => toast.error(error.message),
  }));
  const rows = candidates.data ?? [];
  const publishedAfterMs = publishedAfter ? new Date(publishedAfter).getTime() : null;
  const likelyMatches = publishedAfterMs == null
    ? []
    : rows.filter(
        (candidate) =>
          candidate.format === "static" &&
          candidate.createdAt.getTime() >= publishedAfterMs,
      );
  const likelyIds = new Set(likelyMatches.map((candidate) => candidate.id));
  const otherCreatives = rows.filter((candidate) => !likelyIds.has(candidate.id));
  const showGroups = likelyMatches.length > 0 && otherCreatives.length > 0;
  const selectCandidate = (candidateId: string) => {
    link.mutate({ variantId: variant.id, creativeId: candidateId });
  };

  if (variant.linkedCreative) {
    return (
      <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-1.5 py-1 text-[11px] text-muted-foreground">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Preview ${variant.linkedCreative.name}`}
            >
              <CreativeThumbnail
                assetUrl={variant.linkedCreative.assetUrl}
                className="size-8 rounded-md border"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <CreativePreview
              assetUrl={variant.linkedCreative.assetUrl}
              format={variant.linkedCreative.format}
              name={variant.linkedCreative.name}
            />
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 break-words text-xs font-medium text-foreground">
                {variant.linkedCreative.name}
              </p>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {formatRoas(variant.linkedCreative.roas)}
              </Badge>
            </div>
          </PopoverContent>
        </Popover>
        <span className="min-w-0 flex-1 truncate">
          Live: {variant.linkedCreative.name} · ROAS {formatRoas(variant.linkedCreative.roas)}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-5 shrink-0"
          disabled={link.isPending}
          aria-label={`Unlink ${variant.linkedCreative.name}`}
          onClick={() => link.mutate({ variantId: variant.id, creativeId: null })}
        >
          {link.isPending ? <Loader2 className="animate-spin" /> : <X />}
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 w-full text-xs">
          Link live ad
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link live ad</DialogTitle>
          <DialogDescription>
            Choose the synced creative that uses this published image.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2">
          <img
            src={variant.imageUrl ?? ""}
            alt="Your published Studio image"
            className="w-16 rounded-md border object-cover"
          />
          <div>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Your image
            </span>
            <span className="text-xs text-muted-foreground">
              Match this to the synced live creative below.
            </span>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            maxLength={80}
            autoFocus
            className="pl-8"
            placeholder="Search creatives"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
          {candidates.isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="animate-spin" />
            </div>
          ) : rows.length ? (
            showGroups ? (
              <>
                <p className="px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Likely matches
                </p>
                {likelyMatches.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    disabled={link.isPending}
                    onSelect={selectCandidate}
                  />
                ))}
                <p className="px-2 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  All creatives
                </p>
                {otherCreatives.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    disabled={link.isPending}
                    onSelect={selectCandidate}
                  />
                ))}
              </>
            ) : (
              rows.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  disabled={link.isPending}
                  onSelect={selectCandidate}
                />
              ))
            )
          ) : (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {search.trim()
                ? "No creatives match your search."
                : "No synced creatives yet. Sync an ad account first."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VariantView({ variant, aspectRatio, pending, onMark, onPublish, onRetry, onLinkChanged }: { variant: Variant; aspectRatio: string; pending: boolean; onMark: (mark: "good" | "bad" | null) => void; onPublish: () => void; onRetry: (withoutImage: boolean) => void; onLinkChanged: () => unknown }) {
  if (variant.status === "failed") {
    return <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 p-4 text-center" style={{ aspectRatio }}><ImageOff /><p className={cn("text-xs", variant.moderationReason && "text-destructive")}>{variant.moderationReason === "likeness" ? "Blocked: the reference shows a real person's likeness" : variant.moderationReason === "logo" ? "Blocked: protected branding in the reference" : "Generation failed"}</p><Button size="sm" variant="outline" disabled={pending} onClick={() => onRetry(Boolean(variant.moderationReason))}><RefreshCw /> {variant.moderationReason ? "Retry without image" : "Retry"}</Button></div>;
  }
  if (variant.status !== "ready" || !variant.imageUrl) {
    return <div className="flex items-center justify-center rounded-xl border bg-muted" style={{ aspectRatio }}><Loader2 className="animate-spin text-muted-foreground" /></div>;
  }
  const pkg = variant.copyPackage;
  return <article className="space-y-2"><div className={cn("relative overflow-hidden rounded-xl border ring-2 ring-transparent", variant.mark === "good" && "ring-emerald-500", variant.mark === "bad" && "opacity-45 ring-red-400")} style={{ aspectRatio }}><img src={variant.imageUrl} alt="Generated static ad" className="size-full object-cover" />{variant.publishedAt ? <Badge className="absolute right-2 top-2 bg-emerald-600">Published</Badge> : null}</div><div className="flex gap-1"><Button size="sm" variant={variant.mark === "good" ? "default" : "outline"} className="flex-1" disabled={pending} onClick={() => onMark(variant.mark === "good" ? null : "good")}><Check /> Good</Button><Button size="sm" variant={variant.mark === "bad" ? "destructive" : "outline"} className="flex-1" disabled={pending} onClick={() => onMark(variant.mark === "bad" ? null : "bad")}><X /> Bad</Button></div>{variant.mark === "good" && !variant.publishedAt ? <Button size="sm" variant="ghost" className="w-full" onClick={onPublish}>Mark as published</Button> : null}{variant.publishedAt ? <LiveCreativeLink variant={variant} onChanged={onLinkChanged} /> : null}{pkg ? <details className="rounded-lg border text-xs"><summary className="cursor-pointer list-none px-3 py-2 font-medium [&::-webkit-details-marker]:hidden">Copy · {pkg.name}</summary><div className="space-y-2 border-t p-3">{[["Primary text", pkg.primaryText], ["Headline", pkg.headline], ["Description", pkg.description]].map(([label, value]) => <button key={label} type="button" className="flex w-full items-start gap-2 text-left" onClick={() => { void navigator.clipboard.writeText(value); toast.success(`${label} copied`); }}><span className="min-w-0 flex-1"><span className="block text-[10px] uppercase text-muted-foreground">{label}</span><span className="line-clamp-3">{value || "—"}</span></span><Copy /></button>)}</div></details> : null}</article>;
}

export default function StudioGenerationPage() {
  const params = useParams<{ id: string }>();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery({ ...trpc.studio.generation.queryOptions({ id: params.id }), refetchInterval: (state) => state.state.data?.generation.status === "generating" ? 4000 : false });
  const mark = useMutation(trpc.studio.setVariantMark.mutationOptions({ onSuccess: () => void query.refetch(), onError: (error) => toast.error(error.message) }));
  const publish = useMutation(trpc.studio.setVariantPublished.mutationOptions({ onSuccess: () => void query.refetch(), onError: (error) => toast.error(error.message) }));
  const retryVariant = useMutation(trpc.studio.retryVariant.mutationOptions({ onSuccess: () => { toast.success("Regenerating image"); void query.refetch(); }, onError: (error) => toast.error(error.message) }));
  const retryGeneration = useMutation(trpc.studio.retry.mutationOptions({ onSuccess: () => void query.refetch(), onError: (error) => toast.error(error.message) }));
  if (query.isLoading) return <div className="mx-auto w-full max-w-5xl py-4"><Skeleton className="mb-4 h-7 w-72" /><div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{[1,2,3,4].map((i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}</div></div>;
  if (!query.data) return <div className="py-16 text-center"><p>Generation not found</p><Button asChild variant="outline" className="mt-4"><Link href="/studio/library"><ArrowLeft /> Library</Link></Button></div>;
  const { generation, variants, realtime, source } = query.data;
  const aspectRatio = studioAspectRatio(generation.format as StudioFormat);
  const ready = variants.filter((variant) => variant.status === "ready").length;
  return <div className="mx-auto w-full max-w-5xl py-4">{realtime ? <RealtimeUpdates runId={realtime.runId} accessToken={realtime.publicAccessToken} onUpdate={query.refetch} /> : null}<Button asChild size="sm" variant="ghost" className="mb-3 -ml-2"><Link href="/studio/library"><ArrowLeft /> Library</Link></Button><header className="mb-4 flex items-start justify-between gap-3"><div className="min-w-0"><h1 className="text-lg font-semibold">{generation.brief}</h1><p className="text-sm text-muted-foreground">{[generation.angle, generation.persona, source && !source.assetUrl ? `From ${source.name}` : null].filter(Boolean).join(" · ")}</p>{source?.assetUrl ? <SourceTile source={source} /> : null}</div>{generation.status === "generating" ? <Badge variant="secondary"><Loader2 className="animate-spin" /> {ready} of {generation.count}</Badge> : generation.status === "failed" ? <Button size="sm" variant="outline" disabled={retryGeneration.isPending} onClick={() => retryGeneration.mutate({ id: generation.id })}><RefreshCw /> Retry all</Button> : <Badge variant="secondary"><CheckCircle2 className="text-primary" /> {ready} ready</Badge>}</header><div className="grid grid-cols-2 gap-4 pb-8 sm:grid-cols-3 lg:grid-cols-4">{variants.map((variant) => <VariantView key={variant.id} variant={variant} aspectRatio={aspectRatio} pending={(mark.isPending && mark.variables?.variantId === variant.id) || (publish.isPending && publish.variables?.variantId === variant.id) || (retryVariant.isPending && retryVariant.variables?.variantId === variant.id)} onMark={(nextMark) => mark.mutate({ variantId: variant.id, mark: nextMark })} onPublish={() => publish.mutate({ variantId: variant.id, published: true })} onRetry={(withoutReferenceImage) => retryVariant.mutate({ variantId: variant.id, withoutReferenceImage })} onLinkChanged={() => queryClient.invalidateQueries({ queryKey: trpc.studio.generation.queryKey({ id: params.id }) })} />)}</div></div>;
}
