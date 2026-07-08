/**
 * Single source of truth for the marketing awareness-level domain, shared by
 * the /create UI, the `create` tRPC router, and the `generate-static-ads`
 * trigger task. Mirrors the `awareness_level` pg enum in `src/schema/enums.ts`.
 */
export const AWARENESS_LEVELS = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

export type AwarenessLevel = (typeof AWARENESS_LEVELS)[number];

/** Hyphenated label for UI display, e.g. `problem_aware` -> "problem-aware". */
export function awarenessDisplayLabel(level: AwarenessLevel): string {
  return level.replace(/_/g, "-");
}
