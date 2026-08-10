CREATE TABLE "assessment_tool_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_id" text NOT NULL,
	"step" text DEFAULT 'upload' NOT NULL,
	"state" jsonb NOT NULL,
	"form_id" uuid,
	"version_id" uuid,
	"saved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_tool_drafts_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
ALTER TABLE "assessment_tool_drafts" ADD CONSTRAINT "assessment_tool_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tool_drafts" ADD CONSTRAINT "assessment_tool_drafts_form_id_form_templates_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."form_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tool_drafts" ADD CONSTRAINT "assessment_tool_drafts_version_id_form_template_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."form_template_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tool_drafts" ADD CONSTRAINT "assessment_tool_drafts_saved_by_user_id_users_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_tool_drafts_org_idx" ON "assessment_tool_drafts" USING btree ("org_id");