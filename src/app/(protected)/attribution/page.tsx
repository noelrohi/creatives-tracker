"use client";

import { useQuery } from "@tanstack/react-query";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useState } from "react";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { Skeleton } from "@/components/ui/skeleton";
import { BucketOrdersPanel } from "@/components/blocks/attribution/bucket-orders-panel";
import {
  page as copy,
  rangeLabels,
  waterfall as waterfallCopy,
  RANGE_PRESETS,
  type VoiceContext,
} from "@/components/blocks/attribution/copy";
import {
  DateRangeChips,
  resolveRange,
} from "@/components/blocks/attribution/date-range-chips";
import { addDays } from "@/components/blocks/attribution/days";
import { FindingsRail } from "@/components/blocks/attribution/findings-rail";
import { FirstLoadProgress } from "@/components/blocks/attribution/first-load";
import {
  ConnectionBanner,
  FreshnessCaption,
} from "@/components/blocks/attribution/freshness";
import {
  formatClock,
  formatDayRange,
  formatMoney,
} from "@/components/blocks/attribution/format";
import { HowWeCount } from "@/components/blocks/attribution/how-we-count";
import { MetaCheckCard } from "@/components/blocks/attribution/meta-check-card";
import { MobileFindingsSheet } from "@/components/blocks/attribution/mobile-findings-sheet";
import {
  connectionsUrl,
  merRangeUrl,
  salesOverTimeUrl,
} from "@/components/blocks/attribution/shopify-links";
import { Waterfall } from "@/components/blocks/attribution/waterfall";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { formatDateOnly } from "@/lib/date";
import { useTRPC } from "@/lib/trpc/client";

const BACKFILL_DAYS = 90;
const FIRST_LOAD_POLL_MS = 5_000;

export default function AttributionPage() {
  const trpc = useTRPC();
  const { role } = useActiveOrganizationRole();
  const canAct = role !== "member";

  useBreadcrumbs([{ label: copy.navLabel }]);

  const [preset, setPreset] = useQueryState(
    "range",
    parseAsStringLiteral(RANGE_PRESETS).withDefault("yesterday"),
  );
  const [customFrom, setCustomFrom] = useQueryState(
    "from",
    parseAsString.withDefault(""),
  );
  const [customTo, setCustomTo] = useQueryState(
    "to",
    parseAsString.withDefault(""),
  );
  const [openBucket, setOpenBucket] = useState<AttributionBucket | null>(null);

  /**
   * One cheap read to learn the store: its timezone, its currency and — the part
   * every range depends on — what "today" is where the store lives. The browser
   * clock is only used to ask the question, never to answer it.
   */
  const browserDay = formatDateOnly(new Date());
  const store = useQuery(
    trpc.attribution.overview.queryOptions({
      dateFrom: browserDay,
      dateTo: browserDay,
    }),
  );

  const today = store.data?.store.todayInStoreTz ?? null;
  const timeZone = store.data?.store.ianaTimezone ?? "UTC";
  const currency = store.data?.store.currency ?? "USD";
  const ctx: VoiceContext = { currency, timeZone };

  const range = today
    ? resolveRange(preset, today, { from: customFrom, to: customTo })
    : null;

  const overview = useQuery({
    ...trpc.attribution.overview.queryOptions({
      dateFrom: range?.dateFrom ?? browserDay,
      dateTo: range?.dateTo ?? browserDay,
    }),
    enabled: range !== null,
  });

  const metaCheck = useQuery({
    ...trpc.attribution.metaCheck.queryOptions({
      dateFrom: range?.dateFrom ?? browserDay,
      dateTo: range?.dateTo ?? browserDay,
    }),
    enabled: range !== null,
  });

  const syncStatus = useQuery({
    ...trpc.attribution.syncStatus.queryOptions(),
    refetchInterval: (query) =>
      query.state.data?.run?.result === "running" ? FIRST_LOAD_POLL_MS : false,
  });

  const run = syncStatus.data?.run ?? null;
  const isFirstLoad =
    syncStatus.isSuccess &&
    (run === null || (run.phase === "backfill" && run.result === "running"));

  /** Days of orders already landed, which is what "filling in" really means. */
  const backfillSeries = useQuery({
    ...trpc.attribution.dailySeries.queryOptions({
      dateFrom: today ? addDays(today, -(BACKFILL_DAYS - 1)) : browserDay,
      dateTo: today ?? browserDay,
    }),
    enabled: isFirstLoad && today !== null,
    refetchInterval: isFirstLoad ? FIRST_LOAD_POLL_MS : false,
  });

  const health = overview.data?.syncHealth ?? store.data?.syncHealth;
  const frozen = health?.shopify.stale ?? false;
  const metaDown = health?.meta.stale ?? false;
  const shopifyClock = formatClock(health?.shopify.lastSuccessAt, timeZone);

  const data = overview.data;
  const orderCount = data
    ? data.buckets.reduce((total, bucket) => total + bucket.orderCount, 0) +
      data.pending.count
    : 0;
  const totalMoney = data ? formatMoney(data.total, currency) : null;
  const pendingMoney = data
    ? formatMoney(data.pending.revenue, currency)
    : null;
  const shopifyReportUrl = range
    ? salesOverTimeUrl({
        shopDomain: store.data?.store.shopDomain,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
      })
    : null;

  const links = {
    metaVsShopify: merRangeUrl({
      dateFrom: range?.dateFrom ?? browserDay,
      dateTo: range?.dateTo ?? browserDay,
    }),
    connections: connectionsUrl(),
  };

  const railProps = {
    ctx,
    frozen,
    frozenClock: shopifyClock,
    lastCheckedClock: shopifyClock,
    totalMoney,
    canAct,
    firstLoad: isFirstLoad,
    links,
    onSeeOrders: (bucket: AttributionBucket) => setOpenBucket(bucket),
  };

  if (store.isError) {
    return (
      <p className="py-16 text-center text-[13px] text-muted-foreground">
        {copy.storeMissing}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-base font-semibold tracking-tight">{copy.title}</h1>
        <FreshnessCaption
          shopify={health?.shopify}
          meta={health?.meta}
          timeZone={timeZone}
          loading={store.isPending}
        />
      </div>

      {frozen ? <ConnectionBanner clock={shopifyClock} canAct={canAct} /> : null}

      <MobileFindingsSheet {...railProps} />

      <div className="grid min-w-0 gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4 min-[1100px]:max-w-[700px]">
          <section className="flex flex-col gap-3">
            {range && today ? (
              <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/60">
                {copy.kicker(
                  rangeLabels[preset],
                  formatDayRange(range.dateFrom, range.dateTo),
                  timeZone,
                )}
              </span>
            ) : (
              <Skeleton className="h-3 w-52" />
            )}

            <div className="flex flex-col gap-1">
              {overview.isPending || !range ? (
                <>
                  <Skeleton className="h-9 w-40" />
                  <Skeleton className="h-3.5 w-52" />
                </>
              ) : (
                <>
                  <span className="text-[32px] font-semibold tabular-nums leading-none tracking-tight">
                    {totalMoney ?? copy.noDataYet}
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {copy.heroSubtitle(orderCount)}
                    {frozen && shopifyClock ? (
                      <span
                        className="ml-1 font-medium"
                        style={{ color: "var(--attr-critical)" }}
                      >
                        {copy.correctUpTo(shopifyClock)}
                      </span>
                    ) : null}
                  </span>
                </>
              )}
            </div>

            <DateRangeChips
              preset={preset}
              range={range}
              today={today}
              onPreset={(next) => {
                void setPreset(next);
                setOpenBucket(null);
              }}
              onCustom={(from, to) => {
                void setCustomFrom(from);
                void setCustomTo(to);
                void setPreset("custom");
                setOpenBucket(null);
              }}
            />
          </section>

          {isFirstLoad ? (
            <FirstLoadProgress
              daysLoaded={backfillSeries.data?.days.length ?? 0}
              daysTotal={BACKFILL_DAYS}
            />
          ) : null}

          <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
            <Waterfall
              entries={data?.buckets ?? []}
              total={data?.total ?? "0"}
              currency={currency}
              selected={openBucket}
              onSelect={(bucket) =>
                setOpenBucket(openBucket === bucket ? null : bucket)
              }
              loading={overview.isPending || !range}
              dimmed={frozen}
            />

            {data ? (
              <div className="flex flex-col gap-1 border-t border-border/60 pt-3">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                  <span
                    style={{
                      color: data.identity.matches
                        ? "var(--attr-good)"
                        : "var(--attr-warning)",
                    }}
                  >
                    {waterfallCopy.addsUp(
                      formatMoney(data.identity.sumOfBuckets, currency) ??
                        copy.noDataYet,
                      formatMoney(data.identity.actual, currency) ??
                        copy.noDataYet,
                      data.identity.matches,
                    )}
                  </span>
                  {shopifyReportUrl ? (
                    <a
                      href={shopifyReportUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary hover:underline"
                    >
                      {waterfallCopy.checkInShopify}
                    </a>
                  ) : null}
                </span>

                {data.pending.count > 0 && pendingMoney ? (
                  <span className="text-[12px] text-muted-foreground">
                    {waterfallCopy.pending(data.pending.count, pendingMoney)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          {openBucket && range ? (
            <BucketOrdersPanel
              bucket={openBucket}
              dateFrom={range.dateFrom}
              dateTo={range.dateTo}
              currency={currency}
              timeZone={timeZone}
              onClose={() => setOpenBucket(null)}
            />
          ) : null}

          <MetaCheckCard
            data={metaCheck.data}
            loading={metaCheck.isPending || !range}
            metaDown={metaDown}
            currency={currency}
            detailHref={links.metaVsShopify}
          />

          <HowWeCount timeZone={timeZone} />
        </div>

        <aside className="hidden min-w-0 min-[1100px]:block">
          <FindingsRail {...railProps} variant="panel" />
        </aside>
      </div>
    </div>
  );
}
