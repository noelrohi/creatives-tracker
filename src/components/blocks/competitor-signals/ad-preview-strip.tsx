"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { AdThumbnail } from "./ad-thumbnail";
import { AdVideoDialog, type PlayableAd } from "./ad-video-dialog";

export type StripAd = {
  archiveId: string;
  thumbnailUrl: string;
  isVideo: boolean;
  videoUrl?: string | null;
};

/**
 * A row of mirrored ad creatives with an optional "+N" overflow tile. A
 * mirrored video plays in-app on click; a video whose mirror failed stays a
 * plain thumbnail. `thumbClassName` sizes both the thumbnails and the tile.
 */
export function AdPreviewStrip({
  ads,
  alt,
  hiddenCount = 0,
  thumbClassName,
  className,
}: {
  ads: StripAd[];
  alt: string;
  hiddenCount?: number;
  thumbClassName: string;
  className?: string;
}) {
  const [playing, setPlaying] = useState<PlayableAd | null>(null);

  return (
    <div className={cn("flex gap-2", className)}>
      {ads.map((ad) => {
        const videoUrl = ad.videoUrl ?? null;
        const creative = (
          <AdThumbnail
            thumbnailUrl={ad.thumbnailUrl}
            isVideo={ad.isVideo}
            alt={alt}
            className={thumbClassName}
          />
        );
        return videoUrl ? (
          <button
            key={ad.archiveId}
            type="button"
            aria-label="Play video"
            className="shrink-0 cursor-pointer"
            onClick={() => setPlaying({ videoUrl, title: `${alt} video` })}
          >
            {creative}
          </button>
        ) : (
          <div key={ad.archiveId} className="shrink-0">
            {creative}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <div
          className={cn(
            "flex shrink-0 items-center justify-center border bg-muted/60 text-xs font-medium text-muted-foreground",
            thumbClassName,
          )}
        >
          +{hiddenCount}
        </div>
      )}
      <AdVideoDialog ad={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}
