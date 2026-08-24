/**
 * Fallback media extraction from a fill's verbatim `raw` payload (§4).
 *
 * The harness is supposed to surface the primary creative's media URLs
 * top-level on the NormalizedAd, but source shapes differ: MetaAdsCollector's
 * normalized output uses root `creatives[]` (and calls a video poster
 * `thumbnail_url`), while native snapshots use `raw_data.cards[]` or the
 * image/video lists. The server holds the verbatim payload anyway, so it can
 * recover any media slot the harness missed.
 */

export type RawPrimaryMedia = {
  imageUrl: string | null;
  /** The smaller resized copy, when the payload carries one distinct from
   * `imageUrl` — a mirror fallback for oversized or dead originals. */
  resizedImageUrl: string | null;
  videoHdUrl: string | null;
  videoSdUrl: string | null;
  videoPreviewImageUrl: string | null;
};

const EMPTY_MEDIA: RawPrimaryMedia = {
  imageUrl: null,
  resizedImageUrl: null,
  videoHdUrl: null,
  videoSdUrl: null,
  videoPreviewImageUrl: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("http") ? value : null;
}

function creativeMedia(creative: unknown): RawPrimaryMedia | null {
  const record = asRecord(creative);
  if (!record) return null;

  const imageUrl =
    asUrl(record.original_image_url) ??
    asUrl(record.resized_image_url) ??
    asUrl(record.image_url);
  const resized = asUrl(record.resized_image_url);
  const media: RawPrimaryMedia = {
    imageUrl,
    resizedImageUrl: resized !== imageUrl ? resized : null,
    videoHdUrl: asUrl(record.video_hd_url),
    videoSdUrl: asUrl(record.video_sd_url),
    videoPreviewImageUrl:
      asUrl(record.video_preview_image_url) ?? asUrl(record.thumbnail_url),
  };

  const hasAny =
    media.imageUrl !== null ||
    media.videoHdUrl !== null ||
    media.videoSdUrl !== null ||
    media.videoPreviewImageUrl !== null;
  return hasAny ? media : null;
}

/**
 * The primary creative's media from the raw payload, or all-null when none is
 * found. MetaAdsCollector's normalized output keeps creatives at the root;
 * native snapshot shapes keep card-based ads in `cards[]` and single-creative
 * ads in `videos[]`/`images[]`, under `raw_data`, `snapshot`, or both. The first
 * creative carrying any media wins — that is the primary.
 */
export function extractRawPrimaryMedia(raw: unknown): RawPrimaryMedia {
  const root = asRecord(raw);
  if (!root) return EMPTY_MEDIA;

  const rawData = asRecord(root.raw_data);
  const containers = [
    rawData,
    asRecord(rawData?.snapshot),
    asRecord(root.snapshot),
    root,
  ];

  for (const container of containers) {
    if (!container) continue;
    for (const listKey of ["cards", "videos", "images", "creatives"] as const) {
      const list = container[listKey];
      if (!Array.isArray(list)) continue;
      for (const creative of list) {
        const media = creativeMedia(creative);
        if (media) return media;
      }
    }
  }

  return EMPTY_MEDIA;
}
