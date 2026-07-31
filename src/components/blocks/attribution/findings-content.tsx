"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import {
  rail as copy,
  findingHeadline,
  severityByType,
  type FindingItem,
  type VoiceContext,
} from "./copy";
import { FindingRow } from "./finding-row";

export type RailStatus = "open" | "handled" | "snoozed";

/** What the findings list needs to know about the page it sits in. */
export type FindingsContext = {
  ctx: VoiceContext;
  frozen: boolean;
  canAct: boolean;
  firstLoad: boolean;
  totalMoney: string | null;
  links: { metaVsShopify: string; connections: string };
  onSeeOrders: (bucket: AttributionBucket) => void;
};

/**
 * Every query and mutation the findings need, in one place, so the desktop fold
 * and the mobile sheet drive the same actions rather than each growing their own.
 */
export function useFindingsState() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RailStatus>("open");
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery(trpc.findings.list.queryOptions({ status }));
  const handled = useQuery(
    trpc.findings.list.queryOptions({ status: "handled" }),
  );
  const snoozed = useQuery(
    trpc.findings.list.queryOptions({ status: "snoozed" }),
  );
  const checks = useQuery(trpc.findings.checks.queryOptions());

  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.findings.list.pathFilter());
    void queryClient.invalidateQueries(trpc.findings.checks.pathFilter());
  };
  const onError = (error: { message: string }) => toast.error(error.message);

  const resolve = useMutation(
    trpc.findings.markResolved.mutationOptions({ onSuccess: invalidate, onError }),
  );
  const mute = useMutation(
    trpc.findings.mute.mutationOptions({ onSuccess: invalidate, onError }),
  );
  const rerun = useMutation(
    trpc.findings.rerunSync.mutationOptions({ onSuccess: invalidate, onError }),
  );

  const items: FindingItem[] = list.data?.items ?? [];

  return {
    status,
    setStatus,
    openId,
    setOpenId,
    items,
    checks: checks.data?.checks,
    checksLoading: checks.isPending,
    isPending: list.isPending,
    handledCount: handled.data?.items.length ?? 0,
    snoozedCount: snoozed.data?.items.length ?? 0,
    busy: resolve.isPending || mute.isPending || rerun.isPending,
    hasCritical: items.some(
      (item) => severityByType[item.type] === "critical",
    ),
    resolve,
    mute,
    rerun,
  };
}

export type FindingsState = ReturnType<typeof useFindingsState>;

/** Open findings only — what the mobile bar and the fold summary count. */
export function useOpenFindingsCount(ctx: VoiceContext): {
  count: number;
  critical: boolean;
  headline: string | null;
} {
  const trpc = useTRPC();
  const query = useQuery(trpc.findings.list.queryOptions({ status: "open" }));
  const items = query.data?.items ?? [];
  const worst =
    items.find((item) => severityByType[item.type] === "critical") ?? items[0];

  return {
    count: items.length,
    critical: items.some((item) => severityByType[item.type] === "critical"),
    headline: worst ? findingHeadline(worst, ctx) : null,
  };
}

/** The list itself: first-load notice, skeletons, all-clear, or the rows. */
export function FindingsBody({
  state,
  context,
  className,
}: {
  state: FindingsState;
  context: FindingsContext;
  className?: string;
}) {
  const { ctx, frozen, canAct, firstLoad, totalMoney, links, onSeeOrders } =
    context;
  const { items, status, openId, setOpenId, busy, isPending, checks } = state;

  if (firstLoad) {
    return (
      <div className={cn("flex flex-col gap-1 px-3 py-6 text-center", className)}>
        <span className="text-[13px] font-semibold">{copy.firstLoadTitle}</span>
        <span className="text-[12px] text-muted-foreground">
          {copy.firstLoadBody}
        </span>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className={cn("flex flex-col gap-3 p-3", className)}>
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return status === "open" ? (
      <AllClear
        checkCount={checks?.length ?? 5}
        totalMoney={totalMoney}
        className={className}
      />
    ) : (
      <p
        className={cn(
          "px-3 py-6 text-center text-[12px] text-muted-foreground/60",
          className,
        )}
      >
        {status === "handled" ? copy.footerHandled(0) : copy.footerSnoozed(0)}
      </p>
    );
  }

  return (
    <div className={className}>
      {items.map((item, index) => {
        const key = item.id ?? `${item.type}:${index}`;
        return (
          <FindingRow
            key={key}
            item={item}
            expanded={openId === key}
            onToggle={() => setOpenId(openId === key ? null : key)}
            context={{
              ctx,
              frozen,
              canAct: canAct && status === "open",
              busy,
              links,
            }}
            handlers={{
              onSeeOrders,
              onResolve: () =>
                item.id && state.resolve.mutate({ findingId: item.id }),
              onSnooze: () => state.mute.mutate({ type: item.type }),
              onRerun: () =>
                item.id && state.rerun.mutate({ findingId: item.id }),
            }}
          />
        );
      })}
    </div>
  );
}

/** Handled · Snoozed, the two other lists the same rows live in. */
export function FindingsStatusFooter({
  state,
  className,
}: {
  state: FindingsState;
  className?: string;
}) {
  const { status, setStatus, handledCount, snoozedCount } = state;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <FooterLink
        label={copy.footerHandled(handledCount)}
        active={status === "handled"}
        onClick={() => setStatus(status === "handled" ? "open" : "handled")}
      />
      <span className="text-muted-foreground/30">·</span>
      <FooterLink
        label={copy.footerSnoozed(snoozedCount)}
        active={status === "snoozed"}
        onClick={() => setStatus(status === "snoozed" ? "open" : "snoozed")}
      />
    </div>
  );
}

function FooterLink({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "text-[11px] font-medium transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground/70 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function AllClear({
  checkCount,
  totalMoney,
  className,
}: {
  checkCount: number;
  totalMoney: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-8 text-center",
        className,
      )}
    >
      <span
        className="flex size-8 items-center justify-center rounded-full"
        style={{
          backgroundColor: "var(--attr-good-soft)",
          color: "var(--attr-good)",
        }}
      >
        <Check className="size-4" />
      </span>
      <span className="text-[13px] font-semibold">{copy.allClearTitle}</span>
      <span className="text-[12px] leading-relaxed text-muted-foreground">
        {totalMoney
          ? copy.allClearBody(checkCount, totalMoney)
          : copy.allClearBodyNoTotal(checkCount)}
      </span>
    </div>
  );
}
