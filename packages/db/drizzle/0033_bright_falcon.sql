CREATE TYPE "public"."attempt_marker_kind" AS ENUM('person', 'automatic');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "pooled_case_overdue_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD COLUMN "marker_kind" "attempt_marker_kind" DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_part_attempts" ADD COLUMN "marking_eligibility_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;