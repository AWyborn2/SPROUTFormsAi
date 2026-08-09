ALTER TYPE "public"."audit_category" ADD VALUE 'profiles';--> statement-breakpoint
ALTER TABLE "audit_log_entries" ADD COLUMN "field" text;