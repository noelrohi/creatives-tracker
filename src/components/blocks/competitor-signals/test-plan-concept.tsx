"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Shield,
  ThumbsDown,
  ThumbsUp,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { HOOK_FEEDBACK_REASONS } from "@/lib/competitor-signals/plan-feedback";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { adLibraryPageUrl } from "./ad-library";
import { AdPreviewStrip } from "./ad-preview-strip";
import { angleLabel, BUDGET_ROUTING_NOTE } from "./copy";
import { daysSince, initials } from "./display";
import { TestPlanFormatStatusSelect } from "./test-plan-status-select";
import type { TestPlanConcept as Concept } from "./types";

type HookRating = Concept["feedback"][number]["rating"];

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <p className="text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * The competitor ads this concept was written from. Evidence cluster ids
 * dangle after a re-fill (§3), so the strip renders only while the router can
 * still resolve them.
 */
function InspiredBy({ inspiration }: { inspiration: Concept["inspiration"] }) {
  if (!inspiration) return null;

  const days = daysSince(inspiration.oldestStartDate);

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
      {inspiration.previewAds.length > 0 && (
        <AdPreviewStrip
          ads={inspiration.previewAds}
          alt={`${inspiration.competitorName} ad`}
          thumbClassName="h-[68px] w-[54px] rounded-md"
          className="gap-1.5"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">
          Inspired by {inspiration.adCount} {inspiration.competitorName}{" "}
          {inspiration.adCount === 1 ? "ad" : "ads"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {inspiration.clusterLabel}
          {days !== null && ` · on air ${days} days`}
        </p>
      </div>
      <a
        href={adLibraryPageUrl(inspiration.metaPageId)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        View in Ad Library <ExternalLink className="size-3" />
      </a>
    </div>
  );
}

/** A comment author, on the same initials helper the competitor cards use. */
function Avatar({ name }: { name: string }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
      {initials(name)}
    </span>
  );
}

/**
 * One hook and everything said about it: the ad rows written against it (one
 * status chip each — an asymmetric survival renders a single chip), its copy
 * when the generator carried any, the rating, and the reasons behind a
 * thumbs-down.
 */
function HookRow({
  concept,
  hook,
  index,
}: {
  concept: Concept;
  hook: string;
  index: number;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const rate = useMutation(
    trpc.signals.rateTestPlanHook.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.signals.testPlan.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const ads = concept.ads.filter((ad) => ad.hook === hook);
  const copy = concept.hookCopy?.find((entry) => entry.hook === hook) ?? null;
  const feedback = concept.feedback.find((entry) => entry.hook === hook) ?? null;
  const rating = feedback?.rating ?? null;
  // Stored reasons come back as plain strings; only the fixture slugs are
  // renderable (or sendable), so anything else is dropped at this boundary.
  const reasons =
    rating === "down"
      ? HOOK_FEEDBACK_REASONS.map((reason) => reason.slug).filter((slug) =>
          (feedback?.reasons ?? []).includes(slug),
        )
      : [];

  // Pressing the lit thumb clears the rating: the row goes back to unrated
  // rather than forcing a person to pick the other side.
  const setRating = (next: NonNullable<HookRating>) =>
    rate.mutate({
      conceptId: concept.id,
      hook,
      rating: rating === next ? null : next,
      reasons: next === "down" && rating !== next ? reasons : [],
    });

  const toggleReason = (slug: (typeof reasons)[number]) =>
    rate.mutate({
      conceptId: concept.id,
      hook,
      rating: "down",
      reasons: reasons.includes(slug)
        ? reasons.filter((value) => value !== slug)
        : [...reasons, slug],
    });

  return (
    <div className="border-t px-6 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-4 shrink-0 text-[13px] tabular-nums text-muted-foreground/70">
          {index + 1}
        </span>
        {/* 14px medium: the hook is the thing being judged, not a table cell. */}
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{hook}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {ads.map((ad) => (
            <TestPlanFormatStatusSelect key={ad.id} ad={ad} />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Useful — ${hook}`}
            aria-pressed={rating === "up"}
            disabled={rate.isPending}
            className={cn(
              rating === "up" &&
                "bg-[var(--attr-good-soft)] text-[var(--attr-good)] hover:bg-[var(--attr-good-soft)] hover:text-[var(--attr-good)]",
            )}
            onClick={() => setRating("up")}
          >
            <ThumbsUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Not useful — ${hook}`}
            aria-pressed={rating === "down"}
            disabled={rate.isPending}
            className={cn(
              rating === "down" &&
                "bg-[var(--attr-critical-soft)] text-[var(--attr-critical)] hover:bg-[var(--attr-critical-soft)] hover:text-[var(--attr-critical)]",
            )}
            onClick={() => setRating("down")}
          >
            <ThumbsDown className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Old plans predate per-hook copy, so the strip simply is not there. */}
      {copy && (
        <div className="mt-1.5 flex flex-wrap items-start gap-3 pl-7">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-snug">
              {copy.headline}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {copy.description}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 font-normal">
            {copy.cta}
          </Badge>
        </div>
      )}

      {/* Reasons only answer "what's off?", so they live under the thumbs-down
       * and nowhere else — the server drops them when the rating leaves down.
       * Tinted critical, like the thumb that opened them: the uncoloured rule
       * governs the status steps, not the rating affordances. */}
      {rating === "down" && (
        <div className="mt-2.5 ml-7 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--attr-critical)]/25 bg-[var(--attr-critical)]/5 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">What&apos;s off?</p>
          {HOOK_FEEDBACK_REASONS.map((reason) => (
            <Button
              key={reason.slug}
              variant="outline"
              size="xs"
              aria-pressed={reasons.includes(reason.slug)}
              disabled={rate.isPending}
              className={cn(
                "rounded-full font-normal",
                reasons.includes(reason.slug) &&
                  "border-[var(--attr-critical)]/45 bg-[var(--attr-critical-soft)] text-foreground",
              )}
              onClick={() => toggleReason(reason.slug)}
            >
              {reason.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The concept's thread. It dies with the concept it hangs off — promoting a
 * comment to a plan rule is the only way to make a note outlive the next
 * generation, which is what the caption is telling the reader.
 */
function FeedbackThread({ concept }: { concept: Concept }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.signals.testPlan.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.signals.planRules.queryKey(),
    });
  };

  const addComment = useMutation(
    trpc.signals.addTestPlanComment.mutationOptions({
      onSuccess: () => {
        setDraft("");
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const promote = useMutation(
    trpc.signals.promoteCommentToRule.mutationOptions({
      onSuccess: invalidate,
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <div className="flex flex-col gap-3 border-t bg-muted/20 px-6 py-4">
      <div className="flex items-baseline gap-2">
        <p className="text-[13px] font-semibold">Feedback</p>
        <p className="text-xs text-muted-foreground">
          Read by the next plan run.
        </p>
      </div>

      {concept.comments.map((comment) => (
        <div key={comment.id} className="flex gap-2.5">
          <Avatar name={comment.authorName} />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {comment.authorName}
              </span>{" "}
              · {formatDistanceToNow(comment.createdAt, { addSuffix: true })}
            </p>
            <p className="text-[13px] leading-relaxed">{comment.text}</p>
            {comment.promotedRuleId ? (
              <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-[var(--attr-good)]/30 bg-[var(--attr-good-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--attr-good)]">
                <Check className="size-3" />
                Plan rule — applies to every future generation
              </span>
            ) : (
              <Button
                variant="link"
                size="xs"
                className="mt-0.5 h-auto px-0 text-xs text-muted-foreground"
                disabled={promote.isPending}
                onClick={() => promote.mutate({ commentId: comment.id })}
              >
                Make this a rule
              </Button>
            )}
          </div>
        </div>
      ))}

      <div className="flex flex-col items-end gap-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={addComment.isPending}
          aria-label={`Feedback on ${concept.title}`}
          placeholder="What should the next plan do differently?"
          className="min-h-16 text-[13px]"
        />
        <Button
          size="sm"
          disabled={draft.trim().length === 0 || addComment.isPending}
          onClick={() =>
            addComment.mutate({ conceptId: concept.id, text: draft.trim() })
          }
        >
          Post feedback
        </Button>
      </div>
    </div>
  );
}

/**
 * One concept: why it exists in one line, the competitor ads it came from, the
 * constraints it carries, then one row per hook — the ad rows written against
 * it collapse into per-format status chips, and the rating and copy sit with
 * the hook they belong to rather than in a separate column.
 */
export function TestPlanConcept({ concept }: { concept: Concept }) {
  const approved = concept.ads.filter((ad) => ad.status === "approved").length;

  return (
    <Card className="gap-0 py-0 overflow-hidden">
      <CardContent className="flex flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{concept.title}</h2>
          <Badge variant="outline">{angleLabel(concept.angle)}</Badge>
          <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
            {approved} of {concept.ads.length} approved
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Why this test
          </p>
          <p className="text-[13px] leading-relaxed">
            {concept.evidenceCitation}
          </p>
        </div>

        <InspiredBy inspiration={concept.inspiration} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Fact label="Who sees it">{concept.audience}</Fact>
          <Fact label="How we'll judge it">{concept.measurementPlan}</Fact>
        </div>

        {/* Product-claim risk only (§9) — a constraint on the copy, not a fault.
         * Collapsed by default: it is a standing constraint, not news. */}
        {concept.claimGuardrail && (
          <Collapsible className="rounded-lg border border-dashed">
            <CollapsibleTrigger className="group/guardrail flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-muted-foreground">
              <Shield className="size-3.5 shrink-0 opacity-60" />
              <span className="flex-1 font-medium text-foreground">
                Copy guardrail
              </span>
              <ChevronDown className="size-3.5 shrink-0 opacity-60 transition-transform group-data-[state=open]/guardrail:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="px-3 pb-2.5 pl-8 text-[13px] leading-relaxed text-muted-foreground">
                {concept.claimGuardrail}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>

      <div>
        {concept.hooks.map((hook, index) => (
          <HookRow key={hook} concept={concept} hook={hook} index={index} />
        ))}

        {/*
         * The budget-routing rule, on every concept without exception: §9 makes
         * it a deterministic fixture, so it is rendered from app code and never
         * from anything the generator returned.
         */}
        <p className="border-t px-6 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
          {BUDGET_ROUTING_NOTE}
        </p>
      </div>

      <FeedbackThread concept={concept} />
    </Card>
  );
}
