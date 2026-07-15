// Whether the URL points at an actual video file. Meta-synced video creatives
// sometimes store an image preview frame in assetUrl (and vice versa), so the
// file type — never the creative format — decides whether a URL can render as
// an image or ride the image-reference pipeline.
const VIDEO_ASSET_PATTERN = /\.(mp4|mov|webm)(\?|$)/i;

export function isVideoFile(assetUrl: string | null | undefined) {
  return Boolean(assetUrl && VIDEO_ASSET_PATTERN.test(assetUrl));
}
