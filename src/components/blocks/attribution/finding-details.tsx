"use client";

/**
 * The drawers for the three creative-insights findings (spec §9). They render
 * inside the shared finding row, so the same detail appears wherever findings
 * are listed — the attribution screen and the insights screen both.
 *
 * The mismatch drawer is the one that does work: its confirm block writes the
 * landing page's stage through `landingPage.confirmStage`, which is the whole
 * human-confirm loop from §5 — no separate admin screen exists on purpose.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import {
  colderFunnelStages,
  isFunnelStage,
  type FunnelStage,
} from "@/components/blocks/funnel-stage-copy";
import { ExternalLink } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { drawers as copy, page, type FindingItem, type VoiceContext } from "./copy";
import { formatMoneyExact, formatPercent } from "./format";
import { managerAdUrl } from "./shopify-links";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function amount(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function pageUrl(normalizedUrl: string): string {
  return /^https?:\/\//i.test(normalizedUrl)
    ? normalizedUrl
    : `https://${normalizedUrl}`;
}

/** Just the path, for the question — the host is the same on every row. */
function pagePath(normalizedUrl: string): string {
  const withoutScheme = normalizedUrl.replace(/^https?:\/\//i, "");
  const slash = withoutScheme.indexOf("/");
  return slash === -1 ? withoutScheme : withoutScheme.slice(slash);
}

export function FindingDetail({
  item,
  ctx,
  canAct,
}: {
  item: FindingItem;
  ctx: VoiceContext;
  canAct: boolean;
}) {
  switch (item.type) {
    case "ad_lp_funnel_mismatch":
      return <MismatchDetail item={item} ctx={ctx} canAct={canAct} />;
    case "untagged_spend":
      return <UntaggedDetail item={item} ctx={ctx} />;
    case "utm_template_drift":
      return <DriftDetail item={item} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* ad_lp_funnel_mismatch — side by side, then settle it                */
/* ------------------------------------------------------------------ */

function MismatchDetail({
  item,
  ctx,
  canAct,
}: {
  item: FindingItem;
  ctx: VoiceContext;
  canAct: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState<FunnelStage | null>(null);
  const [picking, setPicking] = useState(false);

  const confirm = useMutation(
    trpc.landingPage.confirmStage.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.findings.list.pathFilter());
        void queryClient.invalidateQueries(trpc.landingPage.list.pathFilter());
      },
      onError: (error: { message: string }) => {
        // The optimistic stage was a promise we could not keep.
        setConfirmed(null);
        toast.error(error.message);
      },
    }),
  );

  const topAd = record(item.payload?.topAd);
  const others = list(item.payload, "offendingAds").slice(1);
  if (!topAd) return null;

  const adStage = isFunnelStage(topAd.adFunnelStage) ? topAd.adFunnelStage : null;
  const storedPageStage = isFunnelStage(topAd.pageFunnelStage)
    ? topAd.pageFunnelStage
    : null;
  const pageStage = confirmed ?? storedPageStage;
  const landingPageId = text(topAd, "landingPageId");
  const normalizedUrl = text(topAd, "normalizedUrl");
  const adName = text(topAd, "adName");
  const spend = formatMoneyExact(amount(topAd, "trailing7dSpend"), ctx.currency);
  const back = formatMoneyExact(
    amount(topAd, "trailing7dRevenue"),
    ctx.currency,
  );
  const land = amount(topAd, "trailing7dLandingPageViews");
  const adSource = text(topAd, "adFunnelStageSource");
  const pageStatus = text(topAd, "pageClassificationStatus");
  const settled = confirmed !== null || pageStatus === "confirmed";

  const submit = (stage: FunnelStage) => {
    if (!landingPageId) return;
    setConfirmed(stage);
    setPicking(false);
    confirm.mutate({ landingPageId, funnelStage: stage });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-sm border border-border p-2.5">
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
            {copy.mismatch.adTitle}
          </span>
          <span className="text-[12.5px] font-medium">
            {adName ?? page.noDataYet}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            {copy.mismatch.adTags(copy.stageName(adStage))}
            {adSource === "ai" ? <Pill>{copy.mismatch.adGuessPill}</Pill> : null}
          </span>
          {/* Spend, what came back, and how far people got — the three figures
              §9 asks for. Any one of them can be missing on a finding fired
              before it was recorded, and a missing figure is left out rather
              than printed as zero. */}
          {spend ? (
            <span className="text-[12px] text-muted-foreground">
              {copy.mismatch.adSpend(spend)}
            </span>
          ) : null}
          {back ? (
            <span className="text-[12px] text-muted-foreground">
              {copy.mismatch.adBack(back)}
            </span>
          ) : null}
          {land !== null ? (
            <span className="text-[12px] text-muted-foreground">
              {copy.mismatch.adLand(land)}
            </span>
          ) : null}
          {adName ? (
            <Link
              href={managerAdUrl({ adName })}
              className="text-[12px] font-medium text-primary hover:underline"
            >
              {copy.mismatch.seeAd}
            </Link>
          ) : null}
        </div>

        <div
          className="flex flex-col gap-1 rounded-sm border p-2.5"
          style={{
            borderColor:
              "color-mix(in oklab, var(--attr-warning) 45%, var(--border))",
            backgroundColor: "var(--attr-warning-soft)",
          }}
        >
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
            {copy.mismatch.pageTitle}
          </span>
          <span className="break-all text-[12.5px] font-medium">
            {normalizedUrl ?? page.noDataYet}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            {copy.mismatch.pageReads(copy.stageName(pageStage))}
            {settled ? (
              <Pill tone="good">{copy.mismatch.confirmedPill}</Pill>
            ) : (
              <Pill tone="warning">{copy.mismatch.unconfirmedPill}</Pill>
            )}
          </span>
          <span className="text-[12px] text-muted-foreground">
            {copy.mismatch.pageFor(pageStage)}
          </span>
        </div>
      </div>

      {landingPageId && storedPageStage && normalizedUrl ? (
        <div className="flex flex-col gap-2 rounded-sm border border-border p-2.5">
          <p className="text-[12.5px] font-medium">
            {copy.mismatch.question(pagePath(normalizedUrl), storedPageStage)}
          </p>

          {confirmed ? (
            <p className="text-[12px] text-muted-foreground">
              {copy.mismatch.saved(copy.stageName(confirmed))}
            </p>
          ) : picking ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-muted-foreground">
                {copy.mismatch.pick}
              </span>
              {colderFunnelStages(storedPageStage).map((stage) => (
                <Button
                  key={stage}
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[12px]"
                  disabled={!canAct || confirm.isPending}
                  onClick={() => submit(stage)}
                >
                  {copy.stageName(stage)}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[12px]"
                onClick={() => setPicking(false)}
              >
                {copy.mismatch.cancel}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={!canAct || confirm.isPending}
                onClick={() => submit(storedPageStage)}
              >
                {copy.mismatch.yes}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={
                  !canAct ||
                  confirm.isPending ||
                  colderFunnelStages(storedPageStage).length === 0
                }
                onClick={() => setPicking(true)}
              >
                {copy.mismatch.no}
              </Button>
              <a
                href={pageUrl(normalizedUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-1 text-[12px] font-medium text-primary hover:underline"
              >
                {copy.mismatch.visit}
                <ExternalLink className="size-3" />
              </a>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground/70">
            {copy.mismatch.sticks}
          </p>
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground/70">
            {copy.mismatch.others(others.length)}
          </span>
          {others.map((ad, index) => {
            const otherSpend = formatMoneyExact(
              amount(ad, "trailing7dSpend"),
              ctx.currency,
            );
            return (
              <span
                key={text(ad, "adId") ?? index}
                className="flex items-baseline justify-between gap-3 text-[12px]"
              >
                <span className="truncate">
                  {text(ad, "adName") ?? page.noDataYet}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {otherSpend
                    ? copy.mismatch.othersSpend(otherSpend)
                    : page.noDataYet}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* untagged_spend + utm_template_drift — the sentence chassis           */
/* ------------------------------------------------------------------ */

function UntaggedDetail({
  item,
  ctx,
}: {
  item: FindingItem;
  ctx: VoiceContext;
}) {
  const share = amount(item.payload, "share");
  const minShare = amount(item.payload, "taggedSpendMinShare");
  const untagged = formatMoneyExact(
    amount(item.payload, "untaggedSpend"),
    ctx.currency,
  );
  const total = formatMoneyExact(
    amount(item.payload, "totalActiveSpend"),
    ctx.currency,
  );
  const taggedShare = share === null ? null : formatPercent(1 - share);

  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted-foreground">
      {taggedShare ? (
        <span className="font-medium text-foreground">
          {copy.untagged.figures(
            taggedShare,
            formatPercent(minShare) ?? page.noDataYet,
          )}
        </span>
      ) : null}
      {untagged && total ? <span>{copy.untagged.spend(untagged, total)}</span> : null}
    </div>
  );
}

function DriftDetail({ item }: { item: FindingItem }) {
  const offenders = list(item.payload, "offenders");
  const samples = list(item.payload, "samples");

  return (
    <div className="flex flex-col gap-2 text-[12px] text-muted-foreground">
      {offenders.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground/70">
            {copy.drift.offenders}
          </span>
          {offenders.map((offender, index) => (
            <span
              key={text(offender, "adId") ?? `${index}`}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="truncate">
                {copy.drift.offenderName(
                  text(offender, "adName"),
                  text(offender, "rawUtmContent"),
                )}
                <span className="ml-1.5 text-muted-foreground/70">
                  {text(offender, "matchMethod") === "name"
                    ? copy.drift.methodName
                    : copy.drift.methodUnmatched}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">
                {copy.drift.offenderOrders(
                  amount(offender, "orderCount") ?? 0,
                )}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {samples.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground/70">
            {copy.drift.samples}
          </span>
          <span className="flex flex-wrap gap-1.5">
            {samples.map((sample, index) => (
              <code
                key={text(sample, "utmContent") ?? `${index}`}
                className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
              >
                {copy.drift.sample(
                  text(sample, "utmContent") ?? page.noDataYet,
                  amount(sample, "count") ?? 0,
                )}
              </code>
            ))}
          </span>
        </div>
      ) : null}

      <span>{copy.drift.fix}</span>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warning" | "good";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.06em]",
      )}
      style={
        tone === "warning"
          ? {
              color: "var(--attr-warning)",
              borderColor:
                "color-mix(in oklab, var(--attr-warning) 40%, transparent)",
              backgroundColor: "var(--attr-warning-soft)",
            }
          : tone === "good"
            ? {
                color: "var(--attr-good)",
                borderColor:
                  "color-mix(in oklab, var(--attr-good) 40%, transparent)",
                backgroundColor: "var(--attr-good-soft)",
              }
            : {
                color: "var(--muted-foreground)",
                borderColor: "var(--border)",
              }
      }
    >
      {children}
    </span>
  );
}
