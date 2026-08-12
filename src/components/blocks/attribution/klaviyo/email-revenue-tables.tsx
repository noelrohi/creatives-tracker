"use client";

import { useState } from "react";
import type { EmailAttributionSummary } from "@/lib/klaviyo/email-attribution";
import { formatMoneyExact } from "@/components/blocks/attribution/format";
import { emailRevenue as copy } from "./copy";
import { centsOf } from "./email-revenue-math";

const headCell =
  "px-2 py-1 text-left text-[9px] uppercase tracking-[0.07em] text-muted-foreground";
const cell = "border-b border-border/40 px-2 py-1 text-[11px]";
const numCell = `${cell} text-right tabular-nums`;

const PRODUCTS_COLLAPSED_COUNT = 10;

/** "+48%" when Klaviyo says more than we confirm; null otherwise. */
function saysDeltaPercent(revenue: string, says: string | null): string | null {
  if (says === null) return null;
  const oursCents = centsOf(revenue);
  const saysCents = centsOf(says);
  if (oursCents <= 0 || saysCents <= oursCents) return null;
  return `+${Math.round(((saysCents - oursCents) / oursCents) * 100)}%`;
}

export function EmailRevenueTables({
  summary,
  currency,
}: {
  summary: EmailAttributionSummary;
  currency: string;
}) {
  const [productsExpanded, setProductsExpanded] = useState(false);
  const hiddenProductCount = productsExpanded
    ? 0
    : Math.max(0, summary.products.length - PRODUCTS_COLLAPSED_COUNT);
  const visibleProducts = productsExpanded
    ? summary.products
    : summary.products.slice(0, PRODUCTS_COLLAPSED_COUNT);
  return (
    <div className="flex flex-wrap gap-4">
      <div className="min-w-[260px] flex-1">
        <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {copy.sourcesHeading}
        </p>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={headCell}>Source</th>
              <th className={`${headCell} text-right`}>Orders</th>
              <th className={`${headCell} text-right`}>We confirm</th>
              <th className={`${headCell} text-right`}>Klaviyo says</th>
            </tr>
          </thead>
          <tbody>
            {summary.sources.map((source) => {
              const delta = saysDeltaPercent(
                source.revenue,
                source.klaviyoConversionValue,
              );
              return (
                <tr key={`${source.objectType}:${source.objectId}`}>
                  <td className={cell}>
                    {source.name || source.objectId}{" "}
                    <span className="text-muted-foreground">
                      {source.objectType}
                    </span>
                  </td>
                  <td className={numCell}>{source.orderCount}</td>
                  <td className={numCell}>
                    {formatMoneyExact(source.revenue, currency)}
                  </td>
                  <td
                    className={numCell}
                    data-testid={`source-${source.objectId}-says`}
                  >
                    {source.klaviyoConversionValue === null
                      ? "—"
                      : formatMoneyExact(
                          source.klaviyoConversionValue,
                          currency,
                        )}
                    {delta === null ? null : (
                      <span
                        className="ml-1 text-[10px] text-amber-600"
                        data-testid={`source-${source.objectId}-delta`}
                      >
                        {delta}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          {copy.saysWindowNote}
        </p>
      </div>
      <div className="min-w-[260px] flex-1">
        <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {copy.productsHeading}
        </p>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={headCell}>Product</th>
              <th className={`${headCell} text-right`}>Units</th>
              <th className={`${headCell} text-right`}>Orders</th>
              <th className={`${headCell} text-right`}>Order revenue</th>
            </tr>
          </thead>
          <tbody>
            {visibleProducts.map((product) => (
              <tr key={product.productKey}>
                <td className={cell}>{product.title}</td>
                <td className={numCell}>{product.units}</td>
                <td className={numCell}>{product.orderCount}</td>
                <td className={numCell}>
                  {formatMoneyExact(product.orderRevenue, currency)}
                </td>
              </tr>
            ))}
          </tbody>
          {hiddenProductCount > 0 ? (
            <tfoot>
              <tr>
                <td colSpan={4} className="px-0">
                  <button
                    type="button"
                    className="w-full py-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => setProductsExpanded(true)}
                  >
                    {copy.productsMore(hiddenProductCount)}
                  </button>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          {copy.productsRevenueNote}
        </p>
      </div>
    </div>
  );
}
