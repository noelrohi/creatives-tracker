/**
 * Landing-page classification (spec §5.3, §5.4).
 *
 * One pass per run: fetch each due page, strip it to text, hash it, and only
 * call the model when the write rules say fresh values are wanted. A human
 * confirmation is never overwritten — changed copy under a confirmed page goes
 * `stale` and waits for a person (see `planLandingPageClassification`).
 */
import { generateObject } from "ai";
import { logger, metadata, schedules, tags, task } from "@trigger.dev/sdk";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { openai } from "@/lib/ai";
import {
  contentHash,
  planLandingPageClassification,
  stripHtmlToText,
} from "@/lib/landing-page";
import {
  awarenessLevelEnum,
  funnelStageEnum,
  pageTypeEnum,
} from "@/schema/enums";
import { landingPages } from "@/schema/landing-page";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const CLASSIFY_MODEL = "gpt-5.6-terra";
const PAGE_BATCH_SIZE = 40;
/** Re-fetch cadence: a page classified within the week is not due again. */
const RECLASSIFY_AFTER_DAYS = 7;
const FETCH_TIMEOUT_MS = 20_000;
/** Enough copy to classify a long advertorial without a giant prompt. */
const MAX_TEXT_CHARS = 12_000;

export type ClassifyLandingPagesPayload = {
  organizationId: string;
  /** Pages per run; the rest are picked up by the next one. */
  limit?: number;
};

const classificationSchema = z.object({
  pageType: z.enum(pageTypeEnum.enumValues),
  pageTypeConfidence: z.number(),
  funnelStage: z.enum(funnelStageEnum.enumValues),
  funnelStageConfidence: z.number(),
  awarenessFit: z.enum(awarenessLevelEnum.enumValues),
  awarenessFitConfidence: z.number(),
});

const SYSTEM_PROMPT = [
  "You classify landing pages for a direct-to-consumer skincare brand. Paid social traffic (mostly Meta) lands on these pages, so read the page the way a shopper arriving from an ad would and judge what the page is doing, not what the brand sells.",
  "",
  "Return exactly these fields:",
  `- pageType: one of ${pageTypeEnum.enumValues.join(", ")}. product_page = a shop page for one product (price, variants, add to cart). advertorial = editorial-styled sales copy, usually a story or an article that sells. listicle = numbered or ranked list format. quiz = an interactive questionnaire that routes to a recommendation. other = anything else (home page, collection, policy, blog post that does not sell).`,
  `- funnelStage: one of ${funnelStageEnum.enumValues.join(", ")}. tof = written for a cold reader who does not know the brand: it explains the problem first. mof = written for someone comparing options: proof, mechanism, comparisons, reviews. bof = written to close: price, offer, guarantee, checkout.`,
  `- awarenessFit: one of ${awarenessLevelEnum.enumValues.join(", ")} — the reader this page's copy assumes, from unaware (does not know they have the problem) to most_aware (knows the product and needs only the offer).`,
  "- pageTypeConfidence, funnelStageConfidence, awarenessFitConfidence: a number from 0 to 1 for each, judged independently.",
  "",
  "Rules: judge only from the text supplied — never guess from the URL alone. Thin or truncated copy is a reason to report low confidence, not a reason to pick `other` by default. Report confidence honestly.",
].join("\n");

function buildUserPrompt(page: { normalizedUrl: string; text: string }) {
  return [
    `URL: ${page.normalizedUrl}`,
    "",
    "Page text:",
    page.text.slice(0, MAX_TEXT_CHARS),
  ].join("\n");
}

async function fetchPageText(normalizedUrl: string): Promise<string> {
  const response = await fetch(`https://${normalizedUrl}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Some storefronts serve a bare shell to unknown clients.
      "user-agent":
        "Mozilla/5.0 (compatible; AdsoluteBot/1.0; +https://adsolute.app)",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return stripHtmlToText(await response.text());
}

async function classifyDuePages(params: {
  organizationId: string;
  limit: number;
  now: Date;
}) {
  const dueBefore = new Date(
    params.now.getTime() - RECLASSIFY_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );

  const candidates = await db
    .select({
      id: landingPages.id,
      normalizedUrl: landingPages.normalizedUrl,
      classificationStatus: landingPages.classificationStatus,
      contentHash: landingPages.contentHash,
    })
    .from(landingPages)
    .where(
      and(
        eq(landingPages.organizationId, params.organizationId),
        or(
          isNull(landingPages.classifiedAt),
          lt(landingPages.classifiedAt, dueBefore),
        ),
      ),
    )
    // Never-classified pages first, then the longest unchecked.
    .orderBy(asc(sql`${landingPages.classifiedAt} nulls first`))
    .limit(params.limit);

  let fetched = 0;
  let classified = 0;
  let markedStale = 0;
  let touched = 0;
  let failed = 0;

  for (const page of candidates) {
    let text: string;
    try {
      text = await fetchPageText(page.normalizedUrl);
      fetched += 1;
    } catch (error) {
      // Skipped, not recorded: `classifiedAt` stays put so the page is due
      // again on the next run.
      failed += 1;
      logger.warn("Landing page fetch failed", {
        landingPageId: page.id,
        normalizedUrl: page.normalizedUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const hash = contentHash(text);
    const action = planLandingPageClassification({
      status: page.classificationStatus,
      priorHash: page.contentHash,
      newHash: hash,
    });

    if (action === "touch") {
      await db
        .update(landingPages)
        .set({ contentHash: hash, classifiedAt: params.now })
        .where(eq(landingPages.id, page.id));
      touched += 1;
      continue;
    }

    if (action === "mark_stale") {
      // The confirmed values stay exactly as the human left them.
      await db
        .update(landingPages)
        .set({
          classificationStatus: "stale",
          contentHash: hash,
          classifiedAt: params.now,
        })
        .where(eq(landingPages.id, page.id));
      markedStale += 1;
      continue;
    }

    try {
      const result = await generateObject({
        model: openai(CLASSIFY_MODEL),
        schema: classificationSchema,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt({ normalizedUrl: page.normalizedUrl, text }),
      });

      await db
        .update(landingPages)
        .set({
          pageType: result.object.pageType,
          funnelStage: result.object.funnelStage,
          awarenessFit: result.object.awarenessFit,
          classificationStatus: "suggested",
          classificationSource: "ai",
          // The funnel stage is the sliced field, so its confidence is the one
          // the diagnostics quote (§5.3).
          classificationConfidence: String(result.object.funnelStageConfidence),
          contentHash: hash,
          classifiedAt: params.now,
        })
        .where(eq(landingPages.id, page.id));
      classified += 1;
    } catch (error) {
      failed += 1;
      logger.error("Landing page classification failed", {
        landingPageId: page.id,
        normalizedUrl: page.normalizedUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidates: candidates.length,
    fetched,
    classified,
    markedStale,
    touched,
    failed,
  };
}

export const classifyLandingPagesTask = task({
  id: "classify-landing-pages",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: { name: "classify-landing-pages", concurrencyLimit: 1 },
  run: async (payload: ClassifyLandingPagesPayload) => {
    await tags.add(`classify-landing-pages:org:${payload.organizationId}`);

    metadata.set("status", "classifying");
    metadata.set("step", "Classifying landing pages");

    const result = await classifyDuePages({
      organizationId: payload.organizationId,
      limit: payload.limit ?? PAGE_BATCH_SIZE,
      now: new Date(),
    });

    metadata.set("status", "completed");
    logger.info("Classified landing pages", {
      organizationId: payload.organizationId,
      ...result,
    });

    return {
      ...result,
      summary: `Classified ${result.classified} landing pages (${result.markedStale} marked stale, ${result.failed} failed)`,
    };
  },
});

export const classifyLandingPagesScheduled = schedules.task({
  id: "classify-landing-pages-weekly",
  // Mondays 21:00 UTC — 5am PHT Tuesday. Page copy changes on the scale of
  // weeks, and this hour is clear of the Meta daily sync (18:00), the hourly
  // Shopify stamp and the daily checks (19:30), so the harvest that feeds it
  // has already run.
  cron: "0 21 * * 1",
  run: async () => {
    const organizations = await db
      .selectDistinct({ organizationId: landingPages.organizationId })
      .from(landingPages);

    if (organizations.length === 0) {
      logger.warn("No landing pages harvested yet — nothing to classify");
      return { organizations: 0, results: [] };
    }

    const results = [];
    for (const org of organizations) {
      results.push({
        organizationId: org.organizationId,
        ...(await classifyDuePages({
          organizationId: org.organizationId,
          limit: PAGE_BATCH_SIZE,
          now: new Date(),
        })),
      });
    }

    return { organizations: organizations.length, results };
  },
});
