CREATE TYPE "public"."assessment_case_state" AS ENUM('open', 'competent', 'closed');--> statement-breakpoint
CREATE TYPE "public"."assessment_pathway" AS ENUM('experienced', 'new', 'rpl');--> statement-breakpoint
CREATE TYPE "public"."ns_disposition" AS ENUM('retry', 'coaching_then_retry', 'change_pathway', 'not_yet_competent');--> statement-breakpoint
CREATE TYPE "public"."part_outcome" AS ENUM('satisfactory', 'not_satisfactory');--> statement-breakpoint
CREATE TABLE "assessment_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"candidate_user_id" uuid NOT NULL,
	"assessor_user_id" uuid,
	"pathway" "assessment_pathway" NOT NULL,
	"location_stream" text,
	"state" "assessment_case_state" DEFAULT 'open' NOT NULL,
	"current_version_id" uuid NOT NULL,
	"appeal_of_case_id" uuid,
	"appeal_reason" text,
	"rpl_justification" text,
	"prerequisite_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assessment_part_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"part_key" text NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"template_version_id" uuid NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" "part_outcome",
	"disposition" "ns_disposition",
	"disposition_reason" text,
	"below_threshold_reason" text,
	"threshold_notified_at" timestamp with time zone,
	"assessor_user_id" uuid,
	"assessor_name" text DEFAULT '' NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"candidate_prerequisite_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assessor_competency_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_tool_id_assessment_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."assessment_tools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_candidate_user_id_users_id_fk" FOREIGN KEY ("candidate_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_assessor_user_id_users_id_fk" FOREIGN KEY ("assessor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_current_version_id_form_template_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."form_template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cases" ADD CONSTRAINT "assessment_cases_appeal_of_case_id_assessment_cases_id_fk" FOREIGN KEY ("appeal_of_case_id") REFERENCES "public"."assessment_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD CONSTRAINT "assessment_part_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD CONSTRAINT "assessment_part_attempts_case_id_assessment_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."assessment_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD CONSTRAINT "assessment_part_attempts_template_version_id_form_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."form_template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD CONSTRAINT "assessment_part_attempts_assessor_user_id_users_id_fk" FOREIGN KEY ("assessor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tools" ADD CONSTRAINT "assessment_tools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tools" ADD CONSTRAINT "assessment_tools_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_cases_org_idx" ON "assessment_cases" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "assessment_cases_candidate_idx" ON "assessment_cases" USING btree ("candidate_user_id");--> statement-breakpoint
CREATE INDEX "assessment_cases_assessor_idx" ON "assessment_cases" USING btree ("assessor_user_id");--> statement-breakpoint
CREATE INDEX "assessment_cases_tool_idx" ON "assessment_cases" USING btree ("tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_attempts_case_part_number_uq" ON "assessment_part_attempts" USING btree ("case_id","part_key","attempt_number");--> statement-breakpoint
CREATE INDEX "assessment_attempts_case_idx" ON "assessment_part_attempts" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "assessment_attempts_org_idx" ON "assessment_part_attempts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_tools_template_uq" ON "assessment_tools" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "assessment_tools_org_idx" ON "assessment_tools" USING btree ("org_id");