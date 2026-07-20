-- U7: server-verified submitter identity on submissions.
--
-- NOTE: drizzle-kit's snapshot chain was behind the hand-written migrations
-- 0004_clerk_auth / 0005_custom_auth / 0006_plan_tiers (they shipped without
-- snapshots), so the raw generate for this migration also re-emitted their
-- already-applied DDL (clerk_user_id, password_hash, plan_tier/seat_limit/
-- account_kind, email unique). Those statements are removed here — they are
-- already applied to every database by 0004-0006 and would fail if re-run.
-- The accompanying 0007_snapshot.json now captures the true full schema, so
-- future `pnpm db:generate` runs diff cleanly again.
ALTER TABLE "submissions" ADD COLUMN "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
