import { z } from "zod";

/**
 * The one preview-ad shape every surface renders — card strips, the signals
 * ledger, the evidence panel, and test-plan inspiration all carry the same
 * object, so a video ad is playable wherever its thumbnail shows up.
 */
export const previewAdSchema = z.object({
  archiveId: z.string(),
  thumbnailUrl: z.string(),
  isVideo: z.boolean(),
  videoUrl: z.string().nullable(),
});

export type PreviewAd = z.infer<typeof previewAdSchema>;

type PreviewSourceAd = {
  archiveId: string | null;
  mirroredPreviewUrl: string | null;
  mirroredImageUrl: string | null;
  mirroredVideoUrl: string | null;
  mediaKinds: string[] | null;
};

/** The card/panel thumbnail for an ad, or null when nothing was mirrored. */
export function adThumbnailUrl(
  ad: Pick<PreviewSourceAd, "mirroredPreviewUrl" | "mirroredImageUrl">,
): string | null {
  return ad.mirroredPreviewUrl ?? ad.mirroredImageUrl;
}

export function adIsVideo(
  ad: Pick<PreviewSourceAd, "mediaKinds" | "mirroredVideoUrl">,
): boolean {
  return (ad.mediaKinds ?? []).includes("video") || Boolean(ad.mirroredVideoUrl);
}

/** An ad row as a preview, or null when there is nothing to show. */
export function toPreviewAd(ad: PreviewSourceAd): PreviewAd | null {
  const thumbnailUrl = adThumbnailUrl(ad);
  if (!ad.archiveId || !thumbnailUrl) return null;
  return {
    archiveId: ad.archiveId,
    thumbnailUrl,
    isVideo: adIsVideo(ad),
    videoUrl: ad.mirroredVideoUrl,
  };
}
