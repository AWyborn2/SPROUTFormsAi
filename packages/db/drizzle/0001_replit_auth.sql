-- Drop the WorkOS org id unique constraint then the column
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_workosOrgId_unique";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "workos_org_id";--> statement-breakpoint

-- Rename the WorkOS user id column to replit_user_id
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_workosUserId_unique";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "workos_user_id" TO "replit_user_id";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_replitUserId_unique" UNIQUE("replit_user_id");
