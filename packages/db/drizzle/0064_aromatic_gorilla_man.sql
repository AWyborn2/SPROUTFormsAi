-- Close the 0060 bridge (three migrations overdue). 0060 renamed
-- `role_required_competencies` to `competency_requirements` and left a
-- single-table compat view under the old name, marked "ONE RELEASE ONLY: the
-- next round's first migration drops this view" — 0061..0063 shipped without
-- doing so. Nothing at runtime selects the old name anymore (verified: only
-- migration SQL, a 0060-pinned test, and docs mention it), so the drop is
-- safe under the same MIGRATE FIRST, THEN DEPLOY precondition as 0060: any
-- still-running pre-0060 build would lose its read path, but no such build
-- exists three releases on.
DROP VIEW "role_required_competencies";--> statement-breakpoint
-- Daily compliance snapshots for the Training summary trend (plan U1/KTD5):
-- compliance is derived everywhere else, so history exists only if captured.
-- The expiry sweep upserts one row per org per UTC day at every grain (org
-- row: scope_type/scope_id NULL; plus per-location and per-department rows)
-- even though v1 UI reads only org rows — scoped history cannot be
-- backfilled later. Partial unique indexes because NULLs are distinct.
CREATE TABLE "compliance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"captured_on" date NOT NULL,
	"scope_type" text,
	"scope_id" uuid,
	"compliant_count" integer NOT NULL,
	"member_count" integer NOT NULL,
	"required_gap_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_snapshots_org_day_uq" ON "compliance_snapshots" USING btree ("org_id","captured_on") WHERE "compliance_snapshots"."scope_type" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_snapshots_scope_day_uq" ON "compliance_snapshots" USING btree ("org_id","scope_type","scope_id","captured_on") WHERE "compliance_snapshots"."scope_type" IS NOT NULL;