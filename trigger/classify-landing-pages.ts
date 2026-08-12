/** Durable landing-page classification with bounded child batches. */
import { generateObject } from "ai";
import { logger, metadata, schedules, tags, task } from "@trigger.dev/sdk";
import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
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

const CLASSIFY_MODEL = "gpt-5.6-luna";
const PAGE_BATCH_SIZE = 10;
const MAX_ITERATIONS = 500;
const RECLASSIFY_AFTER_DAYS = 7;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 12_000;

export type ClassifyLandingPagesPayload = {
  organizationId: string;
  /** Records handled by each bounded child task. */
  limit?: number;
  maxIterations?: number;
};

type PageCursor = { classifiedAt: string | null; id: string };

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

function requireModelConfiguration() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for landing-page classification");
  }
}

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
      "user-agent":
        "Mozilla/5.0 (compatible; AdsoluteBot/1.0; +https://adsolute.app)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return stripHtmlToText(await response.text());
}

function afterPageCursor(cursor: PageCursor | null | undefined) {
  if (!cursor) return undefined;
  if (cursor.classifiedAt === null) {
    return or(
      and(isNull(landingPages.classifiedAt), gt(landingPages.id, cursor.id)),
      isNotNull(landingPages.classifiedAt),
    );
  }

  const classifiedAt = new Date(cursor.classifiedAt);
  return or(
    gt(landingPages.classifiedAt, classifiedAt),
    and(
      eq(landingPages.classifiedAt, classifiedAt),
      gt(landingPages.id, cursor.id),
    ),
  );
}

async function classifyDuePageBatch(params: {
  organizationId: string;
  limit: number;
  now: Date;
  cursor?: PageCursor | null;
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
      classifiedAt: landingPages.classifiedAt,
    })
    .from(landingPages)
    .where(
      and(
        eq(landingPages.organizationId, params.organizationId),
        or(
          isNull(landingPages.classifiedAt),
          lt(landingPages.classifiedAt, dueBefore),
        ),
        afterPageCursor(params.cursor),
      ),
    )
    // PostgreSQL requires ASC before NULLS FIRST.
    .orderBy(
      sql`${landingPages.classifiedAt} asc nulls first`,
      asc(landingPages.id),
    )
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

  const last = candidates.at(-1);
  return {
    candidates: candidates.length,
    fetched,
    classified,
    markedStale,
    touched,
    failed,
    nextCursor: last
      ? { classifiedAt: last.classifiedAt?.toISOString() ?? null, id: last.id }
      : null,
  };
}

export const classifyLandingPagesBatchTask = task({
  id: "classify-landing-pages-batch",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: { name: "classify-landing-pages-batch", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload: {
    organizationId: string;
    limit: number;
    now: string;
    cursor?: PageCursor | null;
  }) => {
    requireModelConfiguration();
    return classifyDuePageBatch({
      organizationId: payload.organizationId,
      limit: payload.limit,
      now: new Date(payload.now),
      cursor: payload.cursor,
    });
  },
});

export const classifyLandingPagesTask = task({
  id: "classify-landing-pages",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: { name: "classify-landing-pages", concurrencyLimit: 1 },
  maxDuration: 3600,
  run: async (payload: ClassifyLandingPagesPayload) => {
    await tags.add(`classify-landing-pages:org:${payload.organizationId}`);
    requireModelConfiguration();

    const limit = Math.max(1, Math.min(payload.limit ?? PAGE_BATCH_SIZE, PAGE_BATCH_SIZE));
    const maxIterations = payload.maxIterations ?? MAX_ITERATIONS;
    const now = new Date();
    let cursor: PageCursor | null = null;
    const totals = {
      candidates: 0,
      fetched: 0,
      classified: 0,
      markedStale: 0,
      touched: 0,
      failed: 0,
    };

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      metadata
        .set("status", "classifying")
        .set("step", `Classifying landing-page batch ${iteration + 1}`)
        .set("processed", totals.candidates)
        .set("classified", totals.classified)
        .set("failed", totals.failed)
        .set("cursor", cursor);
      const result = await classifyLandingPagesBatchTask.triggerAndWait({
        organizationId: payload.organizationId,
        limit,
        now: now.toISOString(),
        cursor,
      });
      if (!result.ok) {
        throw new Error(
          `Landing-page batch ${iteration + 1} failed after ${cursor?.id ?? "start"}: ${String(result.error)}`,
        );
      }

      totals.candidates += result.output.candidates;
      totals.fetched += result.output.fetched;
      totals.classified += result.output.classified;
      totals.markedStale += result.output.markedStale;
      totals.touched += result.output.touched;
      totals.failed += result.output.failed;
      if (!result.output.nextCursor) break;
      cursor = result.output.nextCursor;
    }

    metadata
      .set("status", "completed")
      .set("processed", totals.candidates)
      .set("classified", totals.classified)
      .set("failed", totals.failed);
    logger.info("Classified landing pages", {
      organizationId: payload.organizationId,
      ...totals,
    });
    return {
      ...totals,
      summary: `Classified ${totals.classified} landing pages (${totals.markedStale} marked stale, ${totals.failed} failed)`,
    };
  },
});

export const classifyLandingPagesScheduled = schedules.task({
  id: "classify-landing-pages-weekly",
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
      const result = await classifyLandingPagesTask.triggerAndWait({
        organizationId: org.organizationId,
      });
      if (!result.ok) {
        throw new Error(
          `Weekly landing-page classification failed for ${org.organizationId}: ${String(result.error)}`,
        );
      }
      results.push({ organizationId: org.organizationId, ...result.output });
    }
    return { organizations: organizations.length, results };
  },
});
