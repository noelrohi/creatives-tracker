import { sql, type SQL } from "drizzle-orm";

export const STATIC_CREATIVE_FORMAT = "static";
export const VIDEO_CREATIVE_FORMAT = "video";
export const CREATIVE_FORMATS = ["static", "video", "ugc", "carousel"] as const;

export type CreativeFormat = typeof CREATIVE_FORMATS[number];
export const WINNER_MIN_SPEND = 50;
export const WINNER_MIN_ROAS = 1;
export const WINNER_MIN_CONVERSIONS = 1;
export const VIDEO_SIGNAL_MIN_3S_VIEWS = 50;
export const VIDEO_SIGNAL_MIN_3S_VIEW_RATE = 0.01;

export type WinnerCandidateInput = {
  format: string | null | undefined;
  status: string | null | undefined;
  spend: number | null | undefined;
  roas: number | null | undefined;
  conversions: number | null | undefined;
  impressions: number | null | undefined;
  videoViews3s: number | null | undefined;
  videoThruplay: number | null | undefined;
  hasSourceContext: boolean;
  hasVideoAsset: boolean;
};

export type WinnerSourceContextInput = {
  caption?: string | null;
  hook?: string | null;
  angle?: string | null;
  persona?: string | null;
  cta?: string | null;
};

type CreativeFormatMergeSqlInput = {
  existingFormat: SQL;
  incomingFormat: SQL;
  incomingVideoUrl?: SQL;
};

type WinnerSourceContextSqlInput = {
  caption: SQL;
  hook: SQL;
  angle: SQL;
  persona: SQL;
  cta: SQL;
};

type WinnerCandidateSqlInput = {
  format: SQL;
  videoUrl: SQL;
  impressions: SQL;
  videoViews3s: SQL;
  videoThruplay: SQL;
  status: SQL;
  spend: SQL;
  roas: SQL;
  conversions: SQL;
  sourceContext: WinnerSourceContextSqlInput;
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

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function nonBlankSql(value: SQL) {
  return sql`nullif(trim(${value}), '') IS NOT NULL`;
}

export function hasWinnerSourceContext(input: WinnerSourceContextInput) {
  return (
    hasText(input.caption)
    || hasText(input.hook)
    || hasText(input.angle)
    || hasText(input.persona)
    || hasText(input.cta)
  );
}

export function isStaticCreativeFormat(format: string | null | undefined) {
  return format === STATIC_CREATIVE_FORMAT;
}

export function hasStrongVideoSignal(input: {
  impressions: number | null | undefined;
  videoViews3s: number | null | undefined;
  videoThruplay: number | null | undefined;
}) {
  const videoViews3s = input.videoViews3s ?? 0;
  const videoThruplay = input.videoThruplay ?? 0;
  const impressions = input.impressions ?? 0;
  return (
    videoThruplay > 0
    || videoViews3s >= VIDEO_SIGNAL_MIN_3S_VIEWS
    || (impressions > 0 && videoViews3s / impressions >= VIDEO_SIGNAL_MIN_3S_VIEW_RATE)
  );
}

export function isWinnerCandidate(input: WinnerCandidateInput) {
  return (
    isStaticCreativeFormat(input.format)
    && !input.hasVideoAsset
    && !hasStrongVideoSignal(input)
    && input.status === "active"
    && input.spend != null
    && input.spend >= WINNER_MIN_SPEND
    && input.roas != null
    && input.roas >= WINNER_MIN_ROAS
    && input.conversions != null
    && input.conversions >= WINNER_MIN_CONVERSIONS
    && input.hasSourceContext
  );
}

export function winnerSourceContextSql(input: WinnerSourceContextSqlInput) {
  return sql`(
    ${nonBlankSql(input.caption)}
    OR ${nonBlankSql(input.hook)}
    OR ${nonBlankSql(input.angle)}
    OR ${nonBlankSql(input.persona)}
    OR ${nonBlankSql(input.cta)}
  )`;
}

export function winnerCandidateSqlPolicy(input: WinnerCandidateSqlInput) {
  const minVideoViews = sql.raw(String(VIDEO_SIGNAL_MIN_3S_VIEWS));
  const minVideoViewRate = sql.raw(String(VIDEO_SIGNAL_MIN_3S_VIEW_RATE));

  return sql`
    ${input.format} = ${STATIC_CREATIVE_FORMAT}
    AND nullif(trim(${input.videoUrl}), '') IS NULL
    AND NOT (
      coalesce(${input.videoThruplay}, 0) > 0
      OR coalesce(${input.videoViews3s}, 0) >= ${minVideoViews}
      OR (
        coalesce(${input.impressions}, 0) > 0
        AND coalesce(${input.videoViews3s}, 0)::numeric / nullif(coalesce(${input.impressions}, 0), 0)::numeric >= ${minVideoViewRate}
      )
    )
    AND ${input.status} = 'active'
    AND ${input.spend} >= ${WINNER_MIN_SPEND}
    AND ${input.roas} >= ${WINNER_MIN_ROAS}
    AND ${input.conversions} >= ${WINNER_MIN_CONVERSIONS}
    AND ${winnerSourceContextSql(input.sourceContext)}
  `;
}
