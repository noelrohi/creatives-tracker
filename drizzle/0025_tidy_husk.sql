-- Dedupe: keep only the most recently created row per
-- (ad_id, date_start, date_end, country, platform, placement, device, age, gender).
-- NULL breakdown cols are treated equivalent to '' (matches basePerformanceLogFilter).
DELETE FROM "performance_log" pl
USING (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        ad_id, date_start, date_end,
        COALESCE(country, ''),
        COALESCE(platform, ''),
        COALESCE(placement, ''),
        COALESCE(device, ''),
        COALESCE(age, ''),
        COALESCE(gender, '')
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM "performance_log"
) ranked
WHERE pl.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
-- Normalize NULL breakdown columns to '' so the unique constraint's
-- NULLS NOT DISTINCT semantics align with the app's COALESCE(..., '') = '' filter.
UPDATE "performance_log" SET country   = '' WHERE country   IS NULL;--> statement-breakpoint
UPDATE "performance_log" SET platform  = '' WHERE platform  IS NULL;--> statement-breakpoint
UPDATE "performance_log" SET placement = '' WHERE placement IS NULL;--> statement-breakpoint
UPDATE "performance_log" SET device    = '' WHERE device    IS NULL;--> statement-breakpoint
UPDATE "performance_log" SET age       = '' WHERE age       IS NULL;--> statement-breakpoint
UPDATE "performance_log" SET gender    = '' WHERE gender    IS NULL;--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_ad_date_breakdown_uniq" UNIQUE NULLS NOT DISTINCT("ad_id","date_start","date_end","country","platform","placement","device","age","gender");
