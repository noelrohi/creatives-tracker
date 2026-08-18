"use client";

import { ImageIcon, PlayIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * One mirrored ad creative: the image when the mirror has one, a quiet
 * placeholder when it doesn't, and a play overlay on video ads. Sizing and
 * radius come from the caller — this only owns what's inside the frame.
 */
export function AdThumbnail({
  thumbnailUrl,
  isVideo,
  alt,
  className,
}: {
  thumbnailUrl: string | null;
  isVideo: boolean;
  alt: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden bg-muted",
        className,
      )}
    >
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- mirrored blob URLs; images are unoptimized anyway
        <img
          src={thumbnailUrl}
          alt={alt}
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <ImageIcon className="size-1/3 max-h-5 max-w-5 text-muted-foreground/40" />
        </div>
      )}
      {isVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-2/5 max-h-8 max-w-8 items-center justify-center rounded-full bg-black/50">
            <PlayIcon className="size-1/2 text-white" />
          </span>
        </div>
      )}
    </div>
  );
}
