import {
  PAUSED_META_STATUS,
  launchpadSupportedCreativeFormats,
  launchpadVideoCreativeFormats,
} from "@/lib/launchpad-constants";
import type { LaunchpadValidationIssue } from "@/lib/launchpad-ledger";
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
    { key: "campaign_objective", label: "Campaign objective/type", source: "source campaign" },
    { key: "budget_style", label: "Budget style", source: "source ad set" },
    { key: "audience", label: "Audience", source: "source ad set" },
    { key: "placements", label: "Placements", source: "source ad set" },
    { key: "tracking", label: "Pixel/conversion tracking", source: "source ad set" },
    { key: "identity", label: "Facebook Page / Instagram identity", source: "ad account defaults" },
  ];

  const notCopiedSettings = [
    { key: "active_status", label: "Active status", reason: "Launchpad creates everything paused." },
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
