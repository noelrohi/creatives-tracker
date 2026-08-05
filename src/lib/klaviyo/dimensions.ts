import { createHash } from "node:crypto";
import type { KlaviyoResource } from "@/lib/klaviyo/client";
import {
  isKlaviyoRawStringWithinBounds,
  sanitizeKlaviyoSensitiveString,
} from "@/lib/klaviyo/redaction";
import type {
  MarketingObjectType,
  TrackingSettingScope,
  TrackingValueMode,
} from "@/schema/klaviyo-claim";

export type NormalizedMarketingObject = {
  objectType: MarketingObjectType;
  externalId: string;
  parentExternalId: string | null;
  parentObjectType: MarketingObjectType | null;
  name: string;
  channel: string | null;
  status: string | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  trackingProjection: Record<string, string>;
};

export type NormalizedTrackingSetting = {
  scope: TrackingSettingScope;
  marketingObjectExternalId: string | null;
  marketingObjectType: MarketingObjectType | null;
  parameterName: string;
  valueMode: TrackingValueMode;
  sanitizedValue: string | null;
  enabled: boolean;
};

export type DimensionSnapshot = {
  objects: NormalizedMarketingObject[];
  trackingSettings: NormalizedTrackingSetting[];
  warnings: string[];
  sourceChecksum: string;
  apiRevisions: Record<string, string>;
};

export type DimensionTraversalInput = {
  campaigns: Array<{ channel: "email" | "sms"; resource: KlaviyoResource }>;
  campaignMessages: Array<{
    campaignExternalId: string;
    resource: KlaviyoResource;
  }>;
  flows: KlaviyoResource[];
  flowActions: Array<{ flowExternalId: string; resource: KlaviyoResource }>;
  flowMessages: Array<{
    flowExternalId: string;
    actionExternalId: string;
    resource: KlaviyoResource;
  }>;
  accountTrackingSettings: KlaviyoResource[];
  messageTrackingSettings: Array<{
    scope: "campaign_message" | "flow_message";
    messageExternalId: string;
    resource: KlaviyoResource;
  }>;
  apiRevisions: Record<string, string>;
};

const MAX_NAME_LENGTH = 512;
const MAX_TRACKING_VALUE_LENGTH = 512;
const ALLOWED_TRACKING_PARAMETERS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_id",
  "utm_term",
  "utm_content",
]);
const ALLOWED_STATUSES_MAX = 64;

function boundedName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_NAME_LENGTH ||
    !isKlaviyoRawStringWithinBounds(trimmed)
  ) {
    return null;
  }
  return sanitizeKlaviyoSensitiveString(trimmed, "text");
}

function boundedShortText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > ALLOWED_STATUSES_MAX) {
    return null;
  }
  return trimmed;
}

function providerTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

/**
 * Bounded scalar/URL redaction for tracking template values. Dynamic
 * template expressions are preserved structurally but query-string values,
 * embedded emails, and oversized payloads never survive.
 */
export function redactTrackingValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TRACKING_VALUE_LENGTH) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return null;
    }
  }
  if (trimmed.includes("@")) return null;
  return sanitizeKlaviyoSensitiveString(trimmed, "text");
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

function normalizeObject(input: {
  objectType: MarketingObjectType;
  resource: KlaviyoResource;
  channel: string | null;
  parentExternalId: string | null;
  parentObjectType: MarketingObjectType | null;
  createdKey: string;
  updatedKey: string;
  nameKey: string;
  warnings: string[];
}): NormalizedMarketingObject | null {
  const attributes = input.resource.attributes ?? {};
  const name = boundedName(attributes[input.nameKey]);
  if (name === null) {
    input.warnings.push(`${input.objectType}_name_unavailable`);
    return null;
  }
  const channelAttribute = boundedShortText(attributes.channel);
  return {
    objectType: input.objectType,
    externalId: input.resource.id,
    parentExternalId: input.parentExternalId,
    parentObjectType: input.parentObjectType,
    name,
    channel: input.channel ?? channelAttribute,
    status: boundedShortText(attributes.status),
    providerCreatedAt: providerTimestamp(attributes[input.createdKey]),
    providerUpdatedAt: providerTimestamp(attributes[input.updatedKey]),
    trackingProjection: {},
  };
}

function normalizeTrackingParameters(input: {
  scope: TrackingSettingScope;
  marketingObjectExternalId: string | null;
  marketingObjectType: MarketingObjectType | null;
  attributes: Record<string, unknown>;
  warnings: string[];
}): NormalizedTrackingSetting[] {
  const settings: NormalizedTrackingSetting[] = [];
  const source = input.attributes;
  const candidates: Array<{
    name: unknown;
    value: unknown;
    dynamic: unknown;
  }> = [];
  for (const parameter of ALLOWED_TRACKING_PARAMETERS) {
    if (parameter in source) {
      candidates.push({
        name: parameter,
        value: source[parameter],
        dynamic: false,
      });
    }
  }
  const custom = source.custom_parameters ?? source.tracking_options;
  if (Array.isArray(custom)) {
    for (const entry of custom) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      candidates.push({
        name: record.name ?? record.parameter,
        value: record.value ?? record.template,
        dynamic: record.dynamic ?? record.value_mode === "dynamic",
      });
    }
  }
  for (const candidate of candidates) {
    if (
      typeof candidate.name !== "string" ||
      !ALLOWED_TRACKING_PARAMETERS.has(candidate.name)
    ) {
      if (candidate.name !== undefined) {
        input.warnings.push("tracking_parameter_not_allowlisted");
      }
      continue;
    }
    settings.push({
      scope: input.scope,
      marketingObjectExternalId: input.marketingObjectExternalId,
      marketingObjectType: input.marketingObjectType,
      parameterName: candidate.name,
      valueMode: candidate.dynamic === true ? "dynamic" : "static",
      sanitizedValue: redactTrackingValue(candidate.value),
      enabled: source.auto_add_parameters !== false,
    });
  }
  return settings;
}

/**
 * Pure fail-closed normalization of one full dimension traversal. Parents
 * come only from documented relationship paths; same external IDs across
 * object types stay distinct; flow-message variations are never emitted
 * because the pinned relationship exposes no stable variation ID.
 */
export function normalizeDimensionSnapshot(
  input: DimensionTraversalInput,
): DimensionSnapshot {
  const warnings: string[] = [];
  const objects: NormalizedMarketingObject[] = [];
  const seen = new Set<string>();

  const push = (object: NormalizedMarketingObject | null): void => {
    if (object === null) return;
    const key = `${object.objectType}:${object.externalId}`;
    if (seen.has(key)) {
      warnings.push("duplicate_marketing_object_dropped");
      return;
    }
    seen.add(key);
    objects.push(object);
  };

  for (const campaign of input.campaigns) {
    push(
      normalizeObject({
        objectType: "campaign",
        resource: campaign.resource,
        channel: campaign.channel,
        parentExternalId: null,
        parentObjectType: null,
        createdKey: "created_at",
        updatedKey: "updated_at",
        nameKey: "name",
        warnings,
      }),
    );
  }
  const campaignIds = new Set(
    input.campaigns.map((campaign) => campaign.resource.id),
  );
  for (const message of input.campaignMessages) {
    if (!campaignIds.has(message.campaignExternalId)) {
      warnings.push("campaign_message_parent_missing");
      continue;
    }
    push(
      normalizeObject({
        objectType: "campaign_message",
        resource: message.resource,
        channel: null,
        parentExternalId: message.campaignExternalId,
        parentObjectType: "campaign",
        createdKey: "created_at",
        updatedKey: "updated_at",
        nameKey: "label",
        warnings,
      }),
    );
  }
  for (const flow of input.flows) {
    push(
      normalizeObject({
        objectType: "flow",
        resource: flow,
        channel: null,
        parentExternalId: null,
        parentObjectType: null,
        createdKey: "created",
        updatedKey: "updated",
        nameKey: "name",
        warnings,
      }),
    );
  }
  const flowIds = new Set(input.flows.map((flow) => flow.id));
  const actionToFlow = new Map<string, string>();
  for (const action of input.flowActions) {
    if (!flowIds.has(action.flowExternalId)) {
      warnings.push("flow_action_parent_missing");
      continue;
    }
    actionToFlow.set(action.resource.id, action.flowExternalId);
  }
  for (const message of input.flowMessages) {
    const flowExternalId = actionToFlow.get(message.actionExternalId);
    if (
      flowExternalId === undefined ||
      flowExternalId !== message.flowExternalId
    ) {
      warnings.push("flow_message_parent_missing");
      continue;
    }
    push(
      normalizeObject({
        objectType: "flow_message",
        resource: message.resource,
        channel: null,
        parentExternalId: flowExternalId,
        parentObjectType: "flow",
        createdKey: "created",
        updatedKey: "updated",
        nameKey: "name",
        warnings,
      }),
    );
  }

  const trackingSettings: NormalizedTrackingSetting[] = [];
  for (const setting of input.accountTrackingSettings) {
    trackingSettings.push(
      ...normalizeTrackingParameters({
        scope: "account",
        marketingObjectExternalId: null,
        marketingObjectType: null,
        attributes: setting.attributes ?? {},
        warnings,
      }),
    );
  }
  const messageKeys = new Set(
    objects
      .filter(
        (object) =>
          object.objectType === "campaign_message" ||
          object.objectType === "flow_message",
      )
      .map((object) => `${object.objectType}:${object.externalId}`),
  );
  for (const setting of input.messageTrackingSettings) {
    if (!messageKeys.has(`${setting.scope}:${setting.messageExternalId}`)) {
      warnings.push("tracking_setting_object_missing");
      continue;
    }
    trackingSettings.push(
      ...normalizeTrackingParameters({
        scope: setting.scope,
        marketingObjectExternalId: setting.messageExternalId,
        marketingObjectType: setting.scope,
        attributes: setting.resource.attributes ?? {},
        warnings,
      }),
    );
  }

  const snapshotBody = { objects, trackingSettings };
  return {
    objects,
    trackingSettings,
    warnings,
    sourceChecksum: stableChecksum(snapshotBody),
    apiRevisions: { ...input.apiRevisions },
  };
}
