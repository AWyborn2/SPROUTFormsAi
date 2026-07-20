-- U7: server-verified submitter identity on submissions (renumbered from the
-- pre-merge 0007_concerned_jack_power after 0007_signup_onboarding merged
-- first and claimed idx 7).
--
-- NOTE: the raw generate for this file emitted the organizations columns
-- (team_size, onboarding_completed_at) because 0007_signup_onboarding shipped
-- without a snapshot; those statements are already applied by 0007 and are
-- removed here. The accompanying 0008_snapshot.json captures the true full
-- merged schema, so future `pnpm db:generate` runs diff cleanly.
ALTER TABLE "submissions" ADD COLUMN "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
