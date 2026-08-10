CREATE TABLE "sent_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"expires_on" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "notification_lead_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "sent_notices" ADD CONSTRAINT "sent_notices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_notices" ADD CONSTRAINT "sent_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_notices" ADD CONSTRAINT "sent_notices_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sent_notices_org_idx" ON "sent_notices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sent_notices_user_idx" ON "sent_notices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sent_notices_uq" ON "sent_notices" USING btree ("user_id","competency_id","expires_on");