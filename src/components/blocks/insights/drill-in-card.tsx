"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  formatMoneyExact,
  formatPercent,
} from "@/components/blocks/attribution/format";
import {
  UNMATCHED_KEY,
  type SliceDimension,
} from "@/lib/creative-insights-shared";
import { cn } from "@/lib/utils";
import { drill as copy, page, sliceValueLabel } from "./insights-copy";

export type DrillInAd = {
  adId: string;
  adName: string;
  spend: string;
  revenue: string;
  backPer1: number | null;
  clicks: number;
  landingPageViews: number;
  addToCart: number;
};

/** A ratio only exists when its denominator does — never a 0% standing in. */
function ratio(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return part / whole;
}

/**
 * The slice, opened: one row per ad, with the three-segment funnel from Meta's
 * modelled counts. The caption under the table stays put — these ratios compare
 * ads against each other, and nothing here is an absolute conversion rate.
 */
export function DrillInCard({
  dimension,
  value,
  ads,
  currency,
  loading = false,
  veiled = false,
}: {
  dimension: SliceDimension;
  value: string;
  ads: readonly DrillInAd[];
  currency: string;
  loading?: boolean;
  veiled?: boolean;
}) {
  const label = sliceValueLabel(dimension, value);

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
        <span className="text-[12.5px] font-semibold">{copy.title(label)}</span>
        {loading ? null : (
          <span className="text-[11px] text-muted-foreground">
            {copy.subtitle(ads.length)}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
      ) : ads.length === 0 ? (
        <p className="px-3 pb-4 text-[12px] text-muted-foreground">
          {value === UNMATCHED_KEY ? copy.emptyUnmatched : copy.empty}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-border text-[11px] font-medium text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">
                  {copy.columns.ad}
                </th>
                <th className="whitespace-nowrap px-3 py-1.5 text-right font-medium">
                  {copy.columns.spend}
                </th>
                <th className="whitespace-nowrap px-3 py-1.5 text-right font-medium">
                  {copy.columns.back}
                </th>
                <th className="whitespace-nowrap px-3 py-1.5 text-left font-medium">
                  {copy.columns.funnel}
                </th>
              </tr>
            </thead>
            <tbody>
              {ads.map((ad) => {
                const land = ratio(ad.landingPageViews, ad.clicks);
                const cart = ratio(ad.addToCart, ad.landingPageViews);
                const back =
                  ad.backPer1 === null
                    ? null
                    : formatMoneyExact(ad.backPer1, currency);

                return (
                  <tr
                    key={ad.adId}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="max-w-[18rem] truncate px-3 py-1.5">
                      {ad.adName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                      {formatMoneyExact(ad.spend, currency) ?? page.noDataYet}
                    </td>
                    <td
                      className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums"
                      style={
                        !veiled && ad.backPer1 !== null
                          ? {
                              color:
                                ad.backPer1 >= 2
                                  ? "var(--attr-good)"
                                  : "var(--attr-warning)",
                            }
                          : undefined
                      }
                    >
                      {veiled ? page.veiled : (back ?? page.noDataYet)}
                    </td>
                    <td className="px-3 py-1.5">
                      <FunnelTrio land={land} cart={cart} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="px-3 pb-3 pt-2 text-[11px] leading-relaxed text-muted-foreground/70">
        {copy.caption}
      </p>
    </section>
  );
}

function FunnelTrio({
  land,
  cart,
}: {
  land: number | null;
  cart: number | null;
}) {
  const landWidth = land === null ? 0 : Math.min(1, land) * 100;
  const cartWidth =
    land === null || cart === null ? 0 : Math.min(1, land) * Math.min(1, cart) * 100;
  const title = copy.ratios({
    land: formatPercent(land) ?? page.noDataYet,
    cart: formatPercent(cart) ?? page.noDataYet,
  });

  return (
    <span
      className="flex w-[7rem] flex-col gap-[2px]"
      title={title}
      aria-label={title}
    >
      {[
        { key: "click", width: 100, opacity: 0.35 },
        { key: "land", width: landWidth, opacity: 0.65 },
        { key: "cart", width: cartWidth, opacity: 1 },
      ].map((segment) => (
        <span
          key={segment.key}
          aria-hidden
          className={cn("h-1.5 rounded-full")}
          style={{
            width: `${Math.max(segment.width, 2)}%`,
            opacity: segment.opacity,
            backgroundColor: "var(--attr-known)",
          }}
        />
      ))}
    </span>
  );
}
