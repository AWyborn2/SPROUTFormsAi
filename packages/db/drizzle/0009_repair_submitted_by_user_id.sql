-- Idempotent repair for two migrations carrying out-of-order journal
-- timestamps: 0006_plan_tiers and 0008_kind_calypso.
--
-- Why they can be missing. Drizzle's migrator (pg-core/dialect.js) reads a
-- SINGLE row — the highest `created_at` in __drizzle_migrations — once, before
-- the apply loop, then runs an entry only when that value is strictly less
-- than the entry's `folderMillis`. An entry whose journal `when` sits below a
-- previously-applied entry's is therefore skipped silently, with exit code 0
-- and no error. CI cannot catch this: it runs against an empty database, where
-- there is no baseline row and everything applies in order regardless.
--
--   0006_plan_tiers   when=1753056000000 (a 2025 value, below every neighbour)
--                     -> skipped on any database that was at 0005 or earlier
--                        when it arrived; plan_tier / seat_limit /
--                        account_kind absent while code reads planTier.
--   0008_kind_calypso when=1784543869870, below 0007's 1784559366081
--                     -> skipped on any database that applied 0007 in an
--                        EARLIER run; submissions.submitted_by_user_id absent.
--                        (A database catching up from 0005 applies 0007 and
--                        0008 in the same pass and is unaffected, because the
--                        baseline is captured before the loop.)
--
-- Why repair forward instead of editing those files. Editing an applied
-- migration's `when` makes Drizzle re-run it — which for these files means
-- `ADD COLUMN` against a column that already exists, failing the whole
-- transaction on every healthy database. That is why 0006 was left alone
-- previously. This migration is written to be correct in BOTH states: where
-- the originals were skipped it creates the missing objects, and where they
-- applied every statement is a no-op.
--
-- 0006's blanket `UPDATE organizations SET plan_tier='business', ...` is
-- deliberately NOT repeated. The column defaults below already reproduce its
-- intent for pre-existing rows, and re-running the UPDATE would reset tiers,
-- seat limits, and account kinds that have legitimately changed since.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "plan_tier" text NOT NULL DEFAULT 'business';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "seat_limit" integer NOT NULL DEFAULT 15;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "account_kind" text NOT NULL DEFAULT 'team';--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" DROP CONSTRAINT IF EXISTS "submissions_submitted_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
