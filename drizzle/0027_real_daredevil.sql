ALTER TABLE "ad_account" ADD COLUMN "default_facebook_page_id" text;--> statement-breakpoint
ALTER TABLE "ad_account" ADD COLUMN "default_instagram_actor_id" text;--> statement-breakpoint
ALTER TABLE "ad_set" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "ad_set" AS "target"
SET "account_id" = "linked"."account_id"
FROM (
  SELECT
    "ad_set_id",
    "organization_id",
    min("account_id") AS "account_id"
  FROM "ad"
  WHERE "ad_set_id" IS NOT NULL
    AND "account_id" IS NOT NULL
  GROUP BY "ad_set_id", "organization_id"
  HAVING count(DISTINCT "account_id") = 1
) AS "linked"
WHERE "target"."id" = "linked"."ad_set_id"
  AND "target"."organization_id" IS NOT DISTINCT FROM "linked"."organization_id"
  AND "target"."account_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ad_set_account_id_idx" ON "ad_set" USING btree ("account_id");