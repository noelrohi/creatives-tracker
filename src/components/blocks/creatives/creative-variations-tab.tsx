"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { toast } from "sonner";
import { Check, ImageOff, Loader2, RefreshCw, Sparkles, X } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { studioAspectRatio, type StudioFormat } from "@/lib/studio-prompt";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import type { VariationAttempt, VariationPlan } from "@/lib/variation-agent-types";
import { cn } from "@/lib/utils";

type VariationItem = RouterOutputs["studio"]["variations"]["listForCreative"][number];

function RunSteps({ runId, accessToken, onUpdate, onSteps }: { runId: string; accessToken: string; onUpdate: () => unknown; onSteps: (runId: string, steps: string[]) => void }) {
  const { run } = useRealtimeRun(runId, { accessToken });
  useEffect(() => {
    const steps = (run?.metadata as Record<string, unknown> | undefined)?.steps;
    if (Array.isArray(steps)) onSteps(runId, steps.filter((step): step is string => typeof step === "string"));
  }, [run?.metadata, runId, onSteps]);
  // Step labels arrive over realtime; only a status transition changes what the
  // list query returns, and each refetch mints a public token per generating row.
  useEffect(() => {
    if (run?.status) void onUpdate();
  }, [run?.status, onUpdate]);
  return null;
}

// "claims" is a moderation reason on the variant row but is a prompt-safety
// stop, not an image block: retrying without the source would not help.
const IMAGE_BLOCKED_REASONS = new Set(["likeness", "logo", "moderation"]);

function failureCopy(reason: string | null, attempts: VariationAttempt[] | null) {
  if (reason === "likeness") return "Blocked: the source shows a real person's likeness";
  if (reason === "logo") return "Blocked: protected branding in the source";
  if (reason === "moderation") return "Blocked: the image model refused this request";
  if (reason === "claims") return "Stopped: the agent could not write a claims-safe prompt";
  const lastReview = attempts?.at(-1)?.review;
  if (lastReview && !lastReview.pass) return `Review rejected the image: ${lastReview.notes.join("; ") || "no notes"}`;
  return "Variation failed";
}

function PlanDisclosure({ plan }: { plan: VariationPlan }) {
  return (
    <details className="rounded-lg border text-xs">
      <summary className="cursor-pointer list-none px-3 py-2 font-medium [&::-webkit-details-marker]:hidden">
        What changed
      </summary>
      <div className="space-y-2 border-t p-3">
        <p>{plan.summary}</p>
        {plan.keptProductRegion ? (
          <p className="text-muted-foreground">Product kept from the source (masked edit).</p>
        ) : null}
        {plan.transplantedProduct ? (
          <p className="text-muted-foreground">
            {plan.transplantedProduct.patchSource === "asset"
              ? "Product transplanted from the product photo."
              : "Product transplanted from the source."}
          </p>
        ) : null}
        {plan.synthesized ? <p className="text-muted-foreground">The agent did not write a full plan for this image.</p> : null}
        {plan.changed.length ? <p><span className="font-medium">Changed:</span> {plan.changed.join("; ")}</p> : null}
        {plan.kept.length ? <p><span className="font-medium">Kept:</span> {plan.kept.join("; ")}</p> : null}
        {plan.rationale ? <p><span className="font-medium">Why:</span> {plan.rationale}</p> : null}
        {plan.inImageCopy.length ? <p><span className="font-medium">In-image copy:</span> {plan.inImageCopy.map((line) => `“${line}”`).join(" ")}</p> : null}
        {plan.evidence.length ? <p className="text-muted-foreground">Based on: {plan.evidence.map((entry) => entry.title).join(", ")}</p> : null}
      </div>
    </details>
  );
}

function VariationCard({ item, steps, pending, readOnly, onMark, onRetry, onUpdate, onSteps }: {
  item: VariationItem;
  steps: string[];
  pending: boolean;
  readOnly: boolean;
  onMark: (mark: "good" | "bad" | null) => void;
  onRetry: (withoutImage: boolean) => void;
  onUpdate: () => unknown;
  onSteps: (runId: string, steps: string[]) => void;
}) {
  const aspectRatio = studioAspectRatio(item.format as StudioFormat);
  const { variant } = item;
  const plan = variant.plan;
  const attempts = variant.attempts;
  // The agent may finish with an attempt the review rejected; say so on the card.
  const shippedReview = plan ? attempts?.find((a) => a.attempt === plan.finalAttempt)?.review : undefined;
  return (
    <article className="space-y-2">
      {item.realtime ? <RunSteps runId={item.realtime.runId} accessToken={item.realtime.publicAccessToken} onUpdate={onUpdate} onSteps={onSteps} /> : null}
      {variant.status === "failed" ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 p-4 text-center" style={{ aspectRatio }}>
          <ImageOff />
          <p className={cn("line-clamp-4 text-xs", variant.moderationReason && "text-destructive")}>{failureCopy(variant.moderationReason, attempts)}</p>
          <Button size="sm" variant="outline" disabled={pending || readOnly} onClick={() => onRetry(IMAGE_BLOCKED_REASONS.has(variant.moderationReason ?? ""))}>
            <RefreshCw /> {IMAGE_BLOCKED_REASONS.has(variant.moderationReason ?? "") ? "Retry without image" : "Retry"}
          </Button>
        </div>
      ) : variant.status !== "ready" || !variant.imageUrl ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-muted p-4 text-center" style={{ aspectRatio }}>
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{steps.at(-1) ?? "queued"}</p>
        </div>
      ) : (
        <>
          <div className={cn("relative overflow-hidden rounded-xl border ring-2 ring-transparent", variant.mark === "good" && "ring-emerald-500", variant.mark === "bad" && "opacity-45 ring-red-400")} style={{ aspectRatio }}>
            <img src={variant.imageUrl} alt="Generated variation" className="size-full object-cover" />
            {variant.publishedAt ? <Badge className="absolute right-2 top-2 bg-emerald-600">Published</Badge> : null}
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant={variant.mark === "good" ? "default" : "outline"} className="flex-1" disabled={pending || readOnly} onClick={() => onMark(variant.mark === "good" ? null : "good")}><Check /> Good</Button>
            <Button size="sm" variant={variant.mark === "bad" ? "destructive" : "outline"} className="flex-1" disabled={pending || readOnly} onClick={() => onMark(variant.mark === "bad" ? null : "bad")}><X /> Bad</Button>
          </div>
          {shippedReview && !shippedReview.pass ? (
            <p className="line-clamp-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Review flagged this image: {shippedReview.notes.join("; ") || "no notes"}
            </p>
          ) : null}
          {plan ? <PlanDisclosure plan={plan} /> : null}
          <Button asChild size="sm" variant="ghost" className="w-full"><Link href={`/studio/${item.id}`}>Open in Studio</Link></Button>
        </>
      )}
      {item.note ? <p className="text-[11px] text-muted-foreground">Note: {item.note}</p> : null}
    </article>
  );
}

export function CreativeVariationsTab({ creativeId, readOnly }: { creativeId: string; readOnly: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [stepsByRun, setStepsByRun] = useState<Record<string, string[]>>({});
  const list = useQuery({
    ...trpc.studio.variations.listForCreative.queryOptions({ creativeId }),
    refetchInterval: (state) => (state.state.data?.some((item) => item.status === "generating") ? 4000 : false),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.studio.variations.listForCreative.queryKey({ creativeId }) });
  const create = useMutation(trpc.studio.variations.create.mutationOptions({
    onSuccess: () => { setNote(""); toast.success("Variation queued"); void invalidate(); },
    onError: (error) => toast.error(error.message),
  }));
  const mark = useMutation(trpc.studio.setVariantMark.mutationOptions({ onSuccess: () => void invalidate(), onError: (error) => toast.error(error.message) }));
  const retry = useMutation(trpc.studio.retryVariant.mutationOptions({ onSuccess: () => { toast.success("Regenerating"); void invalidate(); }, onError: (error) => toast.error(error.message) }));
  // Stable identity so the realtime effect in RunSteps only reruns on actual run
  // changes. Step labels are append-only within a run and each run has its own
  // key, so an unchanged length means unchanged content.
  const handleSteps = useCallback((runId: string, steps: string[]) => {
    setStepsByRun((prev) => (prev[runId]?.length === steps.length ? prev : { ...prev, [runId]: steps }));
  }, []);

  if (list.isError) {
    return <p className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">{list.error.message.includes("not enabled") ? "Image Studio is not enabled for this workspace." : list.error.message}</p>;
  }

  const items = list.data ?? [];
  const button = (
    <Button size="sm" disabled={readOnly || create.isPending} onClick={() => create.mutate({ sourceCreativeId: creativeId, note: note.trim() || undefined })}>
      <Sparkles /> {create.isPending ? "Queuing…" : "Make Variation"}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={note} maxLength={500} aria-label="Variation note" placeholder="Optional note, e.g. try a testimonial angle" className="max-w-md" disabled={readOnly} onChange={(event) => setNote(event.target.value)} />
        {readOnly ? (
          <Tooltip>
            <TooltipTrigger asChild><span tabIndex={0} className="inline-flex">{button}</span></TooltipTrigger>
            <TooltipContent>Members have read-only access.</TooltipContent>
          </Tooltip>
        ) : button}
      </div>
      {list.isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="animate-spin" /></div>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No variations yet</EmptyTitle>
            <EmptyDescription>
              Make Variation asks the agent to study this ad against your brand guideline, resolution log, product facts, and testimonials, change one thing that the evidence supports, and explain what it did.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-4 pb-8 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <VariationCard
              key={item.id}
              item={item}
              steps={stepsByRun[item.realtime?.runId ?? ""] ?? []}
              pending={(mark.isPending && mark.variables?.variantId === item.variant.id) || (retry.isPending && retry.variables?.variantId === item.variant.id)}
              readOnly={readOnly}
              onMark={(next) => mark.mutate({ variantId: item.variant.id, mark: next })}
              onRetry={(withoutReferenceImage) => retry.mutate({ variantId: item.variant.id, withoutReferenceImage })}
              onUpdate={list.refetch}
              onSteps={handleSteps}
            />
          ))}
        </div>
      )}
    </div>
  );
}
