-- Backfills the `assessments` permission category into existing role matrices.
--
-- DELIBERATELY CONTAINS NO REFERENCE TO THE NEW ENUM VALUES. 0011 adds
-- 'assessor' and 'candidate' to the role enum, and PostgreSQL refuses to USE a
-- new enum value until the transaction that added it has committed
-- (SQLSTATE 55P04). drizzle-kit applies every pending migration in ONE
-- transaction, so putting the seeding in a separate FILE does not put it in a
-- separate transaction — an earlier version of this migration did exactly that
-- and failed on apply.
--
-- Matrices for the two new roles are therefore seeded from application code
-- instead: tenant provisioning writes them for new orgs, and the permission
-- resolver falls back to the product defaults for any known role with no stored
-- row. That has no ordering dependency on the enum at all.
--
-- Every statement below touches only pre-existing enum values and is guarded on
-- the key being absent, so a partial apply can be re-run safely.

UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{assessments}', '{"view":true,"create":true,"edit":true,"delete":true,"export":true}'::jsonb, true)
WHERE "role" IN ('owner', 'admin') AND "matrix"->'assessments' IS NULL;
--> statement-breakpoint
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{assessments}', '{"view":true,"create":false,"edit":false,"delete":false,"export":true}'::jsonb, true)
WHERE "role" = 'reviewer' AND "matrix"->'assessments' IS NULL;
--> statement-breakpoint
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{assessments}', '{"view":true,"create":false,"edit":false,"delete":false,"export":false}'::jsonb, true)
WHERE "role" IN ('builder', 'viewer') AND "matrix"->'assessments' IS NULL;
