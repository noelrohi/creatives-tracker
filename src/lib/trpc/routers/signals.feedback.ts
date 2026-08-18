import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { HOOK_FEEDBACK_REASON_SLUGS } from "@/lib/competitor-signals/plan-feedback";
import { user } from "@/schema/auth";
import {
  planRuleSourceEnum,
  planRules,
  testPlanComments,
  testPlanConcepts,
  testPlanHookFeedback,
  testPlanHookRatingEnum,
} from "@/schema/competitor-signals";
import { openApiQueryMeta } from "../openapi-meta";
import { orgProcedure, orgWriteProcedure } from "../init";

const MAX_COMMENT_LENGTH = 2000;
const MAX_RULE_LENGTH = 500;

export const hookFeedbackSchema = z.object({
  hook: z.string(),
  rating: z.enum(testPlanHookRatingEnum.enumValues),
  reasons: z.array(z.string()),
});

export const planCommentSchema = z.object({
  id: z.string(),
  authorName: z.string(),
  createdAt: z.date(),
  text: z.string(),
  promotedRuleId: z.string().nullable(),
});

const planRuleSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(planRuleSourceEnum.enumValues),
  active: z.boolean(),
  attributionName: z.string(),
  createdAt: z.date(),
});

/** The `planRuleSchema` projection, for every read and `returning` below. */
const planRuleColumns = {
  id: planRules.id,
  text: planRules.text,
  source: planRules.source,
  active: planRules.active,
  attributionName: planRules.attributionName,
  createdAt: planRules.createdAt,
};

/**
 * The session user behind a write. `orgWriteProcedure` also admits API-key and
 * worker principals, but a comment or a rule is attributed to a person — there
 * is no name to snapshot for a machine, so those principals are turned away.
 */
async function requireAuthor(userId: string | null) {
  if (!userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Test plan feedback is written by a signed-in user",
    });
  }

  const [author] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!author) {
    throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
  }

  return author;
}

/** The concept a piece of feedback hangs off, scoped to the caller's org. */
async function requireConcept(conceptId: string, organizationId: string) {
  const [concept] = await db
    .select({ id: testPlanConcepts.id, hooks: testPlanConcepts.hooks })
    .from(testPlanConcepts)
    .where(
      and(
        eq(testPlanConcepts.id, conceptId),
        eq(testPlanConcepts.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!concept) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Test plan concept not found",
    });
  }

  return concept;
}

export const signalsFeedbackProcedures = {
  /**
   * Per-hook thumbs, org-shared and last-writer-wins — the same tracking-sheet
   * reasoning as `setTestPlanAdStatus`, so no extra role gating. `null` clears
   * the rating by deleting the row.
   */
  rateTestPlanHook: orgWriteProcedure
    .input(
      z.object({
        conceptId: z.string(),
        hook: z.string(),
        rating: z.enum(testPlanHookRatingEnum.enumValues).nullable(),
        reasons: z.array(z.enum(HOOK_FEEDBACK_REASON_SLUGS)).optional(),
      }),
    )
    .output(
      z.object({
        conceptId: z.string(),
        hook: z.string(),
        rating: z.enum(testPlanHookRatingEnum.enumValues).nullable(),
        reasons: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const concept = await requireConcept(input.conceptId, ctx.organizationId);

      // Feedback is keyed `(conceptId, hook)`, so a hook the concept does not
      // carry would strand a row no reader ever joins back — same reasoning as
      // the `ads[].hook` check at ingest.
      if (!concept.hooks.includes(input.hook)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Hook "${input.hook}" is not one of the concept's hooks`,
        });
      }

      if (input.rating === null) {
        await db
          .delete(testPlanHookFeedback)
          .where(
            and(
              eq(testPlanHookFeedback.conceptId, input.conceptId),
              eq(testPlanHookFeedback.hook, input.hook),
              eq(testPlanHookFeedback.organizationId, ctx.organizationId),
            ),
          );

        return {
          conceptId: input.conceptId,
          hook: input.hook,
          rating: null,
          reasons: [],
        };
      }

      // Reasons answer "what's off?" — they only mean anything under a thumbs
      // down, so leaving `down` drops them rather than parking stale slugs.
      const reasons = input.rating === "down" ? (input.reasons ?? []) : [];
      const now = new Date();

      await db
        .insert(testPlanHookFeedback)
        .values({
          organizationId: ctx.organizationId,
          conceptId: input.conceptId,
          hook: input.hook,
          rating: input.rating,
          reasons,
        })
        .onConflictDoUpdate({
          target: [testPlanHookFeedback.conceptId, testPlanHookFeedback.hook],
          set: { rating: input.rating, reasons, updatedAt: now },
        });

      return {
        conceptId: input.conceptId,
        hook: input.hook,
        rating: input.rating,
        reasons,
      };
    }),

  /** A note on the concept's thread; the author is the session user. */
  addTestPlanComment: orgWriteProcedure
    .input(
      z.object({
        conceptId: z.string(),
        text: z.string().min(1).max(MAX_COMMENT_LENGTH),
      }),
    )
    .output(planCommentSchema)
    .mutation(async ({ input, ctx }) => {
      await requireConcept(input.conceptId, ctx.organizationId);
      const author = await requireAuthor(ctx.userId);

      const [comment] = await db
        .insert(testPlanComments)
        .values({
          organizationId: ctx.organizationId,
          conceptId: input.conceptId,
          authorUserId: author.id,
          text: input.text,
        })
        .returning({
          id: testPlanComments.id,
          createdAt: testPlanComments.createdAt,
          text: testPlanComments.text,
          promotedRuleId: testPlanComments.promotedRuleId,
        });

      return { ...comment, authorName: author.name };
    }),

  /**
   * Turn a comment into standing memory. Comments cascade-delete with their
   * concept, so the rule snapshots the author's name instead of joining back.
   * Idempotent: an already-promoted comment hands back the rule it made.
   */
  promoteCommentToRule: orgWriteProcedure
    .input(z.object({ commentId: z.string() }))
    .output(planRuleSchema)
    .mutation(async ({ input, ctx }) => {
      const [comment] = await db
        .select({
          id: testPlanComments.id,
          text: testPlanComments.text,
          promotedRuleId: testPlanComments.promotedRuleId,
          authorName: user.name,
        })
        .from(testPlanComments)
        .innerJoin(user, eq(user.id, testPlanComments.authorUserId))
        .where(
          and(
            eq(testPlanComments.id, input.commentId),
            eq(testPlanComments.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!comment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Test plan comment not found",
        });
      }

      if (comment.promotedRuleId) {
        const [existing] = await db
          .select(planRuleColumns)
          .from(planRules)
          .where(
            and(
              eq(planRules.id, comment.promotedRuleId),
              eq(planRules.organizationId, ctx.organizationId),
            ),
          )
          .limit(1);

        if (existing) return existing;
      }

      const author = await requireAuthor(ctx.userId);

      const [rule] = await db
        .insert(planRules)
        .values({
          organizationId: ctx.organizationId,
          text: comment.text,
          source: "feedback",
          attributionName: comment.authorName,
          createdByUserId: author.id,
        })
        .returning(planRuleColumns);

      await db
        .update(testPlanComments)
        .set({ promotedRuleId: rule.id, updatedAt: new Date() })
        .where(
          and(
            eq(testPlanComments.id, input.commentId),
            eq(testPlanComments.organizationId, ctx.organizationId),
          ),
        );

      return rule;
    }),

  /** A rule typed straight onto the rules card, attributed to its author. */
  addPlanRule: orgWriteProcedure
    .input(z.object({ text: z.string().min(1).max(MAX_RULE_LENGTH) }))
    .output(planRuleSchema)
    .mutation(async ({ input, ctx }) => {
      const author = await requireAuthor(ctx.userId);

      const [rule] = await db
        .insert(planRules)
        .values({
          organizationId: ctx.organizationId,
          text: input.text,
          source: "manual",
          attributionName: author.name,
          createdByUserId: author.id,
        })
        .returning(planRuleColumns);

      return rule;
    }),

  /** Toggling a rule off is the v1 stand-in for deleting one. */
  setPlanRuleActive: orgWriteProcedure
    .input(z.object({ ruleId: z.string(), active: z.boolean() }))
    .output(z.object({ id: z.string(), active: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db
        .update(planRules)
        .set({ active: input.active, updatedAt: new Date() })
        .where(
          and(
            eq(planRules.id, input.ruleId),
            eq(planRules.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: planRules.id, active: planRules.active });

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Plan rule not found",
        });
      }

      return updated;
    }),

  /** The rules card reads every rule, active or not — the switch needs both. */
  planRules: orgProcedure
    .output(z.object({ rules: z.array(planRuleSchema) }))
    .query(async ({ ctx }) => {
      const rules = await db
        .select(planRuleColumns)
        .from(planRules)
        .where(eq(planRules.organizationId, ctx.organizationId))
        .orderBy(asc(planRules.createdAt));

      return { rules };
    }),

  /**
   * The harness read-back before it generates the next plan (step 8): one GET
   * carries the standing rules and everything the humans said about the plan
   * currently on the screen.
   *
   * The built-in guardrail rule is deliberately absent — it is a code fixture
   * the skill carries verbatim, so a wiped table can never silently drop the
   * compliance rule.
   */
  planFeedback: orgProcedure
    .meta(
      openApiQueryMeta(
        "signals",
        "planFeedback",
        "Read the plan rules and current test-plan feedback",
        "Active plan rules plus per-concept hook ratings and comments, for the next generation.",
      ),
    )
    .output(
      z.object({
        rules: z.array(
          z.object({
            text: z.string(),
            source: z.enum(planRuleSourceEnum.enumValues),
            attributionName: z.string(),
          }),
        ),
        concepts: z.array(
          z.object({
            title: z.string(),
            hooks: z.array(z.string()),
            feedback: z.array(hookFeedbackSchema),
            comments: z.array(
              z.object({
                authorName: z.string(),
                text: z.string(),
                createdAt: z.date(),
              }),
            ),
          }),
        ),
      }),
    )
    .query(async ({ ctx }) => {
      const rules = await db
        .select({
          text: planRules.text,
          source: planRules.source,
          attributionName: planRules.attributionName,
        })
        .from(planRules)
        .where(
          and(
            eq(planRules.organizationId, ctx.organizationId),
            eq(planRules.active, true),
          ),
        )
        .orderBy(asc(planRules.createdAt));

      const concepts = await db
        .select({
          id: testPlanConcepts.id,
          title: testPlanConcepts.title,
          hooks: testPlanConcepts.hooks,
        })
        .from(testPlanConcepts)
        .where(eq(testPlanConcepts.organizationId, ctx.organizationId))
        .orderBy(
          asc(testPlanConcepts.generatedAt),
          asc(testPlanConcepts.createdAt),
        );

      if (concepts.length === 0) return { rules, concepts: [] };

      const conceptIds = concepts.map((concept) => concept.id);
      const [feedback, comments] = await Promise.all([
        readHookFeedback(conceptIds, ctx.organizationId),
        readComments(conceptIds, ctx.organizationId),
      ]);

      return {
        rules,
        concepts: concepts.map((concept) => ({
          title: concept.title,
          hooks: concept.hooks,
          feedback: feedback.get(concept.id) ?? [],
          comments: (comments.get(concept.id) ?? []).map((comment) => ({
            authorName: comment.authorName,
            text: comment.text,
            createdAt: comment.createdAt,
          })),
        })),
      };
    }),
} satisfies TRPCRouterRecord;

/** One read for every concept's ratings, grouped in memory — as the ads read. */
export async function readHookFeedback(
  conceptIds: string[],
  organizationId: string,
) {
  const rows = await db
    .select({
      conceptId: testPlanHookFeedback.conceptId,
      hook: testPlanHookFeedback.hook,
      rating: testPlanHookFeedback.rating,
      reasons: testPlanHookFeedback.reasons,
    })
    .from(testPlanHookFeedback)
    .where(
      and(
        eq(testPlanHookFeedback.organizationId, organizationId),
        inArray(testPlanHookFeedback.conceptId, conceptIds),
      ),
    );

  const byConcept = new Map<string, z.infer<typeof hookFeedbackSchema>[]>();
  for (const row of rows) {
    const bucket = byConcept.get(row.conceptId) ?? [];
    bucket.push({
      hook: row.hook,
      rating: row.rating,
      reasons: row.reasons ?? [],
    });
    byConcept.set(row.conceptId, bucket);
  }
  return byConcept;
}

/** The same, for the comment threads — author name joined, oldest first. */
export async function readComments(
  conceptIds: string[],
  organizationId: string,
) {
  const rows = await db
    .select({
      id: testPlanComments.id,
      conceptId: testPlanComments.conceptId,
      authorName: user.name,
      createdAt: testPlanComments.createdAt,
      text: testPlanComments.text,
      promotedRuleId: testPlanComments.promotedRuleId,
    })
    .from(testPlanComments)
    .innerJoin(user, eq(user.id, testPlanComments.authorUserId))
    .where(
      and(
        eq(testPlanComments.organizationId, organizationId),
        inArray(testPlanComments.conceptId, conceptIds),
      ),
    )
    .orderBy(asc(testPlanComments.createdAt));

  const byConcept = new Map<string, z.infer<typeof planCommentSchema>[]>();
  for (const row of rows) {
    const bucket = byConcept.get(row.conceptId) ?? [];
    bucket.push({
      id: row.id,
      authorName: row.authorName,
      createdAt: row.createdAt,
      text: row.text,
      promotedRuleId: row.promotedRuleId,
    });
    byConcept.set(row.conceptId, bucket);
  }
  return byConcept;
}
