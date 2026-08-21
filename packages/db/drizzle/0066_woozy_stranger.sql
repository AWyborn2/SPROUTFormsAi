CREATE TABLE "placement_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"form_id" text,
	"version_id" text,
	"document_type" text,
	"context" text NOT NULL,
	"outcomes" jsonb NOT NULL,
	"proposals_attempted" integer NOT NULL,
	"auto_confirmed" integer NOT NULL,
	"accepted_as_is" integer NOT NULL,
	"adjusted" integer NOT NULL,
	"rejected" integer NOT NULL,
	"no_match" integer NOT NULL,
	"manual_draws" integer NOT NULL,
	"retargets" integer NOT NULL,
	"field_count" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "placement_outcomes" ADD CONSTRAINT "placement_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_outcomes" ADD CONSTRAINT "placement_outcomes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placement_outcomes_org_type_idx" ON "placement_outcomes" USING btree ("org_id","document_type");--> statement-breakpoint
CREATE INDEX "placement_outcomes_org_created_idx" ON "placement_outcomes" USING btree ("org_id","created_at");