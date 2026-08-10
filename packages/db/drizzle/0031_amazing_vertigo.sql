CREATE TABLE "role_required_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_tools" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "requirements_configured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_required_assessments" ADD CONSTRAINT "role_required_assessments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_required_assessments" ADD CONSTRAINT "role_required_assessments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_required_assessments" ADD CONSTRAINT "role_required_assessments_tool_id_assessment_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."assessment_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_required_assessments_uq" ON "role_required_assessments" USING btree ("role_id","tool_id");--> statement-breakpoint
CREATE INDEX "role_required_assessments_org_idx" ON "role_required_assessments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "role_required_assessments_role_idx" ON "role_required_assessments" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "role_required_assessments_tool_idx" ON "role_required_assessments" USING btree ("tool_id");--> statement-breakpoint
ALTER TABLE "assessment_tools" ADD CONSTRAINT "assessment_tools_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_tools_department_idx" ON "assessment_tools" USING btree ("department_id");