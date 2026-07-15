export const STUDIO_ANGLE_SEEDS = [
  "vs. the expensive fix",
  "creams don't work",
  "week-by-week timeline",
  "nobody talks about this",
  "clothing freedom",
  "feel like yourself again",
  "offer/bundle",
] as const;

export const STUDIO_STYLE_SEEDS = [
  "before/after",
  "us vs. them",
  "testimonial",
  "facts & stats",
  "features & benefits",
  "native/screenshot",
] as const;

export function studioSlug(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
