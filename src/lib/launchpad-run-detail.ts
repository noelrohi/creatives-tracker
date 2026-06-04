import type {
  LaunchpadErrorCategory,
  LaunchpadItemStatus,
  LaunchpadReconciliationStatus,
  LaunchpadRunStatus,
} from "@/lib/launchpad-constants";

type Dateish = Date | string | null | undefined;

type LaunchpadPayloadPreview = {
  creative?: {
    id?: string | null;
    name?: string | null;
    format?: string | null;
    assetUrl?: string | null;
    videoUrl?: string | null;
    hook?: string | null;
  } | null;
  launch?: {
    adName?: string | null;
    adNameSource?: string | null;
    primaryText?: string | null;
    caption?: string | null;
    headline?: string | null;
    headlineSource?: string | null;
    destinationUrl?: string | null;
    cta?: string | null;
    ctaSource?: string | null;
    requestedStatus?: string | null;
  } | null;
  media?: {
    type?: string | null;
    uploadMethod?: string | null;
    sourceUrl?: string | null;
    thumbnailUrl?: string | null;
  } | null;
  url?: {
    finalUrl?: string | null;
    source?: string | null;
    missingRequiredUtmParameters?: string[] | null;
  } | null;
  safety?: {
    localAdStatus?: string | null;
    metaAdStatus?: string | null;
  } | null;
};

export type LaunchpadRunDetailRun = {
  id: string;
  status: LaunchpadRunStatus | string;
  mode?: string | null;
  requestedStatus?: string | null;
  itemCount?: number | null;
  manifestHash?: string | null;
  actorAccountId?: string | null;
  actorAccountMetaId?: string | null;
  actorPageId?: string | null;
  actorInstagramId?: string | null;
  destinationAdSetId?: string | null;
  destinationAdSetMetaId?: string | null;
  requestedByUserId?: string | null;
  requestedByPrincipalType?: string | null;
  requestedByRole?: string | null;
  livePublishEnabledAtValidation?: boolean | null;
  retryCount?: number | null;
  lastRetryRequestedAt?: Dateish;
  reconciliationStatus?: LaunchpadReconciliationStatus | string | null;
  errorCategory?: LaunchpadErrorCategory | string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  manualInterventionReason?: string | null;
  validatedAt?: Dateish;
  queuedAt?: Dateish;
  startedAt?: Dateish;
  completedAt?: Dateish;
  cancelledAt?: Dateish;
  createdAt?: Dateish;
  updatedAt?: Dateish;
};

export type LaunchpadRunDetailItem = {
  id: string;
  position?: number | null;
  status: LaunchpadItemStatus | string;
  requestedStatus?: string | null;
  creativeId?: string | null;
  localAdId?: string | null;
  requestedAdName?: string | null;
  externalMetaCreativeId?: string | null;
  externalMetaVideoId?: string | null;
  externalMetaAdId?: string | null;
  rawMetaConfiguredStatus?: string | null;
  rawMetaEffectiveStatus?: string | null;
  errorCategory?: LaunchpadErrorCategory | string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorDetails?: Record<string, unknown> | null;
  reconciliationStatus?: LaunchpadReconciliationStatus | string | null;
  manualInterventionReason?: string | null;
  retryCount?: number | null;
  lastRetryRequestedAt?: Dateish;
  validatedAt?: Dateish;
  queuedAt?: Dateish;
  startedAt?: Dateish;
  completedAt?: Dateish;
  payload?: unknown;
  localAd?: {
    id: string | null;
    name?: string | null;
    status?: string | null;
    metaId?: string | null;
    metaVideoId?: string | null;
    destinationUrl?: string | null;
    rawMetaConfiguredStatus?: string | null;
    rawMetaEffectiveStatus?: string | null;
  } | null;
};

export type LaunchpadDiagnosticRow = {
  label: string;
  value: string;
  tone: "neutral" | "warning" | "danger" | "success";
};

const retryableRunStatuses = new Set([
  "failed",
  "partial_success",
  "ambiguous",
  "manual_intervention",
]);

const manualInterventionItemStatuses = new Set([
  "queued",
  "publishing",
  "failed",
  "ambiguous",
  "manual_intervention",
]);

function asPayload(value: unknown): LaunchpadPayloadPreview {
  if (!value || typeof value !== "object") return {};
  return value as LaunchpadPayloadPreview;
}

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatDateForReadiness(value: Dateish) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function hasRetryCandidate(item: LaunchpadRunDetailItem) {
  if (["success", "skipped", "cancelled"].includes(item.status)) return false;
  if (item.errorCategory === "terminal") return false;

  return Boolean(
    (item.status === "failed" && item.errorCategory === "retryable" && !item.externalMetaAdId) ||
      item.status === "ambiguous" ||
      item.errorCategory === "ambiguous" ||
      item.externalMetaAdId,
  );
}

export function formatLaunchpadStatusLabel(status: string | null | undefined) {
  return normalizedText(status)?.replace(/_/g, " ") ?? "unknown";
}

export function summarizeLaunchpadRunStatuses(items: LaunchpadRunDetailItem[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function getLaunchpadRunAggregateResult(
  run: LaunchpadRunDetailRun,
  items: LaunchpadRunDetailItem[],
) {
  const counts = summarizeLaunchpadRunStatuses(items);
  const status = run.status;
  const failed = (counts.failed ?? 0) + (counts.ambiguous ?? 0) + (counts.manual_intervention ?? 0);
  const succeeded = counts.success ?? 0;

  if (status === "success") {
    return {
      label: "All items published",
      tone: "success" as const,
      detail: `${succeeded}/${items.length} items have Meta ad IDs and reconciled linkage.`,
      counts,
    };
  }

  if (status === "partial_success") {
    return {
      label: "Partial success",
      tone: "warning" as const,
      detail: `${succeeded}/${items.length} items succeeded; ${failed} need retry, reconciliation, or manual review.`,
      counts,
    };
  }

  if (status === "failed" || status === "ambiguous" || status === "manual_intervention") {
    return {
      label: formatLaunchpadStatusLabel(status),
      tone: status === "failed" ? "danger" as const : "warning" as const,
      detail: `${failed || items.length} item${(failed || items.length) === 1 ? "" : "s"} need operator attention before this run can be trusted.`,
      counts,
    };
  }

  if (status === "queued" || status === "publishing") {
    return {
      label: formatLaunchpadStatusLabel(status),
      tone: "neutral" as const,
      detail: "Trigger is expected to publish queued items as paused Meta ads and update this ledger.",
      counts,
    };
  }

  return {
    label: formatLaunchpadStatusLabel(status),
    tone: "neutral" as const,
    detail: "Inspect the frozen manifest, validation result, and item diagnostics before publishing.",
    counts,
  };
}

export function getLaunchpadItemManifestSummary(item: LaunchpadRunDetailItem) {
  const payload = asPayload(item.payload);
  const creativeId = normalizedText(payload.creative?.id) ?? normalizedText(item.creativeId);
  const adName = normalizedText(item.requestedAdName) ?? normalizedText(payload.launch?.adName);

  return {
    creativeId,
    creativeName: normalizedText(payload.creative?.name),
    creativeFormat: normalizedText(payload.creative?.format),
    creativeAssetUrl: normalizedText(payload.creative?.assetUrl),
    creativeVideoUrl: normalizedText(payload.creative?.videoUrl),
    mediaType: normalizedText(payload.media?.type),
    mediaUploadMethod: normalizedText(payload.media?.uploadMethod),
    mediaSourceUrl: normalizedText(payload.media?.sourceUrl),
    mediaThumbnailUrl: normalizedText(payload.media?.thumbnailUrl),
    adName,
    adNameSource: normalizedText(payload.launch?.adNameSource),
    finalUrl:
      normalizedText(payload.launch?.destinationUrl) ?? normalizedText(payload.url?.finalUrl),
    urlSource: normalizedText(payload.url?.source),
    cta: normalizedText(payload.launch?.cta),
    ctaSource: normalizedText(payload.launch?.ctaSource),
    headline: normalizedText(payload.launch?.headline),
    headlineSource: normalizedText(payload.launch?.headlineSource),
    primaryText:
      normalizedText(payload.launch?.primaryText) ?? normalizedText(payload.launch?.caption),
    requestedStatus:
      normalizedText(item.requestedStatus) ?? normalizedText(payload.launch?.requestedStatus),
    plannedLocalStatus: normalizedText(payload.safety?.localAdStatus) ?? "paused",
    missingRequiredUtmParameters: payload.url?.missingRequiredUtmParameters ?? [],
  };
}

export function getLaunchpadStatusBreakdown(item: LaunchpadRunDetailItem) {
  const manifest = getLaunchpadItemManifestSummary(item);
  const localStatus =
    normalizedText(item.localAd?.status) ??
    (item.localAdId ? manifest.plannedLocalStatus : "not_created");

  return {
    local: {
      label: localStatus === "not_created" ? "Local ad not created" : `Local ad: ${formatLaunchpadStatusLabel(localStatus)}`,
      status: localStatus,
    },
    meta: {
      configured:
        normalizedText(item.rawMetaConfiguredStatus) ??
        normalizedText(item.localAd?.rawMetaConfiguredStatus),
      effective:
        normalizedText(item.rawMetaEffectiveStatus) ??
        normalizedText(item.localAd?.rawMetaEffectiveStatus),
    },
  };
}

function safeNumericMetaId(value: string | null | undefined) {
  const trimmed = normalizedText(value);
  if (!trimmed) return null;
  const withoutActPrefix = trimmed.startsWith("act_") ? trimmed.slice(4) : trimmed;
  return /^\d+$/.test(withoutActPrefix) ? withoutActPrefix : null;
}

export function buildMetaAdsManagerAdUrl(input: {
  accountMetaId?: string | null;
  adMetaId?: string | null;
}) {
  const accountId = safeNumericMetaId(input.accountMetaId);
  const adId = safeNumericMetaId(input.adMetaId);
  if (!accountId || !adId) return null;

  const url = new URL("https://www.facebook.com/adsmanager/manage/ads");
  url.searchParams.set("act", accountId);
  url.searchParams.set("selected_ad_ids", adId);
  return url.toString();
}

export function buildLaunchpadLocalAdHref(item: LaunchpadRunDetailItem) {
  const creativeId = getLaunchpadItemManifestSummary(item).creativeId;
  if (!item.localAdId || !creativeId) return null;
  return `/creatives/${encodeURIComponent(creativeId)}?tab=ads`;
}

export function canShowLaunchpadRetryAction(
  run: LaunchpadRunDetailRun | null | undefined,
  items: LaunchpadRunDetailItem[] = [],
) {
  if (!run || !retryableRunStatuses.has(run.status)) return false;
  if (items.length === 0) return true;
  return items.some(hasRetryCandidate);
}

export function canShowLaunchpadManualInterventionAction(
  item: LaunchpadRunDetailItem,
) {
  if (item.status === "success" && item.externalMetaAdId) return false;
  if (["skipped", "cancelled"].includes(item.status)) return false;
  return manualInterventionItemStatuses.has(item.status);
}

export function getLaunchpadItemDiagnostics(
  item: LaunchpadRunDetailItem,
): LaunchpadDiagnosticRow[] {
  const rows: LaunchpadDiagnosticRow[] = [];

  if (item.errorCategory) {
    rows.push({
      label: "Classification",
      value: formatLaunchpadStatusLabel(item.errorCategory),
      tone: item.errorCategory === "terminal" ? "danger" : "warning",
    });
  }

  if (item.errorCode || item.errorMessage) {
    rows.push({
      label: item.errorCode ? `Error ${item.errorCode}` : "Error",
      value: item.errorMessage ?? item.errorCode ?? "Unknown Launchpad error",
      tone: item.errorCategory === "terminal" ? "danger" : "warning",
    });
  }

  if (item.errorDetails && Object.keys(item.errorDetails).length > 0) {
    rows.push({
      label: "Details",
      value: JSON.stringify(item.errorDetails),
      tone: item.errorCategory === "terminal" ? "danger" : "warning",
    });
  }

  if (item.reconciliationStatus && item.reconciliationStatus !== "not_required") {
    rows.push({
      label: "Reconciliation",
      value: formatLaunchpadStatusLabel(item.reconciliationStatus),
      tone: item.reconciliationStatus === "reconciled" ? "success" : "warning",
    });
  }

  if (item.manualInterventionReason) {
    rows.push({
      label: "Manual intervention",
      value: item.manualInterventionReason,
      tone: "warning",
    });
  }

  if (item.retryCount) {
    const lastRetry = formatDateForReadiness(item.lastRetryRequestedAt);
    rows.push({
      label: "Retries",
      value: lastRetry ? `${item.retryCount} · last requested ${lastRetry}` : String(item.retryCount),
      tone: "neutral",
    });
  }

  return rows;
}

export function getLaunchpadPerformanceSyncReadiness(item: LaunchpadRunDetailItem) {
  if (!item.externalMetaAdId) {
    return {
      ready: false,
      tone: "neutral" as const,
      label: "Waiting for Meta ad ID",
      message:
        "Performance cannot link yet because this item has not produced a Meta ad ID.",
    };
  }

  if (!item.localAdId) {
    return {
      ready: false,
      tone: "warning" as const,
      label: "Meta ID saved, local link incomplete",
      message:
        "A Meta ad ID exists, but the local paused ad row must be reconciled before performance linkage is trustworthy.",
    };
  }

  return {
    ready: true,
    tone: "success" as const,
    label: "Ready for Meta sync linkage",
    message:
      "Existing Meta performance sync will attach spend and delivery metrics after it sees this created ad ID.",
  };
}
