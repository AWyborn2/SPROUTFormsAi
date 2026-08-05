CREATE TABLE "membership_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_departments" ADD CONSTRAINT "membership_departments_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_departments" ADD CONSTRAINT "membership_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_departments_uq" ON "membership_departments" USING btree ("membership_id","department_id");--> statement-breakpoint
CREATE INDEX "membership_departments_membership_idx" ON "membership_departments" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "membership_departments_department_idx" ON "membership_departments" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_locations_uq" ON "membership_locations" USING btree ("membership_id","location_id");--> statement-breakpoint
CREATE INDEX "membership_locations_membership_idx" ON "membership_locations" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "membership_locations_location_idx" ON "membership_locations" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_roles_uq" ON "membership_roles" USING btree ("membership_id","role_id");--> statement-breakpoint
CREATE INDEX "membership_roles_membership_idx" ON "membership_roles" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "membership_roles_role_idx" ON "membership_roles" USING btree ("role_id");