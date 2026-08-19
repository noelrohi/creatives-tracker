/**
 * The test-plan feedback vocabulary and the built-in plan rule: domain
 * fixtures read by both the feedback router and the test-plan screens, so
 * they live here rather than in a UI module.
 */

/** Thumbs-down reason slugs, in the order the chips render. */
export const HOOK_FEEDBACK_REASON_SLUGS = [
  "too_generic",
  "off_brand_voice",
  "wrong_claim_risk",
  "weak_angle",
  "weak_cta",
  "overlaps_live_ad",
] as const;

export type HookFeedbackReasonSlug =
  (typeof HOOK_FEEDBACK_REASON_SLUGS)[number];

const HOOK_FEEDBACK_REASON_LABELS: Record<HookFeedbackReasonSlug, string> = {
  too_generic: "Too generic",
  off_brand_voice: "Off brand voice",
  wrong_claim_risk: "Wrong claim risk",
  weak_angle: "Weak angle",
  weak_cta: "Weak CTA",
  overlaps_live_ad: "Overlaps a live ad",
};

/**
 * Slug/label pairs for the chips: slugs are stored on
 * `test_plan_hook_feedback.reasons`, labels render in the UI.
 */
export const HOOK_FEEDBACK_REASONS = HOOK_FEEDBACK_REASON_SLUGS.map((slug) => ({
  slug,
  label: HOOK_FEEDBACK_REASON_LABELS[slug],
}));

/**
 * The built-in compliance guardrail: a code fixture, not a `plan_rule` row, so
 * a DB wipe can never silently drop it. Pinned first on the rules card and
 * deliberately excluded from the API.
 *
 * `.claude/skills/fill-competitor-signals/SKILL.md` carries this same text
 * verbatim for the generation prompt — keep the two in sync.
 */
export const BUILT_IN_PLAN_RULE =
  "Never claim to diagnose, treat, or cure a condition — describe the product mechanism and subjective experience only.";
