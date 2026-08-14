import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ANGLE_TYPES } from "@/lib/creative-taxonomy";
import { normalizeAngle } from "@/lib/creative-tag-enrichment";
import {
  intelSnapshots,
  testPlanAdStatusEnum,
  testPlanAds,
  testPlanConcepts,
  testPlanFormatEnum,
} from "@/schema/competitor-signals";
import { openApiMutationMeta } from "../openapi-meta";
import { orgProcedure, orgWriteProcedure } from "../init";

// §9: 3 concepts × 3 hooks × 2 formats is the default wave, but the shape is
// parameterized by the harness — the caps only stop a runaway generation.
const MAX_CONCEPTS_PER_PLAN = 6;
const MAX_HOOKS_PER_CONCEPT = 6;
const MAX_ADS_PER_CONCEPT = 24;

const planAdSchema = z.object({
  hook: z.string(),
  format: z.enum(testPlanFormatEnum.enumValues),
});

const planConceptSchema = z.object({
  title: z.string().min(1),
  // Free text across the boundary — the harness is an LLM, so the server
  // gatekeeps it below (§5) rather than trusting the vocabulary.
  angle: z.string(),
  audience: z.string(),
  evidenceClusterIds: z.array(z.string()),
  evidenceCitation: z.string(),
  measurementPlan: z.string(),
  claimGuardrail: z.string().nullable(),
  hooks: z.array(z.string()).min(1).max(MAX_HOOKS_PER_CONCEPT),
  ads: z.array(planAdSchema).min(1).max(MAX_ADS_PER_CONCEPT),
});

const planAdOutputSchema = z.object({
  id: z.string(),
  hook: z.string(),
  format: z.enum(testPlanFormatEnum.enumValues),
  status: z.enum(testPlanAdStatusEnum.enumValues),
  sortOrder: z.number().int(),
});

const planConceptOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  angle: z.string(),
  audience: z.string(),
  evidenceClusterIds: z.array(z.string()),
  evidenceCitation: z.string(),
  measurementPlan: z.string(),
  claimGuardrail: z.string().nullable(),
  hooks: z.array(z.string()),
  generatedAt: z.date(),
  ads: z.array(planAdOutputSchema),
});

export const signalsPlanProcedures = {
  /**
   * The plan push (§9): the fill workflow's final step, after the harness has
   * read `rankedSignals` and generated against cross-competitor state.
   */
  ingestTestPlan: orgWriteProcedure
    .meta(
      openApiMutationMeta(
        "signals",
        "ingestTestPlan",
        "Push a generated creative test plan",
        "Concepts plus their light ad rows; replaces everything still proposed.",
      ),
    )
    .input(
      z.object({
        generatedSnapshotId: z.string().nullable(),
        concepts: z.array(planConceptSchema).min(1).max(MAX_CONCEPTS_PER_PLAN),
      }),
    )
    .output(
      z.object({
        conceptCount: z.number().int(),
        adCount: z.number().int(),
        replacedAdCount: z.number().int(),
        keptConceptCount: z.number().int(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const now = new Date();

      // The §5 gatekeeper degrades an unrecognized cluster angle to null, but a
      // concept's angle column is notNull — there is nothing to degrade to, and
      // a plan concept with no angle is not a plan concept. So this one rejects.
      const concepts = input.concepts.map((concept) => {
        const angle = normalizeAngle(concept.angle);
        if (!angle) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Concept "${concept.title}" has angle "${concept.angle}", which is not one of: ${ANGLE_TYPES.join(", ")}`,
          });
        }

        // §9: ad rows are deliberately light — the hook is the only copy they
        // carry, so it has to name one of the concept's own hooks or the row
        // is orphaned from the rich concept it is supposed to test.
        const hooks = new Set(concept.hooks);
        for (const ad of concept.ads) {
          if (!hooks.has(ad.hook)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Concept "${concept.title}" has an ad on hook "${ad.hook}", which is not one of its hooks`,
            });
          }
        }

        return { ...concept, angle };
      });

      return await db.transaction(async (tx) => {
        if (input.generatedSnapshotId) {
          const [snapshot] = await tx
            .select({ id: intelSnapshots.id })
            .from(intelSnapshots)
            .where(
              and(
                eq(intelSnapshots.id, input.generatedSnapshotId),
                eq(intelSnapshots.organizationId, ctx.organizationId),
              ),
            )
            .limit(1);

          if (!snapshot) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `No fill snapshot ${input.generatedSnapshotId} for this organization`,
            });
          }
        }

        // §9 "regeneration replaces `proposed` only": the untouched statuses
        // are human decisions, and a regeneration never tramples one.
        const replacedAds = await tx
          .delete(testPlanAds)
          .where(
            and(
              eq(testPlanAds.organizationId, ctx.organizationId),
              eq(testPlanAds.status, "proposed"),
            ),
          )
          .returning({ id: testPlanAds.id });

        const existingConcepts = await tx
          .select({ id: testPlanConcepts.id })
          .from(testPlanConcepts)
          .where(eq(testPlanConcepts.organizationId, ctx.organizationId));

        const survivingAds = await tx
          .select({ conceptId: testPlanAds.conceptId })
          .from(testPlanAds)
          .where(eq(testPlanAds.organizationId, ctx.organizationId));

        // A concept survives on the strength of its ads: keep one in-flight ad
        // and the whole header (title, hooks, citation, guardrail) stays as the
        // human left it; lose them all and the concept goes with them.
        const conceptsWithAds = new Set(survivingAds.map((ad) => ad.conceptId));
        const emptyConceptIds = existingConcepts
          .map((concept) => concept.id)
          .filter((id) => !conceptsWithAds.has(id));
        const keptConceptCount =
          existingConcepts.length - emptyConceptIds.length;

        if (emptyConceptIds.length > 0) {
          await tx
            .delete(testPlanConcepts)
            .where(
              and(
                eq(testPlanConcepts.organizationId, ctx.organizationId),
                inArray(testPlanConcepts.id, emptyConceptIds),
              ),
            );
        }

        const inserted = await tx
          .insert(testPlanConcepts)
          .values(
            concepts.map((concept) => ({
              organizationId: ctx.organizationId,
              title: concept.title,
              angle: concept.angle,
              audience: concept.audience,
              // Stored verbatim, never existence-checked: clusters are wiped
              // and rebuilt on every fill (§3), so these ids are expected to
              // dangle. They are provenance for a reader, not a foreign key.
              evidenceClusterIds: concept.evidenceClusterIds,
              evidenceCitation: concept.evidenceCitation,
              measurementPlan: concept.measurementPlan,
              claimGuardrail: concept.claimGuardrail,
              hooks: concept.hooks,
              generatedSnapshotId: input.generatedSnapshotId,
              generatedAt: now,
            })),
          )
          .returning({ id: testPlanConcepts.id });

        // A surviving concept and a fresh one can carry the same title. That is
        // accepted for v1 (§3/§13): concepts have no identity across
        // generations, exactly like the clusters they cite — no dedupe here.
        const adRows = concepts.flatMap((concept, index) =>
          concept.ads.map((ad, sortOrder) => ({
            organizationId: ctx.organizationId,
            conceptId: inserted[index].id,
            hook: ad.hook,
            format: ad.format,
            sortOrder,
          })),
        );

        if (adRows.length > 0) {
          await tx.insert(testPlanAds).values(adRows);
        }

        return {
          conceptCount: concepts.length,
          adCount: adRows.length,
          replacedAdCount: replacedAds.length,
          keptConceptCount,
        };
      });
    }),

  /** The one live plan behind /competitors/test-plan (§9, Phase 3). */
  testPlan: orgProcedure
    .output(z.object({ concepts: z.array(planConceptOutputSchema) }))
    .query(async ({ ctx }) => {
      const concepts = await db
        .select({
          id: testPlanConcepts.id,
          title: testPlanConcepts.title,
          angle: testPlanConcepts.angle,
          audience: testPlanConcepts.audience,
          evidenceClusterIds: testPlanConcepts.evidenceClusterIds,
          evidenceCitation: testPlanConcepts.evidenceCitation,
          measurementPlan: testPlanConcepts.measurementPlan,
          claimGuardrail: testPlanConcepts.claimGuardrail,
          hooks: testPlanConcepts.hooks,
          generatedAt: testPlanConcepts.generatedAt,
        })
        .from(testPlanConcepts)
        .where(eq(testPlanConcepts.organizationId, ctx.organizationId))
        // Oldest generation first, so the concepts carrying in-flight work read
        // above the newest proposals; createdAt breaks ties within one push.
        .orderBy(
          asc(testPlanConcepts.generatedAt),
          asc(testPlanConcepts.createdAt),
        );

      if (concepts.length === 0) return { concepts: [] };

      // One read for every concept's ads, grouped in memory — not a query per
      // concept.
      const ads = await db
        .select({
          id: testPlanAds.id,
          conceptId: testPlanAds.conceptId,
          hook: testPlanAds.hook,
          format: testPlanAds.format,
          status: testPlanAds.status,
          sortOrder: testPlanAds.sortOrder,
        })
        .from(testPlanAds)
        .where(
          and(
            eq(testPlanAds.organizationId, ctx.organizationId),
            inArray(
              testPlanAds.conceptId,
              concepts.map((concept) => concept.id),
            ),
          ),
        )
        .orderBy(asc(testPlanAds.sortOrder));

      type PlanAdOutput = z.infer<typeof planAdOutputSchema>;
      const adsByConcept = new Map<string, PlanAdOutput[]>();
      for (const ad of ads) {
        const bucket = adsByConcept.get(ad.conceptId) ?? [];
        bucket.push({
          id: ad.id,
          hook: ad.hook,
          format: ad.format,
          status: ad.status,
          sortOrder: ad.sortOrder,
        });
        adsByConcept.set(ad.conceptId, bucket);
      }

      return {
        concepts: concepts.map((concept) => ({
          ...concept,
          ads: adsByConcept.get(concept.id) ?? [],
        })),
      };
    }),

  /**
   * The per-ad status move (§9). Deliberately on `orgWriteProcedure` with no
   * further role gating: any org member moves a row, because the checklist is a
   * tracking sheet, not an approval system.
   */
  setTestPlanAdStatus: orgWriteProcedure
    .input(
      z.object({
        adId: z.string(),
        status: z.enum(testPlanAdStatusEnum.enumValues),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        status: z.enum(testPlanAdStatusEnum.enumValues),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db
        .update(testPlanAds)
        .set({ status: input.status, updatedAt: new Date() })
        .where(
          and(
            eq(testPlanAds.id, input.adId),
            eq(testPlanAds.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: testPlanAds.id, status: testPlanAds.status });

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Test plan ad not found",
        });
      }

      return updated;
    }),
} satisfies TRPCRouterRecord;
