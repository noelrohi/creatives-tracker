/**
 * Which failure reasons on a Studio variant mean the image model itself
 * refused the request, so retrying from the written spec alone ("retry without
 * image") can actually help.
 *
 * Every other reason keeps the plain Retry: "claims" is a prompt-safety stop
 * the source image had no part in, and "logo_unavailable" is decided by the
 * logo step, which reads the source bytes whether or not the source is sent to
 * the image model — dropping the layout reference re-fails on the same branch.
 */
export const IMAGE_BLOCKED_REASONS = ["likeness", "logo", "moderation"] as const;

export function isImageBlockedReason(reason: string | null | undefined) {
  return (IMAGE_BLOCKED_REASONS as readonly string[]).includes(reason ?? "");
}

/**
 * What a `logo_unavailable` failure means, in one line, shared by every
 * failure surface. A plain "Generation failed" plus a Retry is a dead end
 * here: the logo step re-locates the same mark and fails on the same branch
 * every time, so the message has to name both the cause and the one action
 * that changes the outcome.
 */
export const LOGO_UNAVAILABLE_MESSAGE =
  "Stopped: no usable logo for this ad — add a logo to Studio context";
