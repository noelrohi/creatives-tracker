"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { banner as bannerCopy, freshness as copy } from "./copy";
import { formatAge, formatClock } from "./format";

export type SourceHealth = {
  lastSuccessAt: Date | string | null;
  stale: boolean;
};

/** "Shopify: 12 min ago · Meta: 3 hrs ago", escalating when a source is quiet. */
export function FreshnessCaption({
  shopify,
  meta,
  timeZone,
  loading,
}: {
  shopify: SourceHealth | undefined;
  meta: SourceHealth | undefined;
  timeZone: string;
  loading: boolean;
}) {
  if (loading || !shopify || !meta) {
    return <Skeleton className="h-3.5 w-56" />;
  }

  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <SourceStamp
        label={copy.shopify}
        health={shopify}
        timeZone={timeZone}
        critical
      />
      <span className="text-muted-foreground/30">·</span>
      <SourceStamp label={copy.meta} health={meta} timeZone={timeZone} />
    </span>
  );
}

function SourceStamp({
  label,
  health,
  timeZone,
  critical = false,
}: {
  label: string;
  health: SourceHealth;
  timeZone: string;
  critical?: boolean;
}) {
  if (!health.stale) {
    const age = formatAge(health.lastSuccessAt);
    return (
      <span className="text-muted-foreground/70 tabular-nums">
        {age ? copy.fresh(label, age) : copy.never(label)}
      </span>
    );
  }

  const clock = formatClock(health.lastSuccessAt, timeZone);
  return (
    <span
      className="font-medium tabular-nums"
      style={{
        color: critical ? "var(--attr-critical)" : "var(--attr-warning)",
      }}
    >
      {clock ? copy.lost(label, clock) : copy.never(label)}
    </span>
  );
}

/**
 * Screen-wide banner while Shopify is quiet. The retry reaches for the open
 * connection finding, which is the only thing the API will re-run.
 */
export function ConnectionBanner({
  clock,
  canAct,
}: {
  clock: string | null;
  canAct: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.findings.list.queryOptions({ status: "open" }));
  const connectionFinding = list.data?.items.find(
    (item) => item.type === "sync_failure" && item.id !== null,
  );

  const rerun = useMutation(
    trpc.findings.rerunSync.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.findings.list.pathFilter());
        void queryClient.invalidateQueries(trpc.attribution.syncStatus.pathFilter());
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2"
      style={{
        borderColor: "var(--attr-critical)",
        backgroundColor: "var(--attr-critical-soft)",
      }}
    >
      <AlertTriangle
        className="size-4 shrink-0"
        style={{ color: "var(--attr-critical)" }}
      />
      <span
        className="text-[13px] font-semibold"
        style={{ color: "var(--attr-critical)" }}
      >
        {clock ? bannerCopy.title(clock) : bannerCopy.titleNoClock}
      </span>
      <span className="text-[12px] text-muted-foreground">
        {bannerCopy.body}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-7 bg-card px-2 text-[12px]"
        disabled={!canAct || !connectionFinding?.id || rerun.isPending}
        onClick={() =>
          connectionFinding?.id &&
          rerun.mutate({ findingId: connectionFinding.id })
        }
      >
        {bannerCopy.action}
      </Button>
    </div>
  );
}
