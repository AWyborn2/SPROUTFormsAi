ALTER TABLE "organizations" ADD COLUMN "candidate_seat_limit" integer;--> statement-breakpoint
-- Backfill the candidate allowance for orgs that predate the column, from the
-- tier they are already on. Enterprise stays NULL (unlimited).
UPDATE "organizations" SET "candidate_seat_limit" = 0 WHERE "candidate_seat_limit" IS NULL AND "plan_tier" IN ('individual', 'team');--> statement-breakpoint
UPDATE "organizations" SET "candidate_seat_limit" = 200 WHERE "candidate_seat_limit" IS NULL AND "plan_tier" = 'business';
