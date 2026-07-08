import { sql, type SQL } from "drizzle-orm";

export const STATIC_CREATIVE_FORMAT = "static";
export const VIDEO_CREATIVE_FORMAT = "video";
export const CREATIVE_FORMATS = ["static", "video", "ugc", "carousel"] as const;

export type CreativeFormat = typeof CREATIVE_FORMATS[number];

type CreativeFormatMergeSqlInput = {
  existingFormat: SQL;
  incomingFormat: SQL;
  incomingVideoUrl?: SQL;
};

export function isCreativeFormat(value: string | null | undefined): value is CreativeFormat {
  return CREATIVE_FORMATS.includes(value as CreativeFormat);
}

export function normalizeIncomingCreativeFormat(input: {
  format?: string | null;
  videoUrl?: string | null;
}): CreativeFormat | undefined {
  if (input.videoUrl?.trim()) return VIDEO_CREATIVE_FORMAT;
  return isCreativeFormat(input.format) ? input.format : undefined;
}

export function mergeCreativeFormat(input: {
  existingFormat?: string | null;
  incomingFormat?: string | null;
  incomingVideoUrl?: string | null;
}): CreativeFormat | undefined {
  const existingFormat = isCreativeFormat(input.existingFormat)
    ? input.existingFormat
    : undefined;
  const incomingFormat = normalizeIncomingCreativeFormat({
    format: input.incomingFormat,
    videoUrl: input.incomingVideoUrl,
  });

  if (incomingFormat === VIDEO_CREATIVE_FORMAT) return VIDEO_CREATIVE_FORMAT;
  if (existingFormat === VIDEO_CREATIVE_FORMAT) return VIDEO_CREATIVE_FORMAT;
  if (!existingFormat) return incomingFormat;
  return existingFormat;
}

export function creativeFormatMergeSql(input: CreativeFormatMergeSqlInput) {
  const incomingVideoPredicate = input.incomingVideoUrl
    ? sql`nullif(trim(${input.incomingVideoUrl}), '') IS NOT NULL`
    : sql`false`;

  return sql`CASE
    WHEN ${input.incomingFormat} = ${VIDEO_CREATIVE_FORMAT} THEN ${VIDEO_CREATIVE_FORMAT}::format
    WHEN ${incomingVideoPredicate} THEN ${VIDEO_CREATIVE_FORMAT}::format
    WHEN ${input.existingFormat} = ${VIDEO_CREATIVE_FORMAT} THEN ${input.existingFormat}
    WHEN ${input.existingFormat} IS NULL THEN ${input.incomingFormat}::format
    ELSE ${input.existingFormat}
  END`;
}

export function isStaticCreativeFormat(format: string | null | undefined) {
  return format === STATIC_CREATIVE_FORMAT;
}
