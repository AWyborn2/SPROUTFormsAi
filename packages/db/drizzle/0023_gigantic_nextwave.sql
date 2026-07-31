ALTER TABLE "competencies" ADD COLUMN "valid_for_months" integer;--> statement-breakpoint
ALTER TABLE "competencies" ADD COLUMN "grace_period_days" integer;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD COLUMN "granted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "competency_holders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
-- The DEFAULT above stamps every EXISTING row with now(), which would date a
-- grant made in 2022 as today and reset its clock. Expiry is derived from the
-- grant date, so those rows have to adopt the date they already carry.
UPDATE "competency_holders" SET "granted_at" = "created_at";