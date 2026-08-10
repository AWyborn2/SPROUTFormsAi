CREATE TYPE "public"."training_request_state" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "training_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"state" "training_request_state" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_tool_id_assessment_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."assessment_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_requests_org_idx" ON "training_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "training_requests_user_idx" ON "training_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_requests_pending_uq" ON "training_requests" USING btree ("user_id","tool_id") WHERE "training_requests"."state" = 'pending';