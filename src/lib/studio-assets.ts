// Whether the URL points at an actual video file. Meta-synced video creatives
// sometimes store an image preview frame in assetUrl (and vice versa), so the
// file type — never the creative format — decides whether a URL can render as
// an image or ride the image-reference pipeline.
const VIDEO_ASSET_PATTERN = /\.(mp4|mov|webm)(\?|$)/i;

export function isVideoFile(assetUrl: string | null | undefined) {
  return Boolean(assetUrl && VIDEO_ASSET_PATTERN.test(assetUrl));
}

// Variations ride the image-reference pipeline, so the source must be a static
// creative whose assetUrl is an actual image. Kept here (not creative-format.ts)
// so client components can import it without pulling drizzle-orm into the bundle.
export function isStaticImageCreative<
  T extends { format?: string | null; assetUrl?: string | null } | null | undefined,
>(creative: T): creative is T & { format: "static"; assetUrl: string } {
  return Boolean(
    creative && creative.format === "static" && creative.assetUrl && !isVideoFile(creative.assetUrl),
  );
}
