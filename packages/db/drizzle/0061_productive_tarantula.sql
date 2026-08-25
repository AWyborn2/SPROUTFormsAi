CREATE TABLE "extraction_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" text,
	"file_name" text NOT NULL,
	"document_type" text,
	"path" text NOT NULL,
	"page_count" integer NOT NULL,
	"model" text,
	"result" jsonb NOT NULL,
	"field_count" integer NOT NULL,
	"extracted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extraction_captures" ADD CONSTRAINT "extraction_captures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_captures" ADD CONSTRAINT "extraction_captures_extracted_by_user_id_users_id_fk" FOREIGN KEY ("extracted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_captures_org_idx" ON "extraction_captures" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "extraction_captures_org_asset_idx" ON "extraction_captures" USING btree ("org_id","asset_id");