"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { paybackColor } from "./colors";
import { campaigns as copy } from "./copy";
import { formatMoneyExact } from "./format";
import { NoDataChip } from "./meta-check-card";

export type CampaignLedgerData = RouterOutputs["attribution"]["campaignLedger"];
type CampaignRow = CampaignLedgerData["campaigns"][number];

/**
 * The body of the "Campaign by campaign" fold: one row per campaign, worst
 * payback first, because the decision this screen exists for is which campaign
 * to cut. The unresolved row sits at the bottom so the rows above it plus that
 * one still add up to the Meta ads total in the ledger.
 *
 * On a phone the table scrolls inside its own container — the page itself never
 * moves sideways.
 */
export function CampaignTable({
  data,
  loading,
  metaDown,
  currency,
}: {
  data: CampaignLedgerData | undefined;
  loading: boolean;
  metaDown: boolean;
  currency: string;
}) {
  if (loading || !data) {
    return (
      <div className="flex flex-col gap-2 py-1">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  if (data.campaigns.length === 0 && !data.unresolved) {
    return (
      <p className="py-6 text-center text-[12px] text-muted-foreground/60">
        {copy.empty}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full min-w-[38rem] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground/50">
              <th scope="col" className="px-3 py-1.5 text-left font-normal">
                {copy.columns.campaign}
              </th>
              <Head>{copy.columns.spent}</Head>
              <Head>{copy.columns.metaSays}</Head>
              <Head>{copy.columns.weConfirm}</Head>
              <Head>{copy.columns.back}</Head>
            </tr>
          </thead>

          <tbody>
            {data.campaigns.map((row) => (
              <CampaignRowCells
                key={row.campaignId}
                row={row}
                goal={data.roasTarget}
                metaDown={metaDown}
                currency={currency}
              />
            ))}

            {data.unresolved ? (
              <UnresolvedRowCells
                row={data.unresolved}
                metaDown={metaDown}
                currency={currency}
              />
            ) : null}
          </tbody>
        </table>
      </div>

      {data.unresolved ? (
        <p className="text-[11px] text-muted-foreground/70">
          {copy.unresolvedNote(data.unresolved.orderCount)}
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground/60">
        {copy.footnote}
      </p>
    </div>
  );
}

function CampaignRowCells({
  row,
  goal,
  metaDown,
  currency,
}: {
  row: CampaignRow;
  goal: number;
  metaDown: boolean;
  currency: string;
}) {
  /**
   * Spend and the claim come from Meta; while that connection is down they are
   * unknown, not zero. What we confirm is read from our own Shopify orders, so
   * it survives a Meta outage.
   */
  const spent = metaDown ? null : formatMoneyExact(row.spend, currency);
  const metaSays = metaDown ? null : formatMoneyExact(row.claimed, currency);
  const back = metaDown ? null : formatMoneyExact(row.roas, currency);

  return (
    <tr className="border-b border-border/50 last:border-0">
      <th scope="row" className="max-w-0 px-3 py-2 text-left font-normal">
        <span className="block truncate">{row.name}</span>
        <span className="block truncate text-[10.5px] text-muted-foreground/60">
          {row.orderCount > 0 ? copy.orders(row.orderCount) : copy.noOrders}
        </span>
      </th>

      <Cell>{spent}</Cell>
      <Cell>{metaSays}</Cell>
      <Cell strong>{formatMoneyExact(row.confirmedRevenue, currency)}</Cell>
      <Cell
        strong
        color={metaDown ? undefined : paybackColor(row.roas, goal)}
      >
        {back}
      </Cell>
    </tr>
  );
}

/**
 * The last row: everything we could not put behind a campaign. Its spend is
 * real money Meta charged for an ad whose ad set has since gone, so it is
 * printed like any other figure rather than dashed out — the column has to add
 * up to the Meta total above. There is no payback to state for it.
 */
function UnresolvedRowCells({
  row,
  metaDown,
  currency,
}: {
  row: NonNullable<CampaignLedgerData["unresolved"]>;
  metaDown: boolean;
  currency: string;
}) {
  const spent = metaDown ? null : formatMoneyExact(row.spend, currency);
  const metaSays = metaDown ? null : formatMoneyExact(row.claimed, currency);

  return (
    <tr className="border-b border-border/50 text-muted-foreground/70 last:border-0">
      <th scope="row" className="max-w-0 px-3 py-2 text-left font-normal">
        <span className="block truncate">{copy.unresolvedLabel}</span>
        <span className="block truncate text-[10.5px] text-muted-foreground/60">
          {copy.orders(row.orderCount)}
        </span>
      </th>

      <Cell>{spent}</Cell>
      <Cell>{metaSays}</Cell>
      <Cell>{formatMoneyExact(row.confirmedRevenue, currency)}</Cell>
      <Cell>—</Cell>
    </tr>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-3 py-1.5 text-right font-normal">
      {children}
    </th>
  );
}

/** A missing Meta figure wears the chip; it is never printed as $0.00. */
function Cell({
  children,
  strong = false,
  color,
}: {
  children: React.ReactNode;
  strong?: boolean;
  color?: string;
}) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-2 text-right tabular-nums",
        strong && "font-semibold",
      )}
      style={color ? { color } : undefined}
    >
      {children ?? <NoDataChip />}
    </td>
  );
}
