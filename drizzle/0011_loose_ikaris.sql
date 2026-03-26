CREATE TABLE "ad_account" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"meta_account_id" text NOT NULL,
	"meta_access_token" text,
	"notes" text,
	"last_imported_at" timestamp,
	"data_date_end" date,
	"organization_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ad_account_meta_account_id_unique" UNIQUE("meta_account_id")
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" DROP CONSTRAINT "account_meta_account_id_unique";--> statement-breakpoint
ALTER TABLE "tag" DROP CONSTRAINT "tag_name_unique";--> statement-breakpoint
ALTER TABLE "ad" DROP CONSTRAINT "ad_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ab_test" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "provider_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "id_token" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "access_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refresh_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "password" text;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ad_set" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "campaign" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "landing_page" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "tag" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_account_organization_id_idx" ON "ad_account" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ab_test_variant_organization_id_idx" ON "ab_test_variant" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ab_test_organization_id_idx" ON "ab_test" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ad_creative_organization_id_idx" ON "ad_creative" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_set_organization_id_idx" ON "ad_set" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_organization_id_idx" ON "ad" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "campaign_organization_id_idx" ON "campaign" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lp_version_organization_id_idx" ON "landing_page_version" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "landing_page_organization_id_idx" ON "landing_page" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "performance_log_organization_id_idx" ON "performance_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "entity_tag_organization_id_idx" ON "entity_tag" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tag_organization_id_idx" ON "tag" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "meta_account_id";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "meta_access_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "notes";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "last_imported_at";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "data_date_end";--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_name_org_unique" UNIQUE("name","organization_id");