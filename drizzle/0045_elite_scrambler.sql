ALTER TABLE "studio_variant" ADD COLUMN "marked_at" timestamp;--> statement-breakpoint
-- Backfill: updated_at was the previous (proxy) clock for existing marks.
UPDATE "studio_variant" SET "marked_at" = "updated_at" WHERE "mark" IS NOT NULL;
