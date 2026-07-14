import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_generateImage as generateImage } from "ai";
import { openai } from "@ai-sdk/openai";
import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import { put } from "@vercel/blob";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import type { AwarenessLevel } from "@/lib/awareness";
import {
  ART_DIRECTIONS,
  buildPrompt,
  studioSizeFor,
  variantPromptFor,
  type StudioFormat,
} from "@/lib/studio-prompt";
import { fetchRemoteImage } from "@/lib/remote-image";
import {
  failStudioGeneration,
  finalizeStudioGenerationIfSettled,
} from "@/lib/studio-generation-status";
import { studioVariants } from "@/schema/studio";

const GENERATION_MODEL = "gpt-image-2";

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

      await markVariant({ status: "ready", imageUrl: blob.url, prompt: variantPrompt });
      setParentVariantMetadata({ index, status: "ready", url: blob.url });

      if (payload.finalizeGeneration) {
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
      }

      return { index, status: "ready" as const, url: blob.url };
    } catch (error) {
      logger.error("Static ad variant generation failed", {
        organizationId: payload.organizationId,
        runId: ctx.run.id,
        variantIndex: index,
        error,
      });
      await markVariant({ status: "failed", prompt: variantPrompt });
      setParentVariantMetadata({ index, status: "failed" });

      if (payload.finalizeGeneration) {
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
      }

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
    const basePrompt = buildPrompt({ ...payload, format });
    const variants: GeneratedVariant[] = Array.from(
      { length: payload.count },
      (_, index) => ({ index, status: "pending" }),
    );

    metadata.set("status", "generating");
    metadata.set("brief", payload.brief);
    metadata.set("angle", payload.angle ?? null);
    metadata.set("variants", variants);

    try {
      const batch = await generateStaticAdVariantTask.batchTriggerAndWait(
        variants.map((variant) => ({
          payload: {
            generationId: payload.generationId,
            organizationId: payload.organizationId,
            variantIndex: variant.index,
            basePrompt,
            artDirection:
              payload.count > 1
                ? ART_DIRECTIONS[variant.index % ART_DIRECTIONS.length]
                : null,
            format,
            referenceImageUrls: payload.referenceImageUrls,
          } satisfies GenerateStaticAdVariantPayload,
        })),
      );

      for (const run of batch.runs) {
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
