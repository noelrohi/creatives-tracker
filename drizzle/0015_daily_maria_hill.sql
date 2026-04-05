CREATE TYPE "public"."ownership" AS ENUM('ours', 'theirs');--> statement-breakpoint
ALTER TABLE "ad_creative" ADD COLUMN "ownership" "ownership";