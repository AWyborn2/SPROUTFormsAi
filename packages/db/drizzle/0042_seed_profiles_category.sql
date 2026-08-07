-- Backfills the `profiles` permission category into role matrices that predate
-- it, and adds the two new object grants to matrices that already carry it.
--
-- WHY THIS IS NOT OPTIONAL. `matrixFor` in apps/api/src/lib/permissions.ts
-- returns the STORED matrix verbatim and falls back to the product defaults only
-- when there is NO stored row at all. An organisation that has ever customised
-- an access level has a row, so a category absent from it resolves to denied for
-- every action. Without this, the day U29 turns enforcement on, every such
-- organisation loses profile access for Owners, Admins and Assessors alike —
-- silently, because the fallback path they are not on is the one that works.
--
-- Follows 0012_seed_assessment_roles.sql, which solved exactly this once before
-- when the `assessments` category shipped, and for the same reason.
--
-- SAFE TO RE-RUN. Every statement is guarded on the key being absent, so a
-- partial apply is repeated rather than reconciled, and a customised value is
-- never overwritten.
--
-- TOUCHES NO NEW ENUM VALUE. 0041 adds 'profiles' to audit_category; nothing
-- here writes it. drizzle applies all pending migrations in ONE transaction and
-- PostgreSQL refuses to USE an enum value added in that same transaction
-- (55P04), which is the failure 0012's header records hitting.

-- Owner and Admin hold every profile grant.
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{profiles}', '{"view":true,"edit":true,"approve":true,"view_documents":true,"view_competencies":true}'::jsonb, true)
WHERE "role" IN ('owner', 'admin') AND "matrix"->'profiles' IS NULL;
--> statement-breakpoint

-- The assessor default (R55): view the profile, its competencies and history,
-- and its documents, and approve those documents. NOT edit.
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{profiles}', '{"view":true,"edit":false,"approve":true,"view_documents":true,"view_competencies":true}'::jsonb, true)
WHERE "role" = 'assessor' AND "matrix"->'profiles' IS NULL;
--> statement-breakpoint

-- Every other access level starts denied, and an organisation loosens it.
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{profiles}', '{"view":false,"edit":false,"approve":false,"view_documents":false,"view_competencies":false}'::jsonb, true)
WHERE "role" IN ('builder', 'reviewer', 'viewer', 'candidate') AND "matrix"->'profiles' IS NULL;
--> statement-breakpoint

-- Organisations provisioned between the category shipping and this migration
-- carry `profiles` WITHOUT the two object grants U29 adds, which would leave
-- their assessors unable to open a document or read a competency. Seed each
-- from that row's own `view` value, so a customisation is carried forward
-- rather than overwritten: an access level already denied the profile stays
-- denied on both, and one admitted to it keeps the reach it had before the
-- split existed.
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{profiles,view_documents}', COALESCE("matrix"->'profiles'->'view', 'false'::jsonb), true)
WHERE "matrix"->'profiles' IS NOT NULL AND "matrix"->'profiles'->'view_documents' IS NULL;
--> statement-breakpoint
UPDATE "role_permissions"
SET "matrix" = jsonb_set("matrix", '{profiles,view_competencies}', COALESCE("matrix"->'profiles'->'view', 'false'::jsonb), true)
WHERE "matrix"->'profiles' IS NOT NULL AND "matrix"->'profiles'->'view_competencies' IS NULL;
