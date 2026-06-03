import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  DEFAULT_META_CTA,
  LAUNCHPAD_MAX_ITEMS,
  PAUSED_META_STATUS,
  metaCtaValues,
} from "@/lib/launchpad-constants";
import {
  LaunchpadLedgerError,
  assertLivePublishSafety,
  assertLockedHashStable,
  createLaunchpadRunDraft,
  type LaunchpadRunDraft,
} from "@/lib/launchpad-ledger";
import { adAccounts } from "@/schema/account";
import { adCreatives } from "@/schema/ad-creative";
import { adSets } from "@/schema/ad-set";
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

const createValidationRunInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
  actor: actorSchema,
  destination: destinationSchema,
  items: z
    .array(
      z.object({
        creativeId: z.string().trim().min(1).optional(),
        creativeName: z.string().trim().min(1).optional(),
        format: z.string().trim().min(1).optional(),
        assetUrl: z.string().trim().url().optional(),
        adName: z.string().trim().min(1),
        caption: z.string().trim().min(1).optional(),
        headline: z.string().trim().min(1).optional(),
        destinationUrl: z.string().trim().url().optional(),
        cta: z.enum(metaCtaValues).default(DEFAULT_META_CTA),
        requestedStatus: z.literal(PAUSED_META_STATUS).default(PAUSED_META_STATUS),
        idempotencyKey: z.string().trim().min(8).max(160).optional(),
        dedupeKey: z.string().trim().min(8).max(160).optional(),
      }),
    )
    .min(1)
    .max(LAUNCHPAD_MAX_ITEMS),
});

function asTrpcError(error: unknown): never {
  if (error instanceof LaunchpadLedgerError) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
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

async function assertLaunchpadReferencesBelongToOrg(
  client: LaunchpadReader,
  organizationId: string,
  draft: LaunchpadRunDraft,
) {
  const accountId = draft.manifest.actor.accountId;
  const accountMetaId = draft.manifest.actor.accountMetaId;
  if (accountId || accountMetaId) {
    const accountRows = await client
      .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId })
      .from(adAccounts)
      .where(
        and(
          accountId
            ? eq(adAccounts.id, accountId)
            : eq(adAccounts.metaAccountId, accountMetaId!),
          eq(adAccounts.organizationId, organizationId),
        ),
      );
    if (accountRows.length !== 1) {
      throwReferenceNotFound("Ad account", [accountId ?? accountMetaId!]);
    }
    if (accountMetaId && accountRows[0]!.metaAccountId !== accountMetaId) {
      throwReferenceMismatch(
        "Ad account",
        accountRows[0]!.metaAccountId,
        accountMetaId,
      );
    }
  }

  const adSetId = draft.manifest.destination.adSetId;
  const adSetMetaId = draft.manifest.destination.adSetMetaId;
  if (adSetId || adSetMetaId) {
    const adSetRows = await client
      .select({ id: adSets.id, metaId: adSets.metaId })
      .from(adSets)
      .where(
        and(
          adSetId ? eq(adSets.id, adSetId) : eq(adSets.metaId, adSetMetaId!),
          eq(adSets.organizationId, organizationId),
        ),
      );
    if (adSetRows.length !== 1) {
      throwReferenceNotFound("Ad set", [adSetId ?? adSetMetaId!]);
    }
    if (adSetMetaId && adSetRows[0]!.metaId !== adSetMetaId) {
      throwReferenceMismatch("Ad set", adSetRows[0]!.metaId ?? "", adSetMetaId);
    }
  }

  const creativeIds = uniqueStrings(draft.items.map((item) => item.creativeId));
  if (creativeIds.length > 0) {
    const creativeRows = await client
      .select({ id: adCreatives.id })
      .from(adCreatives)
      .where(
        and(
          inArray(adCreatives.id, creativeIds),
          eq(adCreatives.organizationId, organizationId),
        ),
      );
    const foundIds = new Set(creativeRows.map((row) => row.id));
    const missingIds = creativeIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throwReferenceNotFound("Creative", missingIds);
    }
  }
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
  list: orgAdminProcedure
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

  getById: orgAdminProcedure
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

  createValidationRun: orgAdminProcedure
    .meta(openApiMutationMeta("launchpad", "createValidationRun"))
    .input(createValidationRunInputSchema)
    .mutation(async ({ input, ctx }) => {
      const draft = (() => {
        try {
          return createLaunchpadRunDraft({
            organizationId: ctx.organizationId,
            requestedBy: {
              userId: ctx.userId,
              principalType: ctx.principalType,
              orgRole: ctx.orgRole,
            },
            actor: input.actor,
            destination: input.destination,
            items: input.items,
            idempotencyKey: input.idempotencyKey,
            env: process.env,
          });
        } catch (error) {
          asTrpcError(error);
        }
      })();

      return db.transaction(async (tx) => {
        await assertLaunchpadReferencesBelongToOrg(
          tx,
          ctx.organizationId,
          draft,
        );

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
            validatedAt: now,
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
            draft.items.map((item) => ({
              runId: run.id,
              organizationId: ctx.organizationId,
              position: item.position,
              status: "validated" as const,
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
              validatedAt: now,
            })),
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

  requestLivePublish: orgAdminProcedure
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
