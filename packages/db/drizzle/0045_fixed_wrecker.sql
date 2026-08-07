CREATE TABLE "document_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_notices" ADD CONSTRAINT "document_notices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_notices" ADD CONSTRAINT "document_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_notices" ADD CONSTRAINT "document_notices_document_id_competency_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."competency_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_notices_user_idx" ON "document_notices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_notices_org_idx" ON "document_notices" USING btree ("org_id");