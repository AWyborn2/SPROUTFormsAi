CREATE TYPE "public"."document_state" AS ENUM('held', 'pending', 'superseded', 'rejected', 'removed');--> statement-breakpoint
CREATE TABLE "competency_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"competency_holder_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"state" "document_state" DEFAULT 'held' NOT NULL,
	"uploaded_by_user_id" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_reason" text,
	"removed_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	"superseded_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competency_documents" ADD CONSTRAINT "competency_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_documents" ADD CONSTRAINT "competency_documents_competency_holder_id_competency_holders_id_fk" FOREIGN KEY ("competency_holder_id") REFERENCES "public"."competency_holders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_documents" ADD CONSTRAINT "competency_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_documents" ADD CONSTRAINT "competency_documents_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_documents" ADD CONSTRAINT "competency_documents_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_documents" ADD CONSTRAINT "competency_documents_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competency_documents_org_idx" ON "competency_documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "competency_documents_holder_idx" ON "competency_documents" USING btree ("competency_holder_id");--> statement-breakpoint
CREATE INDEX "competency_documents_key_idx" ON "competency_documents" USING btree ("storage_key");