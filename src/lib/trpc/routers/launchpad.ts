import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { isLaunchpadEnabled } from "@/lib/feature-flags";
import {
  LAUNCHPAD_MAX_ITEMS,
  PAUSED_META_STATUS,
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
  createLaunchpadRunDraft,
  summarizeLaunchpadValidationIssues,
  type LaunchpadRunDraft,
} from "@/lib/launchpad-ledger";
import { buildLaunchpadPlannerOutput } from "@/lib/launchpad-planner";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import {
  launchpadPublishItems,
  launchpadPublishRuns,
} from "@/schema/launchpad";
import { router, orgAdminProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";

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

const createValidationRunInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
  actor: actorSchema,
  destination: destinationSchema,
  defaultDestinationUrl: z.string().trim().optional(),
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
    .max(1),
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

  throw error;
}

type LaunchpadReader = Pick<typeof db, "select">;

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => !!value)));
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

async function findExistingRunForReplay(
  client: LaunchpadReader,
  organizationId: string,
  draft: LaunchpadRunDraft,
) {
  const [sameIdempotencyRun] = await client
    .select()
    .from(launchpadPublishRuns)
    .where(
      and(
        eq(launchpadPublishRuns.organizationId, organizationId),
        eq(launchpadPublishRuns.idempotencyKey, draft.idempotencyKey),
      ),
    )
    .limit(1);

  if (sameIdempotencyRun) {
    if (sameIdempotencyRun.manifestHash !== draft.manifestHash) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Launchpad idempotency key was replayed with a different manifest",
      });
    }

    return sameIdempotencyRun;
  }

  const [sameDedupeRun] = await client
    .select()
    .from(launchpadPublishRuns)
    .where(
      and(
        eq(launchpadPublishRuns.organizationId, organizationId),
        eq(launchpadPublishRuns.dedupeKey, draft.dedupeKey),
      ),
    )
    .limit(1);

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

export const launchpadRouter = router({
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

      const items = await db
        .select()
        .from(launchpadPublishItems)
        .where(
          and(
            eq(launchpadPublishItems.runId, run.id),
            eq(launchpadPublishItems.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(launchpadPublishItems.position);

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

        const itemInput = input.items[0];
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

        const plannerOutput = buildLaunchpadPlannerOutput({
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
          launch: {
            defaultDestinationUrl: input.defaultDestinationUrl,
            destinationUrlOverride: itemInput.destinationUrl,
            primaryText: itemInput.primaryText,
            caption: itemInput.caption,
            headline: itemInput.headline,
            cta: itemInput.cta,
            adName: itemInput.adName,
            namingTemplate: input.namingTemplate,
          },
          existingMetaAdConflicts,
          idempotencyKey: input.idempotencyKey,
          env: process.env,
        });

        const draft = (() => {
          try {
            return createLaunchpadRunDraft(plannerOutput.runDraftInput);
          } catch (error) {
            asTrpcError(error);
          }
        })();

        const existingRun = await findExistingRunForReplay(
          tx,
          ctx.organizationId,
          draft,
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
            draft,
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
      const [run] = await db
        .select()
        .from(launchpadPublishRuns)
        .where(
          and(
            eq(launchpadPublishRuns.id, input.runId),
            eq(launchpadPublishRuns.organizationId, ctx.organizationId),
          ),
        );

      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Launchpad run not found",
        });
      }

      try {
        assertLockedHashStable({
          label: "manifest",
          lockedHash: run.manifestHash,
          nextValue: run.manifest,
        });
        assertLivePublishSafety({
          principalType: ctx.principalType,
          orgRole: ctx.orgRole,
          requestedStatus: run.requestedStatus,
          itemCount: run.itemCount,
          confirmationAccepted: input.confirmation === "PUBLISH_PAUSED_META_ADS",
          previouslyValidatedManifest:
            run.status === "validated" && !!run.manifestLockedAt && !!run.validatedAt,
          activePublishingPathAvailable: false,
          env: process.env,
        });
      } catch (error) {
        asTrpcError(error);
      }

      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Live Meta publishing is not implemented in this foundation slice",
      });
    }),
});
