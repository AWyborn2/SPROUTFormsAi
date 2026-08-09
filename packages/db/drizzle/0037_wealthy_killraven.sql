CREATE TABLE "member_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text NOT NULL,
	"gender" text NOT NULL,
	"ethnicity" text NOT NULL,
	"date_of_birth" text NOT NULL,
	"address_street" text NOT NULL,
	"suburb" text NOT NULL,
	"postcode" text NOT NULL,
	"mobile" text NOT NULL,
	"emergency_contact_name" text NOT NULL,
	"emergency_contact_phone" text NOT NULL,
	"starter_type" text NOT NULL,
	"induction_date" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_profiles_membership_uq" ON "member_profiles" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "member_profiles_org_idx" ON "member_profiles" USING btree ("org_id");