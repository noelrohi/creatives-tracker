import { describe, expect, it } from "vitest";
import { extractRawPrimaryMedia } from "./raw-media";

const IMG = "https://scontent.example.fbcdn.net/v/t39/original.jpg";
const IMG_RESIZED = "https://scontent.example.fbcdn.net/v/t39/resized.jpg";
const VID = "https://video.example.fbcdn.net/v/t42/hd.mp4";
const PREVIEW = "https://scontent.example.fbcdn.net/v/t39/preview.jpg";

describe("extractRawPrimaryMedia", () => {
  it("reads the first card of a card-based (DCO/carousel) ad", () => {
    const raw = {
      raw_data: {
        cards: [
          {
            original_image_url: IMG,
            resized_image_url: IMG_RESIZED,
            video_hd_url: null,
            video_sd_url: null,
            video_preview_image_url: null,
          },
          { original_image_url: "https://scontent.example.fbcdn.net/other.jpg" },
        ],
      },
    };
    expect(extractRawPrimaryMedia(raw)).toEqual({
      imageUrl: IMG,
      resizedImageUrl: IMG_RESIZED,
      videoHdUrl: null,
      videoSdUrl: null,
      videoPreviewImageUrl: null,
    });
  });

  it("reads images[] on a single-creative image ad", () => {
    const raw = {
      raw_data: {
        images: [{ original_image_url: IMG, resized_image_url: IMG_RESIZED }],
        snapshot: {
          images: [{ original_image_url: IMG, resized_image_url: IMG_RESIZED }],
        },
      },
    };
    expect(extractRawPrimaryMedia(raw).imageUrl).toBe(IMG);
  });

  it("falls back to resized_image_url when there is no original", () => {
    const raw = { raw_data: { images: [{ resized_image_url: IMG_RESIZED }] }};
    const media = extractRawPrimaryMedia(raw);
    expect(media.imageUrl).toBe(IMG_RESIZED);
    // Already the primary url — not repeated as a separate fallback.
    expect(media.resizedImageUrl).toBeNull();
  });

  it("reads video urls and preview from a video card", () => {
    const raw = {
      raw_data: {
        cards: [{ video_hd_url: VID, video_preview_image_url: PREVIEW }],
      },
    };
    expect(extractRawPrimaryMedia(raw)).toEqual({
      imageUrl: null,
      resizedImageUrl: null,
      videoHdUrl: VID,
      videoSdUrl: null,
      videoPreviewImageUrl: PREVIEW,
    });
  });

  it("skips media-less creatives to find the primary", () => {
    const raw = {
      raw_data: {
        cards: [
          { link_url: "https://example.com", video_hd_url: null },
          { original_image_url: IMG },
        ],
      },
    };
    expect(extractRawPrimaryMedia(raw).imageUrl).toBe(IMG);
  });

  it("reads a native snapshot shape without raw_data", () => {
    const raw = { snapshot: { cards: [{ original_image_url: IMG }] } };
    expect(extractRawPrimaryMedia(raw).imageUrl).toBe(IMG);
  });

  it("ignores non-url junk values", () => {
    const raw = { raw_data: { images: [{ original_image_url: "" }, { original_image_url: 42 }] } };
    expect(extractRawPrimaryMedia(raw).imageUrl).toBeNull();
  });

  it.each([null, undefined, "string", 42, [], {}])(
    "returns all-null for unusable raw: %p",
    (raw) => {
      expect(extractRawPrimaryMedia(raw)).toEqual({
        imageUrl: null,
        resizedImageUrl: null,
        videoHdUrl: null,
        videoSdUrl: null,
        videoPreviewImageUrl: null,
      });
    },
  );
});
