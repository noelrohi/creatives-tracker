/**
 * Segment order and color, left to right. Known sources ride the green ramp,
 * "Source unknown" wears the amber, "No tracking info" the neutral edge — the
 * values themselves live in `globals.css`, never as literals in a component.
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

const BUCKET_COLOR_VARS: Record<AttributionBucket, string> = {
  meta: "--attr-bucket-meta",
  google: "--attr-bucket-google",
  klaviyo: "--attr-bucket-klaviyo",
  tiktok: "--attr-bucket-tiktok",
  organic_direct: "--attr-bucket-organic",
  unattributed: "--attr-bucket-unknown",
  untracked: "--attr-bucket-none",
};

export function bucketColor(bucket: AttributionBucket): string {
  return `var(${BUCKET_COLOR_VARS[bucket]})`;
}

/** Sort API rows into display order without trusting the server's ordering. */
export function inBucketOrder<T extends { bucket: AttributionBucket }>(
  entries: readonly T[],
): T[] {
  const byBucket = new Map(entries.map((entry) => [entry.bucket, entry]));
  return BUCKET_ORDER.map((bucket) => byBucket.get(bucket)).filter(
    (entry): entry is T => entry !== undefined,
  );
}
