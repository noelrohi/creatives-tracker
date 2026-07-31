CREATE TYPE "public"."finding_resolution" AS ENUM('handled', 'retired');--> statement-breakpoint
ALTER TABLE "finding" ADD COLUMN "resolution" "finding_resolution";--> statement-breakpoint
-- Every finding closed before this column existed was closed by a person
-- clicking resolve, because nothing else could close one.
UPDATE "finding" SET "resolution" = 'handled' WHERE "resolved_at" IS NOT NULL;
