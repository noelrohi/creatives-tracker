import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_generateImage as generateImage, generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import { put } from "@vercel/blob";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import type { AwarenessLevel } from "@/lib/awareness";
import {
  artDirectionFor,
  buildPrompt,
  buildPromptRewrite,
  classifyPromptClaims,
  studioSizeFor,
  variantPromptFor,
  type StudioFormat,
} from "@/lib/studio-prompt";
import { fetchRemoteImage } from "@/lib/remote-image";
import { getStudioBrandProfile, type StudioBrandProfile } from "@/lib/studio-brand";
import { moderationReasonFromError } from "@/lib/studio-moderation";
import {
  failStudioGeneration,
  finalizeStudioGenerationIfSettled,
} from "@/lib/studio-generation-status";
import { studioVariants } from "@/schema/studio";

const GENERATION_MODEL = "gpt-image-2";
const REWRITE_MODEL = "gpt-5.6-terra";

const rewrittenPromptsSchema = z.object({
  prompts: z.array(z.string().trim().min(1)).min(1).max(8),
});

/**
 * Turns the layered brief into one short concrete prompt per variant. Returns
 * null when the rewrite fails so the caller can fall back to template prompts.
 */
async function rewriteVariantPrompts(
  payload: GenerateStaticAdsPayload,
  format: StudioFormat,
  hasReferenceImages: boolean,
  brand: StudioBrandProfile | null,
  claimsRetryInstruction?: string,
): Promise<string[] | null> {
  try {
    const { system, prompt } = buildPromptRewrite({
      brief: payload.brief,
      angle: payload.angle,
      persona: payload.persona,
      awarenessLevel: payload.awarenessLevel,
      count: payload.count,
      format,
      hasReferenceImages,
      brand,
      hasProductImage: Boolean(brand?.productImageUrl),
    });
    // The rewriter sees the actual images so its scene descriptions match the
    // real reference layout instead of an invented one; product photo last.
    const content: Array<
      { type: "text"; text: string } | { type: "image"; image: URL }
    > = [{
      type: "text",
      text: claimsRetryInstruction
        ? `${prompt}\n\nREWRITE RETRY\n${claimsRetryInstruction}`
        : prompt,
    }];
    for (const url of (payload.referenceImageUrls ?? []).slice(0, 3)) {
      content.push({ type: "image", image: new URL(url) });
    }
    if (brand?.productImageUrl) {
      content.push({ type: "image", image: new URL(brand.productImageUrl) });
    }
    const result = await logger.trace("Rewrite variant prompts", () =>
      generateObject({
        model: openai(REWRITE_MODEL),
        schema: rewrittenPromptsSchema,
        system,
        messages: [{ role: "user", content }],
      }),
    );
    const prompts = result.object.prompts;
    return Array.from(
      { length: payload.count },
      (_, index) => prompts[index % prompts.length],
    );
  } catch (error) {
    logger.warn("Prompt rewrite failed; falling back to template prompts", {
      generationId: payload.generationId,
      organizationId: payload.organizationId,
      error,
    });
    return null;
  }
}

export type { StudioFormat };

export type GenerateStaticAdsPayload = {
  generationId: string;
  organizationId: string;
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel | null;
  count: number;
  format?: StudioFormat;
  referenceImageUrls?: string[];
};

export type GenerateStaticAdVariantPayload = {
  generationId: string;
  organizationId: string;
  variantIndex: number;
  basePrompt: string;
  artDirection: string | null;
  format: StudioFormat;
  referenceImageUrls?: string[];
  /**
   * Set when the variant is triggered standalone (per-variant retry): the
   * child finalizes the generation status once no siblings are in flight.
   */
  finalizeGeneration?: boolean;
};

export type VariantStatus = "pending" | "generating" | "ready" | "failed";
export type StudioModerationReason =
  | ReturnType<typeof moderationReasonFromError>
  | "claims";

export type GeneratedVariant = {
  index: number;
  status: VariantStatus;
  url?: string;
};

function setParentVariantMetadata(variant: GeneratedVariant) {
  // No-op when the variant task runs standalone (per-variant retry).
  try {
    metadata.parent.set(`variant:${variant.index}`, variant);
  } catch {
    // ignore — no parent run
  }
}

async function persistStudioUpdate<T>(
  operation: string,
  write: () => Promise<T>,
  context: Record<string, unknown>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    logger.error("Studio persistence failed", {
      operation,
      ...context,
      error,
    });
    throw error;
  }
}

async function generateImageWithOpenAi(
  variantPrompt: string,
  referenceImages: Uint8Array[],
  format: StudioFormat,
) {
  const result = await generateImage({
    model: openai.image(GENERATION_MODEL),
    prompt:
      referenceImages.length > 0
        ? { text: variantPrompt, images: referenceImages }
        : variantPrompt,
    size: studioSizeFor(format),
  });

  return result.image.uint8Array;
}

async function generateImageWithLocalCli({
  ima2Bin,
  variantPrompt,
  runId,
  variantIndex,
  referenceImagePaths,
  format,
}: {
  ima2Bin: string;
  variantPrompt: string;
  runId: string;
  variantIndex: number;
  referenceImagePaths: string[];
  format: StudioFormat;
}) {
  const tmpOut = path.join(
    tmpdir(),
    `static-ad-${runId}-${variantIndex}-${randomUUID()}.png`,
  );
  const args = [
    "gen",
    "--stdin",
    "-o",
    tmpOut,
    "--size",
    studioSizeFor(format),
    "--quality",
    "low",
    "--json",
  ];

  for (const referenceImagePath of referenceImagePaths) {
    args.push("--ref", referenceImagePath);
  }

  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(ima2Bin, args);
      const stderrChunks: Buffer[] = [];

      // Swallow stdin stream errors (e.g. EPIPE when the process fails to
      // spawn); the child "error"/"close" handlers surface the real failure.
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (error) => {
        const capturedStderr = Buffer.concat(stderrChunks).toString("utf8").trim();

        reject(
          new Error(
            `ima2 spawn failed${
              capturedStderr ? `: ${capturedStderr}` : `: ${error.message}`
            }`,
            { cause: error },
          ),
        );
      });
      child.on("close", (code) => {
        const capturedStderr = Buffer.concat(stderrChunks).toString("utf8").trim();

        if (code === 0) {
          resolve(capturedStderr);
          return;
        }

        reject(
          new Error(
            `ima2 exited with code ${code}${
              capturedStderr ? `: ${capturedStderr}` : ""
            }`,
          ),
        );
      });

      child.stdin.end(variantPrompt);
    });

    try {
      return await readFile(tmpOut);
    } catch (error) {
      throw new Error(
        `ima2 did not write output file${stderr ? `: ${stderr}` : ""}`,
        { cause: error },
      );
    }
  } finally {
    await rm(tmpOut, { force: true });
  }
}

export const generateStaticAdVariantTask = task({
  id: "generate-static-ad-variant",
  queue: { concurrencyLimit: 4 },
  maxDuration: 300,
  run: async (payload: GenerateStaticAdVariantPayload, { ctx }) => {
    const useLocalCli =
      process.env.NODE_ENV !== "production" &&
      process.env.STUDIO_DISABLE_LOCAL_CLI !== "1";
    const ima2Bin = process.env.IMA2_BIN ?? "ima2";
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const index = payload.variantIndex;
    const variantPrompt = variantPromptFor(payload.basePrompt, payload.artDirection);

    const markVariant = (values: {
      status: VariantStatus;
      imageUrl?: string | null;
      prompt?: string;
      moderationReason?: StudioModerationReason;
    }) =>
      persistStudioUpdate(
        `mark variant ${values.status}`,
        () =>
          db
            .update(studioVariants)
            .set({ ...values, updatedAt: new Date() })
            .where(
              and(
                eq(studioVariants.generationId, payload.generationId),
                eq(studioVariants.organizationId, payload.organizationId),
                eq(studioVariants.index, index),
              ),
            ),
        {
          generationId: payload.generationId,
          organizationId: payload.organizationId,
          runId: ctx.run.id,
          variantIndex: index,
        },
      );

    const finalizeIfRequested = async () => {
      if (!payload.finalizeGeneration) return;
      await persistStudioUpdate(
        "finalize generation status",
        () =>
          finalizeStudioGenerationIfSettled(
            payload.generationId,
            payload.organizationId,
          ),
        {
          generationId: payload.generationId,
          organizationId: payload.organizationId,
          runId: ctx.run.id,
        },
      );
    };

    await markVariant({ status: "generating" });
    setParentVariantMetadata({ index, status: "generating" });

    const referenceImagePaths: string[] = [];

    try {
      const referenceImages: Uint8Array[] = [];
      for (const url of payload.referenceImageUrls ?? []) {
        referenceImages.push(
          await logger.trace("Fetch reference image", () => fetchRemoteImage(url), {
            attributes: { "studio.reference_image_url": url },
          }),
        );
      }

      if (useLocalCli) {
        for (const image of referenceImages) {
          const refPath = path.join(
            tmpdir(),
            `static-ad-ref-${ctx.run.id}-${randomUUID()}.png`,
          );
          await writeFile(refPath, image);
          referenceImagePaths.push(refPath);
        }
      }

      const imageBytes = await logger.trace(
        `Generate variant ${index + 1}`,
        () =>
          useLocalCli
            ? generateImageWithLocalCli({
                ima2Bin,
                variantPrompt,
                runId: ctx.run.id,
                variantIndex: index,
                referenceImagePaths,
                format: payload.format,
              })
            : generateImageWithOpenAi(variantPrompt, referenceImages, payload.format),
        {
          attributes: {
            "studio.variant": index + 1,
            "studio.format": payload.format,
          },
        },
      );

      const blob = await logger.trace(`Upload variant ${index + 1}`, () =>
        put(`${env}/create/${ctx.run.id}-${index}.png`, Buffer.from(imageBytes), {
          access: "public",
          contentType: "image/png",
        }),
      );

      await markVariant({
        status: "ready",
        imageUrl: blob.url,
        prompt: variantPrompt,
        moderationReason: null,
      });
      setParentVariantMetadata({ index, status: "ready", url: blob.url });

      await finalizeIfRequested();

      return { index, status: "ready" as const, url: blob.url };
    } catch (error) {
      logger.error("Static ad variant generation failed", {
        organizationId: payload.organizationId,
        runId: ctx.run.id,
        variantIndex: index,
        error,
      });
      await markVariant({
        status: "failed",
        prompt: variantPrompt,
        moderationReason: moderationReasonFromError(error),
      });
      setParentVariantMetadata({ index, status: "failed" });

      await finalizeIfRequested();

      return { index, status: "failed" as const };
    } finally {
      for (const refPath of referenceImagePaths) {
        await rm(refPath, { force: true });
      }
    }
  },
});

export const generateStaticAdsTask = task({
  id: "generate-static-ads",
  queue: { concurrencyLimit: 3 },
  maxDuration: 900,
  run: async (payload: GenerateStaticAdsPayload, { ctx }) => {
    await tags.add(`create:org:${payload.organizationId}`);

    const format = payload.format ?? "square";
    const layoutReferenceUrls = payload.referenceImageUrls ?? [];
    const hasReferenceImages = layoutReferenceUrls.length > 0;
    const variants: GeneratedVariant[] = Array.from(
      { length: payload.count },
      (_, index) => ({ index, status: "pending" }),
    );

    metadata.set("status", "generating");
    metadata.set("brief", payload.brief);
    metadata.set("angle", payload.angle ?? null);
    metadata.set("variants", variants);

    const brand = await getStudioBrandProfile(payload.organizationId);
    // The product photo goes last so "the last reference image" in the
    // rewrite rules stays true regardless of layout references.
    const referenceImageUrls =
      brand?.productImageUrl &&
      !layoutReferenceUrls.includes(brand.productImageUrl)
        ? [...layoutReferenceUrls, brand.productImageUrl]
        : payload.referenceImageUrls;

    let rewrittenPrompts = await rewriteVariantPrompts(
      payload,
      format,
      hasReferenceImages,
      brand,
    );
    const fallbackPrompt = buildPrompt({ ...payload, format, brand });
    let finalPrompts = Array.from(
      { length: payload.count },
      (_, index) => rewrittenPrompts?.[index] ?? fallbackPrompt,
    );
    const prohibitedClaims = brand?.prohibitedClaims ?? [];
    const initialClaimsCheck = classifyPromptClaims({
      prompts: finalPrompts,
      prohibitedClaims,
      retried: false,
    });
    if (initialClaimsCheck.action === "retry") {
      rewrittenPrompts = await rewriteVariantPrompts(
        payload,
        format,
        hasReferenceImages,
        brand,
        initialClaimsCheck.retryInstruction,
      );
      finalPrompts = Array.from(
        { length: payload.count },
        (_, index) => rewrittenPrompts?.[index] ?? finalPrompts[index],
      );
    }
    const claimsFailures = new Set<number>();
    for (const [index, prompt] of finalPrompts.entries()) {
      if (
        classifyPromptClaims({
          prompts: [prompt],
          prohibitedClaims,
          retried: initialClaimsCheck.action === "retry",
        }).action === "claims"
      ) {
        claimsFailures.add(index);
      }
    }

    try {
      for (const index of claimsFailures) {
        await persistStudioUpdate(
          "mark claims-blocked variant failed",
          () =>
            db
              .update(studioVariants)
              .set({
                status: "failed",
                prompt: finalPrompts[index],
                moderationReason: "claims",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(studioVariants.generationId, payload.generationId),
                  eq(studioVariants.organizationId, payload.organizationId),
                  eq(studioVariants.index, index),
                ),
              ),
          {
            generationId: payload.generationId,
            organizationId: payload.organizationId,
            runId: ctx.run.id,
            variantIndex: index,
          },
        );
        variants[index] = { index, status: "failed" };
      }
      const safeVariants = variants.filter(
        (variant) => !claimsFailures.has(variant.index),
      );
      const batch = safeVariants.length > 0
        ? await generateStaticAdVariantTask.batchTriggerAndWait(
            safeVariants.map((variant) => ({
              payload: {
                generationId: payload.generationId,
                organizationId: payload.organizationId,
                variantIndex: variant.index,
                basePrompt: finalPrompts[variant.index],
                artDirection: rewrittenPrompts
                  ? null
                  : artDirectionFor(
                      variant.index,
                      payload.count,
                      hasReferenceImages,
                    ),
                format,
                referenceImageUrls,
              } satisfies GenerateStaticAdVariantPayload,
            })),
          )
        : null;

      for (const run of batch?.runs ?? []) {
        if (run.ok) {
          variants[run.output.index] = {
            index: run.output.index,
            status: run.output.status,
            url: run.output.status === "ready" ? run.output.url : undefined,
          };
        }
      }

      // Runs that crashed without returning output stay pending in memory;
      // read the DB rows as the source of truth for the final rollup.
      const rows = await db
        .select({
          index: studioVariants.index,
          status: studioVariants.status,
          imageUrl: studioVariants.imageUrl,
        })
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.generationId, payload.generationId),
            eq(studioVariants.organizationId, payload.organizationId),
          ),
        )
        .orderBy(asc(studioVariants.index));

      for (const row of rows) {
        const status =
          row.status === "pending" || row.status === "generating"
            ? "failed"
            : (row.status as VariantStatus);
        variants[row.index] = {
          index: row.index,
          status,
          url: row.imageUrl ?? undefined,
        };
        if (status === "failed" && row.status !== "failed") {
          await persistStudioUpdate(
            "mark stranded variant failed",
            () =>
              db
                .update(studioVariants)
                .set({ status: "failed", updatedAt: new Date() })
                .where(
                  and(
                    eq(studioVariants.generationId, payload.generationId),
                    eq(studioVariants.organizationId, payload.organizationId),
                    eq(studioVariants.index, row.index),
                  ),
                ),
            {
              generationId: payload.generationId,
              organizationId: payload.organizationId,
              runId: ctx.run.id,
              variantIndex: row.index,
            },
          );
        }
      }

      const completedStatus = await persistStudioUpdate(
        "mark generation completed",
        () =>
          finalizeStudioGenerationIfSettled(
            payload.generationId,
            payload.organizationId,
          ),
        {
          generationId: payload.generationId,
          organizationId: payload.organizationId,
          runId: ctx.run.id,
        },
      );
      if (!completedStatus) {
        throw new Error("Cannot finalize generation while variants are still in flight");
      }

      metadata.set("status", completedStatus);
      metadata.set("variants", variants);

      return { variants };
    } catch (error) {
      metadata.set("status", "failed");
      await persistStudioUpdate(
        "mark generation failed after unexpected error",
        () => failStudioGeneration(payload.generationId, payload.organizationId),
        {
          generationId: payload.generationId,
          organizationId: payload.organizationId,
          runId: ctx.run.id,
        },
      );
      throw error;
    }
  },
});
