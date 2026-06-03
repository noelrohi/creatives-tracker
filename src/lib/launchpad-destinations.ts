import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { adSets } from "@/schema/ad-set";
import { campaigns } from "@/schema/campaign";

type LaunchpadDestinationReader = Pick<typeof db, "select">;

export type LaunchpadDestinationErrorCode =
  | "ACCOUNT_ID_REQUIRED"
  | "AD_SET_ID_REQUIRED"
  | "AD_ACCOUNT_NOT_FOUND"
  | "AD_SET_NOT_FOUND"
  | "ACCOUNT_ACCESS_TOKEN_REQUIRED"
  | "FACEBOOK_PAGE_ID_REQUIRED"
  | "AD_SET_ACCOUNT_LINK_REQUIRED"
  | "ACCOUNT_AD_SET_MISMATCH"
  | "AD_SET_META_ID_REQUIRED";

export type LaunchpadAccountReadinessReason =
  | "missing_access_token"
  | "missing_facebook_page_id";

export class LaunchpadDestinationError extends Error {
  readonly code: LaunchpadDestinationErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: LaunchpadDestinationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LaunchpadDestinationError";
    this.code = code;
    this.details = details;
  }
}

type AccountRow = {
  id: string;
  name: string;
  metaAccountId: string;
  metaAccessToken: string | null;
  defaultFacebookPageId: string | null;
  defaultInstagramActorId: string | null;
};

type AdSetContextRow = {
  id: string;
  name: string;
  metaId: string | null;
  accountId: string | null;
  status: string;
  campaignId: string;
  campaignName: string | null;
  campaignMetaId: string | null;
  campaignStatus: string | null;
};

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readinessReasons(account: Pick<AccountRow, "metaAccessToken" | "defaultFacebookPageId">) {
  const reasons: LaunchpadAccountReadinessReason[] = [];
  if (!account.metaAccessToken) reasons.push("missing_access_token");
  if (!account.defaultFacebookPageId) reasons.push("missing_facebook_page_id");
  return reasons;
}

function publicAccount(account: AccountRow) {
  const ineligibleReasons = readinessReasons(account);
  return {
    id: account.id,
    name: account.name,
    metaAccountId: account.metaAccountId,
    defaultFacebookPageId: account.defaultFacebookPageId,
    defaultInstagramActorId: account.defaultInstagramActorId,
    hasMetaAccessToken: Boolean(account.metaAccessToken),
    canPublish: ineligibleReasons.length === 0,
    ineligibleReasons,
  };
}

function publicAdSet(row: AdSetContextRow) {
  return {
    id: row.id,
    name: row.name,
    metaId: row.metaId,
    accountId: row.accountId,
    status: row.status,
    campaign: {
      id: row.campaignId,
      name: row.campaignName,
      metaId: row.campaignMetaId,
      status: row.campaignStatus,
    },
  };
}

export type LaunchpadDestinationAccount = ReturnType<typeof publicAccount>;
export type LaunchpadDestinationAdSet = ReturnType<typeof publicAdSet>;

export type LaunchpadDestinationInspectionIssue = {
  code: LaunchpadDestinationErrorCode;
  message: string;
  field?: "accountId" | "adSetId";
  details?: Record<string, unknown>;
};

export type LaunchpadDestinationInspection = {
  account: LaunchpadDestinationAccount;
  adSet: LaunchpadDestinationAdSet;
  issues: LaunchpadDestinationInspectionIssue[];
};

export async function listLaunchpadDestinationAccounts(
  client: LaunchpadDestinationReader,
  organizationId: string,
) {
  const rows = await client
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      metaAccountId: adAccounts.metaAccountId,
      metaAccessToken: adAccounts.metaAccessToken,
      defaultFacebookPageId: adAccounts.defaultFacebookPageId,
      defaultInstagramActorId: adAccounts.defaultInstagramActorId,
    })
    .from(adAccounts)
    .where(eq(adAccounts.organizationId, organizationId))
    .orderBy(desc(adAccounts.createdAt));

  return rows.map(publicAccount);
}

async function getAccount(
  client: LaunchpadDestinationReader,
  organizationId: string,
  accountId: string,
) {
  const [account] = await client
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      metaAccountId: adAccounts.metaAccountId,
      metaAccessToken: adAccounts.metaAccessToken,
      defaultFacebookPageId: adAccounts.defaultFacebookPageId,
      defaultInstagramActorId: adAccounts.defaultInstagramActorId,
    })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.id, accountId),
        eq(adAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);

  return account;
}

async function getAdSetContext(
  client: LaunchpadDestinationReader,
  organizationId: string,
  adSetId: string,
) {
  const [adSet] = await client
    .select({
      id: adSets.id,
      name: adSets.name,
      metaId: adSets.metaId,
      accountId: adAccounts.id,
      status: adSets.status,
      campaignId: adSets.campaignId,
      campaignName: campaigns.name,
      campaignMetaId: campaigns.metaId,
      campaignStatus: campaigns.status,
    })
    .from(adSets)
    .leftJoin(
      adAccounts,
      and(
        eq(adSets.accountId, adAccounts.id),
        eq(adAccounts.organizationId, organizationId),
      ),
    )
    .leftJoin(
      campaigns,
      and(
        eq(adSets.campaignId, campaigns.id),
        eq(campaigns.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(adSets.id, adSetId),
        eq(adSets.organizationId, organizationId),
      ),
    )
    .limit(1);

  return adSet;
}

export async function listEligibleLaunchpadAdSets(
  client: LaunchpadDestinationReader,
  organizationId: string,
  accountId: string,
) {
  const account = await getAccount(client, organizationId, accountId);
  if (!account) {
    throw new LaunchpadDestinationError(
      "AD_ACCOUNT_NOT_FOUND",
      "Ad account does not exist in this organization",
      { accountId },
    );
  }

  if (readinessReasons(account).length > 0) {
    return [];
  }

  const rows = await client
    .select({
      id: adSets.id,
      name: adSets.name,
      metaId: adSets.metaId,
      accountId: adAccounts.id,
      status: adSets.status,
      campaignId: adSets.campaignId,
      campaignName: campaigns.name,
      campaignMetaId: campaigns.metaId,
      campaignStatus: campaigns.status,
    })
    .from(adSets)
    .leftJoin(
      adAccounts,
      and(
        eq(adSets.accountId, adAccounts.id),
        eq(adAccounts.organizationId, organizationId),
      ),
    )
    .leftJoin(
      campaigns,
      and(
        eq(adSets.campaignId, campaigns.id),
        eq(campaigns.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(adSets.organizationId, organizationId),
        eq(adSets.accountId, accountId),
        isNotNull(adSets.metaId),
      ),
    )
    .orderBy(desc(adSets.updatedAt));

  return rows
    .filter((row) => row.accountId === accountId && row.metaId)
    .map(publicAdSet);
}

export async function inspectLaunchpadDestinationForDryRun(
  client: LaunchpadDestinationReader,
  organizationId: string,
  input: { accountId?: string | null; adSetId?: string | null },
): Promise<LaunchpadDestinationInspection> {
  const accountId = normalizedText(input.accountId);
  if (!accountId) {
    throw new LaunchpadDestinationError(
      "ACCOUNT_ID_REQUIRED",
      "A Launchpad destination requires a selected Meta ad account",
    );
  }

  const adSetId = normalizedText(input.adSetId);
  if (!adSetId) {
    throw new LaunchpadDestinationError(
      "AD_SET_ID_REQUIRED",
      "A Launchpad destination requires a selected Meta ad set",
    );
  }

  const account = await getAccount(client, organizationId, accountId);
  if (!account) {
    throw new LaunchpadDestinationError(
      "AD_ACCOUNT_NOT_FOUND",
      "Ad account does not exist in this organization",
      { accountId },
    );
  }

  const adSet = await getAdSetContext(client, organizationId, adSetId);
  if (!adSet) {
    throw new LaunchpadDestinationError(
      "AD_SET_NOT_FOUND",
      "Ad set does not exist in this organization",
      { adSetId },
    );
  }

  const issues: LaunchpadDestinationInspectionIssue[] = [];

  if (!account.metaAccessToken) {
    issues.push({
      code: "ACCOUNT_ACCESS_TOKEN_REQUIRED",
      message: "The selected Meta ad account needs a stored access token before publishing",
      field: "accountId",
      details: { accountId },
    });
  }

  if (!account.defaultFacebookPageId) {
    issues.push({
      code: "FACEBOOK_PAGE_ID_REQUIRED",
      message: "The selected Meta ad account needs a default Facebook Page ID before publishing",
      field: "accountId",
      details: { accountId },
    });
  }

  if (!adSet.accountId) {
    issues.push({
      code: "AD_SET_ACCOUNT_LINK_REQUIRED",
      message: "The selected Meta ad set is not linked to a Meta ad account",
      field: "adSetId",
      details: { adSetId },
    });
  } else if (adSet.accountId !== account.id) {
    issues.push({
      code: "ACCOUNT_AD_SET_MISMATCH",
      message: "The selected Meta ad set does not belong to the selected Meta ad account",
      field: "adSetId",
      details: { accountId: account.id, adSetId, adSetAccountId: adSet.accountId },
    });
  }

  if (!adSet.metaId) {
    issues.push({
      code: "AD_SET_META_ID_REQUIRED",
      message: "The selected ad set needs a Meta ad set ID before publishing",
      field: "adSetId",
      details: { adSetId },
    });
  }

  return {
    account: publicAccount(account),
    adSet: publicAdSet(adSet),
    issues,
  };
}

export async function assertEligibleLaunchpadDestination(
  client: LaunchpadDestinationReader,
  organizationId: string,
  input: { accountId?: string | null; adSetId?: string | null },
) {
  const accountId = normalizedText(input.accountId);
  if (!accountId) {
    throw new LaunchpadDestinationError(
      "ACCOUNT_ID_REQUIRED",
      "A Launchpad destination requires a selected Meta ad account",
    );
  }

  const adSetId = normalizedText(input.adSetId);
  if (!adSetId) {
    throw new LaunchpadDestinationError(
      "AD_SET_ID_REQUIRED",
      "A Launchpad destination requires a selected Meta ad set",
    );
  }

  const account = await getAccount(client, organizationId, accountId);
  if (!account) {
    throw new LaunchpadDestinationError(
      "AD_ACCOUNT_NOT_FOUND",
      "Ad account does not exist in this organization",
      { accountId },
    );
  }

  if (!account.metaAccessToken) {
    throw new LaunchpadDestinationError(
      "ACCOUNT_ACCESS_TOKEN_REQUIRED",
      "The selected Meta ad account needs a stored access token before publishing",
      { accountId },
    );
  }

  if (!account.defaultFacebookPageId) {
    throw new LaunchpadDestinationError(
      "FACEBOOK_PAGE_ID_REQUIRED",
      "The selected Meta ad account needs a default Facebook Page ID before publishing",
      { accountId },
    );
  }

  const adSet = await getAdSetContext(client, organizationId, adSetId);
  if (!adSet) {
    throw new LaunchpadDestinationError(
      "AD_SET_NOT_FOUND",
      "Ad set does not exist in this organization",
      { adSetId },
    );
  }

  if (!adSet.accountId) {
    throw new LaunchpadDestinationError(
      "AD_SET_ACCOUNT_LINK_REQUIRED",
      "The selected Meta ad set is not linked to a Meta ad account",
      { adSetId },
    );
  }

  if (adSet.accountId !== account.id) {
    throw new LaunchpadDestinationError(
      "ACCOUNT_AD_SET_MISMATCH",
      "The selected Meta ad set does not belong to the selected Meta ad account",
      { accountId: account.id, adSetId, adSetAccountId: adSet.accountId },
    );
  }

  if (!adSet.metaId) {
    throw new LaunchpadDestinationError(
      "AD_SET_META_ID_REQUIRED",
      "The selected ad set needs a Meta ad set ID before publishing",
      { adSetId },
    );
  }

  return {
    account: publicAccount(account),
    adSet: publicAdSet(adSet),
  };
}
