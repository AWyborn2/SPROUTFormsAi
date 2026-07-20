CREATE TABLE "fill_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fill_links" ADD CONSTRAINT "fill_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_links" ADD CONSTRAINT "fill_links_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fill_links_token_uq" ON "fill_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "fill_links_template_idx" ON "fill_links" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "fill_links_org_idx" ON "fill_links" USING btree ("org_id");