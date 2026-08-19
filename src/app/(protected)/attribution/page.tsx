"use client";

import { useQuery } from "@tanstack/react-query";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useBreadcrumbs } from "@/components/breadcrumbs";
import { BUCKET_ORDER } from "@/components/blocks/attribution/buckets";
import { Skeleton } from "@/components/ui/skeleton";
import { BucketOrdersPanel } from "@/components/blocks/attribution/bucket-orders-panel";
import { ChannelLedger } from "@/components/blocks/attribution/channel-ledger";
import { paybackColor } from "@/components/blocks/attribution/colors";
import {
  page as copy,
  headerRail as railCopy,
  help,
  metaCheck as metaCopy,
  rangeLabels,
  RANGE_PRESETS,
  type VoiceContext,
} from "@/components/blocks/attribution/copy";
import {
  DateRangeChips,
  resolveRange,
} from "@/components/blocks/attribution/date-range-chips";
import { DetailFolds } from "@/components/blocks/attribution/detail-folds";
import { FirstLoadProgress } from "@/components/blocks/attribution/first-load";
import {
  ConnectionBanner,
  FreshnessCaption,
} from "@/components/blocks/attribution/freshness";
import {
  formatClock,
  formatDayRange,
  formatMoneyExact,
} from "@/components/blocks/attribution/format";
import { HeaderRail } from "@/components/blocks/attribution/header-rail";
import { MobileFindingsSheet } from "@/components/blocks/attribution/mobile-findings-sheet";
import {
  connectionsUrl,
  merRangeUrl,
  financeSummaryUrl,
} from "@/components/blocks/attribution/shopify-links";
import {
  addDays,
  dayCount,
} from "@/components/blocks/attribution/days";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import { KlaviyoLabLink } from "@/components/blocks/attribution/klaviyo/lab-link";
import { GoogleAdsLabLink } from "@/components/blocks/attribution/google-ads/lab-link";
import { GoogleAdsRevenuePanel } from "@/components/blocks/attribution/google-ads/revenue-panel";
import { EmailRevenuePanel } from "@/components/blocks/attribution/klaviyo/email-revenue-panel";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { formatDateOnly } from "@/lib/date";
import { useTRPC } from "@/lib/trpc/client";

const BACKFILL_DAYS = 90;
const FIRST_LOAD_POLL_MS = 5_000;

type BackfillProgress = { daysLoaded: number; daysTotal: number };

/** The `progress` object the backfill task writes onto its sync-run row. */
function readSyncRunProgress(
  meta: Record<string, unknown> | null | undefined,
): BackfillProgress | null {
  const progress = meta?.progress;
  if (!progress || typeof progress !== "object") return null;
  const { daysLoaded, daysTotal } = progress as Record<string, unknown>;
  if (typeof daysLoaded !== "number" || typeof daysTotal !== "number") {
    return null;
  }
  return { daysLoaded, daysTotal };
}

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
  /**
   * The open order panel lives in the URL, so a finding elsewhere can link
   * straight at the orders behind one channel on one day (§8).
   */
  const [openBucket, setOpenBucketState] = useQueryState(
    "bucket",
    parseAsStringLiteral(BUCKET_ORDER),
  );
  const setOpenBucket = (bucket: AttributionBucket | null) => {
    void setOpenBucketState(bucket);
  };

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

  const previousRange =
    range && preset !== "today"
      ? (() => {
          const days = dayCount(range.dateFrom, range.dateTo);
          const dateTo = addDays(range.dateFrom, -1);
          return {
            dateFrom: addDays(dateTo, -(days - 1)),
            dateTo,
            days,
          };
        })()
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

  const campaignLedger = useQuery({
    ...trpc.attribution.campaignLedger.queryOptions({
      dateFrom: range?.dateFrom ?? browserDay,
      dateTo: range?.dateTo ?? browserDay,
    }),
    enabled: range !== null,
  });

  const previousOverview = useQuery({
    ...trpc.attribution.overview.queryOptions({
      dateFrom: previousRange?.dateFrom ?? browserDay,
      dateTo: previousRange?.dateTo ?? browserDay,
    }),
    enabled: previousRange !== null,
  });

  const previousMetaCheck = useQuery({
    ...trpc.attribution.metaCheck.queryOptions({
      dateFrom: previousRange?.dateFrom ?? browserDay,
      dateTo: previousRange?.dateTo ?? browserDay,
    }),
    enabled: previousRange !== null,
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

  /**
   * Progress comes from the backfill's own `shopify_sync_run` row, written as
   * each Bulk Operation page lands — not inferred from the order rows.
   */
  const backfillProgress = readSyncRunProgress(run?.meta);

  const health = overview.data?.syncHealth ?? store.data?.syncHealth;
  const frozen = health?.shopify.stale ?? false;
  const metaDown = health?.meta.stale ?? false;
  const shopifyClock = formatClock(health?.shopify.lastSuccessAt, timeZone);

  const data = overview.data;
  const orderCount = data
    ? data.buckets.reduce((total, bucket) => total + bucket.orderCount, 0) +
      data.pending.count
    : 0;
  const totalMoney = data ? formatMoneyExact(data.total, currency) : null;
  const previousTotalMoney = previousOverview.data
    ? formatMoneyExact(previousOverview.data.total, currency)
    : null;
  /**
   * Spend and payback come from Meta; while that connection is down they are
   * unknown, not zero, so they wear the "no data yet" chip. What we confirm is
   * read from our own Shopify orders, so it survives a Meta outage.
   */
  const meta = metaDown ? undefined : metaCheck.data;
  const paybackMoney = meta ? formatMoneyExact(meta.verifiedRoas, currency) : null;
  const paybackSpend = meta ? formatMoneyExact(meta.spend, currency) : null;
  const paybackGoal = metaCheck.data
    ? formatMoneyExact(metaCheck.data.roasTarget, currency)
    : null;
  const paybackTone = paybackColor(meta?.verifiedRoas, meta?.roasTarget);
  const confirmedMoney = metaCheck.data
    ? formatMoneyExact(metaCheck.data.verifiedRevenue, currency)
    : null;
  const previousPaybackMoney = meta
    ? formatMoneyExact(previousMetaCheck.data?.verifiedRoas, currency)
    : null;
  const shopifyReportUrl = range
    ? financeSummaryUrl({
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

  const findingsContext = {
    ctx,
    frozen,
    canAct,
    firstLoad: isFirstLoad,
    totalMoney,
    links,
    onSeeOrders: (bucket: AttributionBucket) => setOpenBucket(bucket),
  };

  /**
   * The four figures, read left to right as the story: what came in, what went
   * out on Meta, what we could match, what came back. "Meta says" is not here —
   * it belongs to the Meta check fold, next to the footnote that explains it.
   */
  const railFigures = [
    {
      key: "net",
      value: totalMoney,
      label: `${railCopy.netSales} · ${railCopy.orders(orderCount)}`,
      sub:
        previousRange && previousTotalMoney
          ? copy.previousTotal(previousTotalMoney, previousRange.days)
          : null,
      help: help.netSales,
    },
    {
      key: "spend",
      value: paybackSpend,
      label: railCopy.spend,
    },
    {
      key: "confirm",
      value: confirmedMoney,
      label: railCopy.confirm,
      color: "var(--attr-known)",
      help: help.confirm,
    },
    {
      key: "back",
      value: paybackMoney,
      label: railCopy.back,
      color: paybackTone,
      sub:
        [
          paybackGoal ? metaCopy.goal(paybackGoal) : null,
          previousRange && previousPaybackMoney
            ? copy.previousBack(previousPaybackMoney, previousRange.days)
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ") || null,
      help: paybackMoney
        ? help.back(paybackMoney, paybackGoal)
        : help.backUnknown,
    },
  ];

  if (store.isError) {
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
        <div className="flex items-center gap-2">
          <KlaviyoLabLink role={role} />
          <GoogleAdsLabLink role={role} />
          <FreshnessCaption
            shopify={health?.shopify}
            meta={health?.meta}
            timeZone={timeZone}
            loading={store.isPending}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
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
      </div>

      {frozen ? <ConnectionBanner clock={shopifyClock} canAct={canAct} /> : null}

      <MobileFindingsSheet
        {...findingsContext}
        frozenClock={shopifyClock}
        lastCheckedClock={shopifyClock}
      />

      {isFirstLoad ? (
        <FirstLoadProgress
          daysLoaded={backfillProgress?.daysLoaded ?? 0}
          daysTotal={backfillProgress?.daysTotal ?? BACKFILL_DAYS}
        />
      ) : null}

      {/* The ledger: the four figures, the channels, and the tie-out that proves
          they add up — one panel, because they are one reading. */}
      <section className="overflow-hidden rounded-md border border-border bg-card">
        <HeaderRail
          figures={railFigures}
          loading={overview.isPending || metaCheck.isPending || !range}
          emptyLabel={copy.noDataYet}
        />

        <div className="px-2 py-3 sm:px-3">
          <ChannelLedger
            entries={data?.buckets ?? []}
            identity={data?.identity ?? null}
            pending={data?.pending ?? null}
            currency={currency}
            selected={openBucket}
            onSelect={(bucket) =>
              setOpenBucket(openBucket === bucket ? null : bucket)
            }
            loading={overview.isPending || !range}
            dimmed={frozen}
            shopifyReportUrl={shopifyReportUrl}
            renderDrawer={(bucket) =>
              range ? (
                <div className="px-1 pb-2 pt-1">
                  <BucketOrdersPanel
                    bucket={bucket}
                    dateFrom={range.dateFrom}
                    dateTo={range.dateTo}
                    currency={currency}
                    timeZone={timeZone}
                    shopDomain={store.data?.store.shopDomain ?? null}
                    onClose={() => setOpenBucket(null)}
                  />
                </div>
              ) : null
            }
          />
        </div>
      </section>

      {range ? (
        <EmailRevenuePanel
          role={role}
          dateFrom={range.dateFrom}
          dateTo={range.dateTo}
          currency={currency}
          shopifyTotal={data?.total != null ? String(data.total) : null}
        />
      ) : null}

      {range ? (
        <GoogleAdsRevenuePanel
          role={role}
          dateFrom={range.dateFrom}
          dateTo={range.dateTo}
          currency={currency}
          shopifyTotal={data?.total != null ? String(data.total) : null}
        />
      ) : null}

      <DetailFolds
        findings={findingsContext}
        metaCheck={metaCheck.data}
        metaLoading={metaCheck.isPending || !range}
        metaDown={metaDown}
        campaignLedger={campaignLedger.data}
        campaignsLoading={campaignLedger.isPending || !range}
        currency={currency}
        timeZone={timeZone}
        detailHref={links.metaVsShopify}
        frozenClock={frozen ? shopifyClock : null}
        lastCheckedClock={shopifyClock}
      />
    </div>
  );
}
