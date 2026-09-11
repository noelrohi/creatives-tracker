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
