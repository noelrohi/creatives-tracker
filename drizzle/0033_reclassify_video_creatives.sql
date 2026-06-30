WITH creative_video_signal AS (
  SELECT
    ac."id",
    ac."format"::text AS format,
    nullif(trim(coalesce(ac."video_url", '')), '') IS NOT NULL AS has_video_url,
    coalesce(sum(pl."impressions") FILTER (
      WHERE coalesce(pl."country", '') = ''
        AND coalesce(pl."platform", '') = ''
        AND coalesce(pl."placement", '') = ''
        AND coalesce(pl."device", '') = ''
        AND coalesce(pl."age", '') = ''
        AND coalesce(pl."gender", '') = ''
        AND pl."date_start" = pl."date_end"
    ), 0) AS impressions,
    coalesce(sum(pl."spend") FILTER (
      WHERE coalesce(pl."country", '') = ''
        AND coalesce(pl."platform", '') = ''
        AND coalesce(pl."placement", '') = ''
        AND coalesce(pl."device", '') = ''
        AND coalesce(pl."age", '') = ''
        AND coalesce(pl."gender", '') = ''
        AND pl."date_start" = pl."date_end"
    ), 0) AS spend,
    coalesce(sum(pl."video_views_3s") FILTER (
      WHERE coalesce(pl."country", '') = ''
        AND coalesce(pl."platform", '') = ''
        AND coalesce(pl."placement", '') = ''
        AND coalesce(pl."device", '') = ''
        AND coalesce(pl."age", '') = ''
        AND coalesce(pl."gender", '') = ''
        AND pl."date_start" = pl."date_end"
    ), 0) AS video_views_3s,
    coalesce(sum(pl."video_thruplay") FILTER (
      WHERE coalesce(pl."country", '') = ''
        AND coalesce(pl."platform", '') = ''
        AND coalesce(pl."placement", '') = ''
        AND coalesce(pl."device", '') = ''
        AND coalesce(pl."age", '') = ''
        AND coalesce(pl."gender", '') = ''
        AND pl."date_start" = pl."date_end"
    ), 0) AS video_thruplay
  FROM "ad_creative" ac
  LEFT JOIN "ad" a ON a."ad_creative_id" = ac."id"
  LEFT JOIN "performance_log" pl ON pl."ad_id" = a."id"
  GROUP BY ac."id"
), classified AS (
  SELECT
    *,
    (
      has_video_url
      OR video_thruplay > 0
      OR video_views_3s >= 50
      OR (impressions > 0 AND video_views_3s / nullif(impressions, 0) >= 0.01)
    ) AS has_strong_video_signal
  FROM creative_video_signal
)
UPDATE "ad_creative" ac
SET "format" = CASE
  WHEN c.has_strong_video_signal THEN 'video'::format
  ELSE 'static'::format
END
FROM classified c
WHERE ac."id" = c."id"
  AND (
    (ac."format" = 'static' AND c.has_strong_video_signal)
    OR (
      ac."format" = 'video'
      AND NOT c.has_strong_video_signal
      AND NOT c.has_video_url
      AND (c.spend > 0 OR c.impressions > 0)
    )
  );
