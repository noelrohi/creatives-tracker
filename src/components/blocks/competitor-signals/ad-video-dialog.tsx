"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type PlayableAd = {
  videoUrl: string;
  title: string;
};

/**
 * Plays one mirrored competitor video. The source is our own blob mirror —
 * Meta's CDN links expire, so the mirror is the only URL that stays playable.
 */
export function AdVideoDialog({
  ad,
  onClose,
}: {
  ad: PlayableAd | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={ad !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md overflow-hidden p-0" showCloseButton>
        <DialogTitle className="sr-only">{ad?.title}</DialogTitle>
        {ad && (
          <video
            src={ad.videoUrl}
            controls
            autoPlay
            playsInline
            className="max-h-[80vh] w-full bg-black"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
