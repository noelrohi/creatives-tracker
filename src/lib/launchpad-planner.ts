import {
  DEFAULT_META_CTA,
  PAUSED_META_STATUS,
  launchpadSupportedCreativeFormats,
  launchpadVideoCreativeFormats,
  metaCtaValues,
  type MetaCallToAction,
} from "@/lib/launchpad-constants";
import { parseLaunchpadUrlPreview } from "@/lib/launchpad-url";
import type {
  LaunchpadManifestItemInput,
  LaunchpadOrgRole,
  LaunchpadRunDraftInput,
  LaunchpadValidationIssue,
} from "@/lib/launchpad-ledger";
import type {
  LaunchpadDestinationAccount,
  LaunchpadDestinationAdSet,
  LaunchpadDestinationInspectionIssue,
} from "@/lib/launchpad-destinations";

export const DEFAULT_LAUNCHPAD_NAMING_TEMPLATE =
  "Launchpad / {{creative.name}} / {{adSet.name}}";

export type LaunchpadPlannerCreative = {
  id: string;
  name: string;
  format: string | null;
  assetUrl: string | null;
  videoUrl?: string | null;
  hook?: string | null;
  cta?: string | null;
};

export type ExistingMetaAdConflict = {
  id: string;
  name: string | null;
  metaId: string | null;
};

export type LaunchpadPlannerInput = {
  organizationId: string;
  requestedBy: {
    userId: string | null;
    principalType: "session" | "apiKey" | "worker" | "anonymous";
    orgRole: LaunchpadOrgRole;
  };
  destination: {
    account: LaunchpadDestinationAccount;
    adSet: LaunchpadDestinationAdSet;
    issues?: LaunchpadDestinationInspectionIssue[];
  };
  creative: LaunchpadPlannerCreative;
  itemPosition?: number | null;
  launch: {
    defaultDestinationUrl?: string | null;
    destinationUrlOverride?: string | null;
    primaryText?: string | null;
    caption?: string | null;
    headline?: string | null;
    cta?: string | null;
    adName?: string | null;
    namingTemplate?: string | null;
  };
  existingMetaAdConflicts?: ExistingMetaAdConflict[];
  idempotencyKey?: string | null;
  env?: Record<string, string | undefined>;
};

export type LaunchpadPlannerOutput = {
  publishPath: "dry_run" | "live_publish";
  normalizedManifest: Record<string, unknown>;
  runDraftInput: LaunchpadRunDraftInput;
  issues: LaunchpadValidationIssue[];
};

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isMetaCta(value: string): value is MetaCallToAction {
  return (metaCtaValues as readonly string[]).includes(value);
}

function isSupportedCreativeFormat(
  format: string | null | undefined,
): format is "static" | "video" | "ugc" {
  return (launchpadSupportedCreativeFormats as readonly string[]).includes(
    format ?? "",
  );
}

function isVideoCreativeFormat(
  format: string | null | undefined,
): format is "video" | "ugc" {
  return (launchpadVideoCreativeFormats as readonly string[]).includes(format ?? "");
}

function destinationIssueToValidationIssue(
  issue: LaunchpadDestinationInspectionIssue,
): LaunchpadValidationIssue {
  return {
    code: issue.code,
    message: issue.message,
    field: issue.field,
    details: issue.details,
  };
}

function renderNamingTemplate(
  template: string,
  input: {
    creative: LaunchpadPlannerCreative;
    account: LaunchpadDestinationAccount;
    adSet: LaunchpadDestinationAdSet;
    itemPosition?: number | null;
  },
) {
  const position = input.itemPosition ? String(input.itemPosition) : null;
  const positionPadded = input.itemPosition
    ? String(input.itemPosition).padStart(2, "0")
    : null;
  const replacements: Record<string, string | null | undefined> = {
    "creative.name": input.creative.name,
    "creative.id": input.creative.id,
    "adSet.name": input.adSet.name,
    "adSet.metaId": input.adSet.metaId,
    "campaign.name": input.adSet.campaign.name,
    "campaign.metaId": input.adSet.campaign.metaId,
    "account.name": input.account.name,
    "account.metaAccountId": input.account.metaAccountId,
    "item.position": position,
    "item.positionPadded": positionPadded,
  };

  return template
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token: string) => {
      return normalizedText(replacements[token.trim()]) ?? "";
    })
    .replace(/[\s/·|_-]+$/g, "")
    .replace(/^[\s/·|_-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function resolveAdName(input: LaunchpadPlannerInput) {
  const override = normalizedText(input.launch.adName);
  if (override) return { value: override, source: "item_override" as const };

  const template =
    normalizedText(input.launch.namingTemplate) ?? DEFAULT_LAUNCHPAD_NAMING_TEMPLATE;
  return {
    value: renderNamingTemplate(template, {
      creative: input.creative,
      account: input.destination.account,
      adSet: input.destination.adSet,
      itemPosition: input.itemPosition,
    }),
    source: "template" as const,
  };
}

function resolveHeadline(creative: LaunchpadPlannerCreative, rawHeadline?: string | null) {
  const provided = normalizedText(rawHeadline);
  if (provided) return { value: provided, source: "provided" as const };

  const hook = normalizedText(creative.hook);
  if (hook) return { value: hook, source: "creative_hook" as const };

  return { value: creative.name, source: "creative_name" as const };
}

function resolveCta(rawCta?: string | null): {
  value: MetaCallToAction;
  source: "default" | "provided" | "invalid_defaulted";
  issue: LaunchpadValidationIssue | null;
} {
  const requested = normalizedText(rawCta);
  if (!requested) {
    return {
      value: DEFAULT_META_CTA,
      source: "default" as const,
      issue: null,
    };
  }

  if (isMetaCta(requested)) {
    return {
      value: requested,
      source: "provided" as const,
      issue: null,
    };
  }

  return {
    value: DEFAULT_META_CTA,
    source: "invalid_defaulted" as const,
    issue: {
      code: "INVALID_META_CTA",
      message: "Launchpad payload uses an unsupported Meta CTA",
      field: "cta",
      details: { cta: requested, allowedValues: metaCtaValues },
    } satisfies LaunchpadValidationIssue,
  };
}

function buildTargetPreview(input: LaunchpadPlannerInput) {
  const { account, adSet } = input.destination;
  return {
    account: {
      id: account.id,
      name: account.name,
      metaAccountId: account.metaAccountId,
      hasMetaAccessToken: account.hasMetaAccessToken,
      defaultFacebookPageId: account.defaultFacebookPageId,
      defaultInstagramActorId: account.defaultInstagramActorId,
    },
    campaign: adSet.campaign,
    adSet: {
      id: adSet.id,
      name: adSet.name,
      metaId: adSet.metaId,
      status: adSet.status,
      accountId: adSet.accountId,
    },
  };
}

function buildMediaPreview(creative: LaunchpadPlannerCreative) {
  if (isVideoCreativeFormat(creative.format)) {
    return {
      type: "video",
      uploadMethod: "file_url",
      creativeId: creative.id,
      sourceUrl: normalizedText(creative.videoUrl),
      thumbnailUrl: normalizedText(creative.assetUrl),
      format: creative.format,
    };
  }

  return {
    type: "image",
    uploadMethod: "url",
    creativeId: creative.id,
    sourceUrl: normalizedText(creative.assetUrl),
    format: creative.format,
  };
}

function buildExpectedMetaObjectShape(input: {
  account: LaunchpadDestinationAccount;
  adSet: LaunchpadDestinationAdSet;
  adName: string;
  primaryText: string | null;
  headline: string | null;
  cta: MetaCallToAction;
  finalUrl: string | null;
  creativeFormat: string | null;
  assetUrl: string | null;
  videoUrl: string | null;
}) {
  const accountPath = input.account.metaAccountId.startsWith("act_")
    ? input.account.metaAccountId
    : `act_${input.account.metaAccountId}`;
  const callToAction =
    input.cta === "NO_BUTTON"
      ? null
      : {
          type: input.cta,
          value: { link: input.finalUrl },
        };

  if (isVideoCreativeFormat(input.creativeFormat)) {
    const creativeObjectStorySpec = {
      page_id: input.account.defaultFacebookPageId,
      instagram_actor_id: input.account.defaultInstagramActorId,
      video_data: {
        video_id: "<META_VIDEO_ID_FROM_URL_UPLOAD>",
        link: input.finalUrl,
        message: input.primaryText,
        title: input.headline,
        image_url: input.assetUrl,
        call_to_action: callToAction,
      },
    };

    return {
      videoUpload: {
        method: "POST",
        endpoint: `/${accountPath}/advideos`,
        fields: {
          file_url: input.videoUrl,
          name: `${input.adName} / Video`,
        },
        resultReference: "<META_VIDEO_ID_FROM_URL_UPLOAD>",
      },
      creative: {
        method: "POST",
        endpoint: `/${accountPath}/adcreatives`,
        fields: {
          name: `${input.adName} / Creative`,
          object_story_spec: creativeObjectStorySpec,
        },
        resultReference: "<META_CREATIVE_ID>",
      },
      ad: {
        method: "POST",
        endpoint: `/${accountPath}/ads`,
        fields: {
          name: input.adName,
          adset_id: input.adSet.metaId,
          creative: { creative_id: "<META_CREATIVE_ID>" },
          status: PAUSED_META_STATUS,
        },
        resultReference: "<META_AD_ID>",
      },
    };
  }

  const creativeObjectStorySpec = {
    page_id: input.account.defaultFacebookPageId,
    instagram_actor_id: input.account.defaultInstagramActorId,
    link_data: {
      image_hash: "<META_IMAGE_HASH_FROM_URL_UPLOAD>",
      link: input.finalUrl,
      message: input.primaryText,
      name: input.headline,
      call_to_action: callToAction,
    },
  };

  return {
    imageUpload: {
      method: "POST",
      endpoint: `/${accountPath}/adimages`,
      fields: {
        url: input.assetUrl,
      },
      resultReference: "<META_IMAGE_HASH_FROM_URL_UPLOAD>",
    },
    creative: {
      method: "POST",
      endpoint: `/${accountPath}/adcreatives`,
      fields: {
        name: `${input.adName} / Creative`,
        object_story_spec: creativeObjectStorySpec,
      },
      resultReference: "<META_CREATIVE_ID>",
    },
    ad: {
      method: "POST",
      endpoint: `/${accountPath}/ads`,
      fields: {
        name: input.adName,
        adset_id: input.adSet.metaId,
        creative: { creative_id: "<META_CREATIVE_ID>" },
        status: PAUSED_META_STATUS,
      },
      resultReference: "<META_AD_ID>",
    },
  };
}

function validateCreativeHttpsUrl(input: {
  creativeId: string;
  url: string;
  fieldName: "assetUrl" | "videoUrl";
  label: string;
}): LaunchpadValidationIssue | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    return {
      code: input.fieldName === "assetUrl"
        ? "INVALID_CREATIVE_ASSET_URL"
        : "INVALID_CREATIVE_VIDEO_URL",
      message: `${input.label} must be a valid HTTPS URL`,
      field: "creativeId",
      details: { creativeId: input.creativeId, [input.fieldName]: input.url },
    };
  }

  if (parsedUrl.protocol !== "https:") {
    return {
      code: input.fieldName === "assetUrl"
        ? "INVALID_CREATIVE_ASSET_URL"
        : "INVALID_CREATIVE_VIDEO_URL",
      message: `${input.label} must use HTTPS`,
      field: "creativeId",
      details: {
        creativeId: input.creativeId,
        [input.fieldName]: input.url,
        protocol: parsedUrl.protocol,
      },
    };
  }

  return null;
}

function buildCreativeIssues(input: LaunchpadPlannerInput) {
  const issues: LaunchpadValidationIssue[] = [];
  const { creative } = input;
  const assetUrl = normalizedText(creative.assetUrl);
  const videoUrl = normalizedText(creative.videoUrl);

  if (!isSupportedCreativeFormat(creative.format)) {
    issues.push({
      code: "UNSUPPORTED_CREATIVE_FORMAT",
      message:
        "Launchpad supports static image and single-asset video/UGC creatives only",
      field: "creativeId",
      details: {
        creativeId: creative.id,
        format: creative.format,
        supportedFormats: launchpadSupportedCreativeFormats,
      },
    });
    return issues;
  }

  if (creative.format === "static") {
    if (!assetUrl) {
      issues.push({
        code: "CREATIVE_ASSET_REQUIRED",
        message: "Static image dry-run requires a creative asset URL",
        field: "creativeId",
        details: { creativeId: creative.id },
      });
      return issues;
    }

    const urlIssue = validateCreativeHttpsUrl({
      creativeId: creative.id,
      url: assetUrl,
      fieldName: "assetUrl",
      label: "Static image asset URL",
    });
    if (urlIssue) issues.push(urlIssue);
    return issues;
  }

  if (!videoUrl) {
    issues.push({
      code: "CREATIVE_VIDEO_REQUIRED",
      message: "Video/UGC dry-run requires a creative video URL",
      field: "creativeId",
      details: { creativeId: creative.id, format: creative.format },
    });
  } else {
    const videoIssue = validateCreativeHttpsUrl({
      creativeId: creative.id,
      url: videoUrl,
      fieldName: "videoUrl",
      label: "Video/UGC asset URL",
    });
    if (videoIssue) issues.push(videoIssue);
  }

  if (assetUrl) {
    const thumbnailIssue = validateCreativeHttpsUrl({
      creativeId: creative.id,
      url: assetUrl,
      fieldName: "assetUrl",
      label: "Video/UGC thumbnail URL",
    });
    if (thumbnailIssue) issues.push(thumbnailIssue);
  }

  return issues;
}

function buildExistingMetaAdConflictIssues(input: LaunchpadPlannerInput) {
  const conflicts = input.existingMetaAdConflicts ?? [];
  if (conflicts.length === 0) return [];

  return [
    {
      code: "EXISTING_META_AD_ID_CONFLICT",
      message:
        "The selected creative already has a Meta ad ID in the selected destination ad set",
      field: "creativeId",
      details: {
        creativeId: input.creative.id,
        adSetId: input.destination.adSet.id,
        conflicts,
      },
    } satisfies LaunchpadValidationIssue,
  ];
}

export function buildLaunchpadPlannerOutput(
  input: LaunchpadPlannerInput,
  options: { publishPath?: "dry_run" | "live_publish" } = {},
): LaunchpadPlannerOutput {
  const target = buildTargetPreview(input);
  const media = buildMediaPreview(input.creative);
  const adName = resolveAdName(input);
  const headline = resolveHeadline(input.creative, input.launch.headline);
  const cta = resolveCta(input.launch.cta);
  const url = parseLaunchpadUrlPreview({
    defaultUrl: input.launch.defaultDestinationUrl,
    overrideUrl: input.launch.destinationUrlOverride,
  });
  const primaryText = normalizedText(input.launch.primaryText ?? input.launch.caption);
  const caption = normalizedText(input.launch.caption ?? input.launch.primaryText);
  const destinationIssues = (input.destination.issues ?? []).map(
    destinationIssueToValidationIssue,
  );
  const issues = [
    ...destinationIssues,
    ...buildCreativeIssues(input),
    ...url.issues,
    ...buildExistingMetaAdConflictIssues(input),
  ];

  if (cta.issue) issues.push(cta.issue);
  if (!adName.value) {
    issues.push({
      code: "AD_NAME_REQUIRED",
      message: "Generated Launchpad ad name must be non-empty",
      field: "adName",
      details: { namingTemplate: input.launch.namingTemplate ?? null },
    });
  }

  const itemIssues = issues;
  const finalAdName = adName.value || "Launchpad dry-run unnamed ad";
  const expectedMetaObjectShape = buildExpectedMetaObjectShape({
    account: input.destination.account,
    adSet: input.destination.adSet,
    adName: finalAdName,
    primaryText,
    headline: headline.value,
    cta: cta.value,
    finalUrl: url.preview.finalUrl,
    creativeFormat: input.creative.format,
    assetUrl: normalizedText(input.creative.assetUrl),
    videoUrl: normalizedText(input.creative.videoUrl),
  });

  const normalizedItem = {
    position: input.itemPosition ?? 1,
    target,
    creative: {
      id: input.creative.id,
      name: input.creative.name,
      format: input.creative.format,
      assetUrl: input.creative.assetUrl,
      videoUrl: input.creative.videoUrl ?? null,
      hook: input.creative.hook ?? null,
    },
    launch: {
      adName: finalAdName,
      adNameSource: adName.source,
      caption,
      primaryText,
      headline: headline.value,
      headlineSource: headline.source,
      cta: cta.value,
      ctaSource: cta.source,
      requestedStatus: PAUSED_META_STATUS,
    },
    media,
    url: url.preview,
    expectedMetaObjectShape,
    validation: {
      status: itemIssues.length > 0 ? "failed" : "passed",
      issueCount: itemIssues.length,
      issues: itemIssues,
    },
  };

  const normalizedManifest = {
    version: 1,
    kind: "creative_launchpad.normalized_publish_manifest",
    requestedStatus: PAUSED_META_STATUS,
    itemCount: 1,
    maxItemCap: 25,
    target,
    items: [normalizedItem],
    validation: {
      status: issues.length > 0 ? "failed" : "passed",
      issueCount: issues.length,
      issues,
    },
  };

  const item: LaunchpadManifestItemInput = {
    creativeId: input.creative.id,
    creativeName: input.creative.name,
    format: input.creative.format,
    assetUrl: input.creative.assetUrl,
    videoUrl: input.creative.videoUrl,
    hook: input.creative.hook,
    adName: finalAdName,
    adNameSource: adName.source,
    caption,
    primaryText,
    headline: headline.value,
    headlineSource: headline.source,
    destinationUrl: url.preview.isHttps ? url.preview.finalUrl : null,
    cta: cta.value,
    ctaSource: cta.source,
    requestedStatus: PAUSED_META_STATUS,
    target,
    media,
    url: url.preview,
    expectedMetaObjectShape,
    validationIssues: itemIssues,
  };

  return {
    publishPath: options.publishPath ?? "dry_run",
    normalizedManifest,
    issues,
    runDraftInput: {
      organizationId: input.organizationId,
      requestedBy: input.requestedBy,
      actor: {
        accountId: input.destination.account.id,
        accountMetaId: input.destination.account.metaAccountId,
        facebookPageId: input.destination.account.defaultFacebookPageId,
        instagramActorId: input.destination.account.defaultInstagramActorId,
      },
      destination: {
        adSetId: input.destination.adSet.id,
        adSetMetaId: input.destination.adSet.metaId,
      },
      destinationContext: target,
      plannerManifest: normalizedManifest,
      validationIssues: issues,
      items: [item],
      idempotencyKey: input.idempotencyKey,
      env: input.env,
    },
  };
}
