ALTER TABLE "klaviyo_report_fact" DROP CONSTRAINT "klaviyo_report_fact_kind_check";--> statement-breakpoint
ALTER TABLE "klaviyo_report_generation" DROP CONSTRAINT "klaviyo_report_generation_kind_check";--> statement-breakpoint
ALTER TABLE "klaviyo_marketing_object" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "klaviyo_marketing_object" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD COLUMN "delivered" numeric;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD COLUMN "bounced" numeric;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD COLUMN "unsubscribes" numeric;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD COLUMN "spam_complaints" numeric;--> statement-breakpoint
ALTER TABLE "klaviyo_report_generation" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_kind_check" CHECK (("klaviyo_report_fact"."report_kind")::text in ('campaign', 'flow', 'campaign_message', 'flow_message'));--> statement-breakpoint
ALTER TABLE "klaviyo_report_generation" ADD CONSTRAINT "klaviyo_report_generation_kind_check" CHECK (("klaviyo_report_generation"."kind")::text in ('campaign', 'flow', 'campaign_message', 'flow_message'));