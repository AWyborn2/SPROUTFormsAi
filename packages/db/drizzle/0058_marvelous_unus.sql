CREATE TYPE "public"."requirement_tier" AS ENUM('required', 'recommended');--> statement-breakpoint
CREATE TABLE "role_required_competencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"tier" "requirement_tier" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "candidate_self_start_recommended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_required_competencies" ADD CONSTRAINT "role_required_competencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_required_competencies" ADD CONSTRAINT "role_required_competencies_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_required_competencies" ADD CONSTRAINT "role_required_competencies_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_required_competencies_uq" ON "role_required_competencies" USING btree ("role_id","competency_id");--> statement-breakpoint
CREATE INDEX "role_required_competencies_org_idx" ON "role_required_competencies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "role_required_competencies_role_idx" ON "role_required_competencies" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "role_required_competencies_competency_idx" ON "role_required_competencies" USING btree ("competency_id");