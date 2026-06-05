import { PAUSED_META_STATUS, DEFAULT_META_CTA, metaCtaValues, type MetaCallToAction } from "@/lib/launchpad-constants";
import { classifyLaunchpadClone, type LaunchpadCloneCreativeInput } from "@/lib/launchpad-clone-classifier";
import { hashLaunchpadPayload, type LaunchpadOrgRole } from "@/lib/launchpad-ledger";
import type { LaunchpadPrincipalType } from "@/lib/launchpad-constants";
import type { LaunchpadSourceTemplate } from "@/lib/launchpad-source-templates";
import { parseLaunchpadUrlPreview } from "@/lib/launchpad-url";

export type LaunchpadClonePlannerInput = {
  organizationId: string;
  requestedBy: {
    userId: string | null;
    principalType: LaunchpadPrincipalType;
    orgRole: LaunchpadOrgRole;
  };
  sourceTemplate: LaunchpadSourceTemplate;
  launch: {
    launchName: string;
    destinationUrl: string;
    defaultPrimaryText?: string | null;
    defaultHeadline?: string | null;
    defaultCta?: string | null;
  };
  creatives: LaunchpadCloneCreativeInput[];
  idempotencyKey?: string | null;
};

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeNamePart(value: string | null | undefined) {
  return normalizedText(value)?.replace(/\s+/g, " ") ?? "Untitled";
}

function isMetaCta(value: string): value is MetaCallToAction {
  return (metaCtaValues as readonly string[]).includes(value);
}

function resolveCta(value: string | null | undefined): MetaCallToAction {
  const normalized = normalizedText(value);
  if (!normalized || !isMetaCta(normalized)) return DEFAULT_META_CTA;
  return normalized;
}

export function buildLaunchpadCloneDryRun(input: LaunchpadClonePlannerInput) {
  const url = parseLaunchpadUrlPreview({ defaultUrl: input.launch.destinationUrl });
  const classification = classifyLaunchpadClone({
    sourceTemplate: input.sourceTemplate,
    creatives: input.creatives,
    destinationUrl: input.launch.destinationUrl,
    requestedStatus: PAUSED_META_STATUS,
  });

  const launchName = sanitizeNamePart(input.launch.launchName);
  const sourceCampaignName = sanitizeNamePart(input.sourceTemplate.sourceCampaign?.name);
  const sourceAdSetName = sanitizeNamePart(input.sourceTemplate.sourceAdSet?.name);
  const plannedCampaignKey = "campaign:0";
  const plannedAdSetKey = "ad_set:0";

  const plannedCampaign = {
    plannedKey: plannedCampaignKey,
    name: `${launchName} / Adsolute paused campaign`,
    requestedStatus: PAUSED_META_STATUS,
    sourceCampaignId: input.sourceTemplate.sourceCampaign?.id ?? null,
    sourceCampaignMetaId: input.sourceTemplate.sourceCampaign?.metaId ?? null,
    sourceCampaignName,
  };

  const plannedAdSet = {
    plannedKey: plannedAdSetKey,
    plannedCampaignKey,
    name: `${launchName} / ${sourceAdSetName}`,
    requestedStatus: PAUSED_META_STATUS,
    sourceAdSetId: input.sourceTemplate.sourceAdSet?.id ?? null,
    sourceAdSetMetaId: input.sourceTemplate.sourceAdSet?.metaId ?? null,
    sourceAdSetName,
    budget: {
      dailyBudget: null,
      costCap: null,
      source: "explicit_budget_required",
    },
    targetingSummary: {
      targetingMethod: input.sourceTemplate.sourceAdSet?.targetingMethod ?? null,
      geos: input.sourceTemplate.sourceAdSet?.geos ?? null,
      placements: input.sourceTemplate.sourceAdSet?.placements ?? null,
      demographics: input.sourceTemplate.sourceAdSet?.demographics ?? null,
    },
  };

  const plannedAds = input.creatives.map((creative, index) => {
    const position = index + 1;
    const plannedKey = `ad:${position}`;
    const adName = `${launchName} / ${sanitizeNamePart(creative.name)} / ${String(position).padStart(2, "0")}`;
    const payload = {
      plannedKey,
      creativeId: creative.id,
      creativeName: creative.name,
      creativeFormat: creative.format,
      destinationUrl: url.preview.isHttps ? url.preview.finalUrl : null,
      requestedStatus: PAUSED_META_STATUS,
      primaryText: normalizedText(input.launch.defaultPrimaryText),
      headline: normalizedText(input.launch.defaultHeadline) ?? creative.name,
      cta: resolveCta(input.launch.defaultCta),
    };

    return {
      position,
      plannedKey,
      plannedAdSetKey,
      name: adName,
      requestedStatus: PAUSED_META_STATUS,
      payloadHash: hashLaunchpadPayload(payload),
      dedupeKey: hashLaunchpadPayload({
        organizationId: input.organizationId,
        sourceTemplateId: input.sourceTemplate.id,
        creativeId: creative.id,
        destinationUrl: payload.destinationUrl,
        requestedStatus: PAUSED_META_STATUS,
      }),
      creative: {
        id: creative.id,
        name: creative.name,
        format: creative.format,
        assetUrl: creative.assetUrl,
        videoUrl: creative.videoUrl ?? null,
      },
      launch: payload,
    };
  });

  const blockers = [
    ...classification.blockers,
    ...url.issues.filter((issue) => issue.code !== "MISSING_REQUIRED_UTM_PARAMETERS"),
  ];
  const warnings = [
    ...classification.warnings,
    ...url.issues.filter((issue) => issue.code === "MISSING_REQUIRED_UTM_PARAMETERS"),
  ];

  if (!normalizedText(input.launch.launchName)) {
    blockers.push({
      code: "LAUNCH_NAME_REQUIRED",
      message: "Enter a launch name so the planned Meta objects are easy to find.",
      field: "launchName",
    });
  }

  const requestedCta = normalizedText(input.launch.defaultCta);
  if (requestedCta && !isMetaCta(requestedCta)) {
    blockers.push({
      code: "INVALID_CTA",
      message: "Choose a supported Meta call-to-action for this launch.",
      field: "defaultCta",
    });
  }

  const validationStatus = blockers.length > 0
    ? "failed"
    : warnings.length > 0
      ? "passed_with_warnings"
      : "passed";

  const sourceSnapshot = {
    template: {
      id: input.sourceTemplate.id,
      label: input.sourceTemplate.label,
      notes: input.sourceTemplate.notes,
      approvedAt: input.sourceTemplate.approvedAt,
      lastValidatedAt: input.sourceTemplate.lastValidatedAt,
      expiresAt: input.sourceTemplate.expiresAt,
    },
    account: input.sourceTemplate.account,
    campaign: input.sourceTemplate.sourceCampaign,
    adSet: input.sourceTemplate.sourceAdSet,
  };
  const clonePlan = {
    classification: classification.status,
    cloneMode: classification.cloneMode,
    plannedCampaignKey,
    plannedAdSetKey,
    requiresCampaignClone: classification.requiresCampaignClone,
    requiresAdSetClone: classification.requiresAdSetClone,
  };

  const manifest = {
    version: 2,
    kind: "creative_launchpad.clone_setup_manifest",
    launchMode: "clone_setup",
    requestedStatus: PAUSED_META_STATUS,
    sourceTemplate: sourceSnapshot.template,
    sourceSnapshot,
    clonePlan,
    plannedCampaign,
    plannedAdSet,
    plannedAds,
    copiedSettings: classification.copiedSettings,
    notCopiedSettings: classification.notCopiedSettings,
    budget: plannedAdSet.budget,
    tracking: {
      finalUrl: url.preview.finalUrl,
      utmSummary: {
        required: url.preview.requiredUtmParameters,
        present: Object.keys(url.preview.utmParameters),
        missing: url.preview.missingRequiredUtmParameters,
      },
    },
    identity: {
      facebookPageId: input.sourceTemplate.account?.defaultFacebookPageId ?? null,
      instagramActorId: input.sourceTemplate.account?.defaultInstagramActorId ?? null,
      source: "account_defaults",
    },
    url: url.preview,
    validation: {
      status: validationStatus,
      blockers,
      warnings,
      issueCount: blockers.length + warnings.length,
      issues: [...blockers, ...warnings],
    },
    safety: {
      dryRunOnly: true,
      localObjectsCreatedDuringValidation: false,
      metaObjectsCreatedDuringValidation: false,
      allCreatedObjectsPaused: true,
      metaWritesAllowed: false,
      campaignCreationAllowed: false,
      adSetCreationAllowed: false,
      adCreationAllowed: false,
    },
  };

  return {
    manifest,
    manifestHash: hashLaunchpadPayload(manifest),
    sourceTemplateHash: hashLaunchpadPayload(sourceSnapshot),
    clonePlanHash: hashLaunchpadPayload(clonePlan),
    status: validationStatus === "failed" ? "failed" as const : "validated" as const,
    issues: manifest.validation.issues,
  };
}
