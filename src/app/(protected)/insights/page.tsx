"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  page as attributionCopy,
  RANGE_PRESETS,
  rangeLabels,
  type VoiceContext,
} from "@/components/blocks/attribution/copy";
import {
  DateRangeChips,
  resolveRange,
} from "@/components/blocks/attribution/date-range-chips";
import {
  formatMoneyExact,
  formatDayRange,
  formatPercent,
} from "@/components/blocks/attribution/format";
import {
  connectionsUrl,
  merRangeUrl,
} from "@/components/blocks/attribution/shopify-links";
import { DrillInCard } from "@/components/blocks/insights/drill-in-card";
import { InsightCards } from "@/components/blocks/insights/insight-cards";
import { InsightsFindings } from "@/components/blocks/insights/insights-findings";
import {
  ledger as ledgerCopy,
  dimensionLabels,
  page as copy,
} from "@/components/blocks/insights/insights-copy";
import { SliceLedger } from "@/components/blocks/insights/slice-ledger";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { SLICE_DIMENSIONS } from "@/lib/creative-insights-shared";
import { formatDateOnly } from "@/lib/date";
import { useTRPC } from "@/lib/trpc/client";

export default function CreativeInsightsPage() {
  const trpc = useTRPC();
  const { role } = useActiveOrganizationRole();
  const canAct = role !== "member";

  useBreadcrumbs([{ label: copy.navLabel }]);

  const [preset, setPreset] = useQueryState(
    "range",
    parseAsStringLiteral(RANGE_PRESETS).withDefault("last7"),
  );
  const [customFrom, setCustomFrom] = useQueryState(
    "from",
    parseAsString.withDefault(""),
  );
  const [customTo, setCustomTo] = useQueryState(
    "to",
    parseAsString.withDefault(""),
  );
  const [dimension, setDimension] = useQueryState(
    "slice",
    parseAsStringLiteral(SLICE_DIMENSIONS).withDefault("angle"),
  );
  const [openRow, setOpenRow] = useQueryState("row", parseAsString);

  /**
   * Coverage answers two things at once and needs no range of its own: what the
   * gate says, and what "today" is where the store lives. Every range below is
   * measured from that day, never from the browser clock.
   */
  const coverage = useQuery(trpc.creativeInsights.coverage.queryOptions());

  const today = coverage.data?.store.todayInStoreTz ?? null;
  const timeZone = coverage.data?.store.ianaTimezone ?? "UTC";
  const currency = coverage.data?.store.currency ?? "USD";
  const ctx: VoiceContext = { currency, timeZone };

  const range = today
    ? resolveRange(preset, today, { from: customFrom, to: customTo })
    : null;
  const rangeInput = {
    dateFrom: range?.dateFrom ?? formatDateOnly(new Date()),
    dateTo: range?.dateTo ?? formatDateOnly(new Date()),
  };

  const slices = useQuery({
    ...trpc.creativeInsights.slices.queryOptions({ ...rangeInput, dimension }),
    enabled: range !== null,
  });

  const cards = useQuery({
    ...trpc.creativeInsights.insightCards.queryOptions(rangeInput),
    enabled: range !== null,
  });

  const drillIn = useQuery({
    ...trpc.creativeInsights.drillIn.queryOptions({
      ...rangeInput,
      dimension,
      value: openRow ?? "",
    }),
    enabled: range !== null && Boolean(openRow),
  });

  const gated = coverage.data?.gated ?? false;
  const taggedShare = formatPercent(coverage.data?.share);
  const minShare = formatPercent(coverage.data?.minShare);

  const veil =
    gated && coverage.data && taggedShare && minShare
      ? {
          share: taggedShare,
          minShare,
          ads: coverage.data.topUntaggedAds.map((ad) => ({
            adId: ad.adId,
            adName: ad.adName,
            creativeId: ad.creativeId,
            spend: ad.spend,
          })),
        }
      : null;

  const untaggedShare =
    coverage.data?.share === null || coverage.data?.share === undefined
      ? null
      : formatPercent(1 - coverage.data.share);

  const alarm =
    gated && coverage.data && untaggedShare
      ? {
          untaggedShare,
          untaggedSpend:
            formatMoneyExact(coverage.data.untaggedSpend, currency) ??
            copy.noDataYet,
          totalSpend:
            formatMoneyExact(coverage.data.totalActiveSpend, currency) ??
            copy.noDataYet,
          adCount: coverage.data.untaggedAdCount,
          windowDays: coverage.data.windowDays,
        }
      : null;

  const links = {
    metaVsShopify: merRangeUrl(rangeInput),
    connections: connectionsUrl(),
  };

  if (coverage.isError) {
    return (
      <p className="py-16 text-center text-[13px] text-muted-foreground">
        {copy.storeMissing}
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-[15px] font-semibold tracking-tight">
          {copy.title}
        </h1>
        {taggedShare ? (
          <Link
            href="/insights/tagging-queue"
            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            {`${taggedShare} of active Meta spend tagged`}
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {range && today ? (
          <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/60">
            {attributionCopy.kicker(
              rangeLabels[preset],
              formatDayRange(range.dateFrom, range.dateTo),
              timeZone,
            )}
          </span>
        ) : (
          <Skeleton className="h-3 w-52" />
        )}

        <DateRangeChips
          preset={preset}
          range={range}
          today={today}
          onPreset={(next) => {
            void setPreset(next);
            void setOpenRow(null);
          }}
          onCustom={(from, to) => {
            void setCustomFrom(from);
            void setCustomTo(to);
            void setPreset("custom");
            void setOpenRow(null);
          }}
        />
      </div>

      {/* 1 — the answers */}
      <InsightCards
        cards={cards.data?.cards ?? []}
        alarm={alarm}
        currency={currency}
        minSpend={
          formatMoneyExact(cards.data?.minSpend, currency) ?? copy.noDataYet
        }
        veiled={gated}
        loading={cards.isPending || !range}
        onSeeDimension={(next) => {
          void setDimension(next);
          void setOpenRow(null);
        }}
      />

      {/* 2 — the full picture */}
      <section className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-[12.5px] font-semibold">{ledgerCopy.title}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {SLICE_DIMENSIONS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={dimension === key}
                onClick={() => {
                  void setDimension(key);
                  void setOpenRow(null);
                }}
                className={
                  dimension === key
                    ? "h-7 rounded-full border border-primary bg-primary px-3 text-[12px] font-medium text-primary-foreground"
                    : "h-7 rounded-full border border-border px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                }
              >
                {dimensionLabels[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="px-2 pb-3 sm:px-3">
          <SliceLedger
            rows={slices.data?.rows ?? []}
            dimension={dimension}
            currency={currency}
            selected={openRow}
            onSelect={(key) => void setOpenRow(openRow === key ? null : key)}
            loading={slices.isPending || !range}
            veil={veil}
          />
        </div>
      </section>

      {openRow ? (
        <DrillInCard
          dimension={dimension}
          value={openRow}
          ads={drillIn.data?.ads ?? []}
          currency={currency}
          loading={drillIn.isPending}
          veiled={gated}
        />
      ) : (
        <p className="px-1 text-[11px] text-muted-foreground/70">
          {ledgerCopy.caption}
        </p>
      )}

      {/* 3 — needs your attention */}
      <InsightsFindings ctx={ctx} canAct={canAct} links={links} />
    </div>
  );
}
