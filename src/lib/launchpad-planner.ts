import {
  DEFAULT_META_CTA,
  PAUSED_META_STATUS,
  metaCtaValues,
  type MetaCallToAction,
} from "@/lib/launchpad-constants";
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

export const REQUIRED_LAUNCHPAD_UTM_PARAMETERS = [
  "utm_source",
  "utm_medium",
] as const;

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

type UrlPreview = {
  defaultUrl: string | null;
  overrideUrl: string | null;
  finalUrl: string | null;
  source: "item_override" | "batch_default" | "none";
  protocol: string | null;
  isHttps: boolean;
  requiredUtmParameters: readonly string[];
  utmParameters: Record<string, string>;
  missingRequiredUtmParameters: string[];
};

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isMetaCta(value: string): value is MetaCallToAction {
  return (metaCtaValues as readonly string[]).includes(value);
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
  },
) {
  const replacements: Record<string, string | null | undefined> = {
    "creative.name": input.creative.name,
    "creative.id": input.creative.id,
    "adSet.name": input.adSet.name,
    "adSet.metaId": input.adSet.metaId,
    "campaign.name": input.adSet.campaign.name,
    "campaign.metaId": input.adSet.campaign.metaId,
    "account.name": input.account.name,
    "account.metaAccountId": input.account.metaAccountId,
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

function parseUrlPreview(input: LaunchpadPlannerInput) {
  const defaultUrl = normalizedText(input.launch.defaultDestinationUrl);
  const overrideUrl = normalizedText(input.launch.destinationUrlOverride);
  const finalUrl = overrideUrl ?? defaultUrl;
  const source = overrideUrl ? "item_override" : defaultUrl ? "batch_default" : "none";
  const issues: LaunchpadValidationIssue[] = [];
  const preview: UrlPreview = {
    defaultUrl,
    overrideUrl,
    finalUrl,
    source,
    protocol: null,
    isHttps: false,
    requiredUtmParameters: REQUIRED_LAUNCHPAD_UTM_PARAMETERS,
    utmParameters: {},
    missingRequiredUtmParameters: [...REQUIRED_LAUNCHPAD_UTM_PARAMETERS],
  };

  if (!finalUrl) {
    issues.push({
      code: "DESTINATION_URL_REQUIRED",
      message: "A Launchpad item requires a destination URL",
      field: "destinationUrl",
    });
    return { preview, issues };
  }

  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    issues.push({
      code: "INVALID_DESTINATION_URL",
      message: "Destination URL must be a valid HTTPS URL",
      field: "destinationUrl",
      details: { destinationUrl: finalUrl },
    });
    return { preview, issues };
  }

  preview.protocol = parsed.protocol;
  preview.isHttps = parsed.protocol === "https:";
  preview.utmParameters = Object.fromEntries(
    Array.from(parsed.searchParams.entries()).filter(([key]) => key.startsWith("utm_")),
  );
  preview.missingRequiredUtmParameters = REQUIRED_LAUNCHPAD_UTM_PARAMETERS.filter(
    (param) => !normalizedText(parsed.searchParams.get(param)),
  );

  if (!preview.isHttps) {
    issues.push({
      code: "INVALID_DESTINATION_URL",
      message: "Destination URL must use HTTPS",
      field: "destinationUrl",
      details: { destinationUrl: finalUrl, protocol: parsed.protocol },
    });
  }

  if (preview.missingRequiredUtmParameters.length > 0) {
    issues.push({
      code: "MISSING_REQUIRED_UTM_PARAMETERS",
      message: "Destination URL is missing required UTM parameters",
      field: "destinationUrl",
      details: {
        destinationUrl: finalUrl,
        requiredUtmParameters: REQUIRED_LAUNCHPAD_UTM_PARAMETERS,
        missingRequiredUtmParameters: preview.missingRequiredUtmParameters,
      },
    });
  }

  return { preview, issues };
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
  return {
    type: "image",
    uploadMethod: "url",
    creativeId: creative.id,
    sourceUrl: normalizedText(creative.assetUrl),
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
  assetUrl: string | null;
}) {
  const accountPath = input.account.metaAccountId.startsWith("act_")
    ? input.account.metaAccountId
    : `act_${input.account.metaAccountId}`;
  const creativeObjectStorySpec = {
    page_id: input.account.defaultFacebookPageId,
    instagram_actor_id: input.account.defaultInstagramActorId,
    link_data: {
      image_hash: "<META_IMAGE_HASH_FROM_URL_UPLOAD>",
      link: input.finalUrl,
      message: input.primaryText,
      name: input.headline,
      call_to_action:
        input.cta === "NO_BUTTON"
          ? null
          : {
              type: input.cta,
              value: { link: input.finalUrl },
            },
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

function buildCreativeIssues(input: LaunchpadPlannerInput) {
  const issues: LaunchpadValidationIssue[] = [];

  if (input.creative.format !== "static") {
    issues.push({
      code: "UNSUPPORTED_CREATIVE_FORMAT",
      message: "Launchpad dry-run currently supports static image creatives only",
      field: "creativeId",
      details: { creativeId: input.creative.id, format: input.creative.format },
    });
  }

  if (!normalizedText(input.creative.assetUrl)) {
    issues.push({
      code: "CREATIVE_ASSET_REQUIRED",
      message: "Static image dry-run requires a creative asset URL",
      field: "creativeId",
      details: { creativeId: input.creative.id },
    });
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
  const url = parseUrlPreview(input);
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
    assetUrl: normalizedText(input.creative.assetUrl),
  });

  const normalizedItem = {
    position: 1,
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
