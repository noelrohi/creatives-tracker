ALTER TABLE "ad_account" ADD COLUMN "default_facebook_page_id" text;--> statement-breakpoint
ALTER TABLE "ad_account" ADD COLUMN "default_instagram_actor_id" text;--> statement-breakpoint
ALTER TABLE "ad_set" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "ad_set" AS "target"
SET "account_id" = "linked"."account_id"
FROM (
  SELECT
    "ad"."ad_set_id",
    "ad"."organization_id",
    min("ad"."account_id") AS "account_id"
  FROM "ad"
  INNER JOIN "ad_account"
    ON "ad_account"."id" = "ad"."account_id"
   AND "ad_account"."organization_id" IS NOT DISTINCT FROM "ad"."organization_id"
  WHERE "ad"."ad_set_id" IS NOT NULL
    AND "ad"."account_id" IS NOT NULL
  GROUP BY "ad"."ad_set_id", "ad"."organization_id"
  HAVING count(DISTINCT "ad"."account_id") = 1
) AS "linked"
WHERE "target"."id" = "linked"."ad_set_id"
  AND "target"."organization_id" IS NOT DISTINCT FROM "linked"."organization_id"
  AND "target"."account_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ad_set_account_id_idx" ON "ad_set" USING btree ("account_id");