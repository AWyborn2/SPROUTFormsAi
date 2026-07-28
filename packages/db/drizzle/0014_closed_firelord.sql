CREATE TABLE "competency_holders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"evidence_ref" text,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competency_holders" ADD CONSTRAINT "competency_holders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD CONSTRAINT "competency_holders_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD CONSTRAINT "competency_holders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD CONSTRAINT "competency_holders_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competency_holders_competency_user_uq" ON "competency_holders" USING btree ("competency_id","user_id");--> statement-breakpoint
CREATE INDEX "competency_holders_user_idx" ON "competency_holders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "competency_holders_org_idx" ON "competency_holders" USING btree ("org_id");