ALTER TABLE "organizations" ADD COLUMN "plan_tier" text NOT NULL DEFAULT 'business';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "seat_limit" integer NOT NULL DEFAULT 15;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "account_kind" text NOT NULL DEFAULT 'team';--> statement-breakpoint
UPDATE "organizations" SET "plan_tier" = 'business', "account_kind" = 'team', "seat_limit" = 15;
