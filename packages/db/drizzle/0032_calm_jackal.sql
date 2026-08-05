CREATE TABLE "form_brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_templates" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "form_brands" ADD CONSTRAINT "form_brands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_brands_org_idx" ON "form_brands" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_brands_org_name_uq" ON "form_brands" USING btree ("org_id",lower("name"));--> statement-breakpoint
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_brand_id_form_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."form_brands"("id") ON DELETE set null ON UPDATE no action;