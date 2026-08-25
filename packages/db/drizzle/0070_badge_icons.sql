CREATE TABLE IF NOT EXISTS "badge_icons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "badge_icons_org_slug_uq" ON "badge_icons" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "badge_icons_org_idx" ON "badge_icons" USING btree ("org_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badge_icons" ADD CONSTRAINT "badge_icons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
