"use client";

import { formatDistanceToNow } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { bucketColor } from "@/components/blocks/attribution/colors";
import { formatCentsMoney } from "@/components/blocks/attribution/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { isPrivilegedOrgRole } from "@/lib/organization-access";
import { toCents } from "@/lib/money";
import { useTRPC } from "@/lib/trpc/client";
import { googleAdsRevenue as copy } from "./copy";
import { GoogleAdsRevenuePanelTable } from "./revenue-panel-table";

/** Width helper for the share bar; ratio of cents, display-only. */
function widthPercent(partCents: number, totalCents: number): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  return Math.min(100, Math.max(0, (partCents / totalCents) * 100));
}

/**
 * Privileged-only panel: hiding it is UX, `orgAdminProcedure` on the query
 * remains the security boundary (same stance as EmailRevenuePanel). Unlike
 * the Klaviyo panel, a missing pilot connection is a normal, renderable
 * state here (`connection: null`) rather than a NOT_FOUND that hides the
 * section — the panel always shows, guiding admins toward connecting.
 */
export function GoogleAdsRevenuePanel({
  role,
  dateFrom,
  dateTo,
  currency,
  shopifyTotal,
}: {
  role: string | null;
  dateFrom: string;
  dateTo: string;
  currency: string;
  shopifyTotal: string | null;
}) {
  const trpc = useTRPC();
  const privileged = isPrivilegedOrgRole(
    role as Parameters<typeof isPrivilegedOrgRole>[0],
  );
  const panel = useQuery({
    ...trpc.googleAds.revenuePanel.queryOptions({ dateFrom, dateTo }),
    enabled: privileged,
    retry: false,
  });

  if (!privileged) return null;

  const data = panel.data;
  const connection = data?.connection ?? null;
  const googleCurrencyCode = data?.googleCurrencyCode ?? null;
  const googleCurrency = googleCurrencyCode ?? currency;
  const googleSays = data?.googleSays ?? null;
  const ourSide = data?.ourSide ?? null;

  const freshnessCaption =
    data === undefined
      ? null
      : connection?.lastFactsSyncedAt != null
        ? copy.freshness(
            formatDistanceToNow(new Date(connection.lastFactsSyncedAt), {
              addSuffix: true,
            }),
          )
        : connection === null
          ? copy.awaitingAccess
          : null;

  const noDataCaption =
    connection === null ? copy.awaitingAccess : copy.noRangeData;

  const sameCurrency =
    googleCurrencyCode === null || googleCurrencyCode === currency;
  const mixedCurrency = googleSays !== null && !sameCurrency;
  const currencySuffix = mixedCurrency ? ` ${googleCurrencyCode}` : "";

  const spendDisplay = googleSays
    ? `${formatCentsMoney(googleSays.spendCents, googleCurrency) ?? "—"}${currencySuffix}`
    : "—";

  const saysDisplay = googleSays
    ? `${formatCentsMoney(googleSays.conversionsValueCents, googleCurrency) ?? "—"}${currencySuffix}`
    : "—";

  // Cents arithmetic across currencies is meaningless (PHP cents minus USD
  // cents is not a PHP or USD figure) — the delta only makes sense when
  // Google's currency matches the store's, same gate as ROAS below.
  const deltaCents =
    googleSays && ourSide && sameCurrency
      ? googleSays.conversionsValueCents - ourSide.paidRevenueCents
      : null;
  const showDelta = deltaCents !== null && deltaCents > 0;
  const deltaDisplay = showDelta
    ? (formatCentsMoney(deltaCents, googleCurrency) ?? "—")
    : null;

  const spendPositive = googleSays !== null && googleSays.spendCents > 0;
  const roasEligible = spendPositive && sameCurrency && ourSide !== null;
  const roasClaims =
    roasEligible && googleSays
      ? (googleSays.conversionsValueCents / googleSays.spendCents).toFixed(2)
      : "—";
  const roasConfirm =
    roasEligible && googleSays && ourSide
      ? (ourSide.paidRevenueCents / googleSays.spendCents).toFixed(2)
      : "—";

  const shopifyTotalCents = shopifyTotal !== null ? toCents(shopifyTotal) : 0;
  const feedWidth = ourSide
    ? widthPercent(ourSide.feedRevenueCents, shopifyTotalCents)
    : 0;
  const paidWidth = ourSide
    ? widthPercent(ourSide.paidRevenueCents, shopifyTotalCents)
    : 0;
  const feedDisplay = ourSide
    ? (formatCentsMoney(ourSide.feedRevenueCents, currency) ?? "—")
    : "—";
  const paidDisplay = ourSide
    ? (formatCentsMoney(ourSide.paidRevenueCents, currency) ?? "—")
    : "—";
  const bucketDisplay = ourSide
    ? (formatCentsMoney(ourSide.bucketRevenueCents, currency) ?? "—")
    : "—";

  const insightText =
    googleSays && ourSide
      ? googleSays.conversions > 0 && ourSide.paidRevenueCents === 0
        ? copy.insight.untaggedPaid
        : ourSide.paidRevenueCents > 0 && sameCurrency
          ? copy.insight.delta(
              formatCentsMoney(googleSays.conversionsValueCents, googleCurrency) ??
                "—",
              formatCentsMoney(ourSide.paidRevenueCents, currency) ?? "—",
            )
          : null
      : null;

  return (
    <section className="rounded-md border border-border bg-card px-3 py-3 sm:px-4">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold tracking-tight">
          {copy.title}
        </h2>
        {freshnessCaption !== null ? (
          <span className="text-[10px] text-muted-foreground/70">
            {freshnessCaption}
          </span>
        ) : null}
      </div>
      {panel.isPending || shopifyTotal === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : panel.isError ? (
        <p className="text-[11px] text-muted-foreground">
          {copy.error}{" "}
          <Button size="sm" variant="ghost" onClick={() => void panel.refetch()}>
            {copy.retry}
          </Button>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex flex-wrap gap-x-7 gap-y-2">
              <div>
                <p
                  className="text-[20px] font-semibold tabular-nums"
                  data-testid="google-bucket-revenue"
                >
                  {bucketDisplay}
                </p>
                <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {copy.kpi.bucket}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {feedDisplay} {copy.kpi.feed} · {paidDisplay} {copy.kpi.paid}
                </p>
              </div>
              <div>
                <p
                  className="text-[20px] font-semibold tabular-nums"
                  data-testid="google-spend"
                >
                  {spendDisplay}
                </p>
                <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {copy.kpi.spend}
                </p>
              </div>
              <div>
                <p
                  className="text-[20px] font-semibold tabular-nums"
                  data-testid="google-says"
                >
                  {saysDisplay}
                </p>
                <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {copy.kpi.says}
                  <span
                    className="ml-1 normal-case tracking-normal"
                    data-testid="google-says-caption"
                  >
                    · {googleSays ? copy.kpi.saysCaption : noDataCaption}
                  </span>
                  {showDelta && deltaDisplay !== null ? (
                    <span
                      className="ml-1 text-amber-600"
                      data-testid="google-says-delta"
                    >
                      · {copy.kpi.saysUnconfirmed(deltaDisplay)}
                    </span>
                  ) : null}
                </p>
              </div>
              <div>
                <p
                  className="text-[20px] font-semibold tabular-nums"
                  data-testid="google-roas-claims"
                >
                  {roasClaims}
                </p>
                <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {copy.kpi.roasClaims}
                </p>
              </div>
              <div>
                <p
                  className="text-[20px] font-semibold tabular-nums"
                  data-testid="google-roas-confirm"
                >
                  {roasConfirm}
                </p>
                <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {copy.kpi.roasConfirm}
                  {mixedCurrency ? (
                    <span className="ml-1 text-amber-600">
                      · {copy.kpi.mixedCurrency}
                    </span>
                  ) : null}
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex h-5 overflow-hidden rounded">
              <div
                style={{
                  width: `${feedWidth}%`,
                  backgroundColor: bucketColor("google"),
                  opacity: 0.5,
                }}
              />
              <div
                style={{
                  width: `${paidWidth}%`,
                  backgroundColor: bucketColor("google"),
                }}
              />
              <div className="flex-1 bg-muted" />
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
              <span>
                <span
                  className="mr-1 inline-block size-2 rounded-[2px]"
                  style={{ backgroundColor: bucketColor("google"), opacity: 0.5 }}
                />
                {copy.kpi.feed} {feedDisplay}
              </span>
              <span>
                <span
                  className="mr-1 inline-block size-2 rounded-[2px]"
                  style={{ backgroundColor: bucketColor("google") }}
                />
                {copy.kpi.paid} {paidDisplay}
              </span>
            </div>
          </div>
          {googleSays && ourSide ? (
            <GoogleAdsRevenuePanelTable
              googleSays={googleSays}
              paidByCampaign={ourSide.paidByCampaign}
              currency={currency}
              googleCurrency={googleCurrency}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">{noDataCaption}</p>
          )}
          {insightText !== null ? (
            <div className="rounded-md border border-dashed border-amber-600/40 bg-amber-600/5 px-3 py-2 text-[11px]">
              {insightText}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
