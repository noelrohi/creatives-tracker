import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";
import { launchpadSourceTemplates } from "@/schema/launchpad";
import type { LaunchpadSourceTemplateStatus } from "@/lib/launchpad-constants";

export type LaunchpadSourceTemplateReadinessIssue = {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
};

type LaunchpadSourceTemplateReader = Pick<typeof db, "select">;

type SourceTemplateRow = {
  id: string;
  organizationId: string;
  accountLinkConfigured: boolean;
  accountId: string | null;
  sourceCampaignLinkConfigured: boolean;
  sourceCampaignId: string | null;
  sourceCampaignMetaId: string;
  sourceAdSetLinkConfigured: boolean;
  sourceAdSetId: string | null;
  sourceAdSetMetaId: string;
  label: string;
  notes: string | null;
  status: LaunchpadSourceTemplateStatus;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  lastValidatedAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  accountName: string | null;
  accountMetaAccountId: string | null;
  accountHasMetaAccessToken: boolean;
  accountDefaultFacebookPageId: string | null;
  accountDefaultInstagramActorId: string | null;
  campaignName: string | null;
  campaignMetaId: string | null;
  campaignStatus: string | null;
  campaignAccountId: string | null;
  adSetName: string | null;
  adSetMetaId: string | null;
  adSetStatus: string | null;
  adSetAccountId: string | null;
  adSetCampaignId: string | null;
  adSetDailyBudget: string | null;
  adSetCostCap: string | null;
  adSetTargetingMethod: string[] | null;
  adSetGeos: string[] | null;
  adSetPlacements: string[] | null;
  adSetDemographics: string | null;
};

function isExpired(expiresAt: Date | null, now = new Date()) {
  return Boolean(expiresAt && expiresAt.getTime() <= now.getTime());
}

function sameTemplateAccountId(
  row: SourceTemplateRow,
  accountId: string | null,
) {
  return row.accountId && accountId === row.accountId ? accountId : null;
}

function buildReadiness(row: SourceTemplateRow) {
  const blockers: LaunchpadSourceTemplateReadinessIssue[] = [];
  const warnings: LaunchpadSourceTemplateReadinessIssue[] = [];

  if (row.status !== "approved") {
    blockers.push({
      code: "SOURCE_TEMPLATE_NOT_APPROVED",
      message: "This campaign/ad set template is not approved for Launchpad yet.",
      field: "status",
      details: { status: row.status },
    });
  }

  if (isExpired(row.expiresAt)) {
    blockers.push({
      code: "SOURCE_TEMPLATE_EXPIRED",
      message: "This campaign/ad set template has expired and needs to be reviewed again.",
      field: "expiresAt",
    });
  }

  if (!row.accountLinkConfigured) {
    blockers.push({
      code: "SOURCE_TEMPLATE_ACCOUNT_REQUIRED",
      message: "This template is missing a linked Meta ad account.",
      field: "accountId",
    });
  } else if (!row.accountId) {
    blockers.push({
      code: "SOURCE_TEMPLATE_ACCOUNT_LINK_INVALID",
      message: "This template's linked Meta ad account does not exist in this organization.",
      field: "accountId",
    });
  } else if (!row.accountMetaAccountId) {
    blockers.push({
      code: "SOURCE_TEMPLATE_ACCOUNT_META_ID_REQUIRED",
      message: "This template's linked Meta ad account is missing its Meta account ID.",
      field: "accountId",
    });
  }

  if (row.accountId && !row.accountHasMetaAccessToken) {
    blockers.push({
      code: "ACCOUNT_ACCESS_TOKEN_REQUIRED",
      message: "The Meta ad account needs an access token before Launchpad can plan from it.",
      field: "accountId",
    });
  }

  if (row.accountId && !row.accountDefaultFacebookPageId) {
    blockers.push({
      code: "FACEBOOK_PAGE_ID_REQUIRED",
      message: "The Meta ad account needs a default Facebook Page before Launchpad can create ads.",
      field: "accountId",
    });
  }

  if (!row.sourceCampaignLinkConfigured) {
    blockers.push({
      code: "SOURCE_CAMPAIGN_LINK_REQUIRED",
      message: "This template is missing its local source campaign link.",
      field: "sourceCampaignId",
    });
  } else if (!row.sourceCampaignId || !row.campaignName) {
    blockers.push({
      code: "SOURCE_CAMPAIGN_LINK_INVALID",
      message: "This template's linked source campaign does not exist in this organization.",
      field: "sourceCampaignId",
    });
  }

  if (row.sourceCampaignId && !row.campaignMetaId) {
    blockers.push({
      code: "SOURCE_CAMPAIGN_META_ID_REQUIRED",
      message: "This template is missing the source campaign Meta ID.",
      field: "sourceCampaignMetaId",
    });
  }

  if (
    row.sourceCampaignId &&
    row.sourceCampaignMetaId &&
    row.campaignMetaId &&
    row.sourceCampaignMetaId !== row.campaignMetaId
  ) {
    blockers.push({
      code: "SOURCE_CAMPAIGN_META_ID_MISMATCH",
      message: "The template's source campaign Meta ID does not match the linked org-owned campaign.",
      field: "sourceCampaignMetaId",
    });
  }

  if (!row.sourceAdSetLinkConfigured) {
    blockers.push({
      code: "SOURCE_AD_SET_LINK_REQUIRED",
      message: "This template is missing its local source ad set link.",
      field: "sourceAdSetId",
    });
  } else if (!row.sourceAdSetId || !row.adSetName) {
    blockers.push({
      code: "SOURCE_AD_SET_LINK_INVALID",
      message: "This template's linked source ad set does not exist in this organization.",
      field: "sourceAdSetId",
    });
  }

  if (row.sourceAdSetId && !row.adSetMetaId) {
    blockers.push({
      code: "SOURCE_AD_SET_META_ID_REQUIRED",
      message: "This template is missing the source ad set Meta ID.",
      field: "sourceAdSetMetaId",
    });
  }

  if (
    row.sourceAdSetId &&
    row.sourceAdSetMetaId &&
    row.adSetMetaId &&
    row.sourceAdSetMetaId !== row.adSetMetaId
  ) {
    blockers.push({
      code: "SOURCE_AD_SET_META_ID_MISMATCH",
      message: "The template's source ad set Meta ID does not match the linked org-owned ad set.",
      field: "sourceAdSetMetaId",
    });
  }

  if (
    row.accountId &&
    row.sourceCampaignId &&
    row.campaignAccountId !== row.accountId
  ) {
    blockers.push({
      code: "SOURCE_TEMPLATE_CAMPAIGN_ACCOUNT_MISMATCH",
      message: "The linked source campaign belongs to a different ad account than this template.",
      field: "sourceCampaignId",
    });
  }

  if (
    row.accountId &&
    row.sourceAdSetId &&
    row.adSetAccountId !== row.accountId
  ) {
    blockers.push({
      code: "SOURCE_TEMPLATE_AD_SET_ACCOUNT_MISMATCH",
      message: "The linked source ad set belongs to a different ad account than this template.",
      field: "sourceAdSetId",
    });
  }

  if (
    row.sourceCampaignId &&
    row.sourceAdSetId &&
    row.adSetCampaignId !== row.sourceCampaignId
  ) {
    blockers.push({
      code: "SOURCE_AD_SET_CAMPAIGN_MISMATCH",
      message: "The linked source ad set does not belong to the linked source campaign.",
      field: "sourceAdSetId",
    });
  }

  if (row.accountId && !row.accountDefaultInstagramActorId) {
    warnings.push({
      code: "INSTAGRAM_ACTOR_NOT_CONFIGURED",
      message: "No default Instagram identity is configured. Launchpad can still plan Facebook/Page ads.",
      field: "accountId",
    });
  }

  if (!row.lastValidatedAt) {
    warnings.push({
      code: "SOURCE_TEMPLATE_NOT_RECENTLY_VALIDATED",
      message: "This template has not been recently validated against Meta.",
      field: "lastValidatedAt",
    });
  }

  if (
    row.campaignAccountId &&
    row.adSetAccountId &&
    row.campaignAccountId !== row.adSetAccountId
  ) {
    blockers.push({
      code: "SOURCE_CAMPAIGN_ACCOUNT_MISMATCH",
      message: "The source campaign and ad set appear to belong to different ad accounts.",
    });
  }

  return {
    status: blockers.length > 0 ? "blocked" as const : warnings.length > 0 ? "warning" as const : "ready" as const,
    blockers,
    warnings,
  };
}

function toPublicSourceTemplate(row: SourceTemplateRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    label: row.label,
    notes: row.notes,
    status: row.status,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    lastValidatedAt: row.lastValidatedAt,
    expiresAt: row.expiresAt,
    metadata: row.metadata,
    account: row.accountId ? {
      id: row.accountId,
      name: row.accountName,
      metaAccountId: row.accountMetaAccountId,
      hasMetaAccessToken: row.accountHasMetaAccessToken,
      defaultFacebookPageId: row.accountDefaultFacebookPageId,
      defaultInstagramActorId: row.accountDefaultInstagramActorId,
    } : null,
    sourceCampaign: row.sourceCampaignId ? {
      id: row.sourceCampaignId,
      name: row.campaignName,
      metaId: row.campaignMetaId,
      status: row.campaignStatus,
      accountId: sameTemplateAccountId(row, row.campaignAccountId),
    } : null,
    sourceAdSet: row.sourceAdSetId ? {
      id: row.sourceAdSetId,
      name: row.adSetName,
      metaId: row.adSetMetaId,
      status: row.adSetStatus,
      accountId: sameTemplateAccountId(row, row.adSetAccountId),
      dailyBudget: row.adSetDailyBudget,
      costCap: row.adSetCostCap,
      targetingMethod: row.adSetTargetingMethod,
      geos: row.adSetGeos,
      placements: row.adSetPlacements,
      demographics: row.adSetDemographics,
    } : null,
    readiness: buildReadiness(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type LaunchpadSourceTemplate = ReturnType<typeof toPublicSourceTemplate>;

async function selectSourceTemplateRows(
  client: LaunchpadSourceTemplateReader,
  organizationId: string,
  extraCondition?: ReturnType<typeof eq>,
) {
  const conditions = [
    eq(launchpadSourceTemplates.organizationId, organizationId),
    extraCondition,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));

  return client
    .select({
      id: launchpadSourceTemplates.id,
      organizationId: launchpadSourceTemplates.organizationId,
      accountLinkConfigured: sql<boolean>`${launchpadSourceTemplates.accountId} is not null`,
      accountId: adAccounts.id,
      sourceCampaignLinkConfigured: sql<boolean>`${launchpadSourceTemplates.sourceCampaignId} is not null`,
      sourceCampaignId: campaigns.id,
      sourceCampaignMetaId: launchpadSourceTemplates.sourceCampaignMetaId,
      sourceAdSetLinkConfigured: sql<boolean>`${launchpadSourceTemplates.sourceAdSetId} is not null`,
      sourceAdSetId: adSets.id,
      sourceAdSetMetaId: launchpadSourceTemplates.sourceAdSetMetaId,
      label: launchpadSourceTemplates.label,
      notes: launchpadSourceTemplates.notes,
      status: launchpadSourceTemplates.status,
      approvedByUserId: launchpadSourceTemplates.approvedByUserId,
      approvedAt: launchpadSourceTemplates.approvedAt,
      lastValidatedAt: launchpadSourceTemplates.lastValidatedAt,
      expiresAt: launchpadSourceTemplates.expiresAt,
      metadata: launchpadSourceTemplates.metadata,
      createdAt: launchpadSourceTemplates.createdAt,
      updatedAt: launchpadSourceTemplates.updatedAt,
      accountName: adAccounts.name,
      accountMetaAccountId: adAccounts.metaAccountId,
      accountHasMetaAccessToken: sql<boolean>`${adAccounts.metaAccessToken} is not null`,
      accountDefaultFacebookPageId: adAccounts.defaultFacebookPageId,
      accountDefaultInstagramActorId: adAccounts.defaultInstagramActorId,
      campaignName: campaigns.name,
      campaignMetaId: campaigns.metaId,
      campaignStatus: campaigns.status,
      campaignAccountId: campaigns.accountId,
      adSetName: adSets.name,
      adSetMetaId: adSets.metaId,
      adSetStatus: adSets.status,
      adSetAccountId: adSets.accountId,
      adSetCampaignId: adSets.campaignId,
      adSetDailyBudget: adSets.dailyBudget,
      adSetCostCap: adSets.costCap,
      adSetTargetingMethod: adSets.targetingMethod,
      adSetGeos: adSets.geos,
      adSetPlacements: adSets.placements,
      adSetDemographics: adSets.demographics,
    })
    .from(launchpadSourceTemplates)
    .leftJoin(
      adAccounts,
      and(
        eq(launchpadSourceTemplates.accountId, adAccounts.id),
        eq(adAccounts.organizationId, organizationId),
      ),
    )
    .leftJoin(
      campaigns,
      and(
        eq(launchpadSourceTemplates.sourceCampaignId, campaigns.id),
        eq(campaigns.organizationId, organizationId),
      ),
    )
    .leftJoin(
      adSets,
      and(
        eq(launchpadSourceTemplates.sourceAdSetId, adSets.id),
        eq(adSets.organizationId, organizationId),
      ),
    )
    .where(and(...conditions));
}

export async function listApprovedLaunchpadSourceTemplates(
  client: LaunchpadSourceTemplateReader,
  organizationId: string,
) {
  const rows = await selectSourceTemplateRows(
    client,
    organizationId,
    and(
      eq(launchpadSourceTemplates.status, "approved"),
      or(
        isNull(launchpadSourceTemplates.expiresAt),
        sql`${launchpadSourceTemplates.expiresAt} > now()`,
      ),
    ),
  );

  return rows.map((row) => toPublicSourceTemplate(row as SourceTemplateRow));
}

export async function getLaunchpadSourceTemplate(
  client: LaunchpadSourceTemplateReader,
  organizationId: string,
  templateId: string,
) {
  const rows = await selectSourceTemplateRows(
    client,
    organizationId,
    eq(launchpadSourceTemplates.id, templateId),
  );

  const row = rows[0];
  return row ? toPublicSourceTemplate(row as SourceTemplateRow) : null;
}

export class LaunchpadSourceTemplateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LaunchpadSourceTemplateError";
    this.code = code;
  }
}

export async function getApprovedLaunchpadSourceTemplateOrThrow(
  client: LaunchpadSourceTemplateReader,
  organizationId: string,
  templateId: string,
) {
  const template = await getLaunchpadSourceTemplate(client, organizationId, templateId);
  if (!template) {
    throw new LaunchpadSourceTemplateError(
      "SOURCE_TEMPLATE_NOT_FOUND",
      "Launchpad source template does not exist in this organization",
    );
  }

  if (template.readiness.blockers.length > 0) {
    throw new LaunchpadSourceTemplateError(
      "SOURCE_TEMPLATE_NOT_READY",
      template.readiness.blockers[0]?.message ?? "Launchpad source template is not ready",
    );
  }

  return template;
}
