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
  adName: string;
  caption?: string | null;
  headline?: string | null;
  destinationUrl?: string | null;
  cta?: MetaCallToAction;
  requestedStatus?: typeof PAUSED_META_STATUS;
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
  };
  launch: {
    adName: string;
    caption: string | null;
    headline: string | null;
    destinationUrl: string | null;
    cta: MetaCallToAction;
    requestedStatus: typeof PAUSED_META_STATUS;
  };
  safety: {
    localAdStatus: "paused";
    metaAdStatus: typeof PAUSED_META_STATUS;
  };
};

export type LaunchpadItemDraft = {
  position: number;
  creativeId: string | null;
  adName: string;
  cta: MetaCallToAction;
  requestedStatus: typeof PAUSED_META_STATUS;
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
    creativeId: string | null;
    adName: string;
    cta: MetaCallToAction;
    requestedStatus: typeof PAUSED_META_STATUS;
    payloadHash: string;
    dedupeKey: string;
  }>;
};

export type LaunchpadRunDraft = {
  status: "validated";
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

  return {
    creative: {
      id: normalizedText(item.creativeId),
      name: normalizedText(item.creativeName),
      format: normalizedText(item.format),
      assetUrl: normalizedText(item.assetUrl),
    },
    launch: {
      adName,
      caption: normalizedText(item.caption),
      headline: normalizedText(item.headline),
      destinationUrl,
      cta,
      requestedStatus,
    },
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

    return {
      position,
      creativeId: payload.creative.id,
      adName: payload.launch.adName,
      cta: payload.launch.cta,
      requestedStatus: payload.launch.requestedStatus,
      payload,
      payloadHash,
      idempotencyKey,
      dedupeKey,
    };
  });

  const manifest: LaunchpadManifest = {
    version: launchpadManifestVersion,
    kind: manifestKind,
    mode: "validation",
    requestedStatus: PAUSED_META_STATUS,
    itemCap: LAUNCHPAD_MAX_ITEMS,
    actor,
    destination,
    audit,
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
      creativeId: item.creativeId,
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
    status: "validated",
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
  if (itemStatuses.some((status) => status === "manual_intervention")) {
    return "manual_intervention";
  }
  if (itemStatuses.some((status) => status === "ambiguous")) {
    return "ambiguous";
  }
  if (itemStatuses.some((status) => status === "publishing")) {
    return "publishing";
  }
  if (itemStatuses.some((status) => status === "queued")) {
    return "queued";
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
