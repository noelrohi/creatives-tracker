import { TRPCError } from "@trpc/server";
import { tasks } from "@trigger.dev/sdk";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { isLaunchpadEnabled } from "@/lib/feature-flags";
import {
  LAUNCHPAD_MAX_ITEMS,
  PAUSED_META_STATUS,
  launchpadSupportedCreativeFormats,
  metaCtaValues,
  launchpadVideoCreativeFormats,
} from "@/lib/launchpad-constants";
import {
  LaunchpadDestinationError,
  assertEligibleLaunchpadDestination,
  inspectLaunchpadDestinationForDryRun,
  listEligibleLaunchpadAdSets,
  listLaunchpadDestinationAccounts,
} from "@/lib/launchpad-destinations";
import {
  LaunchpadLedgerError,
  assertLivePublishSafety,
  assertLockedHashStable,
  computeRunAggregateStatus,
  createLaunchpadRunDraft,
  hashLaunchpadPayload,
  summarizeLaunchpadValidationIssues,
  type LaunchpadItemPayload,
  type LaunchpadRunDraft,
} from "@/lib/launchpad-ledger";
import {
  LaunchpadMetaPublishError,
  createMetaStaticCreative,
  createMetaVideoCreative,
  createPausedMetaAd,
  fetchMetaAdSnapshot,
  reconcileCreatedMetaAd,
  uploadMetaImageByUrl,
  uploadMetaVideoByUrl,
} from "@/lib/launchpad-meta-publish";
import { buildLaunchpadCloneDryRun } from "@/lib/launchpad-clone-planner";
import { buildLaunchpadPlannerOutput } from "@/lib/launchpad-planner";
import {
  LaunchpadSourceTemplateError,
  getApprovedLaunchpadSourceTemplateOrThrow,
  listApprovedLaunchpadSourceTemplates,
} from "@/lib/launchpad-source-templates";
import { ads } from "@/schema/ad";
import { adAccounts } from "@/schema/account";
import { adCreatives } from "@/schema/ad-creative";
import {
  launchpadPublishItems,
  launchpadPublishRuns,
} from "@/schema/launchpad";
import { router, internalWorkerProcedure, orgAdminProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import type { launchpadPublishTask } from "../../../../trigger/launchpad-publish";

const actorSchema = z
  .object({
    accountId: z.string().trim().min(1).optional(),
    accountMetaId: z.string().trim().min(1).optional(),
    facebookPageId: z.string().trim().min(1).optional(),
    instagramActorId: z.string().trim().min(1).optional(),
  })
  .optional();

const destinationSchema = z
  .object({
    adSetId: z.string().trim().min(1).optional(),
    adSetMetaId: z.string().trim().min(1).optional(),
  })
  .optional();

const launchpadDestinationAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  metaAccountId: z.string(),
  defaultFacebookPageId: z.string().nullable(),
  defaultInstagramActorId: z.string().nullable(),
  hasMetaAccessToken: z.boolean(),
  canPublish: z.boolean(),
  ineligibleReasons: z.array(
    z.enum(["missing_access_token", "missing_facebook_page_id"]),
  ),
});

const launchpadDestinationAdSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  metaId: z.string().nullable(),
  accountId: z.string().nullable(),
  status: z.string(),
  campaign: z.object({
    id: z.string(),
    name: z.string().nullable(),
    metaId: z.string().nullable(),
    status: z.string().nullable(),
  }),
});

const launchpadDestinationContextSchema = z.object({
  account: launchpadDestinationAccountSchema,
  adSet: launchpadDestinationAdSetSchema,
});

const createCloneDryRunInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
  sourceTemplateId: z.string().trim().min(1),
  launchName: z.string().trim().min(1),
  dailyBudgetMinorUnits: z.number().int().positive(),
  destinationUrl: z.string().trim().min(1),
  defaultPrimaryText: z.string().optional(),
  defaultHeadline: z.string().optional(),
  defaultCta: z.enum(metaCtaValues).optional(),
  creativeIds: z.array(z.string().trim().min(1)).min(1).max(LAUNCHPAD_MAX_ITEMS),
}).superRefine((input, ctx) => {
  const firstIndexByCreativeId = new Map<string, number>();

  input.creativeIds.forEach((creativeId, index) => {
    const firstIndex = firstIndexByCreativeId.get(creativeId);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["creativeIds", index],
        message: "Launchpad plans cannot include the same creative more than once",
        params: { firstIndex, duplicateIndex: index },
      });
      return;
    }

    firstIndexByCreativeId.set(creativeId, index);
  });
});

const createValidationRunInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
  actor: actorSchema,
  destination: destinationSchema,
  defaultDestinationUrl: z.string().trim().optional(),
  defaultPrimaryText: z.string().optional(),
  defaultCaption: z.string().optional(),
  defaultCta: z.string().trim().optional(),
  namingTemplate: z.string().optional(),
  items: z
    .array(
      z.object({
        creativeId: z.string().trim().min(1),
        adName: z.string().optional(),
        primaryText: z.string().optional(),
        caption: z.string().optional(),
        headline: z.string().optional(),
        destinationUrl: z.string().trim().optional(),
        cta: z.string().trim().optional(),
        requestedStatus: z.literal(PAUSED_META_STATUS).default(PAUSED_META_STATUS),
      }),
    )
    .min(1)
    .max(LAUNCHPAD_MAX_ITEMS),
}).superRefine((input, ctx) => {
  const firstIndexByCreativeId = new Map<string, number>();

  input.items.forEach((item, index) => {
    const creativeId = item.creativeId.trim();
    const firstIndex = firstIndexByCreativeId.get(creativeId);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "creativeId"],
        message: "Launchpad batches cannot include the same creative more than once",
        params: { firstIndex, duplicateIndex: index },
      });
      return;
    }

    firstIndexByCreativeId.set(creativeId, index);
  });
});

const launchpadAdminProcedure = orgAdminProcedure.use(async ({ next }) => {
  if (!isLaunchpadEnabled()) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Launchpad is not enabled",
    });
  }

  return next();
});

function asTrpcError(error: unknown): never {
  if (error instanceof LaunchpadLedgerError) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof LaunchpadDestinationError) {
    throw new TRPCError({
      code: error.code.endsWith("NOT_FOUND") ? "NOT_FOUND" : "PRECONDITION_FAILED",
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof LaunchpadSourceTemplateError) {
    throw new TRPCError({
      code: error.code.endsWith("NOT_FOUND") ? "NOT_FOUND" : "PRECONDITION_FAILED",
      message: error.message,
      cause: error,
    });
  }

  throw error;
}

type LaunchpadReader = Pick<typeof db, "select">;

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => !!value)));
}

function normalizedInputText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function throwReferenceNotFound(entityName: string, missingIds: string[]): never {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `${entityName} does not exist in this organization`,
    cause: { missingIds },
  });
}

function throwReferenceMismatch(
  entityName: string,
  expected: string,
  received: string,
): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${entityName} Meta ID does not match the org-owned record`,
    cause: { expected, received },
  });
}

function assertProvidedDestinationMetadataMatches(
  input: z.infer<typeof createValidationRunInputSchema>,
  context: Awaited<ReturnType<typeof assertEligibleLaunchpadDestination>>,
) {
  const providedAccountMetaId = input.actor?.accountMetaId;
  if (
    providedAccountMetaId &&
    providedAccountMetaId !== context.account.metaAccountId
  ) {
    throwReferenceMismatch(
      "Ad account",
      context.account.metaAccountId,
      providedAccountMetaId,
    );
  }

  const providedAdSetMetaId = input.destination?.adSetMetaId;
  if (providedAdSetMetaId && providedAdSetMetaId !== context.adSet.metaId) {
    throwReferenceMismatch("Ad set", context.adSet.metaId ?? "", providedAdSetMetaId);
  }
}

async function loadSingleLaunchpadCreative(
  client: LaunchpadReader,
  organizationId: string,
  creativeId: string,
) {
  const [creative] = await client
    .select({
      id: adCreatives.id,
      name: adCreatives.name,
      format: adCreatives.format,
      assetUrl: adCreatives.assetUrl,
      videoUrl: adCreatives.videoUrl,
      hook: adCreatives.hook,
      cta: adCreatives.cta,
    })
    .from(adCreatives)
    .where(
      and(
        eq(adCreatives.id, creativeId),
        eq(adCreatives.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!creative) {
    throwReferenceNotFound("Creative", [creativeId]);
  }

  return creative;
}

async function findExistingMetaAdConflicts(
  client: LaunchpadReader,
  organizationId: string,
  input: { creativeId: string; adSetId: string },
) {
  return client
    .select({ id: ads.id, name: ads.name, metaId: ads.metaId })
    .from(ads)
    .where(
      and(
        eq(ads.organizationId, organizationId),
        eq(ads.adCreativeId, input.creativeId),
        eq(ads.adSetId, input.adSetId),
        isNotNull(ads.metaId),
      ),
    )
    .limit(5);
}

type LaunchpadReplayCandidate = {
  idempotencyKey: string;
  dedupeKey: string;
  manifestHash: string;
  mode: string;
};

function assertReplayCompatible(
  existing: LaunchpadRunRow,
  candidate: LaunchpadReplayCandidate,
  source: "idempotency" | "dedupe",
) {
  if (
    existing.manifestHash !== candidate.manifestHash ||
    existing.mode !== candidate.mode
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        source === "idempotency"
          ? "Launchpad idempotency key was replayed with a different manifest or mode"
          : "Launchpad dedupe key matched a different manifest or mode",
      cause: {
        existingRunId: existing.id,
        existing: {
          manifestHash: existing.manifestHash,
          mode: existing.mode,
        },
        requested: {
          manifestHash: candidate.manifestHash,
          mode: candidate.mode,
        },
      },
    });
  }
}

async function findExistingRunForReplay(
  client: LaunchpadReader,
  organizationId: string,
  candidate: LaunchpadReplayCandidate,
) {
  const [sameIdempotencyRun] = await client
    .select()
    .from(launchpadPublishRuns)
    .where(
      and(
        eq(launchpadPublishRuns.organizationId, organizationId),
        eq(launchpadPublishRuns.idempotencyKey, candidate.idempotencyKey),
      ),
    )
    .limit(1);

  if (sameIdempotencyRun) {
    assertReplayCompatible(sameIdempotencyRun, candidate, "idempotency");
    return sameIdempotencyRun;
  }

  const [sameDedupeRun] = await client
    .select()
    .from(launchpadPublishRuns)
    .where(
      and(
        eq(launchpadPublishRuns.organizationId, organizationId),
        eq(launchpadPublishRuns.dedupeKey, candidate.dedupeKey),
      ),
    )
    .limit(1);

  if (sameDedupeRun) {
    assertReplayCompatible(sameDedupeRun, candidate, "dedupe");
  }

  return sameDedupeRun;
}

async function assertNoItemKeyConflicts(
  client: LaunchpadReader,
  organizationId: string,
  draft: LaunchpadRunDraft,
) {
  const itemIdempotencyKeys = uniqueStrings(
    draft.items.map((item) => item.idempotencyKey),
  );
  const itemDedupeKeys = uniqueStrings(draft.items.map((item) => item.dedupeKey));
  const conflictingItems = await client
    .select({
      id: launchpadPublishItems.id,
      idempotencyKey: launchpadPublishItems.idempotencyKey,
      dedupeKey: launchpadPublishItems.dedupeKey,
    })
    .from(launchpadPublishItems)
    .where(
      and(
        eq(launchpadPublishItems.organizationId, organizationId),
        or(
          inArray(launchpadPublishItems.idempotencyKey, itemIdempotencyKeys),
          inArray(launchpadPublishItems.dedupeKey, itemDedupeKeys),
        ),
      ),
    );

  if (conflictingItems.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Launchpad item idempotency or dedupe key collides with an existing item",
      cause: { itemIds: conflictingItems.map((item) => item.id) },
    });
  }
}

type LaunchpadWriter = Pick<typeof db, "select" | "insert" | "update">;
type LaunchpadRunRow = typeof launchpadPublishRuns.$inferSelect;
type LaunchpadItemRow = typeof launchpadPublishItems.$inferSelect;

type PublishFailureInput = {
  organizationId: string;
  runId: string;
  runItemCount: number;
  itemId: string;
  category: "retryable" | "terminal" | "ambiguous" | "manual_intervention";
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  reconciliationStatus?: "pending" | "checking" | "reconciled" | "mismatched" | "manual_intervention";
  manualInterventionReason?: string | null;
  rawMetaConfiguredStatus?: string | null;
  rawMetaEffectiveStatus?: string | null;
};

function manifestSafety(run: LaunchpadRunRow) {
  const manifest = run.manifest as { safety?: Record<string, unknown> } | null;
  return manifest?.safety ?? {};
}

function assertRunModePublishable(run: Pick<LaunchpadRunRow, "mode" | "manifest">) {
  const manifest = run.manifest as {
    kind?: unknown;
    launchMode?: unknown;
    mode?: unknown;
  } | null;

  if (
    run.mode === "clone_setup_validation" ||
    manifest?.mode === "clone_setup_validation" ||
    manifest?.launchMode === "clone_setup" ||
    manifest?.kind === "creative_launchpad.clone_setup_manifest"
  ) {
    throw new LaunchpadLedgerError(
      "CLONE_SETUP_DRY_RUN_NOT_PUBLISHABLE",
      "Launchpad clone setup dry-runs are validation previews only and cannot be promoted to live publishing",
    );
  }
}

function isTerminalRunStatus(status: string) {
  return [
    "success",
    "partial_success",
    "failed",
    "ambiguous",
    "skipped",
    "cancelled",
    "manual_intervention",
  ].includes(status);
}

function assertLaunchpadEnabledForWorker() {
  if (!isLaunchpadEnabled()) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Launchpad is not enabled",
    });
  }
}

function isLaunchpadVideoFormat(format: string | null | undefined) {
  return (launchpadVideoCreativeFormats as readonly string[]).includes(format ?? "");
}

function assertHttpsField(input: {
  value: string;
  field: "assetUrl" | "videoUrl" | "destinationUrl";
  label: string;
}) {
  let parsed: URL;
  try {
    parsed = new URL(input.value);
  } catch {
    throw new LaunchpadLedgerError(
      input.field === "destinationUrl"
        ? "INVALID_DESTINATION_URL"
        : input.field === "assetUrl"
          ? "INVALID_CREATIVE_ASSET_URL"
          : "INVALID_CREATIVE_VIDEO_URL",
      `${input.label} must be a valid HTTPS URL`,
      { [input.field]: input.value },
    );
  }

  if (parsed.protocol !== "https:") {
    throw new LaunchpadLedgerError(
      input.field === "destinationUrl"
        ? "INVALID_DESTINATION_URL"
        : input.field === "assetUrl"
          ? "INVALID_CREATIVE_ASSET_URL"
          : "INVALID_CREATIVE_VIDEO_URL",
      `${input.label} must use HTTPS`,
      { [input.field]: input.value, protocol: parsed.protocol },
    );
  }
}

function assertSupportedPublishPayload(payload: LaunchpadItemPayload) {
  const format = payload.creative.format;
  if (!(launchpadSupportedCreativeFormats as readonly string[]).includes(format ?? "")) {
    throw new LaunchpadLedgerError(
      "UNSUPPORTED_CREATIVE_FORMAT",
      "Launchpad live publishing supports static image and single-asset video/UGC creatives only",
      {
        format,
        creativeId: payload.creative.id,
        supportedFormats: launchpadSupportedCreativeFormats,
      },
    );
  }

  const destinationUrl = payload.launch.destinationUrl;
  if (!destinationUrl) {
    throw new LaunchpadLedgerError(
      "DESTINATION_URL_REQUIRED",
      "Launchpad publishing requires a destination URL",
    );
  }
  assertHttpsField({
    value: destinationUrl,
    field: "destinationUrl",
    label: "Destination URL",
  });

  if (format === "static") {
    const assetUrl = payload.creative.assetUrl;
    if (!assetUrl) {
      throw new LaunchpadLedgerError(
        "CREATIVE_ASSET_REQUIRED",
        "Static image publishing requires a creative asset URL",
        { creativeId: payload.creative.id },
      );
    }
    assertHttpsField({
      value: assetUrl,
      field: "assetUrl",
      label: "Static image asset URL",
    });
    return;
  }

  const videoUrl = payload.creative.videoUrl;
  if (!videoUrl) {
    throw new LaunchpadLedgerError(
      "CREATIVE_VIDEO_REQUIRED",
      "Video/UGC publishing requires a creative video URL",
      { creativeId: payload.creative.id, format },
    );
  }
  assertHttpsField({
    value: videoUrl,
    field: "videoUrl",
    label: "Video/UGC asset URL",
  });

  if (payload.creative.assetUrl) {
    assertHttpsField({
      value: payload.creative.assetUrl,
      field: "assetUrl",
      label: "Video/UGC thumbnail URL",
    });
  }
}

function assertRunReadyForPublish(run: LaunchpadRunRow) {
  assertRunModePublishable(run);
  assertLockedHashStable({
    label: "manifest",
    lockedHash: run.manifestHash,
    nextValue: run.manifest,
  });
  const safety = manifestSafety(run);

  assertLivePublishSafety({
    principalType: "session",
    orgRole: "admin",
    requestedStatus: run.requestedStatus,
    itemCount: run.itemCount,
    confirmationAccepted: true,
    previouslyValidatedManifest: Boolean(run.manifestLockedAt && run.validatedAt),
    campaignCreationRequested: safety.campaignCreationAllowed === true,
    adSetCreationRequested: safety.adSetCreationAllowed === true,
    activePublishingPathAvailable: true,
    env: process.env,
  });
}

function assertItemReadyForPublish(item: LaunchpadItemRow) {
  assertLockedHashStable({
    label: "payload",
    lockedHash: item.payloadHash,
    nextValue: item.payload,
  });

  if (!item.validatedAt) {
    throw new LaunchpadLedgerError(
      "VALIDATED_ITEM_REQUIRED",
      "Live Launchpad publishing requires a previously validated item payload",
      { itemId: item.id },
    );
  }

  if (item.requestedStatus !== PAUSED_META_STATUS) {
    throw new LaunchpadLedgerError(
      "ACTIVE_META_STATUS_FORBIDDEN",
      "Launchpad can only request PAUSED Meta ads",
      { requestedStatus: item.requestedStatus },
    );
  }

  if (!["validated", "queued", "publishing"].includes(item.status)) {
    throw new LaunchpadLedgerError(
      "VALIDATED_ITEM_REQUIRED",
      "Only validated Launchpad items can be promoted to live publishing",
      { itemId: item.id, status: item.status },
    );
  }

  assertSupportedPublishPayload(item.payload as LaunchpadItemPayload);
}

async function loadLaunchpadRunOrThrow(
  client: LaunchpadReader,
  organizationId: string,
  runId: string,
) {
  const [run] = await client
    .select()
    .from(launchpadPublishRuns)
    .where(
      and(
        eq(launchpadPublishRuns.id, runId),
        eq(launchpadPublishRuns.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!run) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Launchpad run not found" });
  }

  return run;
}

async function loadRunItems(
  client: LaunchpadReader,
  organizationId: string,
  runId: string,
) {
  return client
    .select()
    .from(launchpadPublishItems)
    .where(
      and(
        eq(launchpadPublishItems.runId, runId),
        eq(launchpadPublishItems.organizationId, organizationId),
      ),
    )
    .orderBy(launchpadPublishItems.position);
}

async function loadLaunchpadItemOrThrow(
  client: LaunchpadReader,
  organizationId: string,
  input: { runId: string; itemId: string },
) {
  const [item] = await client
    .select()
    .from(launchpadPublishItems)
    .where(
      and(
        eq(launchpadPublishItems.id, input.itemId),
        eq(launchpadPublishItems.runId, input.runId),
        eq(launchpadPublishItems.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!item) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Launchpad item not found" });
  }

  return item;
}

async function loadAccountAccessToken(
  client: LaunchpadReader,
  organizationId: string,
  accountId: string,
) {
  const [account] = await client
    .select({ metaAccessToken: adAccounts.metaAccessToken })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.id, accountId),
        eq(adAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!account?.metaAccessToken) {
    throw new LaunchpadDestinationError(
      "ACCOUNT_ACCESS_TOKEN_REQUIRED",
      "The selected Meta ad account needs a stored access token before publishing",
      { accountId },
    );
  }

  return account.metaAccessToken;
}

async function assertPublishDestinationStillEligible(
  client: LaunchpadReader,
  organizationId: string,
  run: LaunchpadRunRow,
) {
  if (!run.actorAccountId || !run.destinationAdSetId) {
    throw new LaunchpadDestinationError(
      "AD_SET_ID_REQUIRED",
      "A Launchpad publish requires a persisted destination account and ad set",
      {
        accountId: run.actorAccountId,
        adSetId: run.destinationAdSetId,
      },
    );
  }

  const destination = await assertEligibleLaunchpadDestination(client, organizationId, {
    accountId: run.actorAccountId,
    adSetId: run.destinationAdSetId,
  });
  const accessToken = await loadAccountAccessToken(
    client,
    organizationId,
    run.actorAccountId,
  );

  return { ...destination, accessToken };
}

async function resolveRunAggregateStatusAfterItem(
  client: LaunchpadWriter,
  input: {
    organizationId: string;
    runId: string;
    runItemCount: number;
    itemStatus: "success" | "failed" | "ambiguous" | "manual_intervention";
  },
) {
  if (input.runItemCount <= 1) return input.itemStatus;

  const rows = await client
    .select({ status: launchpadPublishItems.status })
    .from(launchpadPublishItems)
    .where(
      and(
        eq(launchpadPublishItems.runId, input.runId),
        eq(launchpadPublishItems.organizationId, input.organizationId),
      ),
    );

  if (rows.length === 0) return input.itemStatus;
  return computeRunAggregateStatus(rows.map((row) => row.status));
}

async function persistPublishFailure(
  client: LaunchpadWriter,
  input: PublishFailureInput,
) {
  const now = new Date();
  const status = input.category === "ambiguous"
    ? "ambiguous"
    : input.category === "manual_intervention"
      ? "manual_intervention"
      : "failed";
  const reconciliationStatus = input.reconciliationStatus
    ?? (input.category === "ambiguous" || input.category === "manual_intervention"
      ? "manual_intervention"
      : input.category === "terminal"
        ? "not_required"
        : "pending");

  await client
    .update(launchpadPublishItems)
    .set({
      status,
      errorCategory: input.category,
      errorCode: input.code,
      errorMessage: input.message,
      errorDetails: input.details ?? null,
      rawMetaConfiguredStatus: input.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: input.rawMetaEffectiveStatus,
      reconciliationStatus,
      reconciliationCheckedAt: input.reconciliationStatus ? now : undefined,
      manualInterventionReason: input.manualInterventionReason,
      completedAt: now,
    })
    .where(
      and(
        eq(launchpadPublishItems.id, input.itemId),
        eq(launchpadPublishItems.organizationId, input.organizationId),
      ),
    );

  const runStatus = await resolveRunAggregateStatusAfterItem(client, {
    organizationId: input.organizationId,
    runId: input.runId,
    runItemCount: input.runItemCount,
    itemStatus: status,
  });

  await client
    .update(launchpadPublishRuns)
    .set({
      status: runStatus,
      errorCategory: input.category,
      errorCode: input.code,
      errorMessage: input.message,
      errorDetails: input.details ?? null,
      reconciliationStatus,
      reconciliationCheckedAt: input.reconciliationStatus ? now : undefined,
      manualInterventionReason: input.manualInterventionReason,
      completedAt: isTerminalRunStatus(runStatus) ? now : undefined,
    })
    .where(
      and(
        eq(launchpadPublishRuns.id, input.runId),
        eq(launchpadPublishRuns.organizationId, input.organizationId),
      ),
    );

  return { status, runStatus, errorCode: input.code, errorCategory: input.category };
}

async function persistPublishEnqueueFailure(
  client: LaunchpadWriter,
  input: {
    organizationId: string;
    runId: string;
    itemIds: string[];
    code: string;
    message: string;
    details?: Record<string, unknown> | null;
  },
) {
  const now = new Date();
  await client
    .update(launchpadPublishItems)
    .set({
      status: "failed",
      errorCategory: "retryable",
      errorCode: input.code,
      errorMessage: input.message,
      errorDetails: input.details ?? null,
      reconciliationStatus: "pending",
      completedAt: now,
    })
    .where(
      and(
        inArray(launchpadPublishItems.id, input.itemIds),
        eq(launchpadPublishItems.organizationId, input.organizationId),
      ),
    );

  const itemStatuses = await client
    .select({ status: launchpadPublishItems.status })
    .from(launchpadPublishItems)
    .where(
      and(
        eq(launchpadPublishItems.runId, input.runId),
        eq(launchpadPublishItems.organizationId, input.organizationId),
      ),
    );
  const runStatus = itemStatuses.length > 0
    ? computeRunAggregateStatus(itemStatuses.map((item) => item.status))
    : "failed";

  await client
    .update(launchpadPublishRuns)
    .set({
      status: runStatus,
      errorCategory: "retryable",
      errorCode: input.code,
      errorMessage: input.message,
      errorDetails: input.details ?? null,
      reconciliationStatus: "pending",
      completedAt: isTerminalRunStatus(runStatus) ? now : undefined,
    })
    .where(
      and(
        eq(launchpadPublishRuns.id, input.runId),
        eq(launchpadPublishRuns.organizationId, input.organizationId),
      ),
    );

  return { status: runStatus, errorCode: input.code, errorCategory: "retryable" as const };
}

async function markPublishInProgress(
  client: LaunchpadWriter,
  organizationId: string,
  input: { runId: string; itemId: string },
) {
  const now = new Date();
  await client
    .update(launchpadPublishRuns)
    .set({
      status: "publishing",
      mode: "publish",
      startedAt: now,
      reconciliationStatus: "pending",
    })
    .where(
      and(
        eq(launchpadPublishRuns.id, input.runId),
        eq(launchpadPublishRuns.organizationId, organizationId),
      ),
    );
  await client
    .update(launchpadPublishItems)
    .set({
      status: "publishing",
      startedAt: now,
      reconciliationStatus: "pending",
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
      manualInterventionReason: null,
    })
    .where(
      and(
        eq(launchpadPublishItems.id, input.itemId),
        eq(launchpadPublishItems.organizationId, organizationId),
      ),
    );
}

async function ensureLocalPausedAd(
  client: LaunchpadWriter,
  organizationId: string,
  item: LaunchpadItemRow,
  payload: LaunchpadItemPayload,
) {
  if (item.localAdId) return item.localAdId;

  const [localAd] = await client
    .insert(ads)
    .values({
      name: item.requestedAdName ?? payload.launch.adName,
      adSetId: item.adSetId,
      adCreativeId: item.creativeId,
      accountId: item.accountId,
      caption: payload.launch.primaryText ?? payload.launch.caption,
      destinationUrl: payload.launch.destinationUrl,
      organizationId,
      status: "paused",
      metaImageHash: item.externalMetaImageHash,
      metaVideoId: item.externalMetaVideoId,
      metaCreativeId: item.externalMetaCreativeId,
      metaId: item.externalMetaAdId,
      rawMetaConfiguredStatus: item.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: item.rawMetaEffectiveStatus,
    })
    .returning({ id: ads.id });

  if (!localAd) {
    throw new LaunchpadLedgerError(
      "LOCAL_AD_CREATE_FAILED",
      "Launchpad could not create a local paused ad before publishing",
      { itemId: item.id },
    );
  }

  await client
    .update(launchpadPublishItems)
    .set({ localAdId: localAd.id })
    .where(
      and(
        eq(launchpadPublishItems.id, item.id),
        eq(launchpadPublishItems.organizationId, organizationId),
      ),
    );

  return localAd.id;
}

async function persistMetaIds(
  client: LaunchpadWriter,
  organizationId: string,
  input: {
    itemId: string;
    localAdId: string;
    imageHash?: string | null;
    videoId?: string | null;
    creativeId?: string | null;
    adId?: string | null;
    rawMetaConfiguredStatus?: string | null;
    rawMetaEffectiveStatus?: string | null;
  },
) {
  await client
    .update(launchpadPublishItems)
    .set({
      externalMetaImageHash: input.imageHash,
      externalMetaVideoId: input.videoId,
      externalMetaCreativeId: input.creativeId,
      externalMetaAdId: input.adId,
      rawMetaConfiguredStatus: input.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: input.rawMetaEffectiveStatus,
    })
    .where(
      and(
        eq(launchpadPublishItems.id, input.itemId),
        eq(launchpadPublishItems.organizationId, organizationId),
      ),
    );

  await client
    .update(ads)
    .set({
      metaImageHash: input.imageHash,
      metaVideoId: input.videoId,
      metaCreativeId: input.creativeId,
      metaId: input.adId,
      rawMetaConfiguredStatus: input.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: input.rawMetaEffectiveStatus,
      status: "paused",
    })
    .where(and(eq(ads.id, input.localAdId), eq(ads.organizationId, organizationId)));
}

function publishErrorInput(input: {
  organizationId: string;
  runId: string;
  runItemCount: number;
  itemId: string;
  error: LaunchpadMetaPublishError;
}): PublishFailureInput {
  return {
    organizationId: input.organizationId,
    runId: input.runId,
    runItemCount: input.runItemCount,
    itemId: input.itemId,
    category: input.error.category,
    code: input.error.code,
    message: input.error.message,
    details: input.error.details,
  };
}

function isRetryableFailedItem(item: LaunchpadItemRow) {
  return (
    item.status === "failed" &&
    item.errorCategory === "retryable" &&
    !item.externalMetaAdId
  );
}

function itemNeedsPreRetryReconciliation(item: LaunchpadItemRow) {
  return Boolean(
    item.externalMetaAdId ||
      item.status === "ambiguous" ||
      item.errorCategory === "ambiguous",
  );
}

function assertRunCanRetry(run: LaunchpadRunRow) {
  if (
    !["failed", "partial_success", "ambiguous", "manual_intervention"].includes(
      run.status,
    )
  ) {
    throw new LaunchpadLedgerError(
      "RETRY_REQUIRES_FAILED_OR_AMBIGUOUS_RUN",
      "Only failed, partially successful, ambiguous, or manual-intervention Launchpad runs can be retried",
      { runId: run.id, status: run.status },
    );
  }
}

function assertItemReadyForRetry(item: LaunchpadItemRow) {
  assertLockedHashStable({
    label: "payload",
    lockedHash: item.payloadHash,
    nextValue: item.payload,
  });

  if (!item.validatedAt) {
    throw new LaunchpadLedgerError(
      "VALIDATED_ITEM_REQUIRED",
      "Retrying Launchpad publishing requires a previously validated item payload",
      { itemId: item.id },
    );
  }

  if (item.requestedStatus !== PAUSED_META_STATUS) {
    throw new LaunchpadLedgerError(
      "ACTIVE_META_STATUS_FORBIDDEN",
      "Launchpad can only retry PAUSED Meta ads",
      { requestedStatus: item.requestedStatus },
    );
  }

  assertSupportedPublishPayload(item.payload as LaunchpadItemPayload);
}

async function persistManualIntervention(
  client: LaunchpadWriter,
  input: {
    organizationId: string;
    runId: string;
    runItemCount: number;
    itemId: string;
    code: string;
    message: string;
    reason: string;
    details?: Record<string, unknown> | null;
    rawMetaConfiguredStatus?: string | null;
    rawMetaEffectiveStatus?: string | null;
  },
) {
  return persistPublishFailure(client, {
    organizationId: input.organizationId,
    runId: input.runId,
    runItemCount: input.runItemCount,
    itemId: input.itemId,
    category: "manual_intervention",
    code: input.code,
    message: input.message,
    details: input.details,
    reconciliationStatus: "manual_intervention",
    manualInterventionReason: input.reason,
    rawMetaConfiguredStatus: input.rawMetaConfiguredStatus,
    rawMetaEffectiveStatus: input.rawMetaEffectiveStatus,
  });
}

async function persistReconciledSuccess(
  client: LaunchpadWriter,
  input: {
    organizationId: string;
    runId: string;
    runItemCount: number;
    itemId: string;
    localAdId: string;
    imageHash: string | null;
    videoId: string | null;
    creativeId: string;
    adId: string;
    rawMetaConfiguredStatus: string | null;
    rawMetaEffectiveStatus: string | null;
  },
) {
  const now = new Date();
  await client
    .update(launchpadPublishItems)
    .set({
      status: "success",
      localAdId: input.localAdId,
      externalMetaImageHash: input.imageHash,
      externalMetaVideoId: input.videoId,
      externalMetaCreativeId: input.creativeId,
      externalMetaAdId: input.adId,
      rawMetaConfiguredStatus: input.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: input.rawMetaEffectiveStatus,
      reconciliationStatus: "reconciled",
      reconciliationCheckedAt: now,
      completedAt: now,
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
      manualInterventionReason: null,
    })
    .where(
      and(
        eq(launchpadPublishItems.id, input.itemId),
        eq(launchpadPublishItems.organizationId, input.organizationId),
      ),
    );

  await client
    .update(ads)
    .set({
      metaImageHash: input.imageHash,
      metaVideoId: input.videoId,
      metaCreativeId: input.creativeId,
      metaId: input.adId,
      rawMetaConfiguredStatus: input.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: input.rawMetaEffectiveStatus,
      status: "paused",
    })
    .where(
      and(eq(ads.id, input.localAdId), eq(ads.organizationId, input.organizationId)),
    );

  const runStatus = await resolveRunAggregateStatusAfterItem(client, {
    organizationId: input.organizationId,
    runId: input.runId,
    runItemCount: input.runItemCount,
    itemStatus: "success",
  });
  await client
    .update(launchpadPublishRuns)
    .set({
      status: runStatus,
      reconciliationStatus: runStatus === "success"
        ? "reconciled"
        : ["ambiguous", "manual_intervention"].includes(runStatus)
          ? "manual_intervention"
          : "pending",
      reconciliationCheckedAt: runStatus === "success" ? now : undefined,
      completedAt: isTerminalRunStatus(runStatus) ? now : undefined,
      ...(runStatus === "success"
        ? {
            errorCategory: null,
            errorCode: null,
            errorMessage: null,
            errorDetails: null,
            manualInterventionReason: null,
          }
        : {}),
    })
    .where(
      and(
        eq(launchpadPublishRuns.id, input.runId),
        eq(launchpadPublishRuns.organizationId, input.organizationId),
      ),
    );

  return { status: "success" as const, runStatus };
}

async function reconcileItemWithSavedMetaAd(
  client: LaunchpadWriter,
  input: {
    organizationId: string;
    run: LaunchpadRunRow;
    item: LaunchpadItemRow;
    accessToken: string;
    expectedAdSetMetaId: string;
  },
) {
  const { item, run } = input;
  if (!item.externalMetaAdId) return null;

  if (!item.localAdId || !item.externalMetaCreativeId) {
    return persistManualIntervention(client, {
      organizationId: input.organizationId,
      runId: run.id,
      runItemCount: run.itemCount,
      itemId: item.id,
      code: "META_AD_RECONCILIATION_UNSAFE",
      message: "Saved Meta ad ID cannot be retried until its local ad and creative linkage are reconciled",
      reason: "Saved Meta ad ID exists without complete local ad or creative linkage",
      details: {
        hasLocalAdId: Boolean(item.localAdId),
        hasMetaCreativeId: Boolean(item.externalMetaCreativeId),
        hasMetaAdId: true,
      },
    });
  }

  const now = new Date();
  await client
    .update(launchpadPublishItems)
    .set({
      reconciliationStatus: "checking",
      reconciliationCheckedAt: now,
    })
    .where(
      and(
        eq(launchpadPublishItems.id, item.id),
        eq(launchpadPublishItems.organizationId, input.organizationId),
      ),
    );

  try {
    const snapshot = await fetchMetaAdSnapshot({
      adMetaId: item.externalMetaAdId,
      accessToken: input.accessToken,
    });
    const reconciliation = reconcileCreatedMetaAd({
      snapshot,
      expectedAdMetaId: item.externalMetaAdId,
      expectedAdSetMetaId: input.expectedAdSetMetaId,
      expectedCreativeMetaId: item.externalMetaCreativeId,
    });

    if (reconciliation.ok) {
      return persistReconciledSuccess(client, {
        organizationId: input.organizationId,
        runId: run.id,
        runItemCount: run.itemCount,
        itemId: item.id,
        localAdId: item.localAdId,
        imageHash: item.externalMetaImageHash,
        videoId: item.externalMetaVideoId,
        creativeId: item.externalMetaCreativeId,
        adId: item.externalMetaAdId,
        rawMetaConfiguredStatus: reconciliation.rawMetaConfiguredStatus,
        rawMetaEffectiveStatus: reconciliation.rawMetaEffectiveStatus,
      });
    }

    return persistManualIntervention(client, {
      organizationId: input.organizationId,
      runId: run.id,
      runItemCount: run.itemCount,
      itemId: item.id,
      code: "META_AD_RECONCILIATION_UNSAFE",
      message: "Saved Meta ad ID could not be reconciled as the expected paused ad",
      reason: reconciliation.failureReason ?? "Saved Meta ad did not match the frozen Launchpad payload",
      details: reconciliation.details,
      rawMetaConfiguredStatus: reconciliation.rawMetaConfiguredStatus,
      rawMetaEffectiveStatus: reconciliation.rawMetaEffectiveStatus,
    });
  } catch (error) {
    if (error instanceof LaunchpadMetaPublishError) {
      return persistManualIntervention(client, {
        organizationId: input.organizationId,
        runId: run.id,
        runItemCount: run.itemCount,
        itemId: item.id,
        code: "META_AD_RECONCILIATION_UNRESOLVED",
        message: "Saved Meta ad ID could not be reconciled before retry",
        reason: error.message,
        details: error.details,
      });
    }

    throw error;
  }
}

async function refreshRunAggregateStatus(
  client: LaunchpadWriter,
  organizationId: string,
  runId: string,
) {
  const rows = await client
    .select({ status: launchpadPublishItems.status })
    .from(launchpadPublishItems)
    .where(
      and(
        eq(launchpadPublishItems.runId, runId),
        eq(launchpadPublishItems.organizationId, organizationId),
      ),
    );
  const status = computeRunAggregateStatus(rows.map((row) => row.status));
  const now = new Date();
  await client
    .update(launchpadPublishRuns)
    .set({
      status,
      reconciliationStatus: ["ambiguous", "manual_intervention"].includes(status)
        ? "manual_intervention"
        : status === "success"
          ? "reconciled"
          : "pending",
      completedAt: isTerminalRunStatus(status) ? now : undefined,
    })
    .where(
      and(
        eq(launchpadPublishRuns.id, runId),
        eq(launchpadPublishRuns.organizationId, organizationId),
      ),
    );
  return status;
}

export const launchpadRouter = router({
  listSourceTemplates: launchpadAdminProcedure
    .meta(openApiQueryMeta("launchpad", "listSourceTemplates"))
    .query(async ({ ctx }) => {
      return listApprovedLaunchpadSourceTemplates(db, ctx.organizationId);
    }),

  createCloneDryRun: launchpadAdminProcedure
    .meta(openApiMutationMeta("launchpad", "createCloneDryRun"))
    .input(createCloneDryRunInputSchema)
    .mutation(async ({ input, ctx }) => {
      return db.transaction(async (tx) => {
        const sourceTemplate = await (async () => {
          try {
            return await getApprovedLaunchpadSourceTemplateOrThrow(
              tx,
              ctx.organizationId,
              input.sourceTemplateId,
            );
          } catch (error) {
            asTrpcError(error);
          }
        })();

        const creatives = [];
        for (const creativeId of input.creativeIds) {
          creatives.push(await loadSingleLaunchpadCreative(tx, ctx.organizationId, creativeId));
        }

        const dryRun = buildLaunchpadCloneDryRun({
          organizationId: ctx.organizationId,
          requestedBy: {
            userId: ctx.userId,
            principalType: ctx.principalType,
            orgRole: ctx.orgRole,
          },
          sourceTemplate,
          launch: {
            launchName: input.launchName,
            destinationUrl: input.destinationUrl,
            dailyBudgetMinorUnits: input.dailyBudgetMinorUnits,
            defaultPrimaryText: input.defaultPrimaryText,
            defaultHeadline: input.defaultHeadline,
            defaultCta: input.defaultCta,
          },
          creatives,
          idempotencyKey: input.idempotencyKey,
        });

        const cloneMode = "clone_setup_validation";
        const idempotencyKey = input.idempotencyKey ?? hashLaunchpadPayload({
          kind: "launchpad.clone_setup.dry_run.idempotency.v2",
          organizationId: ctx.organizationId,
          mode: cloneMode,
          manifestHash: dryRun.manifestHash,
        });
        const dedupeKey = hashLaunchpadPayload({
          kind: "launchpad.clone_setup.dry_run.dedupe.v2",
          organizationId: ctx.organizationId,
          mode: cloneMode,
          manifestHash: dryRun.manifestHash,
        });
        const replayCandidate = {
          idempotencyKey,
          dedupeKey,
          manifestHash: dryRun.manifestHash,
          mode: cloneMode,
        };

        const existing = await findExistingRunForReplay(
          tx,
          ctx.organizationId,
          replayCandidate,
        );
        if (existing) {
          return existing;
        }

        const now = new Date();
        const runError = dryRun.status === "failed"
          ? summarizeLaunchpadValidationIssues(dryRun.issues)
          : null;
        const [run] = await tx
          .insert(launchpadPublishRuns)
          .values({
            organizationId: ctx.organizationId,
            status: dryRun.status,
            mode: cloneMode,
            requestedStatus: PAUSED_META_STATUS,
            itemCount: dryRun.manifest.plannedAds.length,
            maxItemCap: LAUNCHPAD_MAX_ITEMS,
            manifest: dryRun.manifest,
            manifestHash: dryRun.manifestHash,
            idempotencyKey,
            dedupeKey,
            requestedByUserId: ctx.userId,
            requestedByPrincipalType: ctx.principalType,
            requestedByRole: ctx.orgRole,
            actorAccountId: sourceTemplate.account?.id ?? null,
            actorAccountMetaId: sourceTemplate.account?.metaAccountId ?? null,
            actorPageId: sourceTemplate.account?.defaultFacebookPageId ?? null,
            actorInstagramId: sourceTemplate.account?.defaultInstagramActorId ?? null,
            livePublishEnabledAtValidation: false,
            reconciliationStatus: "not_required",
            ...(runError
              ? {
                  errorCategory: runError.errorCategory,
                  errorCode: runError.errorCode,
                  errorMessage: runError.errorMessage,
                  errorDetails: runError.errorDetails,
                  completedAt: now,
                }
              : { validatedAt: now }),
          })
          .onConflictDoNothing()
          .returning();

        if (!run) {
          const replayed = await findExistingRunForReplay(
            tx,
            ctx.organizationId,
            replayCandidate,
          );

          if (replayed) {
            return replayed;
          }

          throw new TRPCError({
            code: "CONFLICT",
            message: "Launchpad clone dry-run conflicted but could not be reloaded",
          });
        }

        if (dryRun.manifest.plannedAds.length > 0) {
          const itemRows = dryRun.manifest.plannedAds.map((plannedAd) => ({
            runId: run.id,
            organizationId: ctx.organizationId,
            position: plannedAd.position,
            status: dryRun.status,
            requestedStatus: PAUSED_META_STATUS,
            creativeId: plannedAd.creative.id,
            accountId: sourceTemplate.account?.id ?? null,
            actorPageId: sourceTemplate.account?.defaultFacebookPageId ?? null,
            actorInstagramId: sourceTemplate.account?.defaultInstagramActorId ?? null,
            payload: plannedAd as unknown as Record<string, unknown>,
            payloadHash: plannedAd.payloadHash,
            idempotencyKey: hashLaunchpadPayload({
              kind: "launchpad.clone_setup.dry_run.item.idempotency.v2",
              organizationId: ctx.organizationId,
              mode: cloneMode,
              manifestHash: dryRun.manifestHash,
              plannedKey: plannedAd.plannedKey,
              payloadHash: plannedAd.payloadHash,
            }),
            dedupeKey: hashLaunchpadPayload({
              kind: "launchpad.clone_setup.dry_run.item.dedupe.v2",
              organizationId: ctx.organizationId,
              mode: cloneMode,
              manifestHash: dryRun.manifestHash,
              plannedKey: plannedAd.plannedKey,
              payloadHash: plannedAd.payloadHash,
            }),
            requestedAdName: plannedAd.name,
            createdByUserId: ctx.userId,
            createdByPrincipalType: ctx.principalType,
            createdByRole: ctx.orgRole,
            reconciliationStatus: "not_required" as const,
            ...(dryRun.status === "failed" && runError
              ? {
                  errorCategory: runError.errorCategory,
                  errorCode: runError.errorCode,
                  errorMessage: runError.errorMessage,
                  errorDetails: runError.errorDetails,
                  completedAt: now,
                }
              : { validatedAt: now }),
          }));
          const insertedItems = await tx
            .insert(launchpadPublishItems)
            .values(itemRows)
            .onConflictDoNothing()
            .returning({ id: launchpadPublishItems.id });

          if (insertedItems.length !== itemRows.length) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Launchpad item idempotency or dedupe key collides with an existing item",
            });
          }
        }

        return run;
      });
    }),

  destinationAccounts: launchpadAdminProcedure
    .meta(openApiQueryMeta("launchpad", "destinationAccounts"))
    .output(z.array(launchpadDestinationAccountSchema))
    .query(async ({ ctx }) => {
      return listLaunchpadDestinationAccounts(db, ctx.organizationId);
    }),

  eligibleAdSets: launchpadAdminProcedure
    .meta(openApiQueryMeta("launchpad", "eligibleAdSets"))
    .input(z.object({ accountId: z.string().trim().min(1) }))
    .output(z.array(launchpadDestinationAdSetSchema))
    .query(async ({ input, ctx }) => {
      try {
        return await listEligibleLaunchpadAdSets(
          db,
          ctx.organizationId,
          input.accountId,
        );
      } catch (error) {
        asTrpcError(error);
      }
    }),

  destinationContext: launchpadAdminProcedure
    .meta(openApiQueryMeta("launchpad", "destinationContext"))
    .input(
      z.object({
        accountId: z.string().trim().min(1),
        adSetId: z.string().trim().min(1),
      }),
    )
    .output(launchpadDestinationContextSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await assertEligibleLaunchpadDestination(
          db,
          ctx.organizationId,
          input,
        );
      } catch (error) {
        asTrpcError(error);
      }
    }),

  list: launchpadAdminProcedure
    .meta(openApiQueryMeta("launchpad", "list"))
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }).optional())
    .query(async ({ input, ctx }) => {
      return db
        .select({
          id: launchpadPublishRuns.id,
          status: launchpadPublishRuns.status,
          mode: launchpadPublishRuns.mode,
          requestedStatus: launchpadPublishRuns.requestedStatus,
          itemCount: launchpadPublishRuns.itemCount,
          maxItemCap: launchpadPublishRuns.maxItemCap,
          manifestHash: launchpadPublishRuns.manifestHash,
          idempotencyKey: launchpadPublishRuns.idempotencyKey,
          actorAccountId: launchpadPublishRuns.actorAccountId,
          actorAccountMetaId: launchpadPublishRuns.actorAccountMetaId,
          actorPageId: launchpadPublishRuns.actorPageId,
          destinationAdSetId: launchpadPublishRuns.destinationAdSetId,
          destinationAdSetMetaId: launchpadPublishRuns.destinationAdSetMetaId,
          livePublishEnabledAtValidation:
            launchpadPublishRuns.livePublishEnabledAtValidation,
          retryCount: launchpadPublishRuns.retryCount,
          lastRetryRequestedAt: launchpadPublishRuns.lastRetryRequestedAt,
          reconciliationStatus: launchpadPublishRuns.reconciliationStatus,
          errorCategory: launchpadPublishRuns.errorCategory,
          errorCode: launchpadPublishRuns.errorCode,
          errorMessage: launchpadPublishRuns.errorMessage,
          validatedAt: launchpadPublishRuns.validatedAt,
          createdAt: launchpadPublishRuns.createdAt,
          updatedAt: launchpadPublishRuns.updatedAt,
        })
        .from(launchpadPublishRuns)
        .where(eq(launchpadPublishRuns.organizationId, ctx.organizationId))
        .orderBy(desc(launchpadPublishRuns.createdAt))
        .limit(input?.limit ?? 25);
    }),

  getById: launchpadAdminProcedure
    .meta(openApiQueryMeta("launchpad", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [run] = await db
        .select()
        .from(launchpadPublishRuns)
        .where(
          and(
            eq(launchpadPublishRuns.id, input.id),
            eq(launchpadPublishRuns.organizationId, ctx.organizationId),
          ),
        );

      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Launchpad run not found" });
      }

      const itemRows = await db
        .select({
          item: launchpadPublishItems,
          localAd: {
            id: ads.id,
            name: ads.name,
            status: ads.status,
            metaId: ads.metaId,
            metaVideoId: ads.metaVideoId,
            destinationUrl: ads.destinationUrl,
            rawMetaConfiguredStatus: ads.rawMetaConfiguredStatus,
            rawMetaEffectiveStatus: ads.rawMetaEffectiveStatus,
          },
        })
        .from(launchpadPublishItems)
        .leftJoin(
          ads,
          and(
            eq(launchpadPublishItems.localAdId, ads.id),
            eq(ads.organizationId, ctx.organizationId),
          ),
        )
        .where(
          and(
            eq(launchpadPublishItems.runId, run.id),
            eq(launchpadPublishItems.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(launchpadPublishItems.position);

      const items = itemRows.map((row) => ({
        ...row.item,
        localAd: row.localAd?.id ? row.localAd : null,
      }));

      return { run, items };
    }),

  createValidationRun: launchpadAdminProcedure
    .meta(openApiMutationMeta("launchpad", "createValidationRun"))
    .input(createValidationRunInputSchema)
    .mutation(async ({ input, ctx }) => {
      return db.transaction(async (tx) => {
        const destinationContext = await (async () => {
          try {
            return await inspectLaunchpadDestinationForDryRun(
              tx,
              ctx.organizationId,
              {
                accountId: input.actor?.accountId,
                adSetId: input.destination?.adSetId,
              },
            );
          } catch (error) {
            asTrpcError(error);
          }
        })();
        assertProvidedDestinationMetadataMatches(input, destinationContext);

        const plannerOutputs = [];
        for (const [index, itemInput] of input.items.entries()) {
          const creative = await loadSingleLaunchpadCreative(
            tx,
            ctx.organizationId,
            itemInput.creativeId,
          );
          const existingMetaAdConflicts = await findExistingMetaAdConflicts(
            tx,
            ctx.organizationId,
            {
              creativeId: creative.id,
              adSetId: destinationContext.adSet.id,
            },
          );

          plannerOutputs.push(buildLaunchpadPlannerOutput({
            organizationId: ctx.organizationId,
            requestedBy: {
              userId: ctx.userId,
              principalType: ctx.principalType,
              orgRole: ctx.orgRole,
            },
            destination: {
              account: destinationContext.account,
              adSet: destinationContext.adSet,
              issues: destinationContext.issues,
            },
            creative,
            itemPosition: index + 1,
            launch: {
              defaultDestinationUrl: input.defaultDestinationUrl,
              destinationUrlOverride: itemInput.destinationUrl,
              primaryText:
                normalizedInputText(itemInput.primaryText) ?? input.defaultPrimaryText,
              caption: normalizedInputText(itemInput.caption) ?? input.defaultCaption,
              headline: itemInput.headline,
              cta: normalizedInputText(itemInput.cta) ?? input.defaultCta,
              adName: itemInput.adName,
              namingTemplate: input.namingTemplate,
            },
            existingMetaAdConflicts,
            idempotencyKey: input.idempotencyKey,
            env: process.env,
          }));
        }

        const aggregateIssues = plannerOutputs.flatMap((output) => output.issues);
        const normalizedItems = plannerOutputs.flatMap((output, index) => {
          const manifest = output.normalizedManifest as {
            items?: Array<Record<string, unknown>>;
          };
          return (manifest.items ?? []).map((item) => ({
            ...item,
            position: index + 1,
          }));
        });
        const firstPlannerOutput = plannerOutputs[0]!;
        const combinedPlannerManifest = {
          ...firstPlannerOutput.normalizedManifest,
          itemCount: normalizedItems.length,
          maxItemCap: LAUNCHPAD_MAX_ITEMS,
          batchDefaults: {
            destinationUrl: input.defaultDestinationUrl ?? null,
            primaryText: input.defaultPrimaryText ?? null,
            caption: input.defaultCaption ?? null,
            cta: input.defaultCta ?? null,
            namingTemplate: input.namingTemplate ?? null,
            requiredUtmParameters: ["utm_source", "utm_medium"],
          },
          items: normalizedItems,
          validation: {
            status: aggregateIssues.length > 0 ? "failed" : "passed",
            issueCount: aggregateIssues.length,
            issues: aggregateIssues,
          },
        };

        const draft = (() => {
          try {
            return createLaunchpadRunDraft({
              ...firstPlannerOutput.runDraftInput,
              plannerManifest: combinedPlannerManifest,
              validationIssues: aggregateIssues,
              items: plannerOutputs.map((output) => output.runDraftInput.items[0]!),
              idempotencyKey: input.idempotencyKey,
            });
          } catch (error) {
            asTrpcError(error);
          }
        })();

        const replayCandidate = {
          idempotencyKey: draft.idempotencyKey,
          dedupeKey: draft.dedupeKey,
          manifestHash: draft.manifestHash,
          mode: "validation",
        };
        const existingRun = await findExistingRunForReplay(
          tx,
          ctx.organizationId,
          replayCandidate,
        );
        if (existingRun) {
          return existingRun;
        }

        await assertNoItemKeyConflicts(tx, ctx.organizationId, draft);

        const now = new Date();
        const runError = summarizeLaunchpadValidationIssues(draft.validationIssues);
        const [run] = await tx
          .insert(launchpadPublishRuns)
          .values({
            organizationId: ctx.organizationId,
            status: draft.status,
            mode: "validation",
            requestedStatus: PAUSED_META_STATUS,
            itemCount: draft.items.length,
            maxItemCap: LAUNCHPAD_MAX_ITEMS,
            manifest: draft.manifest,
            manifestHash: draft.manifestHash,
            idempotencyKey: draft.idempotencyKey,
            dedupeKey: draft.dedupeKey,
            requestedByUserId: ctx.userId,
            requestedByPrincipalType: ctx.principalType,
            requestedByRole: ctx.orgRole,
            actorAccountId: draft.manifest.actor.accountId,
            actorAccountMetaId: draft.manifest.actor.accountMetaId,
            actorPageId: draft.manifest.actor.facebookPageId,
            actorInstagramId: draft.manifest.actor.instagramActorId,
            destinationAdSetId: draft.manifest.destination.adSetId,
            destinationAdSetMetaId: draft.manifest.destination.adSetMetaId,
            livePublishEnabledAtValidation:
              draft.manifest.safety.livePublishEnabled,
            reconciliationStatus: "not_required",
            ...(runError
              ? {
                  errorCategory: runError.errorCategory,
                  errorCode: runError.errorCode,
                  errorMessage: runError.errorMessage,
                  errorDetails: runError.errorDetails,
                  completedAt: now,
                }
              : { validatedAt: now }),
          })
          .onConflictDoNothing()
          .returning();

        if (!run) {
          const existing = await findExistingRunForReplay(
            tx,
            ctx.organizationId,
            replayCandidate,
          );

          if (existing) {
            return existing;
          }

          throw new TRPCError({
            code: "CONFLICT",
            message: "Launchpad run conflicted but could not be reloaded",
          });
        }

        const insertedItems = await tx
          .insert(launchpadPublishItems)
          .values(
            draft.items.map((item) => {
              const itemError = summarizeLaunchpadValidationIssues(
                item.validationIssues,
              );

              return {
                runId: run.id,
                organizationId: ctx.organizationId,
                position: item.position,
                status: item.status,
                requestedStatus: item.requestedStatus,
                creativeId: item.creativeId,
                accountId: draft.manifest.actor.accountId,
                adSetId: draft.manifest.destination.adSetId,
                actorPageId: draft.manifest.actor.facebookPageId,
                actorInstagramId: draft.manifest.actor.instagramActorId,
                payload: item.payload,
                payloadHash: item.payloadHash,
                idempotencyKey: item.idempotencyKey,
                dedupeKey: item.dedupeKey,
                requestedAdName: item.adName,
                createdByUserId: ctx.userId,
                createdByPrincipalType: ctx.principalType,
                createdByRole: ctx.orgRole,
                reconciliationStatus: "not_required" as const,
                ...(itemError
                  ? {
                      errorCategory: itemError.errorCategory,
                      errorCode: itemError.errorCode,
                      errorMessage: itemError.errorMessage,
                      errorDetails: itemError.errorDetails,
                      completedAt: now,
                    }
                  : { validatedAt: now }),
              };
            }),
          )
          .onConflictDoNothing()
          .returning({ id: launchpadPublishItems.id });

        if (insertedItems.length !== draft.items.length) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Launchpad item idempotency or dedupe key collides with an existing item",
          });
        }

        return run;
      });
    }),

  requestLivePublish: launchpadAdminProcedure
    .meta(openApiMutationMeta("launchpad", "requestLivePublish"))
    .input(
      z.object({
        runId: z.string(),
        confirmation: z.literal("PUBLISH_PAUSED_META_ADS"),
        requestedStatus: z.literal(PAUSED_META_STATUS).default(PAUSED_META_STATUS),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const run = await loadLaunchpadRunOrThrow(
        db,
        ctx.organizationId,
        input.runId,
      );

      try {
        assertRunModePublishable(run);
        assertLockedHashStable({
          label: "manifest",
          lockedHash: run.manifestHash,
          nextValue: run.manifest,
        });
        const safety = manifestSafety(run);
        assertLivePublishSafety({
          principalType: ctx.principalType,
          orgRole: ctx.orgRole,
          requestedStatus: input.requestedStatus,
          itemCount: run.itemCount,
          confirmationAccepted: input.confirmation === "PUBLISH_PAUSED_META_ADS",
          previouslyValidatedManifest:
            run.status === "validated" && !!run.manifestLockedAt && !!run.validatedAt,
          campaignCreationRequested: safety.campaignCreationAllowed === true,
          adSetCreationRequested: safety.adSetCreationAllowed === true,
          activePublishingPathAvailable: true,
          env: process.env,
        });

        if (run.requestedStatus !== PAUSED_META_STATUS) {
          throw new LaunchpadLedgerError(
            "ACTIVE_META_STATUS_FORBIDDEN",
            "Launchpad can only request PAUSED Meta ads",
            { requestedStatus: run.requestedStatus },
          );
        }
      } catch (error) {
        asTrpcError(error);
      }

      const items = await loadRunItems(db, ctx.organizationId, run.id);
      if (items.length !== run.itemCount) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Launchpad run item count does not match its persisted items",
          cause: { expected: run.itemCount, actual: items.length },
        });
      }
      const itemIds = items.map((item) => item.id);

      try {
        for (const item of items) {
          if (item.status !== "validated") {
            throw new LaunchpadLedgerError(
              "VALIDATED_ITEM_REQUIRED",
              "Only validated Launchpad items can be promoted to live publishing",
              { itemId: item.id, status: item.status },
            );
          }
          assertItemReadyForPublish(item);
        }
        await assertPublishDestinationStillEligible(db, ctx.organizationId, run);
      } catch (error) {
        asTrpcError(error);
      }

      const now = new Date();
      await db
        .update(launchpadPublishRuns)
        .set({
          status: "queued",
          mode: "publish",
          queuedAt: now,
          reconciliationStatus: "pending",
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          manualInterventionReason: null,
        })
        .where(
          and(
            eq(launchpadPublishRuns.id, run.id),
            eq(launchpadPublishRuns.organizationId, ctx.organizationId),
          ),
        );
      await db
        .update(launchpadPublishItems)
        .set({
          status: "queued",
          queuedAt: now,
          reconciliationStatus: "pending",
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          manualInterventionReason: null,
        })
        .where(
          and(
            inArray(launchpadPublishItems.id, itemIds),
            eq(launchpadPublishItems.organizationId, ctx.organizationId),
          ),
        );

      let handle: { id: string };
      try {
        handle = await tasks.trigger<typeof launchpadPublishTask>(
          "launchpad-publish",
          {
            organizationId: ctx.organizationId,
            runId: run.id,
            itemIds,
            requestedStatus: PAUSED_META_STATUS,
          },
        );
      } catch (error) {
        await persistPublishEnqueueFailure(db, {
          organizationId: ctx.organizationId,
          runId: run.id,
          itemIds,
          code: "TRIGGER_ENQUEUE_FAILED",
          message: "Launchpad publish task could not be enqueued",
          details: {
            errorName: error instanceof Error ? error.name : undefined,
          },
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Launchpad publish task could not be enqueued",
        });
      }

      await db
        .update(launchpadPublishRuns)
        .set({ externalTriggerRunId: handle.id })
        .where(
          and(
            eq(launchpadPublishRuns.id, run.id),
            eq(launchpadPublishRuns.organizationId, ctx.organizationId),
          ),
        );

      return {
        runId: run.id,
        itemIds,
        triggerRunId: handle.id,
        status: "queued" as const,
      };
    }),

  retryFailedItems: launchpadAdminProcedure
    .meta(openApiMutationMeta("launchpad", "retryFailedItems"))
    .input(
      z.object({
        runId: z.string(),
        confirmation: z.literal("RETRY_FAILED_LAUNCHPAD_ITEMS"),
        requestedStatus: z.literal(PAUSED_META_STATUS).default(PAUSED_META_STATUS),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const run = await loadLaunchpadRunOrThrow(
        db,
        ctx.organizationId,
        input.runId,
      );

      try {
        assertLockedHashStable({
          label: "manifest",
          lockedHash: run.manifestHash,
          nextValue: run.manifest,
        });
        assertRunCanRetry(run);
        const safety = manifestSafety(run);
        assertLivePublishSafety({
          principalType: ctx.principalType,
          orgRole: ctx.orgRole,
          requestedStatus: input.requestedStatus,
          itemCount: run.itemCount,
          confirmationAccepted: input.confirmation === "RETRY_FAILED_LAUNCHPAD_ITEMS",
          previouslyValidatedManifest: Boolean(run.manifestLockedAt && run.validatedAt),
          campaignCreationRequested: safety.campaignCreationAllowed === true,
          adSetCreationRequested: safety.adSetCreationAllowed === true,
          activePublishingPathAvailable: true,
          env: process.env,
        });

        if (run.requestedStatus !== PAUSED_META_STATUS) {
          throw new LaunchpadLedgerError(
            "ACTIVE_META_STATUS_FORBIDDEN",
            "Launchpad can only retry PAUSED Meta ads",
            { requestedStatus: run.requestedStatus },
          );
        }
      } catch (error) {
        asTrpcError(error);
      }

      const items = await loadRunItems(db, ctx.organizationId, run.id);
      if (items.length !== run.itemCount) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Launchpad run item count does not match its persisted items",
          cause: { expected: run.itemCount, actual: items.length },
        });
      }

      let destination: Awaited<ReturnType<typeof assertPublishDestinationStillEligible>>;
      try {
        destination = await assertPublishDestinationStillEligible(
          db,
          ctx.organizationId,
          run,
        );
      } catch (error) {
        asTrpcError(error);
      }

      const reconciledItemIds: string[] = [];
      const manualInterventionItemIds: string[] = [];
      for (const item of items) {
        if (["success", "skipped", "cancelled"].includes(item.status)) {
          continue;
        }

        if (item.errorCategory === "terminal") {
          continue;
        }

        if (item.externalMetaAdId) {
          const result = await reconcileItemWithSavedMetaAd(db, {
            organizationId: ctx.organizationId,
            run,
            item,
            accessToken: destination.accessToken,
            expectedAdSetMetaId: destination.adSet.metaId!,
          });
          if (result?.status === "success") {
            reconciledItemIds.push(item.id);
          } else if (result) {
            manualInterventionItemIds.push(item.id);
          }
          continue;
        }

        if (itemNeedsPreRetryReconciliation(item)) {
          await persistManualIntervention(db, {
            organizationId: ctx.organizationId,
            runId: run.id,
            runItemCount: run.itemCount,
            itemId: item.id,
            code: "META_AD_CREATE_UNRESOLVED",
            message: "Ambiguous Meta ad creation has no saved Meta ad ID and cannot be retried safely",
            reason:
              "Inspect Meta Ads Manager before deciding whether a Launchpad retry would duplicate an ad",
            details: {
              previousStatus: item.status,
              previousErrorCategory: item.errorCategory,
              previousErrorCode: item.errorCode,
            },
          });
          manualInterventionItemIds.push(item.id);
        }
      }

      const refreshedItems = await loadRunItems(db, ctx.organizationId, run.id);
      const retryableItems = refreshedItems.filter(isRetryableFailedItem);
      const retryableItemIdSet = new Set(retryableItems.map((item) => item.id));
      const skippedItemIds = refreshedItems
        .filter((item) => !retryableItemIdSet.has(item.id))
        .map((item) => item.id);

      for (const item of retryableItems) {
        try {
          assertItemReadyForRetry(item);
        } catch (error) {
          asTrpcError(error);
        }
      }

      if (retryableItems.length === 0) {
        const status = await refreshRunAggregateStatus(
          db,
          ctx.organizationId,
          run.id,
        );
        return {
          runId: run.id,
          itemIds: [] as string[],
          skippedItemIds,
          reconciledItemIds,
          manualInterventionItemIds,
          triggerRunId: null,
          status,
          queued: false,
        };
      }

      const now = new Date();
      const itemIds = retryableItems.map((item) => item.id);
      await db
        .update(launchpadPublishRuns)
        .set({
          status: "queued",
          mode: "publish",
          queuedAt: now,
          completedAt: null,
          reconciliationStatus: "pending",
          retryCount: sql`${launchpadPublishRuns.retryCount} + 1`,
          lastRetryRequestedAt: now,
          lastRetryRequestedByUserId: ctx.userId,
          lastRetryRequestedByPrincipalType: ctx.principalType,
          lastRetryRequestedByRole: ctx.orgRole,
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          manualInterventionReason: null,
        })
        .where(
          and(
            eq(launchpadPublishRuns.id, run.id),
            eq(launchpadPublishRuns.organizationId, ctx.organizationId),
          ),
        );
      await db
        .update(launchpadPublishItems)
        .set({
          status: "queued",
          queuedAt: now,
          startedAt: null,
          completedAt: null,
          reconciliationStatus: "pending",
          retryCount: sql`${launchpadPublishItems.retryCount} + 1`,
          lastRetryRequestedAt: now,
          lastRetryRequestedByUserId: ctx.userId,
          lastRetryRequestedByPrincipalType: ctx.principalType,
          lastRetryRequestedByRole: ctx.orgRole,
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          manualInterventionReason: null,
        })
        .where(
          and(
            inArray(launchpadPublishItems.id, itemIds),
            eq(launchpadPublishItems.organizationId, ctx.organizationId),
          ),
        );

      let handle: { id: string };
      try {
        handle = await tasks.trigger<typeof launchpadPublishTask>(
          "launchpad-publish",
          {
            organizationId: ctx.organizationId,
            runId: run.id,
            itemIds,
            requestedStatus: PAUSED_META_STATUS,
          },
        );
      } catch (error) {
        await persistPublishEnqueueFailure(db, {
          organizationId: ctx.organizationId,
          runId: run.id,
          itemIds,
          code: "TRIGGER_RETRY_ENQUEUE_FAILED",
          message: "Launchpad retry task could not be enqueued",
          details: {
            errorName: error instanceof Error ? error.name : undefined,
          },
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Launchpad retry task could not be enqueued",
        });
      }

      await db
        .update(launchpadPublishRuns)
        .set({ externalTriggerRunId: handle.id })
        .where(
          and(
            eq(launchpadPublishRuns.id, run.id),
            eq(launchpadPublishRuns.organizationId, ctx.organizationId),
          ),
        );

      return {
        runId: run.id,
        itemIds,
        skippedItemIds,
        reconciledItemIds,
        manualInterventionItemIds,
        triggerRunId: handle.id,
        status: "queued" as const,
        queued: true,
      };
    }),

  markItemManualIntervention: launchpadAdminProcedure
    .meta(openApiMutationMeta("launchpad", "markItemManualIntervention"))
    .input(
      z.object({
        runId: z.string(),
        itemId: z.string(),
        reason: z.string().trim().min(3).max(1000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const run = await loadLaunchpadRunOrThrow(
        db,
        ctx.organizationId,
        input.runId,
      );
      const item = await loadLaunchpadItemOrThrow(db, ctx.organizationId, input);

      if (item.status === "success" && item.externalMetaAdId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Successful Launchpad items with Meta IDs cannot be moved to manual intervention",
        });
      }

      const result = await persistManualIntervention(db, {
        organizationId: ctx.organizationId,
        runId: run.id,
        runItemCount: run.itemCount,
        itemId: item.id,
        code: "MANUAL_INTERVENTION_MARKED",
        message: "Launchpad item was moved to manual intervention by an authorized user",
        reason: input.reason,
        details: {
          previousStatus: item.status,
          previousErrorCategory: item.errorCategory,
          previousErrorCode: item.errorCode,
          markedByUserId: ctx.userId,
          markedByRole: ctx.orgRole,
        },
      });

      return {
        runId: run.id,
        itemId: item.id,
        status: result.status,
        runStatus: result.runStatus,
      };
    }),

  workerExecuteLivePublish: internalWorkerProcedure
    .input(
      z.object({
        runId: z.string(),
        itemId: z.string(),
        requestedStatus: z.literal(PAUSED_META_STATUS).default(PAUSED_META_STATUS),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertLaunchpadEnabledForWorker();
      if (!ctx.organizationId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Worker publish execution requires an organization scope",
        });
      }

      const organizationId = ctx.organizationId;
      const run = await loadLaunchpadRunOrThrow(db, organizationId, input.runId);
      const item = await loadLaunchpadItemOrThrow(db, organizationId, input);

      if (item.status === "success" && item.localAdId && item.externalMetaAdId) {
        return {
          status: "success" as const,
          runStatus: run.status,
          replayed: true,
          runId: run.id,
          itemId: item.id,
          localAdId: item.localAdId,
          metaImageHash: item.externalMetaImageHash,
          metaVideoId: item.externalMetaVideoId,
          metaCreativeId: item.externalMetaCreativeId,
          metaAdId: item.externalMetaAdId,
          rawMetaConfiguredStatus: item.rawMetaConfiguredStatus,
          rawMetaEffectiveStatus: item.rawMetaEffectiveStatus,
        };
      }

      let destination: Awaited<ReturnType<typeof assertPublishDestinationStillEligible>>;
      try {
        if (!["queued", "publishing"].includes(run.status)) {
          throw new LaunchpadLedgerError(
            "QUEUED_PUBLISH_REQUIRED",
            "Launchpad live publishing must be started from a queued durable intent",
            { runId: run.id, status: run.status },
          );
        }
        if (!["queued", "publishing"].includes(item.status)) {
          throw new LaunchpadLedgerError(
            "QUEUED_PUBLISH_REQUIRED",
            "Launchpad live publishing item must be queued before worker execution",
            { itemId: item.id, status: item.status },
          );
        }
        if (input.requestedStatus !== PAUSED_META_STATUS) {
          throw new LaunchpadLedgerError(
            "ACTIVE_META_STATUS_FORBIDDEN",
            "Launchpad can only request PAUSED Meta ads",
            { requestedStatus: input.requestedStatus },
          );
        }
        assertRunReadyForPublish(run);
        assertItemReadyForPublish(item);
        destination = await assertPublishDestinationStillEligible(
          db,
          organizationId,
          run,
        );
      } catch (error) {
        asTrpcError(error);
      }

      const payload = item.payload as LaunchpadItemPayload;
      let localAdId = item.localAdId;
      let imageHash = item.externalMetaImageHash;
      let videoId = item.externalMetaVideoId;
      let metaCreativeId = item.externalMetaCreativeId;
      let metaAdId = item.externalMetaAdId;
      const isVideoPayload = isLaunchpadVideoFormat(payload.creative.format);

      try {
        await markPublishInProgress(db, organizationId, {
          runId: run.id,
          itemId: item.id,
        });

        localAdId = await ensureLocalPausedAd(db, organizationId, item, payload);

        if (isVideoPayload) {
          if (!videoId) {
            const videoResult = await uploadMetaVideoByUrl({
              metaAccountId: destination.account.metaAccountId,
              accessToken: destination.accessToken,
              sourceUrl: payload.creative.videoUrl!,
              videoName: `${payload.launch.adName} / Video`,
            });
            videoId = videoResult.videoId;
            await persistMetaIds(db, organizationId, {
              itemId: item.id,
              localAdId,
              imageHash,
              videoId,
              creativeId: metaCreativeId,
              adId: metaAdId,
            });
          }

          if (!metaCreativeId) {
            const creativeResult = await createMetaVideoCreative({
              metaAccountId: destination.account.metaAccountId,
              accessToken: destination.accessToken,
              creativeName: `${payload.launch.adName} / Creative`,
              pageId: destination.account.defaultFacebookPageId!,
              instagramActorId: destination.account.defaultInstagramActorId,
              videoId,
              thumbnailUrl: payload.creative.assetUrl,
              destinationUrl: payload.launch.destinationUrl!,
              primaryText: payload.launch.primaryText,
              headline: payload.launch.headline,
              cta: payload.launch.cta,
            });
            metaCreativeId = creativeResult.creativeId;
            await persistMetaIds(db, organizationId, {
              itemId: item.id,
              localAdId,
              imageHash,
              videoId,
              creativeId: metaCreativeId,
              adId: metaAdId,
            });
          }
        } else {
          if (!imageHash) {
            const imageResult = await uploadMetaImageByUrl({
              metaAccountId: destination.account.metaAccountId,
              accessToken: destination.accessToken,
              sourceUrl: payload.creative.assetUrl!,
            });
            imageHash = imageResult.imageHash;
            await persistMetaIds(db, organizationId, {
              itemId: item.id,
              localAdId,
              imageHash,
              videoId,
              creativeId: metaCreativeId,
              adId: metaAdId,
            });
          }

          if (!metaCreativeId) {
            const creativeResult = await createMetaStaticCreative({
              metaAccountId: destination.account.metaAccountId,
              accessToken: destination.accessToken,
              creativeName: `${payload.launch.adName} / Creative`,
              pageId: destination.account.defaultFacebookPageId!,
              instagramActorId: destination.account.defaultInstagramActorId,
              imageHash,
              destinationUrl: payload.launch.destinationUrl!,
              primaryText: payload.launch.primaryText,
              headline: payload.launch.headline,
              cta: payload.launch.cta,
            });
            metaCreativeId = creativeResult.creativeId;
            await persistMetaIds(db, organizationId, {
              itemId: item.id,
              localAdId,
              imageHash,
              videoId,
              creativeId: metaCreativeId,
              adId: metaAdId,
            });
          }
        }

        if (!metaAdId) {
          const adResult = await createPausedMetaAd({
            metaAccountId: destination.account.metaAccountId,
            accessToken: destination.accessToken,
            adName: payload.launch.adName,
            adSetMetaId: destination.adSet.metaId!,
            creativeId: metaCreativeId,
            requestedStatus: PAUSED_META_STATUS,
          });
          metaAdId = adResult.adId;
          await persistMetaIds(db, organizationId, {
            itemId: item.id,
            localAdId,
            imageHash,
            videoId,
            creativeId: metaCreativeId,
            adId: metaAdId,
          });
        }

        const snapshot = await fetchMetaAdSnapshot({
          adMetaId: metaAdId,
          accessToken: destination.accessToken,
        });
        const reconciliation = reconcileCreatedMetaAd({
          snapshot,
          expectedAdMetaId: metaAdId,
          expectedAdSetMetaId: destination.adSet.metaId!,
          expectedCreativeMetaId: metaCreativeId,
        });

        await persistMetaIds(db, organizationId, {
          itemId: item.id,
          localAdId,
          imageHash,
          videoId,
          creativeId: metaCreativeId,
          adId: metaAdId,
          rawMetaConfiguredStatus: reconciliation.rawMetaConfiguredStatus,
          rawMetaEffectiveStatus: reconciliation.rawMetaEffectiveStatus,
        });

        if (!reconciliation.ok) {
          return persistPublishFailure(db, {
            organizationId,
            runId: run.id,
            runItemCount: run.itemCount,
            itemId: item.id,
            category: "ambiguous",
            code: "META_RECONCILIATION_FAILED",
            message: "Created Meta ad could not be reconciled as the expected paused ad",
            details: reconciliation.details,
            reconciliationStatus: "mismatched",
            manualInterventionReason: reconciliation.failureReason,
            rawMetaConfiguredStatus: reconciliation.rawMetaConfiguredStatus,
            rawMetaEffectiveStatus: reconciliation.rawMetaEffectiveStatus,
          });
        }

        const now = new Date();
        await db
          .update(launchpadPublishItems)
          .set({
            status: "success",
            localAdId,
            externalMetaImageHash: imageHash,
            externalMetaVideoId: videoId,
            externalMetaCreativeId: metaCreativeId,
            externalMetaAdId: metaAdId,
            rawMetaConfiguredStatus: reconciliation.rawMetaConfiguredStatus,
            rawMetaEffectiveStatus: reconciliation.rawMetaEffectiveStatus,
            reconciliationStatus: "reconciled",
            reconciliationCheckedAt: now,
            completedAt: now,
            errorCategory: null,
            errorCode: null,
            errorMessage: null,
            errorDetails: null,
            manualInterventionReason: null,
          })
          .where(
            and(
              eq(launchpadPublishItems.id, item.id),
              eq(launchpadPublishItems.organizationId, organizationId),
            ),
          );
        const runStatus = await resolveRunAggregateStatusAfterItem(db, {
          organizationId,
          runId: run.id,
          runItemCount: run.itemCount,
          itemStatus: "success",
        });
        const runReconciliationStatus = runStatus === "success"
          ? "reconciled"
          : ["ambiguous", "manual_intervention"].includes(runStatus)
            ? "manual_intervention"
            : "pending";
        await db
          .update(launchpadPublishRuns)
          .set({
            status: runStatus,
            reconciliationStatus: runReconciliationStatus,
            reconciliationCheckedAt: runStatus === "success" ? now : undefined,
            completedAt: isTerminalRunStatus(runStatus) ? now : undefined,
            ...(runStatus === "success"
              ? {
                  errorCategory: null,
                  errorCode: null,
                  errorMessage: null,
                  errorDetails: null,
                  manualInterventionReason: null,
                }
              : {}),
          })
          .where(
            and(
              eq(launchpadPublishRuns.id, run.id),
              eq(launchpadPublishRuns.organizationId, organizationId),
            ),
          );

        return {
          status: "success" as const,
          runStatus,
          replayed: false,
          runId: run.id,
          itemId: item.id,
          localAdId,
          metaImageHash: imageHash,
          metaVideoId: videoId,
          metaCreativeId,
          metaAdId,
          rawMetaConfiguredStatus: reconciliation.rawMetaConfiguredStatus,
          rawMetaEffectiveStatus: reconciliation.rawMetaEffectiveStatus,
        };
      } catch (error) {
        if (error instanceof LaunchpadMetaPublishError) {
          const isUncertainAdCreateFailure =
            error.operation === "create_ad" &&
            error.category === "retryable" &&
            error.code !== "META_RATE_LIMIT";
          if (error.operation === "reconcile_ad" || isUncertainAdCreateFailure) {
            return persistPublishFailure(db, {
              organizationId,
              runId: run.id,
              runItemCount: run.itemCount,
              itemId: item.id,
              category: "ambiguous",
              code: error.operation === "reconcile_ad"
                ? "META_RECONCILIATION_AMBIGUOUS"
                : "META_AD_CREATE_AMBIGUOUS",
              message: error.operation === "reconcile_ad"
                ? "Created Meta ad could not be reconciled after publishing"
                : "Meta ad creation failed after the /ads request was sent and needs reconciliation before retry",
              details: error.details,
              reconciliationStatus: "manual_intervention",
              manualInterventionReason: error.message,
            });
          }

          return persistPublishFailure(db, publishErrorInput({
            organizationId,
            runId: run.id,
            runItemCount: run.itemCount,
            itemId: item.id,
            error,
          }));
        }

        asTrpcError(error);
      }
    }),
});
