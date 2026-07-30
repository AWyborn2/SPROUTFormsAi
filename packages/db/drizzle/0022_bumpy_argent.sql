ALTER TYPE "public"."assessment_case_state" ADD VALUE 'awaiting_sign_off' BEFORE 'competent';--> statement-breakpoint
ALTER TABLE "competency_holders" ADD COLUMN "source_case_id" uuid;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD COLUMN "signed_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD COLUMN "signed_off_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD COLUMN "signed_off_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD COLUMN "signed_off_signature" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_tools" ADD COLUMN "awarded_competency_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD CONSTRAINT "competency_holders_source_case_id_assessment_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."assessment_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_signed_off_by_user_id_users_id_fk" FOREIGN KEY ("signed_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;