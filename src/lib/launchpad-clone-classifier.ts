import {
  PAUSED_META_STATUS,
  launchpadSupportedCreativeFormats,
  launchpadVideoCreativeFormats,
} from "@/lib/launchpad-constants";
import type { LaunchpadValidationIssue } from "@/lib/launchpad-ledger";
import type { LaunchpadFreshSourceInspection } from "@/lib/launchpad-meta-source-inspection";
import type { LaunchpadSourceTemplate } from "@/lib/launchpad-source-templates";

export type LaunchpadCloneCreativeInput = {
  id: string;
  name: string;
  format: string | null;
  assetUrl: string | null;
  videoUrl?: string | null;
};

export type LaunchpadCloneClassifierInput = {
  sourceTemplate: LaunchpadSourceTemplate;
  creatives: LaunchpadCloneCreativeInput[];
  destinationUrl?: string | null;
  requestedStatus?: string;
  sourceInspection?: LaunchpadFreshSourceInspection | null;
};

export type LaunchpadCloneClassification = {
  status: "eligible" | "eligible_with_warning" | "blocked" | "manual_review_required";
  cloneMode:
    | "source_campaign_ad_set_template"
    | "source_campaign_ad_set_template_with_warnings"
    | "invalid";
  requiresCampaignClone: true;
  requiresAdSetClone: true;
  blockers: LaunchpadValidationIssue[];
  warnings: LaunchpadValidationIssue[];
  copiedSettings: Array<{ key: string; label: string; source: string }>;
  notCopiedSettings: Array<{ key: string; label: string; reason: string }>;
};

function isSupportedCreativeFormat(format: string | null | undefined) {
  return (launchpadSupportedCreativeFormats as readonly string[]).includes(format ?? "");
}

function isVideoCreativeFormat(format: string | null | undefined) {
  return (launchpadVideoCreativeFormats as readonly string[]).includes(format ?? "");
}

export function classifyLaunchpadClone(
  input: LaunchpadCloneClassifierInput,
): LaunchpadCloneClassification {
  const blockers: LaunchpadValidationIssue[] = [];
  const warnings: LaunchpadValidationIssue[] = [];
  const templateReadiness = input.sourceTemplate.readiness;

  blockers.push(...templateReadiness.blockers);
  warnings.push(...templateReadiness.warnings);

  if (!input.sourceInspection || input.sourceInspection.status !== "available") {
    blockers.push(...(input.sourceInspection?.blockers.length
      ? input.sourceInspection.blockers
      : [{
          code: "FRESH_SOURCE_INSPECTION_UNAVAILABLE",
          message: "Launchpad needs a fresh Meta source inspection before it can create a dry-run plan.",
          field: "sourceTemplateId",
        }]));
  } else {
    const campaign = input.sourceInspection.campaign ?? {};
    const adSet = input.sourceInspection.adSet ?? {};
    const targeting = typeof adSet.targeting === "object" && adSet.targeting ? adSet.targeting as Record<string, unknown> : {};

    if (campaign.buying_type && campaign.buying_type !== "AUCTION") blockers.push({ code: "UNSUPPORTED_BUYING_TYPE", message: "Only AUCTION source campaigns are supported in Launchpad M1.", field: "sourceCampaignId", details: { buyingType: campaign.buying_type } });
    if (campaign.daily_budget || campaign.lifetime_budget) blockers.push({ code: "CAMPAIGN_BUDGET_UNSUPPORTED", message: "Campaign budget optimization/source campaign budgets are not supported for clone dry-runs.", field: "sourceCampaignId" });
    if (campaign.spend_cap) blockers.push({ code: "CAMPAIGN_SPEND_CAP_UNSUPPORTED", message: "Source campaign spend caps are not copied and require manual review.", field: "sourceCampaignId" });
    if (Array.isArray(campaign.special_ad_categories) && campaign.special_ad_categories.length > 0) blockers.push({ code: "SPECIAL_AD_CATEGORY_UNSUPPORTED", message: "Special ad category source campaigns require manual media-buyer review.", field: "sourceCampaignId" });
    if (adSet.lifetime_budget) blockers.push({ code: "LIFETIME_BUDGET_UNSUPPORTED", message: "Lifetime-budget ad sets are not supported. Enter an explicit daily budget instead.", field: "sourceAdSetId" });
    if (adSet.dynamic_creative === true) blockers.push({ code: "DYNAMIC_CREATIVE_UNSUPPORTED", message: "Dynamic creative source ad sets are not supported in Launchpad M1.", field: "sourceAdSetId" });
    if (!adSet.promoted_object) blockers.push({ code: "PROMOTED_OBJECT_REQUIRED", message: "Source ad set promoted object/pixel tracking could not be read.", field: "sourceAdSetId" });
    if (!adSet.optimization_goal) blockers.push({ code: "OPTIMIZATION_GOAL_REQUIRED", message: "Source ad set optimization goal could not be read.", field: "sourceAdSetId" });
    if (!adSet.billing_event) blockers.push({ code: "BILLING_EVENT_REQUIRED", message: "Source ad set billing event could not be read.", field: "sourceAdSetId" });
    if (targeting.publisher_platforms && !Array.isArray(targeting.publisher_platforms)) blockers.push({ code: "PLACEMENTS_UNREADABLE", message: "Source placements could not be read safely.", field: "sourceAdSetId" });
  }

  if (input.requestedStatus && input.requestedStatus !== PAUSED_META_STATUS) {
    blockers.push({
      code: "ACTIVE_META_STATUS_FORBIDDEN",
      message: "Launchpad clone plans can only create PAUSED Meta objects.",
      field: "requestedStatus",
      details: { requestedStatus: input.requestedStatus },
    });
  }

  if (input.creatives.length === 0) {
    blockers.push({
      code: "CREATIVE_SELECTION_REQUIRED",
      message: "Select at least one creative for this Launchpad plan.",
      field: "creativeIds",
    });
  }

  const seenCreativeIds = new Set<string>();
  for (const [index, creative] of input.creatives.entries()) {
    if (seenCreativeIds.has(creative.id)) {
      blockers.push({
        code: "DUPLICATE_CREATIVE_SELECTED",
        message: "Each creative can only be selected once in a Launchpad plan.",
        field: "creativeIds",
        details: { creativeId: creative.id, index },
      });
      continue;
    }
    seenCreativeIds.add(creative.id);

    if (!isSupportedCreativeFormat(creative.format)) {
      blockers.push({
        code: "UNSUPPORTED_CREATIVE_FORMAT",
        message: "This creative format is not supported by the first Launchpad clone flow.",
        field: "creativeIds",
        details: {
          creativeId: creative.id,
          format: creative.format,
          supportedFormats: launchpadSupportedCreativeFormats,
        },
      });
      continue;
    }

    if (isVideoCreativeFormat(creative.format)) {
      if (!creative.videoUrl?.trim()) {
        blockers.push({
          code: "CREATIVE_VIDEO_REQUIRED",
          message: "Video/UGC creatives need a playable video URL before Launchpad can plan ads.",
          field: "creativeIds",
          details: { creativeId: creative.id },
        });
      }
    } else if (!creative.assetUrl?.trim()) {
      blockers.push({
        code: "CREATIVE_ASSET_REQUIRED",
        message: "Static creatives need an image asset URL before Launchpad can plan ads.",
        field: "creativeIds",
        details: { creativeId: creative.id },
      });
    }
  }

  const copiedSettings = [
    { key: "campaign_objective", label: "Campaign objective/type", source: "fresh Meta source inspection" },
    { key: "audience", label: "Audience", source: "source ad set" },
    { key: "placements", label: "Placements", source: "source ad set" },
    { key: "identity", label: "Facebook Page / Instagram identity", source: "ad account defaults" },
  ];

  const notCopiedSettings = [
    { key: "active_status", label: "Active status", reason: "Launchpad creates everything paused." },
    { key: "budget", label: "Source budget and spend caps", reason: "Milestone 1 requires an explicit launch budget." },
    { key: "historical_performance", label: "Historical performance", reason: "Performance is not copied into new Meta objects." },
    { key: "learning", label: "Meta learning state", reason: "New campaigns/ad sets start fresh in Meta." },
  ];

  const status = blockers.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "eligible_with_warning"
      : "eligible";

  return {
    status,
    cloneMode: status === "blocked"
      ? "invalid"
      : status === "eligible_with_warning"
        ? "source_campaign_ad_set_template_with_warnings"
        : "source_campaign_ad_set_template",
    requiresCampaignClone: true,
    requiresAdSetClone: true,
    blockers,
    warnings,
    copiedSettings,
    notCopiedSettings,
  };
}
