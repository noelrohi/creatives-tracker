import { put } from "@vercel/blob";

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type MetaCreativePreview = {
  assetUrl: string | null;
  format: "static" | "video" | null;
  videoUrl?: string;
  destinationUrl?: string;
};

type MetaAdCreativeResponse = {
  id?: string;
  creative?: {
    image_hash?: string;
    image_url?: string;
    effective_image_url?: string;
    thumbnail_url?: string;
    link_url?: string;
    video_id?: string;
    object_type?: string;
    object_story_spec?: {
      link_data?: {
        picture?: string;
        image_hash?: string;
        link?: string;
      };
      video_data?: {
        image_url?: string;
        image_hash?: string;
        video_id?: string;
        call_to_action?: {
          value?: { link?: string };
        };
      };
      photo_data?: {
        url?: string;
      };
    };
    effective_object_story_spec?: {
      link_data?: {
        picture?: string;
        image_hash?: string;
        link?: string;
      };
      video_data?: {
        image_url?: string;
        image_hash?: string;
        video_id?: string;
        call_to_action?: {
          value?: { link?: string };
        };
      };
      photo_data?: {
        url?: string;
      };
    };
    asset_feed_spec?: {
      images?: Array<{
        hash?: string;
        url?: string;
      }>;
      videos?: Array<{
        video_id?: string;
        thumbnail_url?: string;
      }>;
    };
  };
};

type MetaAdImagesResponse = {
  data?: Array<{
    hash?: string;
    url?: string;
  }>;
};

type MetaVideoSourceResponse = {
  source?: string;
};

const META_IDS_CHUNK_SIZE = 50;
const META_IMAGE_HASH_CHUNK_SIZE = 50;

function getStorySpecs(
  creative: MetaAdCreativeResponse["creative"],
): Array<
  NonNullable<MetaAdCreativeResponse["creative"]>["object_story_spec"]
> {
  return [
    creative?.object_story_spec,
    creative?.effective_object_story_spec,
  ].filter(Boolean);
}

function getCreativeVideoId(
  creative: MetaAdCreativeResponse["creative"],
): string | undefined {
  return creative?.video_id
    ?? creative?.object_story_spec?.video_data?.video_id
    ?? creative?.effective_object_story_spec?.video_data?.video_id
    ?? creative?.asset_feed_spec?.videos?.find((video) => video.video_id)?.video_id;
}

function inferCreativeFormat(
  creative: MetaAdCreativeResponse["creative"],
): "static" | "video" | null {
  const objectType = creative?.object_type?.toUpperCase();
  if (creative?.video_id) {
    return "video";
  }
  if (objectType === "VIDEO") {
    return "video";
  }
  if (
    creative?.object_story_spec?.video_data
    || creative?.effective_object_story_spec?.video_data
  ) {
    return "video";
  }
  if (creative?.asset_feed_spec?.videos?.length) {
    return "video";
  }
  if (
    creative?.effective_image_url ||
    creative?.image_hash ||
    creative?.image_url ||
    creative?.object_story_spec?.link_data?.picture ||
    creative?.object_story_spec?.link_data?.image_hash ||
    creative?.object_story_spec?.video_data?.image_url ||
    creative?.object_story_spec?.video_data?.image_hash ||
    creative?.object_story_spec?.photo_data?.url ||
    creative?.effective_object_story_spec?.link_data?.picture ||
    creative?.effective_object_story_spec?.link_data?.image_hash ||
    creative?.effective_object_story_spec?.video_data?.image_url ||
    creative?.effective_object_story_spec?.video_data?.image_hash ||
    creative?.effective_object_story_spec?.photo_data?.url ||
    creative?.asset_feed_spec?.images?.length ||
    creative?.thumbnail_url
  ) {
    return "static";
  }
  return null;
}

async function fetchJson<T>(url: URL): Promise<T | null> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as T;
}

/**
 * Extract the best available image URL from a creative.
 * Priority (highest quality first):
 *   1. effective_image_url — resolved image from Meta
 *   2. image_url — the originally uploaded image
 *   3. object_story_spec/effective_object_story_spec link_data.picture — link ad image
 *   4. object_story_spec/effective_object_story_spec video_data.image_url — video poster
 *   5. object_story_spec/effective_object_story_spec photo_data.url — photo ad image
 *   6. resolved image hash from creative/story spec/asset_feed_spec
 *   7. asset_feed_spec image url — dynamic creative asset URL
 *   8. asset_feed_spec video thumbnail_url — dynamic video poster
 *   9. thumbnail_url — last resort (small)
 */
function getBestImageUrl(
  creative: MetaAdCreativeResponse["creative"],
  resolvedImageUrls: Map<string, string>,
): string | null {
  if (creative?.effective_image_url) return creative.effective_image_url;
  if (creative?.image_url) return creative.image_url;

  const specs = getStorySpecs(creative);
  for (const spec of specs) {
    if (spec?.link_data?.picture) return spec.link_data.picture;
  }
  for (const spec of specs) {
    if (spec?.video_data?.image_url) return spec.video_data.image_url;
  }
  for (const spec of specs) {
    if (spec?.photo_data?.url) return spec.photo_data.url;
  }

  const imageHashes = [
    creative?.image_hash,
    ...specs.flatMap((spec) => [spec?.link_data?.image_hash, spec?.video_data?.image_hash]),
    ...(creative?.asset_feed_spec?.images?.map((image) => image.hash) ?? []),
  ].filter(Boolean) as string[];

  for (const imageHash of imageHashes) {
    const resolved = resolvedImageUrls.get(imageHash);
    if (resolved) return resolved;
  }

  const dynamicImageUrl = creative?.asset_feed_spec?.images?.find((image) => image.url)?.url;
  if (dynamicImageUrl) return dynamicImageUrl;

  const dynamicVideoThumbnail = creative?.asset_feed_spec?.videos?.find((video) => video.thumbnail_url)?.thumbnail_url;
  if (dynamicVideoThumbnail) return dynamicVideoThumbnail;

  if (creative?.thumbnail_url) return creative.thumbnail_url;

  return null;
}

function getDestinationUrl(
  creative: MetaAdCreativeResponse["creative"],
): string | undefined {
  if (creative?.link_url) return creative.link_url;
  for (const spec of getStorySpecs(creative)) {
    if (spec?.link_data?.link) return spec.link_data.link;
  }
  for (const spec of getStorySpecs(creative)) {
    if (spec?.video_data?.call_to_action?.value?.link) {
      return spec.video_data.call_to_action.value.link;
    }
  }
  return undefined;
}

function toPreview(
  creative: MetaAdCreativeResponse["creative"],
  resolvedImageUrls: Map<string, string>,
): MetaCreativePreview {
  const format = inferCreativeFormat(creative);
  const assetUrl = getBestImageUrl(creative, resolvedImageUrls);

  return {
    assetUrl,
    format: format ?? (assetUrl ? "static" : null),
    destinationUrl: getDestinationUrl(creative),
  };
}

function getVideoExtension(
  contentType: string | null,
  sourceUrl: string,
): string {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalizedContentType) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "video/ogg":
      return "ogv";
    case "video/x-msvideo":
      return "avi";
    default:
      break;
  }

  try {
    const pathname = new URL(sourceUrl).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  } catch {
    return "mp4";
  }

  return "mp4";
}

async function fetchAndUploadVideo(input: {
  videoId: string;
  accessToken: string;
}): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return null;
  }

  try {
    const videoUrl = new URL(`${GRAPH_API_BASE}/${input.videoId}`);
    videoUrl.searchParams.set("access_token", input.accessToken);
    videoUrl.searchParams.set("fields", "source");

    const video = await fetchJson<MetaVideoSourceResponse>(videoUrl);
    if (!video?.source) {
      return null;
    }

    const videoResponse = await fetch(video.source);
    if (!videoResponse.ok) {
      return null;
    }

    const contentType = videoResponse.headers.get("content-type");
    const extension = getVideoExtension(contentType, video.source);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const pathname = `${env}/meta-videos/${input.videoId}.${extension}`;
    const body = videoResponse.body ?? await videoResponse.arrayBuffer();

    const blob = await put(pathname, body, {
      access: "public",
      allowOverwrite: true,
      contentType: contentType ?? undefined,
    });

    return blob.url;
  } catch {
    return null;
  }
}

async function fetchAdImageUrls(input: {
  imageHashes: string[];
  metaAccountId: string;
  accessToken: string;
}) {
  const resolved = new Map<string, string>();

  for (let i = 0; i < input.imageHashes.length; i += META_IMAGE_HASH_CHUNK_SIZE) {
    const chunk = input.imageHashes.slice(i, i + META_IMAGE_HASH_CHUNK_SIZE);
    const imageUrl = new URL(
      `${GRAPH_API_BASE}/act_${input.metaAccountId}/adimages`,
    );
    imageUrl.searchParams.set("access_token", input.accessToken);
    imageUrl.searchParams.set("hashes", JSON.stringify(chunk));
    imageUrl.searchParams.set("fields", "hash,url");

    const images = await fetchJson<MetaAdImagesResponse>(imageUrl);
    for (const image of images?.data ?? []) {
      if (image.hash && image.url) {
        resolved.set(image.hash, image.url);
      }
    }
  }

  return resolved;
}

export async function fetchMetaCreativePreviewsForAds(input: {
  adMetaIds: string[];
  metaAccountId: string;
  accessToken: string;
}) {
  const previews = new Map<string, MetaCreativePreview>();
  const creativesByAdId = new Map<string, MetaAdCreativeResponse["creative"]>();

  for (let i = 0; i < input.adMetaIds.length; i += META_IDS_CHUNK_SIZE) {
    const chunk = input.adMetaIds.slice(i, i + META_IDS_CHUNK_SIZE);
    const url = new URL(`${GRAPH_API_BASE}/`);
    url.searchParams.set("access_token", input.accessToken);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set(
      "fields",
      "creative{image_hash,image_url,effective_image_url,thumbnail_url,link_url,video_id,object_type,object_story_spec,effective_object_story_spec,asset_feed_spec}",
    );

    const response = await fetchJson<Record<string, MetaAdCreativeResponse>>(url);
    if (!response) {
      continue;
    }

    for (const adMetaId of chunk) {
      creativesByAdId.set(adMetaId, response[adMetaId]?.creative);
    }
  }

  const imageHashes = [...new Set(
    [...creativesByAdId.values()]
      .flatMap((creative) => [
        creative?.image_hash,
        creative?.object_story_spec?.link_data?.image_hash,
        creative?.object_story_spec?.video_data?.image_hash,
        creative?.effective_object_story_spec?.link_data?.image_hash,
        creative?.effective_object_story_spec?.video_data?.image_hash,
        ...(creative?.asset_feed_spec?.images?.map((image) => image.hash) ?? []),
      ])
      .filter(Boolean) as string[],
  )];
  const resolvedImageUrls = imageHashes.length > 0
    ? await fetchAdImageUrls({
        imageHashes,
        metaAccountId: input.metaAccountId,
        accessToken: input.accessToken,
      })
    : new Map<string, string>();

  for (const adMetaId of input.adMetaIds) {
    const creative = creativesByAdId.get(adMetaId);
    if (creative) {
      previews.set(adMetaId, toPreview(creative, resolvedImageUrls));
    }
  }

  const uploadedVideoUrls = new Map<string, string | null>();
  for (const adMetaId of input.adMetaIds) {
    const creative = creativesByAdId.get(adMetaId);
    const preview = previews.get(adMetaId);
    const videoId = getCreativeVideoId(creative);

    if (!preview || preview.format !== "video" || !videoId) {
      continue;
    }

    if (!uploadedVideoUrls.has(videoId)) {
      uploadedVideoUrls.set(videoId, await fetchAndUploadVideo({
        videoId,
        accessToken: input.accessToken,
      }));
    }

    const videoUrl = uploadedVideoUrls.get(videoId);
    if (videoUrl) {
      preview.videoUrl = videoUrl;
    }
  }

  return previews;
}

export async function fetchMetaCreativePreview(input: {
  adMetaId: string;
  metaAccountId: string;
  accessToken: string;
}): Promise<MetaCreativePreview | null> {
  const previews = await fetchMetaCreativePreviewsForAds({
    adMetaIds: [input.adMetaId],
    metaAccountId: input.metaAccountId,
    accessToken: input.accessToken,
  });
  return previews.get(input.adMetaId) ?? null;
}
