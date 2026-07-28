-- Seeds the assessment permission surface for orgs that predate it.
--
-- Split from 0011 deliberately: PostgreSQL refuses to USE an enum value in the
-- same transaction that added it, and 0011 adds 'assessor' and 'candidate' to
-- the role enum. Inserting rows with those roles must therefore happen in a
-- later migration.
--
-- Every statement is idempotent (guarded on the value being absent), so a
-- partial apply can be re-run safely.

-- Backfill the new `assessments` category into existing matrices. Roles keep
-- the same breadth they already had elsewhere: owners and admins administer,
-- reviewers read and export, builders and viewers read.
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
--> statement-breakpoint
-- Seed a matrix for the two new roles in every existing org. New orgs get these
-- from tenant provisioning; this covers orgs created before the roles existed.
INSERT INTO "role_permissions" ("org_id", "role", "matrix")
SELECT o."id", 'assessor'::"role",
  '{"forms":{"view":true,"create":false,"edit":false,"delete":false},"submissions":{"view":true,"export":true,"delete":false},"team":{"view":true,"invite":false,"manage":false},"billing":{"view":false,"manage":false},"audit":{"view":false},"assessments":{"view":true,"create":true,"edit":true,"delete":false,"export":true}}'::jsonb
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" rp WHERE rp."org_id" = o."id" AND rp."role" = 'assessor'
);
--> statement-breakpoint
-- The candidate is denied everything outside its own assessment records. The
-- 'own' values are what confine it; a boolean true here would hand every
-- candidate the whole org.
INSERT INTO "role_permissions" ("org_id", "role", "matrix")
SELECT o."id", 'candidate'::"role",
  '{"forms":{"view":false,"create":false,"edit":false,"delete":false,"export":false,"invite":false,"manage":false},"submissions":{"view":false,"create":false,"edit":false,"delete":false,"export":false,"invite":false,"manage":false},"team":{"view":false,"create":false,"edit":false,"delete":false,"export":false,"invite":false,"manage":false},"billing":{"view":false,"create":false,"edit":false,"delete":false,"export":false,"invite":false,"manage":false},"audit":{"view":false,"create":false,"edit":false,"delete":false,"export":false,"invite":false,"manage":false},"assessments":{"view":"own","edit":"own","create":false,"delete":false,"export":false}}'::jsonb
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" rp WHERE rp."org_id" = o."id" AND rp."role" = 'candidate'
);
