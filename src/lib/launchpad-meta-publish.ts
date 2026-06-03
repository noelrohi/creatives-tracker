import {
  PAUSED_META_STATUS,
  type LaunchpadErrorCategory,
  type MetaCallToAction,
} from "@/lib/launchpad-constants";
import { META_GRAPH_API_BASE } from "@/lib/meta-insights-sync";

export type LaunchpadMetaOperation =
  | "upload_image"
  | "create_creative"
  | "create_ad"
  | "reconcile_ad";

export type SanitizedMetaErrorDetails = {
  operation: LaunchpadMetaOperation;
  httpStatus?: number;
  httpStatusText?: string;
  metaType?: string;
  metaCode?: number;
  metaSubcode?: number;
  metaIsTransient?: boolean;
  metaMessage?: string;
};

export class LaunchpadMetaPublishError extends Error {
  readonly category: LaunchpadErrorCategory;
  readonly code: string;
  readonly operation: LaunchpadMetaOperation;
  readonly details: SanitizedMetaErrorDetails | Record<string, unknown>;

  constructor(input: {
    category: LaunchpadErrorCategory;
    code: string;
    message: string;
    operation: LaunchpadMetaOperation;
    details?: SanitizedMetaErrorDetails | Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "LaunchpadMetaPublishError";
    this.category = input.category;
    this.code = input.code;
    this.operation = input.operation;
    this.details = input.details ?? { operation: input.operation };
  }
}

type MetaErrorBody = {
  error?: {
    type?: string;
    message?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
  };
};

type MetaImageUploadResponse = {
  images?: Record<string, { hash?: string }>;
  data?: Array<{ hash?: string }>;
  hash?: string;
};

type MetaIdResponse = {
  id?: string;
};

export type MetaAdSnapshot = {
  id?: string;
  adset_id?: string;
  creative?: { id?: string } | string;
  configured_status?: string;
  effective_status?: string;
  status?: string;
};

export type MetaReconciliationResult = {
  ok: boolean;
  rawMetaConfiguredStatus: string | null;
  rawMetaEffectiveStatus: string | null;
  details: Record<string, unknown>;
  failureReason?: string;
};

export function metaAccountNode(metaAccountId: string) {
  const normalized = metaAccountId.trim();
  return normalized.startsWith("act_") ? normalized : `act_${normalized}`;
}

function redactMetaSecrets(value: string) {
  return value
    .replace(/access_token=([^&\s]+)/gi, "access_token=<redacted>")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>");
}

function sanitizedMetaDetails(
  operation: LaunchpadMetaOperation,
  response: { status: number; statusText: string },
  body: MetaErrorBody | null,
): SanitizedMetaErrorDetails {
  const metaError = body?.error;
  return {
    operation,
    httpStatus: response.status,
    httpStatusText: response.statusText,
    metaType: metaError?.type,
    metaCode: metaError?.code,
    metaSubcode: metaError?.error_subcode,
    metaIsTransient: metaError?.is_transient,
    metaMessage: metaError?.message
      ? redactMetaSecrets(metaError.message).slice(0, 500)
      : undefined,
  };
}

function classifyMetaHttpError(
  operation: LaunchpadMetaOperation,
  response: { status: number; statusText: string },
  body: MetaErrorBody | null,
): LaunchpadMetaPublishError {
  const details = sanitizedMetaDetails(operation, response, body);
  const metaMessage = details.metaMessage ?? response.statusText;

  if (response.status === 429) {
    return new LaunchpadMetaPublishError({
      category: "retryable",
      code: "META_RATE_LIMIT",
      message: "Meta API rate limit reached while publishing Launchpad item",
      operation,
      details,
    });
  }

  if (response.status >= 500) {
    return new LaunchpadMetaPublishError({
      category: "retryable",
      code: "META_SERVER_ERROR",
      message: "Meta API returned a server error while publishing Launchpad item",
      operation,
      details,
    });
  }

  if (body?.error?.type === "OAuthException" || response.status === 401 || response.status === 403) {
    return new LaunchpadMetaPublishError({
      category: "terminal",
      code: "META_AUTH_ERROR",
      message: `Meta authorization failed while publishing Launchpad item: ${metaMessage}`,
      operation,
      details,
    });
  }

  return new LaunchpadMetaPublishError({
    category: "terminal",
    code: "META_API_ERROR",
    message: `Meta API rejected the Launchpad publish request: ${metaMessage}`,
    operation,
    details,
  });
}

function classifyFetchFailure(
  operation: LaunchpadMetaOperation,
  error: unknown,
): LaunchpadMetaPublishError {
  const message = redactMetaSecrets(error instanceof Error ? error.message : String(error));
  const name = error instanceof Error ? error.name : undefined;
  const isTimeout = name === "AbortError" || /timeout|timed out/i.test(message);

  return new LaunchpadMetaPublishError({
    category: "retryable",
    code: isTimeout ? "META_TIMEOUT" : "META_NETWORK_ERROR",
    message: isTimeout
      ? "Meta API request timed out while publishing Launchpad item"
      : "Meta API network request failed while publishing Launchpad item",
    operation,
    details: {
      operation,
      errorName: name,
      errorMessage: message.slice(0, 500),
    },
  });
}

async function metaFetchJson<T>(
  operation: LaunchpadMetaOperation,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw classifyFetchFailure(operation, error);
  }

  const json = await response.json().catch(() => null) as T | MetaErrorBody | null;

  if (!response.ok) {
    throw classifyMetaHttpError(operation, response, json as MetaErrorBody | null);
  }

  return (json ?? {}) as T;
}

function requireMetaId(
  operation: LaunchpadMetaOperation,
  response: MetaIdResponse,
  code: string,
  message: string,
) {
  if (!response.id) {
    throw new LaunchpadMetaPublishError({
      category: "terminal",
      code,
      message,
      operation,
      details: { operation, responseShape: Object.keys(response) },
    });
  }

  return response.id;
}

function extractImageHash(response: MetaImageUploadResponse, sourceUrl: string) {
  if (response.hash) return response.hash;
  const direct = response.images?.[sourceUrl]?.hash;
  if (direct) return direct;
  const firstImage = Object.values(response.images ?? {}).find((image) => image.hash);
  if (firstImage?.hash) return firstImage.hash;
  const firstData = response.data?.find((image) => image.hash);
  return firstData?.hash ?? null;
}

export async function uploadMetaImageByUrl(input: {
  metaAccountId: string;
  accessToken: string;
  sourceUrl: string;
}) {
  const body = new URLSearchParams({
    access_token: input.accessToken,
    url: input.sourceUrl,
  });

  const response = await metaFetchJson<MetaImageUploadResponse>(
    "upload_image",
    `${META_GRAPH_API_BASE}/${metaAccountNode(input.metaAccountId)}/adimages`,
    { method: "POST", body },
  );
  const imageHash = extractImageHash(response, input.sourceUrl);

  if (!imageHash) {
    throw new LaunchpadMetaPublishError({
      category: "terminal",
      code: "META_IMAGE_HASH_MISSING",
      message: "Meta image upload did not return an image hash",
      operation: "upload_image",
      details: { operation: "upload_image", responseShape: Object.keys(response) },
    });
  }

  return { imageHash };
}

function buildObjectStorySpec(input: {
  pageId: string;
  instagramActorId: string | null;
  imageHash: string;
  destinationUrl: string;
  primaryText: string | null;
  headline: string | null;
  cta: MetaCallToAction;
}) {
  return {
    page_id: input.pageId,
    ...(input.instagramActorId ? { instagram_actor_id: input.instagramActorId } : {}),
    link_data: {
      image_hash: input.imageHash,
      link: input.destinationUrl,
      ...(input.primaryText ? { message: input.primaryText } : {}),
      ...(input.headline ? { name: input.headline } : {}),
      ...(input.cta === "NO_BUTTON"
        ? {}
        : {
            call_to_action: {
              type: input.cta,
              value: { link: input.destinationUrl },
            },
          }),
    },
  };
}

export async function createMetaStaticCreative(input: {
  metaAccountId: string;
  accessToken: string;
  creativeName: string;
  pageId: string;
  instagramActorId: string | null;
  imageHash: string;
  destinationUrl: string;
  primaryText: string | null;
  headline: string | null;
  cta: MetaCallToAction;
}) {
  const objectStorySpec = buildObjectStorySpec(input);
  const body = new URLSearchParams({
    access_token: input.accessToken,
    name: input.creativeName,
    object_story_spec: JSON.stringify(objectStorySpec),
  });

  const response = await metaFetchJson<MetaIdResponse>(
    "create_creative",
    `${META_GRAPH_API_BASE}/${metaAccountNode(input.metaAccountId)}/adcreatives`,
    { method: "POST", body },
  );

  return {
    creativeId: requireMetaId(
      "create_creative",
      response,
      "META_CREATIVE_ID_MISSING",
      "Meta creative creation did not return a creative ID",
    ),
  };
}

export async function createPausedMetaAd(input: {
  metaAccountId: string;
  accessToken: string;
  adName: string;
  adSetMetaId: string;
  creativeId: string;
  requestedStatus: typeof PAUSED_META_STATUS;
}) {
  if (input.requestedStatus !== PAUSED_META_STATUS) {
    throw new LaunchpadMetaPublishError({
      category: "terminal",
      code: "ACTIVE_META_STATUS_FORBIDDEN",
      message: "Launchpad can only create Meta ads with status PAUSED",
      operation: "create_ad",
      details: { operation: "create_ad", requestedStatus: input.requestedStatus },
    });
  }

  const body = new URLSearchParams({
    access_token: input.accessToken,
    name: input.adName,
    adset_id: input.adSetMetaId,
    creative: JSON.stringify({ creative_id: input.creativeId }),
    status: PAUSED_META_STATUS,
  });

  const response = await metaFetchJson<MetaIdResponse>(
    "create_ad",
    `${META_GRAPH_API_BASE}/${metaAccountNode(input.metaAccountId)}/ads`,
    { method: "POST", body },
  );

  return {
    adId: requireMetaId(
      "create_ad",
      response,
      "META_AD_ID_MISSING",
      "Meta ad creation did not return an ad ID",
    ),
  };
}

export async function fetchMetaAdSnapshot(input: {
  adMetaId: string;
  accessToken: string;
}) {
  const url = new URL(`${META_GRAPH_API_BASE}/${input.adMetaId}`);
  url.searchParams.set("access_token", input.accessToken);
  url.searchParams.set(
    "fields",
    "id,adset_id,creative{id},configured_status,effective_status,status",
  );

  return metaFetchJson<MetaAdSnapshot>("reconcile_ad", url);
}

function creativeIdFromSnapshot(snapshot: MetaAdSnapshot) {
  if (typeof snapshot.creative === "string") return snapshot.creative;
  return snapshot.creative?.id ?? null;
}

export function reconcileCreatedMetaAd(input: {
  snapshot: MetaAdSnapshot;
  expectedAdMetaId: string;
  expectedAdSetMetaId: string;
  expectedCreativeMetaId: string;
}): MetaReconciliationResult {
  const rawMetaConfiguredStatus = input.snapshot.configured_status ?? input.snapshot.status ?? null;
  const rawMetaEffectiveStatus = input.snapshot.effective_status ?? null;
  const creativeId = creativeIdFromSnapshot(input.snapshot);
  const mismatches: string[] = [];

  if (!input.snapshot.id) {
    mismatches.push("ad_not_found");
  } else if (input.snapshot.id !== input.expectedAdMetaId) {
    mismatches.push("ad_id_mismatch");
  }

  if (input.snapshot.adset_id && input.snapshot.adset_id !== input.expectedAdSetMetaId) {
    mismatches.push("ad_set_mismatch");
  }

  if (creativeId && creativeId !== input.expectedCreativeMetaId) {
    mismatches.push("creative_mismatch");
  }

  if (rawMetaConfiguredStatus !== PAUSED_META_STATUS) {
    mismatches.push("configured_status_not_paused");
  }

  if (rawMetaEffectiveStatus !== PAUSED_META_STATUS) {
    mismatches.push("effective_status_not_paused");
  }

  const details = {
    expectedAdMetaId: input.expectedAdMetaId,
    actualAdMetaId: input.snapshot.id ?? null,
    expectedAdSetMetaId: input.expectedAdSetMetaId,
    actualAdSetMetaId: input.snapshot.adset_id ?? null,
    expectedCreativeMetaId: input.expectedCreativeMetaId,
    actualCreativeMetaId: creativeId,
    rawMetaConfiguredStatus,
    rawMetaEffectiveStatus,
    mismatches,
  };

  return {
    ok: mismatches.length === 0,
    rawMetaConfiguredStatus,
    rawMetaEffectiveStatus,
    details,
    failureReason: mismatches.length > 0 ? mismatches.join(", ") : undefined,
  };
}
