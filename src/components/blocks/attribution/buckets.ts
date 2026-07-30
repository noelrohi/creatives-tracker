/**
 * Segment order, left to right: known sources first, then "Source unknown" and
 * "No tracking info" on the edge. The colours live in `./colors`.
 */

import type { AttributionBucket } from "@/lib/attribution-bucket";

export const BUCKET_ORDER: readonly AttributionBucket[] = [
  "meta",
  "google",
  "klaviyo",
  "tiktok",
  "organic_direct",
  "unattributed",
  "untracked",
];

export { bucketColor } from "./colors";

/** Sort API rows into display order without trusting the server's ordering. */
export function inBucketOrder<T extends { bucket: AttributionBucket }>(
  entries: readonly T[],
): T[] {
  const byBucket = new Map(entries.map((entry) => [entry.bucket, entry]));
  return BUCKET_ORDER.map((bucket) => byBucket.get(bucket)).filter(
    (entry): entry is T => entry !== undefined,
  );
}
