"use client";

import { useState } from "react";
import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/client";
import {
  campaigns as campaignCopy,
  findingHeadline,
  folds as copy,
  howWeCount,
  page,
  rail as railCopy,
} from "./copy";
import { CampaignTable, type CampaignLedgerData } from "./campaign-table";
import {
  FindingsBody,
  FindingsStatusFooter,
  useFindingsState,
  type FindingsContext,
} from "./findings-content";
import { HowWeCountList } from "./how-we-count";
import { MetaCheckDetail } from "./meta-check-card";
import { TodaysChecks } from "./todays-checks";
import { formatMoneyExact } from "./format";

type MetaCheckData = RouterOutputs["attribution"]["metaCheck"];
type FoldKey = "attention" | "meta" | "campaigns" | "how";

/**
 * Everything that used to shout from a right-hand rail and two cards, folded
 * into four rows. Each summary carries its own answer, so on a quiet morning
 * none of them has to be opened.
 */
export function DetailFolds({
  findings,
  metaCheck,
  metaLoading,
  metaDown,
  campaignLedger,
  campaignsLoading,
  currency,
  timeZone,
  detailHref,
  frozenClock,
  lastCheckedClock,
}: {
  findings: FindingsContext;
  metaCheck: MetaCheckData | undefined;
  metaLoading: boolean;
  metaDown: boolean;
  campaignLedger: CampaignLedgerData | undefined;
  campaignsLoading: boolean;
  currency: string;
  timeZone: string;
  detailHref: string;
  frozenClock: string | null;
  lastCheckedClock: string | null;
}) {
  const [open, setOpen] = useState<FoldKey | null>(null);
  const state = useFindingsState();
  const { items, checks, checksLoading, hasCritical, isPending } = state;

  const attentionSummary = findings.firstLoad
    ? copy.attentionFirstLoad
    : findings.frozen
      ? copy.attentionFrozen
      : isPending
        ? null
        : items.length > 0
          ? copy.attentionOpen(
              items.length,
              findingHeadline(items[0], findings.ctx),
            )
          : copy.attentionAllClear(checks?.length ?? 5);

  const confirmed = metaCheck
    ? formatMoneyExact(metaCheck.verifiedRevenue, currency)
    : null;
  const claimed =
    metaCheck && !metaDown
      ? formatMoneyExact(metaCheck.claims.claimed, currency)
      : null;
  const back =
    metaCheck && !metaDown
      ? formatMoneyExact(metaCheck.verifiedRoas, currency)
      : null;

  const metaSummary = metaLoading
    ? null
    : confirmed
      ? copy.metaSummary(claimed, confirmed, back)
      : copy.metaSummaryNoData;

  const campaignSummary =
    campaignsLoading || metaDown
      ? null
      : campaignSummaryFor(campaignLedger, currency);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <Fold
        foldKey="attention"
        title={copy.attention}
        summary={attentionSummary}
        open={open === "attention"}
        onToggle={setOpen}
        badge={
          items.length > 0 ? (
            <Badge
              variant="outline"
              className="h-5 rounded-full px-2 text-[11px] tabular-nums"
              style={
                hasCritical
                  ? {
                      backgroundColor: "var(--attr-critical-soft)",
                      borderColor: "var(--attr-critical)",
                      color: "var(--attr-critical)",
                    }
                  : undefined
              }
            >
              {items.length}
            </Badge>
          ) : null
        }
      >
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">
          {findings.frozen
            ? frozenClock
              ? railCopy.frozen(frozenClock)
              : railCopy.frozenNoClock
            : lastCheckedClock
              ? railCopy.checked(lastCheckedClock)
              : railCopy.checkedNoStamp}
        </p>
        <div className="overflow-hidden rounded-sm border border-border">
          <FindingsBody state={state} context={findings} />
          <TodaysChecks items={checks} loading={checksLoading} />
          <FindingsStatusFooter
            state={state}
            className="border-t border-border px-3 py-2"
          />
        </div>
      </Fold>

      <Fold
        foldKey="meta"
        title={copy.meta}
        summary={metaSummary}
        open={open === "meta"}
        onToggle={setOpen}
      >
        <MetaCheckDetail
          data={metaCheck}
          loading={metaLoading}
          metaDown={metaDown}
          currency={currency}
          detailHref={detailHref}
        />
      </Fold>

      <Fold
        foldKey="campaigns"
        title={campaignCopy.title}
        summary={campaignSummary}
        open={open === "campaigns"}
        onToggle={setOpen}
      >
        <CampaignTable
          data={campaignLedger}
          loading={campaignsLoading}
          metaDown={metaDown}
          currency={currency}
        />
      </Fold>

      <Fold
        foldKey="how"
        title={howWeCount.trigger}
        summary={copy.howSummary}
        open={open === "how"}
        onToggle={setOpen}
        last
      >
        <HowWeCountList timeZone={timeZone} />
      </Fold>
    </div>
  );
}

/**
 * The worst payback, named — the line that means the fold need not be opened.
 * The rows arrive worst-first, so the first one is the answer; a campaign that
 * spent and sold nothing says that outright instead of reading "$0.00 back".
 */
function campaignSummaryFor(
  data: CampaignLedgerData | undefined,
  currency: string,
): string | null {
  const worst = data?.campaigns[0];
  if (!worst) return null;

  const count = data.campaigns.length;

  if (worst.orderCount === 0 && worst.spend !== null) {
    const spent = formatMoneyExact(worst.spend, currency);
    if (spent) return campaignCopy.summaryNoBack(worst.name, spent, count);
  }

  const back = formatMoneyExact(worst.roas, currency);
  return back ? campaignCopy.summary(worst.name, back, count) : null;
}

function Fold({
  foldKey,
  title,
  summary,
  badge,
  open,
  onToggle,
  last = false,
  children,
}: {
  foldKey: FoldKey;
  title: string;
  summary: string | null;
  badge?: React.ReactNode;
  open: boolean;
  onToggle: (next: FoldKey | null) => void;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(!last && "border-b border-border")}>
      <button
        type="button"
        onClick={() => onToggle(open ? null : foldKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[12.5px] font-semibold">{title}</span>
        {badge}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {summary ?? page.noDataYet}
        </span>
      </button>

      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}
