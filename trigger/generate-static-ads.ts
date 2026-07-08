import { experimental_generateImage as generateImage } from "ai";
import { openai } from "@ai-sdk/openai";
import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import { put } from "@vercel/blob";

const GENERATION_MODEL = "gpt-image-2";

const AWARENESS_LABELS = {
  unaware: "unaware",
  problem_aware: "problem aware",
  solution_aware: "solution aware",
  product_aware: "product aware",
  most_aware: "most aware",
} as const;

export type GenerateStaticAdsPayload = {
  organizationId: string;
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: keyof typeof AWARENESS_LABELS | null;
  count: number;
};

type VariantStatus = "pending" | "generating" | "ready" | "failed";

type GeneratedVariant = {
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
      ? `Awareness level: ${AWARENESS_LABELS[payload.awarenessLevel]}`
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

export const generateStaticAdsTask = task({
  id: "generate-static-ads",
  queue: { concurrencyLimit: 3 },
  run: async (payload: GenerateStaticAdsPayload, { ctx }) => {
    await tags.add(`create:org:${payload.organizationId}`);

    const prompt = buildPrompt(payload);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const variants: GeneratedVariant[] = Array.from(
      { length: payload.count },
      (_, index) => ({ index, status: "pending" }),
    );

    setRunMetadata("generating", payload, variants);

    for (let i = 0; i < variants.length; i += 1) {
      variants[i] = { ...variants[i], status: "generating" };
      setRunMetadata("generating", payload, variants);

      try {
        const result = await generateImage({
          model: openai.image(GENERATION_MODEL),
          prompt: `${prompt}\nVariant: ${i + 1} of ${variants.length}.`,
          size: "1024x1536",
        });

        const blob = await put(
          `${env}/create/${ctx.run.id}-${i}.png`,
          Buffer.from(result.image.uint8Array),
          {
            access: "public",
            contentType: "image/png",
          },
        );

        variants[i] = { index: i, status: "ready", url: blob.url };
      } catch (error) {
        logger.error("Static ad variant generation failed", {
          organizationId: payload.organizationId,
          runId: ctx.run.id,
          variantIndex: i,
          error,
        });
        variants[i] = { index: i, status: "failed" };
      }

      setRunMetadata("generating", payload, variants);
    }

    const completedStatus = variants.some((variant) => variant.status === "ready")
      ? "completed"
      : "failed";
    setRunMetadata(completedStatus, payload, variants);

    return { variants };
  },
});
