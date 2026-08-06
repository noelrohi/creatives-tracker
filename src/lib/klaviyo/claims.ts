import { createHash } from "node:crypto";
import type { KlaviyoResource } from "@/lib/klaviyo/client";
import type { KlaviyoMetricKind } from "@/lib/klaviyo/types";

export const MAX_ATTRIBUTION_RELATIONSHIPS_PER_CONVERSION = 100;

export type RedactedInteractionDetail = {
  interactionType: "click" | "open" | "delivery" | "sms";
  occurredAt: Date | null;
  channel: string | null;
  host: string | null;
  path: string | null;
  botClick: boolean | null;
};

export type NormalizedAttributionClaim = {
  conversionEventRowId: string;
  conversionExternalEventId: string;
  attributionId: string;
  attributedInteractionEventId: string | null;
  marketingRelationships: {
    campaignId: string | null;
    flowId: string | null;
    messageId: string | null;
    variationId: string | null;
    externalVariationReference: string | null;
  };
  interaction: RedactedInteractionDetail | null;
  unknownReasonCodes: string[];
  sourceChecksum: string;
  apiRevision: string;
};

export type ClaimNormalizationResult = {
  complete: boolean;
  incompleteReasonCodes: string[];
  claims: NormalizedAttributionClaim[];
};

const INTERACTION_TYPE_BY_METRIC_KIND: Partial<
  Record<KlaviyoMetricKind, RedactedInteractionDetail["interactionType"]>
> = {
  clicked_email: "click",
  clicked_sms: "sms",
};

function relationshipId(
  relationships: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const relationship = relationships?.[key];
  if (!relationship || typeof relationship !== "object") return null;
  const data = (relationship as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function stableChecksum(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input instanceof Date) return input.toISOString();
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return input ?? null;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/**
 * Sanitize an interaction URL down to host and path. Query strings,
 * credentials, fragments, and non-HTTPS destinations never survive; an
 * unsafe URL leaves detail unknown rather than being partially exposed.
 */
export function sanitizeInteractionUrl(
  value: unknown,
): { host: string; path: string } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.length === 0
  ) {
    return null;
  }
  const path = url.pathname.length > 512 ? null : url.pathname;
  if (path === null || /@/.test(path)) return null;
  return { host: url.hostname, path };
}

export type ReferencedInteractionInput = {
  externalEventId: string;
  metricKind: KlaviyoMetricKind | null;
  occurredAt: Date | null;
  channel: string | null;
  url: unknown;
  botClick: boolean | null;
};

/**
 * Normalize one referenced interaction event into bounded claim detail.
 * Only allowlisted metric families produce detail; anything else keeps the
 * relationship with unknown detail. Opens/deliveries are never relabelled
 * clicks.
 */
export function normalizeReferencedInteraction(
  input: ReferencedInteractionInput,
): { detail: RedactedInteractionDetail | null; reasonCodes: string[] } {
  if (input.metricKind === null) {
    return { detail: null, reasonCodes: ["referenced_metric_not_allowlisted"] };
  }
  const interactionType = INTERACTION_TYPE_BY_METRIC_KIND[input.metricKind];
  if (interactionType === undefined) {
    return { detail: null, reasonCodes: ["referenced_metric_not_allowlisted"] };
  }
  const sanitized = sanitizeInteractionUrl(input.url);
  const reasonCodes: string[] = [];
  if (input.url !== null && input.url !== undefined && sanitized === null) {
    reasonCodes.push("interaction_url_unsafe");
  }
  return {
    detail: {
      interactionType,
      occurredAt: input.occurredAt,
      channel: input.channel,
      host: sanitized?.host ?? null,
      path: sanitized?.path ?? null,
      botClick: input.botClick,
    },
    reasonCodes,
  };
}

export type CoarseInteractionRelationship = {
  kind: "open" | "delivery";
  occurredAt: Date | null;
  channel: string | null;
  botClick: boolean | null;
};

/**
 * Coarse open/delivery detail carries no URL and is never relabelled a
 * click regardless of what other relationships exist on the claim.
 */
export function normalizeCoarseInteraction(
  input: CoarseInteractionRelationship,
): RedactedInteractionDetail {
  return {
    interactionType: input.kind,
    occurredAt: input.occurredAt,
    channel: input.channel,
    host: null,
    path: null,
    botClick: input.botClick,
  };
}

export type NormalizeClaimsInput = {
  conversionEventRowId: string;
  conversionExternalEventId: string;
  storedAttributionRelationshipIds: string[];
  storedTruncated: boolean;
  fetchedEventExternalId: string;
  attributions: KlaviyoResource[];
  apiRevision: string;
};

/**
 * Pure claim normalization: only relationships proven by the pinned
 * revision and probe are mapped; everything else stays null with a reason
 * code. No campaign, flow, or message is ever inferred from a report or a
 * display name, and the conversion foreign key remains the internal row ID.
 */
export function normalizeAttributionClaims(
  input: NormalizeClaimsInput,
): ClaimNormalizationResult {
  const incompleteReasonCodes: string[] = [];
  if (input.fetchedEventExternalId !== input.conversionExternalEventId) {
    throw new Error(
      "Klaviyo attribution response references a different conversion event",
    );
  }
  const expected = [...new Set(input.storedAttributionRelationshipIds)];
  if (expected.length > MAX_ATTRIBUTION_RELATIONSHIPS_PER_CONVERSION) {
    incompleteReasonCodes.push("attribution_relationship_overflow");
  }
  if (input.storedTruncated) {
    incompleteReasonCodes.push("attribution_relationship_truncated");
  }

  const fetchedIds = input.attributions.map((resource) => resource.id);
  const fetchedSet = new Set(fetchedIds);
  if (fetchedIds.length !== fetchedSet.size) {
    incompleteReasonCodes.push("attribution_resource_duplicated");
  }
  const expectedSet = new Set(expected);
  for (const id of expectedSet) {
    if (!fetchedSet.has(id)) {
      incompleteReasonCodes.push("attribution_resource_missing");
      break;
    }
  }
  for (const id of fetchedSet) {
    if (!expectedSet.has(id)) {
      incompleteReasonCodes.push("attribution_resource_unexpected");
      break;
    }
  }

  const claims: NormalizedAttributionClaim[] = [];
  for (const resource of input.attributions) {
    if (!expectedSet.has(resource.id)) continue;
    const relationships = resource.relationships as
      | Record<string, unknown>
      | undefined;
    const campaignId = relationshipId(relationships, "campaign");
    const flowId = relationshipId(relationships, "flow");
    const messageId =
      relationshipId(relationships, "campaign-message") ??
      relationshipId(relationships, "flow-message");
    const variationReference =
      relationshipId(relationships, "flow-message-variation") ??
      relationshipId(relationships, "variation");
    const attributedInteractionEventId = relationshipId(
      relationships,
      "attributed-event",
    );

    const unknownReasonCodes: string[] = [];
    if (campaignId === null && flowId === null) {
      unknownReasonCodes.push("marketing_source_unknown");
    }
    if (messageId === null) unknownReasonCodes.push("message_unknown");
    if (attributedInteractionEventId === null) {
      unknownReasonCodes.push("interaction_relationship_unavailable");
    }

    const claim: NormalizedAttributionClaim = {
      conversionEventRowId: input.conversionEventRowId,
      conversionExternalEventId: input.conversionExternalEventId,
      attributionId: resource.id,
      attributedInteractionEventId,
      marketingRelationships: {
        campaignId,
        flowId,
        messageId,
        // Variation objects are never fabricated: the pinned relationship
        // exposes no stable variation object, so only the redacted
        // external reference survives.
        variationId: null,
        externalVariationReference: variationReference,
      },
      interaction: null,
      unknownReasonCodes,
      apiRevision: input.apiRevision,
      sourceChecksum: "",
    };
    claim.sourceChecksum = stableChecksum({
      attributionId: claim.attributionId,
      conversionExternalEventId: claim.conversionExternalEventId,
      attributedInteractionEventId,
      marketingRelationships: claim.marketingRelationships,
      apiRevision: input.apiRevision,
    });
    claims.push(claim);
  }

  return {
    complete: incompleteReasonCodes.length === 0,
    incompleteReasonCodes,
    claims,
  };
}

export type ClaimReplayCheckpoint = {
  claimReplayId: string;
  sourceRunId: string;
  matchRunId: string;
  phase: "missing" | "incomplete_retry" | "failed_retry";
  afterOccurredAt: string | null;
  afterEventRowId: string | null;
  remainingIncompleteRetries: number;
  remainingFailedRetries: number;
  attemptingConversionEventId: string | null;
  attemptingOccurredAt: string | null;
  stage: "idle" | "fetching" | "handoff";
};

export const MAX_CLAIM_CONVERSIONS_PER_BATCH = 5;
export const MAX_CLAIM_REMOTE_CALLS_PER_BATCH = 25;
export const MAX_REFERENCED_EVENT_FETCHES_PER_CONVERSION = 10;
export const CLAIM_BATCH_SOFT_DEADLINE_MS = 480_000;
export const MAX_INCOMPLETE_CLAIM_RETRIES_PER_GRAPH = 5;
export const MAX_FAILED_CLAIM_RETRIES_PER_GRAPH = 5;

export function assertExactClaimReplayCheckpoint(
  value: unknown,
): asserts value is ClaimReplayCheckpoint {
  const checkpoint = value as Record<string, unknown> | null;
  if (
    !checkpoint ||
    typeof checkpoint.claimReplayId !== "string" ||
    typeof checkpoint.sourceRunId !== "string" ||
    typeof checkpoint.matchRunId !== "string" ||
    !["missing", "incomplete_retry", "failed_retry"].includes(
      checkpoint.phase as string,
    ) ||
    (checkpoint.afterOccurredAt !== null &&
      typeof checkpoint.afterOccurredAt !== "string") ||
    (checkpoint.afterEventRowId !== null &&
      typeof checkpoint.afterEventRowId !== "string") ||
    typeof checkpoint.remainingIncompleteRetries !== "number" ||
    typeof checkpoint.remainingFailedRetries !== "number" ||
    (checkpoint.attemptingConversionEventId !== null &&
      typeof checkpoint.attemptingConversionEventId !== "string") ||
    (checkpoint.attemptingOccurredAt !== null &&
      typeof checkpoint.attemptingOccurredAt !== "string") ||
    !["idle", "fetching", "handoff"].includes(checkpoint.stage as string) ||
    Object.keys(checkpoint).length !== 11
  ) {
    throw new Error("Klaviyo claim replay checkpoint is malformed");
  }
}
