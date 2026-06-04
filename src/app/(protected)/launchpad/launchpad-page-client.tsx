"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileImage,
  Fingerprint,
  Link2,
  ListChecks,
  LockKeyhole,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  Target,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { LAUNCHPAD_MAX_ITEMS, metaCtaValues } from "@/lib/launchpad-constants";
import {
  buildLaunchpadLocalAdHref,
  buildMetaAdsManagerAdUrl,
  canShowLaunchpadManualInterventionAction,
  canShowLaunchpadRetryAction,
  formatLaunchpadStatusLabel,
  getLaunchpadItemDiagnostics,
  getLaunchpadItemManifestSummary,
  getLaunchpadPerformanceSyncReadiness,
  getLaunchpadRunAggregateResult,
  getLaunchpadStatusBreakdown,
  summarizeLaunchpadRunStatuses,
  type LaunchpadRunDetailItem,
  type LaunchpadRunDetailRun,
} from "@/lib/launchpad-run-detail";
import { useTRPC } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function readinessLabel(reason: string) {
  switch (reason) {
    case "missing_access_token":
      return "missing access token";
    case "missing_facebook_page_id":
      return "missing Facebook Page ID";
    default:
      return reason.replace(/_/g, " ");
  }
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

type LaunchpadDraftItem = {
  creativeId: string;
  adName: string;
  primaryText: string;
  headline: string;
  destinationUrl: string;
  cta: string;
};

type LaunchpadRunDetailData = {
  run: LaunchpadRunDetailRun & {
    manifest?: unknown;
    errorDetails?: unknown;
  };
  items: LaunchpadRunDetailItem[];
};

type Tone = "neutral" | "warning" | "danger" | "success";

function toneClasses(tone: Tone) {
  switch (tone) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300";
    case "danger":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted/25 text-muted-foreground";
  }
}

function statusBadgeClasses(status: string) {
  if (["success", "reconciled"].includes(status)) {
    return "border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300";
  }
  if (["failed", "terminal", "mismatched"].includes(status)) {
    return "border-destructive/30 text-destructive";
  }
  if (["ambiguous", "manual_intervention", "retryable", "pending", "checking"].includes(status)) {
    return "border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-300";
  }
  if (["queued", "publishing"].includes(status)) {
    return "border-blue-200 text-blue-700 dark:border-blue-900/60 dark:text-blue-300";
  }
  return "";
}

function metaStatusClasses(status: string | null) {
  if (!status) return "border-border text-muted-foreground";
  const normalized = status.toUpperCase();
  if (["PAUSED", "ACTIVE"].includes(normalized)) {
    return "border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300";
  }
  if (["REJECTED", "DISAPPROVED", "WITH_ISSUES"].includes(normalized)) {
    return "border-destructive/30 text-destructive";
  }
  if (["PENDING_REVIEW", "IN_PROCESS", "PENDING", "PROCESSING"].includes(normalized)) {
    return "border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-300";
  }
  return "border-border text-muted-foreground";
}

function formatTimestamp(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function compactId(value: string | null | undefined, head = 8, tail = 6) {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const value = status ?? "unknown";
  return (
    <Badge variant="outline" className={cn("capitalize", statusBadgeClasses(value))}>
      {formatLaunchpadStatusLabel(value)}
    </Badge>
  );
}

function MetaStatusBadge({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="rounded-lg border bg-background/70 p-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <Badge
        variant="outline"
        className={cn("mt-1 font-mono text-[11px]", metaStatusClasses(value ?? null))}
      >
        {value ?? "not synced"}
      </Badge>
    </div>
  );
}

function RunTimeline({ run }: { run: LaunchpadRunDetailData["run"] }) {
  const events = [
    ["Created", run.createdAt],
    ["Validated", run.validatedAt],
    ["Queued", run.queuedAt],
    ["Started", run.startedAt],
    ["Completed", run.completedAt],
    ["Last retry", run.lastRetryRequestedAt],
  ] as const;

  return (
    <div className="rounded-xl border bg-muted/15 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <CalendarClock className="size-4 text-primary" /> Run timeline
      </div>
      <dl className="grid gap-1.5 text-xs">
        {events.map(([label, value]) => (
          <DetailRow key={label} label={label}>
            <span className="tabular-nums text-muted-foreground">
              {formatTimestamp(value)}
            </span>
          </DetailRow>
        ))}
      </dl>
    </div>
  );
}

function LaunchpadRunDetailPanel({
  data,
  isPublishing,
  isRetrying,
  isMarkingManual,
  onPublish,
  onRetry,
  onMarkManual,
}: {
  data: LaunchpadRunDetailData;
  isPublishing: boolean;
  isRetrying: boolean;
  isMarkingManual: boolean;
  onPublish: () => void;
  onRetry: () => void;
  onMarkManual: (itemId: string) => void;
}) {
  const { run, items } = data;
  const aggregate = getLaunchpadRunAggregateResult(run, items);
  const statusCounts = summarizeLaunchpadRunStatuses(items);
  const canPublish = run.status === "validated";
  const canRetry = canShowLaunchpadRetryAction(run, items);

  return (
    <div className="space-y-4 p-4">
      <div className={cn("rounded-2xl border p-4", toneClasses(aggregate.tone))}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={run.status} />
              <Badge variant="secondary" className="capitalize">
                {run.mode ?? "validation"}
              </Badge>
              {run.reconciliationStatus ? (
                <Badge variant="outline" className={cn("capitalize", statusBadgeClasses(run.reconciliationStatus))}>
                  reconciliation {formatLaunchpadStatusLabel(run.reconciliationStatus)}
                </Badge>
              ) : null}
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {aggregate.label}
              </h3>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {aggregate.detail}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canPublish ? (
              <Button
                size="sm"
                variant="outline"
                disabled={isPublishing}
                onClick={onPublish}
              >
                {isPublishing ? "Queueing…" : "Publish paused ads"}
              </Button>
            ) : null}
            {canRetry ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={isRetrying}
                onClick={onRetry}
                className="gap-1.5"
              >
                <RotateCcw className="size-3" />
                {isRetrying ? "Reconciling…" : "Retry failed only"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr]">
        <div className="rounded-xl border bg-muted/15 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Target className="size-4 text-primary" /> Destination
          </div>
          <dl className="grid gap-1.5 text-xs">
            <DetailRow label="Account Meta ID">
              <code className="font-mono">{run.actorAccountMetaId ?? "—"}</code>
            </DetailRow>
            <DetailRow label="Facebook Page">
              <code className="font-mono">{run.actorPageId ?? "—"}</code>
            </DetailRow>
            <DetailRow label="Instagram actor">
              <code className="font-mono">{run.actorInstagramId ?? "—"}</code>
            </DetailRow>
            <DetailRow label="Ad set Meta ID">
              <code className="font-mono">{run.destinationAdSetMetaId ?? "—"}</code>
            </DetailRow>
            <DetailRow label="Requested Meta status">
              <span className="font-mono">{run.requestedStatus ?? "PAUSED"}</span>
            </DetailRow>
          </dl>
        </div>

        <div className="rounded-xl border bg-muted/15 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <ListChecks className="size-4 text-primary" /> Audit
          </div>
          <dl className="grid gap-1.5 text-xs">
            <DetailRow label="Run ID">
              <code className="font-mono" title={run.id}>{compactId(run.id)}</code>
            </DetailRow>
            <DetailRow label="Manifest hash">
              <code className="font-mono" title={run.manifestHash ?? undefined}>
                {run.manifestHash ? shortHash(run.manifestHash) : "—"}
              </code>
            </DetailRow>
            <DetailRow label="Actor">
              <span className="capitalize">
                {run.requestedByRole ?? "unknown"} · {run.requestedByPrincipalType ?? "unknown"}
              </span>
            </DetailRow>
            <DetailRow label="User ID">
              <code className="font-mono" title={run.requestedByUserId ?? undefined}>
                {compactId(run.requestedByUserId)}
              </code>
            </DetailRow>
            <DetailRow label="Live env at validation">
              {run.livePublishEnabledAtValidation ? (
                <Badge>Enabled</Badge>
              ) : (
                <Badge variant="secondary">Disabled</Badge>
              )}
            </DetailRow>
          </dl>
        </div>

        <RunTimeline run={run} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(statusCounts).map(([status, count]) => (
          <div key={status} className="rounded-xl border bg-card p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {formatLaunchpadStatusLabel(status)}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{count}</p>
          </div>
        ))}
        {Object.keys(statusCounts).length === 0 ? (
          <div className="rounded-xl border bg-card p-3 text-sm text-muted-foreground">
            No persisted items found for this run.
          </div>
        ) : null}
      </div>

      {run.errorCode || run.errorMessage || run.manualInterventionReason ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Run-level diagnostic</p>
          <p className="mt-1">
            {run.errorCode ? `${run.errorCode}: ` : null}{run.errorMessage ?? run.manualInterventionReason}
          </p>
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Publish item detail</h3>
          <p className="text-xs text-muted-foreground">
            Manifest intent, local linkage, raw Meta status, and sync readiness are shown as separate concerns.
          </p>
        </div>
        {items.map((item) => (
          <LaunchpadItemDetailCard
            key={item.id}
            item={item}
            accountMetaId={run.actorAccountMetaId}
            isMarkingManual={isMarkingManual}
            onMarkManual={onMarkManual}
          />
        ))}
      </div>

      <details className="rounded-xl border bg-muted/15 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Raw manifest and diagnostics JSON
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg border bg-background/70 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {formatJson({
            manifest: run.manifest,
            retry: {
              count: run.retryCount ?? 0,
              lastRequestedAt: run.lastRetryRequestedAt,
            },
            itemPayloads: items.map((item) => item.payload),
            itemDiagnostics: items.map((item) => ({
              id: item.id,
              status: item.status,
              errorCategory: item.errorCategory,
              errorCode: item.errorCode,
              errorMessage: item.errorMessage,
              errorDetails: item.errorDetails,
              reconciliationStatus: item.reconciliationStatus,
              manualInterventionReason: item.manualInterventionReason,
              retryCount: item.retryCount ?? 0,
              lastRetryRequestedAt: item.lastRetryRequestedAt,
              externalMetaAdId: item.externalMetaAdId,
              externalMetaCreativeId: item.externalMetaCreativeId,
              localAdId: item.localAdId,
              localAd: item.localAd,
            })),
          })}
        </pre>
      </details>
    </div>
  );
}

function LaunchpadItemDetailCard({
  item,
  accountMetaId,
  isMarkingManual,
  onMarkManual,
}: {
  item: LaunchpadRunDetailItem;
  accountMetaId?: string | null;
  isMarkingManual: boolean;
  onMarkManual: (itemId: string) => void;
}) {
  const manifest = getLaunchpadItemManifestSummary(item);
  const statuses = getLaunchpadStatusBreakdown(item);
  const diagnostics = getLaunchpadItemDiagnostics(item);
  const syncReadiness = getLaunchpadPerformanceSyncReadiness(item);
  const adsManagerUrl = buildMetaAdsManagerAdUrl({
    accountMetaId,
    adMetaId: item.externalMetaAdId,
  });
  const localAdHref = buildLaunchpadLocalAdHref(item);
  const showManualAction = canShowLaunchpadManualInterventionAction(item);

  return (
    <article className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={item.status} />
            <Badge variant="secondary">Item {item.position ?? "—"}</Badge>
            {item.reconciliationStatus ? (
              <Badge variant="outline" className={cn("capitalize", statusBadgeClasses(item.reconciliationStatus))}>
                {formatLaunchpadStatusLabel(item.reconciliationStatus)}
              </Badge>
            ) : null}
          </div>
          <h4 className="truncate text-base font-semibold">
            {manifest.adName ?? item.requestedAdName ?? item.id}
          </h4>
          <p className="text-xs text-muted-foreground">
            {manifest.creativeName ?? manifest.creativeId ?? "Unknown creative"}
            {manifest.creativeFormat ? ` · ${manifest.creativeFormat}` : null}
          </p>
        </div>
        {showManualAction ? (
          <Button
            size="sm"
            variant="outline"
            disabled={isMarkingManual}
            onClick={() => onMarkManual(item.id)}
          >
            <Wrench className="size-3" /> Manual intervention
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-3">
          <div className="rounded-xl border bg-muted/15 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Manifest summary
            </p>
            <dl className="grid gap-1.5 text-xs">
              <DetailRow label="Generated / overridden ad name">
                <span className="break-words">{manifest.adName ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Final URL">
                {manifest.finalUrl ? (
                  <a
                    href={manifest.finalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-sm items-center justify-end gap-1 text-primary hover:underline"
                  >
                    <span className="truncate">{manifest.finalUrl}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="CTA">
                <span className="font-mono">{manifest.cta ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Headline">
                <span className="break-words">{manifest.headline ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Primary text">
                <span className="line-clamp-2 max-w-sm whitespace-pre-wrap text-right">
                  {manifest.primaryText ?? "—"}
                </span>
              </DetailRow>
              <DetailRow label="Requested Meta status">
                <span className="font-mono">{manifest.requestedStatus ?? "PAUSED"}</span>
              </DetailRow>
            </dl>
          </div>

          <div className="rounded-xl border bg-muted/15 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Linkage
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border bg-background/70 p-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Local ad
                </p>
                <p className="mt-1 font-mono text-xs">{item.localAdId ?? "not created"}</p>
                {localAdHref ? (
                  <Button asChild size="xs" variant="outline" className="mt-2">
                    <Link href={localAdHref}>
                      <Link2 className="size-3" /> Open local ad
                    </Link>
                  </Button>
                ) : null}
              </div>
              <div className="rounded-lg border bg-background/70 p-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Meta ad
                </p>
                <p className="mt-1 font-mono text-xs">{item.externalMetaAdId ?? "not created"}</p>
                {adsManagerUrl ? (
                  <Button asChild size="xs" variant="outline" className="mt-2">
                    <a href={adsManagerUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="size-3" /> Ads Manager
                    </a>
                  </Button>
                ) : null}
              </div>
              <div className="rounded-lg border bg-background/70 p-2 sm:col-span-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Meta creative ID
                </p>
                <p className="mt-1 font-mono text-xs">
                  {item.externalMetaCreativeId ?? "not created"}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border bg-muted/15 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Status separation
            </p>
            <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
              <div className="rounded-lg border bg-background/70 p-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Local Adsolute status
                </p>
                <Badge variant="outline" className="mt-1 capitalize">
                  {statuses.local.label}
                </Badge>
              </div>
              <MetaStatusBadge label="Meta configured" value={statuses.meta.configured} />
              <MetaStatusBadge label="Meta effective / review" value={statuses.meta.effective} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Local paused status stays separate from Meta review, rejection, effective, or with-issues states.
            </p>
          </div>

          <div className={cn("rounded-xl border p-3", toneClasses(syncReadiness.tone))}>
            <div className="flex items-start gap-2">
              <RadioTower className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="text-sm font-medium">{syncReadiness.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {syncReadiness.message}
                </p>
              </div>
            </div>
          </div>

          {diagnostics.length > 0 ? (
            <div className="rounded-xl border bg-muted/15 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Error and reconciliation context
              </p>
              <dl className="space-y-2 text-xs">
                {diagnostics.map((diagnostic) => (
                  <div
                    key={`${diagnostic.label}-${diagnostic.value}`}
                    className={cn("rounded-lg border p-2", toneClasses(diagnostic.tone))}
                  >
                    <dt className="font-medium">{diagnostic.label}</dt>
                    <dd className="mt-1 break-words text-muted-foreground">
                      {diagnostic.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed bg-muted/10 p-3 text-xs text-muted-foreground">
              No item-level errors recorded.
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function LaunchpadPageClient() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedAdSetId, setSelectedAdSetId] = useState("");
  const [selectedCreativeId, setSelectedCreativeId] = useState("");
  const [launchItems, setLaunchItems] = useState<LaunchpadDraftItem[]>([]);
  const [defaultPrimaryText, setDefaultPrimaryText] = useState("");
  const [defaultDestinationUrl, setDefaultDestinationUrl] = useState("");
  const [namingTemplate, setNamingTemplate] = useState("");
  const [cta, setCta] = useState("SHOP_NOW");
  const [selectedRunId, setSelectedRunId] = useState("");

  const runs = useQuery(trpc.launchpad.list.queryOptions({ limit: 50 }));
  const staticCreatives = useQuery(
    trpc.adCreative.list.queryOptions({ format: "static" }),
  );
  const selectedRun = useQuery({
    ...trpc.launchpad.getById.queryOptions({ id: selectedRunId || "__no_run__" }),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => {
      const data = query.state.data as
        | { run?: { status?: string } }
        | undefined;
      return ["queued", "publishing"].includes(data?.run?.status ?? "")
        ? 3000
        : false;
    },
  });
  const destinationAccounts = useQuery(
    trpc.launchpad.destinationAccounts.queryOptions(),
  );
  const selectedAccount = destinationAccounts.data?.find(
    (account) => account.id === selectedAccountId,
  );
  const eligibleAdSets = useQuery({
    ...trpc.launchpad.eligibleAdSets.queryOptions({
      accountId: selectedAccountId || "__no_account_selected__",
    }),
    enabled: Boolean(selectedAccountId && selectedAccount?.canPublish),
  });
  const selectedAdSet = eligibleAdSets.data?.find(
    (adSet) => adSet.id === selectedAdSetId,
  );
  const selectedCreative = staticCreatives.data?.find(
    (creative) => creative.id === selectedCreativeId,
  );
  const destinationContext = useQuery({
    ...trpc.launchpad.destinationContext.queryOptions({
      accountId: selectedAccountId || "__no_account_selected__",
      adSetId: selectedAdSetId || "__no_ad_set_selected__",
    }),
    enabled: Boolean(selectedAccountId && selectedAdSetId),
  });

  const createRun = useMutation(
    trpc.launchpad.createValidationRun.mutationOptions({
      onSuccess: (run) => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        if (run?.id) setSelectedRunId(run.id);
        toast.success("Launchpad dry-run manifest recorded");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const requestPublish = useMutation(
    trpc.launchpad.requestLivePublish.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.launchpad.getById.queryKey({ id: result.runId }),
        });
        toast.success("Paused Meta publish queued in Trigger");
      },
      onError: (error) => {
        toast.error(error.message);
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        const runId = selectedRun.data?.run.id ?? selectedRunId;
        if (runId) {
          queryClient.invalidateQueries({
            queryKey: trpc.launchpad.getById.queryKey({ id: runId }),
          });
        }
      },
    }),
  );
  const retryFailed = useMutation(
    trpc.launchpad.retryFailedItems.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.launchpad.getById.queryKey({ id: result.runId }),
        });
        if (result.queued) {
          toast.success(`Queued ${result.itemIds.length} retryable item${result.itemIds.length === 1 ? "" : "s"}`);
        } else {
          toast.info("No retryable Launchpad items were queued");
        }
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const markManualIntervention = useMutation(
    trpc.launchpad.markItemManualIntervention.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.launchpad.getById.queryKey({ id: result.runId }),
        });
        toast.success("Launchpad item moved to manual intervention");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function handleAccountChange(accountId: string) {
    setSelectedAccountId(accountId);
    setSelectedAdSetId("");
  }

  function addSelectedCreative() {
    if (!selectedCreativeId) return;
    if (launchItems.some((item) => item.creativeId === selectedCreativeId)) {
      toast.error("That creative is already in this batch.");
      return;
    }
    if (launchItems.length >= LAUNCHPAD_MAX_ITEMS) {
      toast.error(`Launchpad batches are capped at ${LAUNCHPAD_MAX_ITEMS} items.`);
      return;
    }

    setLaunchItems((items) => [
      ...items,
      {
        creativeId: selectedCreativeId,
        adName: "",
        primaryText: "",
        headline: "",
        destinationUrl: "",
        cta: "",
      },
    ]);
    setSelectedCreativeId("");
  }

  function updateLaunchItem(
    creativeId: string,
    field: keyof Omit<LaunchpadDraftItem, "creativeId">,
    value: string,
  ) {
    setLaunchItems((items) =>
      items.map((item) =>
        item.creativeId === creativeId ? { ...item, [field]: value } : item,
      ),
    );
  }

  function removeLaunchItem(creativeId: string) {
    setLaunchItems((items) =>
      items.filter((item) => item.creativeId !== creativeId),
    );
  }

  function createDryRun() {
    if (!selectedAccountId || !selectedAdSetId) {
      toast.error("Select an eligible Meta destination first.");
      return;
    }

    if (launchItems.length === 0) {
      toast.error("Choose at least one static creative for the dry run.");
      return;
    }

    const everyItemHasUrl = launchItems.every((item) => item.destinationUrl.trim());
    if (!defaultDestinationUrl.trim() && !everyItemHasUrl) {
      toast.error("Provide a batch URL or URL overrides for every item.");
      return;
    }

    createRun.mutate({
      idempotencyKey: `dry_run_${crypto.randomUUID()}`,
      actor: { accountId: selectedAccountId },
      destination: { adSetId: selectedAdSetId },
      defaultDestinationUrl: defaultDestinationUrl.trim() || undefined,
      defaultPrimaryText: defaultPrimaryText.trim() || undefined,
      defaultCta: cta,
      namingTemplate: namingTemplate.trim() || undefined,
      items: launchItems.map((item) => ({
        creativeId: item.creativeId,
        adName: item.adName.trim() || undefined,
        primaryText: item.primaryText.trim() || undefined,
        headline: item.headline.trim() || undefined,
        destinationUrl: item.destinationUrl.trim() || undefined,
        cta: item.cta.trim() || undefined,
        requestedStatus: "PAUSED" as const,
      })),
    });
  }

  function publishSelectedRun() {
    if (!selectedRun.data?.run.id) {
      toast.error("Select a validated Launchpad run first.");
      return;
    }

    const confirmed = window.confirm(
      `Create ${selectedRun.data.items.length} real Meta ad${selectedRun.data.items.length === 1 ? "" : "s"} as PAUSED through Trigger? This will create local paused ad rows and Meta objects.`,
    );
    if (!confirmed) return;

    requestPublish.mutate({
      runId: selectedRun.data.run.id,
      confirmation: "PUBLISH_PAUSED_META_ADS",
      requestedStatus: "PAUSED",
    });
  }

  function retrySelectedRun() {
    if (!selectedRun.data?.run.id) {
      toast.error("Select a Launchpad run with failed items first.");
      return;
    }

    const confirmed = window.confirm(
      "Retry failed/retryable Launchpad items only? Successful, skipped, terminal, and saved-Meta-ID items will be skipped or reconciled first.",
    );
    if (!confirmed) return;

    retryFailed.mutate({
      runId: selectedRun.data.run.id,
      confirmation: "RETRY_FAILED_LAUNCHPAD_ITEMS",
      requestedStatus: "PAUSED",
    });
  }

  function markItemForManualIntervention(itemId: string) {
    if (!selectedRun.data?.run.id) return;
    const reason = window.prompt(
      "Why should this Launchpad item move to manual intervention?",
    );
    const trimmedReason = reason?.trim();
    if (!trimmedReason) return;

    markManualIntervention.mutate({
      runId: selectedRun.data.run.id,
      itemId,
      reason: trimmedReason,
    });
  }

  const destinationReady = Boolean(selectedAccountId && selectedAdSetId);
  const dryRunReady = Boolean(
    destinationReady &&
      launchItems.length > 0 &&
      (defaultDestinationUrl.trim() || launchItems.every((item) => item.destinationUrl.trim())),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm">
        <div className="pointer-events-none absolute right-0 top-0 h-40 w-40 translate-x-12 -translate-y-12 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1.5">
                <ShieldCheck className="size-3" /> Dry-run ledger
              </Badge>
              <Badge variant="secondary">Live publish gated</Badge>
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Creative Launchpad
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Select one eligible synced Meta destination and up to {LAUNCHPAD_MAX_ITEMS}
                existing static creatives to freeze a side-effect-free batch
                dry-run manifest. Destination context is read-only: no budget,
                targeting, pixel, placement, or optimization controls.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={createDryRun}
            disabled={createRun.isPending || !dryRunReady}
            className="gap-1.5"
          >
            <Plus className="size-3.5" />
            {createRun.isPending ? "Recording…" : "Generate batch dry run"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Publishing destination</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose a Meta ad account with a stored token and default Facebook
            Page ID, then one linked synced ad set with a Meta ad set ID.
          </p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr_1.3fr]">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Account
            </label>
            <Select
              value={selectedAccountId}
              onValueChange={handleAccountChange}
              disabled={destinationAccounts.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select account…" />
              </SelectTrigger>
              <SelectContent>
                {destinationAccounts.data?.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    <span>{account.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {account.metaAccountId}
                    </span>
                    {!account.canPublish ? (
                      <span className="ml-2 text-xs text-amber-600">
                        needs setup
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAccount && !selectedAccount.canPublish ? (
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Account setup incomplete: {selectedAccount.ineligibleReasons.map(readinessLabel).join(", ")}.
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Eligible ad set
            </label>
            <Select
              value={selectedAdSetId}
              onValueChange={setSelectedAdSetId}
              disabled={!selectedAccount?.canPublish || eligibleAdSets.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select ad set…" />
              </SelectTrigger>
              <SelectContent>
                {eligibleAdSets.data?.map((adSet) => (
                  <SelectItem key={adSet.id} value={adSet.id}>
                    <span>{adSet.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {adSet.metaId}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAccount?.canPublish && eligibleAdSets.data?.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No eligible linked ad sets for this account yet.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              {destinationContext.data ? (
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <ShieldCheck className="size-4 text-muted-foreground" />
              )}
              <p className="text-sm font-medium">Read-only context</p>
            </div>
            {destinationContext.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : destinationContext.data ? (
              <dl className="grid gap-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="text-right font-medium">
                    {destinationContext.data.account.name}
                    <span className="ml-1 text-muted-foreground">
                      {destinationContext.data.account.metaAccountId}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Facebook Page</dt>
                  <dd className="font-mono">
                    {destinationContext.data.account.defaultFacebookPageId}
                  </dd>
                </div>
                {destinationContext.data.account.defaultInstagramActorId ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Instagram actor</dt>
                    <dd className="font-mono">
                      {destinationContext.data.account.defaultInstagramActorId}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Campaign</dt>
                  <dd className="text-right">
                    {destinationContext.data.adSet.campaign.name ?? "Unknown"}
                    {destinationContext.data.adSet.campaign.metaId ? (
                      <span className="ml-1 font-mono text-muted-foreground">
                        {destinationContext.data.adSet.campaign.metaId}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Ad set</dt>
                  <dd className="text-right">
                    {selectedAdSet?.name ?? destinationContext.data.adSet.name}
                    <span className="ml-1 font-mono text-muted-foreground">
                      {destinationContext.data.adSet.metaId}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Statuses</dt>
                  <dd className="capitalize">
                    {destinationContext.data.adSet.status}
                    {destinationContext.data.adSet.campaign.status ? (
                      <span className="text-muted-foreground">
                        {` · campaign ${destinationContext.data.adSet.campaign.status}`}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
            ) : destinationContext.error ? (
              <p className="text-xs text-destructive">
                {destinationContext.error.message}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select an account and eligible ad set to preview the exact
                Launchpad destination context.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <FileImage className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Batch static creative dry run</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            The server reloads every creative before planning. The form sends only
            creative IDs, batch defaults, and per-item launch overrides.
          </p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Add static creatives
              </Label>
              <div className="flex gap-2">
                <Select
                  value={selectedCreativeId}
                  onValueChange={setSelectedCreativeId}
                  disabled={staticCreatives.isLoading || launchItems.length >= LAUNCHPAD_MAX_ITEMS}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a static creative…" />
                  </SelectTrigger>
                  <SelectContent>
                    {staticCreatives.data?.map((creative) => (
                      <SelectItem
                        key={creative.id}
                        value={creative.id}
                        disabled={launchItems.some((item) => item.creativeId === creative.id)}
                      >
                        <span>{creative.name}</span>
                        {creative.assetUrl ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            asset ready
                          </span>
                        ) : (
                          <span className="ml-2 text-xs text-amber-600">
                            missing asset
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={addSelectedCreative}
                  disabled={!selectedCreativeId || launchItems.length >= LAUNCHPAD_MAX_ITEMS}
                >
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {launchItems.length}/{LAUNCHPAD_MAX_ITEMS} selected. {selectedCreative
                  ? selectedCreative.hook
                    ? `Headline fallback: ${selectedCreative.hook}`
                    : `Headline fallback: ${selectedCreative.name}`
                  : "Each item can override name, URL, headline, and copy."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="defaultPrimaryText" className="text-xs uppercase tracking-wide text-muted-foreground">
                Batch primary text / caption pattern
              </Label>
              <Textarea
                id="defaultPrimaryText"
                value={defaultPrimaryText}
                onChange={(event) => setDefaultPrimaryText(event.target.value)}
                placeholder="Default launch copy applied to items without an override…"
                className="min-h-24"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="defaultUrl" className="text-xs uppercase tracking-wide text-muted-foreground">
                Batch default URL
              </Label>
              <Input
                id="defaultUrl"
                value={defaultDestinationUrl}
                onChange={(event) => setDefaultDestinationUrl(event.target.value)}
                placeholder="https://example.com/products?utm_source=meta&utm_medium=paid_social"
              />
              <p className="text-xs text-muted-foreground">
                Dry-run validation requires HTTPS plus utm_source and utm_medium.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="namingTemplate" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Naming template
                </Label>
                <Input
                  id="namingTemplate"
                  value={namingTemplate}
                  onChange={(event) => setNamingTemplate(event.target.value)}
                  placeholder="Launchpad / {{creative.name}} / {{adSet.name}}"
                />
                <p className="text-xs text-muted-foreground">
                  Supports creative, ad set, campaign, account, and item position tokens.
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Batch Meta CTA
                </Label>
                <Select value={cta} onValueChange={setCta}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select CTA" />
                  </SelectTrigger>
                  <SelectContent>
                    {metaCtaValues.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Batch items</p>
                <p className="text-xs text-muted-foreground">
                  Overrides are optional unless no batch URL is provided.
                </p>
              </div>
              <Badge variant="outline">{launchItems.length} selected</Badge>
            </div>
            {launchItems.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground">
                Add static creatives to build a batch manifest.
              </div>
            ) : (
              <div className="max-h-[520px] space-y-3 overflow-auto pr-1">
                {launchItems.map((item, index) => {
                  const creative = staticCreatives.data?.find(
                    (candidate) => candidate.id === item.creativeId,
                  );
                  return (
                    <div key={item.creativeId} className="rounded-lg border bg-muted/10 p-3">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">
                            {index + 1}. {creative?.name ?? item.creativeId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {creative?.assetUrl ? "Static asset ready" : "Missing asset will fail QA"}
                            {creative?.hook ? ` · headline fallback: ${creative.hook}` : null}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeLaunchItem(item.creativeId)}
                          aria-label={`Remove ${creative?.name ?? "creative"}`}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor={`adName-${item.creativeId}`} className="text-xs text-muted-foreground">
                            Ad name override
                          </Label>
                          <Input
                            id={`adName-${item.creativeId}`}
                            value={item.adName}
                            onChange={(event) => updateLaunchItem(item.creativeId, "adName", event.target.value)}
                            placeholder="Template-generated if blank"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`url-${item.creativeId}`} className="text-xs text-muted-foreground">
                            URL override
                          </Label>
                          <Input
                            id={`url-${item.creativeId}`}
                            value={item.destinationUrl}
                            onChange={(event) => updateLaunchItem(item.creativeId, "destinationUrl", event.target.value)}
                            placeholder="Overrides batch URL"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`headline-${item.creativeId}`} className="text-xs text-muted-foreground">
                            Headline override
                          </Label>
                          <Input
                            id={`headline-${item.creativeId}`}
                            value={item.headline}
                            onChange={(event) => updateLaunchItem(item.creativeId, "headline", event.target.value)}
                            placeholder="Defaults from hook/name"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`copy-${item.creativeId}`} className="text-xs text-muted-foreground">
                            Copy override
                          </Label>
                          <Input
                            id={`copy-${item.creativeId}`}
                            value={item.primaryText}
                            onChange={(event) => updateLaunchItem(item.creativeId, "primaryText", event.target.value)}
                            placeholder="Uses batch copy if blank"
                          />
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label className="text-xs text-muted-foreground">
                            CTA override
                          </Label>
                          <Select
                            value={item.cta || "__batch_default__"}
                            onValueChange={(value) => updateLaunchItem(
                              item.creativeId,
                              "cta",
                              value === "__batch_default__" ? "" : value,
                            )}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Use batch CTA" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__batch_default__">Use batch CTA</SelectItem>
                              {metaCtaValues.map((value) => (
                                <SelectItem key={value} value={value}>
                                  {value.replace(/_/g, " ")}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Dry-run boundary</p>
              <p className="mt-1">
                Validation records frozen manifests and QA errors only. A separate
                gated action queues PAUSED Meta publishing through Trigger.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <LockKeyhole className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">Immutable manifest</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Hash-locked run and item payloads.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <Archive className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">Durable states</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Validation through manual intervention outcomes.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <Fingerprint className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">Idempotent by design</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Run and item dedupe keys are persisted.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <ShieldCheck className="mb-3 size-4 text-primary" />
          <p className="text-sm font-medium">{LAUNCHPAD_MAX_ITEMS}-item cap</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Backend-enforced, paused-only safety contract.
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Launchpad run detail</h2>
          <p className="text-xs text-muted-foreground">
            Open a run to inspect destination context, audit history, item IDs,
            raw Meta status, errors, local linkage, and post-sync readiness.
          </p>
        </div>
        {selectedRun.isLoading ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : selectedRun.data ? (
          <LaunchpadRunDetailPanel
            data={selectedRun.data}
            isPublishing={requestPublish.isPending}
            isRetrying={retryFailed.isPending}
            isMarkingManual={markManualIntervention.isPending}
            onPublish={publishSelectedRun}
            onRetry={retrySelectedRun}
            onMarkManual={markItemForManualIntervention}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">
            Generate a dry run or choose one from the table below.
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Validation runs</h2>
          <p className="text-xs text-muted-foreground">
            Validated records can be promoted into a gated PAUSED Meta batch publish.
          </p>
        </div>
        {runs.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : runs.data?.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-14 text-center">
            <div className="rounded-full border bg-muted/40 p-3">
              <ShieldCheck className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No Launchpad runs yet</p>
              <p className="text-xs text-muted-foreground">
                Select a destination and creative, then generate a dry run to
                verify the planner without calling Meta.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Manifest hash</TableHead>
                <TableHead>Live env at validation</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Run detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data?.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {statusLabel(run.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm tabular-nums">
                      {run.itemCount}/{run.maxItemCap}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">
                      {shortHash(run.manifestHash)}
                    </code>
                  </TableCell>
                  <TableCell>
                    {run.livePublishEnabledAtValidation ? (
                      <Badge>Enabled</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      Open detail
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
