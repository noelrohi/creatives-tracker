"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRealtimeRun, useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, CheckCircle2, XCircle, Clock, Loader2 } from "@/components/icons";
import type { metaSyncTask } from "../../trigger/meta-sync";

function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "COMPLETED":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600">
          <CheckCircle2 className="size-2.5" />
          Done
        </span>
      );
    case "FAILED":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-red-600">
          <XCircle className="size-2.5" />
          Failed
        </span>
      );
    case "EXECUTING":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-blue-600">
          <Loader2 className="size-2.5 animate-spin" />
          Running
        </span>
      );
    case "QUEUED":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="size-2.5" />
          Queued
        </span>
      );
    default:
      return <span className="text-[10px] text-muted-foreground">{status}</span>;
  }
}

function ActiveRunProgress({ runId, accessToken }: { runId: string; accessToken: string }) {
  const { run } = useRealtimeRun<typeof metaSyncTask>(runId, { accessToken });

  if (!run) return null;

  const metadata = run.metadata as Record<string, unknown> | undefined;
  const currentAccount = metadata?.currentAccount as string | undefined;
  const accountProgress = metadata?.accountProgress as string | undefined;
  const currentBreakdown = metadata?.currentBreakdown as string | undefined;
  const status = metadata?.status as string | undefined;

  const progressParts = accountProgress?.split("/") ?? [];
  const progressPercent = progressParts.length === 2
    ? (parseInt(progressParts[0], 10) / parseInt(progressParts[1], 10)) * 100
    : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <RunStatusBadge status={run.status} />
        {accountProgress && (
          <span className="text-[10px] text-muted-foreground">{accountProgress}</span>
        )}
      </div>
      {run.status === "EXECUTING" && (
        <>
          <Progress value={progressPercent} className="h-1" />
          <p className="truncate text-[10px] text-muted-foreground">
            {status === "syncing" && currentAccount && (
              <>{currentAccount} · {currentBreakdown}</>
            )}
            {status === "fetching_accounts" && "Fetching accounts..."}
            {status === "loading_recent_runs" && "Checking runs..."}
          </p>
        </>
      )}
      {run.status === "COMPLETED" && run.output && (
        <p className="text-[10px] text-muted-foreground">{run.output.summary}</p>
      )}
    </div>
  );
}

function MetaSyncStatus({ accessToken, tag }: { accessToken: string; tag: string }) {
  const trpc = useTRPC();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const triggerMutation = useMutation(
    trpc.trigger.triggerMetaSync.mutationOptions({
      onSuccess: (data) => {
        setActiveRunId(data.runId);
      },
    })
  );

  const { runs } = useRealtimeRunsWithTag(tag, { accessToken });
  const recentRuns = runs.slice(0, 3);
  const hasActiveRun = runs.some((r) => r.status === "EXECUTING" || r.status === "QUEUED");

  return (
    <div className="w-48 shrink-0 rounded-lg border border-border/60 bg-background">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-2.5 py-1.5">
        <span className="text-[11px] font-medium">Background Sync</span>
        <Button
          size="sm"
          variant="outline"
          className="h-5 gap-1 px-1.5 text-[10px]"
          onClick={() => triggerMutation.mutate({})}
          disabled={triggerMutation.isPending || hasActiveRun}
        >
          {triggerMutation.isPending || hasActiveRun ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : (
            <RefreshCw className="size-2.5" />
          )}
          Sync
        </Button>
      </div>

      <div className="p-2.5">
        {activeRunId && <ActiveRunProgress runId={activeRunId} accessToken={accessToken} />}

        {recentRuns.length > 0 && !activeRunId && (
          <div className="space-y-1">
            {recentRuns.map((run) => (
              <div key={run.id} className="flex items-center justify-between">
                <RunStatusBadge status={run.status} />
                <span className="text-[9px] text-muted-foreground">
                  {new Date(run.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {recentRuns.length === 0 && !activeRunId && (
          <p className="text-[10px] text-muted-foreground">No recent runs</p>
        )}
      </div>
    </div>
  );
}

export function MetaSyncCard() {
  const trpc = useTRPC();
  const tokenQuery = useQuery(trpc.trigger.getPublicToken.queryOptions());

  if (tokenQuery.error) {
    return (
      <div className="w-48 shrink-0 rounded-lg border border-border/60 bg-background p-2.5">
        <span className="text-[10px] text-destructive">Failed to load</span>
      </div>
    );
  }

  if (tokenQuery.isLoading || !tokenQuery.data) {
    return (
      <div className="w-48 shrink-0 rounded-lg border border-border/60 bg-background">
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-2.5 py-1.5">
          <span className="text-[11px] font-medium">Background Sync</span>
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        </div>
        <div className="p-2.5">
          <span className="text-[10px] text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return <MetaSyncStatus accessToken={tokenQuery.data.publicToken} tag={tokenQuery.data.tag} />;
}
