-- U1 (KTD1): `role_required_competencies` generalises to `competency_requirements`
-- with FOUR scopes — Organisation, Location, Department, Role. A RENAME, not
-- drop/create, so any rows survive regardless of environment: the zero-rows
-- premise (verified in production 2026-08-14) is a comfort, never load-bearing.
-- `role_id` drops NOT NULL; nullable `location_id`/`department_id` land with
-- restrict FKs (retire-not-delete values); a CHECK holds rows to AT MOST ONE
-- scope column (all three null = org scope); the single unique index becomes
-- FOUR partial ones, because Postgres treats NULLs as distinct and a composite
-- unique over nullable scope columns would quietly permit duplicates.
ALTER TABLE "role_required_competencies" RENAME TO "competency_requirements";--> statement-breakpoint
ALTER TABLE "competency_requirements" DROP CONSTRAINT "role_required_competencies_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "competency_requirements" DROP CONSTRAINT "role_required_competencies_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "competency_requirements" DROP CONSTRAINT "role_required_competencies_competency_id_competencies_id_fk";
--> statement-breakpoint
DROP INDEX "role_required_competencies_uq";--> statement-breakpoint
DROP INDEX "role_required_competencies_org_idx";--> statement-breakpoint
DROP INDEX "role_required_competencies_role_idx";--> statement-breakpoint
DROP INDEX "role_required_competencies_competency_idx";--> statement-breakpoint
ALTER TABLE "competency_requirements" ALTER COLUMN "role_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD CONSTRAINT "competency_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD CONSTRAINT "competency_requirements_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD CONSTRAINT "competency_requirements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD CONSTRAINT "competency_requirements_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD CONSTRAINT "competency_requirements_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competency_requirements_role_uq" ON "competency_requirements" USING btree ("role_id","competency_id") WHERE "competency_requirements"."role_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "competency_requirements_location_uq" ON "competency_requirements" USING btree ("location_id","competency_id") WHERE "competency_requirements"."location_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "competency_requirements_department_uq" ON "competency_requirements" USING btree ("department_id","competency_id") WHERE "competency_requirements"."department_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "competency_requirements_org_uq" ON "competency_requirements" USING btree ("org_id","competency_id") WHERE "competency_requirements"."role_id" IS NULL AND "competency_requirements"."location_id" IS NULL AND "competency_requirements"."department_id" IS NULL;--> statement-breakpoint
CREATE INDEX "competency_requirements_org_idx" ON "competency_requirements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "competency_requirements_role_idx" ON "competency_requirements" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "competency_requirements_location_idx" ON "competency_requirements" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "competency_requirements_department_idx" ON "competency_requirements" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "competency_requirements_competency_idx" ON "competency_requirements" USING btree ("competency_id");--> statement-breakpoint
ALTER TABLE "competency_requirements" ADD CONSTRAINT "competency_requirements_one_scope_ck" CHECK (num_nonnulls("competency_requirements"."role_id", "competency_requirements"."location_id", "competency_requirements"."department_id") <= 1);--> statement-breakpoint
-- DEPLOY-WINDOW BRIDGE (U1). Unlike an additive migration, a rename breaks OLD
-- servers the moment it applies — and the readers of the old name include
-- standing, compliance and assignment, not just the editors. A simple
-- single-table view is AUTO-UPDATABLE in Postgres, so old code keeps reading
-- AND writing `role_required_competencies` until the new build is live: an
-- insert through the view lands in `competency_requirements` with `role_id`
-- set (old code always sets it) and the new columns null, which the CHECK
-- accepts. With the bridge, neither ordering of migrate-vs-redeploy breaks
-- anything. ONE RELEASE ONLY: the next round's first migration drops this view.
CREATE VIEW "role_required_competencies" AS
  SELECT "id", "org_id", "role_id", "competency_id", "tier", "created_at"
  FROM "competency_requirements"
  WHERE "role_id" IS NOT NULL;