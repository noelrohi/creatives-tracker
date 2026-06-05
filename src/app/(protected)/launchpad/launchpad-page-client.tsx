"use client";

import { Fragment, type ReactNode, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileImage,
  Link2,
  ListChecks,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  Target,
  Video,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  LAUNCHPAD_MAX_ITEMS,
  launchpadSupportedCreativeFormats,
  launchpadVideoCreativeFormats,
  metaCtaValues,
} from "@/lib/launchpad-constants";
import {
  buildLaunchpadLocalAdHref,
  buildMetaAdsManagerAdUrl,
  canShowLaunchpadManualInterventionAction,
  canShowLaunchpadPublishAction,
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

type LaunchpadSelectableCreative = {
  id: string;
  name: string;
  format: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
  hook?: string | null;
};

function isSupportedLaunchpadFormat(format: string | null | undefined) {
  return (launchpadSupportedCreativeFormats as readonly string[]).includes(
    format ?? "",
  );
}

function isVideoLaunchpadFormat(format: string | null | undefined) {
  return (launchpadVideoCreativeFormats as readonly string[]).includes(format ?? "");
}

function creativeMediaReadiness(creative: LaunchpadSelectableCreative | undefined) {
  if (!creative) return "Select a creative to inspect media readiness.";
  if (creative.format === "static") {
    return creative.assetUrl ? "Static asset ready" : "Missing image asset will fail QA";
  }
  if (isVideoLaunchpadFormat(creative.format)) {
    return creative.videoUrl ? "Video asset ready" : "Missing video URL will fail QA";
  }
  return "Unsupported format will be blocked by QA";
}

function formatCreativeKind(format: string | null | undefined) {
  if (!format) return "unknown";
  return format.toUpperCase();
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asIssueList(value: unknown): Array<{ code?: string; message?: string }> {
  return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null) as Array<{ code?: string; message?: string }> : [];
}

function asSettingsList(value: unknown): Array<{ key?: string; label?: string; source?: string; reason?: string }> {
  return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null) as Array<{ key?: string; label?: string; source?: string; reason?: string }> : [];
}

function formatMinorUnits(value: unknown, currency: unknown) {
  if (typeof value !== "number") return "Explicit budget required";
  const amount = value / 100;
  const currencyCode = typeof currency === "string" && currency ? currency : undefined;
  return currencyCode
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(amount)
    : `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/day`;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function urlHasLaunchpadRequirements(value: string) {
  if (!value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.searchParams.has("utm_source") &&
      url.searchParams.has("utm_medium")
    );
  } catch {
    return false;
  }
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

type ReadinessChecklistItem = {
  label: string;
  detail: string;
  ready: boolean;
};

type LaunchpadStep = "destination" | "creatives" | "defaults" | "preview" | "runs";

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
  const canPublish = canShowLaunchpadPublishAction(run);
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
              externalMetaVideoId: item.externalMetaVideoId,
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
              <DetailRow label="Media">
                <span className="inline-flex items-center justify-end gap-1 font-mono uppercase">
                  {manifest.mediaType === "video" ? (
                    <Video className="size-3" />
                  ) : (
                    <FileImage className="size-3" />
                  )}
                  {manifest.creativeFormat ?? manifest.mediaType ?? "unknown"}
                  {manifest.mediaUploadMethod ? ` · ${manifest.mediaUploadMethod}` : null}
                </span>
              </DetailRow>
              <DetailRow label="Media source">
                {manifest.mediaSourceUrl ? (
                  <a
                    href={manifest.mediaSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-sm items-center justify-end gap-1 text-primary hover:underline"
                  >
                    <span className="truncate">{manifest.mediaSourceUrl}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                ) : (
                  "—"
                )}
              </DetailRow>
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
              {manifest.mediaType === "video" || item.externalMetaVideoId || item.localAd?.metaVideoId ? (
                <div className="rounded-lg border bg-background/70 p-2 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Meta video ID
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    {item.externalMetaVideoId ?? item.localAd?.metaVideoId ?? "not uploaded"}
                  </p>
                </div>
              ) : null}
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

function ReadinessChecklist({ items }: { items: ReadinessChecklistItem[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <div
          key={item.label}
          title={item.detail}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 text-xs",
            item.ready
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-amber-700 dark:text-amber-300",
          )}
        >
          {item.ready ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate font-medium">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function LaunchpadStepper({
  activeStep,
  onStepChange,
  steps,
}: {
  activeStep: LaunchpadStep;
  onStepChange: (step: LaunchpadStep) => void;
  steps: {
    id: LaunchpadStep;
    label: string;
    detail: string;
    ready: boolean;
  }[];
}) {
  return (
    <nav className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-4">
      {steps.map((step, index) => {
        const isActive = step.id === activeStep;
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onStepChange(step.id)}
            className={cn(
              "flex min-w-0 items-center gap-3 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0",
              isActive ? "bg-muted/35" : "hover:bg-muted/20",
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : step.ready
                    ? "border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300"
                    : "border-border text-muted-foreground",
              )}
            >
              {step.ready && !isActive ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                index + 1
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {step.label}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function itemOverrideCount(item: LaunchpadDraftItem) {
  return [
    item.adName,
    item.destinationUrl,
    item.headline,
    item.primaryText,
    item.cta,
  ].filter((value) => value.trim()).length;
}

function ManifestPreviewTable({
  launchItems,
  launchpadCreatives,
  defaultDestinationUrl,
  cta,
  onUpdateItem,
  onRemoveItem,
}: {
  launchItems: LaunchpadDraftItem[];
  launchpadCreatives: LaunchpadSelectableCreative[];
  defaultDestinationUrl: string;
  cta: string;
  onUpdateItem: (
    creativeId: string,
    field: keyof Omit<LaunchpadDraftItem, "creativeId">,
    value: string,
  ) => void;
  onRemoveItem: (creativeId: string) => void;
}) {
  if (launchItems.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/15 px-4 py-10 text-center">
        <div className="rounded-full border bg-background/70 p-3">
          <FileImage className="size-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">No creatives added yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Creative</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>URL source</TableHead>
              <TableHead>Headline</TableHead>
              <TableHead>CTA</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead>Overrides</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {launchItems.map((item, index) => {
              const creative = launchpadCreatives.find(
                (candidate) => candidate.id === item.creativeId,
              );
              const readiness = creativeMediaReadiness(creative);
              const hasReadinessIssue =
                readiness.includes("Missing") ||
                readiness.includes("Unsupported");
              const overrideCount = itemOverrideCount(item);
              const urlSource = item.destinationUrl.trim()
                ? "Override"
                : defaultDestinationUrl.trim()
                  ? "Batch default"
                  : "Missing";

              return (
                <Fragment key={item.creativeId}>
                  <TableRow>
                    <TableCell className="text-muted-foreground">
                      {index + 1}
                    </TableCell>
                    <TableCell className="min-w-56">
                      <div className="max-w-72">
                        <p className="truncate text-sm font-medium">
                          {creative?.name ?? item.creativeId}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {creative?.hook
                            ? `Fallback: ${creative.hook}`
                            : "Uses creative name fallback"}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        {isVideoLaunchpadFormat(creative?.format) ? (
                          <Video className="size-3" />
                        ) : (
                          <FileImage className="size-3" />
                        )}
                        {formatCreativeKind(creative?.format)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          urlSource === "Missing"
                            ? "border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-300"
                            : "",
                        )}
                      >
                        {urlSource}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-sm">
                      {item.headline || creative?.hook || creative?.name || "Fallback"}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{item.cta || cta}</code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          hasReadinessIssue
                            ? "border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-300"
                            : "border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300",
                        )}
                      >
                        {hasReadinessIssue ? "Needs QA" : "Ready"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{overrideCount} set</Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => onRemoveItem(item.creativeId)}
                        aria-label={`Remove ${creative?.name ?? "creative"}`}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  <TableRow className="bg-muted/10 hover:bg-muted/10">
                    <TableCell colSpan={9} className="p-0">
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
                          <span>
                            Edit per-item overrides for{" "}
                            <span className="font-medium text-foreground">
                              {creative?.name ?? `item ${index + 1}`}
                            </span>
                          </span>
                          <span className="text-[11px] group-open:hidden">
                            Show fields
                          </span>
                          <span className="hidden text-[11px] group-open:inline">
                            Hide fields
                          </span>
                        </summary>
                        <div className="grid gap-3 border-t p-4 sm:grid-cols-2 xl:grid-cols-5">
                          <div className="space-y-1.5">
                            <Label
                              htmlFor={`adName-${item.creativeId}`}
                              className="text-xs text-muted-foreground"
                            >
                              Ad name override
                            </Label>
                            <Input
                              id={`adName-${item.creativeId}`}
                              value={item.adName}
                              onChange={(event) =>
                                onUpdateItem(
                                  item.creativeId,
                                  "adName",
                                  event.target.value,
                                )
                              }
                              placeholder="Template-generated"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor={`url-${item.creativeId}`}
                              className="text-xs text-muted-foreground"
                            >
                              URL override
                            </Label>
                            <Input
                              id={`url-${item.creativeId}`}
                              value={item.destinationUrl}
                              onChange={(event) =>
                                onUpdateItem(
                                  item.creativeId,
                                  "destinationUrl",
                                  event.target.value,
                                )
                              }
                              placeholder="Overrides batch URL"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor={`headline-${item.creativeId}`}
                              className="text-xs text-muted-foreground"
                            >
                              Headline override
                            </Label>
                            <Input
                              id={`headline-${item.creativeId}`}
                              value={item.headline}
                              onChange={(event) =>
                                onUpdateItem(
                                  item.creativeId,
                                  "headline",
                                  event.target.value,
                                )
                              }
                              placeholder="Defaults from hook"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor={`copy-${item.creativeId}`}
                              className="text-xs text-muted-foreground"
                            >
                              Copy override
                            </Label>
                            <Input
                              id={`copy-${item.creativeId}`}
                              value={item.primaryText}
                              onChange={(event) =>
                                onUpdateItem(
                                  item.creativeId,
                                  "primaryText",
                                  event.target.value,
                                )
                              }
                              placeholder="Uses batch copy"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">
                              CTA override
                            </Label>
                            <Select
                              value={item.cta || "__batch_default__"}
                              onValueChange={(value) =>
                                onUpdateItem(
                                  item.creativeId,
                                  "cta",
                                  value === "__batch_default__" ? "" : value,
                                )
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Use batch CTA" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__batch_default__">
                                  Use batch CTA
                                </SelectItem>
                                {metaCtaValues.map((value) => (
                                  <SelectItem key={value} value={value}>
                                    {value.replace(/_/g, " ")}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </details>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function LaunchpadRunInspector({
  data,
  isLoading,
  isPublishing,
  isRetrying,
  isMarkingManual,
  onPublish,
  onRetry,
  onMarkManual,
  onClear,
}: {
  data: LaunchpadRunDetailData | undefined;
  isLoading: boolean;
  isPublishing: boolean;
  isRetrying: boolean;
  isMarkingManual: boolean;
  onPublish: () => void;
  onRetry: () => void;
  onMarkManual: (itemId: string) => void;
  onClear: () => void;
}) {
  if (isLoading) {
    return (
      <aside className="rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="space-y-3 p-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </aside>
    );
  }

  if (!data) {
    return (
      <aside className="rounded-xl border border-dashed bg-card/70 p-4">
        <div className="rounded-full border bg-muted/40 p-3 w-fit">
          <ListChecks className="size-5 text-muted-foreground" />
        </div>
        <h2 className="mt-4 text-sm font-semibold">Run detail</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Generate a dry run or open a validation run to inspect audit history,
          item IDs, Meta status, errors, local linkage, and sync readiness.
        </p>
      </aside>
    );
  }

  const { run, items } = data;
  const aggregate = getLaunchpadRunAggregateResult(run, items);
  const statusCounts = summarizeLaunchpadRunStatuses(items);
  const canPublish = canShowLaunchpadPublishAction(run);
  const canRetry = canShowLaunchpadRetryAction(run, items);

  return (
    <aside className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Run detail</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatTimestamp(run.createdAt)}
          </p>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={onClear}
          aria-label="Close run detail"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-4 p-4">
        <div className={cn("rounded-lg border p-3", toneClasses(aggregate.tone))}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <Badge variant="secondary">{run.mode ?? "validation"}</Badge>
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">
            {aggregate.label}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {aggregate.detail}
          </p>
        </div>

        <div className="grid gap-2 text-xs">
          <DetailRow label="Run ID">
            <code className="font-mono" title={run.id}>
              {compactId(run.id)}
            </code>
          </DetailRow>
          <DetailRow label="Items">
            <span className="tabular-nums">{items.length}</span>
          </DetailRow>
          <DetailRow label="Manifest">
            <code className="font-mono" title={run.manifestHash ?? undefined}>
              {run.manifestHash ? shortHash(run.manifestHash) : "—"}
            </code>
          </DetailRow>
          <DetailRow label="Live env">
            {run.livePublishEnabledAtValidation ? (
              <Badge>Enabled</Badge>
            ) : (
              <Badge variant="secondary">Disabled</Badge>
            )}
          </DetailRow>
        </div>

        <div className="grid gap-2">
          {canPublish ? (
            <Button
              size="sm"
              variant="default"
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

        <div className="rounded-lg border bg-muted/15 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Status counts
          </p>
          <div className="mt-3 grid gap-2">
            {Object.entries(statusCounts).length > 0 ? (
              Object.entries(statusCounts).map(([status, count]) => (
                <div
                  key={status}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="capitalize text-muted-foreground">
                    {formatLaunchpadStatusLabel(status)}
                  </span>
                  <span className="font-medium tabular-nums">{count}</span>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No persisted items.</p>
            )}
          </div>
        </div>

        <details className="rounded-lg border bg-muted/10">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Full audit and item diagnostics
          </summary>
          <div className="max-h-[72vh] overflow-auto border-t">
            <LaunchpadRunDetailPanel
              data={data}
              isPublishing={isPublishing}
              isRetrying={isRetrying}
              isMarkingManual={isMarkingManual}
              onPublish={onPublish}
              onRetry={onRetry}
              onMarkManual={onMarkManual}
            />
          </div>
        </details>
      </div>
    </aside>
  );
}

export function LaunchpadPageClient() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedAdSetId, setSelectedAdSetId] = useState("");
  const [selectedSourceTemplateId, setSelectedSourceTemplateId] = useState("");
  const [launchName, setLaunchName] = useState("");
  const [dailyBudget, setDailyBudget] = useState("");
  const [selectedCreativeId, setSelectedCreativeId] = useState("");
  const [launchItems, setLaunchItems] = useState<LaunchpadDraftItem[]>([]);
  const [defaultPrimaryText, setDefaultPrimaryText] = useState("");
  const [defaultDestinationUrl, setDefaultDestinationUrl] = useState("");
  const [namingTemplate, setNamingTemplate] = useState("");
  const [cta, setCta] = useState("SHOP_NOW");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [activeStep, setActiveStep] = useState<LaunchpadStep>("destination");

  const runs = useQuery(trpc.launchpad.list.queryOptions({ limit: 50 }));
  const creatives = useQuery(trpc.adCreative.list.queryOptions());
  const sourceTemplates = useQuery(trpc.launchpad.listSourceTemplates.queryOptions());
  const launchpadCreatives = (creatives.data ?? []).filter((creative) =>
    isSupportedLaunchpadFormat(creative.format),
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
  const selectedCreative = launchpadCreatives.find(
    (creative) => creative.id === selectedCreativeId,
  );
  const selectedSourceTemplate = sourceTemplates.data?.find(
    (template) => template.id === selectedSourceTemplateId,
  );
  const selectedManifest = asRecord(selectedRun.data?.run.manifest);
  const selectedManifestTracking = asRecord(selectedManifest.tracking);
  const selectedManifestValidation = asRecord(selectedManifest.validation);
  const selectedManifestBudget = asRecord(selectedManifest.budget);
  const selectedManifestIdentity = asRecord(selectedManifest.identity);
  const selectedManifestCopiedSettings = asSettingsList(selectedManifest.copiedSettings);
  const selectedManifestNotCopiedSettings = asSettingsList(selectedManifest.notCopiedSettings);
  const selectedManifestBlockers = asIssueList(selectedManifestValidation.blockers);
  const selectedManifestWarnings = asIssueList(selectedManifestValidation.warnings);

  const destinationContext = useQuery({
    ...trpc.launchpad.destinationContext.queryOptions({
      accountId: selectedAccountId || "__no_account_selected__",
      adSetId: selectedAdSetId || "__no_ad_set_selected__",
    }),
    enabled: Boolean(selectedAccountId && selectedAdSetId),
  });

  const createCloneRun = useMutation(
    trpc.launchpad.createCloneDryRun.mutationOptions({
      onSuccess: (run) => {
        queryClient.invalidateQueries({ queryKey: trpc.launchpad.list.queryKey() });
        if (run?.id) setSelectedRunId(run.id);
        setActiveStep("preview");
        toast.success("Launch Plan preview recorded");
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
    if (!selectedSourceTemplateId) {
      toast.error("Pick an approved source template first.");
      return;
    }

    if (launchItems.length === 0) {
      toast.error("Choose at least one supported static, video, or UGC creative for the dry run.");
      return;
    }

    const budget = Math.round(Number(dailyBudget) * 100);
    if (!launchName.trim() || !Number.isFinite(budget) || budget <= 0 || !defaultDestinationUrl.trim()) {
      toast.error("Enter a launch name, explicit daily budget, and destination URL.");
      return;
    }

    createCloneRun.mutate({
      idempotencyKey: `clone_dry_run_${crypto.randomUUID()}`,
      sourceTemplateId: selectedSourceTemplateId,
      launchName: launchName.trim(),
      dailyBudgetMinorUnits: budget,
      destinationUrl: defaultDestinationUrl.trim(),
      defaultPrimaryText: defaultPrimaryText.trim() || undefined,
      defaultCta: cta as (typeof metaCtaValues)[number],
      creativeIds: launchItems.map((item) => item.creativeId),
    });
  }

  function publishSelectedRun() {
    if (!selectedRun.data?.run.id) {
      toast.error("Select a validated Launchpad run first.");
      return;
    }

    if (!canShowLaunchpadPublishAction(selectedRun.data.run)) {
      toast.error("Clone setup dry-runs are validation previews only and cannot be published.");
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

  const destinationReady = Boolean(
    selectedSourceTemplateId && selectedSourceTemplate?.readiness.status === "ready",
  );
  const hasDefaultDestinationUrl = Boolean(defaultDestinationUrl.trim());
  const everyItemHasUrl = Boolean(
    launchItems.length > 0 &&
      launchItems.every((item) => item.destinationUrl.trim()),
  );
  const urlCoverageReady = hasDefaultDestinationUrl;
  const defaultUrlLooksValid = urlHasLaunchpadRequirements(defaultDestinationUrl);
  const urlReadinessDetail = hasDefaultDestinationUrl
    ? defaultUrlLooksValid
      ? "Batch URL has HTTPS and UTMs"
      : "Dry run will validate HTTPS and UTMs"
    : everyItemHasUrl
      ? "Every item has a URL override"
      : "Add a batch URL or item URLs";
  const readinessItems: ReadinessChecklistItem[] = [
    {
      label: "Source template",
      detail: selectedSourceTemplate?.label ?? "Pick an approved source campaign/ad set",
      ready: destinationReady,
    },
    {
      label: "Launch inputs",
      detail: launchName.trim() && dailyBudget ? "Name and budget entered" : "Name and explicit daily budget required",
      ready: Boolean(launchName.trim() && Number(dailyBudget) > 0),
    },
    {
      label: `Creatives ${launchItems.length}/${LAUNCHPAD_MAX_ITEMS}`,
      detail: `${launchItems.length}/${LAUNCHPAD_MAX_ITEMS} selected`,
      ready: launchItems.length > 0 && launchItems.length <= LAUNCHPAD_MAX_ITEMS,
    },
    {
      label: "URL",
      detail: urlReadinessDetail,
      ready: urlCoverageReady,
    },
    {
      label: cta.replace(/_/g, " "),
      detail: `CTA ${cta.replace(/_/g, " ")}`,
      ready: true,
    },
  ];
  const dryRunReady = Boolean(
    destinationReady &&
      launchName.trim() &&
      Number(dailyBudget) > 0 &&
      launchItems.length > 0 &&
      urlCoverageReady,
  );
  const launchpadSteps = [
    {
      id: "destination" as const,
      label: "Destination",
      detail: destinationReady ? "Selected" : "Source template",
      ready: destinationReady,
    },
    {
      id: "creatives" as const,
      label: "Creatives",
      detail: `${launchItems.length}/${LAUNCHPAD_MAX_ITEMS} selected`,
      ready: launchItems.length > 0,
    },
    {
      id: "defaults" as const,
      label: "Defaults",
      detail: urlCoverageReady ? "URL covered" : "URL required",
      ready: urlCoverageReady,
    },
    {
      id: "preview" as const,
      label: "Preview",
      detail: selectedRun.data?.run.mode === "clone_setup_validation" ? "Launch Plan" : "Generate plan",
      ready: selectedRun.data?.run.mode === "clone_setup_validation",
    },
    {
      id: "runs" as const,
      label: "Runs",
      detail: runs.data?.length ? `${runs.data.length} recorded` : "Ledger",
      ready: Boolean(runs.data?.length),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold">Creative Launchpad</h1>
              <Badge variant="outline" className="gap-1.5">
                <ShieldCheck className="size-3" /> Dry-run ledger
              </Badge>
              <Badge variant="secondary">Live publish gated</Badge>
            </div>
          </div>
          <Button
            size="sm"
            onClick={createDryRun}
            disabled={createCloneRun.isPending || !dryRunReady}
            className="gap-1.5 lg:ml-auto"
          >
            <Plus className="size-3.5" />
            {createCloneRun.isPending ? "Recording…" : "Generate Launch Plan"}
          </Button>
        </div>
        <div className="space-y-2">
          <ReadinessChecklist items={readinessItems} />
        </div>
      </header>

      <LaunchpadStepper
        activeStep={activeStep}
        onStepChange={setActiveStep}
        steps={launchpadSteps}
      />

      <div
        className={cn(
          "grid gap-4",
          activeStep === "runs" ? "xl:grid-cols-[minmax(0,1fr)_380px]" : "",
        )}
      >
        <main className="min-w-0 space-y-5">
          {activeStep === "destination" ? (
          <section className="rounded-xl border bg-card">
            <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Target className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold">Source setup</h2>
                </div>
              </div>
              {destinationContext.data ? (
                <Badge
                  variant="outline"
                  className="w-fit border-emerald-200 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300"
                >
                  Safe for paused launch
                </Badge>
              ) : null}
            </div>
            <div className="space-y-4 p-4">
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Approved source template
                </label>
                <Select
                  value={selectedSourceTemplateId}
                  onValueChange={setSelectedSourceTemplateId}
                  disabled={sourceTemplates.isLoading}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select source campaign/ad set…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceTemplates.data?.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        <span>{template.label}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {template.sourceCampaign?.name} / {template.sourceAdSet?.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedSourceTemplate ? (
                  <div className="rounded-lg border bg-muted/25 p-3 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">{selectedSourceTemplate.account?.name ?? "Meta account"}</div>
                    <div>Campaign: {selectedSourceTemplate.sourceCampaign?.name ?? "—"}</div>
                    <div>Ad set: {selectedSourceTemplate.sourceAdSet?.name ?? "—"}</div>
                    {selectedSourceTemplate.readiness.status !== "ready" ? (
                      <div className="mt-2 text-amber-600 dark:text-amber-300">
                        This template needs review before Launchpad can use it.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="hidden">
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
                      Account setup incomplete:{" "}
                      {selectedAccount.ineligibleReasons
                        .map(readinessLabel)
                        .join(", ")}
                      .
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
                {selectedAccount?.canPublish &&
                eligibleAdSets.data?.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No eligible linked ad sets for this account yet.
                  </p>
                ) : null}
              </div>

              <div className="rounded-lg border bg-muted/15 p-3">
                <div className="mb-2 flex items-center gap-2">
                  {destinationContext.data ? (
                    <CheckCircle2 className="size-4 text-emerald-600" />
                  ) : (
                    <ShieldCheck className="size-4 text-muted-foreground" />
                  )}
                  <p className="text-sm font-medium">Context</p>
                </div>
                {destinationContext.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                ) : destinationContext.data ? (
                  <details>
                    <summary className="cursor-pointer list-none text-xs">
                      <div className="grid gap-2">
                        <DetailRow label="Campaign">
                          <span className="truncate text-right">
                            {destinationContext.data.adSet.campaign.name ??
                              "Unknown"}
                          </span>
                        </DetailRow>
                        <DetailRow label="Ad set">
                          <span className="truncate text-right">
                            {selectedAdSet?.name ??
                              destinationContext.data.adSet.name}
                          </span>
                        </DetailRow>
                        <DetailRow label="Statuses">
                          <span className="capitalize">
                            {destinationContext.data.adSet.status}
                            {destinationContext.data.adSet.campaign.status ? (
                              <span className="text-muted-foreground">
                                {` · campaign ${destinationContext.data.adSet.campaign.status}`}
                              </span>
                            ) : null}
                          </span>
                        </DetailRow>
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">IDs</p>
                    </summary>
                    <dl className="mt-3 grid gap-2 border-t pt-3 text-xs">
                      <DetailRow label="Account">
                        <span className="text-right font-medium">
                          {destinationContext.data.account.name}
                          <span className="ml-1 text-muted-foreground">
                            {destinationContext.data.account.metaAccountId}
                          </span>
                        </span>
                      </DetailRow>
                      <DetailRow label="Facebook Page">
                        <code className="font-mono">
                          {destinationContext.data.account.defaultFacebookPageId}
                        </code>
                      </DetailRow>
                      {destinationContext.data.account.defaultInstagramActorId ? (
                        <DetailRow label="Instagram actor">
                          <code className="font-mono">
                            {
                              destinationContext.data.account
                                .defaultInstagramActorId
                            }
                          </code>
                        </DetailRow>
                      ) : null}
                      <DetailRow label="Campaign Meta ID">
                        <code className="font-mono">
                          {destinationContext.data.adSet.campaign.metaId ?? "—"}
                        </code>
                      </DetailRow>
                      <DetailRow label="Ad set Meta ID">
                        <code className="font-mono">
                          {destinationContext.data.adSet.metaId}
                        </code>
                      </DetailRow>
                    </dl>
                  </details>
                ) : destinationContext.error ? (
                  <p className="text-xs text-destructive">
                    {destinationContext.error.message}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Select destination.
                  </p>
                )}
              </div>
              </div>
            </div>
          </section>
          ) : null}

          {activeStep === "creatives" ? (
          <section className="rounded-xl border bg-card">
            <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <FileImage className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold">
                    Manifest preview
                  </h2>
                </div>
              </div>
              <Badge variant="outline" className="w-fit">
                {launchItems.length}/{LAUNCHPAD_MAX_ITEMS} selected
              </Badge>
            </div>

            <div className="space-y-4 p-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Add supported creatives
                  </Label>
                  <Select
                    value={selectedCreativeId}
                    onValueChange={setSelectedCreativeId}
                    disabled={
                      creatives.isLoading ||
                      launchItems.length >= LAUNCHPAD_MAX_ITEMS
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose static, video, or UGC…" />
                    </SelectTrigger>
                    <SelectContent>
                      {launchpadCreatives.map((creative) => (
                        <SelectItem
                          key={creative.id}
                          value={creative.id}
                          disabled={launchItems.some(
                            (item) => item.creativeId === creative.id,
                          )}
                        >
                          <span>{creative.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {formatCreativeKind(creative.format)}
                          </span>
                          <span
                            className={cn(
                              "ml-2 text-xs",
                              creativeMediaReadiness(creative).includes(
                                "Missing",
                              )
                                ? "text-amber-600"
                                : "text-muted-foreground",
                            )}
                          >
                            {creativeMediaReadiness(creative)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedCreative ? (
                    <p className="text-xs text-muted-foreground">
                      {creativeMediaReadiness(selectedCreative)}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={addSelectedCreative}
                  disabled={
                    !selectedCreativeId ||
                    launchItems.length >= LAUNCHPAD_MAX_ITEMS
                  }
                  className="w-full lg:w-auto"
                >
                  Add
                </Button>
              </div>

              <ManifestPreviewTable
                launchItems={launchItems}
                launchpadCreatives={launchpadCreatives}
                defaultDestinationUrl={defaultDestinationUrl}
                cta={cta}
                onUpdateItem={updateLaunchItem}
                onRemoveItem={removeLaunchItem}
              />
            </div>
          </section>
          ) : null}

          {activeStep === "defaults" ? (
          <section className="rounded-xl border bg-card">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Batch defaults</h2>
            </div>
            <div className="grid gap-4 p-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="launchName" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Launch name
                </Label>
                <Input
                  id="launchName"
                  value={launchName}
                  onChange={(event) => setLaunchName(event.target.value)}
                  placeholder="June hook test"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dailyBudget" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Daily budget
                </Label>
                <Input
                  id="dailyBudget"
                  type="number"
                  min="1"
                  step="1"
                  value={dailyBudget}
                  onChange={(event) => setDailyBudget(event.target.value)}
                  placeholder="50"
                />
                <p className="text-xs text-muted-foreground">Required. Source budget and spend caps are not copied.</p>
              </div>
              <div className="space-y-2 lg:col-span-2">
                <Label
                  htmlFor="defaultPrimaryText"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Batch primary text / caption pattern
                </Label>
                <Textarea
                  id="defaultPrimaryText"
                  value={defaultPrimaryText}
                  onChange={(event) =>
                    setDefaultPrimaryText(event.target.value)
                  }
                  placeholder="Default launch copy..."
                  className="min-h-24"
                />
              </div>

              <div className="space-y-2 lg:col-span-2">
                <Label
                  htmlFor="defaultUrl"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Destination URL
                </Label>
                <Input
                  id="defaultUrl"
                  value={defaultDestinationUrl}
                  onChange={(event) =>
                    setDefaultDestinationUrl(event.target.value)
                  }
                  placeholder="https://example.com/products?utm_source=meta&utm_medium=paid_social"
                />
                <p
                  className={cn(
                    "text-xs",
                    hasDefaultDestinationUrl && !defaultUrlLooksValid
                      ? "text-amber-600 dark:text-amber-300"
                      : "text-muted-foreground",
                  )}
                >
                  HTTPS required. Missing utm_source/utm_medium will be appended in the Launch Plan.
                </p>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="namingTemplate"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Naming template
                </Label>
                <Input
                  id="namingTemplate"
                  value={namingTemplate}
                  onChange={(event) => setNamingTemplate(event.target.value)}
                  placeholder="Launchpad / {{creative.name}} / {{adSet.name}}"
                />
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
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                Dry-run only
              </span>
              <span>Trigger gated</span>
              <span>
                <code className="text-foreground">PAUSED</code>
              </span>
              <span>
                Cap <code className="text-foreground">{LAUNCHPAD_MAX_ITEMS}</code>
              </span>
            </div>
          </section>
          ) : null}

          {activeStep === "preview" ? (
          <section className="rounded-xl border bg-card">
            <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold">Launch Plan preview</h2>
                <p className="text-xs text-muted-foreground">
                  Dry-run only. No publish CTA is available for Launchpad v2 Milestone 1.
                </p>
              </div>
              <Badge variant="outline">No Meta writes</Badge>
            </div>
            <div className="space-y-4 p-4">
              {selectedRun.data?.run.manifest ? (
                <>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border bg-muted/25 p-3 text-sm">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                      <StatusBadge status={selectedRun.data.run.status} />
                    </div>
                    <div className="rounded-lg border bg-muted/25 p-3 text-sm">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Budget</p>
                      <p className="font-medium">{formatMinorUnits(selectedManifestBudget.dailyBudgetMinorUnits, selectedManifestBudget.currency)}</p>
                    </div>
                    <div className="rounded-lg border bg-muted/25 p-3 text-sm">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Safety</p>
                      <p className="font-medium">Paused plan · dry-run only</p>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">What will be cloned</p>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                        {selectedManifestCopiedSettings.map((setting) => (
                          <li key={setting.key ?? setting.label}>{setting.label ?? setting.key} <span className="text-muted-foreground/80">from {setting.source ?? "source setup"}</span></li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">What will not be copied</p>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                        {selectedManifestNotCopiedSettings.map((setting) => (
                          <li key={setting.key ?? setting.label}>{setting.label ?? setting.key}: {setting.reason ?? "Not copied"}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Tracking</p>
                      <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
                        <DetailRow label="Final URL"><span className="break-all">{displayValue(selectedManifestTracking.finalUrl)}</span></DetailRow>
                        <DetailRow label="Domain">{displayValue(selectedManifestTracking.destinationDomain)}</DetailRow>
                        <DetailRow label="Objective">{displayValue(selectedManifestTracking.objective)}</DetailRow>
                        <DetailRow label="Optimization">{displayValue(selectedManifestTracking.optimizationGoal)}</DetailRow>
                        <DetailRow label="Billing">{displayValue(selectedManifestTracking.billingEvent)}</DetailRow>
                        <DetailRow label="Pixel / promoted object"><span className="break-all">{displayValue(selectedManifestTracking.promotedObject)}</span></DetailRow>
                        <DetailRow label="Conversion">{displayValue(selectedManifestTracking.conversionEvent)}</DetailRow>
                        <DetailRow label="Attribution">{displayValue(selectedManifestTracking.attributionSetting)}</DetailRow>
                      </dl>
                    </div>
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Validation</p>
                      <div className="mt-2 space-y-2 text-xs">
                        {selectedManifestBlockers.length > 0 ? (
                          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                            <p className="font-medium">Blockers</p>
                            <ul className="mt-1 list-disc pl-4">
                              {selectedManifestBlockers.map((issue, index) => (
                                <li key={`${issue.code ?? "blocker"}-${index}`}>{issue.message ?? issue.code}</li>
                              ))}
                            </ul>
                          </div>
                        ) : <p className="text-emerald-700 dark:text-emerald-300">No blockers in this plan.</p>}
                        {selectedManifestWarnings.length > 0 ? (
                          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                            <p className="font-medium">Warnings</p>
                            <ul className="mt-1 list-disc pl-4">
                              {selectedManifestWarnings.map((issue, index) => (
                                <li key={`${issue.code ?? "warning"}-${index}`}>{issue.message ?? issue.code}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Budget and identity</p>
                    <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <DetailRow label="Daily budget">{formatMinorUnits(selectedManifestBudget.dailyBudgetMinorUnits, selectedManifestBudget.currency)}</DetailRow>
                      <DetailRow label="Currency">{displayValue(selectedManifestBudget.currency)}</DetailRow>
                      <DetailRow label="Facebook Page"><code>{displayValue(selectedManifestIdentity.facebookPageId)}</code></DetailRow>
                      <DetailRow label="Instagram actor"><code>{displayValue(selectedManifestIdentity.instagramActorId)}</code></DetailRow>
                    </dl>
                    <p className="mt-2 text-xs text-muted-foreground">Source budget and spend caps are not copied.</p>
                  </div>
                  <details className="rounded-lg border bg-muted/20">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">Technical manifest</summary>
                    <pre className="max-h-[520px] overflow-auto border-t p-3 text-xs">
                      {formatJson(selectedRun.data.run.manifest)}
                    </pre>
                  </details>
                </>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                  Generate a Launch Plan to inspect planned campaign, ad set, ads, tracking, identity, warnings, and blockers.
                </div>
              )}
            </div>
          </section>
          ) : null}

          {activeStep === "runs" ? (
          <section className="rounded-xl border bg-card">
            <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold">Validation runs</h2>
              </div>
            </div>
            {runs.isLoading ? (
              <div className="space-y-3 p-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-10 w-full" />
                ))}
              </div>
            ) : runs.data?.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
                <div className="rounded-full border bg-muted/40 p-3">
                  <ShieldCheck className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No Launchpad runs yet</p>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
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
                      <TableRow
                        key={run.id}
                        className={cn(
                          selectedRunId === run.id ? "bg-muted/30" : "",
                        )}
                      >
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
              </div>
            )}
          </section>
          ) : null}
        </main>

        {activeStep === "runs" &&
        (selectedRunId || selectedRun.data || selectedRun.isLoading) ? (
        <div className="xl:sticky xl:top-4 xl:self-start">
          <LaunchpadRunInspector
            data={selectedRun.data}
            isLoading={selectedRun.isLoading}
            isPublishing={requestPublish.isPending}
            isRetrying={retryFailed.isPending}
            isMarkingManual={markManualIntervention.isPending}
            onPublish={publishSelectedRun}
            onRetry={retrySelectedRun}
            onMarkManual={markItemForManualIntervention}
            onClear={() => setSelectedRunId("")}
          />
        </div>
        ) : null}
      </div>
    </div>
  );
}
