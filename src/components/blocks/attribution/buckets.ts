/**
 * Segment order, left to right: known sources first, then "Source unknown" and
 * "No tracking info" on the edge. The colours live in `./colors`.
 */

import {
  Ban,
  CircleHelp,
  Leaf,
  Mail,
  MousePointerClick,
  Search,
  Video,
} from "@/components/icons";
import type { AttributionBucket } from "@/lib/attribution-bucket";

/**
 * One glyph per bucket, so a row is recognisable before its label is read.
 * The two off-ramp buckets wear the two shapes a shop owner already reads as
 * "we don't know" and "nothing came through".
 */
export const BUCKET_ICON: Record<
  AttributionBucket,
  typeof MousePointerClick
> = {
  meta: MousePointerClick,
  google: Search,
  klaviyo: Mail,
  tiktok: Video,
  organic_direct: Leaf,
  unattributed: CircleHelp,
  untracked: Ban,
};

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
