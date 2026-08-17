CREATE TABLE "extraction_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"capture_id" uuid,
	"asset_id" text,
	"document_type" text,
	"form_id" text,
	"version_id" text,
	"corrections" jsonb NOT NULL,
	"correction_count" integer NOT NULL,
	"field_count" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extraction_corrections" ADD CONSTRAINT "extraction_corrections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_corrections" ADD CONSTRAINT "extraction_corrections_capture_id_extraction_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."extraction_captures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_corrections" ADD CONSTRAINT "extraction_corrections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_corrections_org_type_idx" ON "extraction_corrections" USING btree ("org_id","document_type");--> statement-breakpoint
CREATE INDEX "extraction_corrections_capture_idx" ON "extraction_corrections" USING btree ("capture_id");