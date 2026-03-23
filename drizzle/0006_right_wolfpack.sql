ALTER TABLE "ad" DROP CONSTRAINT "ad_ad_set_id_ad_set_id_fk";
--> statement-breakpoint
ALTER TABLE "ad" ALTER COLUMN "ad_set_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_ad_set_id_ad_set_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE set null ON UPDATE no action;