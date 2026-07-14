import type { AwarenessLevel } from "@/lib/awareness";

export const STUDIO_FORMATS = {
  portrait: "1024x1536",
  square: "1024x1024",
  landscape: "1536x1024",
  widescreen: "1536x864",
  vertical: "864x1536",
} as const;

export type StudioPreset = keyof typeof STUDIO_FORMATS;
export type StudioSize = `${number}x${number}`;
export type StudioFormat = StudioPreset | StudioSize;

const STUDIO_SIZE_PATTERN = /^(\d+)x(\d+)$/;
const MIN_STUDIO_PIXELS = 655_360;
const MAX_STUDIO_PIXELS = 8_294_400;
const MAX_STUDIO_EDGE = 3_840;

export function isSupportedStudioSize(value: string): value is StudioSize {
  const match = STUDIO_SIZE_PATTERN.exec(value);
  if (!match) return false;

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  return (
    width > 0 &&
    height > 0 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    width <= MAX_STUDIO_EDGE &&
    height <= MAX_STUDIO_EDGE &&
    Math.max(width, height) / Math.min(width, height) <= 3 &&
    pixels >= MIN_STUDIO_PIXELS &&
    pixels <= MAX_STUDIO_PIXELS
  );
}

export function isStudioFormat(value: string): value is StudioFormat {
  return value in STUDIO_FORMATS || isSupportedStudioSize(value);
}

export function studioSizeFor(format: StudioFormat): StudioSize {
  return format in STUDIO_FORMATS
    ? STUDIO_FORMATS[format as StudioPreset]
    : (format as StudioSize);
}

export function studioDimensions(format: StudioFormat) {
  const [width, height] = studioSizeFor(format).split("x").map(Number);
  return { width, height };
}

export function studioAspectRatio(format: StudioFormat) {
  const { width, height } = studioDimensions(format);
  return `${width} / ${height}`;
}

// Rotated per variant index so a single brief yields visually distinct takes.
export const ART_DIRECTIONS = [
  "Hero product close-up on a clean seamless background with dramatic studio lighting.",
  "Lifestyle scene showing the product in real-world use, natural light, candid energy.",
  "Bold typographic layout where the headline dominates and the product supports it.",
  "Flat-lay composition with complementary props on a textured surface, top-down view.",
  "High-contrast editorial look with a strong single accent color and generous negative space.",
  "Before/after or comparison-style split composition with clear visual storytelling.",
];

export function buildPrompt(payload: {
  brief: string;
  angle?: string | null;
  persona?: string | null;
  awarenessLevel?: AwarenessLevel | null;
  format?: StudioFormat;
}) {
  const format = payload.format ?? "square";
  const details = [
    `Brief: ${payload.brief}`,
    payload.angle ? `Angle: ${payload.angle}` : null,
    payload.persona ? `Persona: ${payload.persona}` : null,
    payload.awarenessLevel
      ? `Awareness level: ${payload.awarenessLevel.replace(/_/g, " ")}`
      : null,
  ].filter(Boolean);

  return [
    `Create a polished ${studioSizeFor(format)} static ad image for paid social.`,
    "Use strong visual hierarchy, direct-response clarity, and a premium ecommerce feel.",
    "Do not include platform UI, watermarks, or unrelated brand logos.",
    ...details,
  ].join("\n");
}

export function variantPromptFor(basePrompt: string, artDirection: string | null) {
  return artDirection ? `${basePrompt}\nArt direction: ${artDirection}` : basePrompt;
}
