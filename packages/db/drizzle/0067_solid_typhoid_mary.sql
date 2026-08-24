CREATE TABLE "assessment_case_course_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"visited_slides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"launch_path" text NOT NULL,
	"slide_count" integer,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_bytes" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_case_course_progress" ADD CONSTRAINT "assessment_case_course_progress_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_case_course_progress" ADD CONSTRAINT "assessment_case_course_progress_case_id_assessment_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."assessment_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_case_course_progress" ADD CONSTRAINT "assessment_case_course_progress_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_case_course_progress" ADD CONSTRAINT "assessment_case_course_progress_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_course_progress_uq" ON "assessment_case_course_progress" USING btree ("case_id","course_id");--> statement-breakpoint
CREATE INDEX "case_course_progress_org_idx" ON "assessment_case_course_progress" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "courses_org_idx" ON "courses" USING btree ("org_id");