import { angleLabels } from "@/components/blocks/insights/insights-copy";

/** The honesty guardrail (§10): every score or tier badge repeats it. */
export const EVIDENCE_NOTE =
  "Strength measures how long and widely a message has run — not how it performed.";

/** Collection runs device-side, so an empty card points at the operator. */
export const NO_FILLS_NOTE =
  "No fills yet — data arrives when the operator runs a fill from their device";

/** A cluster whose verdict never validated (§8): strategic scores 0, flagged. */
export const NO_VERDICT_NOTE =
  "The last update couldn't assess this message — relevance counts 0 until the next one.";

/** Ledger empty state — clusters only ever arrive with a fill. */
export const NO_CLUSTERS_NOTE =
  "No signals yet — clusters arrive with the next fill that carries them";

/** Zero-competitor empty state — before fills are even in the picture. */
export const NO_COMPETITORS_NOTE =
  "Track a competitor's Meta page to start collecting their public ads";

/** The §9 budget-routing rule, app-rendered on every concept header. */
export const BUDGET_ROUTING_NOTE =
  "Scale and kill decisions follow measured CTR, CAC, and ROAS in Adsolute — never these evidence scores.";

/** Test-plan empty state — a plan only ever arrives with a generation. */
export const NO_TEST_PLAN_NOTE =
  "No test plan yet — one arrives when the operator generates it from their device";

/**
 * Angles arrive as the snake_case `ANGLE_TYPES` wire values. Print the shared
 * labels the rest of the app uses, and humanize anything outside that
 * vocabulary rather than leaking a raw identifier onto the screen.
 */
export function angleLabel(angle: string): string {
  const known = angleLabels[angle];
  if (known) return known;
  const words = angle.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

