"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import type { RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { metaCheck as copy, page } from "./copy";
import { formatMoney, formatMoneyExact } from "./format";

type MetaCheckData = RouterOutputs["attribution"]["metaCheck"];

/** A missing Meta number is never printed as $0 — it wears this instead. */
export function NoDataChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground/80",
        className,
      )}
    >
      {page.noDataYet}
    </span>
  );
}

export function MetaCheckCard({
  data,
  loading,
  metaDown,
  currency,
  detailHref,
}: {
  data: MetaCheckData | undefined;
  loading: boolean;
  metaDown: boolean;
  currency: string;
  detailHref: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">{copy.title}</h2>
        <Link
          href={detailHref}
          className="text-[12px] font-medium text-primary hover:underline"
        >
          {copy.seeDetail}
        </Link>
      </div>

      {loading || !data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <MetaCheckBody data={data} metaDown={metaDown} currency={currency} />
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground/60">
        {copy.footnote}
      </p>
    </section>
  );
}

function MetaCheckBody({
  data,
  metaDown,
  currency,
}: {
  data: MetaCheckData;
  metaDown: boolean;
  currency: string;
}) {
  const confirmed = formatMoney(data.verifiedRevenue, currency);
  const metaSays = metaDown ? null : formatMoney(data.claims.claimed, currency);
  const spend = metaDown ? null : formatMoney(data.spend, currency);
  const back = metaDown ? null : formatMoneyExact(data.verifiedRoas, currency);
  const goal = formatMoneyExact(data.roasTarget, currency);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Figure label={copy.spendLabel} value={spend} />
        <Figure
          label={copy.metaSaysLabel}
          value={metaSays}
          tone="claim"
        />
        <Figure label={copy.weConfirmLabel} value={confirmed} tone="known" />
      </div>

      <p className="text-[13px] leading-relaxed">
        {metaSays && confirmed
          ? copy.claimSentence(metaSays, confirmed)
          : confirmed
            ? copy.claimSentenceNoData(confirmed)
            : null}
      </p>

      <p className="text-[13px] leading-relaxed">
        {back && goal ? (
          copy.paybackSentence(back, goal)
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            {copy.paybackUnknown}
            <NoDataChip />
          </span>
        )}
      </p>

      {data.verificationPendingCount > 0 ? (
        <p className="text-[12px] text-muted-foreground/70">
          {copy.pendingNote(data.verificationPendingCount)}
        </p>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: "claim" | "known";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/55">
        {label}
      </span>
      {value ? (
        <span
          className="text-[17px] font-semibold tabular-nums leading-none"
          style={
            tone
              ? {
                  color:
                    tone === "claim" ? "var(--attr-claim)" : "var(--attr-known)",
                }
              : undefined
          }
        >
          {value}
        </span>
      ) : (
        <NoDataChip className="self-start" />
      )}
    </div>
  );
}
