"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ledger as copy } from "../copy";
import { LedgerDayBars } from "./ledger-day-bars";
import { formatCount, formatCurrency, formatPercent, formatSentDay } from "./ledger-format";
import { LedgerFunnel } from "./ledger-funnel";
import type { LedgerDetailData } from "./ledger-types";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value, note, testId, tone }: { label: string; value: string; note?: string | null; testId?: string; tone?: "warn" }) {
  return (
    <div className="contents">
      <span className="text-muted-foreground">{label}</span>
      <span data-testid={testId} className={tone === "warn" ? "font-mono font-semibold text-amber-600" : "font-mono font-semibold"}>
        {value}
        {note ? <span className="ml-1 font-sans font-normal text-muted-foreground">{note}</span> : null}
      </span>
    </div>
  );
}

function rateNote(numerator: number | null, rate: number | null): string | null {
  return numerator == null ? null : formatPercent(rate);
}

export function LedgerDetailContent({ detail, onViewOrders }: { detail: LedgerDetailData; onViewOrders: () => void }) {
  const { object, klaviyo, rates, ours, reconciliation } = detail;
  const sent = formatSentDay(object.sentAt);
  const isFlow = object.objectType === "flow";
  const bouncedRate = klaviyo?.bounced == null || klaviyo.recipients == null || klaviyo.recipients <= 0 ? null : klaviyo.bounced / klaviyo.recipients;
  const spamRate = klaviyo?.spamComplaints == null || klaviyo.delivered == null || klaviyo.delivered <= 0 ? null : klaviyo.spamComplaints / klaviyo.delivered;

  return (
    <div className="space-y-4 text-[12px]">
      <header className="space-y-0.5">
        <h2 className="text-[14px] font-semibold">{object.name}</h2>
        {/* Each segment is its own span so tests and screen readers get one
            phrase per node ("ongoing", the subject) rather than one run-on. */}
        <p className="flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className="h-4 rounded px-1 font-mono text-[9px]">{isFlow ? copy.chips.flow : copy.chips.campaign}</Badge>
          {object.channel ? <span>{object.channel.toUpperCase()} ·</span> : null}
          <span>{sent ? copy.sheet.sentAt(sent) : copy.ongoing}</span>
          {object.subject ? <span>· {copy.sheet.subject(object.subject)}</span> : null}
        </p>
      </header>

      <Block title={copy.sheet.funnel}><LedgerFunnel detail={detail} /></Block>

      <Block title={copy.sheet.revenue}>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <Stat label={copy.sheet.weConfirm} value={formatCurrency(ours.revenue)} note={copy.sheet.weConfirmNote(ours.orderCount)} testId="we-confirm" />
          <Stat
            label={copy.sheet.klaviyoSays}
            value={formatCurrency(klaviyo?.conversionValue ?? null)}
            note={reconciliation.unconfirmedOrders != null && reconciliation.unconfirmedOrders > 0 ? copy.sheet.unconfirmed(reconciliation.unconfirmedOrders) : null}
            testId="klaviyo-says"
          />
          <Stat
            label={copy.sheet.perRecipient}
            value={formatCurrency(reconciliation.revenuePerRecipient)}
            note={reconciliation.averageOrderValue ? copy.sheet.aov(formatCurrency(reconciliation.averageOrderValue)) : null}
            testId="per-recipient"
          />
        </div>
      </Block>

      <Block title={copy.sheet.listImpact}>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <Stat label={copy.sheet.unsubscribed} value={formatCount(klaviyo?.unsubscribes ?? null)} note={rateNote(klaviyo?.unsubscribes ?? null, rates.unsubscribe)} testId="list-unsubscribed" tone={(klaviyo?.unsubscribes ?? 0) > 0 ? "warn" : undefined} />
          <Stat label={copy.sheet.spam} value={formatCount(klaviyo?.spamComplaints ?? null)} note={rateNote(klaviyo?.spamComplaints ?? null, spamRate)} testId="list-spam" />
          <Stat label={copy.sheet.bounced} value={formatCount(klaviyo?.bounced ?? null)} note={rateNote(klaviyo?.bounced ?? null, bouncedRate)} testId="list-bounced" />
        </div>
      </Block>

      <Block title={detail.ordersByDay.mode === "offset" ? copy.sheet.ordersByDayOffset : copy.sheet.ordersByDayCalendar}>
        <LedgerDayBars ordersByDay={detail.ordersByDay} />
        <Button variant="link" size="sm" className="h-auto p-0 text-[11.5px]" onClick={onViewOrders}>
          {copy.sheet.viewOrders}
        </Button>
      </Block>

      {detail.topProducts.length > 0 ? (
        <Block title={copy.sheet.topProducts}>
          <table className="w-full text-[11px]">
            <tbody>
              {detail.topProducts.map((product) => (
                <tr key={product.productKey} className="border-b border-border/60">
                  <td className="py-0.5 pr-2">{product.title}</td>
                  <td className="whitespace-nowrap py-0.5 pl-2 text-right font-mono tabular-nums">{formatCount(product.units)} units</td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatCurrency(product.orderRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ) : null}

      {detail.messages.length > 0 ? (
        <Block title={isFlow ? copy.sheet.emails : copy.sheet.variants}>
          <table className="w-full text-[11px]">
            <tbody>
              {detail.messages.map((message) => (
                <tr key={message.objectId} className="border-b border-border/60">
                  <td className="py-0.5 pr-2">
                    {message.name}
                    {message.subject ? (
                      <>
                        {" · "}
                        <span className="text-muted-foreground">{message.subject}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatPercent(message.rates.open)} open</td>
                  <td className="py-0.5 text-right font-mono tabular-nums">{formatCurrency(message.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ) : null}
    </div>
  );
}
