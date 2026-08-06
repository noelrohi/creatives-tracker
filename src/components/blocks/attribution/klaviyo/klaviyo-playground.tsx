"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft } from "@/components/icons";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { useTRPC } from "@/lib/trpc/client";
import { ADVISORY_BANNER, LAB_VIEWS, type LabView } from "./copy";
import { CoverageSummary } from "./coverage-summary";
import { LabFilterBar } from "./filter-bar";
import { LabHeader } from "./lab-header";
import { OrderDetailSheet } from "./order-detail-sheet";
import { OrdersTable } from "./orders-table";
import { LabPanelState } from "./panel-state";
import { ProbePanel } from "./probe-panel";
import { ReportsTable } from "./reports-table";
import { SyncRunsPanel } from "./sync-runs-panel";
import { UnmatchedEventsTable } from "./unmatched-events-table";
import { resolveLabDayRange, useKlaviyoLabState } from "./use-klaviyo-lab-state";

const QUEUE_CONFIRMATION_MS = 30_000;

function clickInstant(): number {
  return Date.now();
}

const VIEW_LABELS: Record<LabView, string> = {
  orders: "Orders",
  unmatched: "Unmatched events",
  reports: "Reports",
  probe: "Probe & runs",
};

/**
 * Query/mutation orchestration only. URL state owns view/range/filters;
 * every broad evidence query stays disabled until the connection exists
 * and the latest durable probe is passed; inactive views are unmounted so
 * their queries cannot run accidentally.
 */
export function KlaviyoPlayground() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const lab = useKlaviyoLabState();
  const view = lab.state.view;

  const [queuedOperation, setQueuedOperation] = useState<{
    operation: string;
    at: number;
  } | null>(null);
  const [queuedRecompute, setQueuedRecompute] = useState<{
    triggerRunId: string;
    invocationFingerprint: string;
    at: number;
  } | null>(null);

  const health = useQuery(trpc.klaviyo.health.queryOptions());
  const probe = useQuery(trpc.klaviyo.probe.queryOptions());
  const syncRuns = useQuery({
    ...trpc.klaviyo.syncRuns.queryOptions({ limit: 20, cursor: null }),
    refetchInterval: (query) =>
      queuedOperation !== null ||
      query.state.data?.items.some((run) => run.status === "running")
        ? 5_000
        : false,
  });

  const matchInvocation = useQuery({
    ...trpc.klaviyo.matchInvocationStatus.queryOptions({
      triggerRunId: queuedRecompute?.triggerRunId ?? "",
    }),
    enabled: queuedRecompute !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 5_000 : false,
  });
  // Clear the recompute lock only for the same fingerprint reaching
  // published or terminal failed — never from failed-attempt counts.
  const invocationData = matchInvocation.data;
  useEffect(() => {
    if (queuedRecompute === null || !invocationData) return;
    if (
      invocationData.invocationFingerprint ===
        queuedRecompute.invocationFingerprint &&
      (invocationData.status === "published" ||
        invocationData.status === "failed")
    ) {
      const timer = setTimeout(() => {
        setQueuedRecompute(null);
        void queryClient.invalidateQueries();
      }, 0);
      return () => clearTimeout(timer);
    }
    if (invocationData.status !== "running") {
      const timer = setTimeout(
        () => {
          toast.message("Match confirmation delayed");
          setQueuedRecompute(null);
        },
        Math.max(0, queuedRecompute.at + QUEUE_CONFIRMATION_MS - Date.now()),
      );
      return () => clearTimeout(timer);
    }
  }, [invocationData, queuedRecompute, queryClient]);

  const invalidateEvidence = () => {
    void queryClient.invalidateQueries();
  };

  const markQueued = (operation: string) => {
    setQueuedOperation({ operation, at: clickInstant() });
  };
  const latestRunStart = syncRuns.data?.items[0]?.startedAt ?? null;
  useEffect(() => {
    if (queuedOperation === null) return;
    if (
      latestRunStart !== null &&
      new Date(latestRunStart).getTime() >= queuedOperation.at - 1000
    ) {
      const timer = setTimeout(() => setQueuedOperation(null), 0);
      return () => clearTimeout(timer);
    }
    // Bounded 30-second confirmation window: the backend handoff, lease,
    // and idempotency guards remain authoritative after the local lock
    // clears.
    const timer = setTimeout(() => {
      toast.message("Queue confirmation delayed");
      setQueuedOperation(null);
    }, Math.max(0, queuedOperation.at + QUEUE_CONFIRMATION_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [latestRunStart, queuedOperation]);

  const onActionError = (fallback: string) => (error: unknown) => {
    toast.error(getUserFacingErrorMessage(error, fallback));
  };

  const startDiscovery = useMutation(
    trpc.klaviyo.startDiscovery.mutationOptions({
      onSuccess: () => {
        toast.success("Discovery queued");
        markQueued("discovery");
        invalidateEvidence();
      },
      onError: onActionError("Discovery could not start"),
    }),
  );
  const runProbe = useMutation(
    trpc.klaviyo.runProbe.mutationOptions({
      onSuccess: () => {
        toast.success("Probe queued");
        markQueued("probe");
        invalidateEvidence();
      },
      onError: onActionError("Probe could not start"),
    }),
  );
  const approveProbe = useMutation(
    trpc.klaviyo.approveProbe.mutationOptions({
      onSuccess: () => {
        toast.success("Probe approved");
        invalidateEvidence();
      },
      onError: onActionError("Probe review failed"),
    }),
  );
  const rejectProbe = useMutation(
    trpc.klaviyo.rejectProbe.mutationOptions({
      onSuccess: () => {
        toast.success("Probe rejected");
        invalidateEvidence();
      },
      onError: onActionError("Probe review failed"),
    }),
  );
  const approveJoinRule = useMutation(
    trpc.klaviyo.approveJoinRule.mutationOptions({
      onSuccess: () => {
        toast.success("Rule approved");
        invalidateEvidence();
      },
      onError: onActionError("Rule review failed"),
    }),
  );
  const rejectJoinRule = useMutation(
    trpc.klaviyo.rejectJoinRule.mutationOptions({
      onSuccess: () => {
        toast.success("Rule rejected");
        invalidateEvidence();
      },
      onError: onActionError("Rule review failed"),
    }),
  );
  const startOrderCoreSync = useMutation(
    trpc.klaviyo.startOrderCoreSync.mutationOptions({
      onSuccess: () => {
        toast.success("Order-core sync queued");
        markQueued("events");
        invalidateEvidence();
      },
      onError: onActionError("Sync could not start"),
    }),
  );
  const recomputeMatches = useMutation(
    trpc.klaviyo.recomputeMatches.mutationOptions({
      onSuccess: (result) => {
        toast.success("Match recompute queued");
        setQueuedRecompute({
          triggerRunId: result.triggerRunId,
          invocationFingerprint: result.invocationFingerprint,
          at: clickInstant(),
        });
      },
      onError: onActionError("Recompute could not start"),
    }),
  );
  const refreshReports = useMutation(
    trpc.klaviyo.refreshReports.mutationOptions({
      onSuccess: (result) => {
        toast.success(
          result.kind === "fresh" ? "Reports already fresh" : "Report refresh queued",
        );
        if (result.kind !== "fresh") markQueued("reports");
        invalidateEvidence();
      },
      onError: onActionError("Report refresh could not start"),
    }),
  );

  const anyMutationPending =
    startDiscovery.isPending ||
    runProbe.isPending ||
    approveProbe.isPending ||
    rejectProbe.isPending ||
    approveJoinRule.isPending ||
    rejectJoinRule.isPending ||
    startOrderCoreSync.isPending ||
    recomputeMatches.isPending ||
    refreshReports.isPending;

  const storeToday = health.data?.store?.todayInStoreTz ?? null;
  const accountToday =
    health.data?.connection?.todayInAccountTz ?? storeToday ?? null;
  const range =
    storeToday === null
      ? null
      : resolveLabDayRange({
          view,
          range: lab.state.range,
          from: lab.state.from,
          to: lab.state.to,
          storeToday,
          accountToday: accountToday ?? storeToday,
        });

  const latestProbe = probe.data?.reports[0] ?? null;
  const probePassed = latestProbe?.status === "passed";
  const connectionReady = health.data?.configured === true;
  const evidenceUnlocked = connectionReady && probePassed && range !== null;

  const serverRunning =
    syncRuns.data?.items.some((run) => run.status === "running") ?? false;

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/attribution"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Attribution
        </Link>
      </div>
      <div>
        <h1 className="text-xl font-semibold">Klaviyo Lab</h1>
        <p className="text-sm text-muted-foreground">{ADVISORY_BANNER}</p>
      </div>

      <LabHeader
        health={health.data ?? null}
        healthError={health.isError}
        onRetryHealth={() => void health.refetch()}
        busy={anyMutationPending}
        syncLocked={
          !probePassed || queuedOperation !== null || serverRunning
        }
        recomputeLocked={!probePassed || queuedRecompute !== null}
        onStartDiscovery={() => startDiscovery.mutate()}
        onSyncNow={() =>
          range !== null &&
          startOrderCoreSync.mutate({
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
          })
        }
        onRecompute={() =>
          range !== null &&
          recomputeMatches.mutate({
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
          })
        }
      />

      <Tabs value={view} onValueChange={(value) => lab.setView(value as LabView)}>
        <TabsList>
          {LAB_VIEWS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {VIEW_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {view !== "probe" && !evidenceUnlocked ? (
        <div className="space-y-4">
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            Broad evidence views stay locked until the connection is
            configured and the latest probe passes review.
          </p>
          <ProbePanel
            reports={probe.data?.reports ?? []}
            rules={probe.data?.rules ?? []}
            busy={anyMutationPending}
            onRunProbe={() => runProbe.mutate({ sampleSize: 30 })}
            onReviewProbe={(input) =>
              (input.decision === "approve" ? approveProbe : rejectProbe).mutate({
                reportId: input.reportId,
                reviewNote: input.reviewNote,
              })
            }
            onReviewRule={(input) =>
              (input.decision === "approve"
                ? approveJoinRule
                : rejectJoinRule
              ).mutate({ ruleId: input.ruleId, reviewNote: input.reviewNote })
            }
          />
        </div>
      ) : null}

      {view !== "probe" && evidenceUnlocked && range !== null ? (
        <div className="space-y-4">
          <LabFilterBar
            view={view}
            range={range}
            storeTimezone={health.data?.store?.ianaTimezone ?? "UTC"}
            accountTimezone={health.data?.connection?.timezone ?? "UTC"}
            lab={lab}
          />
          {view === "orders" ? (
            <>
              <CoverageQuery range={range} enabled={evidenceUnlocked} />
              <OrdersView range={range} lab={lab} />
            </>
          ) : null}
          {view === "unmatched" ? (
            <>
              <CoverageQuery range={range} enabled={evidenceUnlocked} />
              <UnmatchedView range={range} lab={lab} />
            </>
          ) : null}
          {view === "reports" ? (
            <ReportsView
              range={range}
              lab={lab}
              accountTimezone={health.data?.connection?.timezone ?? "UTC"}
              busy={anyMutationPending || queuedOperation !== null}
              onRefresh={() =>
                refreshReports.mutate({
                  dateFrom: range.dateFrom,
                  dateTo: range.dateTo,
                  kinds: [lab.state.reportKind],
                })
              }
            />
          ) : null}
        </div>
      ) : null}

      {view === "probe" ? (
        <div className="space-y-4">
          <ProbePanel
            reports={probe.data?.reports ?? []}
            rules={probe.data?.rules ?? []}
            busy={anyMutationPending}
            onRunProbe={() => runProbe.mutate({ sampleSize: 30 })}
            onReviewProbe={(input) =>
              (input.decision === "approve" ? approveProbe : rejectProbe).mutate({
                reportId: input.reportId,
                reviewNote: input.reviewNote,
              })
            }
            onReviewRule={(input) =>
              (input.decision === "approve"
                ? approveJoinRule
                : rejectJoinRule
              ).mutate({ ruleId: input.ruleId, reviewNote: input.reviewNote })
            }
          />
          <SyncRunsPanel
            runs={syncRuns.data?.items ?? null}
            error={syncRuns.isError}
            stale={syncRuns.isError && syncRuns.data !== undefined}
            onRetry={() => void syncRuns.refetch()}
          />
        </div>
      ) : null}

      <OrderDetailSheet lab={lab} />
    </div>
  );
}

function CoverageQuery(props: {
  range: { dateFrom: string; dateTo: string };
  enabled: boolean;
}) {
  const trpc = useTRPC();
  const coverage = useQuery({
    ...trpc.klaviyo.coverage.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
    }),
    enabled: props.enabled,
  });
  if (coverage.isError) {
    return (
      <LabPanelState
        kind="error"
        title="Coverage could not load"
        body="Previously loaded evidence remains unchanged."
        onRetry={() => void coverage.refetch()}
      />
    );
  }
  if (!coverage.data) {
    return <LabPanelState kind="loading" title="Loading coverage" body="" />;
  }
  return <CoverageSummary coverage={coverage.data} />;
}

function OrdersView(props: {
  range: { dateFrom: string; dateTo: string };
  lab: ReturnType<typeof useKlaviyoLabState>;
}) {
  const trpc = useTRPC();
  const { state } = props.lab;
  const [cursor, setCursor] = useState<string | null>(null);
  const filterKey = JSON.stringify([
    props.range,
    state.orderStatus,
    state.productStatus,
    state.claimType,
    state.channel,
    state.bucket,
  ]);
  const [previousFilterKey, setPreviousFilterKey] = useState(filterKey);
  if (previousFilterKey !== filterKey) {
    setPreviousFilterKey(filterKey);
    setCursor(null);
  }
  const orders = useQuery(
    trpc.klaviyo.orders.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
      orderStatus: state.orderStatus === "all" ? undefined : state.orderStatus,
      productStatus:
        state.productStatus === "all" ? undefined : state.productStatus,
      claimType: state.claimType === "all" ? undefined : state.claimType,
      channel: state.channel === "all" ? undefined : state.channel,
      bucket:
        state.bucket === "all"
          ? undefined
          : (state.bucket as
              | "meta"
              | "google"
              | "klaviyo"
              | "tiktok"
              | "ai"
              | "organic_direct"
              | "unattributed"
              | "untracked"),
      cursor,
      limit: 25,
    }),
  );
  const filtered =
    state.orderStatus !== "all" ||
    state.productStatus !== "all" ||
    state.claimType !== "all" ||
    state.channel !== "all" ||
    state.bucket !== "all";
  return (
    <OrdersTable
      data={orders.data ?? null}
      error={orders.isError}
      filtered={filtered}
      onRetry={() => void orders.refetch()}
      onClearFilters={props.lab.clearFilters}
      onOpenOrder={props.lab.openOrder}
      onNextPage={(next) => setCursor(next)}
    />
  );
}

function UnmatchedView(props: {
  range: { dateFrom: string; dateTo: string };
  lab: ReturnType<typeof useKlaviyoLabState>;
}) {
  const trpc = useTRPC();
  const { state } = props.lab;
  const [cursor, setCursor] = useState<string | null>(null);
  const events = useQuery(
    trpc.klaviyo.unmatchedEvents.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
      channel: state.channel === "all" ? undefined : state.channel,
      cursor,
      limit: 25,
    }),
  );
  return (
    <UnmatchedEventsTable
      data={events.data ?? null}
      error={events.isError}
      onRetry={() => void events.refetch()}
      onNextPage={(next) => setCursor(next)}
    />
  );
}

function ReportsView(props: {
  range: { dateFrom: string; dateTo: string };
  lab: ReturnType<typeof useKlaviyoLabState>;
  accountTimezone: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  const trpc = useTRPC();
  const reports = useQuery(
    trpc.klaviyo.reports.queryOptions({
      dateFrom: props.range.dateFrom,
      dateTo: props.range.dateTo,
      kind: props.lab.state.reportKind,
      limit: 50,
    }),
  );
  return (
    <ReportsTable
      data={reports.data ?? null}
      error={reports.isError}
      accountTimezone={props.accountTimezone}
      kind={props.lab.state.reportKind}
      range={props.range}
      busy={props.busy}
      onRetry={() => void reports.refetch()}
      onRefresh={props.onRefresh}
    />
  );
}
