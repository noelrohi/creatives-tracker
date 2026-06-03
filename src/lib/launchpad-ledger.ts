import { createHash } from "crypto";
import {
  DEFAULT_META_CTA,
  LAUNCHPAD_MAX_ITEMS,
  PAUSED_META_STATUS,
  type LaunchpadItemStatus,
  type LaunchpadPrincipalType,
  type LaunchpadRunStatus,
  type MetaCallToAction,
  metaCtaValues,
} from "@/lib/launchpad-constants";

const launchpadManifestVersion = 1;
const manifestKind = "creative_launchpad.publish_manifest";

export type LaunchpadOrgRole = "owner" | "admin" | "member" | null;

type ErrorDetails = Record<string, unknown>;

export type LaunchpadValidationIssue = {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
};

export type LaunchpadValidationSummary = {
  status: "passed" | "failed";
  issueCount: number;
  issues: LaunchpadValidationIssue[];
};

export class LaunchpadLedgerError extends Error {
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "LaunchpadLedgerError";
    this.code = code;
    this.details = details;
  }
}

export type LaunchpadActorInput = {
  accountId?: string | null;
  accountMetaId?: string | null;
  facebookPageId?: string | null;
  instagramActorId?: string | null;
};

export type LaunchpadDestinationInput = {
  adSetId?: string | null;
  adSetMetaId?: string | null;
};

export type LaunchpadManifestItemInput = {
  creativeId?: string | null;
  creativeName?: string | null;
  format?: string | null;
  assetUrl?: string | null;
  videoUrl?: string | null;
  hook?: string | null;
  adName: string;
  adNameSource?: string | null;
  caption?: string | null;
  primaryText?: string | null;
  headline?: string | null;
  headlineSource?: string | null;
  destinationUrl?: string | null;
  cta?: MetaCallToAction;
  ctaSource?: string | null;
  requestedStatus?: typeof PAUSED_META_STATUS;
  target?: Record<string, unknown> | null;
  media?: Record<string, unknown> | null;
  url?: Record<string, unknown> | null;
  expectedMetaObjectShape?: Record<string, unknown> | null;
  validationIssues?: LaunchpadValidationIssue[];
  idempotencyKey?: string | null;
  dedupeKey?: string | null;
};

export type LaunchpadRunDraftInput = {
  organizationId: string;
  requestedBy: {
    userId: string | null;
    principalType: LaunchpadPrincipalType;
    orgRole: LaunchpadOrgRole;
  };
  actor?: LaunchpadActorInput;
  destination?: LaunchpadDestinationInput;
  destinationContext?: Record<string, unknown> | null;
  plannerManifest?: Record<string, unknown> | null;
  validationIssues?: LaunchpadValidationIssue[];
  items: LaunchpadManifestItemInput[];
  idempotencyKey?: string | null;
  env?: Record<string, string | undefined>;
};

export type LaunchpadItemPayload = {
  creative: {
    id: string | null;
    name: string | null;
    format: string | null;
    assetUrl: string | null;
    videoUrl: string | null;
    hook: string | null;
  };
  launch: {
    adName: string;
    adNameSource: string | null;
    caption: string | null;
    primaryText: string | null;
    headline: string | null;
    headlineSource: string | null;
    destinationUrl: string | null;
    cta: MetaCallToAction;
    ctaSource: string | null;
    requestedStatus: typeof PAUSED_META_STATUS;
  };
  target: Record<string, unknown> | null;
  media: Record<string, unknown> | null;
  url: Record<string, unknown> | null;
  expectedMetaObjectShape: Record<string, unknown> | null;
  validation: LaunchpadValidationSummary;
  safety: {
    localAdStatus: "paused";
    metaAdStatus: typeof PAUSED_META_STATUS;
  };
};

export type LaunchpadItemDraft = {
  position: number;
  status: "validated" | "failed";
  creativeId: string | null;
  adName: string;
  cta: MetaCallToAction;
  requestedStatus: typeof PAUSED_META_STATUS;
  validationIssues: LaunchpadValidationIssue[];
  payload: LaunchpadItemPayload;
  payloadHash: string;
  idempotencyKey: string;
  dedupeKey: string;
};

export type LaunchpadManifest = {
  version: typeof launchpadManifestVersion;
  kind: typeof manifestKind;
  mode: "validation";
  requestedStatus: typeof PAUSED_META_STATUS;
  itemCap: typeof LAUNCHPAD_MAX_ITEMS;
  actor: Required<LaunchpadActorInput>;
  destination: Required<LaunchpadDestinationInput>;
  audit: {
    organizationId: string;
    requestedBy: {
      userId: string | null;
      principalType: LaunchpadPrincipalType;
      orgRole: LaunchpadOrgRole;
    };
  };
  destinationContext: Record<string, unknown> | null;
  plannerManifest: Record<string, unknown> | null;
  validation: LaunchpadValidationSummary;
  safety: {
    dryRunOnly: true;
    activePublishingPathAvailable: false;
    livePublishEnabled: boolean;
    campaignCreationAllowed: false;
    adSetCreationAllowed: false;
    localAdsCreatedDuringValidation: false;
  };
  items: Array<{
    position: number;
    status: "validated" | "failed";
    creativeId: string | null;
    creative: LaunchpadItemPayload["creative"];
    launch: LaunchpadItemPayload["launch"];
    target: LaunchpadItemPayload["target"];
    media: LaunchpadItemPayload["media"];
    url: LaunchpadItemPayload["url"];
    expectedMetaObjectShape: LaunchpadItemPayload["expectedMetaObjectShape"];
    validation: LaunchpadValidationSummary;
    adName: string;
    cta: MetaCallToAction;
    requestedStatus: typeof PAUSED_META_STATUS;
    payloadHash: string;
    dedupeKey: string;
  }>;
};

export type LaunchpadRunDraft = {
  status: "validated" | "failed";
  validationIssues: LaunchpadValidationIssue[];
  manifest: LaunchpadManifest;
  manifestHash: string;
  idempotencyKey: string;
  dedupeKey: string;
  items: LaunchpadItemDraft[];
};

export type LivePublishSafetyInput = {
  principalType: LaunchpadPrincipalType;
  orgRole: LaunchpadOrgRole;
  requestedStatus: string;
  itemCount: number;
  confirmationAccepted: boolean;
  previouslyValidatedManifest: boolean;
  campaignCreationRequested?: boolean;
  adSetCreationRequested?: boolean;
  activePublishingPathAvailable?: boolean;
  env?: Record<string, string | undefined>;
};

const runStatusTransitions = {
  validation: ["validated", "failed", "skipped", "cancelled", "manual_intervention"],
  validated: ["queued", "failed", "skipped", "cancelled", "manual_intervention"],
  queued: ["publishing", "failed", "skipped", "cancelled", "manual_intervention"],
  publishing: [
    "success",
    "partial_success",
    "failed",
    "ambiguous",
    "skipped",
    "cancelled",
    "manual_intervention",
  ],
  success: [],
  partial_success: ["queued", "cancelled", "manual_intervention"],
  failed: ["queued", "cancelled", "manual_intervention"],
  ambiguous: ["publishing", "success", "partial_success", "failed", "manual_intervention"],
  skipped: [],
  cancelled: [],
  manual_intervention: ["queued", "cancelled"],
} satisfies Record<LaunchpadRunStatus, LaunchpadRunStatus[]>;

const itemStatusTransitions = {
  validation: ["validated", "failed", "skipped", "cancelled", "manual_intervention"],
  validated: ["queued", "failed", "skipped", "cancelled", "manual_intervention"],
  queued: ["publishing", "failed", "skipped", "cancelled", "manual_intervention"],
  publishing: [
    "success",
    "failed",
    "ambiguous",
    "skipped",
    "cancelled",
    "manual_intervention",
  ],
  success: [],
  partial_success: ["queued", "cancelled", "manual_intervention"],
  failed: ["queued", "skipped", "cancelled", "manual_intervention"],
  ambiguous: ["publishing", "success", "failed", "manual_intervention"],
  skipped: [],
  cancelled: [],
  manual_intervention: ["queued", "skipped", "cancelled"],
} satisfies Record<LaunchpadItemStatus, LaunchpadItemStatus[]>;

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validationSummary(issues: LaunchpadValidationIssue[]): LaunchpadValidationSummary {
  return {
    status: issues.length > 0 ? "failed" : "passed",
    issueCount: issues.length,
    issues,
  };
}

export function summarizeLaunchpadValidationIssues(
  issues: LaunchpadValidationIssue[],
) {
  if (issues.length === 0) return null;

  return {
    errorCategory: "terminal" as const,
    errorCode: "LAUNCHPAD_VALIDATION_FAILED",
    errorMessage:
      issues.length === 1
        ? issues[0]?.message ?? "Launchpad dry-run validation failed"
        : `Launchpad dry-run validation failed with ${issues.length} QA issues`,
    errorDetails: { issues },
  };
}

function requireNonEmpty(value: string, code: string, field: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LaunchpadLedgerError(code, `${field} is required`, { field });
  }
  return trimmed;
}

function assertKnownCta(value: MetaCallToAction) {
  if (!metaCtaValues.includes(value)) {
    throw new LaunchpadLedgerError(
      "INVALID_META_CTA",
      "Launchpad payload uses an unsupported Meta CTA",
      { cta: value },
    );
  }
}

function assertHttpsUrl(value: string | null) {
  if (!value) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LaunchpadLedgerError(
      "INVALID_DESTINATION_URL",
      "Destination URL must be a valid HTTPS URL",
      { destinationUrl: value },
    );
  }

  if (parsed.protocol !== "https:") {
    throw new LaunchpadLedgerError(
      "INVALID_DESTINATION_URL",
      "Destination URL must use HTTPS",
      { destinationUrl: value },
    );
  }
}

function assertPausedRequestedStatus(value: string) {
  if (value !== PAUSED_META_STATUS) {
    throw new LaunchpadLedgerError(
      "ACTIVE_META_STATUS_FORBIDDEN",
      "Launchpad can only request PAUSED Meta ads",
      { requestedStatus: value },
    );
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export function hashLaunchpadPayload(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function isMetaPublishEnabled(env: Record<string, string | undefined> = process.env) {
  return env.ADSOLUTE_META_PUBLISH_ENABLED === "true";
}

export function assertLaunchpadItemCap(itemCount: number) {
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new LaunchpadLedgerError(
      "ITEM_COUNT_REQUIRED",
      "A Launchpad run must contain at least one item",
      { itemCount },
    );
  }

  if (itemCount > LAUNCHPAD_MAX_ITEMS) {
    throw new LaunchpadLedgerError(
      "ITEM_CAP_EXCEEDED",
      `Launchpad runs are capped at ${LAUNCHPAD_MAX_ITEMS} items`,
      { itemCount, maxItemCap: LAUNCHPAD_MAX_ITEMS },
    );
  }
}

export function assertRunStatusTransition(
  currentStatus: LaunchpadRunStatus,
  nextStatus: LaunchpadRunStatus,
) {
  const allowedStatuses = runStatusTransitions[currentStatus] as readonly LaunchpadRunStatus[];
  if (!allowedStatuses.includes(nextStatus)) {
    throw new LaunchpadLedgerError(
      "INVALID_RUN_STATUS_TRANSITION",
      `Cannot transition Launchpad run from ${currentStatus} to ${nextStatus}`,
      { currentStatus, nextStatus },
    );
  }
}

export function assertItemStatusTransition(
  currentStatus: LaunchpadItemStatus,
  nextStatus: LaunchpadItemStatus,
) {
  const allowedStatuses = itemStatusTransitions[currentStatus] as readonly LaunchpadItemStatus[];
  if (!allowedStatuses.includes(nextStatus)) {
    throw new LaunchpadLedgerError(
      "INVALID_ITEM_STATUS_TRANSITION",
      `Cannot transition Launchpad item from ${currentStatus} to ${nextStatus}`,
      { currentStatus, nextStatus },
    );
  }
}

function normalizeActor(actor: LaunchpadActorInput | undefined): Required<LaunchpadActorInput> {
  return {
    accountId: normalizedText(actor?.accountId),
    accountMetaId: normalizedText(actor?.accountMetaId),
    facebookPageId: normalizedText(actor?.facebookPageId),
    instagramActorId: normalizedText(actor?.instagramActorId),
  };
}

function normalizeDestination(
  destination: LaunchpadDestinationInput | undefined,
): Required<LaunchpadDestinationInput> {
  return {
    adSetId: normalizedText(destination?.adSetId),
    adSetMetaId: normalizedText(destination?.adSetMetaId),
  };
}

function buildItemPayload(item: LaunchpadManifestItemInput): LaunchpadItemPayload {
  const requestedStatus = item.requestedStatus ?? PAUSED_META_STATUS;
  assertPausedRequestedStatus(requestedStatus);
  const cta = item.cta ?? DEFAULT_META_CTA;
  assertKnownCta(cta);
  const adName = requireNonEmpty(item.adName, "AD_NAME_REQUIRED", "adName");
  const destinationUrl = normalizedText(item.destinationUrl);
  assertHttpsUrl(destinationUrl);
  const validationIssues = item.validationIssues ?? [];

  return {
    creative: {
      id: normalizedText(item.creativeId),
      name: normalizedText(item.creativeName),
      format: normalizedText(item.format),
      assetUrl: normalizedText(item.assetUrl),
      videoUrl: normalizedText(item.videoUrl),
      hook: normalizedText(item.hook),
    },
    launch: {
      adName,
      adNameSource: normalizedText(item.adNameSource),
      caption: normalizedText(item.caption),
      primaryText: normalizedText(item.primaryText ?? item.caption),
      headline: normalizedText(item.headline),
      headlineSource: normalizedText(item.headlineSource),
      destinationUrl,
      cta,
      ctaSource: normalizedText(item.ctaSource),
      requestedStatus,
    },
    target: item.target ?? null,
    media: item.media ?? null,
    url: item.url ?? null,
    expectedMetaObjectShape: item.expectedMetaObjectShape ?? null,
    validation: validationSummary(validationIssues),
    safety: {
      localAdStatus: "paused",
      metaAdStatus: PAUSED_META_STATUS,
    },
  };
}

function prefixedHash(prefix: string, value: unknown) {
  return `${prefix}_${hashLaunchpadPayload(value).slice(0, 48)}`;
}

export function createLaunchpadRunDraft(input: LaunchpadRunDraftInput): LaunchpadRunDraft {
  assertLaunchpadItemCap(input.items.length);

  const actor = normalizeActor(input.actor);
  const destination = normalizeDestination(input.destination);
  const audit = {
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
  };
  const publishDestination = {
    accountId: actor.accountId,
    accountMetaId: actor.accountMetaId,
    facebookPageId: actor.facebookPageId,
    instagramActorId: actor.instagramActorId,
    adSetId: destination.adSetId,
    adSetMetaId: destination.adSetMetaId,
  };
  const itemIntentHashes: string[] = [];

  const items = input.items.map((item, index): LaunchpadItemDraft => {
    const payload = buildItemPayload(item);
    const payloadHash = hashLaunchpadPayload(payload);
    const position = index + 1;
    const itemIntentHash = prefixedHash("lpi_intent", {
      organizationId: input.organizationId,
      destination: publishDestination,
      creativeId: payload.creative.id,
      payloadHash,
    });
    itemIntentHashes.push(itemIntentHash);
    const dedupeKey = normalizedText(item.dedupeKey) ?? itemIntentHash;
    const idempotencyKey =
      normalizedText(item.idempotencyKey) ??
      prefixedHash("lpi", {
        organizationId: input.organizationId,
        dedupeKey,
        payloadHash,
      });

    const validationIssues = item.validationIssues ?? [];
    const status = validationIssues.length > 0 ? "failed" : "validated";

    return {
      position,
      status,
      creativeId: payload.creative.id,
      adName: payload.launch.adName,
      cta: payload.launch.cta,
      requestedStatus: payload.launch.requestedStatus,
      validationIssues,
      payload,
      payloadHash,
      idempotencyKey,
      dedupeKey,
    };
  });

  const validationIssues = input.validationIssues ?? items.flatMap((item) => item.validationIssues);
  const runStatus = validationIssues.length > 0 ? "failed" : "validated";
  const runValidation = validationSummary(validationIssues);

  const manifest: LaunchpadManifest = {
    version: launchpadManifestVersion,
    kind: manifestKind,
    mode: "validation",
    requestedStatus: PAUSED_META_STATUS,
    itemCap: LAUNCHPAD_MAX_ITEMS,
    actor,
    destination,
    audit,
    destinationContext: input.destinationContext ?? null,
    plannerManifest: input.plannerManifest ?? null,
    validation: runValidation,
    safety: {
      dryRunOnly: true,
      activePublishingPathAvailable: false,
      livePublishEnabled: isMetaPublishEnabled(input.env),
      campaignCreationAllowed: false,
      adSetCreationAllowed: false,
      localAdsCreatedDuringValidation: false,
    },
    items: items.map((item) => ({
      position: item.position,
      status: item.status,
      creativeId: item.creativeId,
      creative: item.payload.creative,
      launch: item.payload.launch,
      target: item.payload.target,
      media: item.payload.media,
      url: item.payload.url,
      expectedMetaObjectShape: item.payload.expectedMetaObjectShape,
      validation: item.payload.validation,
      adName: item.adName,
      cta: item.cta,
      requestedStatus: item.requestedStatus,
      payloadHash: item.payloadHash,
      dedupeKey: item.dedupeKey,
    })),
  };
  const manifestHash = hashLaunchpadPayload(manifest);
  const dedupeKey = prefixedHash("lpr_dedupe", {
    organizationId: input.organizationId,
    destination: publishDestination,
    itemIntentHashes: [...itemIntentHashes].sort(),
  });
  const idempotencyKey =
    normalizedText(input.idempotencyKey) ??
    prefixedHash("lpr", {
      organizationId: input.organizationId,
      manifestHash,
    });

  return {
    status: runStatus,
    validationIssues,
    manifest,
    manifestHash,
    idempotencyKey,
    dedupeKey,
    items,
  };
}

export function assertLockedHashStable(input: {
  label: "manifest" | "payload";
  lockedHash: string;
  nextValue: unknown;
}) {
  const nextHash = hashLaunchpadPayload(input.nextValue);
  if (nextHash !== input.lockedHash) {
    throw new LaunchpadLedgerError(
      "LOCKED_HASH_CHANGED",
      `Locked Launchpad ${input.label} cannot be changed after persistence`,
      {
        label: input.label,
        lockedHash: input.lockedHash,
        nextHash,
      },
    );
  }
}

function isPrivilegedRole(role: LaunchpadOrgRole) {
  return role === "admin" || role === "owner";
}

export function assertLivePublishSafety(input: LivePublishSafetyInput) {
  if (input.principalType !== "session" || !isPrivilegedRole(input.orgRole)) {
    throw new LaunchpadLedgerError(
      "LIVE_PUBLISH_REQUIRES_ADMIN_SESSION",
      "Live Launchpad publishing requires an authenticated admin or owner session",
      {
        principalType: input.principalType,
        orgRole: input.orgRole,
      },
    );
  }

  assertLaunchpadItemCap(input.itemCount);
  assertPausedRequestedStatus(input.requestedStatus);

  if (input.campaignCreationRequested) {
    throw new LaunchpadLedgerError(
      "CAMPAIGN_CREATION_FORBIDDEN",
      "Launchpad cannot create Meta campaigns in this release",
    );
  }

  if (input.adSetCreationRequested) {
    throw new LaunchpadLedgerError(
      "AD_SET_CREATION_FORBIDDEN",
      "Launchpad cannot create Meta ad sets in this release",
    );
  }

  if (!isMetaPublishEnabled(input.env)) {
    throw new LaunchpadLedgerError(
      "LIVE_PUBLISH_ENV_DISABLED",
      "Live Launchpad publishing is disabled unless ADSOLUTE_META_PUBLISH_ENABLED=true",
    );
  }

  if (!input.confirmationAccepted) {
    throw new LaunchpadLedgerError(
      "LIVE_PUBLISH_CONFIRMATION_REQUIRED",
      "Live Launchpad publishing requires explicit paused-publish confirmation",
    );
  }

  if (!input.previouslyValidatedManifest) {
    throw new LaunchpadLedgerError(
      "VALIDATED_MANIFEST_REQUIRED",
      "Live Launchpad publishing requires a previously validated immutable manifest",
    );
  }

  if (!input.activePublishingPathAvailable) {
    throw new LaunchpadLedgerError(
      "LIVE_PUBLISH_PATH_UNAVAILABLE",
      "Live Meta publishing is intentionally unavailable in this ledger foundation slice",
    );
  }
}

export function computeRunAggregateStatus(
  itemStatuses: LaunchpadItemStatus[],
): LaunchpadRunStatus {
  if (itemStatuses.length === 0) return "validation";
  if (itemStatuses.some((status) => status === "publishing")) {
    return "publishing";
  }
  if (itemStatuses.some((status) => status === "queued")) {
    const hasStartedItem = itemStatuses.some(
      (status) => !["validation", "validated", "queued"].includes(status),
    );
    return hasStartedItem ? "publishing" : "queued";
  }
  if (itemStatuses.some((status) => status === "manual_intervention")) {
    return "manual_intervention";
  }
  if (itemStatuses.some((status) => status === "ambiguous")) {
    return "ambiguous";
  }
  if (itemStatuses.every((status) => status === "success")) {
    return "success";
  }
  if (itemStatuses.some((status) => status === "success")) {
    return "partial_success";
  }
  if (itemStatuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (itemStatuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (itemStatuses.every((status) => status === "cancelled")) {
    return "cancelled";
  }
  if (itemStatuses.every((status) => status === "validated")) {
    return "validated";
  }
  if (itemStatuses.every((status) => status === "validation")) {
    return "validation";
  }
  return "cancelled";
}
