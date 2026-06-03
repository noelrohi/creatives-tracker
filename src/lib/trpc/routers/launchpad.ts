import { TRPCError } from "@trpc/server";
import { and, desc, eq, or } from "drizzle-orm";
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
  createLaunchpadRunDraft,
} from "@/lib/launchpad-ledger";
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
        const [existing] = await tx
          .select()
          .from(launchpadPublishRuns)
          .where(
            and(
              eq(launchpadPublishRuns.organizationId, ctx.organizationId),
              or(
                eq(launchpadPublishRuns.idempotencyKey, draft.idempotencyKey),
                eq(launchpadPublishRuns.dedupeKey, draft.dedupeKey),
              ),
            ),
          )
          .limit(1);

        if (existing) {
          return existing;
        }

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
          .returning();

        await tx.insert(launchpadPublishItems).values(
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
        );

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
      try {
        assertLivePublishSafety({
          principalType: ctx.principalType,
          orgRole: ctx.orgRole,
          requestedStatus: input.requestedStatus,
          itemCount: 1,
          confirmationAccepted: input.confirmation === "PUBLISH_PAUSED_META_ADS",
          previouslyValidatedManifest: true,
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
