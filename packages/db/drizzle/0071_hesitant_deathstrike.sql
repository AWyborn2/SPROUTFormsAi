ALTER TABLE "assessment_part_attempts" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD COLUMN "superseded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD COLUMN "superseded_reason" text;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD CONSTRAINT "assessment_part_attempts_superseded_by_user_id_users_id_fk" FOREIGN KEY ("superseded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;