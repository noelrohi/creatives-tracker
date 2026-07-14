"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { awarenessDisplayLabel } from "@/lib/awareness";
import { fmtRoas } from "@/lib/fmt";
import type { SuggestionElements } from "@/lib/studio-suggestions";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

type SuggestionCard = RouterOutputs["studio"]["suggestions"]["cards"][number];
type SuggestionVariant = SuggestionCard["variants"][number];

type RefreshState = {
  baseline: number | null;
};

const KIND_STYLES = {
  new_hooks: { label: "Try new hooks", className: "text-blue-500" },
  new_format: { label: "Try a new format", className: "text-emerald-500" },
  refresh: { label: "Refresh this winner", className: "text-amber-500" },
} as const;

const ELEMENT_LABELS: Record<keyof SuggestionElements, string> = {
  headline: "Headline",
  heroImage: "Hero image",
  background: "Background",
  offer: "Offer",
  cta: "CTA",
};

function generatedAtValue(value: Date | string | null | undefined) {
  return value == null ? null : new Date(value).getTime();
}

function SuggestionSkeletons() {
  return (
    <div className="space-y-4">
      {[0, 1].map((index) => (
        <div key={index} className="overflow-hidden rounded-xl border bg-card">
          <div className="flex gap-4 p-4">
            <Skeleton className="size-14 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-7 w-16" />
          </div>
          <Skeleton className="mx-4 mb-4 h-4 w-4/5" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex gap-3 border-t p-4">
              <Skeleton className="mt-1 size-4" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ProductionDetails({ variant }: { variant: SuggestionVariant }) {
  const elements = Object.entries(variant.elements) as Array<
    [keyof SuggestionElements, SuggestionElements[keyof SuggestionElements]]
  >;

  return (
    <details className="group/details mt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open/details:rotate-90" />
        View production details
      </summary>
      <div className="mt-2 overflow-hidden rounded-lg border text-xs">
        {elements.map(([key, element]) => {
          const changed = element.action === "change";
          return (
            <div
              key={key}
              className={cn(
                "flex gap-2 border-t px-3 py-2 first:border-t-0",
                changed ? "bg-primary/5" : "text-muted-foreground",
              )}
            >
              <span className="w-20 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {ELEMENT_LABELS[key]}
              </span>
              <span
                className={cn(
                  "w-3 shrink-0 font-mono",
                  changed ? "text-primary" : "text-muted-foreground",
                )}
              >
                {changed ? "~" : "="}
              </span>
              <span className={cn("min-w-0", changed && "text-foreground")}>
                {element.value ??
                  (key === "heroImage"
                    ? "Keep — reuse the winner as the reference visual"
                    : "Keep from winner")}
              </span>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5 border-t bg-muted/30 px-3 py-2 font-mono text-[10px] text-muted-foreground">
          <span className="rounded border px-1.5 py-0.5">{variant.format}</span>
        </div>
      </div>
    </details>
  );
}

function VariantRow({
  variant,
  onStatus,
  onEdit,
  pending,
}: {
  variant: SuggestionVariant;
  onStatus: (status: "approved" | "skipped" | "suggested") => void;
  onEdit: () => void;
  pending: boolean;
}) {
  const approved = variant.status === "approved";
  const skipped = variant.status === "skipped";
  const generated = variant.status === "generated";

  return (
    <div
      className={cn(
        "relative flex gap-3 border-t px-4 py-4 transition-colors sm:gap-4",
        approved && "bg-primary/5 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        skipped && "opacity-50",
      )}
    >
      <span className="w-4 shrink-0 pt-1 font-mono text-[11px] text-muted-foreground">
        {variant.index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-semibold sm:text-[15px]",
            skipped && "text-muted-foreground line-through",
          )}
        >
          {variant.headline}
        </p>
        {skipped ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Skipped — we&apos;ll suggest fewer like this.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {variant.diffSummary}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground italic">
              <span className="mr-1.5 font-mono text-[9px] font-semibold tracking-wider not-italic">
                COPY
              </span>
              “{variant.copyLine}”
            </p>
            <ProductionDetails variant={variant} />
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-start">
        {generated ? (
          <Badge variant="secondary" className="gap-1 font-normal">
            Generated <Check className="size-3 text-primary" />
          </Badge>
        ) : (
          <>
            <Button
              size="sm"
              variant={approved ? "default" : "outline"}
              disabled={pending}
              onClick={() => onStatus(approved ? "suggested" : "approved")}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              <span className="hidden sm:inline">Approve</span>
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={onEdit}>
              <Pencil className="size-3.5" />
              <span className="hidden sm:inline">Edit</span>
            </Button>
            <Button
              size="sm"
              variant={skipped ? "secondary" : "ghost"}
              disabled={pending}
              onClick={() => onStatus(skipped ? "suggested" : "skipped")}
            >
              <X className="size-3.5" />
              <span className="hidden sm:inline">Skip</span>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SuggestionCardView({
  card,
  onStatus,
  onEdit,
  pendingVariantId,
}: {
  card: SuggestionCard;
  onStatus: (
    variantId: string,
    status: "approved" | "skipped" | "suggested",
  ) => void;
  onEdit: (variantId: string) => void;
  pendingVariantId?: string;
}) {
  const kind = KIND_STYLES[card.kind as keyof typeof KIND_STYLES] ?? KIND_STYLES.refresh;
  const approvedCount = card.variants.filter(
    (variant) => variant.status === "approved",
  ).length;
  const meta = [
    card.angle,
    card.awarenessLevel ? awarenessDisplayLabel(card.awarenessLevel) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 p-4 pb-3 sm:gap-4">
        <div className="relative size-14 shrink-0 overflow-hidden rounded-lg border bg-muted">
          {card.source?.assetUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.source.assetUrl}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <Sparkles className="absolute inset-0 m-auto size-5 text-muted-foreground" />
          )}
          <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center font-mono text-[8px] font-semibold tracking-widest text-white backdrop-blur-sm">
            WINNER
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-[10px] font-semibold uppercase tracking-[0.14em]",
              kind.className,
            )}
          >
            {kind.label}
          </p>
          <h2 className="mt-1 truncate text-sm font-semibold sm:text-base">
            {card.title}
          </h2>
          {meta ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <strong className="block font-mono text-lg font-semibold text-primary">
            {fmtRoas(card.roas)}
          </strong>
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground">
            ROAS
          </span>
        </div>
      </div>
      <p className="px-4 pb-4 text-sm leading-relaxed text-muted-foreground">
        {card.whyLine}
      </p>
      <div>
        {card.variants.map((variant) => (
          <VariantRow
            key={variant.id}
            variant={variant}
            pending={pendingVariantId === variant.id}
            onStatus={(status) => onStatus(variant.id, status)}
            onEdit={() => onEdit(variant.id)}
          />
        ))}
      </div>
      <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
        {approvedCount > 0 ? (
          <><span className="font-semibold text-primary">{approvedCount}</span> of {card.variants.length} approved</>
        ) : (
          <>0 of {card.variants.length} approved</>
        )}
      </div>
    </section>
  );
}

export function StudioSuggestions() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshState, setRefreshState] = useState<RefreshState | null>(null);

  const suggestionsQuery = useQuery({
    ...trpc.studio.suggestions.queryOptions(),
    refetchInterval: (query) => {
      if (!refreshState) return false;
      const generatedAt = generatedAtValue(query.state.data?.generatedAt);
      return generatedAt === refreshState.baseline ? 4000 : false;
    },
  });
  const suggestionsKey = trpc.studio.suggestions.queryKey();
  const statusMutation = useMutation(
    trpc.studio.setSuggestionStatus.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: suggestionsKey }),
      onError: (error) => toast.error(error.message),
    }),
  );
  const refreshMutation = useMutation(
    trpc.studio.refreshSuggestions.mutationOptions({
      onSuccess: (result) => {
        if (result.skipped) {
          toast.info("Suggestions were just refreshed.");
          return;
        }
        setRefreshState({
          baseline: generatedAtValue(suggestionsQuery.data?.generatedAt),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const generateMutation = useMutation(
    trpc.studio.generateApproved.mutationOptions({
      onSuccess: (result) => {
        toast.success(`Queued ${result.queued} ads — see Library`);
        void queryClient.invalidateQueries({ queryKey: suggestionsKey });
        void queryClient.invalidateQueries({
          queryKey: trpc.studio.generations.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  useEffect(() => {
    if (!refreshState) return;
    const timeout = window.setTimeout(() => setRefreshState(null), 90_000);
    return () => window.clearTimeout(timeout);
  }, [refreshState]);

  const cards = suggestionsQuery.data?.cards ?? [];
  const currentGeneratedAt = generatedAtValue(suggestionsQuery.data?.generatedAt);
  const isWaiting =
    refreshState != null && currentGeneratedAt === refreshState.baseline;
  const approvedCount = cards.reduce(
    (count, card) =>
      count + card.variants.filter((variant) => variant.status === "approved").length,
    0,
  );

  function refresh() {
    if (refreshMutation.isPending || isWaiting) return;
    refreshMutation.mutate();
  }

  return (
    <div className="mx-auto w-full max-w-3xl pb-28">
      <header className="relative py-5 text-center sm:py-8">
        {cards.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="absolute top-4 right-0 text-muted-foreground"
            disabled={refreshMutation.isPending || isWaiting}
            onClick={refresh}
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                (refreshMutation.isPending || isWaiting) && "animate-spin",
              )}
            />
            Refresh
          </Button>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          What should we make <span className="text-primary">this week</span>?
        </h1>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
          Your recent winners, turned into a short creative queue. Approve what
          you like, skip what you don&apos;t — we&apos;ll handle the production brief.
        </p>
      </header>

      {suggestionsQuery.isLoading || (cards.length === 0 && isWaiting) ? (
        <SuggestionSkeletons />
      ) : cards.length === 0 ? (
        <Empty className="min-h-72 flex-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Sparkles />
            </EmptyMedia>
            <EmptyTitle>No suggestions yet</EmptyTitle>
            <EmptyDescription>
              Turn your strongest recent ads into three focused iterations each.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
              disabled={refreshMutation.isPending}
              onClick={refresh}
            >
              {refreshMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Generate suggestions
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-4">
          {cards.map((card) => (
            <SuggestionCardView
              key={card.id}
              card={card}
              pendingVariantId={statusMutation.variables?.variantId}
              onStatus={(variantId, status) =>
                statusMutation.mutate({ variantId, status })
              }
              onEdit={(variantId) =>
                router.push(`/studio?suggestion=${variantId}`)
              }
            />
          ))}
        </div>
      )}

      {approvedCount > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-full border bg-background/90 p-2 pl-5 shadow-xl backdrop-blur-md">
          <span className="text-sm text-muted-foreground">
            <strong className="text-foreground">{approvedCount}</strong> approved ·
          </span>
          <Button
            className="rounded-full"
            disabled={generateMutation.isPending}
            onClick={() => generateMutation.mutate()}
          >
            {generateMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Generate {approvedCount} Approved {approvedCount === 1 ? "Ad" : "Ads"}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
