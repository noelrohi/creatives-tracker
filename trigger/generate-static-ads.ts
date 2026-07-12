import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_generateImage as generateImage } from "ai";
import { openai } from "@ai-sdk/openai";
import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import { put } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { AwarenessLevel } from "@/lib/awareness";
import { studioGenerations, studioVariants } from "@/schema/studio";

const GENERATION_MODEL = "gpt-image-2";

export type GenerateStaticAdsPayload = {
  generationId: string;
  organizationId: string;
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel | null;
  count: number;
  referenceImageUrls?: string[];
};

export type VariantStatus = "pending" | "generating" | "ready" | "failed";

export type GeneratedVariant = {
  index: number;
  status: VariantStatus;
  url?: string;
};

function buildPrompt(payload: GenerateStaticAdsPayload) {
  const details = [
    `Brief: ${payload.brief}`,
    payload.angle ? `Angle: ${payload.angle}` : null,
    payload.persona ? `Persona: ${payload.persona}` : null,
    payload.awarenessLevel
      ? `Awareness level: ${payload.awarenessLevel.replace(/_/g, " ")}`
      : null,
  ].filter(Boolean);

  return [
    "Create a polished portrait static ad image for paid social.",
    "Use strong visual hierarchy, direct-response clarity, and a premium ecommerce feel.",
    "Do not include platform UI, watermarks, or unrelated brand logos.",
    ...details,
  ].join("\n");
}

function setRunMetadata(
  status: "generating" | "completed" | "failed",
  payload: GenerateStaticAdsPayload,
  variants: GeneratedVariant[],
) {
  metadata.set("status", status);
  metadata.set("brief", payload.brief);
  metadata.set("angle", payload.angle ?? null);
  metadata.set("variants", variants);
}

async function persistStudioUpdate(
  operation: string,
  write: () => Promise<unknown>,
  context: Record<string, unknown>,
) {
  try {
    await write();
  } catch (error) {
    logger.error("Studio persistence failed", {
      operation,
      ...context,
      error,
    });
  }
}

async function fetchReferenceImage(url: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch reference image: ${response.status} ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function generateImageWithOpenAi(
  variantPrompt: string,
  referenceImage: Uint8Array | undefined,
) {
  const result = await generateImage({
    model: openai.image(GENERATION_MODEL),
    prompt: referenceImage
      ? { text: variantPrompt, images: [referenceImage] }
      : variantPrompt,
    size: "1024x1536",
  });

  return result.image.uint8Array;
}

async function generateImageWithLocalCli({
  ima2Bin,
  variantPrompt,
  runId,
  variantIndex,
  referenceImagePath,
}: {
  ima2Bin: string;
  variantPrompt: string;
  runId: string;
  variantIndex: number;
  referenceImagePath: string | undefined;
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
    "1024x1536",
    "--quality",
    "low",
    "--json",
  ];

  if (referenceImagePath) {
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

async function generateVariantImage({
  useLocalCli,
  ima2Bin,
  variantPrompt,
  referenceImage,
  referenceImagePath,
  runId,
  variantIndex,
}: {
  useLocalCli: boolean;
  ima2Bin: string;
  variantPrompt: string;
  referenceImage: Uint8Array | undefined;
  referenceImagePath: string | undefined;
  runId: string;
  variantIndex: number;
}) {
  if (useLocalCli) {
    return generateImageWithLocalCli({
      ima2Bin,
      variantPrompt,
      runId,
      variantIndex,
      referenceImagePath,
    });
  }

  return generateImageWithOpenAi(variantPrompt, referenceImage);
}

export const generateStaticAdsTask = task({
  id: "generate-static-ads",
  queue: { concurrencyLimit: 3 },
  run: async (payload: GenerateStaticAdsPayload, { ctx }) => {
    const useLocalCli =
      process.env.NODE_ENV !== "production" &&
      process.env.STUDIO_DISABLE_LOCAL_CLI !== "1";
    const ima2Bin = process.env.IMA2_BIN ?? "ima2";

    await tags.add(`create:org:${payload.organizationId}`);

    const prompt = buildPrompt(payload);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const variants: GeneratedVariant[] = Array.from(
      { length: payload.count },
      (_, index) => ({ index, status: "pending" }),
    );

    setRunMetadata("generating", payload, variants);

    const referenceImageUrl = payload.referenceImageUrls?.[0];
    let referenceImage: Uint8Array | undefined;

    if (referenceImageUrl) {
      try {
        referenceImage = await fetchReferenceImage(referenceImageUrl);
      } catch (error) {
        logger.error("Failed to fetch reference image", {
          organizationId: payload.organizationId,
          runId: ctx.run.id,
          referenceImageUrl,
          error,
        });
        metadata.set(
          "error",
          "Couldn't load the attached reference image. Please try again.",
        );
        setRunMetadata("failed", payload, variants);
        await persistStudioUpdate(
          "mark generation failed after reference image fetch error",
          () =>
            db
              .update(studioGenerations)
              .set({ status: "failed", updatedAt: new Date() })
              .where(eq(studioGenerations.id, payload.generationId)),
          {
            generationId: payload.generationId,
            organizationId: payload.organizationId,
            runId: ctx.run.id,
          },
        );
        throw new Error(
          `Failed to fetch reference image: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const referenceImagePath =
      useLocalCli && referenceImage
        ? path.join(tmpdir(), `static-ad-ref-${ctx.run.id}-${randomUUID()}.png`)
        : undefined;

    try {
      if (referenceImagePath && referenceImage) {
        await writeFile(referenceImagePath, referenceImage);
      }

      for (let i = 0; i < variants.length; i += 1) {
        variants[i] = { ...variants[i], status: "generating" };
        setRunMetadata("generating", payload, variants);

        try {
          const variantPrompt = `${prompt}\nVariant: ${i + 1} of ${variants.length}.`;
          const imageBytes = await generateVariantImage({
            useLocalCli,
            ima2Bin,
            variantPrompt,
            referenceImage,
            referenceImagePath,
            runId: ctx.run.id,
            variantIndex: i,
          });

          const blob = await put(
            `${env}/create/${ctx.run.id}-${i}.png`,
            Buffer.from(imageBytes),
            {
              access: "public",
              contentType: "image/png",
            },
          );

          variants[i] = { index: i, status: "ready", url: blob.url };
          await persistStudioUpdate(
            "mark variant ready",
            () =>
              db
                .update(studioVariants)
                .set({
                  status: "ready",
                  imageUrl: blob.url,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(studioVariants.generationId, payload.generationId),
                    eq(studioVariants.index, i),
                  ),
                ),
            {
              generationId: payload.generationId,
              organizationId: payload.organizationId,
              runId: ctx.run.id,
              variantIndex: i,
            },
          );
        } catch (error) {
          logger.error("Static ad variant generation failed", {
            organizationId: payload.organizationId,
            runId: ctx.run.id,
            variantIndex: i,
            error,
          });
          variants[i] = { index: i, status: "failed" };
          await persistStudioUpdate(
            "mark variant failed",
            () =>
              db
                .update(studioVariants)
                .set({ status: "failed", updatedAt: new Date() })
                .where(
                  and(
                    eq(studioVariants.generationId, payload.generationId),
                    eq(studioVariants.index, i),
                  ),
                ),
            {
              generationId: payload.generationId,
              organizationId: payload.organizationId,
              runId: ctx.run.id,
              variantIndex: i,
            },
          );
        }

        setRunMetadata("generating", payload, variants);
      }
    } finally {
      if (referenceImagePath) {
        await rm(referenceImagePath, { force: true });
      }
    }

    const completedStatus = variants.some((variant) => variant.status === "ready")
      ? "completed"
      : "failed";
    await persistStudioUpdate(
      "mark generation completed",
      () =>
        db
          .update(studioGenerations)
          .set({ status: completedStatus, updatedAt: new Date() })
          .where(eq(studioGenerations.id, payload.generationId)),
      {
        generationId: payload.generationId,
        organizationId: payload.organizationId,
        runId: ctx.run.id,
        status: completedStatus,
      },
    );
    setRunMetadata(completedStatus, payload, variants);

    return { variants };
  },
});
