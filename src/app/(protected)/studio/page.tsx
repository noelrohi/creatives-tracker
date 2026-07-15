"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  FileVideo,
  Images,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { AwarenessLevel } from "@/lib/awareness";
import { isVideoFile } from "@/lib/studio-assets";
import { ELEMENT_LABELS } from "@/lib/studio-suggestions";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { StudioCreateDialog, type StudioDialogValue } from "./studio-create-dialog";

const RUN_FAILURE_STATUSES = new Set([
  "FAILED",
  "CANCELED",
  "CRASHED",
  "TIMED_OUT",
  "SYSTEM_FAILURE",
  "EXPIRED",
]);

/**
 * Subscribes to the refresh run and reports once when it settles. On hook
 * errors (e.g. realtime unavailable) it settles silently — the 8s home poll
 * still picks up the new queue.
 */
function RefreshRunWatcher({
  runId,
  accessToken,
  onSettled,
}: {
  runId: string;
  accessToken: string;
  onSettled: (outcome: "completed" | "failed" | "lost") => void;
}) {
  const { run, error } = useRealtimeRun(runId, { accessToken });
  const settledRef = useRef(false);
  const status = run?.status;
  useEffect(() => {
    if (settledRef.current) return;
    const outcome = error
      ? ("lost" as const)
      : status === "COMPLETED"
        ? ("completed" as const)
        : status && RUN_FAILURE_STATUSES.has(status)
          ? ("failed" as const)
          : null;
    if (!outcome) return;
    settledRef.current = true;
    onSettled(outcome);
  }, [status, error, onSettled]);
  return null;
}

const KIND_STYLES: Record<string, { label: string; className: string }> = {
  new_hooks: { label: "Try new hooks", className: "text-blue-500" },
  new_format: { label: "Try a new format", className: "text-emerald-500" },
  refresh: { label: "Refresh this winner", className: "text-amber-500" },
  rebrand_swipe: { label: "Rebrand a swipe", className: "text-violet-500" },
};

function elementLabel(key: string) {
  const label = (ELEMENT_LABELS as Record<string, string>)[key] ?? key;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function moderationMessage(reason: string | null) {
  if (reason === "likeness") {
    return "Blocked: the reference shows a real person's likeness";
  }
  if (reason === "logo") {
    return "Blocked: the reference contains protected branding";
  }
  if (reason) return "Blocked by image moderation";
  return "Generation failed";
}

type HomeCard = RouterOutputs["studio"]["home"]["cards"][number];
type LibraryItem = RouterOutputs["studio"]["home"]["library"][number];

function TodoCard({
  card,
  pending,
  onApprove,
  onEdit,
  onSkip,
  onSaveCopy,
}: {
  card: HomeCard;
  pending: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onSkip: () => void;
  onSaveCopy: () => void;
}) {
  const kind = KIND_STYLES[card.kind] ?? KIND_STYLES.refresh;
  const previewUrl = card.swipe?.imageUrl ?? card.source?.assetUrl;
  // The file type decides the element and the creative format decides the label.
  const previewIsVideoFile = isVideoFile(previewUrl);
  const isVideoAd =
    previewIsVideoFile || (!card.swipe && card.source?.format === "video");
  const numericRoas = card.roas == null ? null : Number(card.roas);
  const roasLabel =
    numericRoas != null && Number.isFinite(numericRoas)
      ? `${numericRoas.toFixed(1)}x`
      : null;
  const sourceName = card.swipe
    ? card.swipe.brandName?.trim() || "Saved swipe"
    : card.source?.name || "This week's performance";

  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Preview source creative for ${card.title}`}
              className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted text-muted-foreground outline-none ring-offset-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {previewUrl ? (
                <>
                  {previewIsVideoFile ? (
                    <video
                      src={previewUrl}
                      muted
                      playsInline
                      preload="metadata"
                      className="size-full object-cover"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="" className="size-full object-cover" />
                  )}
                  {isVideoAd ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/10">
                      <span className="flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
                        <FileVideo className="size-3.5" />
                      </span>
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="flex size-full items-center justify-center">
                  <Sparkles className="size-5" />
                </span>
              )}
              {roasLabel ? (
                <Badge className="absolute bottom-1 left-1 h-5 px-1.5 text-[10px] tabular-nums shadow-sm">
                  {roasLabel}
                </Badge>
              ) : null}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <div className="flex h-72 items-center justify-center overflow-hidden rounded-md bg-muted">
              {previewUrl ? (
                previewIsVideoFile ? (
                  <video
                    src={previewUrl}
                    controls
                    muted
                    playsInline
                    preload="metadata"
                    className="size-full object-contain"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewUrl}
                    alt={sourceName}
                    className="size-full object-contain"
                  />
                )
              ) : (
                <Sparkles className="size-8 text-muted-foreground" />
              )}
            </div>
            <div className="space-y-1 px-0.5 pb-0.5">
              {isVideoAd && !previewIsVideoFile ? (
                <p className="text-[10px] text-muted-foreground">
                  Video ad — showing its preview frame.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium">{sourceName}</p>
                {roasLabel ? (
                  <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                    {roasLabel} ROAS
                  </span>
                ) : null}
              </div>
              {card.hypothesis ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {card.hypothesis}
                </p>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-wider",
                  kind.className,
                )}
              >
                {kind.label}
              </p>
              <h2 className="mt-0.5 font-medium leading-snug">{card.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{card.whyLine}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Source: {sourceName}
                {roasLabel ? ` · ${roasLabel} ROAS` : ""}
              </p>
            </div>
            {card.sourceCreativeId ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="-mr-1 -mt-1 size-7 shrink-0 text-muted-foreground"
                    disabled={pending}
                    aria-label="More suggestion actions"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={onSaveCopy}>
                    Save copy as package
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          <details className="mt-3 rounded-lg border bg-muted/20 text-xs">
            <summary className="cursor-pointer list-none px-3 py-2 font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
              View production details
            </summary>
            <div className="space-y-2 border-t px-3 py-2.5">
              {card.brief ? (
                <p className="leading-relaxed text-muted-foreground">{card.brief}</p>
              ) : null}
              {card.elements ? (
                <div className="space-y-1">
                  {Object.entries(card.elements).map(([key, element]) =>
                    element ? (
                      <div key={key} className="grid grid-cols-[88px_52px_1fr] gap-2">
                        <span className="font-medium">{elementLabel(key)}</span>
                        <span className={element.action === "keep" ? "text-emerald-600" : "text-amber-600"}>
                          {element.action}
                        </span>
                        <span className="text-muted-foreground">
                          {element.value || (element.action === "keep" ? "From the reference" : "Replace")}
                        </span>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 border-t pt-2">
                <span className="font-medium">Copy</span>
                <span className="truncate text-muted-foreground">
                  {card.copyPackage?.name ?? "No package attached"}
                </span>
              </div>
            </div>
          </details>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" className="h-7 gap-1.5" disabled={pending} onClick={onApprove}>
              {pending ? <Loader2 className="animate-spin" /> : <Check />}
              Approve
            </Button>
            <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={pending} onClick={onEdit}>
              <Pencil /> Edit
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" disabled={pending} onClick={onSkip}>
              Skip
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function LibraryPanel({
  items,
  pendingId,
  onMark,
  onPublish,
  onRetry,
}: {
  items: LibraryItem[];
  pendingId?: string;
  onMark: (id: string, mark: "good" | "bad" | null) => void;
  onPublish: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <aside className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Images className="size-4" /> New in Library
        </h2>
        <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-xs">
          <Link href="/studio/library">View library <ArrowRight /></Link>
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
          Approved suggestions land here as images.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-3">
          {items.map((item) => {
            if (item.status === "pending" || item.status === "generating") {
              return (
                <div key={item.id} className="flex aspect-square animate-pulse items-center justify-center rounded-lg bg-muted">
                  <Loader2 className="animate-spin text-muted-foreground" />
                </div>
              );
            }
            if (item.status === "failed") {
              return (
                <div key={item.id} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-2 text-center">
                  <p className="text-xs font-medium text-destructive">
                    {moderationMessage(item.moderationReason)}
                  </p>
                  {item.moderationReason ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pendingId === item.id} onClick={() => onRetry(item.id)}>
                      <RefreshCw /> Retry without image
                    </Button>
                  ) : null}
                </div>
              );
            }
            return (
              <div key={item.id} className="space-y-1.5">
                <div className={cn("relative aspect-square overflow-hidden rounded-lg ring-2 ring-transparent", item.mark === "good" && "ring-emerald-500", item.mark === "bad" && "opacity-40 ring-red-400")}>
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="Generated ad" className="size-full object-cover" />
                  ) : null}
                  {item.publishedAt ? <Badge className="absolute right-1.5 top-1.5 bg-emerald-600 text-[9px]">Published</Badge> : null}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant={item.mark === "good" ? "default" : "outline"} className="h-6 flex-1 px-1 text-[11px]" disabled={pendingId === item.id} onClick={() => onMark(item.id, item.mark === "good" ? null : "good")}>
                    <Check /> Good
                  </Button>
                  <Button size="sm" variant={item.mark === "bad" ? "destructive" : "outline"} className="h-6 flex-1 px-1 text-[11px]" disabled={pendingId === item.id} onClick={() => onMark(item.id, item.mark === "bad" ? null : "bad")}>
                    <X /> Bad
                  </Button>
                </div>
                {item.mark === "good" && !item.publishedAt ? (
                  <button type="button" className="w-full text-center text-[10px] text-muted-foreground hover:underline" onClick={() => onPublish(item.id)}>
                    Mark as published
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function StudioHomeContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [compose, setCompose] = useQueryState("compose");
  const [editId, setEditId] = useQueryState("edit");
  const [remixId, setRemixId] = useQueryState("remix");
  const homeKey = trpc.studio.home.queryKey();
  const home = useQuery({ ...trpc.studio.home.queryOptions(), refetchInterval: 8000 });
  const packages = useQuery(trpc.studio.copyPackages.queryOptions());
  const remixSource = useQuery({
    ...trpc.studio.remixSource.queryOptions({ creativeId: remixId ?? "" }),
    enabled: remixId != null,
  });
  const remixError = remixId != null && remixSource.isError;
  useEffect(() => {
    if (!remixError) return;
    toast.error("That creative could not be loaded for remixing");
    void setRemixId(null);
  }, [remixError, setRemixId]);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: homeKey });

  const approve = useMutation(
    trpc.studio.approveSuggestion.mutationOptions({
      onSuccess: () => {
        toast.success("Approved — making images for Library");
        void invalidate();
        void setEditId(null);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const setStatus = useMutation(
    trpc.studio.setSuggestionStatus.mutationOptions({
      onSuccess: () => void invalidate(),
      onError: (error) => toast.error(error.message),
    }),
  );
  const [refreshRun, setRefreshRun] = useState<{
    runId: string;
    publicAccessToken: string;
  } | null>(null);
  const refresh = useMutation(
    trpc.studio.refreshSuggestions.mutationOptions({
      onSuccess: ({ runId, publicAccessToken, expiredCount }) => {
        toast.success(expiredCount ? `${expiredCount} old suggestions expired; building the new queue…` : "Building this week's queue…");
        setRefreshRun({ runId, publicAccessToken });
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const refreshing = refresh.isPending || refreshRun !== null;
  function settleRefresh(outcome: "completed" | "failed" | "lost") {
    setRefreshRun(null);
    void invalidate();
    if (outcome === "completed") toast.success("This week's queue is ready");
    if (outcome === "failed") toast.error("Suggestion refresh failed — try again");
  }
  const generate = useMutation(
    trpc.studio.generate.mutationOptions({
      onSuccess: () => {
        toast.success("Generation started — results will appear in Library");
        void setCompose(null);
        void setRemixId(null);
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const mark = useMutation(
    trpc.studio.setVariantMark.mutationOptions({
      onSuccess: () => void invalidate(),
      onError: (error) => toast.error(error.message),
    }),
  );
  const publish = useMutation(
    trpc.studio.setVariantPublished.mutationOptions({
      onSuccess: () => void invalidate(),
      onError: (error) => toast.error(error.message),
    }),
  );
  const saveCopy = useMutation(
    trpc.studio.createCopyPackageFromCreative.mutationOptions({
      onSuccess: () => {
        toast.success("Copy package saved");
        void queryClient.invalidateQueries({ queryKey: trpc.studio.copyPackages.queryKey() });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const retry = useMutation(
    trpc.studio.retryVariant.mutationOptions({
      onSuccess: () => {
        toast.success("Retrying from the written spec only");
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (home.isLoading) {
    return <div className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1fr_360px]"><div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div><Skeleton className="h-80 rounded-xl" /></div>;
  }

  const cards = home.data?.cards ?? [];
  const remixing = remixId != null ? remixSource.data : undefined;
  const proposed = cards.filter((card) => card.status === "proposed");
  const done = cards.filter((card) => card.status !== "proposed");
  const total = cards.length;
  const actioned = done.length;
  const editing = cards.find((card) => card.id === editId);
  const isColdStart = total === 0;

  function submitScratch(value: StudioDialogValue) {
    generate.mutate({
      brief: value.brief.trim(),
      format: value.format,
      count: value.count,
      referenceImageUrls: value.references.map((reference) => reference.url),
      copyPackageId: value.copyPackageId ?? undefined,
    });
  }

  return (
    <>
      {refreshRun ? (
        <RefreshRunWatcher
          runId={refreshRun.runId}
          accessToken={refreshRun.publicAccessToken}
          onSettled={settleRefresh}
        />
      ) : null}
      <div className="mx-auto grid w-full max-w-5xl gap-8 pb-8 lg:grid-cols-[1fr_360px]">
        <main className="space-y-6">
          <header className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">This week</h1>
              <p className="text-sm text-muted-foreground">
                {refreshing
                  ? "Building this week's queue…"
                  : isColdStart
                    ? "No suggestions yet"
                    : `${actioned} of ${total} actioned · refreshes Monday`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-8" onClick={() => setCompose("new")}>
                <Plus /> Start from scratch
              </Button>
              <Button size="sm" variant="outline" className="h-8" disabled={refreshing} onClick={() => refresh.mutate()}>
                <RefreshCw className={cn(refreshing && "animate-spin")} /> {refreshing ? "Refreshing…" : "Refresh now"}
              </Button>
            </div>
          </header>

          {(home.data?.expiredCount ?? 0) > 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Last week: {home.data?.expiredCount} unactioned suggestion{home.data?.expiredCount === 1 ? "" : "s"} expired.
            </p>
          ) : null}

          {isColdStart ? (
            <Empty className="rounded-xl border py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
                <EmptyTitle>Nothing here yet</EmptyTitle>
                <EmptyDescription>Suggestions are built from your ad performance and saved swipes. Sync an account or refresh to generate this week&apos;s queue.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button size="sm" disabled={refreshing} onClick={() => refresh.mutate()}><RefreshCw className={cn(refreshing && "animate-spin")} /> {refreshing ? "Building the queue…" : "Generate suggestions"}</Button></EmptyContent>
            </Empty>
          ) : proposed.length === 0 ? (
            <Empty className="rounded-xl border py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Check /></EmptyMedia>
                <EmptyTitle>You&apos;re done for this week</EmptyTitle>
                <EmptyDescription>Every suggestion is actioned. Review the results in Library, or add swipes for next week&apos;s queue.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button asChild size="sm" variant="outline"><Link href="/studio/swipes">Browse swipes <ArrowRight /></Link></Button></EmptyContent>
            </Empty>
          ) : (
            <div className="space-y-3">
              {proposed.map((card) => (
                <TodoCard
                  key={card.id}
                  card={card}
                  pending={approve.isPending && approve.variables?.id === card.id}
                  onApprove={() => approve.mutate({ id: card.id })}
                  onEdit={() => setEditId(card.id)}
                  onSkip={() => setStatus.mutate({ suggestionId: card.id, status: "skipped" })}
                  onSaveCopy={() => {
                    if (card.sourceCreativeId) {
                      saveCopy.mutate({ creativeId: card.sourceCreativeId });
                    }
                  }}
                />
              ))}
            </div>
          )}

          {done.length > 0 ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Done</h2>
              <div className="divide-y rounded-xl border bg-card/50">
                {done.map((card) => (
                  <div key={card.id} className="flex items-center gap-3 px-4 py-3">
                    {card.status === "skipped" ? (
                      <X className="text-muted-foreground" />
                    ) : card.generationStatus === "completed" ? (
                      <Check className="text-emerald-500" />
                    ) : card.generationStatus === "failed" ? (
                      <X className="text-destructive" />
                    ) : (
                      <Loader2 className="animate-spin text-muted-foreground" />
                    )}
                    <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">{card.title}</p>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {card.status === "skipped"
                        ? "skipped"
                        : card.generationStatus === "completed"
                          ? <Link href="/studio/library" className="inline-flex items-center gap-1">{card.count} images <ArrowRight /> Library</Link>
                          : card.generationStatus === "failed"
                            ? "generation failed"
                            : `making ${card.count} images…`}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </main>

        <LibraryPanel
          items={home.data?.library ?? []}
          pendingId={
            (mark.isPending ? mark.variables?.variantId : undefined) ??
            (publish.isPending ? publish.variables?.variantId : undefined) ??
            (retry.isPending ? retry.variables?.variantId : undefined)
          }
          onMark={(variantId, nextMark) => mark.mutate({ variantId, mark: nextMark })}
          onPublish={(variantId) => publish.mutate({ variantId, published: true })}
          onRetry={(variantId) => retry.mutate({ variantId, withoutReferenceImage: true })}
        />
      </div>

      {compose ? (
        <StudioCreateDialog
          key="scratch"
          open
          onOpenChange={(open) => { if (!open) void setCompose(null); }}
          pending={generate.isPending}
          copyPackages={packages.data ?? []}
          onSubmit={submitScratch}
        />
      ) : null}
      {remixing ? (
        <StudioCreateDialog
          key={`remix-${remixing.id}`}
          open
          title={`Remix "${remixing.name}"`}
          description="Generate fresh takes on this winner. It rides along as the reference image."
          initialValue={{
            brief: `Iterate on the winning ad "${remixing.name}". Keep what works and change one big thing.`,
            references:
              remixing.assetUrl && !isVideoFile(remixing.assetUrl)
                ? [{ url: remixing.assetUrl, label: remixing.name }]
                : [],
          }}
          copyPackages={packages.data ?? []}
          pending={generate.isPending}
          onOpenChange={(open) => { if (!open) void setRemixId(null); }}
          onSubmit={(value) => generate.mutate({
            brief: value.brief.trim(),
            format: value.format,
            count: value.count,
            referenceImageUrls: value.references.map((reference) => reference.url),
            copyPackageId: value.copyPackageId ?? undefined,
            sourceCreativeId: remixing.id,
            angle: remixing.angle ?? undefined,
            persona: remixing.persona ?? undefined,
            awarenessLevel:
              (remixing.awarenessLevel as AwarenessLevel | null) ?? undefined,
          })}
        />
      ) : null}
      {editing ? (
        <StudioCreateDialog
          key={editing.id}
          open
          title={editing.title}
          description="Adjust the brief, size, reference, or copy package before approval."
          initialValue={{
            brief: editing.brief ?? editing.title,
            format: isStudioFormatValue(editing.format),
            count: editing.count,
            references: editing.swipe?.imageUrl
              ? [{ url: editing.swipe.imageUrl, label: editing.swipe.brandName || "Swipe reference" }]
              : editing.source?.assetUrl
                ? [{ url: editing.source.assetUrl, label: editing.source.name }]
                : [],
            copyPackageId: editing.copyPackageId,
          }}
          copyPackages={packages.data ?? []}
          pending={approve.isPending}
          submitLabel={`Approve & generate ${editing.count} variants`}
          onOpenChange={(open) => { if (!open) void setEditId(null); }}
          onSubmit={(value) => approve.mutate({
            id: editing.id,
            brief: value.brief.trim(),
            format: value.format,
            count: value.count,
            copyPackageId: value.copyPackageId,
            referenceImageUrls: value.references.map((reference) => reference.url),
          })}
        />
      ) : null}
    </>
  );
}

function isStudioFormatValue(value: string) {
  return value as StudioDialogValue["format"];
}

export default function StudioPage() {
  return <Suspense><StudioHomeContent /></Suspense>;
}
