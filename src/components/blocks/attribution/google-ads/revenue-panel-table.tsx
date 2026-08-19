"use client";

import { formatCentsMoney, formatCount } from "@/components/blocks/attribution/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  PaidCampaignSlice,
  RevenuePanelSummary,
} from "@/lib/google-ads/revenue-panel";
import { googleAdsRevenue as copy } from "./copy";

const numCell = "text-right tabular-nums";

/**
 * Presentational only — the caller loads `RevenuePanelSummary` and hands it
 * down; this component does no fetching. Rows are already spend-sorted by
 * the server (`listCampaignFactsSummary`); "ours only" slices keep the
 * revenue-desc/name-asc/null-last order `loadOurSide` produced.
 */
export function GoogleAdsRevenuePanelTable({
  googleSays,
  paidByCampaign,
  currency,
  googleCurrency,
}: {
  googleSays: NonNullable<RevenuePanelSummary["googleSays"]>;
  paidByCampaign: PaidCampaignSlice[];
  currency: string;
  googleCurrency: string;
}) {
  const revenueByUtmCampaign = new Map<string, number>();
  for (const slice of paidByCampaign) {
    if (slice.utmCampaign !== null) {
      revenueByUtmCampaign.set(slice.utmCampaign, slice.revenueCents);
    }
  }

  const matchedUtmCampaigns = new Set(
    googleSays.byCampaign
      .map((row) => row.matchedUtmCampaign)
      .filter((utmCampaign): utmCampaign is string => utmCampaign !== null),
  );
  const oursOnly = paidByCampaign.filter(
    (slice) =>
      slice.utmCampaign === null || !matchedUtmCampaigns.has(slice.utmCampaign),
  );

  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        {copy.table.heading}
      </p>
      <div className="overflow-x-auto rounded-sm border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
              <TableHead className="text-right">Conv. value</TableHead>
              <TableHead className="text-right">We confirm</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {googleSays.byCampaign.map((row) => {
              const confirmedCents =
                row.matchedUtmCampaign !== null
                  ? (revenueByUtmCampaign.get(row.matchedUtmCampaign) ?? null)
                  : null;
              return (
                <TableRow key={row.campaignId}>
                  <TableCell>{row.campaignName}</TableCell>
                  <TableCell className={numCell}>
                    {formatCentsMoney(row.spendCents, googleCurrency) ?? "—"}
                  </TableCell>
                  <TableCell className={numCell}>
                    {formatCount(row.conversions)}
                  </TableCell>
                  <TableCell className={numCell}>
                    {formatCentsMoney(row.conversionsValueCents, googleCurrency) ??
                      "—"}
                  </TableCell>
                  <TableCell className={numCell}>
                    {confirmedCents === null
                      ? "—"
                      : (formatCentsMoney(confirmedCents, currency) ?? "—")}
                  </TableCell>
                </TableRow>
              );
            })}
            {oursOnly.length > 0 ? (
              <>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                  >
                    {copy.table.oursOnly}
                  </TableCell>
                </TableRow>
                {oursOnly.map((slice) => (
                  <TableRow
                    key={slice.utmCampaign ?? "__untagged__"}
                    className="text-muted-foreground"
                  >
                    <TableCell>{slice.utmCampaign ?? copy.table.untagged}</TableCell>
                    <TableCell className={numCell}>—</TableCell>
                    <TableCell className={numCell}>—</TableCell>
                    <TableCell className={numCell}>—</TableCell>
                    <TableCell className={cn(numCell, "text-foreground")}>
                      {formatCentsMoney(slice.revenueCents, currency) ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <p className="text-[10px] text-muted-foreground/70">
        {copy.table.feedFootnote}
      </p>
      <p className="text-[10px] text-muted-foreground/70">
        {copy.table.calendarCaption}
      </p>
    </div>
  );
}
