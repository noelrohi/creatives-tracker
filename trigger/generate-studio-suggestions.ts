import { generateObject } from "ai";
import { logger, schedules, task } from "@trigger.dev/sdk";
import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { openai } from "@/lib/ai";
import type { AwarenessLevel } from "@/lib/awareness";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import { fetchStudioMarketResults } from "@/lib/studio-market";
import { isVideoFile } from "@/lib/studio-assets";
import {
  fetchCreativePerformanceRows,
  toNumber,
} from "@/lib/studio-performance";
import {
  buildRebrandBrief,
  buildWeeklySuggestionPrompt,
  isStudioFormat,
} from "@/lib/studio-prompt";
import { studioSlug } from "@/lib/studio-taxonomy";
import {
  classifyTrend,
  selectStudioWinners,
  WINNER_TREND_SPLIT_DAYS,
  WINNER_WINDOW_DAYS,
} from "@/lib/studio-winners";
import {
  rebrandElementSpecSchema,
  studioSuggestionCardSchema,
} from "@/lib/studio-suggestions";
import { organization } from "@/schema/auth";
import { performanceLogs } from "@/schema/performance-log";
import {
  studioCopyPackages,
  studioSuggestions,
  studioSwipes,
  studioTaxonomyValues,
  studioVariants,
  studioGenerations,
} from "@/schema/studio";

const SUGGESTION_MODEL = "gpt-5.6-terra";
const VISION_MODEL = "gpt-5.6-terra";
const IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GenerateStudioSuggestionsPayload = {
  organizationId: string;
  force?: boolean;
};

export const analyzeStudioSwipeTask = task({
  id: "analyze-studio-swipe",
  machine: { preset: "small-1x" },
  maxDuration: 120,
  run: async (payload: { organizationId: string; swipeId: string; imageUrl: string }) => {
    const result = await generateObject({
      model: openai(VISION_MODEL),
      schema: rebrandElementSpecSchema,
      system:
        "Inspect the saved reference ad and write a concise production element spec. Mark layout/background elements worth preserving as keep. Mark headline, hero person, product, offer, CTA, all brand marks, and copy as change whenever they belong to the source advertiser. Values must be plain-language visual instructions.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Write the keep/change element spec for this swipe." },
            { type: "image", image: payload.imageUrl },
          ],
        },
      ],
    });

    await db
      .update(studioSwipes)
      .set({ elements: result.object, updatedAt: new Date() })
      .where(
        and(
          eq(studioSwipes.id, payload.swipeId),
          eq(studioSwipes.organizationId, payload.organizationId),
        ),
      );
    return { ok: true };
  },
});

export const generateStudioSuggestionsTask = task({
  id: "generate-studio-suggestions",
  machine: { preset: "small-1x" },
  maxDuration: 300,
  run: async (payload: GenerateStudioSuggestionsPayload) => {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
    if (!payload.force) {
      const [recent] = await db
        .select({ id: studioSuggestions.id })
        .from(studioSuggestions)
        .where(
          and(
            eq(studioSuggestions.organizationId, payload.organizationId),
            eq(studioSuggestions.status, "proposed"),
            gte(studioSuggestions.createdAt, cutoff),
          ),
        )
        .orderBy(desc(studioSuggestions.createdAt))
        .limit(1);
      if (recent) return { skipped: true as const };
    }

    const now = Date.now();
    const windowStart = new Date(now - WINNER_WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const trendSplit = new Date(now - WINNER_TREND_SPLIT_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const [
      brand,
      marketRows,
      selectionPerformance,
      recentPerformance,
      priorPerformance,
    ] =
      await Promise.all([
        getStudioBrandProfile(payload.organizationId),
        fetchStudioMarketResults(payload.organizationId),
        fetchCreativePerformanceRows(payload.organizationId, [
          gte(performanceLogs.dateStart, windowStart),
        ]),
        fetchCreativePerformanceRows(payload.organizationId, [
          gte(performanceLogs.dateStart, trendSplit),
        ]),
        fetchCreativePerformanceRows(payload.organizationId, [
          gte(performanceLogs.dateStart, windowStart),
          lt(performanceLogs.dateStart, trendSplit),
        ]),
      ]);
    const selectedWinners = selectStudioWinners(
      selectionPerformance.map((row) => ({
        ...row,
        spend: toNumber(row.spend),
        purchases: toNumber(row.purchases),
        roas: toNumber(row.roas),
      })),
    );
    const recentByCreativeId = new Map(
      recentPerformance.map((row) => [row.creativeId, row]),
    );
    const priorByCreativeId = new Map(
      priorPerformance.map((row) => [row.creativeId, row]),
    );
    const winners = selectedWinners.map((winner) => {
      const recent = recentByCreativeId.get(winner.creativeId);
      const prior = priorByCreativeId.get(winner.creativeId);
      return {
        ...winner,
        trend: classifyTrend({
          recentRoas: toNumber(recent?.roas),
          priorRoas: toNumber(prior?.roas),
          recentSpend: toNumber(recent?.spend),
        }),
      };
    });

    const [skips, untriedSwipes, allSwipeTags, markedVariants, packages, taxonomy] =
      await Promise.all([
        db
          .select({
            title: studioSuggestions.title,
            angle: studioSuggestions.angle,
            whyLine: studioSuggestions.whyLine,
          })
          .from(studioSuggestions)
          .where(
            and(
              eq(studioSuggestions.organizationId, payload.organizationId),
              eq(studioSuggestions.status, "skipped"),
            ),
          )
          .orderBy(desc(studioSuggestions.updatedAt))
          .limit(30),
        db
          .select()
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, payload.organizationId),
              isNull(studioSwipes.archivedAt),
              isNull(studioSwipes.lastTriedAt),
            ),
          )
          .orderBy(desc(studioSwipes.createdAt))
          .limit(4),
        db
          .select({
            id: studioSwipes.id,
            visualStyleId: studioSwipes.visualStyleId,
          })
          .from(studioSwipes)
          .where(eq(studioSwipes.organizationId, payload.organizationId)),
        db
          .select({
            mark: studioVariants.mark,
            angle: studioGenerations.angle,
            swipeId: studioGenerations.swipeId,
            visualStyleId: studioSuggestions.visualStyleId,
          })
          .from(studioVariants)
          .innerJoin(
            studioGenerations,
            eq(studioGenerations.id, studioVariants.generationId),
          )
          .leftJoin(
            studioSuggestions,
            and(
              eq(studioSuggestions.generationId, studioGenerations.id),
              eq(studioSuggestions.organizationId, payload.organizationId),
            ),
          )
          .where(
            and(
              eq(studioVariants.organizationId, payload.organizationId),
              inArray(studioVariants.mark, ["good", "bad"]),
            ),
          ),
        db
          .select()
          .from(studioCopyPackages)
          .where(
            and(
              eq(studioCopyPackages.organizationId, payload.organizationId),
              isNull(studioCopyPackages.archivedAt),
            ),
          )
          .orderBy(desc(studioCopyPackages.createdAt)),
        db
          .select()
          .from(studioTaxonomyValues)
          .where(eq(studioTaxonomyValues.organizationId, payload.organizationId)),
      ]);

    const taxonomyById = new Map(taxonomy.map((value) => [value.id, value.name]));
    const swipeStyleById = new Map(
      allSwipeTags.map((swipe) => [
        swipe.id,
        swipe.visualStyleId ? taxonomyById.get(swipe.visualStyleId) ?? null : null,
      ]),
    );
    const tallies = new Map<
      string,
      { angle: string; style: string | null; good: number; bad: number }
    >();
    for (const variant of markedVariants) {
      const angle = variant.angle?.trim() || "Untagged";
      const style = variant.swipeId
        ? swipeStyleById.get(variant.swipeId) ?? null
        : variant.visualStyleId
          ? taxonomyById.get(variant.visualStyleId) ?? null
          : null;
      const key = `${angle}\u0000${style ?? ""}`;
      const current = tallies.get(key) ?? { angle, style, good: 0, bad: 0 };
      if (variant.mark === "good") current.good += 1;
      if (variant.mark === "bad") current.bad += 1;
      tallies.set(key, current);
    }

    const packageContext = packages.map((pkg) => ({
      angle: (pkg.angleId && taxonomyById.get(pkg.angleId)) || "Untagged",
      name: pkg.name,
      primaryText: pkg.primaryText,
      headline: pkg.headline,
      description: pkg.description,
    }));
    const swipeContext = untriedSwipes.map((swipe) => ({
      id: swipe.id,
      brandName: swipe.brandName,
      whyItWorks: swipe.whyItWorks,
      angle: swipe.angleId ? taxonomyById.get(swipe.angleId) : null,
      style: swipe.visualStyleId
        ? taxonomyById.get(swipe.visualStyleId)
        : null,
    }));
    const marketByAngle = new Map<
      string,
      { angle: string | null; shipped: number; spend: number; roasValues: number[] }
    >();
    for (const row of marketRows) {
      const key = row.angle?.trim() || "Untagged";
      const entry =
        marketByAngle.get(key) ??
        { angle: row.angle?.trim() || "Untagged", shipped: 0, spend: 0, roasValues: [] };
      entry.shipped += 1;
      entry.spend += row.spend ?? 0;
      if (row.roas != null) entry.roasValues.push(row.roas);
      marketByAngle.set(key, entry);
    }
    const marketResults = Array.from(marketByAngle.values()).map((entry) => ({
      angle: entry.angle,
      shipped: entry.shipped,
      avgRoas:
        entry.roasValues.length > 0
          ? entry.roasValues.reduce((sum, roas) => sum + roas, 0) /
            entry.roasValues.length
          : null,
      spend: entry.spend > 0 ? entry.spend : null,
    }));

    const prompt = buildWeeklySuggestionPrompt({
      winners: winners.map((winner) => ({
        name: winner.name,
        angle: winner.angle,
        roas: winner.roas,
        purchases: winner.purchases,
        spend: winner.spend,
        trend: winner.trend,
        format: winner.format,
      })),
      skips,
      tallies: Array.from(tallies.values()),
      untriedSwipes: swipeContext,
      copyPackages: packageContext,
      visualStyles: taxonomy
        .filter((value) => value.kind === "visual_style" && !value.archivedAt)
        .map((value) => value.name),
      brand,
      marketResults,
    });

    if (winners.length === 0 && untriedSwipes.length === 0) {
      await expireProposals(payload.organizationId);
      return { cards: 0 };
    }

    const sources = [
      ...winners.map((winner) => ({ type: "winner" as const, winner })),
      ...untriedSwipes.map((swipe) => ({ type: "swipe" as const, swipe })),
    ];
    const promptWithSources = `${prompt}\n\nSOURCE ORDER\n${JSON.stringify(
      sources.map((source, index) => ({ order: index + 1, ...source })),
      null,
      2,
    )}`;
    const system =
      "You are a senior DTC creative strategist. Return one concise production card per useful sourceOrder, 6 cards at most. Use rebrand_swipe for swipe sources. Make titles, reasons, briefs, and element values plain language. Never invent performance numbers. Use exactly 3 or 4 variants. Every card must include a one-sentence hypothesis naming the single variable being tested and the evidence it rests on: winner trend, Good/Bad tallies, or swipe why-it-works. Set visualStyle to null or one exact value from AVAILABLE VISUAL STYLES. For winner sources, declining or paused trend requires kind refresh; rising or stable trend requires new_hooks or new_format and must never use refresh.";
    async function generateCards(multimodal: boolean) {
      if (!multimodal) {
        return generateObject({
          model: openai(SUGGESTION_MODEL),
          output: "array",
          schema: studioSuggestionCardSchema,
          system,
          prompt: promptWithSources,
        });
      }

      const content: Array<
        { type: "text"; text: string } | { type: "image"; image: URL }
      > = [{ type: "text", text: promptWithSources }];
      let imageCount = 0;
      for (const [index, winner] of winners.entries()) {
        if (imageCount >= 8) break;
        if (!winner.assetUrl || isVideoFile(winner.assetUrl)) continue;
        content.push({
          type: "text",
          text: `WINNER ${index + 1} IMAGE — ${winner.name}`,
        });
        content.push({ type: "image", image: new URL(winner.assetUrl) });
        imageCount += 1;
      }
      for (const swipe of untriedSwipes) {
        if (imageCount >= 8) break;
        content.push({
          type: "text",
          text: `SWIPE IMAGE — ${swipe.brandName ?? "saved swipe"}`,
        });
        content.push({ type: "image", image: new URL(swipe.imageUrl) });
        imageCount += 1;
      }

      return generateObject({
        model: openai(SUGGESTION_MODEL),
        output: "array",
        schema: studioSuggestionCardSchema,
        system,
        messages: [{ role: "user", content }],
      });
    }
    const result = await generateCards(true).catch(() => generateCards(false));
    const cards = result.object.slice(0, 6);

    await db.transaction(async (tx) => {
      await tx
        .update(studioSuggestions)
        .set({ status: "expired", actionedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(studioSuggestions.organizationId, payload.organizationId),
            eq(studioSuggestions.status, "proposed"),
          ),
        );

      for (const card of cards) {
        const source = sources[card.sourceOrder - 1];
        if (!source) continue;
        const winner = source.type === "winner" ? source.winner : null;
        const swipe = source.type === "swipe" ? source.swipe : null;
        const angle =
          winner?.angle?.trim() ||
          (swipe?.angleId ? taxonomyById.get(swipe.angleId) : null) ||
          null;
        const angleValue = taxonomy.find(
          (value) => value.kind === "angle" && value.name === angle,
        );
        const defaultPackage = packages.find(
          (pkg) => pkg.angleId && pkg.angleId === angleValue?.id,
        );
        const visualStyleValue = card.visualStyle
          ? taxonomy.find(
              (value) =>
                value.kind === "visual_style" &&
                value.slug === studioSlug(card.visualStyle ?? ""),
            )
          : null;

        await tx.insert(studioSuggestions).values({
          organizationId: payload.organizationId,
          sourceCreativeId: winner?.creativeId ?? null,
          swipeId: swipe?.id ?? null,
          kind: swipe ? "rebrand_swipe" : card.kind,
          title: card.title,
          whyLine: card.whyLine,
          hypothesis: card.hypothesis,
          brief: swipe
            ? buildRebrandBrief({
                brandName: brand?.brandName,
                sourceBrandName: swipe.brandName,
              })
            : card.brief,
          elements: swipe?.elements ?? card.elements,
          angle,
          angleId: angleValue?.id ?? swipe?.angleId ?? null,
          visualStyleId: swipe?.visualStyleId ?? visualStyleValue?.id ?? null,
          persona: winner?.persona ?? null,
          awarenessLevel: (winner?.awarenessLevel as AwarenessLevel | null) ?? null,
          roas: winner ? String(winner.roas) : null,
          purchases: winner?.purchases ?? null,
          spend: winner ? String(winner.spend) : null,
          format: isStudioFormat(card.format) ? card.format : "square",
          count: card.count,
          copyPackageId: defaultPackage?.id ?? null,
          status: "proposed",
        });
      }
    });

    logger.info("Generated Studio weekly queue", {
      organizationId: payload.organizationId,
      cards: cards.length,
    });
    return { cards: cards.length };
  },
});

async function expireProposals(organizationId: string) {
  return db
    .update(studioSuggestions)
    .set({ status: "expired", actionedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(studioSuggestions.organizationId, organizationId),
        eq(studioSuggestions.status, "proposed"),
      ),
    );
}

export const studioWeeklySuggestionsScheduled = schedules.task({
  id: "studio-weekly-suggestions",
  cron: "0 8 * * 1",
  run: async () => {
    const organizations = await db.select({ id: organization.id }).from(organization);
    for (const row of organizations) {
      await generateStudioSuggestionsTask.trigger({
        organizationId: row.id,
        force: true,
      });
    }
    return { organizations: organizations.length };
  },
});
