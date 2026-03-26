import { put } from "@vercel/blob";

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type MetaCreativePreview = {
  assetUrl: string | null;
  format: "static" | "video" | null;
  videoUrl?: string;
};

type MetaAdCreativeResponse = {
  id?: string;
  creative?: {
    image_url?: string;
    thumbnail_url?: string;
    video_id?: string;
    object_type?: string;
    object_story_spec?: {
      video_data?: {
        image_url?: string;
      };
    };
    effective_object_story_spec?: {
      video_data?: {
        image_url?: string;
      };
    };
    asset_feed_spec?: {
      images?: Array<{
        hash?: string;
      }>;
      videos?: Array<{
        video_id?: string;
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

function getCreativeVideoId(
  creative: MetaAdCreativeResponse["creative"],
): string | undefined {
  return creative?.video_id
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
    creative?.image_url ||
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

function toPreview(
  creative: MetaAdCreativeResponse["creative"],
  resolvedImageUrls: Map<string, string>,
): MetaCreativePreview {
  const format = inferCreativeFormat(creative);

  if (format === "video") {
    const videoPoster = creative?.object_story_spec?.video_data?.image_url
      ?? creative?.effective_object_story_spec?.video_data?.image_url;
    if (videoPoster) {
      return {
        assetUrl: videoPoster,
        format,
      };
    }

    if (creative?.thumbnail_url) {
      return {
        assetUrl: creative.thumbnail_url,
        format,
      };
    }
  }

  if (creative?.image_url) {
    return {
      assetUrl: creative.image_url,
      format: format ?? "static",
    };
  }

  const imageHash = creative?.asset_feed_spec?.images?.find((image) => image.hash)
    ?.hash;
  const resolved = imageHash ? resolvedImageUrls.get(imageHash) : undefined;
  if (resolved) {
    return {
      assetUrl: resolved,
      format: format ?? "static",
    };
  }

  if (creative?.thumbnail_url) {
    return {
      assetUrl: creative.thumbnail_url,
      format: format ?? "static",
    };
  }

  return {
    assetUrl: null,
    format,
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
      "creative{image_url,thumbnail_url,video_id,object_type,object_story_spec,effective_object_story_spec,asset_feed_spec}",
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
      .map((creative) => creative?.asset_feed_spec?.images?.find((image) => image.hash)?.hash)
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
