import { generateObject } from "ai";
import { logger, task } from "@trigger.dev/sdk";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { openai } from "@/lib/ai";
import type { AwarenessLevel } from "@/lib/awareness";
import { fetchCreativePerformanceRows } from "@/lib/studio-performance";
import { isStudioFormat } from "@/lib/studio-prompt";
import { studioSuggestionCardsSchema } from "@/lib/studio-suggestions";
import {
  studioSuggestions,
  studioSuggestionVariants,
} from "@/schema/studio";

const SUGGESTION_MODEL = "gpt-5.6-terra";
const IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;

function toNumber(value: string | number | null | undefined) {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type GenerateStudioSuggestionsPayload = {
  organizationId: string;
};

export const generateStudioSuggestionsTask = task({
  id: "generate-studio-suggestions",
  machine: { preset: "small-1x" },
  maxDuration: 300,
  run: async (payload: GenerateStudioSuggestionsPayload) => {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
    const [recent] = await db
      .select({ id: studioSuggestions.id })
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, payload.organizationId),
          eq(studioSuggestions.status, "active"),
          gte(studioSuggestions.createdAt, cutoff),
        ),
      )
      .orderBy(desc(studioSuggestions.createdAt))
      .limit(1);

    if (recent) {
      logger.info("Skipping duplicate Studio suggestion generation", {
        organizationId: payload.organizationId,
        suggestionId: recent.id,
      });
      return { skipped: true as const };
    }

    try {
      const performance = await fetchCreativePerformanceRows(
        payload.organizationId,
      );
      const winners = performance
        .filter(
          (row) =>
            (toNumber(row.purchases) > 0 || toNumber(row.spend) > 0) &&
            Boolean(row.assetUrl) &&
            Boolean(row.angle?.trim()),
        )
        .sort((a, b) => toNumber(b.roas) - toNumber(a.roas))
        .slice(0, 3);

      if (winners.length === 0) return { cards: 0 };

      const context = winners.map((winner, index) => ({
        order: index + 1,
        name: winner.name,
        angle: winner.angle,
        persona: winner.persona,
        awarenessLevel: winner.awarenessLevel,
        roas: winner.roas,
        purchases: winner.purchases,
        spend: winner.spend,
        adCount: winner.adCount,
      }));
      const result = await generateObject({
        model: openai(SUGGESTION_MODEL),
        schema: studioSuggestionCardsSchema,
        system: `You are a senior DTC creative strategist turning paid-social performance into a founder-friendly production queue.
Produce exactly one recommendation card per supplied winner, in the same order as the winners. Choose a kind from the evidence: use new_hooks for the top-ROAS winner, new_format for a strong angle represented by few ads, and refresh for the oldest or most-spent winner.
Each card must contain exactly three useful, materially distinct variants. Keep variants single-variable-biased: at least one variant per card must change only the headline while every other production element is marked keep. diffSummary must be one plain-English sentence a founder understands. copyLine must be a punchy one-liner in the brand voice inferred from creative names and angles.
For elements, use action "keep" when production should reuse the winning ad and action "change" with a concrete value when it should differ. In particular, heroImage "keep" means reuse the supplied winner as the reference visual. Never invent performance numbers; use numbers only from the winner context.`,
        prompt: `Create this week's recommendation cards from these winners:\n${JSON.stringify(
          context,
          null,
          2,
        )}`,
      });

      if (result.object.length !== winners.length) {
        throw new Error(
          `Expected ${winners.length} suggestion cards, received ${result.object.length}`,
        );
      }
      const cards = result.object;
      await db.transaction(async (tx) => {
        await tx
          .update(studioSuggestions)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            and(
              eq(studioSuggestions.organizationId, payload.organizationId),
              eq(studioSuggestions.status, "active"),
            ),
          );

        for (const [cardIndex, card] of cards.entries()) {
          const winner = winners[cardIndex];
          if (!winner) continue;

          const [suggestion] = await tx
            .insert(studioSuggestions)
            .values({
              organizationId: payload.organizationId,
              sourceCreativeId: winner.creativeId,
              kind: card.kind,
              title: card.title,
              whyLine: card.whyLine,
              angle: winner.angle,
              persona: winner.persona,
              awarenessLevel: winner.awarenessLevel as AwarenessLevel | null,
              roas: winner.roas,
              purchases: winner.purchases,
              spend: winner.spend,
              status: "active",
            })
            .returning({ id: studioSuggestions.id });

          await tx.insert(studioSuggestionVariants).values(
            card.variants.map((variant, index) => ({
              suggestionId: suggestion.id,
              organizationId: payload.organizationId,
              index,
              headline: variant.headline,
              diffSummary: variant.diffSummary,
              copyLine: variant.copyLine,
              elements: variant.elements,
              format: isStudioFormat(variant.format) ? variant.format : "square",
              status: "suggested",
            })),
          );
        }
      });

      logger.info("Generated Studio suggestions", {
        organizationId: payload.organizationId,
        cards: cards.length,
      });
      return { cards: cards.length };
    } catch (error) {
      logger.error("Studio suggestion generation failed", {
        organizationId: payload.organizationId,
        error,
      });
      throw error;
    }
  },
});
