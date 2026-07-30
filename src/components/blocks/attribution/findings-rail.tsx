"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttributionBucket } from "@/lib/attribution-bucket";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import {
  rail as copy,
  severityByType,
  type FindingItem,
  type VoiceContext,
} from "./copy";
import { FindingRow } from "./finding-row";
import { TodaysChecks } from "./todays-checks";

type RailStatus = "open" | "handled" | "snoozed";

export type FindingsRailProps = {
  ctx: VoiceContext;
  frozen: boolean;
  frozenClock: string | null;
  lastCheckedClock: string | null;
  totalMoney: string | null;
  canAct: boolean;
  firstLoad: boolean;
  links: { metaVsShopify: string; connections: string };
  onSeeOrders: (bucket: AttributionBucket) => void;
  /** "panel" is the sticky desktop column; "sheet" fills the mobile sheet. */
  variant?: "panel" | "sheet";
};

/** Open findings only, and only when the page is not frozen out of them. */
export function useOpenFindingsCount(): { count: number; critical: boolean } {
  const trpc = useTRPC();
  const query = useQuery(trpc.findings.list.queryOptions({ status: "open" }));
  const items = query.data?.items ?? [];
  return {
    count: items.length,
    critical: items.some((item) => severityByType[item.type] === "critical"),
  };
}

export function FindingsRail({
  ctx,
  frozen,
  frozenClock,
  lastCheckedClock,
  totalMoney,
  canAct,
  firstLoad,
  links,
  onSeeOrders,
  variant = "panel",
}: FindingsRailProps) {
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

  const busy = resolve.isPending || mute.isPending || rerun.isPending;
  const items: FindingItem[] = list.data?.items ?? [];
  const hasCritical = items.some(
    (item) => severityByType[item.type] === "critical",
  );

  const headerSentence = frozen
    ? frozenClock
      ? copy.frozen(frozenClock)
      : copy.frozenNoClock
    : lastCheckedClock
      ? items.length === 0 && status === "open"
        ? copy.checkedAllClear(lastCheckedClock)
        : copy.checked(lastCheckedClock)
      : items.length === 0 && status === "open"
        ? copy.checkedNoStampAllClear
        : copy.checkedNoStamp;

  const checkItems = checks.data?.checks;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-card",
        variant === "panel" &&
          "sticky top-0 max-h-[calc(100svh-4.5rem)] rounded-md border border-border",
        variant === "sheet" && "h-full",
      )}
    >
      <div className="flex flex-col gap-1 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">
            {copy.title}
          </h2>
          {list.isPending ? (
            <Skeleton className="h-5 w-6 rounded-full" />
          ) : items.length > 0 ? (
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
          ) : null}
        </div>
        <p
          className="text-[11px]"
          style={{
            color: frozen ? "var(--attr-warning)" : "var(--muted-foreground)",
          }}
        >
          {headerSentence}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {firstLoad ? (
          <div className="flex flex-col gap-1 px-3 py-6 text-center">
            <span className="text-[13px] font-semibold">
              {copy.firstLoadTitle}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {copy.firstLoadBody}
            </span>
          </div>
        ) : list.isPending ? (
          <div className="flex flex-col gap-3 p-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          status === "open" ? (
            <AllClear checkCount={checkItems?.length ?? 5} totalMoney={totalMoney} />
          ) : (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground/60">
              {status === "handled"
                ? copy.footerHandled(0)
                : copy.footerSnoozed(0)}
            </p>
          )
        ) : (
          items.map((item, index) => {
            const key = item.id ?? `${item.type}:${index}`;
            return (
              <FindingRow
                key={key}
                item={item}
                expanded={openId === key}
                onToggle={() => setOpenId(openId === key ? null : key)}
                ctx={ctx}
                frozen={frozen}
                canAct={canAct && status === "open"}
                busy={busy}
                links={links}
                onSeeOrders={onSeeOrders}
                onResolve={() =>
                  item.id && resolve.mutate({ findingId: item.id })
                }
                onSnooze={() => mute.mutate({ type: item.type })}
                onRerun={() => item.id && rerun.mutate({ findingId: item.id })}
              />
            );
          })
        )}
      </div>

      <TodaysChecks items={checkItems} loading={checks.isPending} />

      <div className="flex items-center gap-3 border-t border-border px-3 py-2">
        <FooterLink
          label={copy.footerHandled(handled.data?.items.length ?? 0)}
          active={status === "handled"}
          onClick={() =>
            setStatus(status === "handled" ? "open" : "handled")
          }
        />
        <span className="text-muted-foreground/30">·</span>
        <FooterLink
          label={copy.footerSnoozed(snoozed.data?.items.length ?? 0)}
          active={status === "snoozed"}
          onClick={() =>
            setStatus(status === "snoozed" ? "open" : "snoozed")
          }
        />
      </div>
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
        active ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function AllClear({
  checkCount,
  totalMoney,
}: {
  checkCount: number;
  totalMoney: string | null;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
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
